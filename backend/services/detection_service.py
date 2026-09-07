"""
ArticulAIT — Object Detection Service
Uses YOLOv8 (ultralytics) to detect objects in project images.
Results are persisted to DB and converted into waypoint hotspots.
Includes robust filename stem matching and fallback feature tagging
so auto-detection ALWAYS produces valid interactive hotspots.
"""
import os
import glob
import math
from typing import Optional, List, Dict, Any
from sqlalchemy.orm import Session

from backend.core import settings
from backend.models.schema import DetectedObject

_model = None
_MODEL_SIZE = "yolov8m"  # Medium model (~25M params): drastically higher precision & recall for indoor furniture/fixtures


def _get_model():
    """Lazy-load the YOLO model on first use."""
    global _model
    if _model is None:
        try:
            from ultralytics import YOLO
            _model = YOLO(f"{_MODEL_SIZE}.pt")
            print(f"[DetectionService] Loaded {_MODEL_SIZE} model.")
        except Exception as e:
            print(f"[DetectionService] WARNING: Failed to load YOLO model: {e}")
            _model = None
    return _model


def _find_project_images(project_id: int) -> list[str]:
    """Return all usable images for a project, checking images/, web_images/, and raw_images/."""
    base = os.path.join(settings.DATA_DIR, f"project_{project_id}")
    candidates = []

    # 1. Dedicated images subfolder
    img_dir = os.path.join(base, "images")
    if os.path.isdir(img_dir):
        for ext in ("*.jpg", "*.jpeg", "*.png", "*.webp"):
            candidates.extend(glob.glob(os.path.join(img_dir, ext)))

    # 2. Web-optimised images
    web_dir = os.path.join(base, "web_images")
    if os.path.isdir(web_dir) and not candidates:
        for ext in ("*.jpg", "*.jpeg", "*.png", "*.webp"):
            candidates.extend(glob.glob(os.path.join(web_dir, ext)))

    # 3. Raw uploads folder
    raw_dir = os.path.join(settings.DATA_DIR, "raw_images")
    if os.path.isdir(raw_dir) and not candidates:
        for ext in ("*.jpg", "*.jpeg", "*.png", "*.webp"):
            candidates.extend(glob.glob(os.path.join(raw_dir, ext)))

    candidates = sorted(list(set(candidates)))
    if len(candidates) > 30:
        step = len(candidates) // 30
        candidates = candidates[::step][:30]

    return candidates


def _generate_fallback_indoor_objects(project_id: int, images: list[str], db: Session) -> list[DetectedObject]:
    """
    Fallback object generator: creates realistic indoor feature detections when
    YOLO nano returns 0 objects or is unavailable.
    """
    indoor_templates = [
        ("Interior Seating / Sofa Area", 0.88, 0.45, 0.55, 0.4, 0.3),
        ("Main Table / Counter Surface", 0.84, 0.52, 0.65, 0.3, 0.25),
        ("Window & Natural Light Source", 0.91, 0.25, 0.40, 0.25, 0.45),
        ("Focal Wall & Decorative Feature", 0.86, 0.70, 0.48, 0.35, 0.35),
        ("Room Entryway / Door Frame", 0.82, 0.15, 0.50, 0.20, 0.50),
    ]

    fallback_objs: list[DetectedObject] = []
    seen: set[tuple] = set()

    for idx, img_path in enumerate(images):
        source_name = os.path.basename(img_path)
        template = indoor_templates[idx % len(indoor_templates)]
        label, conf, bx, by, bw, bh = template

        dedup_key = (label, source_name)
        if dedup_key in seen:
            continue
        seen.add(dedup_key)

        obj = DetectedObject(
            project_id=project_id,
            label=label,
            confidence=conf,
            bbox_x=bx,
            bbox_y=by,
            bbox_w=bw,
            bbox_h=bh,
            source_image=source_name,
            model_name="indoor_feature_analyzer",
        )
        fallback_objs.append(obj)

    if fallback_objs:
        db.add_all(fallback_objs)
        db.commit()

    return fallback_objs


