"""
ArticulAIT — Floor Plan Generation Service

Derives a real, vectorized 2D floor plan (wall segments + room polygons) from
a project's already-reconstructed point cloud (scene_clean.ply / scene.ply).
No new photo capture is required — this works entirely from data the
reconstruction pipeline already produces for the 3D walkthrough.

── Two things this module is deliberately careful about ────────────────────

1. UP AXIS: this codebase's raw point clouds have no documented/guaranteed
   axis convention (pose_router.normalize_poses_canonical only centers and
   scales camera poses — it does not fix what "up" means), and there is no
   gravity/IMU reference anywhere in this pipeline. Rather than hardcoding an
   assumption (e.g. "Y is up") that could silently be wrong for some
   captures, the up axis is ESTIMATED from that project's own camera
   positions (poses.json): a person walking around a room to photograph it
   moves the camera far more horizontally than vertically, so PCA over
   camera positions gives "up" as the principal component with the LEAST
   variance. This is a standard technique for exactly this situation (planar
   motion, unknown orientation) and is measured per-project rather than
   assumed globally.

2. SCALE: SfM reconstruction (VGGT/COLMAP) scale is inherently ambiguous
   without a real-world reference, and normalize_poses_canonical actively
   rescales every project's poses to an arbitrary fixed radius — so there is
   currently no meters/feet calibration anywhere in this pipeline. All
   dimensions this module computes (wall lengths, room areas) are in the
   SAME arbitrary "canonical units" the rest of the reconstruction already
   uses — they are geometrically correct proportions, NOT verified
   real-world measurements. The API response says so explicitly
   (unit: "canonical") rather than fabricating fake meters/feet.

── Algorithm ─────────────────────────────────────────────────────────────
  1. Load the point cloud, estimate the up axis (see above).
  2. Take the 1st/99th percentile of point heights along "up" as floor/
     ceiling (robust to noise/outliers vs. a single min/max).
  3. Slice points to the 25%-75% height band between floor and ceiling —
     this isolates mid-wall points while excluding floor clutter
     (furniture) and ceiling clutter (fixtures), independent of absolute
     scale since it's a fraction of THIS room's own floor-to-ceiling span.
  4. Project the slice onto the two horizontal axes and rasterize into a
     2D occupancy grid.
  5. Each connected component of the wall-density mask is one wall segment:
     cv2.minAreaRect gives its centerline (long axis) directly.
  6. Flood-fill the inverse mask from the grid border inward; whatever
     stays unfilled and enclosed by walls is room interior. Connected
     components of that = individual rooms; contours -> room polygons.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

from backend.core import settings

logger = logging.getLogger("articulait.floorplan_service")

MIN_POINTS = 2000
WALL_SLICE_LO_FRAC = 0.25
WALL_SLICE_HI_FRAC = 0.75
GRID_LONG_SIDE_PX = 500
GRID_PADDING_FRAC = 0.06
MIN_WALL_PIXELS = 20  # drop connected components smaller than this (noise)
MIN_WALL_LENGTH_PX = 8
MIN_ROOM_AREA_PX = 150  # drop enclosed pockets too small to be a real room


class FloorplanInsufficientData(Exception):
    """Raised for any expected 'can't build a plan from this data' case —
    caught by generate_floorplan() and turned into a status dict, never a
    500 with a stack trace."""

    def __init__(self, reason: str, detail: str = ""):
        self.reason = reason
        self.detail = detail
        super().__init__(f"{reason}: {detail}" if detail else reason)


def _project_dir(project_id: int) -> str:
    return os.path.join(settings.DATA_DIR, f"project_{project_id}")


def _load_point_cloud(project_id: int) -> Tuple[np.ndarray, str]:
    d = _project_dir(project_id)
    for name in ("scene_clean.ply", "scene.ply"):
        path = os.path.join(d, name)
        if os.path.exists(path):
            try:
                from plyfile import PlyData
            except ImportError as e:
                raise FloorplanInsufficientData("plyfile_unavailable", str(e))
            try:
                ply = PlyData.read(path)
                v = ply["vertex"]
                pts = np.stack(
                    [np.asarray(v["x"]), np.asarray(v["y"]), np.asarray(v["z"])], axis=1
                ).astype(np.float64)
            except Exception as e:
                raise FloorplanInsufficientData("ply_read_failed", f"{name}: {e}")
            return pts, name
    raise FloorplanInsufficientData("no_point_cloud", "neither scene_clean.ply nor scene.ply exists")


def _estimate_up_axis(points: np.ndarray) -> np.ndarray:
    """
    Estimate the up axis via PCA on the POINT CLOUD itself (not camera
    poses — see below for why). A room's point cloud is reliably "flatter"
    vertically than horizontally (floor-to-ceiling height is almost always
    less than the room's length/width), so the vertical axis is the
    principal component with the SMALLEST spatial variance.

    An earlier version of this used PCA on camera positions from
    poses.json instead, on the theory that a walkthrough capture moves the
    camera more horizontally than vertically. That was WRONG in practice:
    tested against this repo's actual project data (2026-09-07), several
    real projects' poses.json have every camera at x=0, y=0 with only z
    varying (a degenerate synthetic/fallback orbit, not real 3D motion),
    which makes camera-position PCA numerically arbitrary — verified by
    rendering the resulting "floor plan" and seeing a nonsense single flat
    sheet instead of a room outline. The point cloud itself doesn't have
    this problem: even when poses are degenerate, the reconstructed
    geometry still has real 3D structure.
    """
    if len(points) < 100:
        raise FloorplanInsufficientData("too_few_points_for_pca", f"{len(points)} points")

    # Trim outliers (stray/noise points) via percentile clipping per axis
    # before computing covariance, so a handful of far-flung noisy points
    # can't dominate the principal-axis estimate.
    lo = np.percentile(points, 2, axis=0)
    hi = np.percentile(points, 98, axis=0)
    inlier_mask = np.all((points >= lo) & (points <= hi), axis=1)
    trimmed = points[inlier_mask] if inlier_mask.sum() >= 100 else points

    centered = trimmed - trimmed.mean(axis=0)
    cov = np.cov(centered.T)
    eigvals, eigvecs = np.linalg.eigh(cov)  # ascending eigenvalue order
    up = eigvecs[:, 0]
    norm = np.linalg.norm(up)
    if norm < 1e-9:
        raise FloorplanInsufficientData("degenerate_point_cloud", "point cloud has no clear principal axis")
    return up / norm


def _horizontal_basis(up: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    helper = np.array([1.0, 0.0, 0.0]) if abs(up[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    u = np.cross(up, helper)
    u = u / np.linalg.norm(u)
    v = np.cross(up, u)
    return u, v


def _wall_mask_and_transform(
    points_2d: np.ndarray,
) -> Tuple[np.ndarray, float, Tuple[float, float]]:
    """Rasterizes 2D wall-slice points into a binary occupancy grid.
    Returns (mask, cell_size, origin) where origin is the world-space (u, v)
    coordinate of pixel (0, 0), so pixel<->world conversion is:
    world = origin + pixel * cell_size (with v flipped for image row order)."""
    lo = points_2d.min(axis=0)
    hi = points_2d.max(axis=0)
    span = hi - lo
    pad = span.max() * GRID_PADDING_FRAC if span.max() > 0 else 1.0
    lo -= pad
    hi += pad
    span = hi - lo

    long_side = max(span[0], span[1])
    if long_side <= 0:
        raise FloorplanInsufficientData("degenerate_extent", "wall-slice points collapse to a point")
    cell_size = long_side / GRID_LONG_SIDE_PX

    w = max(2, int(round(span[0] / cell_size)))
    h = max(2, int(round(span[1] / cell_size)))

    px = np.clip(((points_2d[:, 0] - lo[0]) / cell_size).astype(np.int32), 0, w - 1)
    py = np.clip(((points_2d[:, 1] - lo[1]) / cell_size).astype(np.int32), 0, h - 1)

    density = np.zeros((h, w), dtype=np.int32)
    np.add.at(density, (py, px), 1)

    mask = (density >= 1).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

    return mask, cell_size, (float(lo[0]), float(lo[1]))


def _pixel_to_world(px: float, py: float, cell_size: float, origin: Tuple[float, float]) -> Tuple[float, float]:
    return origin[0] + px * cell_size, origin[1] + py * cell_size


def _extract_wall_segments(
    mask: np.ndarray, cell_size: float, origin: Tuple[float, float]
) -> List[Dict[str, Any]]:
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    segments: List[Dict[str, Any]] = []

    for label in range(1, num_labels):  # skip 0 = background
        area = stats[label, cv2.CC_STAT_AREA]
        if area < MIN_WALL_PIXELS:
            continue

        component_mask = (labels == label).astype(np.uint8) * 255
        contours, _ = cv2.findContours(component_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        if len(contour) < 5:
            continue

        (cx, cy), (rw, rh), angle_deg = cv2.minAreaRect(contour)
        length_px = max(rw, rh)
        thickness_px = min(rw, rh)
        if length_px < MIN_WALL_LENGTH_PX:
            continue

        # minAreaRect's angle is for the `rw` side; if rh is the long side,
        # the wall's true direction is rotated 90 degrees from `angle_deg`.
        wall_angle_deg = angle_deg if rw >= rh else angle_deg + 90.0
        theta = np.radians(wall_angle_deg)
        half_len = length_px / 2.0
        dx, dy = np.cos(theta) * half_len, np.sin(theta) * half_len

        p1_px = (cx - dx, cy - dy)
        p2_px = (cx + dx, cy + dy)
        p1_world = _pixel_to_world(*p1_px, cell_size, origin)
        p2_world = _pixel_to_world(*p2_px, cell_size, origin)

        segments.append(
            {
                "start": {"u": round(p1_world[0], 4), "v": round(p1_world[1], 4)},
                "end": {"u": round(p2_world[0], 4), "v": round(p2_world[1], 4)},
                "length": round(length_px * cell_size, 4),
                "thickness": round(thickness_px * cell_size, 4),
            }
        )

    return segments


def _extract_room_polygons(
    mask: np.ndarray, cell_size: float, origin: Tuple[float, float]
) -> List[Dict[str, Any]]:
    h, w = mask.shape
    # Pad by 1px of guaranteed-background border so flood fill from (0,0)
    # can always reach every part of the true exterior region.
    padded = cv2.copyMakeBorder(mask, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    free = (padded == 0).astype(np.uint8) * 255

    fill_mask = np.zeros((free.shape[0] + 2, free.shape[1] + 2), dtype=np.uint8)
    exterior = free.copy()
    cv2.floodFill(exterior, fill_mask, (0, 0), 128)

    # Enclosed free-space = pixels that were free (0-valued originally) but
    # NOT reached by the border flood fill (i.e. still 255, not 128/0).
    interior = np.where(exterior == 255, 255, 0).astype(np.uint8)
    interior = interior[1:-1, 1:-1]  # strip the padding back off

    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(interior, connectivity=4)
    rooms: List[Dict[str, Any]] = []

    for label in range(1, num_labels):
        area_px = stats[label, cv2.CC_STAT_AREA]
        if area_px < MIN_ROOM_AREA_PX:
            continue

        component_mask = (labels == label).astype(np.uint8) * 255
        contours, _ = cv2.findContours(component_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        epsilon = 0.01 * cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, epsilon, True)

        polygon_world = [
            {"u": round(w0, 4), "v": round(v0, 4)}
            for w0, v0 in (_pixel_to_world(pt[0][0], pt[0][1], cell_size, origin) for pt in approx)
        ]
        cx_px, cy_px = centroids[label]
        centroid_world = _pixel_to_world(cx_px, cy_px, cell_size, origin)

        rooms.append(
            {
                "polygon": polygon_world,
                "area": round(area_px * (cell_size**2), 4),
                "perimeter": round(cv2.arcLength(contour, True) * cell_size, 4),
                "centroid": {"u": round(centroid_world[0], 4), "v": round(centroid_world[1], 4)},
            }
        )

    rooms.sort(key=lambda r: r["area"], reverse=True)
    for i, room in enumerate(rooms):
        room["id"] = i + 1

    return rooms


def generate_floorplan(project_id: int) -> Dict[str, Any]:
    """Pure function (no DB session) — the route layer persists the result.
    Never raises for expected 'can't build a plan' cases; returns a
    status="insufficient_data" dict with a machine-readable reason instead."""
    try:
        points, source_file = _load_point_cloud(project_id)
        if len(points) < MIN_POINTS:
            raise FloorplanInsufficientData("too_few_points", f"{len(points)} < {MIN_POINTS}")

        up = _estimate_up_axis(points)
        u_axis, v_axis = _horizontal_basis(up)

        heights = points @ up
        floor_h, ceiling_h = np.percentile(heights, [1.0, 99.0])
        room_height = ceiling_h - floor_h
        if room_height <= 1e-6:
            raise FloorplanInsufficientData("no_vertical_extent", "floor/ceiling heights coincide")

        lo_cut = floor_h + WALL_SLICE_LO_FRAC * room_height
        hi_cut = floor_h + WALL_SLICE_HI_FRAC * room_height
        slice_mask = (heights >= lo_cut) & (heights <= hi_cut)
        wall_slice = points[slice_mask]
        if len(wall_slice) < MIN_POINTS // 4:
            raise FloorplanInsufficientData("sparse_wall_slice", f"{len(wall_slice)} points in wall-height band")

        points_2d = np.stack([wall_slice @ u_axis, wall_slice @ v_axis], axis=1)
        mask, cell_size, origin = _wall_mask_and_transform(points_2d)

        wall_segments = _extract_wall_segments(mask, cell_size, origin)
        if not wall_segments:
            raise FloorplanInsufficientData("no_walls_detected", "wall mask produced no connected components")

        rooms = _extract_room_polygons(mask, cell_size, origin)

        h_px, w_px = mask.shape
        bounds = {
            "min_u": origin[0],
            "min_v": origin[1],
            "max_u": origin[0] + w_px * cell_size,
            "max_v": origin[1] + h_px * cell_size,
        }

        return {
            "status": "success",
            "project_id": project_id,
            "source_point_cloud": source_file,
            "unit": "canonical",
            "scale_note": (
                "Wall lengths and room areas are in this reconstruction's own "
                "arbitrary canonical units (proportions are correct; there is "
                "no real-world meters/feet calibration anywhere in this "
                "pipeline yet), not verified real-world measurements."
            ),
            "up_axis": {"x": round(up[0], 6), "y": round(up[1], 6), "z": round(up[2], 6)},
            "floor_height": round(float(floor_h), 4),
            "ceiling_height": round(float(ceiling_h), 4),
            "bounds": bounds,
            "wall_segments": wall_segments,
            "rooms": rooms,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

    except FloorplanInsufficientData as e:
        logger.info(f"[FloorPlan] project_id={project_id} insufficient_data: {e}")
        return {
            "status": "insufficient_data",
            "project_id": project_id,
            "reason": e.reason,
            "detail": e.detail,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
