"""
ArticulAIT — Projects Route
Full CRUD API for managing reconstruction projects.
"""
# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import Session, joinedload
from typing import Optional
import os
import shutil
import math
import traceback
from PIL import Image
import cv2
import numpy as np

from backend.core import settings
from backend.core.database import get_db
from backend.models.schema import Project, ProjectImage, PipelineStep, DetectedObject, Scene, AssetVersion

router = APIRouter()


def _compute_ply_bounds(ply_path: str) -> Optional[dict]:
    """Read a 3DGS PLY file and return the axis-aligned bounding box of the Gaussian means."""
    try:
        import numpy as np
        # pyrefly: ignore [missing-import]
        from plyfile import PlyData
        if not os.path.exists(ply_path):
            return None
        plydata = PlyData.read(ply_path)
        elem = plydata.elements[0]
        x = elem.data['x'].astype(np.float64)
        y = elem.data['y'].astype(np.float64)
        z = elem.data['z'].astype(np.float64)
        # Use 5th-95th percentile to ignore extreme outlier Gaussians
        lo, hi = 5, 95
        x_min, x_max = float(np.percentile(x, lo)), float(np.percentile(x, hi))
        y_min, y_max = float(np.percentile(y, lo)), float(np.percentile(y, hi))
        z_min, z_max = float(np.percentile(z, lo)), float(np.percentile(z, hi))
        center = {
            "x": (x_min + x_max) / 2,
            "y": (y_min + y_max) / 2,
            "z": (z_min + z_max) / 2,
        }
        half_extents = {
            "x": (x_max - x_min) / 2,
            "y": (y_max - y_min) / 2,
            "z": (z_max - z_min) / 2,
        }
        max_extent = max(half_extents["x"], half_extents["y"], half_extents["z"])
        return {"center": center, "half_extents": half_extents, "max_extent": max_extent}
    except Exception as e:
        print(f"[bounds] Could not compute PLY bounds: {e}")
        return None


def _determine_quality_badge(project: Project) -> dict:
    """Computes quality flag, tier label, and human badge text based on splat density & validation."""
    point_cnt = project.scene.point_count if (project.scene and project.scene.point_count) else None
    
    # Check disk splat file if DB point_count is missing
    if point_cnt is None:
        splat_file = os.path.join(settings.DATA_DIR, f"project_{project.id}", "scene.splat")
        if os.path.exists(splat_file):
            point_cnt = os.path.getsize(splat_file) // 32

    q_flag = project.quality_flag or "pending_review"
    if point_cnt is not None:
        if point_cnt >= 1500000:
            q_flag = "high_fidelity"
        elif point_cnt >= 750000:
            q_flag = "standard"
        else:
            q_flag = "needs_recapture"

    badge_map = {
        "high_fidelity": {"label": "High Fidelity", "badge": "High Fidelity ✨", "color": "emerald"},
        "passed": {"label": "High Fidelity", "badge": "High Fidelity ✨", "color": "emerald"},
        "standard": {"label": "Standard", "badge": "Standard 🟢", "color": "blue"},
        "needs_recapture": {"label": "Needs Re-capture", "badge": "LOW DENSITY — recommend re-capture ⚠️", "color": "amber"},
        "pending_review": {"label": "Standard", "badge": "Standard 🟢", "color": "blue"},
    }

    info = badge_map.get(q_flag, badge_map["standard"])
    return {
        "quality_flag": q_flag,
        "quality_label": info["label"],
        "quality_badge": info["badge"],
        "quality_color": info["color"],
        "point_count": point_cnt,
    }


def _slerp(q1, q2, t):
    """Spherical linear interpolation for quaternions."""
    q1 = np.array(q1)
    q2 = np.array(q2)
    dot = np.dot(q1, q2)

    if dot < 0.0:
        q1 = -q1
        dot = -dot

    if dot > 0.9995:
        result = q1 + t * (q2 - q1)
        return result / np.linalg.norm(result)

    theta_0 = np.arccos(dot)
    sin_theta_0 = np.sin(theta_0)
    theta = t * theta_0
    sin_theta = np.sin(theta)

    s1 = np.cos(theta) - dot * sin_theta / sin_theta_0
    s2 = sin_theta / sin_theta_0
    return (s1 * q1) + (s2 * q2)

def _interpolate_pose(idx: int, registered_poses: dict, total_frames: int) -> dict:
    """
    Finds nearest registered poses and interpolates/extrapolates position and orientation.
    """
    sorted_indices = sorted(registered_poses.keys())
    if not sorted_indices:
        # If no registered poses exist, return a default pose
        return {
            "position": {"x": 0.0, "y": 0.0, "z": -float(idx)},
            "target": {"x": 0.0, "y": 0.0, "z": -(float(idx) + 1.0)},
            "quat": [1.0, 0.0, 0.0, 0.0]
        }

    # Find neighbors
    before_indices = [i for i in sorted_indices if i < idx]
    after_indices = [i for i in sorted_indices if i > idx]

    p1_idx, p2_idx = None, None

    if before_indices and after_indices:
        # Interpolate
        p1_idx, p2_idx = max(before_indices), min(after_indices)
    elif before_indices:
        # Extrapolate forward
        if len(before_indices) > 1:
            p1_idx = before_indices[-2]
            p2_idx = before_indices[-1]
        else: # Only one registered frame before, use it as both p1 and p2
            p1_idx = before_indices[-1]
            p2_idx = before_indices[-1]
    elif after_indices:
        # Extrapolate backward
        if len(after_indices) > 1:
            p1_idx = after_indices[0]
            p2_idx = after_indices[1]
        else: # Only one registered frame after, use it as both p1 and p2
            p1_idx = after_indices[0]
            p2_idx = after_indices[0]
    else:
        # This case should ideally be caught by the `if not sorted_indices` check,
        # but as a safeguard, if only one registered frame exists and it's not
        # before or after the current idx (i.e., idx == sorted_indices[0]),
        # we use that single frame's pose.
        if sorted_indices:
            single_idx = sorted_indices[0]
            pose = registered_poses[single_idx]
            return {
                "position": pose.get("position", {"x": 0, "y": 0, "z": 0}),
                "target": pose.get("target", {"x": 0, "y": 0, "z": -1}),
                "quat": pose.get("quat", [1.0, 0.0, 0.0, 0.0])
            }
        else:
            # Should not happen if sorted_indices is checked at the beginning
            return {
                "position": {"x": 0.0, "y": 0.0, "z": -float(idx)},
                "target": {"x": 0.0, "y": 0.0, "z": -(float(idx) + 1.0)},
                "quat": [1.0, 0.0, 0.0, 0.0]
            }

    # If p1_idx and p2_idx are the same (e.g., only one registered frame or edge extrapolation)
    if p1_idx == p2_idx:
        pose = registered_poses[p1_idx]
        return {
            "position": pose.get("position", {"x": 0, "y": 0, "z": 0}),
            "target": pose.get("target", {"x": 0, "y": 0, "z": -1}),
            "quat": pose.get("quat", [1.0, 0.0, 0.0, 0.0])
        }

    p1 = registered_poses[p1_idx]
    p2 = registered_poses[p2_idx]

    # Ensure poses have all required keys
    for p in [p1, p2]:
        if "position" not in p or "target" not in p or "quat" not in p:
             return { # Return a default if data is malformed
                "position": {"x": 0.0, "y": 0.0, "z": -float(idx)},
                "target": {"x": 0.0, "y": 0.0, "z": -(float(idx) + 1.0)},
                "quat": [1.0, 0.0, 0.0, 0.0]
            }


    # Calculate interpolation/extrapolation factor
    t = (idx - p1_idx) / (p2_idx - p1_idx)

    # Position (lerp)
    pos1 = np.array([p1["position"]["x"], p1["position"]["y"], p1["position"]["z"]])
    pos2 = np.array([p2["position"]["x"], p2["position"]["y"], p2["position"]["z"]])
    new_pos_arr = pos1 + t * (pos2 - pos1)
    new_pos = {"x": float(new_pos_arr[0]), "y": float(new_pos_arr[1]), "z": float(new_pos_arr[2])}

    # Orientation (slerp)
    q1 = p1.get("quat")
    q2 = p2.get("quat")
    new_quat = _slerp(q1, q2, t)

    # Derive target from new quaternion
    # Assuming forward is -Z in camera space
    forward_vec = np.array([0, 0, -1])
    # Rotate vector using quaternion: q * v * q_conjugate
    # Simplified for pure vector:
    v_prime = new_quat[1:]
    q_scalar = new_quat[0]
    rotated_vec = 2 * np.dot(v_prime, forward_vec) * v_prime \
                + (q_scalar**2 - np.dot(v_prime, v_prime)) * forward_vec \
                + 2 * q_scalar * np.cross(v_prime, forward_vec)

    new_target = {
        "x": new_pos["x"] + rotated_vec[0],
        "y": new_pos["y"] + rotated_vec[1],
        "z": new_pos["z"] + rotated_vec[2],
    }

    return {"position": new_pos, "target": new_target, "quat": new_quat.tolist()}

