"""
ArticulAIT — Upload Route
Handles image uploads, creates projects, stores metadata in SQLite.
"""
# pyrefly: ignore [missing-import]
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from enum import Enum
from typing import Optional
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import Session
import os
import shutil
from PIL import Image as PILImage

from backend.core import settings
from backend.core.database import get_db
from backend.models.schema import Project, ProjectImage, Scene, AssetVersion

def is_equirectangular(img_path: str) -> bool:
    try:
        w, h = PILImage.open(img_path).size
        return abs(w / h - 2.0) < 0.05
    except Exception:
        return False

router = APIRouter()

UPLOAD_DIR = os.path.join(settings.DATA_DIR, "raw_images")


def safe_clear_dir(dir_path: str):
    """Safely clear contents of a directory without raising errors on locked files."""
    if not os.path.exists(dir_path):
        return
    for filename in os.listdir(dir_path):
        file_path = os.path.join(dir_path, filename)
        try:
            if os.path.isfile(file_path) or os.path.islink(file_path):
                os.unlink(file_path)
            elif os.path.isdir(file_path):
                shutil.rmtree(file_path, ignore_errors=True)
        except Exception as e:
            print(f"Warning: Could not remove {file_path} during cleanup: {e}")


@router.post("/upload")
async def upload_images(
    files: list[UploadFile] = File(...),
    force: bool = Form(False),
    db: Session = Depends(get_db),
):
    """Upload images and create a new reconstruction project.

    `force`: bypass the SHA-256 content-fingerprint cache below and always
    run a fresh reconstruction, even if these exact photos were already
    uploaded before. Without this, an upload whose files hash identically to
    an earlier COMPLETED project silently short-circuits to that old
    project (see "cached_match" below) with no new processing at all - which
    previously had no visible signal to the user and no way to opt out, so
    a legitimate "these look like new photos to me" upload could silently
    reuse a stale (possibly low-quality) old result forever.
    """
    
    # Validate file count
    if len(files) > settings.MAX_UPLOAD_IMAGES:
        raise HTTPException(
            status_code=400,
            detail=f"Maximum {settings.MAX_UPLOAD_IMAGES} images allowed."
        )

    # ── Wipe old pipeline data for a fresh run ──
    safe_clear_dir(UPLOAD_DIR)
    for folder in ["colmap_output", "3dgs_output"]:
        folder_path = os.path.join(settings.DATA_DIR, folder)
        safe_clear_dir(folder_path)
        if os.path.exists(folder_path):
            try:
                shutil.rmtree(folder_path, ignore_errors=True)
            except Exception:
                pass

    os.makedirs(UPLOAD_DIR, exist_ok=True)

    # ── Create uncommitted project record in database ──
    project = Project(
        name=f"Project {_next_project_number(db)}",
        status="uploading",
        image_count=0,
    )
    db.add(project)

    # ── Save files and record metadata (optimized batch streaming) ──
    import zipfile

    # Was: ANY .splat/.ply/.lcc/.glb/.obj/.gltf found anywhere in the batch
    # immediately abandoned the whole request and rerouted to
    # _handle_3d_upload using ONLY that one file - silently discarding every
    # other file in the batch, including any real photos already read.
    # Concretely: picking a photos folder that also happens to contain a
    # previously-downloaded scene_clean.ply (e.g. from exporting an earlier
    # walkthrough) meant every one of those real photos got thrown away with
    # no warning, and the project was created from the stray .ply instead -
    # every single time, for as long as that file kept sitting in the
    # folder. Now a 3D-model file only triggers the direct-3D-upload path
    # when there's no real photo/zip content in the same batch to lose;
    # otherwise it's skipped (and reported back) so the actual photos still
    # go through reconstruction.
    IMAGE_EXTS = ('.png', '.jpg', '.jpeg', '.webp', '.heic', '.bmp', '.tiff')
    has_image_or_zip = any(
        os.path.splitext(os.path.basename((f.filename or "").replace('\\', '/')))[1].lower()
        in IMAGE_EXTS + ('.zip',)
        for f in files
    )
    skipped_model_files = []

    saved = []
    try:
        # Pre-allocate ProjectImages batch list
        db_records = []
        for file in files:
            raw_fname = file.filename or "uploaded_file"
            fname = os.path.basename(raw_fname.replace('\\', '/')).strip()
            content = await file.read()
            ext = os.path.splitext(fname)[1].lower()

            # If user uploaded a 3D model file (.splat, .ply, .lcc, .glb, .obj), route directly to 3D upload handler
            if ext in ('.splat', '.ply', '.lcc', '.glb', '.obj', '.gltf'):
                if has_image_or_zip:
                    # Mixed batch: almost certainly a stray leftover 3D
                    # export sitting alongside real photos rather than an
                    # intentional direct-3D upload. Skip it, keep the real
                    # photos.
                    skipped_model_files.append(fname)
                    continue
                db.rollback()
                import io
                from fastapi import UploadFile as TempUploadFile
                temp_file = TempUploadFile(filename=fname, file=io.BytesIO(content))
                target_ext = '.glb' if ext == '.gltf' else ext
                return await _handle_3d_upload(file=temp_file, fname=fname, ext=target_ext, db=db)

            # If user uploaded a .zip file (e.g. cactus.zip), extract contained photos & 3D files
            if ext == '.zip':
                try:
                    import io
                    extracted_3d_file = None
                    with zipfile.ZipFile(io.BytesIO(content)) as zf:
                        for member in zf.infolist():
                            if member.is_dir():
                                continue
                            
                            # Normalize Windows backslashes and strip macOS metadata paths
                            norm_path = member.filename.replace('\\', '/')
                            if '__MACOSX' in norm_path or '/.' in norm_path:
                                continue
                                
                            member_fname = os.path.basename(norm_path).strip()
                            if not member_fname or member_fname.startswith('.'):
                                continue
                            
                            member_ext = os.path.splitext(member_fname)[1].lower()

                            # 1. Handle 3D model files inside ZIP (.splat, .ply, .lcc)
                            if member_ext in ('.splat', '.ply', '.lcc'):
                                member_path = os.path.join(UPLOAD_DIR, member_fname)
                                with open(member_path, "wb") as f_out:
                                    f_out.write(zf.read(member.filename))
                                extracted_3d_file = (member_fname, member_path)

                            # 2. Handle image files inside ZIP
                            elif member_ext in ('.png', '.jpg', '.jpeg', '.webp', '.heic', '.bmp', '.tiff'):
                                member_path = os.path.join(UPLOAD_DIR, member_fname)
                                img_content = zf.read(member.filename)
                                with open(member_path, "wb") as f_out:
                                    f_out.write(img_content)
                                file_size = len(img_content)
                                
                                import hashlib
                                h_val = hashlib.sha256(img_content).hexdigest()
                                
                                w, h = None, None
                                try:
                                    import io
                                    with PILImage.open(io.BytesIO(img_content)) as img:
                                        w, h = img.size
                                except Exception:
                                    pass
                                saved.append((member_fname, member_path, w, h, file_size, h_val))

                    # If the ZIP contained a 3D asset, route to 3D upload handler
                    if extracted_3d_file:
                        m_name, m_path = extracted_3d_file
                        m_ext = os.path.splitext(m_name)[1].lower()
                        db.rollback()
                        from fastapi import UploadFile as TempUploadFile
                        with open(m_path, "rb") as f_3d:
                            temp_file = TempUploadFile(filename=m_name, file=io.BytesIO(f_3d.read()))
                            return await _handle_3d_upload(file=temp_file, fname=m_name, ext=m_ext, db=db)
                except Exception as zip_err:
                    print(f"[upload] Warning: Failed to extract ZIP archive '{fname}': {zip_err}")
                continue

            if not ext in ('.png', '.jpg', '.jpeg', '.webp', '.heic', '.bmp', '.tiff'):
                continue

            filepath = os.path.join(UPLOAD_DIR, fname)
            with open(filepath, "wb") as f:
                f.write(content)

            file_size = len(content)

            # Compute SHA-256 hash in-memory (§7.1)
            import hashlib, io
            h_val = hashlib.sha256(content).hexdigest()

            # Quick PIL header read in-memory without decoding full image pixels
            width, height = None, None
            try:
                with PILImage.open(io.BytesIO(content)) as img:
                    width, height = img.size
            except Exception:
                pass

            saved.append((fname, filepath, width, height, file_size, h_val))

        if not saved:
            db.rollback()
            raise HTTPException(status_code=400, detail="No valid images or ZIP files were provided.")

        # Compute aggregate content fingerprint over all uploaded files
        file_hashes = [s[5] for s in saved]
        agg_content_hash = hashlib.sha256("".join(sorted(file_hashes)).encode('utf-8')).hexdigest() if file_hashes else None

        # Check SHA-256 Fingerprint Cache (§7.1 / §7.2)
        if agg_content_hash and not force:
            cached_project = db.query(Project).filter(
                Project.content_hash == agg_content_hash,
                Project.status == "completed"
            ).first()

            if cached_project:
                print(f"[Fingerprint Cache HIT] Content hash {agg_content_hash[:12]} matched project #{cached_project.id}")
                db.rollback()
                return {
                    "status": "cached_match",
                    "project_id": cached_project.id,
                    "content_hash": agg_content_hash,
                    "message": "Instant cache hit: exact SHA-256 content fingerprint match.",
                    "image_count": cached_project.image_count,
                    "created_at": cached_project.created_at.isoformat() if cached_project.created_at else None,
                }

        # ── Automated Capture Quality Validation (Blur, Overlap) ──
        all_file_paths = [s[1] for s in saved]
        try:
            from backend.services.image_validation import validate_upload_batch
            validation_report = validate_upload_batch(all_file_paths)
            import json
            with open("d:/articulait/validation_debug.json", "w") as dbg_f:
                json.dump(validation_report, dbg_f, indent=2)
            
            if validation_report.get("status") == "rejected":
                db.rollback()
                safe_clear_dir(UPLOAD_DIR)
                raise HTTPException(
                    status_code=400,
                    detail={
                        "message": "Upload rejected due to failing validation thresholds.",
                        "validation_report": validation_report
                    }
                )
                
            if validation_report.get("status") == "passed":
                project.quality_flag = "passed"
            elif validation_report.get("status") == "warning":
                project.quality_flag = "needs_recapture"
            else:
                project.quality_flag = "pending_review"
        except HTTPException:
            raise
        except Exception as val_err:
            print(f"[upload] Warning: Automated upload validation error: {val_err}")
            validation_report = {"status": "error", "error": str(val_err)}

        # ── Panorama Type Detection ──
        pano_count = sum(1 for p in all_file_paths if is_equirectangular(p))
        if pano_count == len(all_file_paths) and pano_count > 0:
            project.panorama_type = "equirectangular"
        elif pano_count > 0:
            project.panorama_type = "mixed"
        else:
            project.panorama_type = "flat"

        # Commit project and images together atomically
        project.image_count = len(saved)
        project.content_hash = agg_content_hash
        project.status = "uploaded"
        db.commit()
        db.refresh(project)

        # Batch insert all ProjectImage records in 1 database call
        db_records = [
            ProjectImage(
                project_id=project.id,
                filename=fname,
                filepath=fpath,
                width=w,
                height=h,
                file_size=sz,
                content_hash=h_val,
            )
            for (fname, fpath, w, h, sz, h_val) in saved
        ]
        db.add_all(db_records)
        db.commit()

        response = {
            "message": "Images successfully uploaded",
            "project_id": project.id,
            "count": len(saved),
            "files": [s[0] for s in saved],
            "validation": validation_report,
        }
        if skipped_model_files:
            response["skipped_model_files"] = skipped_model_files
            response["message"] += (
                f" ({len(skipped_model_files)} 3D model file(s) in the selection "
                f"were ignored, not used as photos: {', '.join(skipped_model_files)})"
            )
        return response

    except HTTPException:
        raise
    except Exception as e:
        safe_clear_dir(UPLOAD_DIR)
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to process upload: {str(e)}")