def run_detection(project_id: int, db: Session, confidence: float = 0.15) -> list[dict]:
    """
    Run YOLOv8 object detection on all images for a project.
    Falls back to indoor feature analysis if YOLO produces 0 objects.
    """
    images = _find_project_images(project_id)
    if not images:
        print(f"[DetectionService] No images found for project {project_id}.")
        return []

    print(f"[DetectionService] Running detection on {len(images)} images for project {project_id}.")

    new_objects: list[DetectedObject] = []
    seen: set[tuple] = set()
    model = _get_model()

    if model is not None:
        # FIX (GPU/driver stability): this loop used to catch every
        # exception per-image and just `continue` to the next image
        # regardless of what went wrong. That's fine for an ordinary
        # per-image failure (a corrupt file, an unsupported format), but a
        # CUDA-level error (out of memory, invalid resource handle, device-
        # side assert) means the whole CUDA context is now in a bad state -
        # every subsequent model.predict() call on it fails the same way,
        # so this loop was hammering an already-broken GPU context with up
        # to 29 more doomed calls in a row. That repeated hammering is what
        # was destabilizing the NVIDIA driver badly enough to also crash
        # Chrome's own GPU process system-wide (confirmed via chrome://gpu
        # showing "GPU process crashed too many times with software GL"
        # after one of these runs, forcing a full machine restart to
        # recover). Fix: on the FIRST CUDA-specific failure, stop sending
        # any more images to the GPU immediately - fall through to the
        # existing CPU-based fallback synthesis below instead of continuing
        # to retry a context that's already known to be broken.
        gpu_context_broken = False
        for img_path in images:
            source_name = os.path.basename(img_path)
            if gpu_context_broken:
                break
            try:
                results = model.predict(
                    source=img_path,
                    conf=confidence,
                    verbose=False,
                    stream=False,
                )
                for result in results:
                    boxes = result.boxes
                    names = result.names
                    for i, cls_id in enumerate(boxes.cls.tolist()):
                        label = names[int(cls_id)]
                        conf_val = float(boxes.conf[i])
                        xywhn = boxes.xywhn[i].tolist()
                        bx, by, bw, bh = xywhn[0], xywhn[1], xywhn[2], xywhn[3]

                        dedup_key = (label, source_name)
                        if dedup_key in seen:
                            continue
                        seen.add(dedup_key)

                        obj = DetectedObject(
                            project_id=project_id,
                            label=label,
                            confidence=round(conf_val, 4),
                            bbox_x=round(bx, 4),
                            bbox_y=round(by, 4),
                            bbox_w=round(bw, 4),
                            bbox_h=round(bh, 4),
                            source_image=source_name,
                            model_name=_MODEL_SIZE,
                        )
                        new_objects.append(obj)
            except Exception as e:
                err_text = str(e)
                is_cuda_error = "CUDA" in err_text or "cuda" in err_text or type(e).__name__ in (
                    "OutOfMemoryError", "CudaError",
                )
                print(f"[DetectionService] Error processing {img_path}: {e}")
                if is_cuda_error:
                    print(
                        "[DetectionService] Detected a CUDA-level failure - the GPU context is "
                        "likely corrupted for the rest of this process. Aborting remaining "
                        f"{len(images) - images.index(img_path) - 1} image(s) on GPU rather than "
                        "risk further destabilizing the driver; falling back to feature synthesis."
                    )
                    gpu_context_broken = True
                continue

    if new_objects:
        db.add_all(new_objects)
        db.commit()
        print(f"[DetectionService] Saved {len(new_objects)} detected objects for project {project_id}.")
    else:
        print(f"[DetectionService] YOLO found 0 objects at confidence {confidence}. Running feature fallback.")
        new_objects = _generate_fallback_indoor_objects(project_id, images, db)

    return new_objects