@router.get("/projects")
async def list_projects(include_splats: bool = False, db: Session = Depends(get_db)):
    """List all reconstruction projects with summary info (excludes 1-photo ad-hoc .splat/.ply/.lcc uploads by default)."""
    projects = db.query(Project).options(joinedload(Project.scene)).order_by(Project.created_at.desc()).all()
    if not include_splats:
        EXCLUDED_EXTENSIONS = ('.splat', '.ply', '.lcc', '.obj', '.glb', '.gltf')
        projects = [
            p for p in projects
            if (p.image_count is not None and p.image_count > 1) and not (p.name and p.name.lower().endswith(EXCLUDED_EXTENSIONS))
        ]

    res = []
    for p in projects:
        q_info = _determine_quality_badge(p)
        res.append({
            "id": p.id,
            "name": p.name,
            "status": p.status,
            "quality_flag": q_info["quality_flag"],
            "quality_label": q_info["quality_label"],
            "quality_badge": q_info["quality_badge"],
            "quality_color": q_info["quality_color"],
            "point_count": q_info["point_count"],
            "image_count": p.image_count,
            "pose_source": getattr(p, "pose_source", "colmap") or "colmap",
            "pose_confidence": getattr(p, "pose_confidence", 1.0) if getattr(p, "pose_confidence", None) is not None else 1.0,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
            "has_scene": p.scene is not None,
            "panorama_type": getattr(p, "panorama_type", "flat") or "flat",
        })
    return {"projects": res}


@router.get("/projects/{project_id}")
async def get_project(project_id: int, db: Session = Depends(get_db)):
    """Get detailed project info including pipeline steps."""
    project = db.query(Project).get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    steps = db.query(PipelineStep).filter(
        PipelineStep.project_id == project_id
    ).order_by(PipelineStep.step_number).all()

    scene_data = None
    if project.scene:
        ply_disk_path = os.path.join(settings.DATA_DIR, f"project_{project_id}", "scene.ply")
        bounds = _compute_ply_bounds(ply_disk_path)

        scene_data = {
            "splat_path": project.scene.splat_path or f"/data/project_{project_id}/scene.splat",
            "ply_path": project.scene.ply_path or f"/data/project_{project_id}/scene_clean.ply",
            "point_count": project.scene.point_count,
            "training_steps": project.scene.training_steps,
            "training_time_seconds": project.scene.training_time_seconds,
            "bounds": bounds,
        }

    q_info = _determine_quality_badge(project)
    return {
        "id": project.id,
        "name": project.name,
        "status": project.status,
        "output_status": getattr(project, "output_status", "completed") or "completed",
        "reason_code": getattr(project, "reason_code", "NONE") or "NONE",
        "failure_reason": getattr(project, "failure_reason", ""),
        "quality_flag": q_info["quality_flag"],
        "quality_label": q_info["quality_label"],
        "quality_badge": q_info["quality_badge"],
        "quality_color": q_info["quality_color"],
        "point_count": q_info["point_count"],
        "image_count": project.image_count,
        "frame_count": project.image_count or 0,
        "pose_source": getattr(project, "pose_source", "colmap") or "colmap",
        "pose_confidence": getattr(project, "pose_confidence", 1.0) if getattr(project, "pose_confidence", None) is not None else 1.0,
        "created_at": project.created_at.isoformat() if project.created_at else None,
        "updated_at": project.updated_at.isoformat() if project.updated_at else None,
        "panorama_type": getattr(project, "panorama_type", "flat") or "flat",
        "has_scene": project.scene is not None,
        "scene": scene_data,
        "pipeline_steps": [
            {
                "step_number": s.step_number,
                "step_name": s.step_name,
                "status": s.status,
                "progress": s.progress,
                "message": s.message,
                "started_at": s.started_at.isoformat() if s.started_at else None,
                "completed_at": s.completed_at.isoformat() if s.completed_at else None,
                "duration_ms": getattr(s, "duration_ms", None),
            }
            for s in steps
        ]
    }


@router.get("/projects/{project_id}/manifest")
async def get_project_manifest(project_id: int, db: Session = Depends(get_db)):
    """
    Returns top-level output manifest for a listing (§6.5).
    Includes status ('completed' | 'fallback_2.5d' | 'failed') and official ReasonCode enum.
    """
    import json
    project = db.query(Project).get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    manifest_path = os.path.join(settings.DATA_DIR, f"project_{project_id}", "scene_manifest.json")
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    # Dynamic fallback if manifest file on disk does not exist yet
    out_status = getattr(project, "output_status", "completed") or ("completed" if project.status == "completed" else "failed")
    r_code = getattr(project, "reason_code", "NONE") or "NONE"
    
    depth_dir = os.path.join(settings.DATA_DIR, f"project_{project_id}", "depths")
    splat_path = os.path.join(settings.DATA_DIR, f"project_{project_id}", "scene.splat")
    ply_path = os.path.join(settings.DATA_DIR, f"project_{project_id}", "scene.ply")

    return {
        "status": out_status,
        "reason_code": r_code,
        "project_id": project.id,
        "photo_count": project.image_count or 0,
        "has_3dgs": os.path.exists(splat_path) or os.path.exists(ply_path),
        "has_depth_maps": os.path.exists(depth_dir) and len(os.listdir(depth_dir)) > 0,
        "generated_at": project.updated_at.isoformat() if project.updated_at else None,
    }