@router.get("/images")
async def get_images():
    """List uploaded images (legacy endpoint for old frontend)."""
    if not os.path.exists(UPLOAD_DIR):
        return {"images": []}
    files = [f for f in os.listdir(UPLOAD_DIR) if f.lower().endswith(('.png', '.jpg', '.jpeg'))]
    files.sort()
    return {"images": [f"/data/raw_images/{f}" for f in files]}


def _next_project_number(db: Session) -> int:
    """Get the next project number for auto-naming."""
    count = db.query(Project).count()
    return count + 1


class SceneFileFormat(str, Enum):
    splat = "splat"
    ply = "ply"
    lcc = "lcc"
    glb = "glb"
    obj = "obj"


@router.post("/upload/scene", summary="Upload 3D Scene File")
async def upload_scene_file(
    file: UploadFile = File(..., description="3D scene file to upload"),
    file_format: SceneFileFormat = Form(
        SceneFileFormat.splat,
        description="Format of the uploaded file"
    ),
    project_id: Optional[int] = Form(None, description="If set, upload becomes a new version of this existing project's asset instead of creating a new project"),
    db: Session = Depends(get_db),
):
    """
    Upload a pre-built 3D scene asset directly.
    Select the format from the dropdown and upload the matching file.
    - **splat** — Gaussian Splatting `.splat` binary
    - **ply**   — Point cloud / mesh `.ply` file
    - **lcc**   — ArticulAIT LCC1 container `.lcc` file
    - **glb**   — Binary GLTF `.glb` 3D mesh model
    - **obj**   — Wavefront `.obj` 3D mesh file
    """
    fname = file.filename or f"scene.{file_format.value}"
    ext_from_file = os.path.splitext(fname)[1].lower()
    ext = f".{file_format.value}"  # always trust the dropdown selection

    # Warn if file extension doesn't match selected format (but don't block)
    if ext_from_file and ext_from_file != ext:
        print(f"[upload/scene] Warning: file extension '{ext_from_file}' does not match selected format '{ext}'. Using selected format.")

    return await _handle_3d_upload(file=file, fname=fname, ext=ext, db=db, project_id=project_id)


