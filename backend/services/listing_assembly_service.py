"""
ArticulAIT — Listing Assembly Service (W1-48, SOW §9.1 / §3.3)

W1-48's own framing: "a listing's 3D output is EVERY reconstructable room
assembled into ONE coherent scene, not a single room. A per-room fallback
inside the listing counts as a fail."

Ground truth this module is built against (verified by reading the actual
code, not assumed):

  * Every room is its own independent Project. backend/reconstruction/
    pose_router.normalize_poses_canonical() centers and scales EACH room's
    camera poses around that room's OWN median position into a canonical
    sphere of radius 2.5, independently of every other room. There is no
    shared real-world coordinate frame between two rooms unless one is
    explicitly established — confirmed by reading pose_router.py end to
    end; there is no cross-project alignment step anywhere in this
    codebase today.
  * Rooms are captured as separate, non-overlapping photo/video sets (one
    upload per room), so there is no shared image content between two
    rooms' reconstructions to automatically register against. This is why
    placement here is an explicit stored transform (backend.models.schema.
    ListingRoom.offset_x/y/z + yaw_deg) rather than an automatic SfM merge
    — the same tradeoff Matterport's own "dollhouse" editor makes (a human
    nudges room placement; it is not a fully automatic merge either).
  * "Genuine splat, no per-room 2.5D fallback" (the W1-48 pass bar) already
    has a source of truth on Project: `output_status` is one of
    "completed" | "fallback_2.5d" | "failed" (see pipeline_orchestrator.py
    and routes/projects.py's own /manifest endpoint, which uses exactly
    this field for the same "completed" vs "fallback_2.5d" distinction).

Layering note: this module imports `build_project_waypoints` and the
file-hotspot helpers from backend.routes.projects rather than duplicating
~150 lines of pose-interpolation/waypoint-graph logic here. That is a
service -> route import, which is backwards from the usual layering, but
it is a deliberate, one-directional dependency (routes/projects.py does not
import this module or routes/listings.py) chosen specifically so the
per-room waypoint logic used by a plain single-room walkthrough and by a
multi-room listing can never drift apart into two different
implementations of the same thing.

UNVERIFIED AGAINST A LIVE RUN: this environment has no working Python
interpreter with this project's actual dependencies (FastAPI, SQLAlchemy,
numpy, plyfile, ...), no COLMAP, and no GPU, so nothing here has been
exercised against a real request. It has been reviewed for syntax
(py_compile) and for consistency against every real function signature it
calls (read directly out of pose_router.py, reconstruction_service.py,
projects.py, schema.py, camera_path_service.py — no guessed signatures).
Please run it and paste back the actual response / traceback so any real
bug can be fixed against real output rather than guessed at further.

2026-08-26 correction (pass-bar semantics only — no change to
reconstruction, pose estimation, or the walkthrough/viewer itself): the
per-listing pass/fail computation at the bottom of `assemble_listing_scene`
previously treated ">=75% of THIS listing's own rooms passed" as a pass.
Re-read against M2 Alignment memo §9.1 ("What counts as a passing
listing"), that's the wrong level — §9.1 states the >=75% figure is a
portfolio-wide target across *listings*, and a single listing only counts
as a full 3DGS pass when ALL of its own reconstructable rooms are genuine
splats. See `_INPUT_INSUFFICIENT_REASON_CODES` and `is_full_3dgs_pass`
below for the corrected computation. This only changes what gets reported
as passing in the metadata payload — it does not touch pose estimation,
VGGT/COLMAP, waypoint building, placement transforms, or camera-path
generation, all of which are unchanged.
"""

from __future__ import annotations

import copy
import math
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from backend.core import settings
from backend.models.schema import Listing, ListingRoom, Project, Scene, ReasonCode

logger = logging.getLogger("articulait.listing_assembly_service")


# ── §9.1 pass-bar correction (2026-08-26) ────────────────────────────────
# M2 Alignment memo §9.1 ("What counts as a passing listing") is explicit
# that the SOW §3.3 ">=75%" figure is a PORTFOLIO-wide target — the
# fraction of *listings* that fully pass — not a per-listing partial-credit
# threshold: "a listing is not counted as a 3DGS pass if any reconstructable
# room falls back to 2.5D." A single listing's own bar is ALL of its
# reconstructable rooms, not 75% of them.
#
# §9.1 also carves out an exception on the room side: "a room that cannot
# reconstruct because of insufficient input is not held against the
# developer — it is excluded from the room set." These are the ReasonCode
# values that mean the room's own photo coverage was inadequate for
# reconstruction to be meaningfully attempted, as distinct from a pipeline
# failure on otherwise-adequate input (which DOES count against the
# listing's pass bar, per §9.1's own room definition):
_INPUT_INSUFFICIENT_REASON_CODES = frozenset({
    ReasonCode.NO_IMAGES_FOUND.value,
    ReasonCode.INSUFFICIENT_FRAME_OVERLAP.value,
    ReasonCode.LOW_PARALLAX.value,
})


