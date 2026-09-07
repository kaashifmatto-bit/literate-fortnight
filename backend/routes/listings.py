"""
ArticulAIT — Listings Route (W1-48, SOW §9.1 / §3.3)

CRUD for Listings (a real-estate listing = a set of rooms, each an
existing, independently-reconstructed Project) and room placement, plus
the assembled multi-room scene endpoint the frontend viewer consumes.

See backend/services/listing_assembly_service.py for the actual assembly
logic and the grounding for why placement is an explicit stored transform
rather than an automatic cross-room registration.
"""
# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from typing import Optional

from backend.core.database import get_db
from backend.models.schema import Listing, ListingRoom, Project

router = APIRouter()


class ListingCreate(BaseModel):
    name: str = Field("Untitled Listing", description="Human-readable listing name")


class ListingRoomCreate(BaseModel):
    project_id: int = Field(..., description="Existing Project id to bind as a room of this listing")
    room_label: str = Field("Room", description="Display label, e.g. 'Kitchen'")
    room_order: int = Field(0, description="Default traversal order")
    offset_x: float = Field(0.0, description="Placement offset X in the shared listing frame")
    offset_y: float = Field(0.0, description="Placement offset Y in the shared listing frame")
    offset_z: float = Field(0.0, description="Placement offset Z in the shared listing frame")
    yaw_deg: float = Field(0.0, description="Placement yaw rotation (degrees, about world Y) applied before the offset")
    scale: float = Field(1.0, description="Uniform placement scale, applied before rotation/offset. Manual fix for rooms that reconstruct at different real-world scales since each room's poses are normalized independently.")


class ListingRoomUpdate(BaseModel):
    room_label: Optional[str] = None
    room_order: Optional[int] = None
    offset_x: Optional[float] = None
    offset_y: Optional[float] = None
    offset_z: Optional[float] = None
    yaw_deg: Optional[float] = None
    scale: Optional[float] = None


def _room_to_dict(room: ListingRoom) -> dict:
    return {
        "id": room.id,
        "listing_id": room.listing_id,
        "project_id": room.project_id,
        "room_label": room.room_label,
        "room_order": room.room_order,
        "offset_x": room.offset_x,
        "offset_y": room.offset_y,
        "offset_z": room.offset_z,
        "yaw_deg": room.yaw_deg,
        "scale": room.scale if room.scale is not None else 1.0,
    }


def _listing_to_dict(listing: Listing) -> dict:
    return {
        "id": listing.id,
        "name": listing.name,
        "created_at": listing.created_at.isoformat() if listing.created_at else None,
        "updated_at": listing.updated_at.isoformat() if listing.updated_at else None,
        "rooms": [_room_to_dict(r) for r in sorted(listing.rooms, key=lambda r: (r.room_order, r.id))],
    }


@router.post("/listings")
async def create_listing(payload: ListingCreate, db: Session = Depends(get_db)):
    listing = Listing(name=payload.name)
    db.add(listing)
    db.commit()
    db.refresh(listing)
    return _listing_to_dict(listing)


@router.get("/listings")
async def list_listings(db: Session = Depends(get_db)):
    listings = db.query(Listing).order_by(Listing.id).all()
    return {"listings": [_listing_to_dict(l) for l in listings]}


@router.get("/listings/{listing_id}")
async def get_listing(listing_id: int, db: Session = Depends(get_db)):
    listing = db.query(Listing).filter(Listing.id == listing_id).first()
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    return _listing_to_dict(listing)


@router.delete("/listings/{listing_id}")
async def delete_listing(listing_id: int, db: Session = Depends(get_db)):
    listing = db.query(Listing).filter(Listing.id == listing_id).first()
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    db.delete(listing)  # cascade="all, delete-orphan" on Listing.rooms removes member ListingRoom rows
    db.commit()
    return {"message": f"Listing {listing_id} deleted"}


@router.post("/listings/{listing_id}/rooms")
async def add_room(listing_id: int, payload: ListingRoomCreate, db: Session = Depends(get_db)):
    listing = db.query(Listing).filter(Listing.id == listing_id).first()
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")

    project = db.query(Project).filter(Project.id == payload.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail=f"Project {payload.project_id} not found")

    existing = db.query(ListingRoom).filter(ListingRoom.project_id == payload.project_id).first()
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Project {payload.project_id} is already a room of listing {existing.listing_id} "
                   f"(a room belongs to at most one listing; remove it from that listing first)",
        )

    existing_count = db.query(ListingRoom).filter(ListingRoom.listing_id == listing_id).count()
    order_to_use = payload.room_order if (payload.room_order != 0 or existing_count == 0) else existing_count

    room = ListingRoom(
        listing_id=listing_id,
        project_id=payload.project_id,
        room_label=payload.room_label,
        room_order=order_to_use,
        offset_x=payload.offset_x,
        offset_y=payload.offset_y,
        offset_z=payload.offset_z,
        yaw_deg=payload.yaw_deg,
        scale=payload.scale,
    )
    db.add(room)
    db.commit()
    db.refresh(room)
    return _room_to_dict(room)


