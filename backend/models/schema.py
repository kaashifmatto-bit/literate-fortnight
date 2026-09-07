"""
ArticulAIT — ORM Models
Defines the database schema for projects, images, scenes, detected objects,
and pipeline steps.
"""
# pyrefly: ignore [missing-import]
from sqlalchemy import Column, Integer, String, Float, DateTime, Text, ForeignKey, JSON, Boolean
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from backend.core.database import Base


from enum import Enum

class ReasonCode(str, Enum):
    NONE = "NONE"
    LOW_PARALLAX = "LOW_PARALLAX"
    INSUFFICIENT_POSE_CONFIDENCE = "INSUFFICIENT_POSE_CONFIDENCE"
    RECONSTRUCTION_TIMEOUT = "RECONSTRUCTION_TIMEOUT"
    TRAINING_DIVERGED = "TRAINING_DIVERGED"
    TRAINING_CRASHED_OOM = "TRAINING_CRASHED_OOM"
    NO_IMAGES_FOUND = "NO_IMAGES_FOUND"
    PIPELINE_EXCEPTION = "PIPELINE_EXCEPTION"
    INSUFFICIENT_FRAME_OVERLAP = "INSUFFICIENT_FRAME_OVERLAP"
    VOCAB_TREE_MISSING = "VOCAB_TREE_MISSING"
    REGISTRATION_FAILURE = "REGISTRATION_FAILURE"


class Project(Base):
    """A reconstruction project (one per upload batch)."""
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), default="Untitled Project")
    status = Column(String(50), default="uploading")  # uploading | processing | completed | failed
    output_status = Column(String(50), default="completed")  # completed | fallback_2.5d | failed (§6.5)
    reason_code = Column(String(100), default=ReasonCode.NONE.value)  # ReasonCode enum (§6.5)
    failure_reason = Column(String(255), nullable=True)  # e.g., insufficient_features, depth_estimation_failed
    quality_flag = Column(String(50), default="pending_review")  # pending_review | passed | failed
    needs_privacy_review = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))
    image_count = Column(Integer, default=0)
    pose_source = Column(String(50), nullable=True, default="vggt")  # vggt | colmap
    pose_confidence = Column(Float, nullable=True, default=1.0)
    content_hash = Column(String(64), nullable=True, index=True)  # SHA-256 fingerprint (§7.1/§7.2)
    panorama_type = Column(String(50), default="flat")  # "equirectangular" | "flat" | "mixed"
    
    # Street View Integration Metadata
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    heading = Column(Float, nullable=True)


    # Relationships
    images = relationship("ProjectImage", back_populates="project", cascade="all, delete-orphan")
    scene = relationship("Scene", back_populates="project", uselist=False, cascade="all, delete-orphan")
    pipeline_steps = relationship("PipelineStep", back_populates="project", cascade="all, delete-orphan")
    detected_objects = relationship("DetectedObject", back_populates="project", cascade="all, delete-orphan")


class ProjectImage(Base):
    """An uploaded image belonging to a project."""
    __tablename__ = "project_images"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    filename = Column(String(500), nullable=False)
    filepath = Column(String(1000), nullable=False)
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    file_size = Column(Integer, nullable=True)
    content_hash = Column(String(64), nullable=True, index=True)  # SHA-256 image fingerprint
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    
    # Relationship
    project = relationship("Project", back_populates="images")


class Scene(Base):
    """A generated 3D scene from a project."""
    __tablename__ = "scenes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, unique=True)
    splat_path = Column(String(1000), nullable=True)
    ply_path = Column(String(1000), nullable=True)
    point_count = Column(Integer, nullable=True)
    bounds_min = Column(JSON, nullable=True)  # [x, y, z]
    bounds_max = Column(JSON, nullable=True)  # [x, y, z]
    training_steps = Column(Integer, nullable=True)
    training_time_seconds = Column(Float, nullable=True)
    psnr = Column(Float, nullable=True)
    ssim = Column(Float, nullable=True)
    lpips = Column(Float, nullable=True)
    quality_pass = Column(Boolean, default=True)  # §3.3 Launch target tracking (>=75% pass rate)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    # Relationship
    project = relationship("Project", back_populates="scene")


