"""
ArticulAIT — Scene Cache Service
Implements SOW §7.2 cache taxonomy rows 87-89 (per-scene 3D caching / scene
reuse), which the research package flagged as designed on paper but "not
evidenced": re-opening an already-processed scene should be a cache hit,
not a silent full regeneration.

A scene is considered CACHED (reusable) when all of the following hold:
  1. A scene_cache_manifest.json exists in the project's data directory
     (data/project_<id>/), written by write_scene_cache_manifest() at the
     end of a successful PipelineOrchestrator run.
  2. Its stored fingerprint of the processed image set matches the CURRENT
     fingerprint of that same directory - so adding, removing, or
     re-uploading a photo correctly invalidates the cache.
  3. Every artifact the manifest claims to have produced (scene.splat,
     scene_clean.ply, poses.json, ...) still exists on disk.

The fingerprint is (filename, size, mtime_ns) per image, not a hash of
pixel content - hashing actual bytes for a 3500-photo project would be far
slower than just re-running the pipeline, which defeats the point of a
cache. This is enough to detect any real change to the input set while
staying cheap for large projects.

Callers (routes/walkthrough.py, PipelineOrchestrator):
  - write_scene_cache_manifest(project_id)  — call once, right after a
    pipeline run completes successfully.
  - check_scene_cache(project_id)           — call before starting a new
    run; on cache_hit=True, skip regeneration and reuse existing assets.
"""

import os
import json
import hashlib
import logging
import datetime
from typing import Any, Dict, List, Optional

from backend.core import settings

logger = logging.getLogger("articulait.scene_cache_service")

CACHE_MANIFEST_FILENAME = "scene_cache_manifest.json"

# Mirrors what PipelineOrchestrator actually writes into base_dir on a
# successful 3DGS run (see pipeline_orchestrator.py's completed branch,
# which copies scene.splat / scene.ply / scene_clean.ply into base_dir and
# pose_router.save_pose_metadata(), which writes poses.json there too).
DEFAULT_REQUIRED_ARTIFACTS = ["scene.splat", "scene_clean.ply", "poses.json"]


def _project_dir(project_id: int) -> str:
    return os.path.join(settings.DATA_DIR, f"project_{project_id}")


def _processed_images_dir(project_id: int) -> str:
    return os.path.join(_project_dir(project_id), "images")


def compute_scene_fingerprint(processed_images_dir: str) -> Optional[str]:
    """
    Deterministic fingerprint of a project's processed image set. Returns
    None if the directory doesn't exist or has no images - i.e. nothing to
    fingerprint, which callers should treat as "cannot be cached".
    """
    if not os.path.isdir(processed_images_dir):
        return None

    valid_exts = (".jpg", ".jpeg", ".png", ".webp")
    entries = []
    for fname in os.listdir(processed_images_dir):
        if not fname.lower().endswith(valid_exts):
            continue
        fpath = os.path.join(processed_images_dir, fname)
        try:
            st = os.stat(fpath)
            entries.append((fname, st.st_size, int(st.st_mtime_ns)))
        except OSError:
            continue

    if not entries:
        return None

    entries.sort(key=lambda e: e[0])
    hasher = hashlib.sha256()
    for fname, size, mtime_ns in entries:
        hasher.update(f"{fname}:{size}:{mtime_ns}|".encode("utf-8"))
    return hasher.hexdigest()


def write_scene_cache_manifest(
    project_id: int,
    required_artifacts: Optional[List[str]] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """
    Snapshot the current fingerprint of the project's processed images plus
    which artifacts exist, so a later request against the SAME inputs can
    be served from cache instead of re-running COLMAP + Gaussian Splat
    training. Call this once, right after a pipeline run completes
    successfully. Never raises - a write failure just means the next
    request won't get a cache hit, not a broken pipeline run.
    """
    required_artifacts = required_artifacts or DEFAULT_REQUIRED_ARTIFACTS
    proj_dir = _project_dir(project_id)
    images_dir = _processed_images_dir(project_id)

    fingerprint = compute_scene_fingerprint(images_dir)
    if fingerprint is None:
        logger.warning(
            f"[SceneCache] project_id={project_id}: no processed images found in {images_dir}, skipping cache manifest write."
        )
        return None

    present_artifacts = [a for a in required_artifacts if os.path.exists(os.path.join(proj_dir, a))]

    manifest: Dict[str, Any] = {
        "project_id": project_id,
        "fingerprint": fingerprint,
        "required_artifacts": required_artifacts,
        "present_artifacts": present_artifacts,
        "cached_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    if extra:
        manifest["extra"] = extra

    manifest_path = os.path.join(proj_dir, CACHE_MANIFEST_FILENAME)
    try:
        os.makedirs(proj_dir, exist_ok=True)
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)
        logger.info(
            f"[SceneCache] project_id={project_id}: wrote cache manifest "
            f"({len(present_artifacts)}/{len(required_artifacts)} artifacts present) -> {manifest_path}"
        )
    except OSError as e:
        logger.warning(f"[SceneCache] project_id={project_id}: failed writing cache manifest: {e}")
        return None

    return manifest


def check_scene_cache(
    project_id: int,
    required_artifacts: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Determines whether a previously-processed scene can be REUSED as-is
    (cache hit) or must be regenerated (cache miss), and records why.
    Never raises - any error is reported as a miss with a reason, so
    callers can safely fall back to a full regeneration rather than crash.
    """
    required_artifacts = required_artifacts or DEFAULT_REQUIRED_ARTIFACTS
    proj_dir = _project_dir(project_id)
    images_dir = _processed_images_dir(project_id)
    manifest_path = os.path.join(proj_dir, CACHE_MANIFEST_FILENAME)

    result: Dict[str, Any] = {
        "project_id": project_id,
        "cache_hit": False,
        "reason": None,
        "fingerprint": None,
        "cached_at": None,
    }

    if not os.path.exists(manifest_path):
        result["reason"] = "no_cache_manifest"
        return result

    try:
        with open(manifest_path, "r") as f:
            manifest = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        result["reason"] = f"unreadable_cache_manifest: {e}"
        return result

    current_fingerprint = compute_scene_fingerprint(images_dir)
    result["fingerprint"] = current_fingerprint
    result["cached_at"] = manifest.get("cached_at")

    if current_fingerprint is None:
        result["reason"] = "no_current_images"
        return result

    if current_fingerprint != manifest.get("fingerprint"):
        result["reason"] = "images_changed_since_cache"
        return result

    missing = [a for a in required_artifacts if not os.path.exists(os.path.join(proj_dir, a))]
    if missing:
        result["reason"] = f"missing_artifacts: {', '.join(missing)}"
        return result

    result["cache_hit"] = True
    result["reason"] = "fingerprint_match_artifacts_present"
    result["artifacts"] = required_artifacts
    logger.info(f"[SceneCache] project_id={project_id}: CACHE HIT - reusing existing scene assets, skipping regeneration.")
    return result
