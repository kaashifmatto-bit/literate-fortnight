"""
ArticulAIT — FastAPI Application Entry Point
Serves the API, static files, and Next.js frontend.
"""
# pyrefly: ignore [missing-import]
from fastapi import FastAPI
# pyrefly: ignore [missing-import]
from fastapi.middleware.cors import CORSMiddleware
# pyrefly: ignore [missing-import]
from fastapi.staticfiles import StaticFiles
# pyrefly: ignore [missing-import]
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from contextlib import asynccontextmanager
import os
import shutil

from backend.core import settings
from backend.core.database import init_db
from backend.core.logger import logger, setup_logger
from backend.core.middleware import APILoggingMiddleware
from backend.routes.upload import router as upload_router
from backend.routes.walkthrough import router as walkthrough_router
from backend.routes.projects import router as projects_router
from backend.routes.listings import router as listings_router
from backend.routes.floorplan import router as floorplan_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown lifecycle."""
    # ── Startup ──
    print("-" * 50)
    print("  ArticulAIT 3D Walkthrough Platform")
    print("-" * 50)
    setup_logger()
    init_db()
    os.makedirs(settings.DATA_DIR, exist_ok=True)
    os.makedirs(settings.MODELS_DIR, exist_ok=True)
    os.makedirs(settings.LOG_DIR, exist_ok=True)

    print(f"  Data directory: {settings.DATA_DIR}")
    print(f"  Models directory: {settings.MODELS_DIR}")
    print(f"  Logs directory: {settings.LOG_DIR}")
    print(f"  Database: {settings.DATABASE_URL}")
    print("-" * 50)
    yield
    # ── Shutdown ──
    print("  ArticulAIT shutting down")


app = FastAPI(
    title="ArticulAIT 3D Walkthrough API",
    description="AI-powered 3D Gaussian Splatting walkthrough platform",
    version="2.0.0",
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────
origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
]

for o in settings.CORS_ORIGINS.split(","):
    o_stripped = o.strip()
    if o_stripped and o_stripped != "*" and o_stripped not in origins:
        origins.append(o_stripped)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1|172\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── API Logging Middleware ────────────────────────────────────
app.add_middleware(APILoggingMiddleware)

# ── API Routes ────────────────────────────────────────────────
app.include_router(upload_router, prefix="/api", tags=["Upload"])
app.include_router(walkthrough_router, prefix="/api", tags=["Walkthrough"])
app.include_router(projects_router, prefix="/api", tags=["Projects"])
app.include_router(listings_router, prefix="/api", tags=["Listings"])
app.include_router(floorplan_router, prefix="/api", tags=["FloorPlan"])


from pydantic import BaseModel

class FrontendLogEntry(BaseModel):
    req_id: str
    method: str
    url: str
    status_code: int = 200
    duration_ms: float = 0.0


# ── Health & Logging Endpoints ────────────────────────────────
@app.get("/api/health", tags=["System"])
async def health_check():
    return {
        "status": "healthy",
        "version": "2.0.0",
        "gpu": _detect_gpu(),
    }


@app.post("/api/logs", tags=["System"])
async def log_frontend_event(entry: FrontendLogEntry):
    """Log frontend page requests into central daily rotating log."""
    logger.info(
        f"[{entry.req_id}] {entry.method} {entry.url} -> {entry.status_code} ({entry.duration_ms:.1f}ms) [FRONTEND]"
    )
    return {"status": "logged"}


def _detect_gpu():
    """Detect available GPU for status reporting."""
    try:
        import torch
        if torch.cuda.is_available():
            name = torch.cuda.get_device_name(0)
            mem = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            return {"available": True, "name": name, "vram_gb": round(mem, 1)}
    except ImportError:
        pass
    return {"available": False, "name": "None", "vram_gb": 0}


# ── Project Model Asset Downloader with Auto-Fallback ──────────
@app.get("/data/project_{project_id}/{filename}")
async def serve_project_model_asset(project_id: int, filename: str):
    """
    Serve project model assets (.ply, .splat, .lcc) with auto-fallback.
    Guarantees no 404 Not Found error when downloading any model format.

    The saved-download filename always carries the project id (e.g.
    "project_167_scene_clean.ply") via Content-Disposition, not just the
    generic on-disk name ("scene_clean.ply"). This matters because the
    frontend's own per-project `download="scene_project_{id}.ply"` anchor
    attribute is silently ignored by the browser here - the API runs on a
    different origin/port than the frontend, and browsers only honor the
    `download` attribute for same-origin navigations. For a cross-origin
    file like this one, the browser uses whatever filename the SERVER
    supplies via Content-Disposition instead, which used to be the bare
    "scene_clean.ply" every single time regardless of project - so every
    download of every project's scene looked identical to the OS, and
    repeat downloads got silently renamed "scene_clean (2).ply", "(3)",
    "(4)"... by Windows' own duplicate-file handling, with no indication of
    which project any of them came from. That ambiguity is what led to
    already-exported files being re-opened later via "Open 3D File" as if
    they were a fresh reconstruction. Stamping the project id server-side
    closes that gap for good, independent of the client's `download` hint.
    """
    # Always present the ORIGINALLY REQUESTED filename to the browser (with
    # the project id prefixed), even when the bytes actually served come
    # from a fallback candidate below - the download should be named after
    # what was asked for, not after whichever file on disk happened to
    # satisfy it.
    def _named(path: str) -> FileResponse:
        return FileResponse(path, filename=f"project_{project_id}_{filename}")

    proj_dir = os.path.join(settings.DATA_DIR, f"project_{project_id}")
    file_path = os.path.join(proj_dir, filename)

    if os.path.exists(file_path):
        return _named(file_path)

    # Fallback to alternate formats if requested format does not exist on disk
    if os.path.exists(proj_dir):
        for cand in ["scene_clean.ply", "scene.ply", "scene.splat", "scene.lcc"]:
            cand_path = os.path.join(proj_dir, cand)
            if os.path.exists(cand_path):
                try:
                    shutil.copy(cand_path, file_path)
                except Exception:
                    pass
                return _named(cand_path)

    from fastapi import HTTPException
    raise HTTPException(status_code=404, detail=f"Asset '{filename}' not found for project {project_id}")


# ── Static File Mounts ────────────────────────────────────────
base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Serve uploaded data (images, 3DGS output)
app.mount("/data", StaticFiles(directory=os.path.join(base_dir, "data")), name="data")

# Serve legacy viewer (kept as fallback during transition)
viewer_dir = os.path.join(base_dir, "viewer")
if os.path.isdir(viewer_dir):
    app.mount("/viewer", StaticFiles(directory=viewer_dir, html=True), name="viewer")

# Serve Next.js frontend (production build output)
frontend_out_dir = os.path.join(base_dir, "frontend-next", "out")
frontend_legacy_dir = os.path.join(base_dir, "frontend")

if os.path.isdir(frontend_out_dir):
    # Production: serve Next.js static export
    app.mount("/", StaticFiles(directory=frontend_out_dir, html=True), name="frontend")
else:
    # Fallback: serve legacy frontend
    @app.get("/", response_class=HTMLResponse)
    def home():
        index_path = os.path.join(frontend_legacy_dir, "index.html")
        if os.path.exists(index_path):
            with open(index_path, "r") as f:
                return f.read()
        return HTMLResponse("<h1>ArticulAIT</h1><p>Frontend not built. Run: cd frontend-next && npm run build</p>")

    # Serve legacy CSS/JS at root
    @app.get("/style.css")
    def get_css():
        # pyrefly: ignore [missing-import]
        from fastapi.responses import FileResponse
        return FileResponse(os.path.join(frontend_legacy_dir, "style.css"))

    @app.get("/app.js")
    def get_js():
        # pyrefly: ignore [missing-import]
        from fastapi.responses import FileResponse
        return FileResponse(os.path.join(frontend_legacy_dir, "app.js"))