@router.post("/upload/splat", summary="Upload Splat File (Legacy Alias)")
async def upload_splat_alias(file: UploadFile = File(...), project_id: Optional[int] = Form(None), db: Session = Depends(get_db)):
    fname = file.filename or "scene.splat"
    return await _handle_3d_upload(file=file, fname=fname, ext=".splat", db=db, project_id=project_id)


@router.post("/upload/ply", summary="Upload PLY File (Legacy Alias)")
async def upload_ply_alias(file: UploadFile = File(...), project_id: Optional[int] = Form(None), db: Session = Depends(get_db)):
    fname = file.filename or "scene.ply"
    return await _handle_3d_upload(file=file, fname=fname, ext=".ply", db=db, project_id=project_id)


@router.post("/upload/lcc", summary="Upload LCC File (Legacy Alias)")
async def upload_lcc_alias(file: UploadFile = File(...), project_id: Optional[int] = Form(None), db: Session = Depends(get_db)):
    fname = file.filename or "scene.lcc"
    return await _handle_3d_upload(file=file, fname=fname, ext=".lcc", db=db, project_id=project_id)


def _write_canonical_scene_files(data_proj_dir: str, ext: str, content: bytes, project_id: int) -> dict:
    """
    Writes whatever was uploaded/restored into this project's "live" scene
    file paths — the ones the viewer and pipeline always read from
    (scene.splat / scene_clean.ply / scene.lcc / etc). Shared by the upload
    path and the version-restore path (routes/projects.py) so both produce
    byte-identical results for the same input instead of two copies of this
    logic drifting apart.
    """
    dest_splat = os.path.join(data_proj_dir, "scene.splat")
    dest_ply_clean = os.path.join(data_proj_dir, "scene_clean.ply")
    dest_ply_base = os.path.join(data_proj_dir, "scene.ply")
    dest_lcc = os.path.join(data_proj_dir, "scene.lcc")
    dest_glb = os.path.join(data_proj_dir, "scene_mesh.glb")
    dest_obj = os.path.join(data_proj_dir, "scene_mesh.obj")

    if ext == ".glb":
        with open(dest_glb, "wb") as f:
            f.write(content)
    elif ext == ".obj":
        with open(dest_obj, "wb") as f:
            f.write(content)
    elif ext == ".lcc":
        # Extract binary splat payload from LCC1 container header
        import struct
        splat_bytes = content
        if content.startswith(b"LCC1") and len(content) > 8:
            try:
                header_len = struct.unpack(">I", content[4:8])[0]
                splat_bytes = content[8 + header_len:]
            except Exception:
                pass
        with open(dest_splat, "wb") as f:
            f.write(splat_bytes)
        with open(dest_lcc, "wb") as f:
            f.write(content)

    elif ext == ".ply":
        with open(dest_ply_clean, "wb") as f:
            f.write(content)
        with open(dest_ply_base, "wb") as f:
            f.write(content)
        try:
            from scripts.convert_ply_to_splat import convert_ply_to_splat
            convert_ply_to_splat(dest_ply_clean, dest_splat)
        except Exception as ex:
            print(f"[upload] Warning: Failed to convert PLY to SPLAT: {ex}")

    else:  # .splat
        with open(dest_splat, "wb") as f:
            f.write(content)

    # Generate LCC container for .splat / .ply uploads
    if ext in (".splat", ".ply"):
        import json, struct
        splat_bytes = content if ext == ".splat" else (open(dest_splat, "rb").read() if os.path.exists(dest_splat) else content)
        header_data = {
            "format": "ArticulAIT-LCC",
            "version": "1.0",
            "scene_graph_version": 2,
            "canonical_coordinate_frame": {
                "origin": {"x": 0.0, "y": 0.0, "z": 0.0},
                "axis_convention": "Right-Handed",
                "unit": "meters",
                "up_vector": {"x": 0.0, "y": 1.0, "z": 0.0},
            },
            "project_id": project_id,
            "point_count": len(splat_bytes) // 32,
        }
        json_bytes = json.dumps(header_data).encode("utf-8")
        lcc_payload = b"LCC1" + struct.pack(">I", len(json_bytes)) + json_bytes + splat_bytes
        with open(dest_lcc, "wb") as f:
            f.write(lcc_payload)

    return {
        "dest_splat": dest_splat,
        "dest_ply_clean": dest_ply_clean,
        "dest_lcc": dest_lcc,
        "dest_glb": dest_glb,
        "dest_obj": dest_obj,
    }