class PipelineStep(Base):
    """Tracks each step of the reconstruction pipeline for real-time UI."""
    __tablename__ = "pipeline_steps"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    step_number = Column(Integer, nullable=False)  # 1, 2, 3, 4, 5...
    step_name = Column(String(255), nullable=False)
    status = Column(String(50), default="pending")  # pending | running | completed | failed
    progress = Column(Float, default=0.0)  # 0.0 to 100.0
    message = Column(Text, nullable=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    duration_ms = Column(Integer, nullable=True)

    # Relationship
    project = relationship("Project", back_populates="pipeline_steps")


class DetectedObject(Base):
    """An object detected in the scene by RF-DETR or other models."""
    __tablename__ = "detected_objects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    label = Column(String(255), nullable=False)
    confidence = Column(Float, nullable=False)
    bbox_x = Column(Float, nullable=True)  # Normalized bounding box
    bbox_y = Column(Float, nullable=True)
    bbox_w = Column(Float, nullable=True)
    bbox_h = Column(Float, nullable=True)
    source_image = Column(String(500), nullable=True)
    model_name = Column(String(100), nullable=True)  # e.g., "rf-detr-l"
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    # Relationship
    project = relationship("Project", back_populates="detected_objects")


class Waypoint(Base):
    """A pre-calculated navigation point representing a camera pose."""
    __tablename__ = "waypoints"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    filename = Column(String(500), nullable=False)
    position_x = Column(Float, nullable=True)
    position_y = Column(Float, nullable=True)
    position_z = Column(Float, nullable=True)
    target_x = Column(Float, nullable=True)
    target_y = Column(Float, nullable=True)
    target_z = Column(Float, nullable=True)

    # Relationship
    hotspots = relationship("Hotspot", back_populates="waypoint", cascade="all, delete-orphan")


class Hotspot(Base):
    """An interactive info or navigation marker attached to a specific waypoint."""
    __tablename__ = "hotspots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    waypoint_id = Column(Integer, ForeignKey("waypoints.id", ondelete="CASCADE"), nullable=True)  # nullable: hotspot may reference a file-cache waypoint with no DB row
    waypoint_index = Column(Integer, nullable=True)  # 0-based index from the waypoints API when no DB waypoint row exists
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    yaw = Column(Float)           # degrees, -180 to 180
    pitch = Column(Float)         # degrees, -90 to 90
    title = Column(String(255))
    description = Column(Text)
    icon_type = Column(String(50), default="info")  # "info" | "room" | "feature"

    # Relationship
    waypoint = relationship("Waypoint", back_populates="hotspots")


class AssetVersion(Base):
    """
    Version history for a project's uploaded 3D scene asset (Row 89: "3D
    asset management — stored, versioned, retrievable").

    Every 3D file upload for a project — the first one and every later
    re-upload targeting the same project — writes one row here holding an
    immutable copy of exactly what was uploaded, in addition to updating the
    project's "live" scene files (scene.splat / scene_clean.ply / etc, which
    the viewer and pipeline always read from). Nothing is ever silently
    overwritten: the live files are just whichever version is currently
    marked is_current, and any prior version stays retrievable/restorable
    from its archived copy under project_{id}/versions/.

    Deliberately scoped to just the uploaded source file (see the
    versions/restore endpoints in routes/projects.py) — LOD tiers and
    poses/cameras are regenerated fresh for whichever version is made
    current rather than being versioned themselves, since they're cheap to
    regenerate and would otherwise double the storage per version.
    """
    __tablename__ = "asset_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    version_number = Column(Integer, nullable=False)  # 1, 2, 3... per project, oldest first
    format = Column(String(20), nullable=False)  # splat | ply | lcc | glb | obj
    original_filename = Column(String(500), nullable=True)
    stored_filename = Column(String(500), nullable=False)  # relative to project_{id}/versions/
    size_bytes = Column(Integer, nullable=True)
    is_current = Column(Boolean, default=False)  # exactly one True per project at a time
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    # Relationship
    project = relationship("Project")


class Listing(Base):
    """
    W1-48 (§9.1) — Groups multiple independently-reconstructed rooms
    (Projects) into ONE navigable multi-room scene.

    A real-estate "listing" is captured room-by-room: each room is its own
    photo/video upload and gets its own independent Project row, its own
    ReconstructionService run, and — critically — its own canonical world
    frame (pose_router.normalize_poses_canonical centers/scales each room's
    poses around ITS OWN median, independent of every other room's frame;
    see backend/reconstruction/pose_router.py). There is no shared
    real-world coordinate system between two rooms' reconstructions unless
    one is explicitly established. A Listing is that explicit binding: it
    is a plain container; the real per-room join lives on ListingRoom.

    This table is distinct from the pre-existing loose integer
    `ListingRunMetric.listing_id` below (an unrelated §3.3 metrics log that
    doesn't reference this table) — left untouched to avoid disturbing
    existing metric collection.
    """
    __tablename__ = "listings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), default="Untitled Listing")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))

    rooms = relationship(
        "ListingRoom",
        back_populates="listing",
        cascade="all, delete-orphan",
        order_by="ListingRoom.room_order",
    )


class ListingRoom(Base):
    """
    One member room of a Listing (§9.1). Binds an existing Project (one
    room's own reconstruction) into the listing's shared frame via an
    explicit placement transform:

        world_pos = R_y(yaw_deg) @ room_local_pos + (offset_x, offset_y, offset_z)

    applied on top of that room's own canonical-frame poses. There is no
    automatic cross-room SfM/registration in this codebase (rooms are
    captured as separate, non-overlapping photo sets, so there are no
    shared features to align on) — placement is deliberately an explicit,
    human/tool-authored offset, the same way Matterport's own "dollhouse"
    editor lets a human nudge room placement rather than trusting a fully
    automatic merge. Defaults to the origin / no rotation, i.e. every room
    stacks at (0,0,0) until placed — callers must set real placement
    before the assembled scene is spatially meaningful.
    """
    __tablename__ = "listing_rooms"

    id = Column(Integer, primary_key=True, autoincrement=True)
    listing_id = Column(Integer, ForeignKey("listings.id", ondelete="CASCADE"), nullable=False)
    # A room (Project) belongs to at most one listing.
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, unique=True)
    room_label = Column(String(255), default="Room")
    room_order = Column(Integer, default=0)  # display / default traversal order

    offset_x = Column(Float, default=0.0)
    offset_y = Column(Float, default=0.0)
    offset_z = Column(Float, default=0.0)
    yaw_deg = Column(Float, default=0.0)
    # Uniform per-room scale multiplier, applied before rotation/offset (§9.1
    # real 3DGS composite work). Each room's poses are normalized INDEPENDENTLY
    # into its own canonical frame (pose_router.normalize_poses_canonical), so
    # there is no shared real-world scale between two rooms - placing them
    # side by side with only offset/yaw can leave one room looking mismatched
    # in size next to another. This is a manual first-pass fix (the same
    # human-authored-placement tradeoff as offset_x/yaw_deg above) rather than
    # a deeper change to pose normalization itself.
    scale = Column(Float, default=1.0)

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))

    listing = relationship("Listing", back_populates="rooms")
    project = relationship("Project")


