"""
ArticulAIT — Walkthrough Route
Triggers the 3D reconstruction pipeline and reports status from the database.
"""
# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import Session
import asyncio
import json

from backend.core.database import get_db, SessionLocal
from backend.core.task_queue import enqueue_pipeline, run_pipeline_async, register_task, update_step
from backend.models.schema import Project, PipelineStep

router = APIRouter()

# ── Define the pipeline steps ────────────────────────────────
PIPELINE_STEPS = [
    {"step_number": 1, "step_name": "Image Preprocessing & Validation"},
    {"step_number": 2, "step_name": "3D Reconstruction (VGGT / COLMAP)"},
    {"step_number": 3, "step_name": "Depth Estimation"},
    {"step_number": 4, "step_name": "3D Gaussian Splatting Training"},
    {"step_number": 5, "step_name": "Scene Export & Optimization"},
]


@register_task("run_reconstruction_pipeline")
def run_reconstruction_pipeline(project_id: int, **kwargs):
    """
    Master pipeline task — runs all reconstruction steps sequentially via PipelineOrchestrator.
    This runs in a background thread via the task queue.
    """
    from backend.services.pipeline_orchestrator import PipelineOrchestrator

    db = SessionLocal()
    try:
        project = db.query(Project).get(project_id)
        if not project:
            print(f"[ERROR] Project {project_id} not found")
            return
        
        project.status = "processing"
        db.commit()

        # Instantiate the orchestrator and run the pipeline
        orchestrator = PipelineOrchestrator(project_id, update_step_callback=update_step)
        success = orchestrator.run()

        if success:
            project.status = "completed"
            db.commit()
            print(f"[OK] Pipeline completed successfully for project {project_id}")
        else:
            project.status = "failed"
            db.commit()
            print(f"[FAILED] Pipeline failed for project {project_id}")

    except Exception as e:
        print(f"[ERROR] Master pipeline error for project {project_id}: {e}")
        import traceback
        traceback.print_exc()
        try:
            project = db.query(Project).get(project_id)
            if project:
                project.status = "failed"
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


from typing import Optional
from fastapi import Query

@router.post("/walkthrough/generate")
async def generate_walkthrough(
    project_id: Optional[int] = Query(None),
    force: bool = Query(False),
    db: Session = Depends(get_db)
):
    """Trigger the reconstruction pipeline for the specified or most recent project."""
    if project_id:
        project = db.query(Project).get(project_id)
    else:
        project = db.query(Project).order_by(Project.id.desc()).first()

    if not project:
        return {"status": "error", "message": "No project found. Upload images first."}

    # Gate E rows 87-89 (per-scene 3D caching / scene reuse): re-opening an
    # already-processed scene should be a cache hit, not a silent full
    # regeneration. This replaces a bare `project.status == "completed"`
    # check (which trusts a DB flag even if the photos changed or the output
    # files are gone) with a real fingerprint + artifact-presence check.
    from backend.services.scene_cache_service import check_scene_cache
    cache_result = check_scene_cache(project.id)
    if cache_result["cache_hit"] and not force:
        return {
            "status": "completed",
            "project_id": project.id,
            "message": "Project reconstruction is already completed — reusing cached scene assets.",
            "cache_hit": True,
            "cache_reason": cache_result["reason"],
            "cached_at": cache_result["cached_at"],
        }

    # Fallback for legacy/already-completed projects with no cache manifest
    # yet (either processed before scene_cache_service existed, or processed
    # by a pipeline branch that didn't write one — e.g. the 2.5D fallback
    # path, before that was wired up). Rather than just trusting the DB
    # status flag and returning, backfill a real manifest now from the
    # project's current on-disk images/artifacts, so this project starts
    # getting genuine cache hits on the next check instead of staying stuck
    # reporting "no_cache_manifest" forever.
    if project.status == "completed" and not force and cache_result["reason"] == "no_cache_manifest":
        from backend.services.scene_cache_service import write_scene_cache_manifest
        backfilled = write_scene_cache_manifest(project.id)
        return {
            "status": "completed",
            "project_id": project.id,
            "message": "Project reconstruction is already completed.",
            "cache_hit": False,
            "cache_reason": "cache_manifest_backfilled" if backfilled else "no_cache_manifest_legacy_project",
        }

    # Initialize pipeline steps in database
    project.status = "processing"
    db.commit()
    enqueue_pipeline(project.id, PIPELINE_STEPS)

    # Launch pipeline in background thread
    run_pipeline_async(project.id, "run_reconstruction_pipeline")

    return {
        "status": "processing",
        "project_id": project.id,
        "message": f"Reconstruction pipeline started for Project #{project.id}.",
    }