# ── Geometry: room placement transform ──────────────────────────────────

def _rotate_xz(x: float, z: float, yaw_deg: float) -> Tuple[float, float]:
    """Rotate a point around the world Y axis by yaw_deg (degrees)."""
    theta = math.radians(yaw_deg)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    return (x * cos_t + z * sin_t, -x * sin_t + z * cos_t)


def _transform_point(p: Dict[str, float], yaw_deg: float, offset: Tuple[float, float, float], scale: float = 1.0) -> Dict[str, float]:
    # Scale first (uniform, about the room's own local origin), THEN rotate,
    # THEN translate - the standard SRT order. Scale is a manual first-pass
    # fix for a real gap: each room's poses are normalized INDEPENDENTLY into
    # its own canonical frame (pose_router.normalize_poses_canonical), so
    # there is no shared real-world scale between two rooms - without this,
    # placing two rooms "8 units apart" via offset alone says nothing about
    # whether they're actually the same real-world size relative to each
    # other. Defaults to 1.0 (no-op) for every room that hasn't been tuned.
    sx = float(p.get("x", 0.0)) * scale
    sy = float(p.get("y", 0.0)) * scale
    sz = float(p.get("z", 0.0)) * scale
    x, z = _rotate_xz(sx, sz, yaw_deg)
    y = sy + offset[1]
    return {"x": x + offset[0], "y": y, "z": z + offset[2]}


def _rotate_quat_yaw(quat: Optional[List[float]], yaw_deg: float) -> Optional[List[float]]:
    """
    Compose an additional world-Y-axis yaw rotation onto a [qw, qx, qy, qz]
    quaternion (Hamilton product, q_yaw * q_orig). Position/target are the
    authoritative transformed values for rendering (recomputed geometrically
    above, not derived from this); the frontend viewer (PanoWalkthrough.tsx)
    does not currently read `quat` at all for rendering — this is kept
    consistent on a best-effort basis for any downstream consumer that does.
    """
    if not quat or len(quat) != 4:
        return quat
    half = math.radians(yaw_deg) / 2.0
    qyaw = [math.cos(half), 0.0, math.sin(half), 0.0]  # rotation about Y
    w1, x1, y1, z1 = qyaw
    w2, x2, y2, z2 = quat
    return [
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ]


def apply_room_placement(waypoints: List[Dict[str, Any]], placement: Dict[str, float]) -> List[Dict[str, Any]]:
    """Returns a NEW list of waypoints with position/target/quat transformed
    into the listing's shared frame. Does not mutate the input (the input is
    normally the cached, reused per-room waypoints list)."""
    yaw_deg = float(placement.get("yaw_deg", 0.0))
    offset = (float(placement.get("offset_x", 0.0)), float(placement.get("offset_y", 0.0)), float(placement.get("offset_z", 0.0)))
    scale = float(placement.get("scale", 1.0)) or 1.0
    out = []
    for wp in waypoints:
        new_wp = copy.deepcopy(wp)
        if new_wp.get("position"):
            new_wp["position"] = _transform_point(new_wp["position"], yaw_deg, offset, scale)
        if new_wp.get("target"):
            new_wp["target"] = _transform_point(new_wp["target"], yaw_deg, offset, scale)
        if new_wp.get("quat"):
            new_wp["quat"] = _rotate_quat_yaw(new_wp["quat"], yaw_deg)
        out.append(new_wp)
    return out


# ── Per-room pass/fail (§9.1: every reconstructable room must be a genuine
#    splat for THIS listing to pass; §3.3's >=75% is a portfolio-wide
#    target across listings, not a per-listing threshold — see module
#    header note) ──────────────────────────────────────────────────────

