"""
ArticulAIT — Depth Discontinuity & Edge Filtering Service (§4.1)
Filters monocular depth map boundary discontinuities to eliminate flying pixels
and streaking/warping artifacts during 3D point cloud backprojection.
"""

import numpy as np
import logging
from typing import Tuple, Optional

logger = logging.getLogger("articulait.depth_filter")


def compute_depth_discontinuity_mask(
    depth_map: np.ndarray,
    rel_threshold: float = 0.07,
    abs_threshold: float = 0.15,
    window_size: int = 3
) -> np.ndarray:
    """
    Computes a boolean mask (True = valid clean surface, False = depth discontinuity / edge streak).
    
    Identifies flying pixels at object boundaries where depth changes rapidly:
    1. Relative depth gradient: (max_d - min_d) / (mean_d + 1e-6) > rel_threshold
    2. Absolute depth gradient: (max_d - min_d) > abs_threshold
    3. Dilates the edge boundary mask to prune bilinear transition pixels.
    """
    if depth_map.ndim != 2:
        raise ValueError(f"Expected 2D depth map array, got shape {depth_map.shape}")

    h, w = depth_map.shape
    valid_mask = depth_map > 0.05

    pad = window_size // 2
    padded_depth = np.pad(depth_map, pad_width=pad, mode='edge')

    # Efficient sliding window view over (window_size, window_size)
    patches = np.lib.stride_tricks.sliding_window_view(padded_depth, (window_size, window_size))

    min_d = np.min(patches, axis=(-2, -1))
    max_d = np.max(patches, axis=(-2, -1))
    mean_d = np.mean(patches, axis=(-2, -1))

    rel_diff = (max_d - min_d) / (mean_d + 1e-6)
    abs_diff = (max_d - min_d)

    is_edge = (rel_diff > rel_threshold) | (abs_diff > abs_threshold)

    # Dilate edge mask by 1 pixel to ensure edge-bleeding pixels are completely masked out
    try:
        from scipy.ndimage import binary_dilation
        is_edge_dilated = binary_dilation(is_edge, iterations=1)
    except ImportError:
        # Fallback NumPy 3x3 max-filter dilation
        padded_edge = np.pad(is_edge, pad_width=1, mode='edge')
        edge_patches = np.lib.stride_tricks.sliding_window_view(padded_edge, (3, 3))
        is_edge_dilated = np.any(edge_patches, axis=(-2, -1))

    clean_mask = valid_mask & (~is_edge_dilated)
    return clean_mask


def validate_camera_intrinsics(
    camera_params: Tuple[float, float, float, float],
    image_dim: Tuple[int, int],
    depth_dim: Tuple[int, int]
) -> Tuple[float, float, float, float]:
    """
    Validates and scales camera intrinsics (fx, fy, cx, cy) to match the depth map's spatial resolution.
    Prevents focal length mismatch shearing and elongated warping across scenes.
    """
    fx, fy, cx, cy = camera_params
    cam_w, cam_h = image_dim
    depth_h, depth_w = depth_dim

    scale_x = float(depth_w) / float(cam_w) if cam_w > 0 else 1.0
    scale_y = float(depth_h) / float(cam_h) if cam_h > 0 else 1.0

    fx_scaled = fx * scale_x
    fy_scaled = fy * scale_y
    cx_scaled = cx * scale_x
    cy_scaled = cy * scale_y

    logger.info(
        f"[Intrinsics Audit] Image size: {cam_w}x{cam_h} -> Depth size: {depth_w}x{depth_h} | "
        f"fx={fx_scaled:.2f}, fy={fy_scaled:.2f}, cx={cx_scaled:.2f}, cy={cy_scaled:.2f}"
    )

    return fx_scaled, fy_scaled, cx_scaled, cy_scaled
