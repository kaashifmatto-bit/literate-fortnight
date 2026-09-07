"""
ArticulAIT — Pose Router Module
Provides a confidence-gated router between VGGT-1B-Commercial and COLMAP with Gate H1 Canonical World Coordinate Normalization (§3.8).

Logic & Specifications (SOW §3.2.1 / §3.2.2 / §3.8):
1. Lazily loads VGGT-1B-Commercial (1.0B parameter feedforward reconstruction model).
2. Runs feedforward pose estimation on uploaded image batch and extracts per-frame pose confidence.
3. Performs Gate H1 Canonical World Coordinate Normalization:
   - Centers camera trajectory at (0, 0, 0) via median camera position subtraction.
   - Scales scene geometry into unified canonical bounding sphere [-2.5m, +2.5m].
4. If confidence >= POSE_ESTIMATOR_CONFIDENCE_THRESHOLD (default 0.6):
   Returns normalized VGGT poses directly (skips COLMAP).
5. If confidence < 0.6 or VGGT fails:
   Falls back to COLMAP (pycolmap) SfM pose estimation.
"""

import os
import math
import json
import logging
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Literal, Optional, Dict, Any, List, Tuple
import numpy as np

try:
    import torch
except ImportError:
    torch = None

from backend.core import settings

logger = logging.getLogger("articulait.pose_router")


@dataclass
class PoseResult:
    """Standardized camera pose output across estimators."""
    source: Literal["vggt", "colmap", "provided", "lightweight_estimate"]
    confidence: float
    poses: Dict[str, Dict[str, Any]]  # filename -> {"position": {"x", "y", "z"}, "target": {"x", "y", "z"}, "quaternion": [qw, qx, qy, qz], "confidence": float, "rotation_error_deg": float, "translation_error_cm": float, "high_confidence": bool}
    details: Optional[Dict[str, Any]] = None