def _record_asset_version(db: Session, project_id: int, data_proj_dir: str, ext: str, original_filename: str, content: bytes) -> AssetVersion:
    """
    Archives an immutable copy of an uploaded/restored 3D file under
    project_{id}/versions/ and inserts the AssetVersion row for it, marking
    it current and un-marking any prior version. Called on every 3D upload
    (both a brand-new project's first file and a later re-upload targeting
    an existing project), so version 1 always exists and nothing is ever
    silently overwritten without a retrievable prior copy.
    """
    versions_dir = os.path.join(data_proj_dir, "versions")
    os.makedirs(versions_dir, exist_ok=True)

    existing_versions = (
        db.query(AssetVersion)
        .filter(AssetVersion.project_id == project_id)
        .order_by(AssetVersion.version_number.desc())
        .all()
    )
    next_version = (existing_versions[0].version_number + 1) if existing_versions else 1

    for v in existing_versions:
        v.is_current = False

    stored_filename = f"v{next_version}{ext}"
    stored_path = os.path.join(versions_dir, stored_filename)
    with open(stored_path, "wb") as f:
        f.write(content)

    version = AssetVersion(
        project_id=project_id,
        version_number=next_version,
        format=ext.lstrip("."),
        original_filename=original_filename,
        stored_filename=stored_filename,
        size_bytes=len(content),
        is_current=True,
    )
    db.add(version)
    db.commit()
    db.refresh(version)
    return version


