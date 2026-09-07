"""
ArticulAIT — Floor Plan Route

Generate/fetch a project's 2D floor plan (wall segments + room polygons),
derived from its already-reconstructed point cloud. See
backend/services/floorplan_service.py for the algorithm and its documented
limitations (unknown up-axis estimated per-project, no real-world scale
calibration in this pipeline yet).
"""
# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import Session

from backend.core.database import get_db
from backend.models.schema import Project, FloorPlan
from backend.services.floorplan_service import generate_floorplan

router = APIRouter()


def _floorplan_to_dict(fp: FloorPlan) -> dict:
    return {
        "status": fp.status,
        "project_id": fp.project_id,
        "reason": fp.reason,
        "unit": fp.unit,
        "wall_segments": fp.wall_segments,
        "rooms": fp.rooms,
        "bounds": fp.bounds,
        "floor_height": fp.floor_height,
        "ceiling_height": fp.ceiling_height,
        "generated_at": fp.generated_at.isoformat() if fp.generated_at else None,
    }


@router.post("/projects/{project_id}/floorplan/generate")
async def generate_project_floorplan(project_id: int, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found.")

    result = generate_floorplan(project_id)

    existing = db.query(FloorPlan).filter(FloorPlan.project_id == project_id).first()
    if not existing:
        existing = FloorPlan(project_id=project_id)
        db.add(existing)

    existing.status = result["status"]
    existing.reason = result.get("reason")
    if result["status"] == "success":
        existing.unit = result.get("unit")
        existing.wall_segments = result.get("wall_segments")
        existing.rooms = result.get("rooms")
        existing.bounds = result.get("bounds")
        existing.floor_height = result.get("floor_height")
        existing.ceiling_height = result.get("ceiling_height")

    db.commit()
    db.refresh(existing)

    # Return the richer service payload (includes scale_note, up_axis, etc.)
    # on success rather than the stripped DB row, since those extra fields
    # aren't persisted columns but are useful context for the caller.
    return result if result["status"] == "success" else _floorplan_to_dict(existing)


@router.get("/projects/{project_id}/floorplan")
async def get_project_floorplan(project_id: int, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found.")

    fp = db.query(FloorPlan).filter(FloorPlan.project_id == project_id).first()
    if not fp:
        raise HTTPException(
            status_code=404,
            detail="No floor plan has been generated for this project yet. "
            "POST /api/projects/{project_id}/floorplan/generate first.",
        )

    return _floorplan_to_dict(fp)