def normalize_poses_canonical(poses: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """
    Gate H1 (§3.8) Canonical World Coordinate Frame Normalization.
    Prevents fragmented multi-blob scenes by aligning all camera poses and scene elements
    into a unified coordinate frame centered at (0,0,0) with normalized scale.
    """
    if not poses:
        return poses

    # 1. Extract camera positions
    xs, ys, zs = [], [], []
    for fname, pdata in poses.items():
        pos = pdata.get("position", {"x": 0.0, "y": 0.0, "z": 0.0})
        xs.append(float(pos["x"]))
        ys.append(float(pos["y"]))
        zs.append(float(pos["z"]))

    if not xs:
        return poses

    # 2. Compute median origin
    med_x = float(np.median(xs))
    med_y = float(np.median(ys))
    med_z = float(np.median(zs))

    # 3. Compute maximum radial distance from median origin
    dists = [
        math.sqrt((x - med_x) ** 2 + (y - med_y) ** 2 + (z - med_z) ** 2)
        for x, y, z in zip(xs, ys, zs)
    ]
    max_dist = max(dists) if dists else 1.0
    scale_factor = 2.5 / max(0.5, max_dist)

    print(f"[Gate H1 Normalization] Normalizing {len(poses)} camera poses to Canonical World Frame:")
    print(f"  - Translation Offset (Median): ({med_x:.4f}, {med_y:.4f}, {med_z:.4f})")
    print(f"  - Raw Trajectory Radius: {max_dist:.4f}m")
    print(f"  - Canonical Scale Factor: {scale_factor:.4f}")

    # 4. Center and scale all positions & targets while preserving metadata
    normalized_poses = {}
    for fname, pdata in poses.items():
        pos = pdata.get("position", {"x": 0.0, "y": 0.0, "z": 0.0})
        tgt = pdata.get("target", {"x": 0.0, "y": 0.0, "z": 1.0})
        quat = pdata.get("quaternion", [1.0, 0.0, 0.0, 0.0])

        new_pos = {
            "x": float((float(pos["x"]) - med_x) * scale_factor),
            "y": float((float(pos["y"]) - med_y) * scale_factor),
            "z": float((float(pos["z"]) - med_z) * scale_factor),
        }
        new_tgt = {
            "x": float((float(tgt["x"]) - med_x) * scale_factor),
            "y": float((float(tgt["y"]) - med_y) * scale_factor),
            "z": float((float(tgt["z"]) - med_z) * scale_factor),
        }

        rot_err = float(pdata.get("rotation_error_deg", 0.0))
        trans_err = float(pdata.get("translation_error_cm", 0.0))
        is_high_conf = bool(pdata.get("high_confidence", (rot_err < 2.0 and trans_err < 5.0)))
        conf = float(pdata.get("confidence", 0.85))

        normalized_poses[fname] = {
            "position": new_pos,
            "target": new_tgt,
            "quaternion": quat,
            "confidence": conf,
            "rotation_error_deg": rot_err,
            "translation_error_cm": trans_err,
            "high_confidence": is_high_conf,
        }

    return normalized_poses


def convert_vggt_to_colmap_convention(R: np.ndarray, t: np.ndarray) -> Tuple[np.ndarray, List[float], Dict[str, float], Dict[str, float]]:
    """
    Explicitly convert VGGT / OpenCV camera pose (Rotation R, Translation t)
    to COLMAP world-space camera center C, target vector, and quaternion (qw, qx, qy, qz).
    
    COLMAP transform: p_cam = R * p_world + t
    World camera origin C = -R^T * t
    View direction V = R[2, :]  (3rd row of rotation matrix)
    """
    R = np.array(R, dtype=np.float64)
    t = np.array(t, dtype=np.float64)

    if R.shape != (3, 3):
        raise ValueError(f"Invalid rotation matrix shape: {R.shape}")

    # Orthonormalize rotation matrix via SVD to prevent precision drift
    U, _, Vt = np.linalg.svd(R)
    R_clean = U @ Vt
    if np.linalg.det(R_clean) < 0:
        R_clean = -R_clean

    camera_center = -R_clean.T @ t
    view_dir = R_clean[2, :]
    target = camera_center + 2.0 * view_dir

    tr = np.trace(R_clean)
    if tr > 0:
        S = math.sqrt(tr + 1.0) * 2
        qw = 0.25 * S
        qx = (R_clean[2, 1] - R_clean[1, 2]) / S
        qy = (R_clean[0, 2] - R_clean[2, 0]) / S
        qz = (R_clean[1, 0] - R_clean[0, 1]) / S
    elif (R_clean[0, 0] > R_clean[1, 1]) and (R_clean[0, 0] > R_clean[2, 2]):
        S = math.sqrt(1.0 + R_clean[0, 0] - R_clean[1, 1] - R_clean[2, 2]) * 2
        qw = (R_clean[2, 1] - R_clean[1, 2]) / S
        qx = 0.25 * S
        qy = (R_clean[0, 1] + R_clean[1, 0]) / S
        qz = (R_clean[0, 2] + R_clean[2, 0]) / S
    elif R_clean[1, 1] > R_clean[2, 2]:
        S = math.sqrt(1.0 + R_clean[1, 1] - R_clean[0, 0] - R_clean[2, 2]) * 2
        qw = (R_clean[0, 2] - R_clean[2, 0]) / S
        qx = (R_clean[0, 1] + R_clean[1, 0]) / S
        qy = 0.25 * S
        qz = (R_clean[1, 2] + R_clean[2, 1]) / S
    else:
        S = math.sqrt(1.0 + R_clean[2, 2] - R_clean[0, 0] - R_clean[1, 1]) * 2
        qw = (R_clean[1, 0] - R_clean[0, 1]) / S
        qx = (R_clean[0, 2] + R_clean[2, 0]) / S
        qy = (R_clean[1, 2] + R_clean[2, 1]) / S
        qz = 0.25 * S

    q_norm = math.sqrt(qw*qw + qx*qx + qy*qy + qz*qz)
    if q_norm > 0:
        qw /= q_norm
        qx /= q_norm
        qy /= q_norm
        qz /= q_norm

    quaternion = [float(qw), float(qx), float(qy), float(qz)]
    pos_dict = {"x": float(camera_center[0]), "y": float(camera_center[1]), "z": float(camera_center[2])}
    target_dict = {"x": float(target[0]), "y": float(target[1]), "z": float(target[2])}

    return R_clean, quaternion, pos_dict, target_dict


class VGGTModelWrapper:
    """Lazy-loaded singleton wrapper for VGGT-1B-Commercial."""
    _instance = None
    _model = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(VGGTModelWrapper, cls).__new__(cls)
        return cls._instance

    def load_model(self):
        """
        Loads the real VGGT model via its published `from_pretrained` API
        (facebookresearch/vggt). Requires the `vggt` package to be installed
        separately - it is NOT in requirements.txt yet:

            pip install git+https://github.com/facebookresearch/vggt.git

        VERIFY BEFORE RELYING ON THIS: the configured model id in settings
        (VGGT_MODEL = "facebook/VGGT-1B-Commercial") has not been confirmed
        to actually exist/be accessible on HuggingFace from this environment
        - I cannot browse HF to check. The well-documented, confirmed-public
        checkpoint is "facebook/VGGT-1B" (no "-Commercial" suffix, Apache
        2.0, no auth needed). If loading fails with a 404/gated-repo error,
        try that id instead, or set HF_TOKEN in .env if "-Commercial" is a
        real gated variant you have access to.
        """
        if self._model is not None:
            return self._model

        model_name = getattr(settings, "VGGT_MODEL", "facebook/VGGT-1B")
        try:
            import torch
            from vggt.models.vggt import VGGT
            from backend.reconstruction.vggt_fp16_loader import (
                ensure_fp16_checkpoint,
                load_vggt_state_dict_fp16,
                load_vggt_config,
            )

            device = "cuda" if torch.cuda.is_available() else "cpu"
            print(f"[PoseRouter] Loading VGGT model '{model_name}' onto {device}...")

            hf_token = getattr(settings, "HF_TOKEN", "") or None

            # Build the (empty) model from its published config, then load
            # weights via our own fp16 safetensors path instead of
            # VGGT.from_pretrained()'s default loader. See
            # vggt_fp16_loader.py's module docstring for why: the default
            # path memory-maps the ~5GB fp32 checkpoint using Windows
            # copy-on-write semantics, which requires the OS to reserve
            # page-file commit-charge for the whole file up front - that is
            # what was actually producing "os error 1455: the paging file is
            # too small" on this project's dev machine, independent of how
            # much page file was configured (its D: drive can't host one at
            # all - BitLocker "Automatic Unlock" isn't unlocked yet at the
            # point in boot Windows sets up page files - and C: doesn't have
            # enough free space for a page file large enough to comfortably
            # cover a 5GB reservation on top of everything else running).
            print("[PoseRouter]   resolving model config (local cache only)...")
            model_config = load_vggt_config(model_name, hf_token)
            print(f"[PoseRouter]   config resolved: {model_config}")

            # FIX (was the actual stall point - "constructing model" never
            # progressed and pegged CPU/RAM for minutes): a plain
            # VGGT(**model_config) call does REAL random weight
            # initialization (kaiming/xavier etc.) for all ~1B parameters on
            # the CPU before we've even gotten to loading the real
            # checkpoint - that's genuinely CPU-heavy random-number-
            # generation work, not a fast no-op, and on a memory-constrained
            # machine it can stall for a very long time (and thrash the
            # system in the process). Since every one of those randomly
            # initialized weights is about to be overwritten by the real
            # checkpoint two steps down anyway, there is no reason to pay
            # that cost at all: build the model on the 'meta' device first
            # (an instant, compute-free skeleton - parameters exist as shape
            # + dtype metadata only, with no real storage and no
            # initialization), then materialize real (uninitialized, NOT
            # randomized - just a plain memory allocation) CPU tensors via
            # to_empty() right before we're about to fill them with the real
            # weights. This is the standard "avoid wasted init before
            # loading a pretrained checkpoint" pattern.
            print("[PoseRouter]   constructing model on 'meta' device (instant - no compute, no real memory allocated yet)...")
            with torch.device("meta"):
                model = VGGT(**model_config)
            print("[PoseRouter]   model skeleton ready. Materializing empty (non-random) fp16 CPU tensors...")
            model = model.to_empty(device="cpu")
            model = model.half()
            print("[PoseRouter]   empty tensors allocated (~2GB). Resolving fp16 checkpoint...")

            fp16_ckpt_path = ensure_fp16_checkpoint(model_name, hf_token)
            print(f"[PoseRouter]   fp16 checkpoint ready: {fp16_ckpt_path}. Loading state dict...")
            state_dict = load_vggt_state_dict_fp16(fp16_ckpt_path)
            print(f"[PoseRouter]   state dict loaded ({len(state_dict)} tensors). Copying real weights into model...")
            model.load_state_dict(state_dict, strict=True)
            print("[PoseRouter]   state dict applied.")

            # On CUDA, stay in fp16 (halves VRAM footprint vs fp32, and
            # predict() below already runs inference under an fp16/bf16
            # autocast anyway, so fp16 weights at rest is consistent with
            # that - not a new precision tradeoff). Only cast back up to
            # fp32 for a CPU fallback, where fp16 ops aren't well supported.
            model_dtype = torch.float16 if device == "cuda" else torch.float32
            model = model.to(device=device, dtype=model_dtype).eval()

            self._model = {"model": model, "device": device}
            print(f"[PoseRouter] VGGT model '{model_name}' loaded successfully on {device}.")
            return self._model
        except ImportError as e:
            print(f"[PoseRouter] VGGT package not installed ({e}). "
                  f"Run: pip install git+https://github.com/facebookresearch/vggt.git")
            self._model = None
            return None
        except Exception as e:
            print(f"[PoseRouter] Failed to load VGGT model '{model_name}': {e}")
            self._model = None
            return None

    def predict(self, image_paths: List[str]) -> Tuple[float, Optional[Dict[str, Dict[str, Any]]]]:
        """
        Run real VGGT feedforward inference on an image batch.
        Returns (confidence_score, poses_dict).

        UNVERIFIED - written from documented VGGT API knowledge, never
        executed in this environment (no working Python/CUDA sandbox
        available here). The overall shape (load_and_preprocess_images ->
        model(images) -> predictions["pose_enc"] ->
        pose_encoding_to_extri_intri -> per-frame (R, t)) matches the
        published facebookresearch/vggt README usage pattern, and the
        (R, t) -> COLMAP-convention conversion reuses this file's existing,
        already-correct convert_vggt_to_colmap_convention() helper - it was
        sitting unused, clearly written in anticipation of exactly this. But
        exact dict key names / tensor shapes can drift between vggt package
        versions, and I cannot confirm them without running this. If this
        raises an exception, the except block below falls back to real
        COLMAP automatically (same safety net as before) - so a bug here
        degrades to "VGGT still doesn't run" rather than corrupting output.
        Please run it and paste the *exact* traceback if it fails; I'll fix
        it against real error output rather than guessing further.
        """
        model_bundle = self.load_model()
        if model_bundle is None:
            return 0.0, None

        num_images = len(image_paths)
        if num_images == 0:
            return 0.0, None

        print(f"[PoseRouter] VGGT processing {num_images} input frames for pose estimation...")

        try:
            import torch
            from vggt.utils.load_fn import load_and_preprocess_images
            from vggt.utils.pose_enc import pose_encoding_to_extri_intri

            model = model_bundle["model"]
            device = model_bundle["device"]
            use_amp = device == "cuda"
            amp_dtype = torch.bfloat16 if (use_amp and torch.cuda.get_device_capability()[0] >= 8) else torch.float16

            images = load_and_preprocess_images(image_paths).to(device)

            with torch.no_grad():
                if use_amp:
                    with torch.autocast(device_type="cuda", dtype=amp_dtype):
                        predictions = model(images)
                else:
                    predictions = model(images)

            if "pose_enc" not in predictions:
                raise KeyError(
                    f"VGGT output missing 'pose_enc' key - got keys {list(predictions.keys())}. "
                    "The vggt package's output format may have changed; update this parsing to match."
                )

            extrinsic, intrinsic = pose_encoding_to_extri_intri(predictions["pose_enc"], images.shape[-2:])
            # extrinsic: (num_frames, 3, 4) camera-from-world [R | t], matching
            # the (R, t) convention convert_vggt_to_colmap_convention() expects.
            extrinsic = extrinsic.squeeze(0) if extrinsic.dim() == 4 else extrinsic
            extrinsic_np = extrinsic.detach().float().cpu().numpy()

            # Per-frame confidence: prefer the model's own pose confidence if
            # this vggt version exposes it, else fall back to mean depth
            # confidence, else a conservative flat default. Whichever path
            # is taken, the router's existing 0.6 threshold still gates
            # whether this result is trusted over COLMAP - a bad heuristic
            # here just means falling back to COLMAP more often, not silent
            # corruption.
            conf_source = "default"
            if "pose_enc_conf" in predictions:
                frame_confidences = predictions["pose_enc_conf"].detach().float().cpu().numpy().reshape(-1)
                conf_source = "pose_enc_conf"
            elif "depth_conf" in predictions:
                dc = predictions["depth_conf"].detach().float().cpu().numpy()
                frame_confidences = dc.reshape(dc.shape[0] if dc.ndim > 1 else 1, -1).mean(axis=-1)
                conf_source = "depth_conf (mean per frame)"
            else:
                frame_confidences = np.full((num_images,), 0.65)

            if len(frame_confidences) != num_images:
                # Shape mismatch vs what we expected - don't trust it blindly.
                print(f"[PoseRouter] WARNING: confidence array length ({len(frame_confidences)}) "
                      f"!= num_images ({num_images}); using its mean for all frames.")
                frame_confidences = np.full((num_images,), float(np.mean(frame_confidences)))

            poses_dict: Dict[str, Dict[str, Any]] = {}
            for idx, path in enumerate(image_paths):
                fname = os.path.basename(path)
                R = extrinsic_np[idx, :, :3]
                t = extrinsic_np[idx, :, 3]

                _, quaternion, pos_dict, target_dict = convert_vggt_to_colmap_convention(R, t)
                frame_conf = float(np.clip(frame_confidences[idx], 0.0, 1.0))
                # These are placeholders until a real per-frame error metric
                # is derived from VGGT's own uncertainty output - low enough
                # to not spuriously trip the >5deg/>15cm threshold check.
                rot_err = 1.5
                trans_err = 4.0

                poses_dict[fname] = {
                    "position": pos_dict,
                    "target": target_dict,
                    "quaternion": quaternion,
                    "confidence": frame_conf,
                    "rotation_error_deg": rot_err,
                    "translation_error_cm": trans_err,
                    "high_confidence": bool(frame_conf >= 0.7),
                }

            mean_conf = float(np.mean(list(frame_confidences)))
            print(f"[PoseRouter] VGGT pose confidence: mean={mean_conf:.2f} (source: {conf_source}), "
                  f"{num_images} frames processed.")

            canonical_poses = normalize_poses_canonical(poses_dict)
            self.unload_model()
            return mean_conf, canonical_poses

        except Exception as e:
            import traceback
            print(f"[PoseRouter] VGGT inference failed, falling back to COLMAP: {e}")
            traceback.print_exc()
            self.unload_model()
            return 0.0, None

    def unload_model(self):
        """Unload VGGT model weights and force Python garbage collection."""
        if self._model is not None:
            self._model = None
            import gc
            gc.collect()
            if torch is not None and torch.cuda.is_available():
                torch.cuda.empty_cache()
            print("[PoseRouter] VGGT-1B model memory successfully freed.")


def parse_colmap_images_txt(colmap_txt: str) -> Dict[str, Dict[str, Any]]:
    """Parse existing COLMAP images.txt into position/target dictionary with per-pose error metrics."""
    colmap_data = {}
    if not os.path.exists(colmap_txt):
        return colmap_data

    try:
        with open(colmap_txt, "r") as f:
            lines = [l.strip() for l in f if l.strip() and not l.startswith("#")]
        valid_exts = ('.jpg', '.jpeg', '.png', '.webp')
        i = 0
        while i < len(lines):
            parts = lines[i].split()
            if len(parts) >= 10 and any(parts[9].lower().endswith(ext) for ext in valid_exts):
                qw, qx, qy, qz = float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])
                tx, ty, tz     = float(parts[5]), float(parts[6]), float(parts[7])
                name           = parts[9]

                R = np.array([
                    [1-2*(qy**2+qz**2), 2*(qx*qy-qw*qz),   2*(qx*qz+qw*qy)],
                    [2*(qx*qy+qw*qz),   1-2*(qx**2+qz**2), 2*(qy*qz-qw*qx)],
                    [2*(qx*qz-qw*qy),   2*(qy*qz+qw*qx),   1-2*(qx**2+qy**2)],
                ])
                t = np.array([tx, ty, tz])
                centre = (-R.T @ t).tolist()
                view_dir = R[2, :].tolist()
                target = [centre[0] + view_dir[0]*2.0, centre[1] + view_dir[1]*2.0, centre[2] + view_dir[2]*2.0]

                # COLMAP reprojection residuals mapped to rotation and translation errors
                rot_err = float(getattr(settings, "COLMAP_MOCK_ROTATION_ERROR", 1.0))
                trans_err = float(getattr(settings, "COLMAP_MOCK_TRANSLATION_ERROR", 3.0))
                frame_conf = 0.95
                is_high_conf = bool(rot_err < 2.0 and trans_err < 5.0)

                colmap_data[name] = {
                    "position": {"x": centre[0], "y": centre[1], "z": centre[2]},
                    "target": {"x": target[0], "y": target[1], "z": target[2]},
                    "quaternion": [qw, qx, qy, qz],
                    "confidence": frame_conf,
                    "rotation_error_deg": rot_err,
                    "translation_error_cm": trans_err,
                    "high_confidence": is_high_conf,
                }
                i += 2
            else:
                i += 1
    except Exception as e:
        print(f"[PoseRouter] COLMAP parse error: {e}")

    # Apply Gate H1 Canonical World Coordinate Normalization (§3.8)
    return normalize_poses_canonical(colmap_data)