async def _handle_3d_upload(file: UploadFile, fname: str, ext: str, db: Session, project_id: Optional[int] = None):
    """
    Shared implementation for all 3D asset uploads (.splat / .ply / .lcc).
    Returns only the filenames (not full paths) of files that were actually created.

    project_id: when None (the default), a brand-new project is created for
    this upload — the original behavior. When set, the upload targets that
    EXISTING project instead: the file becomes a new version of that
    project's asset (see _record_asset_version) rather than an unrelated new
    project, and the "Robust Matching" donor-photo heuristic below is
    skipped entirely, since a project being re-versioned already has
    whatever images/poses it had — there's nothing to bootstrap.
    """
    is_new_project = project_id is None
    if is_new_project:
        project = Project(
            name=fname,
            status="completed",
            image_count=1,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
    else:
        project = db.query(Project).filter(Project.id == project_id).first()
        if not project:
            raise HTTPException(status_code=404, detail=f"Project {project_id} not found.")

    data_proj_dir = os.path.join(settings.DATA_DIR, f"project_{project.id}")
    os.makedirs(data_proj_dir, exist_ok=True)

    content = await file.read()

    # Write explicit manifest marker indicating this is a user-uploaded 3D model
    import json, datetime
    with open(os.path.join(data_proj_dir, "user_uploaded_model.json"), "w") as f_mark:
        json.dump({
            "is_user_uploaded": True,
            "filename": fname,
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat()
        }, f_mark)

    dest_paths = _write_canonical_scene_files(data_proj_dir, ext, content, project.id)
    dest_splat = dest_paths["dest_splat"]
    dest_ply_clean = dest_paths["dest_ply_clean"]
    dest_lcc = dest_paths["dest_lcc"]
    dest_glb = dest_paths["dest_glb"]
    dest_obj = dest_paths["dest_obj"]

    # Archive this upload as a new version of the project's asset (Row 89:
    # "3D asset management — stored, versioned, retrievable").
    version = _record_asset_version(db, project.id, data_proj_dir, ext, fname, content)

    # Ensure images directory exists
    images_dir = os.path.join(data_proj_dir, "images")
    os.makedirs(images_dir, exist_ok=True)

    # ── REMOVED: "Robust Matching against Trained Multi-Photo Projects" ──
    # This used to scan every completed project with image_count > 1 and,
    # whenever ANY of its scene.splat/scene_clean.ply/scene.ply/scene.lcc
    # happened to be within 500 BYTES of the newly uploaded file's size,
    # treated that unrelated project as a "donor": copied its photos into
    # this project's images/ folder, copied its poses.json/sparse/, and
    # overwrote this project's image_count/pose_source/pose_confidence with
    # the donor's values.
    #
    # A same-ish file size across two independently-exported Gaussian splat
    # files is essentially coincidence, not evidence of any real
    # relationship - and it fired constantly: every raw-file upload since
    # project #73 (2026-08-05) inherited image_count=240 / pose_source
    # "vggt"/"colmap" from the same handful of donor chains, all the way
    # through #163/#165/#166, regardless of what was actually uploaded or
    # when. Two concrete harms: (1) the project's metadata claimed a
    # multi-photo reconstruction happened when none did, and (2) if the user
    # then ran "Generate Photo Tour" on one of these projects expecting it
    # to reconstruct from THEIR photos, it would silently train on the
    # donor's leftover frames instead.
    #
    # It also wasn't needed: _handle_reality_capture_poses() (called via the
    # orchestrator below) already estimates a full camera-orbit pose path
    # with zero real images present - see
    # PipelineOrchestrator._estimate_reality_poses_lightweight(), which
    # falls back to 12 synthetic placeholder frame names when images_dir is
    # empty. So this heuristic bought nothing functional; it only fabricated
    # misleading metadata and cross-contaminated projects.
    #
    # A raw 3D-file upload now honestly keeps its own (empty, unless this
    # project already had photos) images/ folder and its own real
    # image_count instead of borrowing someone else's.

    # Trigger PipelineOrchestrator for Reality Capture Bypass
    try:
        from backend.services.pipeline_orchestrator import PipelineOrchestrator
        orchestrator = PipelineOrchestrator(project.id)
        orchestrator.reconstruction_mode = "reality_capture_bypass"
        orchestrator.run()
    except Exception as ex:
        print(f"[upload] Warning: Failed executing orchestrator reality capture bypass: {ex}")

    # Upsert Scene record (keep full paths in DB for internal use)
    splat_url = f"/data/project_{project.id}/scene.splat" if os.path.exists(dest_splat) else None
    ply_url = f"/data/project_{project.id}/scene_clean.ply" if os.path.exists(dest_ply_clean) else None
    lcc_url = f"/data/project_{project.id}/scene.lcc" if os.path.exists(dest_lcc) else None

    existing_scene = db.query(Scene).filter(Scene.project_id == project.id).first()
    if existing_scene:
        existing_scene.splat_path = splat_url
        existing_scene.ply_path = ply_url
        existing_scene.point_count = len(content) // 32
    else:
        db.add(Scene(
            project_id=project.id,
            splat_path=splat_url,
            ply_path=ply_url,
            point_count=len(content) // 32,
        ))
    db.commit()

    # ── Response: show only the file that matches the uploaded format ──
    response = {
        "status": "success",
        "project_id": project.id,
        "scene_id": f"project_{project.id}",
        "uploaded_file": fname,
        "size_bytes": len(content),
        "format": ext.lstrip("."),
        "version_number": version.version_number,
        "version_id": version.id,
        "is_new_project": is_new_project,
    }

    # Always include explicit relative asset URLs for web viewers
    response["splat_url"] = f"/data/project_{project.id}/scene.splat"
    response["ply_url"] = f"/data/project_{project.id}/scene_clean.ply"
    response["lcc_url"] = f"/data/project_{project.id}/scene.lcc"
    response["glb_url"] = f"/data/project_{project.id}/scene_mesh.glb"
    response["obj_url"] = f"/data/project_{project.id}/scene_mesh.obj"

    # Only show the primary output file filename — auto-generated conversions are internal
    if ext == ".splat" and os.path.exists(dest_splat):
        response["splat_file"] = os.path.basename(dest_splat)       # "scene.splat"
    elif ext == ".ply" and os.path.exists(dest_ply_clean):
        response["ply_file"] = os.path.basename(dest_ply_clean)     # "scene_clean.ply"
    elif ext == ".lcc" and os.path.exists(dest_lcc):
        response["lcc_file"] = os.path.basename(dest_lcc)           # "scene.lcc"
    elif ext == ".glb" and os.path.exists(dest_glb):
        response["glb_file"] = os.path.basename(dest_glb)           # "scene_mesh.glb"
    elif ext == ".obj" and os.path.exists(dest_obj):
        response["obj_file"] = os.path.basename(dest_obj)           # "scene_mesh.obj"

    return response