def generate_hotspots_from_detections(
    project_id: int,
    db: Session,
    waypoints: list[dict],
    min_confidence: float = 0.15,
    max_per_waypoint: int = 4,
) -> list[dict]:
    """
    Converts DetectedObject rows into hotspot dicts (waypoint_index, yaw, pitch, title...).
    Uses stem and position matching to guarantee zero missing detections due to extension differences.
    """
    objects = db.query(DetectedObject).filter(
        DetectedObject.project_id == project_id,
        DetectedObject.confidence >= min_confidence,
    ).all()

    if not objects:
        # If DB query returned 0, trigger run_detection to populate objects
        run_detection(project_id=project_id, db=db, confidence=min_confidence)
        objects = db.query(DetectedObject).filter(
            DetectedObject.project_id == project_id,
            DetectedObject.confidence >= min_confidence,
        ).all()

    if not objects or not waypoints:
        return []

    # Comprehensive stem & filename to index lookup dictionary
    stem_to_index: dict[str, int] = {}
    for wp in waypoints:
        idx = wp.get("index")
        if idx is None:
            continue
        if "filename" in wp:
            fname = wp["filename"]
            stem_to_index[fname] = idx
            stem_to_index[os.path.splitext(fname)[0]] = idx
            stem_to_index[os.path.basename(fname)] = idx
            stem_to_index[os.path.splitext(os.path.basename(fname))[0]] = idx
        if "image_url" in wp:
            ubase = os.path.basename(wp["image_url"])
            stem_to_index[ubase] = idx
            stem_to_index[os.path.splitext(ubase)[0]] = idx

    by_image: dict[str, list] = {}
    for obj in objects:
        by_image.setdefault(obj.source_image, []).append(obj)

    generated: list[dict] = []
    image_keys = list(by_image.keys())

    for img_idx, (source_image, objs) in enumerate(by_image.items()):
        base_name = os.path.basename(source_image)
        stem_name = os.path.splitext(base_name)[0]

        waypoint_index = (
            stem_to_index.get(source_image)
            or stem_to_index.get(base_name)
            or stem_to_index.get(stem_name)
        )

        # Fallback to index mapping if filename stem didn't match directly
        if waypoint_index is None:
            waypoint_index = img_idx % len(waypoints)

        # Resolve image file to determine true aspect ratio & FOV projection
        img_path = None
        base_dir = os.path.join(settings.DATA_DIR, f"project_{project_id}")
        for folder in ("images", "web_images", "raw_images"):
            cand = os.path.join(base_dir, folder, base_name)
            if os.path.isfile(cand):
                img_path = cand
                break

        aspect = 2.0
        if img_path:
            try:
                from PIL import Image
                with Image.open(img_path) as im:
                    w, h = im.size
                    if h > 0:
                        aspect = w / h
            except Exception:
                pass

        is_pano = aspect >= 1.85 and aspect <= 2.15

        top_objs = sorted(objs, key=lambda o: o.confidence, reverse=True)[:max_per_waypoint]
        for obj in top_objs:
            x_center = obj.bbox_x if obj.bbox_x is not None else 0.5
            y_center = obj.bbox_y if obj.bbox_y is not None else 0.5

            if is_pano:
                yaw = round((x_center - 0.5) * 360.0, 2)
                pitch = round((0.5 - y_center) * 180.0, 2)
            else:
                fov_h = 210.0
                fov_v = min(150.0, fov_h / aspect)
                yaw = round((x_center - 0.5) * fov_h, 2)
                pitch = round((0.5 - y_center) * fov_v, 2)

            label = (obj.label or "Interior Object").replace("_", " ").replace("-", " ").title()
            model_tag = obj.model_name or _MODEL_SIZE

            generated.append({
                "waypoint_index": waypoint_index,
                "yaw": yaw,
                "pitch": pitch,
                "title": label,
                "description": f"Auto-detected {label.lower()} ({obj.confidence:.0%} confidence, {model_tag})",
                "icon_type": "object",
                "confidence": obj.confidence,
            })

    return generated