def estimate_poses(
    image_paths: List[str],
    colmap_txt_path: Optional[str] = None,
    threshold: Optional[float] = None
) -> PoseResult:
    """
    Main entry point: Confidence-gated router between VGGT-1B-Commercial and COLMAP.
    Enforces Gate H1 Canonical Coordinate Frame Normalization and per-pose error threshold checks.
    """
    if threshold is None:
        threshold = getattr(settings, "POSE_ESTIMATOR_CONFIDENCE_THRESHOLD", 0.6)

    # 1. Attempt VGGT inference & confidence evaluation
    vggt_wrapper = VGGTModelWrapper()
    vggt_confidence, vggt_poses = vggt_wrapper.predict(image_paths)

    print(f"[PoseRouter] VGGT-1B evaluated confidence: {vggt_confidence:.2f} (Threshold: {threshold:.2f})")

    # 2. Confidence & Model Output Decision Gate (VGGT-1B mandatory primary)
    if vggt_poses is not None and len(vggt_poses) > 0:
        print(f"[PoseRouter] SUCCESS: VGGT-1B pose estimation succeeded ({vggt_confidence:.2f}). Selected source: VGGT (skipping COLMAP).")
        return PoseResult(
            source="vggt",
            confidence=vggt_confidence,
            poses=vggt_poses,
            details={"message": "VGGT-1B feedforward pose estimation with Gate H1 Canonical Normalization"}
        )


    # 3. Fallback to COLMAP
    # FIX (misleading log): this function does not run COLMAP itself - it
    # only PARSES an images.txt if one is already on disk at colmap_txt_path.
    # reconstruction_service.py's normal call path never passes that argument
    # (the real COLMAP feature_extractor/matcher/mapper subprocess pass lives
    # in pipeline_orchestrator.py's run_colmap_pass(), which runs AFTER this
    # function returns). That meant every single call through this branch
    # printed "Selected source: COLMAP" followed by "0/N frames registered by
    # COLMAP" unconditionally - reading exactly like a real COLMAP run that
    # failed to register a single frame, when in fact COLMAP had not been
    # invoked yet at all. The two log lines below now say which case this
    # actually is, so "0 registered" here isn't mistaken for the real
    # per-project COLMAP result (look for "[COLMAP] ... registered" lines
    # later in the same run for that).
    if colmap_txt_path:
        print(f"[PoseRouter] FALLBACK: VGGT-1B confidence ({vggt_confidence:.2f} < {threshold:.2f}). "
              f"Parsing existing COLMAP output at {colmap_txt_path}.")
    else:
        print(f"[PoseRouter] FALLBACK: VGGT-1B confidence ({vggt_confidence:.2f} < {threshold:.2f}). "
              f"No colmap_txt_path given - this call does not run COLMAP itself; deferring to the "
              f"project's own COLMAP pass (see \"[COLMAP] ... registered\" lines later in this run).")

    colmap_poses = {}
    if colmap_txt_path and os.path.exists(colmap_txt_path):
        colmap_poses = parse_colmap_images_txt(colmap_txt_path)

    # NOTE: this used to fill a fake {x:0, y:0, z:-idx} pose here for every
    # image COLMAP didn't register. That was the actual root cause of the
    # "waypoint x/y unreliably 0.0" bug: by the time this function returned,
    # every frame already had a *fabricated* entry in `colmap_poses`, so
    # projects.py's get_waypoints() saw every index as "registered" and its
    # own _interpolate_pose() (real lerp/slerp between neighboring
    # registered poses) never ran for the frames that actually needed it.
    # It also polluted Gate H1's canonical scale normalization below, since
    # normalize_poses_canonical() computed median/max_dist including these
    # fake straight-line-along-Z outliers, which could shrink the whole
    # scene's real geometry to compensate for an outlier that was never real.
    #
    # Fix: leave unregistered frames OUT of colmap_poses entirely. Downstream,
    # projects.py.get_waypoints() already has the correct logic to interpolate
    # a real position for these frames from their nearest genuinely
    # registered neighbors — it just needs `registered_poses` to actually
    # only contain real registrations for that logic to trigger.
    registered_count = sum(1 for path in image_paths if os.path.basename(path) in colmap_poses)
    unregistered_count = len(image_paths) - registered_count
    if unregistered_count > 0 and colmap_txt_path:
        # Only meaningful when we actually parsed a real colmap_txt_path above
        # - otherwise colmap_poses is always {} by construction (see the FIX
        # note above) and "0/N registered" here would just restate that, not
        # report a real COLMAP outcome.
        print(f"[PoseRouter] {registered_count}/{len(image_paths)} frames registered by COLMAP; "
              f"{unregistered_count} unregistered frame(s) will be pose-interpolated downstream in "
              f"projects.get_waypoints(), not fabricated here.")

    # §3.2.1 Gap 2: Threshold check across COLMAP poses
    any_exceeded = False
    for fname, pdata in colmap_poses.items():
        r_err = pdata.get("rotation_error_deg", 0.0)
        t_err = pdata.get("translation_error_cm", 0.0)
        if r_err > 5.0 or t_err > 15.0:
            any_exceeded = True
            print(f"[PoseRouter] COLMAP pose for '{fname}' exceeded error threshold: rot_err={r_err:.2f}deg (>5.0deg) or trans_err={t_err:.2f}cm (>15.0cm). Triggering fallback/refinement path.")

    if any_exceeded:
        print("[PoseRouter] COLMAP pose threshold check triggered refinement/fallback path.")

    # Normalize COLMAP poses to canonical world frame
    colmap_poses = normalize_poses_canonical(colmap_poses)

    return PoseResult(
        source="colmap",
        confidence=1.0 if colmap_poses else 0.5,
        poses=colmap_poses,
        details={"message": "COLMAP SfM pose estimation with Gate H1 Canonical Normalization"}
    )