class ListingRunMetric(Base):
    """
    Persists production launch target metrics per listing run (§3.3 & §6.1).
    Tracks whether 8+-photo listings produce acceptable 3DGS walkthroughs.
    """
    __tablename__ = "listing_run_metrics"

    id = Column(Integer, primary_key=True, autoincrement=True)
    listing_id = Column(Integer, index=True, nullable=False)
    session_id = Column(String(100), index=True, nullable=True)
    photo_count = Column(Integer, nullable=False)
    status = Column(String(50), nullable=False)  # completed | failed | diverted
    duration_per_stage = Column(JSON, nullable=True)  # {"step_1": 1500, "step_2": 8200, ...}
    total_duration_seconds = Column(Float, nullable=True)
    measured_fps_desktop = Column(Float, nullable=True)
    measured_fps_mobile = Column(Float, nullable=True)
    quality_pass = Column(Boolean, default=True)
    psnr = Column(Float, nullable=True)
    is_acceptable = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class FloorPlan(Base):
    """A generated 2D floor plan (wall segments + room polygons) derived
    from a project's reconstructed point cloud. See
    backend/services/floorplan_service.py for how this is computed."""
    __tablename__ = "floor_plans"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, unique=True)
    status = Column(String(50), nullable=False)  # success | insufficient_data
    reason = Column(String(100), nullable=True)  # set when status == insufficient_data
    unit = Column(String(20), nullable=True, default="canonical")
    wall_segments = Column(JSON, nullable=True)  # [{start:{u,v}, end:{u,v}, length, thickness}, ...]
    rooms = Column(JSON, nullable=True)  # [{id, polygon:[{u,v},...], area, perimeter, centroid}, ...]
    bounds = Column(JSON, nullable=True)  # {min_u, min_v, max_u, max_v}
    floor_height = Column(Float, nullable=True)
    ceiling_height = Column(Float, nullable=True)
    generated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

