"""
ArticulAIT — Production Launch Target Metrics Service (§3.3 & §6.1)
Tracks and computes rolling success rate for >=75% acceptable 3DGS walkthroughs (8+-photo listings).
"""

import logging
from typing import Dict, Any, Optional, List
from sqlalchemy.orm import Session
from backend.models.schema import ListingRunMetric, Project, Scene

logger = logging.getLogger("articulait.metrics_service")

# §3.3 Launch Target Thresholds
MIN_PHOTOS_FOR_TARGET_DENOMINATOR = 8
TARGET_PASS_RATE_PERCENT = 75.0
MAX_WALKTHROUGH_GEN_SECONDS_P95 = 1200.0  # <20 minutes p95 walkthrough generation (§6.1)
MIN_DESKTOP_RENDER_FPS = 60.0              # >=60fps desktop at render (§6.1)
MIN_MOBILE_RENDER_FPS = 30.0               # >=30fps mobile at render (§6.1)
MIN_PSNR_THRESHOLD_DB = 20.0               # Minimum acceptable PSNR in dB


def is_acceptable(listing_result: Dict[str, Any]) -> bool:
    """
    Programmatic definition of an 'acceptable' 3DGS walkthrough per §3.3 / §6.1.
    
    A listing result is acceptable IF AND ONLY IF:
    1. photo_count >= 8 (per §3.3 launch target scope filter)
    2. status == "completed"
    3. total_duration_seconds <= 1200.0 (< 20 minutes p95 walkthrough generation per §6.1)
    4. quality_pass is True (and PSNR >= 20.0 dB if evaluated)
    5. render FPS thresholds met if measured:
       - measured_fps_desktop is None OR measured_fps_desktop >= 60.0
       - measured_fps_mobile is None OR measured_fps_mobile >= 30.0
    """
    photo_count = listing_result.get("photo_count", 0)
    if photo_count < MIN_PHOTOS_FOR_TARGET_DENOMINATOR:
        return False

    status = listing_result.get("status")
    if status != "completed":
        return False

    total_duration = listing_result.get("total_duration_seconds")
    if total_duration is not None and total_duration > MAX_WALKTHROUGH_GEN_SECONDS_P95:
        return False

    quality_pass = listing_result.get("quality_pass", True)
    if quality_pass is False:
        return False

    psnr = listing_result.get("psnr")
    if psnr is not None and psnr < MIN_PSNR_THRESHOLD_DB:
        return False

    fps_desktop = listing_result.get("measured_fps_desktop")
    if fps_desktop is not None and fps_desktop < MIN_DESKTOP_RENDER_FPS:
        return False

    fps_mobile = listing_result.get("measured_fps_mobile")
    if fps_mobile is not None and fps_mobile < MIN_MOBILE_RENDER_FPS:
        return False

    return True


def record_listing_run_metric(db: Session, metric_data: Dict[str, Any]) -> ListingRunMetric:
    """
    Persists a single listing run metric record to the database.
    Computes is_acceptable programmatically before insertion.
    """
    acceptable_flag = is_acceptable(metric_data)
    metric_record = ListingRunMetric(
        listing_id=metric_data["listing_id"],
        session_id=metric_data.get("session_id"),
        photo_count=metric_data.get("photo_count", 0),
        status=metric_data.get("status", "failed"),
        duration_per_stage=metric_data.get("duration_per_stage", {}),
        total_duration_seconds=metric_data.get("total_duration_seconds"),
        measured_fps_desktop=metric_data.get("measured_fps_desktop"),
        measured_fps_mobile=metric_data.get("measured_fps_mobile"),
        quality_pass=metric_data.get("quality_pass", True),
        psnr=metric_data.get("psnr"),
        is_acceptable=acceptable_flag,
    )
    db.add(metric_record)
    try:
        db.commit()
        db.refresh(metric_record)
    except Exception as ex:
        db.rollback()
        logger.warning(f"[MetricsService] Failed committing ListingRunMetric: {ex}")
    return metric_record


def compute_rolling_pass_rate(db: Session, window: int = 100) -> Dict[str, Any]:
    """
    Computes rolling success rate = count(is_acceptable) / count(photo_count >= 8),
    over the specified window (e.g. last 20 / last 100 listings).
    Strictly excludes listings with photo_count < 8 from the denominator.
    """
    # 1. Query dedicated ListingRunMetric records for 8+ photo listings
    metric_rows = (
        db.query(ListingRunMetric)
        .filter(ListingRunMetric.photo_count >= MIN_PHOTOS_FOR_TARGET_DENOMINATOR)
        .order_by(ListingRunMetric.id.desc())
        .limit(window)
        .all()
    )

    # 2. Fallback to Project / Scene records if ListingRunMetric table has no rows yet
    if not metric_rows:
        eligible_projects = (
            db.query(Project)
            .filter(Project.image_count >= MIN_PHOTOS_FOR_TARGET_DENOMINATOR)
            .order_by(Project.id.desc())
            .limit(window)
            .all()
        )
        total_eligible = len(eligible_projects)
        if total_eligible == 0:
            return {
                "target": ">=75%",
                "window": window,
                "total_eligible_listings_8plus": 0,
                "acceptable_count": 0,
                "pass_rate_percentage": 100.0,
                "target_met": True,
                "message": "No 8+ photo listings processed yet. Baseline target set to 100%.",
            }

        acceptable_count = sum(
            1 for p in eligible_projects 
            if p.status == "completed" and p.scene and p.scene.quality_pass is not False
        )
        pass_rate = round((acceptable_count / total_eligible) * 100.0, 2)
        return {
            "target": ">=75%",
            "window": window,
            "total_eligible_listings_8plus": total_eligible,
            "acceptable_count": acceptable_count,
            "pass_rate_percentage": pass_rate,
            "target_met": pass_rate >= TARGET_PASS_RATE_PERCENT,
            "message": f"Rolling pass rate (last {total_eligible}): {pass_rate}% (Target >= {TARGET_PASS_RATE_PERCENT}%)",
        }

    total_eligible = len(metric_rows)
    acceptable_count = sum(1 for m in metric_rows if m.is_acceptable)
    pass_rate = round((acceptable_count / total_eligible) * 100.0, 2)
    target_met = pass_rate >= TARGET_PASS_RATE_PERCENT

    return {
        "target": ">=75%",
        "window": window,
        "total_eligible_listings_8plus": total_eligible,
        "acceptable_count": acceptable_count,
        "pass_rate_percentage": pass_rate,
        "target_met": target_met,
        "message": f"Rolling pass rate (last {total_eligible}): {pass_rate}% (Target >= {TARGET_PASS_RATE_PERCENT}%)",
    }