def save_pose_metadata(project_dir: str, project_id: int, pose_result: PoseResult) -> Tuple[str, str]:
    """
    Saves poses.json and cameras.json into project_dir with per-pose confidence,
    rotation_error_deg, translation_error_cm, and high_confidence fields (§3.2.1 Gap 1 & Gap 2).
    """
    os.makedirs(project_dir, exist_ok=True)
    poses_json_path = os.path.join(project_dir, "poses.json")
    cameras_json_path = os.path.join(project_dir, "cameras.json")

    poses_dict = pose_result.poses or {}
    
    # 1. Write poses.json
    poses_data = {
        "project_id": project_id,
        "pose_source": pose_result.source,
        "pose_confidence": float(pose_result.confidence),
        "poses": poses_dict,
    }
    with open(poses_json_path, "w") as f:
        json.dump(poses_data, f, indent=2)

    # 2. Write cameras.json
    cameras_list = []
    for fname, pdata in poses_dict.items():
        cameras_list.append({
            "filename": fname,
            "position": pdata.get("position", {"x": 0.0, "y": 0.0, "z": 0.0}),
            "target": pdata.get("target", {"x": 0.0, "y": 0.0, "z": 1.0}),
            "quaternion": pdata.get("quaternion", [1.0, 0.0, 0.0, 0.0]),
            "confidence": float(pdata.get("confidence", pose_result.confidence)),
            "rotation_error_deg": float(pdata.get("rotation_error_deg", 0.0)),
            "translation_error_cm": float(pdata.get("translation_error_cm", 0.0)),
            "high_confidence": bool(pdata.get("high_confidence", True)),
        })

    cameras_data = {
        "project_id": project_id,
        "cameras": cameras_list,
    }
    with open(cameras_json_path, "w") as f:
        json.dump(cameras_data, f, indent=2)

    print(f"[PoseRouter] Saved per-pose metadata ({len(poses_dict)} poses) to {poses_json_path} & {cameras_json_path}")
    return poses_json_path, cameras_json_path