@router.patch("/listings/{listing_id}/rooms/{project_id}")
async def update_room_placement(listing_id: int, project_id: int, payload: ListingRoomUpdate, db: Session = Depends(get_db)):
    room = db.query(ListingRoom).filter(ListingRoom.listing_id == listing_id, ListingRoom.project_id == project_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found in this listing")

    update_data = payload.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(room, field, value)

    db.commit()
    db.refresh(room)
    return _room_to_dict(room)


@router.delete("/listings/{listing_id}/rooms/{project_id}")
async def remove_room(listing_id: int, project_id: int, db: Session = Depends(get_db)):
    room = db.query(ListingRoom).filter(ListingRoom.listing_id == listing_id, ListingRoom.project_id == project_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found in this listing")
    db.delete(room)
    db.commit()
    return {"message": f"Project {project_id} removed from listing {listing_id}"}


@router.get("/listings/{listing_id}/scene")
async def get_listing_scene(listing_id: int, db: Session = Depends(get_db)):
    """
    W1-48 DELIVERABLE: the assembled multi-room scene. Shaped as a superset
    of the existing single-project /waypoints response so PanoWalkthrough.tsx
    can consume it with minimal changes (see backend/services/
    listing_assembly_service.py for exactly what's added on top).
    """
    from backend.services.listing_assembly_service import assemble_listing_scene

    listing = db.query(Listing).filter(Listing.id == listing_id).first()
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    if not listing.rooms:
        raise HTTPException(status_code=400, detail="Listing has no rooms yet - add rooms via POST /api/listings/{id}/rooms")

    try:
        return assemble_listing_scene(listing, db)
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Listing scene assembly failed: {exc}")


@router.post("/listings/{listing_id}/auto-generate")
async def auto_generate_listing_hotspots(
    listing_id: int,
    db: Session = Depends(get_db),
    min_confidence: float = 0.15,
    max_per_waypoint: int = 4,
    force_refresh: bool = False,
):
    """
    Runs auto object detection across all rooms/projects within a listing,
    persists hotspots for each project, and returns the assembled listing scene.
    """
    listing = db.query(Listing).filter(Listing.id == listing_id).first()
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    if not listing.rooms:
        raise HTTPException(status_code=400, detail="Listing has no rooms yet")

    total_generated = 0
    total_raw_detections = 0

    from backend.routes.projects import _load_file_hotspots, _save_file_hotspots, get_waypoints
    from backend.services.detection_service import run_detection, generate_hotspots_from_detections
    from backend.models.schema import DetectedObject
    from backend.services.listing_assembly_service import assemble_listing_scene

    for room in listing.rooms:
        pid = room.project_id
        existing_objs = db.query(DetectedObject).filter(DetectedObject.project_id == pid).all()
        if not existing_objs or force_refresh:
            if force_refresh and existing_objs:
                db.query(DetectedObject).filter(DetectedObject.project_id == pid).delete()
                db.commit()
            try:
                run_detection(project_id=pid, db=db, confidence=min_confidence)
            except Exception as e:
                print(f"[listing_auto_generate] Detection failed for project {pid}: {e}")

        raw_count = db.query(DetectedObject).filter(DetectedObject.project_id == pid).count()
        total_raw_detections += raw_count

        wp_resp = await get_waypoints(project_id=pid, force_refresh=False, db=db)
        waypoints = wp_resp.get("waypoints", [])

        auto_hotspots = generate_hotspots_from_detections(
            pid, db, waypoints,
            min_confidence=min_confidence,
            max_per_waypoint=max_per_waypoint,
        )

        file_hotspots = _load_file_hotspots(pid)
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

        _save_file_hotspots(pid, saved)
        total_generated += len(auto_hotspots)

    scene = assemble_listing_scene(listing, db)
    scene["generated"] = total_generated
    scene["raw_detections_total"] = total_raw_detections
    scene["message"] = f"Auto-detected objects across {len(listing.rooms)} room(s). Placed {total_generated} hotspot(s)."

    return scene