@router.get("/projects/{project_id}/scene-cache")
async def get_scene_cache_status(project_id: int, db: Session = Depends(get_db)):
    """
    Gate E rows 87-89 (per-scene 3D caching / scene reuse) — read-only status
    check, no side effects. Lets the UI (or a manual check) confirm that
    re-opening a processed scene is in fact backed by a cache hit rather than
    a claim we can't demonstrate: reports whether the current photo set still
    matches what was cached, and whether the expected output files are still
    on disk.
    """
    from backend.services.scene_cache_service import check_scene_cache

    project = db.query(Project).get(project_id)
    if not project:
        return {"status": "error", "message": f"Project {project_id} not found."}

    return {"status": "ok", **check_scene_cache(project_id)}


@router.get("/walkthrough/status")
async def get_status(db: Session = Depends(get_db)):
    """Get pipeline status (backwards-compatible with old frontend)."""
    project = db.query(Project).order_by(Project.id.desc()).first()
    if not project:
        return {"step": 0, "message": "No project found."}

    # Map to old format for legacy frontend compatibility
    if project.status == "completed":
        return {"step": 4, "message": "3D Walkthrough Generation Complete!"}
    elif project.status == "failed":
        return {"step": -1, "message": "Pipeline failed."}
    elif project.status == "processing":
        steps = db.query(PipelineStep).filter(
            PipelineStep.project_id == project.id
        ).order_by(PipelineStep.step_number).all()
        
        current_step = 1
        current_message = "Processing..."
        for step in steps:
            if step.status == "running":
                current_step = step.step_number
                current_message = step.message or step.step_name
                break
            elif step.status == "completed":
                current_step = step.step_number
                current_message = step.step_name
        
        return {"step": current_step, "message": current_message}
    
    return {"step": 0, "message": "Ready to process."}


@router.websocket("/ws/pipeline/{project_id}")
async def pipeline_websocket(websocket: WebSocket, project_id: int):
    """WebSocket endpoint for real-time pipeline progress updates."""
    await websocket.accept()
    try:
        while True:
            db = SessionLocal()
            try:
                project = db.query(Project).get(project_id)
                if not project:
                    await websocket.send_json({"error": "Project not found"})
                    break

                steps = db.query(PipelineStep).filter(
                    PipelineStep.project_id == project_id
                ).order_by(PipelineStep.step_number).all()

                payload = {
                    "project_id": project.id,
                    "project_status": project.status,
                    "steps": [
                        {
                            "step_number": s.step_number,
                            "step_name": s.step_name,
                            "status": s.status,
                            "progress": s.progress,
                            "message": s.message,
                        }
                        for s in steps
                    ],
                }
                await websocket.send_json(payload)

                # Stop sending if pipeline is done
                if project.status in ("completed", "failed"):
                    break

            finally:
                db.close()

            await asyncio.sleep(1)  # Poll every second
    except WebSocketDisconnect:
        pass


# pyrefly: ignore [missing-import]
from fastapi import Query

@router.get("/walkthrough/metrics/pass-rate")
def get_quality_pass_rate_metric(
    window: int = Query(100, ge=1, le=1000, description="Rolling window size for 8+ photo listings"),
    db: Session = Depends(get_db)
):
    """
    §3.3 Launch Target Metric Endpoint: Tracks pass rate for 8+-photo listings producing acceptable 3DGS walkthroughs.
    Target: >= 75% acceptable rate over configurable rolling window (e.g. last 20 / last 100 listings).
    """
    from backend.services.metrics_service import compute_rolling_pass_rate
    return compute_rolling_pass_rate(db, window=window)


@router.get("/projects/{project_id}/camera-path")
@router.get("/walkthrough/camera-path/{project_id}")
def get_guided_camera_path(
    project_id: int,
    db: Session = Depends(get_db)
):
    """
    §9.1 Guided Bézier Camera Path Endpoint: Computes smooth 3D camera flythrough path
    (positions & look-at targets) derived from canonical scene geometry bounds.
    Shared source of truth for both in-viewer guided tour AND video export pipeline.
    """
    from backend.services.camera_path_service import generate_bezier_camera_path
    
    project = db.query(Project).get(project_id)
    scene_bounds = None
    num_rooms = 1
    
    if project and project.scene and project.scene.bounds_min and project.scene.bounds_max:
        scene_bounds = {
            "min": project.scene.bounds_min,
            "max": project.scene.bounds_max,
        }
        
    return generate_bezier_camera_path(scene_bounds=scene_bounds, num_rooms=num_rooms)