def _room_pass_fail(project: Project) -> Dict[str, Any]:
    out_status = getattr(project, "output_status", None) or ("completed" if project.status == "completed" else "failed")
    reason_code = getattr(project, "reason_code", "NONE") or "NONE"
    # "completed" = genuine 3DGS splat produced for this room. Anything else
    # ("fallback_2.5d" or "failed") is a per-room fail per W1-48's own
    # acceptance bar ("a per-room fallback inside the listing counts as a
    # fail") — this mirrors exactly what routes/projects.py's own
    # /manifest endpoint (§6.5) already treats as the pass/fail line.
    passed = out_status == "completed"
    # §9.1: a room excluded here because ITS OWN input was insufficient is
    # not "reconstructable" and is not held against the listing's pass bar
    # (see _INPUT_INSUFFICIENT_REASON_CODES above). A passed room is
    # trivially reconstructable; a failed/fallback room is reconstructable
    # only if its reason code is NOT one of the input-insufficient ones.
    reconstructable = passed or (reason_code not in _INPUT_INSUFFICIENT_REASON_CODES)
    return {
        "output_status": out_status,
        "reason_code": reason_code,
        "passed": passed,
        "reconstructable": reconstructable,
    }


def compute_listing_pass_summary(room_pass_fails: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Pure aggregation step, extracted out of assemble_listing_scene so the
    §9.1 pass-bar arithmetic is unit-testable without a DB session, a
    Listing/ListingRoom graph, or the reconstruction pipeline. Takes a list
    of `_room_pass_fail()` results (or any dicts with the same "passed" /
    "reconstructable" keys) for one listing's rooms and returns the
    corrected §9.1 pass computation:

      - a listing's own bar is ALL of its reconstructable rooms genuine,
        not >=75% of them (the >=75% figure in §3.3 is a portfolio-wide
        target across *listings*, not a per-listing partial-credit line —
        see the module header note and CLAUDE.md at the project root).
      - a room excluded here as "not reconstructable" (insufficient input)
        does not count against this listing's bar either way.
    """
    rooms_total = len(room_pass_fails)
    passed_count = sum(1 for r in room_pass_fails if r.get("passed"))
    reconstructable_count = sum(1 for r in room_pass_fails if r.get("reconstructable"))
    rooms_excluded_insufficient_input = rooms_total - reconstructable_count
    pass_rate = (passed_count / rooms_total) if rooms_total else 0.0
    is_full_3dgs_pass = reconstructable_count > 0 and passed_count == reconstructable_count
    return {
        "rooms_total": rooms_total,
        "rooms_passed": passed_count,
        "rooms_reconstructable_total": reconstructable_count,
        "rooms_excluded_insufficient_input": rooms_excluded_insufficient_input,
        "pass_rate": round(pass_rate, 4),
        "is_full_3dgs_pass": is_full_3dgs_pass,
    }


# ── Camera path: concatenate each room's real registered poses, one spline ──

def _catmull_vec(p0, p1, p2, p3, u):
    u2 = u * u
    u3 = u2 * u
    return {
        k: 0.5 * (
            2 * p1[k]
            + (-p0[k] + p2[k]) * u
            + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2
            + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3
        )
        for k in ("x", "y", "z")
    }


def build_listing_camera_path(rooms_control_points: List[List[Dict[str, Any]]], num_rooms: int, fps: int = 30) -> Dict[str, Any]:
    """
    Builds ONE continuous Bezier/Catmull-Rom camera path threading through
    every room in order (§9.1: "Make the scripted Bezier camera path...
    play across rooms"). This is the same Catmull-Rom-through-real-poses
    algorithm routes/projects.py's own get_camera_path() uses for a single
    room (§9.1 / M2), extended to a concatenated multi-room control-point
    sequence instead of duplicating a second, divergent implementation.

    rooms_control_points: per room, a list of ALREADY listing-frame
    (placement-transformed) waypoint dicts with "position"/"target", in
    room traversal order, each room's list already subsampled to a
    reasonable control-point count by the caller.
    """
    sampled: List[Dict[str, Any]] = []
    for room_points in rooms_control_points:
        sampled.extend(room_points)

    if len(sampled) < 2:
        return {
            "status": "insufficient_control_points",
            "path_type": "catmull_rom_poses_multi_room",
            "waypoints": [],
        }

    positions = [{"x": p["position"]["x"], "y": p["position"]["y"], "z": p["position"]["z"]} for p in sampled]
    targets = []
    for p in sampled:
        t = p.get("target") or p["position"]
        targets.append({"x": t["x"], "y": t["y"], "z": t["z"]})

    # Duration: scales with control-point count AND room count (more rooms
    # need more time even at a fixed pace) - same intent as
    # camera_path_service.generate_bezier_camera_path's own num_rooms term,
    # bounded wider here (a real multi-room flythrough is legitimately
    # longer than a single-room one) but still capped so it can't run away.
    duration = round(min(90.0, max(15.0, len(sampled) * 0.55 + (num_rooms - 1) * 4.0)), 1)
    total_frames = max(2, int(duration * fps))

    padded_pos = [positions[0]] + positions + [positions[-1]]
    padded_tgt = [targets[0]] + targets + [targets[-1]]
    n_segments = len(positions) - 1

    path_waypoints = []
    cumulative = 0.0
    prev_pos = None
    for frame_idx in range(total_frames):
        t_global = frame_idx / max(1, total_frames - 1)
        seg_f = t_global * n_segments
        seg_i = min(int(seg_f), n_segments - 1)
        seg_t = seg_f - seg_i

        p0, p1, p2, p3 = padded_pos[seg_i], padded_pos[seg_i + 1], padded_pos[seg_i + 2], padded_pos[seg_i + 3]
        t0, t1, t2, t3 = padded_tgt[seg_i], padded_tgt[seg_i + 1], padded_tgt[seg_i + 2], padded_tgt[seg_i + 3]
        pos = _catmull_vec(p0, p1, p2, p3, seg_t)
        tgt = _catmull_vec(t0, t1, t2, t3, seg_t)

        seg_dist = 0.0
        if prev_pos:
            seg_dist = math.sqrt((pos["x"] - prev_pos["x"]) ** 2 + (pos["y"] - prev_pos["y"]) ** 2 + (pos["z"] - prev_pos["z"]) ** 2)
        cumulative += seg_dist
        prev_pos = pos

        path_waypoints.append({
            "frame": frame_idx,
            "time_sec": round(t_global * duration, 3),
            "t": round(t_global, 4),
            "position": {k: round(pos[k], 4) for k in ("x", "y", "z")},
            "target": {k: round(tgt[k], 4) for k in ("x", "y", "z")},
            "cumulative_distance": round(cumulative, 4),
        })

    return {
        "status": "success",
        "path_type": "catmull_rom_poses_multi_room",
        "duration_seconds": duration,
        "sample_rate_fps": fps,
        "total_waypoints": len(path_waypoints),
        "control_point_count": len(sampled),
        "num_rooms": num_rooms,
        "waypoints": path_waypoints,
    }


# ── Main entry point ────────────────────────────────────────────────────

def assemble_listing_scene(listing: Listing, db: Session) -> Dict[str, Any]:
    """
    Assembles every member room of `listing` into ONE merged, navigable
    waypoint graph in a shared "listing frame", per W1-48 / §9.1.

    Returns a payload shaped to be a drop-in superset of the existing
    single-project /waypoints response ({waypoints, hotspots, total,
    source, confidence, panorama_type, ...}) plus listing-level metadata
    (rooms, pass_rate, camera_path) - so the existing PanoWalkthrough.tsx
    viewer (which is already index/connections/image_url driven, not
    project-id driven - see its resolveUrl()/executeWalkTransitionToNode())
    can consume it with minimal changes.
    """
    from backend.routes.projects import build_project_waypoints, _load_file_hotspots  # local import: see module docstring layering note

    rooms = sorted(listing.rooms, key=lambda r: (r.room_order, r.id))

    merged_waypoints: List[Dict[str, Any]] = []
    merged_hotspots: List[Dict[str, Any]] = []
    room_summaries: List[Dict[str, Any]] = []
    rooms_control_points: List[List[Dict[str, Any]]] = []

    # project_id -> global index offset, needed for a second pass to resolve
    # cross-room "door" connector hotspots (a hotspot in room A may target a
    # waypoint in room B that hasn't been processed yet in traversal order).
    offset_by_project: Dict[int, int] = {}
    raw_hotspots_by_project: Dict[int, List[Dict[str, Any]]] = {}

    global_index = 0
    panorama_types = set()
    confidences = []

    for room in rooms:
        project = db.query(Project).filter(Project.id == room.project_id).first()
        if not project:
            room_summaries.append({
                "listing_room_id": room.id, "project_id": room.project_id, "room_label": room.room_label,
                "room_order": room.room_order, "error": "project_not_found", "passed": False,
                "waypoint_count": 0,
            })
            continue

        placement = {
            "offset_x": room.offset_x, "offset_y": room.offset_y,
            "offset_z": room.offset_z, "yaw_deg": room.yaw_deg,
            "scale": room.scale if room.scale is not None else 1.0,
        }

        # ── Real 3DGS composite asset (W1-48's actual acceptance bar, not
        # just the photo-tour waypoint graph above) - surface each room's
        # own trained splat file, if one exists on disk, as a URL the
        # frontend's multi-room splat compositor (ListingSplatViewer.tsx)
        # can fetch directly, plus whatever LOD tiers were generated for it
        # (see gaussian_service.py) so the compositor can trade quality for
        # total-scene splat budget across rooms instead of always loading
        # every room at full resolution. `has_genuine_splat` is deliberately
        # NOT the same check as `pf["passed"]` below - a fallback_2.5d room
        # can still have a scene.splat file (the crude dense-cloud
        # conversion also writes one), so a consumer must check `passed`/
        # `output_status`, not just "does a URL exist", to honor W1-48's own
        # "a per-room fallback counts as a fail" bar.
        project_dir = os.path.join(settings.DATA_DIR, f"project_{room.project_id}")
        splat_url = None
        if os.path.exists(os.path.join(project_dir, "scene.splat")):
            splat_url = f"/data/project_{room.project_id}/scene.splat"
        splat_lod_urls: Dict[str, str] = {}
        for tier in ("low", "medium", "high"):
            if os.path.exists(os.path.join(project_dir, f"scene_lod_{tier}.splat")):
                splat_lod_urls[tier] = f"/data/project_{room.project_id}/scene_lod_{tier}.splat"

        try:
            wp_result = build_project_waypoints(project, db, force_refresh=False)
        except Exception as e:
            logger.warning(f"[ListingAssembly] room project_id={room.project_id} waypoint build failed: {e}")
            wp_result = {"waypoints": [], "source": "error", "confidence": 0.0, "panorama_type": "flat"}

        room_waypoints = wp_result.get("waypoints") or []
        transformed = apply_room_placement(room_waypoints, placement)

        offset_by_project[room.project_id] = global_index
        for wp in transformed:
            local_idx = wp["index"]
            wp["index"] = global_index + local_idx
            wp["project_id"] = room.project_id
            wp["room_id"] = room.id
            wp["room_label"] = room.room_label
            if isinstance(wp.get("connections"), list):
                wp["connections"] = [global_index + c for c in wp["connections"]]
            merged_waypoints.append(wp)

        scene = db.query(Scene).filter(Scene.project_id == room.project_id).first()
        pf = _room_pass_fail(project)
        # passed/reconstructable counts are derived below from room_summaries
        # via compute_listing_pass_summary() rather than accumulated here.
        panorama_types.add(wp_result.get("panorama_type") or "flat")
        confidences.append(float(wp_result.get("confidence", 0.0)))

        room_summaries.append({
            "listing_room_id": room.id,
            "project_id": room.project_id,
            "room_label": room.room_label,
            "room_order": room.room_order,
            "placement": placement,
            "passed": pf["passed"],
            "output_status": pf["output_status"],
            "reason_code": pf["reason_code"],
            # §9.1: whether this room counts toward the listing's pass bar
            # at all. False only when the room fell back/failed for a
            # reason that means ITS OWN input was insufficient — that case
            # is excluded from the bar rather than held against it.
            "reconstructable": pf["reconstructable"],
            "point_count": scene.point_count if scene else None,
            "waypoint_count": len(transformed),
            "index_offset": global_index,
            "pose_source": wp_result.get("source"),
            "splat_url": splat_url,
            "splat_lod_urls": splat_lod_urls or None,
        })

        # Bound control points per room the same way the single-room
        # get_camera_path() caps at ~80 for the whole path; here we cap
        # per-room so many rooms doesn't blow the total up unboundedly.
        real_poses = [w for w in transformed if w.get("position") and all(k in w["position"] for k in ("x", "y", "z"))]
        if real_poses:
            step = max(1, len(real_poses) // 24)
            room_sampled = real_poses[::step]
            if room_sampled[-1]["index"] != real_poses[-1]["index"]:
                room_sampled.append(real_poses[-1])
            rooms_control_points.append(room_sampled)

        raw_hotspots_by_project[room.project_id] = _load_file_hotspots(room.project_id)
        global_index += len(transformed)

    # ── Second pass: merge hotspots, remap indices, wire "door" connectors ──
    index_to_waypoint = {w["index"]: w for w in merged_waypoints}
    next_hotspot_id = 1
    for room in rooms:
        if room.project_id not in offset_by_project:
            continue
        base = offset_by_project[room.project_id]
        for h in raw_hotspots_by_project.get(room.project_id, []):
            new_h = dict(h)
            local_wp_idx = h.get("waypoint_index", h.get("waypoint_id"))
            if local_wp_idx is None:
                continue
            global_wp_idx = base + int(local_wp_idx)
            new_h["id"] = next_hotspot_id
            new_h["waypoint_id"] = global_wp_idx
            new_h["waypoint_index"] = global_wp_idx
            new_h["project_id"] = room.project_id
            next_hotspot_id += 1

            tgt_project = h.get("target_project_id")
            tgt_local_idx = h.get("target_waypoint_index")
            if h.get("icon_type") == "door" and tgt_project is not None and tgt_local_idx is not None:
                if tgt_project in offset_by_project:
                    tgt_global_idx = offset_by_project[tgt_project] + int(tgt_local_idx)
                    new_h["target_waypoint_global_index"] = tgt_global_idx
                    # Wire a bidirectional graph edge through the doorway so
                    # the existing nav-ring / click-to-move UI can walk it
                    # exactly like any other connection.
                    src_wp = index_to_waypoint.get(global_wp_idx)
                    tgt_wp = index_to_waypoint.get(tgt_global_idx)
                    if src_wp is not None and tgt_wp is not None:
                        src_conns = src_wp.setdefault("connections", [])
                        if tgt_global_idx not in src_conns:
                            src_conns.append(tgt_global_idx)
                        tgt_conns = tgt_wp.setdefault("connections", [])
                        if global_wp_idx not in tgt_conns:
                            tgt_conns.append(global_wp_idx)
                else:
                    logger.warning(
                        f"[ListingAssembly] door hotspot on project {room.project_id} targets "
                        f"project {tgt_project}, which is not a member of listing {listing.id} - edge skipped."
                    )
            merged_hotspots.append(new_h)

    camera_path = build_listing_camera_path(rooms_control_points, num_rooms=len(rooms))

    # §9.1 corrected pass bar (2026-08-26, see compute_listing_pass_summary
    # docstring and CLAUDE.md at the project root): THIS listing passes only
    # when every one of its own reconstructable rooms is a genuine splat —
    # not merely >=75% of them. The SOW §3.3 ">=75%" figure is the
    # portfolio target measured across *listings*, so it is deliberately
    # NOT used as the per-listing threshold here. room_summaries already
    # carries "passed"/"reconstructable" per room (set above), so the
    # aggregation is delegated to the pure, independently-tested helper
    # rather than recomputed inline.
    pass_summary = compute_listing_pass_summary(room_summaries)

    return {
        "listing_id": listing.id,
        "name": listing.name,
        "waypoints": merged_waypoints,
        "hotspots": merged_hotspots,
        "total": len(merged_waypoints),
        "raw_total": len(merged_waypoints),
        "coverage_gaps": [],
        "source": "multi_room_listing",
        "confidence": (sum(confidences) / len(confidences)) if confidences else 0.0,
        "panorama_type": "mixed" if len(panorama_types) > 1 else (next(iter(panorama_types)) if panorama_types else "flat"),
        "rooms": room_summaries,
        "rooms_total": pass_summary["rooms_total"],
        "rooms_passed": pass_summary["rooms_passed"],
        # Rooms that count toward this listing's pass bar at all (excludes
        # rooms whose own photo coverage was too thin to reconstruct — §9.1
        # does not hold those against the developer).
        "rooms_reconstructable_total": pass_summary["rooms_reconstructable_total"],
        "rooms_excluded_insufficient_input": pass_summary["rooms_excluded_insufficient_input"],
        "pass_rate": pass_summary["pass_rate"],
        # Corrected 2026-08-26 against M2 Alignment §9.1: this is now the
        # all-reconstructable-rooms-genuine bar for THIS listing (equal to
        # is_full_3dgs_pass below), not the old >=75%-of-this-listing's-own-
        # rooms threshold. Field name kept for API/frontend compatibility.
        "meets_pass_target": pass_summary["is_full_3dgs_pass"],
        "is_full_3dgs_pass": pass_summary["is_full_3dgs_pass"],
        "camera_path": camera_path,
    }