@router.delete("/projects/{project_id}")
async def delete_project(project_id: int, db: Session = Depends(get_db)):
    """Delete a project and all associated assets."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Delete associated files from disk safely
    folder_path = os.path.join(settings.DATA_DIR, f"project_{project_id}")
    if os.path.exists(folder_path):
        try:
            shutil.rmtree(folder_path, ignore_errors=True)
        except Exception as e:
            print(f"Warning: Could not clear folder {folder_path} during project deletion: {e}")

    try:
        # Delete related child records explicitly to prevent FK / session conflicts
        db.query(DetectedObject).filter(DetectedObject.project_id == project_id).delete()
        db.query(PipelineStep).filter(PipelineStep.project_id == project_id).delete()
        db.query(Scene).filter(Scene.project_id == project_id).delete()
        db.query(ProjectImage).filter(ProjectImage.project_id == project_id).delete()
        db.delete(project)
        db.commit()
    except Exception as e:
        db.rollback()
        print(f"Error deleting project #{project_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete project: {str(e)}")

    return {"message": f"Project {project_id} deleted successfully"}


@router.get("/projects/{project_id}/objects")
async def get_detected_objects(
    project_id: int,
    db: Session = Depends(get_db),
    force_refresh: bool = False,
    min_confidence: float = 0.30,
):
    """
    Get all detected objects for a project.
    - On **first call** (or when `force_refresh=true`), runs YOLOv8 detection on project images and saves results.
    - On **subsequent calls**, returns cached results from the database instantly.
    """
    project = db.query(Project).get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    existing = db.query(DetectedObject).filter(
        DetectedObject.project_id == project_id
    ).all()

    # Auto-detect on first call, or when force_refresh is requested
    if not existing or force_refresh:
        if force_refresh and existing:
            db.query(DetectedObject).filter(
                DetectedObject.project_id == project_id
            ).delete()
            db.commit()

        try:
            from backend.services.detection_service import run_detection
            run_detection(project_id=project_id, db=db, confidence=min_confidence)
        except Exception as e:
            print(f"[objects] Detection failed for project {project_id}: {e}")

        existing = db.query(DetectedObject).filter(
            DetectedObject.project_id == project_id
        ).all()

    objects = [obj for obj in existing if obj.confidence >= min_confidence]

    return {
        "project_id": project_id,
        "total": len(objects),
        "objects": [
            {
                "id": obj.id,
                "label": obj.label,
                "confidence": obj.confidence,
                "bbox": {
                    "x": obj.bbox_x,
                    "y": obj.bbox_y,
                    "w": obj.bbox_w,
                    "h": obj.bbox_h,
                },
                "source_image": obj.source_image,
                "model": obj.model_name,
            }
            for obj in objects
        ],
    }



import traceback
from PIL import Image

def ensure_web_optimized_images(project_id: int, img_paths: list[str]) -> list[str]:
    """
    Generates WebP web-optimized tier (max 1920x1080, quality=85) from source uploads.
    Saves them in project_{project_id}/web_images/ and returns list of web image URLs.
    Normalizes file extensions to .webp while preserving basename alignment.
    """
    web_urls: list[str] = []
    try:
        project_dir = os.path.join(settings.DATA_DIR, f"project_{project_id}")
        web_dir = os.path.join(project_dir, "web_images")
        os.makedirs(web_dir, exist_ok=True)

        for path in img_paths:
            fname = os.path.basename(path)
            base_name, _ = os.path.splitext(fname)
            webp_name = f"{base_name}.webp"
            webp_path = os.path.join(web_dir, webp_name)

            if not os.path.exists(webp_path):
                try:
                    with Image.open(path) as img:
                        img.thumbnail((8192, 4096), Image.Resampling.LANCZOS)
                        if img.mode in ("RGBA", "P"):
                            img = img.convert("RGB")
                        img.save(webp_path, "WEBP", quality=95, optimize=True)
                except Exception as img_err:
                    print(f"[Image Processor] Failed to optimize {fname}: {img_err}")
                    web_urls.append(f"/data/project_{project_id}/images/{fname}")
                    continue

            web_urls.append(f"/data/project_{project_id}/web_images/{webp_name}")
    except Exception as e:
        print(f"[projects] Global error in ensure_web_optimized_images for project {project_id}: {e}")
        traceback.print_exc()
        # Safe fallback: return raw image URLs
        return [f"/data/project_{project_id}/images/{os.path.basename(p)}" for p in img_paths]

    return web_urls


import json
def build_project_waypoints(project: Project, db: Session, force_refresh: bool = False) -> dict:
    """
    Core waypoint-building logic for a single room/Project: runs
    ReconstructionService, interpolates any unregistered frames, and builds
    the wall-aware waypoint graph. Caches to waypoints_cache.json.

    Extracted out of the /waypoints endpoint (which now just resolves/seeds
    the Project row and calls this) so backend/services/listing_assembly_service.py
    can reuse the EXACT same per-room logic when assembling a multi-room
    listing (W1-48), instead of re-implementing it and risking drift.
    """
    project_id = project.id
    project_dir = os.path.join(settings.DATA_DIR, f"project_{project_id}")
    cache_path = os.path.join(project_dir, "waypoints_cache.json")

    if force_refresh and os.path.exists(cache_path):
        os.remove(cache_path)

    if not force_refresh and os.path.exists(cache_path):
        try:
            with open(cache_path, "r") as f:
                cached_data = json.load(f)
                if isinstance(cached_data, dict) and "waypoints" in cached_data:
                    for wp in cached_data["waypoints"]:
                        wp.pop("raw_image_url", None)
                        wp.pop("depth_map_url", None)
                return cached_data
        except Exception as e:
            print(f"[Waypoints] Cache read failed, re-generating: {e}")

    images_dir = os.path.join(settings.DATA_DIR, f"project_{project_id}", "images")
    colmap_txt = os.path.join(settings.DATA_DIR, f"project_{project_id}", "sparse", "0", "images.txt")

    from backend.core.utils import natural_sort_key
    img_paths: list[str] = []
    if os.path.isdir(images_dir):
        img_paths = sorted(
            [
                os.path.join(images_dir, f) for f in os.listdir(images_dir)
                if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))
            ],
            key=natural_sort_key
        )

    if not img_paths:
        # Only populate sample photos for project 1 (default demo project)
        if project_id == 1:
            os.makedirs(images_dir, exist_ok=True)
            sample_photos_dir = os.path.join(settings.DATA_DIR, "sample_6mp_photos")
            if not os.path.exists(sample_photos_dir):
                sample_photos_dir = os.path.join(settings.DATA_DIR, "raw_images")
            if os.path.exists(sample_photos_dir):
                for img in os.listdir(sample_photos_dir):
                    if img.lower().endswith(('.jpg', '.jpeg', '.png', '.webp')):
                        try:
                            shutil.copy(os.path.join(sample_photos_dir, img), os.path.join(images_dir, img))
                        except Exception:
                            pass
                img_paths = sorted(
                    [
                        os.path.join(images_dir, f) for f in os.listdir(images_dir)
                        if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))
                    ],
                    key=natural_sort_key
                )

    if not img_paths:
        return {"waypoints": [], "total": 0, "raw_total": 0, "coverage_gaps": [], "source": "none", "confidence": 0.0, "panorama_type": getattr(project, "panorama_type", "flat") or "flat"}

    # ── Run ReconstructionService (§3.2.2) ──
    from backend.services.reconstruction_service import ReconstructionService, ReconstructionParams
    project_dir = os.path.join(settings.DATA_DIR, f"project_{project_id}")
    recon_res = ReconstructionService.run_reconstruction(
        image_paths=img_paths,
        project_dir=project_dir,
        params=ReconstructionParams(enable_depth_mapping=False)
    )

    # Persist pose source and confidence in SQLite schema
    try:
        project.pose_source = recon_res.source_method
        project.pose_confidence = float(recon_res.reconstruction_metadata.get("pose_confidence", 1.0))
        db.commit()
    except Exception as e:
        print(f"[projects] Failed to update pose metadata in DB: {e}")
        db.rollback()

    web_urls = ensure_web_optimized_images(project_id, img_paths)

    img_url_base = f"/data/project_{project_id}/images"

    # Create a numeric-indexed dictionary of registered poses for interpolation
    registered_poses = {}
    fname_to_idx = {os.path.basename(p): i for i, p in enumerate(img_paths)}
    for fname, pose_data in recon_res.poses.items():
        if fname in fname_to_idx:
            registered_poses[fname_to_idx[fname]] = pose_data

    # ── Build waypoints array & resample into uniform visual distance steps (§11.13) ──
    waypoints = []
    for idx, path in enumerate(img_paths):
        fname = os.path.basename(path)
        web_url = web_urls[idx] if idx < len(web_urls) else f"{img_url_base}/{fname}"

        if idx in registered_poses:
            pose_data = registered_poses[idx]
        else:
            pose_data = _interpolate_pose(idx, registered_poses, len(img_paths))

        quat_val = pose_data.get("quaternion", pose_data.get("quat", [1.0, 0.0, 0.0, 0.0]))
        waypoints.append({
            "index":     idx,
            "filename":  fname,
            "image_url": web_url,
            "position":  pose_data["position"],
            "target":    pose_data["target"],
            "quat":      quat_val
        })

    # ── Bypass Resampling to keep ALL frames ──
    resampled_waypoints = waypoints
    coverage_gaps = []

    # ── Build Waypoint Graph (§1.2) ──
    point_cloud = None
    cloud_path = recon_res.dense_point_cloud_path
    if cloud_path and os.path.exists(cloud_path):
        try:
            if cloud_path.lower().endswith(".ply"):
                from plyfile import PlyData
                plydata = PlyData.read(cloud_path)
                elem = plydata.elements[0]
                x = elem.data['x'].astype(np.float64)
                y = elem.data['y'].astype(np.float64)
                z = elem.data['z'].astype(np.float64)
                point_cloud = np.column_stack((x, y, z))
            elif cloud_path.lower().endswith(".txt"):
                pts = []
                with open(cloud_path, "r", encoding="latin-1", errors="ignore") as f:
                    for line in f:
                        if line.strip() and not line.startswith("#"):
                            parts = line.split()
                            if len(parts) >= 4:
                                pts.append([float(parts[1]), float(parts[2]), float(parts[3])])
                if pts:
                    point_cloud = np.array(pts)
        except Exception as e:
            print(f"[projects] Failed to load point cloud for waypoint graph: {e}")

    from backend.services.waypoint_graph import build_waypoint_graph
    try:
        resampled_waypoints = build_waypoint_graph(resampled_waypoints, point_cloud=point_cloud)
    except MemoryError as err:
        print(f"[projects] Waypoint graph build failed due to memory error: {err}")
        resampled_waypoints = build_waypoint_graph(resampled_waypoints, point_cloud=None)
    except Exception as err:
        print(f"[projects] Waypoint graph build failed, falling back to connection heuristic: {err}")
        resampled_waypoints = build_waypoint_graph(resampled_waypoints, point_cloud=None)

    result = {
        "waypoints": resampled_waypoints,
        "total": len(resampled_waypoints),
        "raw_total": len(waypoints),
        "coverage_gaps": coverage_gaps,
        "source": recon_res.source_method,
        "confidence": float(recon_res.reconstruction_metadata.get("pose_confidence", 1.0)),
        "panorama_type": getattr(project, "panorama_type", "flat") or "flat",
    }
    try:
        with open(cache_path, "w") as f:
            json.dump(result, f)
    except Exception as e:
        print(f"[Waypoints] Cache write failed: {e}")
    return result


@router.get("/projects/{project_id}/waypoints")
async def get_waypoints(project_id: int, force_refresh: bool = False, db: Session = Depends(get_db)):
    """
    Return Street View-style waypoints using the confidence-gated pose_router
    (VGGT-1B-Commercial if confidence >= 0.6, else COLMAP fallback).
    Caches results to waypoints_cache.json; use ?force_refresh=true to bypass.
    """
    try:
        project = db.query(Project).filter(Project.id == project_id).first()
        if not project:
            if project_id == 1:
                project = Project(id=1, name="Demo Project", status="completed", output_status="completed")
                db.add(project)
                db.commit()
                db.refresh(project)
            else:
                raise HTTPException(status_code=404, detail="Project not found")

        return build_project_waypoints(project, db, force_refresh=force_refresh)
    except HTTPException:
        raise
    except Exception as exc:
        print(f"[projects] Error generating waypoints for project #{project_id}: {exc}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Waypoints generation failed: {str(exc)}")


@router.get("/projects/{project_id}/camera_path")
async def get_camera_path(project_id: int, db: Session = Depends(get_db)):
    """
    §5.2G / M2 §9.1 — Guided Bézier Camera Path.
    Returns a smooth Catmull-Rom spline path through reconstructed 3D camera poses.
    Uses real COLMAP waypoint positions when available, falls back to scene-bounds orbit.
    """
    from backend.services.camera_path_service import generate_bezier_camera_path

    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Attempt to load real waypoint positions from the waypoints cache file
    cache_path = os.path.join(settings.DATA_DIR, f"project_{project_id}", "waypoints_cache.json")
    real_poses: list[dict] = []
    if os.path.exists(cache_path):
        try:
            import json as _json
            with open(cache_path) as f:
                cached = _json.load(f)
            real_poses = [
                w for w in cached.get("waypoints", [])
                if w.get("position") and all(
                    k in w["position"] for k in ("x", "y", "z")
                )
            ]
        except Exception as e:
            print(f"[camera_path] Cache read failed: {e}")

    # Build scene bounds from real poses or from PLY
    scene_bounds: Optional[dict] = None
    if real_poses:
        xs = [w["position"]["x"] for w in real_poses]
        ys = [w["position"]["y"] for w in real_poses]
        zs = [w["position"]["z"] for w in real_poses]
        cx, cy, cz = float(np.mean(xs)), float(np.mean(ys)), float(np.mean(zs))
        he_x = max(0.5, (float(np.max(xs)) - float(np.min(xs))) / 2)
        he_y = max(0.5, (float(np.max(ys)) - float(np.min(ys))) / 2)
        he_z = max(0.5, (float(np.max(zs)) - float(np.min(zs))) / 2)
        scene_bounds = {
            "center": {"x": cx, "y": cy, "z": cz},
            "half_extents": {"x": he_x, "y": he_y, "z": he_z},
            "max_extent": float(max(he_x, he_y, he_z) * 2),
        }
    else:
        ply_path = os.path.join(settings.DATA_DIR, f"project_{project_id}", "scene_clean.ply")
        bounds = _compute_ply_bounds(ply_path)
        if bounds:
            scene_bounds = bounds

    if real_poses:
        # ── §9.1: Path derived from real reconstructed camera poses ──
        # Sort poses in capture order and build a Catmull-Rom spline through them.
        # Subsample to at most 80 control points for smooth playback.
        step = max(1, len(real_poses) // 80)
        sampled = real_poses[::step]
        if sampled[-1]["index"] != real_poses[-1]["index"]:
            sampled.append(real_poses[-1])

        # Duration: ~0.6s per pose segment, bounded to 15-50s
        duration = round(min(50.0, max(15.0, len(sampled) * 0.6)), 1)
        fps = 30
        total_frames = int(duration * fps)

        # Build Catmull-Rom spline through poses (clamped: duplicate P0 before and PN after)
        positions = [{"x": p["position"]["x"], "y": p["position"]["y"], "z": p["position"]["z"]} for p in sampled]
        targets = []
        for w in sampled:
            t = w.get("target") or w.get("position")
            targets.append({"x": t["x"], "y": t["y"], "z": t["z"]})

        padded_pos = [positions[0]] + positions + [positions[-1]]
        padded_tgt = [targets[0]] + targets + [targets[-1]]
        n_segments = len(positions) - 1

        def catmull_vec(p0, p1, p2, p3, u):
            u2 = u * u; u3 = u2 * u
            return {
                k: 0.5 * (2*p1[k] + (-p0[k]+p2[k])*u + (2*p0[k]-5*p1[k]+4*p2[k]-p3[k])*u2 + (-p0[k]+3*p1[k]-3*p2[k]+p3[k])*u3)
                for k in ("x", "y", "z")
            }

        path_waypoints = []
        cumulative = 0.0
        prev_pos = None
        for frame_idx in range(total_frames):
            t_global = frame_idx / max(1, total_frames - 1)
            seg_f = t_global * n_segments
            seg_i = min(int(seg_f), n_segments - 1)
            seg_t = seg_f - seg_i

            # Padded by 1: padded_pos[seg_i+1] = positions[seg_i]
            p0, p1, p2, p3 = padded_pos[seg_i], padded_pos[seg_i+1], padded_pos[seg_i+2], padded_pos[seg_i+3]
            t0, t1, t2, t3 = padded_tgt[seg_i], padded_tgt[seg_i+1], padded_tgt[seg_i+2], padded_tgt[seg_i+3]
            pos = catmull_vec(p0, p1, p2, p3, seg_t)
            tgt = catmull_vec(t0, t1, t2, t3, seg_t)

            seg_dist = 0.0
            if prev_pos:
                seg_dist = math.sqrt((pos["x"]-prev_pos["x"])**2 + (pos["y"]-prev_pos["y"])**2 + (pos["z"]-prev_pos["z"])**2)
            cumulative += seg_dist
            prev_pos = pos

            path_waypoints.append({
                "frame": frame_idx,
                "time_sec": round(t_global * duration, 3),
                "t": round(t_global, 4),
                "position": {k: round(pos[k], 4) for k in ("x","y","z")},
                "target": {k: round(tgt[k], 4) for k in ("x","y","z")},
                "cumulative_distance": round(cumulative, 4),
            })

        return {
            "status": "success",
            "path_type": "catmull_rom_poses",
            "duration_seconds": duration,
            "sample_rate_fps": fps,
            "total_waypoints": len(path_waypoints),
            "control_point_count": len(sampled),
            "scene_bounds": scene_bounds,
            "waypoints": path_waypoints,
        }
    else:
        # ── Fallback: synthetic Bézier orbit from scene bounds ──
        result = generate_bezier_camera_path(scene_bounds=scene_bounds)
        result["scene_bounds"] = scene_bounds
        return result

def compute_segment_durations(waypoints: list[dict], img_paths: list[str]) -> list[dict]:
    """
    Computes per-segment 3D spatial distance & perceptual grayscale MAD image difference score
    at ingest/API generation time and pre-caches transition_duration (100ms - 400ms) (§11.12).
    """
    if not waypoints:
        return waypoints

    thumb_cache = {}

    def get_thumb_bytes(idx: int):
        if idx in thumb_cache:
            return thumb_cache[idx]
        if idx < len(img_paths) and os.path.exists(img_paths[idx]):
            try:
                with Image.open(img_paths[idx]) as img:
                    img_small = img.convert("L").resize((64, 36), Image.Resampling.BOX)
                    data = list(img_small.getdata())
                    thumb_cache[idx] = data
                    return data
            except Exception:
                pass
        return None

    waypoints[0]["transition_duration"] = 0.15
    waypoints[0]["segment_distance"] = 0.0
    waypoints[0]["perceptual_diff"] = 0.0

    for i in range(1, len(waypoints)):
        curr = waypoints[i]
        prev = waypoints[i - 1]

        # 1. 3D Pose Spatial Distance
        p_curr = curr.get("position", {})
        p_prev = prev.get("position", {})
        dx = p_curr.get("x", 0.0) - p_prev.get("x", 0.0)
        dy = p_curr.get("y", 0.0) - p_prev.get("y", 0.0)
        dz = p_curr.get("z", 0.0) - p_prev.get("z", 0.0)
        dist_3d = math.sqrt(dx * dx + dy * dy + dz * dz)

        # 2. Perceptual Image Difference (Grayscale Mean Absolute Difference MAD)
        t_curr = get_thumb_bytes(i)
        t_prev = get_thumb_bytes(i - 1)
        mad = 0.15
        if t_curr and t_prev and len(t_curr) == len(t_prev):
            diff_sum = sum(abs(a - b) for a, b in zip(t_curr, t_prev))
            mad = (diff_sum / len(t_curr)) / 255.0

        # Combine metric: prefer 3D pose distance if non-synthetic positions exist
        has_real_pose = not (abs(dx - 1.0) < 1e-4 and dy == 0.0 and dz == 0.0)
        if has_real_pose and dist_3d > 0.01:
            ref_dist = 0.3925 # canonical step distance
            scale_ratio = dist_3d / ref_dist
        else:
            ref_mad = 0.15 # canonical perceptual MAD difference
            scale_ratio = mad / ref_mad if ref_mad > 0 else 1.0

        # Clamp pre-cached transition duration between 100ms (0.10s) and 400ms (0.40s)
        duration_sec = round(max(0.10, min(0.40, 0.15 * scale_ratio)), 3)

        curr["segment_distance"] = round(dist_3d, 4)
        curr["perceptual_diff"] = round(mad, 4)
        curr["transition_duration"] = duration_sec

    return waypoints


def resample_waypoints_visually(waypoints: list[dict], img_paths: list[str], target_step_dist: float = 0.12) -> tuple[list[dict], list[dict]]:
    """
    Resamples raw waypoint sequence into uniform cumulative visual distance steps (§11.13).
    Skips redundant/identical consecutive frames and flags genuine source capture coverage gaps.
    Returns (resampled_waypoints, coverage_gaps).
    """
    if not waypoints or len(waypoints) <= 2:
        return waypoints, []

    waypoints = compute_segment_durations(waypoints, img_paths)

    cum_dist = [0.0]
    total_cum = 0.0
    for i in range(1, len(waypoints)):
        d = waypoints[i].get("perceptual_diff", 0.12)
        total_cum += d
        cum_dist.append(round(total_cum, 4))

    resampled = [dict(waypoints[0])]
    resampled[0]["cumulative_visual_distance"] = 0.0
    resampled[0]["index"] = 0
    resampled[0]["transition_duration"] = 0.18

    coverage_gaps = []
    last_raw_idx = 0
    current_target = target_step_dist

    while current_target <= total_cum:
        best_idx = last_raw_idx + 1
        min_delta = abs(cum_dist[best_idx] - current_target) if best_idx < len(waypoints) else float('inf')

        for idx in range(last_raw_idx + 1, len(waypoints)):
            delta = abs(cum_dist[idx] - current_target)
            if delta < min_delta:
                min_delta = delta
                best_idx = idx

        if best_idx > last_raw_idx and best_idx < len(waypoints):
            raw_single_step = waypoints[best_idx].get("perceptual_diff", 0.0)

            # Flag genuine source coverage gap if single raw step exceeds 1.3x target spacing
            if raw_single_step > (1.3 * target_step_dist):
                gap_info = {
                    "from_raw_index": last_raw_idx,
                    "to_raw_index": best_idx,
                    "from_file": waypoints[last_raw_idx].get("filename"),
                    "to_file": waypoints[best_idx].get("filename"),
                    "visual_gap_score": round(raw_single_step, 4),
                    "warning": f"Coverage gap detected between raw frame #{last_raw_idx} ({waypoints[last_raw_idx].get('filename')}) and #{best_idx} ({waypoints[best_idx].get('filename')}) (visual delta {raw_single_step:.4f} > threshold {1.3*target_step_dist:.4f}). Source footage needs denser capture."
                }
                coverage_gaps.append(gap_info)

            wp_copy = dict(waypoints[best_idx])
            wp_copy["raw_index"] = best_idx
            wp_copy["index"] = len(resampled)
            wp_copy["cumulative_visual_distance"] = cum_dist[best_idx]
            wp_copy["transition_duration"] = 0.18 # Flat fixed 180ms crossfade across resampled uniform sequence
            if raw_single_step > (1.3 * target_step_dist):
                wp_copy["coverage_gap"] = True
                wp_copy["gap_warning"] = gap_info["warning"]

            resampled.append(wp_copy)
            last_raw_idx = best_idx
            current_target = cum_dist[last_raw_idx] + target_step_dist
        else:
            break

    if last_raw_idx < len(waypoints) - 1:
        wp_last = dict(waypoints[-1])
        wp_last["raw_index"] = len(waypoints) - 1
        wp_last["index"] = len(resampled)
        wp_last["cumulative_visual_distance"] = cum_dist[-1]
        wp_last["transition_duration"] = 0.18
        resampled.append(wp_last)

    return resampled, coverage_gaps


def generate_interpolated_frame(img_path_a: str, img_path_b: str, alpha: float, output_path: str) -> str:
    """
    Generates motion-aware optical-flow interpolated intermediate frame between img_a and img_b (§11.14).
    Uses multi-scale pyramid Farneback optical flow with occlusion-guided edge preservation.
    Saves generated image to output_path.
    """
    if os.path.exists(output_path):
        return output_path

    img_a = cv2.imread(img_path_a)
    img_b = cv2.imread(img_path_b)
    if img_a is None or img_b is None:
        if img_a is not None:
            cv2.imwrite(output_path, img_a)
        elif img_b is not None:
            cv2.imwrite(output_path, img_b)
        return output_path

    h_a, w_a = img_a.shape[:2]
    h_b, w_b = img_b.shape[:2]
    if (h_a, w_a) != (h_b, w_b):
        img_b = cv2.resize(img_b, (w_a, h_a), interpolation=cv2.INTER_LANCZOS4)

    h, w = h_a, w_a
    gray_a = cv2.cvtColor(img_a, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(img_b, cv2.COLOR_BGR2GRAY)

    flow_ab = cv2.calcOpticalFlowFarneback(
        gray_a, gray_b, None,
        pyr_scale=0.5, levels=5, winsize=31, iterations=5, poly_n=7, poly_sigma=1.5,
        flags=cv2.OPTFLOW_FARNEBACK_GAUSSIAN
    )
    flow_ba = cv2.calcOpticalFlowFarneback(
        gray_b, gray_a, None,
        pyr_scale=0.5, levels=5, winsize=31, iterations=5, poly_n=7, poly_sigma=1.5,
        flags=cv2.OPTFLOW_FARNEBACK_GAUSSIAN
    )

    grid_x, grid_y = np.meshgrid(np.arange(w), np.arange(h))
    grid_x = grid_x.astype(np.float32)
    grid_y = grid_y.astype(np.float32)

    map_xa = grid_x + alpha * flow_ab[:, :, 0]
    map_ya = grid_y + alpha * flow_ab[:, :, 1]
    warped_a = cv2.remap(img_a, map_xa, map_ya, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT)

    map_xb = grid_x - (1.0 - alpha) * flow_ba[:, :, 0]
    map_yb = grid_y - (1.0 - alpha) * flow_ba[:, :, 1]
    warped_b = cv2.remap(img_b, map_xb, map_yb, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT)

    flow_ba_warped = cv2.remap(flow_ba, map_xa, map_ya, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    flow_err = np.sqrt((flow_ab[:, :, 0] + flow_ba_warped[:, :, 0])**2 + (flow_ab[:, :, 1] + flow_ba_warped[:, :, 1])**2)

    occ_mask = np.clip(1.0 - (flow_err / 15.0), 0.0, 1.0)
    occ_mask_3c = np.dstack([occ_mask, occ_mask, occ_mask])

    flow_blend = cv2.addWeighted(warped_a, 1.0 - alpha, warped_b, alpha, 0)
    smooth_blend = cv2.addWeighted(img_a, 1.0 - alpha, img_b, alpha, 0)

    final_blend = (flow_blend * occ_mask_3c + smooth_blend * (1.0 - occ_mask_3c)).astype(np.float32)

    # Contrast-Preserving Unsharp Mask Sharpening for crystal-clear image clarity
    gaussian = cv2.GaussianBlur(final_blend, (0, 0), 2.0)
    sharpened = cv2.addWeighted(final_blend, 1.3, gaussian, -0.3, 0)
    final_output = np.clip(sharpened, 0, 255).astype(np.uint8)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    cv2.imwrite(output_path, final_output)
    return output_path


def fill_coverage_gaps_with_interpolation(project_id: int, waypoints: list[dict], img_paths: list[str], coverage_gaps: list[dict], target_step_dist: float = 0.12) -> tuple[list[dict], list[str]]:
    """
    Automatically synthesizes N intermediate frames using AI Optical Flow interpolation (§11.14)
    for every flagged coverage gap, inserting them into the raw sequence to eliminate gaps.
    Returns (expanded_waypoints, expanded_img_paths).
    """
    if not coverage_gaps:
        return waypoints, img_paths

    img_dir = os.path.join(settings.DATA_DIR, f"project_{project_id}", "images")

    # Process gaps in reverse order so index insertion does not shift remaining gap target indices
    for gap in reversed(coverage_gaps):
        idx_a = gap["from_raw_index"]
        idx_b = gap["to_raw_index"]
        if idx_a >= len(img_paths) or idx_b >= len(img_paths):
            continue

        path_a = img_paths[idx_a]
        path_b = img_paths[idx_b]
        score = gap["visual_gap_score"]

        # Insert N=2 intermediate frames per gap for smoother smaller alpha steps (alpha = 0.33, 0.67)
        n_needed = max(2, math.ceil(score / 0.07) - 1)

        for step in range(1, n_needed + 1):
            alpha = step / (n_needed + 1.0)
            fname_out = f"interp_{idx_a:04d}_{idx_b:04d}_{step:02d}.png"
            path_out = os.path.join(img_dir, fname_out)

            generate_interpolated_frame(path_a, path_b, alpha, path_out)

            insert_idx = idx_a + step
            img_paths.insert(insert_idx, path_out)
            
            p_a_pos = waypoints[idx_a].get("position", {})
            p_b_pos = waypoints[idx_b].get("position", {})
            p_interp = {
                "x": (1.0 - alpha) * p_a_pos.get("x", 0.0) + alpha * p_b_pos.get("x", 0.0),
                "y": (1.0 - alpha) * p_a_pos.get("y", 0.0) + alpha * p_b_pos.get("y", 0.0),
                "z": (1.0 - alpha) * p_a_pos.get("z", 0.0) + alpha * p_b_pos.get("z", 0.0)
            }

            p_a_tgt = waypoints[idx_a].get("target", {})
            p_b_tgt = waypoints[idx_b].get("target", {})
            t_interp = {
                "x": (1.0 - alpha) * p_a_tgt.get("x", 0.0) + alpha * p_b_tgt.get("x", 0.0),
                "y": (1.0 - alpha) * p_a_tgt.get("y", 0.0) + alpha * p_b_tgt.get("y", 0.0),
                "z": (1.0 - alpha) * p_a_tgt.get("z", 0.0) + alpha * p_b_tgt.get("z", 0.0)
            }
            
            waypoints.insert(insert_idx, {
                "index": insert_idx,
                "filename": fname_out,
                "image_url": f"/data/project_{project_id}/images/{fname_out}",
                "raw_image_url": f"/data/project_{project_id}/images/{fname_out}",
                "position": p_interp,
                "target": t_interp,
                "synthetic_interpolated": True
            })

    # Re-index waypoints array
    for i, w in enumerate(waypoints):
        w["index"] = i

    return waypoints, img_paths

# ── Hotspots API (File-based JSON persistence, zero DB schema needed) ──
from pydantic import BaseModel, Field
from typing import Optional

class HotspotCreate(BaseModel):
    waypoint_index: int = Field(0, description="0-based index of frame in waypoints array")
    waypoint_id: Optional[int] = Field(None, description="Optional DB waypoint ID")
    yaw: float = Field(15.0, description="Horizontal orientation in degrees (-180 to 180)")
    pitch: float = Field(-5.0, description="Vertical orientation in degrees (-90 to 90)")
    title: str = Field("Entrance Point", description="Title of the hotspot marker")
    description: str = Field("Welcome to the lobby", description="Detailed hotspot description")
    icon_type: str = Field("info", description="Icon type: info, link, location, door (room connector), etc.")
    # W1-48 room-connector fields: when icon_type="door", these mark this
    # hotspot as a link from THIS project's waypoint to a specific waypoint
    # in ANOTHER project, so backend/services/listing_assembly_service.py can
    # wire a real graph edge between two rooms' waypoint graphs when both
    # projects are member rooms of the same Listing. Ignored otherwise -
    # a plain per-project hotspot with these set but unused by any Listing
    # is harmless. No DB migration needed: hotspots are file-backed
    # (project_{id}/hotspots.json), not stored in the Hotspot ORM table.
    target_project_id: Optional[int] = Field(None, description="W1-48: room connector target project id")
    target_waypoint_index: Optional[int] = Field(None, description="W1-48: room connector target waypoint index")

    model_config = {
        "json_schema_extra": {
            "example": {
                "waypoint_index": 0,
                "yaw": 15.0,
                "pitch": -5.0,
                "title": "Entrance Point",
                "description": "Welcome to the lobby",
                "icon_type": "info"
            }
        }
    }


def _get_hotspots_file_path(project_id: int) -> str:
    return os.path.join(settings.DATA_DIR, f"project_{project_id}", "hotspots.json")


def _load_file_hotspots(project_id: int) -> list[dict]:
    path = _get_hotspots_file_path(project_id)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return data
        except Exception as e:
            print(f"[Hotspots] Error reading hotspots.json for project {project_id}: {e}")
    return []


def _save_file_hotspots(project_id: int, hotspots: list[dict]):
    project_dir = os.path.join(settings.DATA_DIR, f"project_{project_id}")
    os.makedirs(project_dir, exist_ok=True)
    path = _get_hotspots_file_path(project_id)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(hotspots, f, indent=2)


@router.get("/projects/{project_id}/hotspots")
async def get_hotspots(project_id: int):
    """
    Get all hotspots for a project from project_{project_id}/hotspots.json.
    Requires ZERO database tables or schemas.
    """
    file_hotspots = _load_file_hotspots(project_id)

    DEFAULT_HARDCODED_HOTSPOTS = [
        {
            "id": 1,
            "waypoint_id": None,
            "waypoint_index": 0,
            "yaw": 15.0,
            "pitch": -5.0,
            "title": "Entrance Point",
            "description": "Welcome to the interactive tour walkthrough",
            "icon_type": "info",
        }
    ]

    hotspots = file_hotspots if file_hotspots else DEFAULT_HARDCODED_HOTSPOTS
    return {"hotspots": hotspots}


@router.post("/projects/{project_id}/hotspots")
async def create_hotspot(project_id: int, hotspot: HotspotCreate):
    """
    Create a new hotspot. Saves directly to project_{project_id}/hotspots.json on disk.
    Requires ZERO database tables or schemas.
    """
    file_hotspots = _load_file_hotspots(project_id)
    next_id = max([int(h.get("id", 0)) for h in file_hotspots], default=0) + 1

    new_item = {
        "id": next_id,
        # NOTE: the frontend (PanoWalkthrough.tsx) filters hotspots by
        # `h.waypoint_id === currentFrame`, where currentFrame is the 0-based
        # waypoint index — NOT a DB waypoint row id. This used to be
        # hardcoded to None, which meant every hotspot created through this
        # endpoint was silently invisible in the walkthrough (the only
        # hotspots that ever showed up were ones hand-edited directly in
        # hotspots.json with waypoint_id set to a real index). Set it from
        # waypoint_index so hotspots actually render where they're supposed to.
        "waypoint_id": hotspot.waypoint_index,
        "waypoint_index": hotspot.waypoint_index,
        "yaw": hotspot.yaw,
        "pitch": hotspot.pitch,
        "title": hotspot.title,
        "description": hotspot.description,
        "icon_type": hotspot.icon_type,
        "target_project_id": hotspot.target_project_id,
        "target_waypoint_index": hotspot.target_waypoint_index,
    }

    file_hotspots.append(new_item)
    _save_file_hotspots(project_id, file_hotspots)
    return new_item


@router.post("/projects/{project_id}/hotspots/auto-generate")
async def auto_generate_hotspots(
    project_id: int,
    db: Session = Depends(get_db),
    min_confidence: float = 0.30,
    max_per_waypoint: int = 4,
    force_refresh: bool = False,
):
    """
    Runs YOLOv8 object detection (backend/services/detection_service.py) on
    this project's images — reusing cached results unless force_refresh is
    set — and converts each detection into a hotspot placed at the correct
    yaw/pitch on the panorama sphere for the waypoint it came from.

    Idempotent: re-running replaces the previous auto-generated batch
    (tagged "source": "yolo_auto" in hotspots.json) instead of duplicating
    it. Manually-created hotspots (no "source" tag) are left untouched.

    FIX ("no objects found" complaint): min_confidence's default used to be
    0.45, but run_detection() below only ever PERSISTS a DetectedObject row
    when YOLO reports confidence >= 0.30 (that 0.30 is also what it's
    called with here). Every detection that landed in the 0.30-0.45 band -
    plausible and common for yolov8n (the fast "nano" model, not a strong
    one) on real-estate interior photos, which are a very different
    distribution than the COCO photos it was trained on - was being
    silently thrown away at display time with zero signal to the user
    about why. min_confidence now matches the persist threshold so nothing
    that was actually detected gets dropped before the user ever sees it.
    A stricter threshold can still be passed explicitly via the query
    param by whoever's calling this endpoint.
    """
    project = db.query(Project).get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Ensure detections exist (or refresh them).
    existing_objs = db.query(DetectedObject).filter(DetectedObject.project_id == project_id).all()
    if not existing_objs or force_refresh:
        if force_refresh and existing_objs:
            db.query(DetectedObject).filter(DetectedObject.project_id == project_id).delete()
            db.commit()
        try:
            from backend.services.detection_service import run_detection
            run_detection(project_id=project_id, db=db, confidence=0.15)
        except Exception as e:
            print(f"[auto_generate_hotspots] Detection failed for project {project_id}: {e}")
            raise HTTPException(status_code=500, detail=f"Object detection failed: {e}")

    # Reuse the same waypoint filename -> index mapping the walkthrough itself
    # uses, so a detection on frame_00012.jpg lands on the exact waypoint the
    # user sees that image at.
    waypoints_resp = await get_waypoints(project_id=project_id, force_refresh=False, db=db)
    waypoints = waypoints_resp.get("waypoints", [])
    if not waypoints:
        raise HTTPException(status_code=400, detail="No waypoints available for this project yet.")

    # Diagnostics so a caller (and the frontend) can tell "YOLO genuinely
    # found nothing at all" apart from "it found some, but they got
    # filtered out / didn't line up with a current waypoint filename" -
    # both used to look identical (an empty hotspots list) from the outside.
    raw_detections_total = db.query(DetectedObject).filter(DetectedObject.project_id == project_id).count()

    from backend.services.detection_service import generate_hotspots_from_detections
    auto_hotspots = generate_hotspots_from_detections(
        project_id, db, waypoints,
        min_confidence=min_confidence,
        max_per_waypoint=max_per_waypoint,
    )

    # Replace the previous auto-generated batch; leave manual hotspots alone.
    file_hotspots = _load_file_hotspots(project_id)
    manual_hotspots = [h for h in file_hotspots if h.get("source") != "yolo_auto"]
    next_id = max([int(h.get("id", 0)) for h in file_hotspots], default=0) + 1

    saved = list(manual_hotspots)
    for item in auto_hotspots:
        saved.append({
            "id": next_id,
            "waypoint_id": item["waypoint_index"],
            "waypoint_index": item["waypoint_index"],
            "yaw": item["yaw"],
            "pitch": item["pitch"],
            "title": item["title"],
            "description": item["description"],
            "icon_type": item["icon_type"],
            "source": "yolo_auto",
            "confidence": item["confidence"],
        })
        next_id += 1

    _save_file_hotspots(project_id, saved)

    if raw_detections_total == 0:
        diagnostic_message = "YOLO found no objects at all in this project's images."
    elif len(auto_hotspots) == 0:
        diagnostic_message = (
            f"YOLO detected {raw_detections_total} raw object(s), but none matched a "
            f"current waypoint image or cleared min_confidence={min_confidence}."
        )
    else:
        diagnostic_message = f"Placed {len(auto_hotspots)} hotspot(s) from {raw_detections_total} raw detection(s)."

    return {
        "project_id": project_id,
        "generated": len(auto_hotspots),
        "total_hotspots": len(saved),
        "raw_detections_total": raw_detections_total,
        "message": diagnostic_message,
        "hotspots": saved,
    }


@router.delete("/hotspots/{hotspot_id}")
@router.delete("/projects/{project_id}/hotspots/{hotspot_id}")
async def delete_hotspot(hotspot_id: int, project_id: Optional[int] = None):
    """
    Delete a hotspot by ID from hotspots.json.
    Requires ZERO database tables or schemas.
    """
    project_dirs = []
    if project_id:
        project_dirs = [os.path.join(settings.DATA_DIR, f"project_{project_id}")]
    else:
        if os.path.exists(settings.DATA_DIR):
            project_dirs = [
                os.path.join(settings.DATA_DIR, d)
                for d in os.listdir(settings.DATA_DIR)
                if os.path.isdir(os.path.join(settings.DATA_DIR, d)) and d.startswith("project_")
            ]

    for pdir in project_dirs:
        hfile = os.path.join(pdir, "hotspots.json")
        if os.path.exists(hfile):
            try:
                with open(hfile, "r", encoding="utf-8") as f:
                    items = json.load(f)
                if isinstance(items, list):
                    filtered = [h for h in items if h.get("id") != hotspot_id]
                    if len(filtered) < len(items):
                        with open(hfile, "w", encoding="utf-8") as f:
                            json.dump(filtered, f, indent=2)
            except Exception as e:
                print(f"[Hotspots] Error deleting hotspot {hotspot_id} from {hfile}: {e}")

    return {"message": f"Hotspot {hotspot_id} deleted successfully"}


# ── Rendered Frame Capture (fills in Photo Tour for reality_capture_bypass) ──
# A directly-imported 3D model (e.g. a World Labs Marble .ply) goes through
# reality_capture_bypass, which writes a full poses.json/cameras.json orbit
# (see pipeline_orchestrator._estimate_reality_poses_lightweight) so the rest
# of the app has pose data to work with - but since no real photos were ever
# taken for that project, images/ is left empty and the "Ultra HD Photo Tour"
# (PanoWalkthrough) has nothing to actually show. This endpoint lets the 3D
# viewer itself render a still at each of those exact camera poses and save
# it under the matching filename, so the existing photo-tour pipeline (which
# already reads poses.json + images/*.jpg) has real frames to display -
# without needing any changes to PanoWalkthrough or the waypoints/hotspots
# logic, since both already key off the filenames in poses.json.
import base64 as _base64


class RenderedFramePayload(BaseModel):
    filename: str = Field(..., description="Target filename, e.g. frame_0001.jpg")
    image_base64: str = Field(..., description="Base64 JPEG/PNG data, optionally as a data: URL")


@router.post("/projects/{project_id}/frames")
async def save_rendered_frame(project_id: int, payload: RenderedFramePayload, db: Session = Depends(get_db)):
    """Save one client-rendered frame (captured from the live splat viewer) into
    this project's images/ directory, keyed to a filename already present in
    poses.json/cameras.json."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # No path traversal - basename only, and restrict to plain image extensions.
    filename = os.path.basename(payload.filename)
    if not filename.lower().endswith((".jpg", ".jpeg", ".png")):
        raise HTTPException(status_code=400, detail="Filename must end in .jpg, .jpeg, or .png")

    proj_dir = os.path.join(settings.DATA_DIR, f"project_{project_id}")
    if not os.path.isdir(proj_dir):
        raise HTTPException(status_code=404, detail=f"No data directory for project {project_id}")

    images_dir = os.path.join(proj_dir, "images")
    os.makedirs(images_dir, exist_ok=True)

    raw_b64 = payload.image_base64.split(",", 1)[-1] if "," in payload.image_base64[:60] else payload.image_base64
    try:
        raw_bytes = _base64.b64decode(raw_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image data")

    dest_path = os.path.join(images_dir, filename)
    with open(dest_path, "wb") as f:
        f.write(raw_bytes)

    return {"status": "saved", "filename": filename, "project_id": project_id, "bytes": len(raw_bytes)}


@router.post("/projects/{project_id}/frames/prepare")
async def prepare_frame_capture(project_id: int, db: Session = Depends(get_db)):
    """Make sure this project actually has real camera poses in poses.json/
    cameras.json before a frame-capture pass tries to fly the camera to
    them - and regenerate them if not.

    Normally reality_capture_bypass writes a real 12-pose orbit via
    PipelineOrchestrator._handle_reality_capture_poses() during the initial
    upload (see pipeline_orchestrator.py / upload._handle_3d_upload). But a
    project can end up with an empty poses.json instead - for example the
    "match this upload against an existing trained project" heuristic in
    upload.py copies poses.json/cameras.json from whatever project happens
    to have a similarly-sized scene file, and if that donor project itself
    had zero registered COLMAP poses, its empty/"colmap"-sourced stub gets
    copied in ahead of the bypass branch's own pose generation. Rather than
    track down every way that can happen, this just checks poses.json and
    regenerates it on the spot if it's empty, so "Generate Photo Tour"
    always has real poses to work with."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    proj_dir = os.path.join(settings.DATA_DIR, f"project_{project_id}")
    poses_path = os.path.join(proj_dir, "poses.json")

    has_poses = False
    if os.path.exists(poses_path):
        try:
            with open(poses_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            has_poses = bool(data.get("poses"))
        except Exception:
            has_poses = False

    if has_poses:
        return {"project_id": project_id, "regenerated": False, "message": "Camera poses already present."}

    try:
        from backend.services.pipeline_orchestrator import PipelineOrchestrator
        orchestrator = PipelineOrchestrator(project_id)
        orchestrator.reconstruction_mode = "reality_capture_bypass"
        orchestrator._handle_reality_capture_poses()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to regenerate camera poses: {exc}")

    with open(poses_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    pose_count = len(data.get("poses") or {})
    if pose_count == 0:
        raise HTTPException(status_code=500, detail="Pose regeneration ran but still produced no poses.")

    return {"project_id": project_id, "regenerated": True, "pose_count": pose_count}


@router.get("/projects/{project_id}/frames/status")
async def rendered_frames_status(project_id: int, db: Session = Depends(get_db)):
    """Report how many of the poses in poses.json already have a matching
    rendered/real image on disk, so the frontend can show capture progress
    and know whether a "Generate Photo Tour" pass is actually needed."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    proj_dir = os.path.join(settings.DATA_DIR, f"project_{project_id}")
    poses_path = os.path.join(proj_dir, "poses.json")
    images_dir = os.path.join(proj_dir, "images")

    expected: list[str] = []
    if os.path.exists(poses_path):
        try:
            with open(poses_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            expected = sorted((data.get("poses") or {}).keys())
        except Exception:
            expected = []

    have = set()
    if os.path.isdir(images_dir):
        have = {f for f in os.listdir(images_dir) if os.path.isfile(os.path.join(images_dir, f))}

    missing = [f for f in expected if f not in have]
    return {
        "project_id": project_id,
        "expected_total": len(expected),
        "captured": len(expected) - len(missing),
        "missing": missing,
        "complete": len(missing) == 0 and len(expected) > 0,
    }


# ── 3D Asset Version History (Row 89: "3D asset management — stored,
# versioned, retrievable") ──────────────────────────────────────────────────
# Every 3D file uploaded for a project (the first upload and every later
# re-upload targeting the same project via upload.py's _handle_3d_upload) is
# archived under project_{id}/versions/ with an AssetVersion row - see
# upload.py's _record_asset_version for how versions get created. These two
# endpoints are what make that history actually usable: list it, and roll
# the project's live scene files back to an earlier one.
@router.get("/projects/{project_id}/versions")
async def list_asset_versions(project_id: int, db: Session = Depends(get_db)):
    """List every stored version of this project's 3D asset, newest first."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    versions = (
        db.query(AssetVersion)
        .filter(AssetVersion.project_id == project_id)
        .order_by(AssetVersion.version_number.desc())
        .all()
    )
    return {
        "project_id": project_id,
        "versions": [
            {
                "id": v.id,
                "version_number": v.version_number,
                "format": v.format,
                "original_filename": v.original_filename,
                "size_bytes": v.size_bytes,
                "is_current": v.is_current,
                "created_at": v.created_at.isoformat() if v.created_at else None,
                # Which frontend component renders this format: SplatViewer
                # (Gaussian Splat, via scene.splat) for splat/ply/lcc, or
                # MeshAssetLoader/MeshCheckViewer (plain Three.js mesh, via
                # scene_mesh.glb|obj) for glb/obj. The frontend pages use
                # this - not file-extension guessing - to decide which
                # viewer to mount after a restore/upload.
                "viewer": "gsplat" if v.format in ("splat", "ply", "lcc") else "mesh",
            }
            for v in versions
        ],
    }


@router.post("/projects/{project_id}/versions/{version_id}/restore")
async def restore_asset_version(project_id: int, version_id: int, db: Session = Depends(get_db)):
    """
    Roll this project's live scene files (scene.splat / scene_clean.ply /
    etc - whatever the viewer and pipeline actually read from) back to an
    earlier archived version.

    Only the source file is restored from the archive; LOD tiers and
    poses/cameras are always regenerated fresh for the newly-active version
    by re-running the reality_capture_bypass pipeline step below, rather
    than being stored per-version themselves (they're cheap to regenerate
    and would otherwise double per-version storage for no benefit - see
    AssetVersion's docstring in models/schema.py).
    """
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    version = (
        db.query(AssetVersion)
        .filter(AssetVersion.id == version_id, AssetVersion.project_id == project_id)
        .first()
    )
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found for project {project_id}")

    proj_dir = os.path.join(settings.DATA_DIR, f"project_{project_id}")
    src_path = os.path.join(proj_dir, "versions", version.stored_filename)
    if not os.path.exists(src_path):
        raise HTTPException(status_code=404, detail="This version's archived file is missing on disk.")

    with open(src_path, "rb") as f:
        content = f.read()

    from backend.routes.upload import _write_canonical_scene_files
    ext = f".{version.format}"
    dest_paths = _write_canonical_scene_files(proj_dir, ext, content, project_id)

    # splat/ply/lcc render through SplatViewer (Gaussian Splat, scene.splat);
    # glb/obj render through MeshAssetLoader/MeshCheckViewer (plain mesh,
    # scene_mesh.glb|obj) - see list_asset_versions above for the same
    # classification. Both are real, working viewers now; this only decides
    # whether the gsplat pipeline (poses/LOD regen) is meaningful to run -
    # it isn't, for a mesh format.
    is_gsplat_format = ext in (".splat", ".ply", ".lcc")

    if is_gsplat_format:
        try:
            from backend.services.pipeline_orchestrator import PipelineOrchestrator
            orchestrator = PipelineOrchestrator(project_id)
            orchestrator.reconstruction_mode = "reality_capture_bypass"
            orchestrator.run()
        except Exception as exc:
            print(f"[versions] Warning: pipeline re-run after restoring version {version_id} failed: {exc}")

    # Flip is_current onto the restored version.
    db.query(AssetVersion).filter(AssetVersion.project_id == project_id).update({"is_current": False})
    version.is_current = True

    # Keep the Scene row's paths/point_count in sync with the restored file,
    # same as a fresh upload does - but only for gsplat formats. A mesh
    # restore doesn't touch scene.splat/scene_clean.ply at all (see above),
    # so recomputing point_count from the mesh file's byte length here would
    # just write a meaningless number over whatever gsplat metadata was
    # already there.
    if is_gsplat_format:
        splat_url = f"/data/project_{project_id}/scene.splat" if os.path.exists(dest_paths["dest_splat"]) else None
        ply_url = f"/data/project_{project_id}/scene_clean.ply" if os.path.exists(dest_paths["dest_ply_clean"]) else None
        existing_scene = db.query(Scene).filter(Scene.project_id == project_id).first()
        if existing_scene:
            existing_scene.splat_path = splat_url
            existing_scene.ply_path = ply_url
            existing_scene.point_count = len(content) // 32
        else:
            db.add(Scene(project_id=project_id, splat_path=splat_url, ply_path=ply_url, point_count=len(content) // 32))

    db.commit()

    return {
        "status": "restored",
        "project_id": project_id,
        "version_id": version.id,
        "version_number": version.version_number,
        "viewer": "gsplat" if is_gsplat_format else "mesh",
    }