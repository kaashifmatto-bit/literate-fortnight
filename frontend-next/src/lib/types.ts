/**
 * ArticulAIT — TypeScript Interfaces
 */

export type OutputStatus = "completed" | "fallback_2.5d" | "failed";

export type ReasonCode =
  | "NONE"
  | "LOW_PARALLAX"
  | "INSUFFICIENT_POSE_CONFIDENCE"
  | "RECONSTRUCTION_TIMEOUT"
  | "TRAINING_DIVERGED"
  | "NO_IMAGES_FOUND"
  | "PIPELINE_EXCEPTION"
  | "INSUFFICIENT_FRAME_OVERLAP"
  | "VOCAB_TREE_MISSING"
  | "REGISTRATION_FAILURE";

export interface ProjectManifest {
  status: OutputStatus;
  reason_code: ReasonCode;
  project_id: number;
  photo_count: number;
  has_3dgs: boolean;
  has_depth_maps: boolean;
  reconstruction_mode?: string;
  session_id?: string;
  generated_at?: string;
}

export interface Project {
  id: number;
  name: string;
  status: "uploading" | "uploaded" | "processing" | "completed" | "failed";
  output_status?: OutputStatus;
  reason_code?: ReasonCode;
  failure_reason?: string;
  quality_flag?: "high_fidelity" | "passed" | "standard" | "needs_recapture" | "pending_review";
  quality_label?: string;
  quality_badge?: string;
  quality_color?: "emerald" | "blue" | "amber" | "rose";
  point_count?: number | null;
  image_count: number;
  created_at: string | null;
  updated_at: string | null;
  has_scene: boolean;
  panorama_type?: "equirectangular" | "flat" | "mixed";
}

export interface PipelineStep {
  step_number: number;
  step_name: string;
  status: "pending" | "running" | "completed" | "failed";
  progress: number;
  message: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms?: number | null;
}

export interface ProjectDetail extends Omit<Project, "has_scene"> {
  has_scene?: boolean;
  scene: SceneInfo | null;
  pipeline_steps: PipelineStep[];
  pose_source?: string;
  pose_confidence?: number;
  latitude?: number;
  longitude?: number;
  heading?: number;
}

export interface SceneBounds {
  center: { x: number; y: number; z: number };
  half_extents: { x: number; y: number; z: number };
  max_extent: number;
}

export interface SceneInfo {
  splat_path: string | null;
  ply_path: string | null;
  point_count: number | null;
  training_steps: number | null;
  training_time_seconds: number | null;
  bounds: SceneBounds | null;
}

export interface DetectedObject {
  id: number;
  label: string;
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number };
  source_image: string | null;
  model_name: string | null;
}

export interface UploadResponse {
  message: string;
  project_id: number;
  count?: number;
  files?: string[];
  status?: string;
  content_hash?: string;
  // Present when status === "cached_match": these exact photos (by SHA-256
  // fingerprint) already produced a completed project, and NO new
  // reconstruction ran - project_id above points at that old project.
  image_count?: number;
  created_at?: string | null;
  skipped_model_files?: string[];
}

export interface HealthResponse {
  status: string;
  version: string;
  gpu: {
    available: boolean;
    name: string;
    vram_gb: number;
  };
}

export interface WsPipelineMessage {
  project_id: number;
  project_status: string;
  steps: PipelineStep[];
}

// ── W1-48: Multi-room Listings ─────────────────────────────────
export interface ListingRoom {
  id: number;
  listing_id: number;
  project_id: number;
  room_label: string;
  room_order: number;
  offset_x: number;
  offset_y: number;
  offset_z: number;
  yaw_deg: number;
  // Uniform placement scale (default 1.0). Manual first-pass fix for rooms
  // that reconstruct at different real-world scales, since each room's
  // poses are normalized independently (see ListingRoom's own docstring in
  // backend/models/schema.py) - there's no shared scale between rooms
  // otherwise.
  scale: number;
}

export interface Listing {
  id: number;
  name: string;
  created_at: string | null;
  updated_at: string | null;
  rooms: ListingRoom[];
}

export interface ListingRoomSummary {
  listing_room_id: number;
  project_id: number;
  room_label: string;
  room_order: number;
  // The placement transform actually applied (offset/yaw/scale) - present
  // whenever the room's project resolved (absent on the "project_not_found"
  // error-summary shape assemble_listing_scene returns for a dangling room).
  placement?: { offset_x: number; offset_y: number; offset_z: number; yaw_deg: number; scale: number };
  passed: boolean;
  output_status: OutputStatus;
  reason_code: ReasonCode;
  // §9.1: false only when this room fell back/failed for a reason that
  // means ITS OWN photo coverage was insufficient (NO_IMAGES_FOUND,
  // INSUFFICIENT_FRAME_OVERLAP, LOW_PARALLAX) - excluded from the
  // listing's pass bar rather than held against it. True for a passed
  // room, and true for any other fallback/failure reason.
  reconstructable: boolean;
  point_count: number | null;
  waypoint_count: number;
  index_offset: number;
  pose_source?: string;
  // Real 3DGS composite assets (W1-48's actual acceptance bar) - present
  // only when this room's project has a trained splat file on disk.
  // IMPORTANT: a fallback_2.5d room can still have a splat_url (the crude
  // dense-cloud fallback conversion writes one too) - check `passed`/
  // `output_status` above, not just whether this is set, before treating a
  // room as a genuine splat.
  splat_url?: string | null;
  splat_lod_urls?: { low?: string; medium?: string; high?: string } | null;
}

export interface ListingCameraPathWaypoint {
  frame: number;
  time_sec: number;
  t: number;
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  cumulative_distance: number;
}

export interface ListingCameraPath {
  status: "success" | "insufficient_control_points";
  path_type: string;
  duration_seconds?: number;
  sample_rate_fps?: number;
  total_waypoints?: number;
  control_point_count?: number;
  num_rooms?: number;
  waypoints: ListingCameraPathWaypoint[];
}

export interface ListingScene {
  listing_id: number;
  name: string;
  total: number;
  rooms: ListingRoomSummary[];
  rooms_total: number;
  rooms_passed: number;
  // Rooms that count toward this listing's pass bar (excludes rooms
  // excluded per §9.1 for insufficient input - see ListingRoomSummary.reconstructable).
  rooms_reconstructable_total: number;
  rooms_excluded_insufficient_input: number;
  pass_rate: number;
  // Corrected 2026-08-26 against M2 Alignment §9.1: true only when EVERY
  // reconstructable room in this listing is a genuine splat (equal to
  // is_full_3dgs_pass). The SOW §3.3 ">=75%" figure is a portfolio-wide
  // target measured across listings, not a per-listing partial-credit
  // threshold - so this is NOT "pass_rate >= 0.75".
  meets_pass_target: boolean;
  is_full_3dgs_pass: boolean;
  // Threads through every room's placement-transformed poses as ONE
  // continuous spline (§9.1: "the scripted Bezier camera path... play
  // across rooms") - see backend/services/listing_assembly_service.py's
  // build_listing_camera_path.
  camera_path?: ListingCameraPath;
  // Present only on the response from POST /api/listings/{id}/auto-generate
  // (it returns the same assembled scene shape, with these fields added on top).
  generated?: number;
  raw_detections_total?: number;
  message?: string;
}

// ── Floor Plan ──────────────────────────────────────────────
// See backend/services/floorplan_service.py for how this is derived and
// why `unit` is "canonical" rather than meters/feet — this reconstruction
// pipeline has no real-world scale calibration, so wall/room dimensions
// are geometrically correct proportions, not verified measurements.
export interface FloorPlanPoint {
  u: number;
  v: number;
}

export interface FloorPlanWallSegment {
  start: FloorPlanPoint;
  end: FloorPlanPoint;
  length: number;
  thickness: number;
}

export interface FloorPlanRoom {
  id: number;
  polygon: FloorPlanPoint[];
  area: number;
  perimeter: number;
  centroid: FloorPlanPoint;
}

export interface FloorPlanBounds {
  min_u: number;
  min_v: number;
  max_u: number;
  max_v: number;
}

export interface FloorPlanSuccess {
  status: "success";
  project_id: number;
  unit: string;
  scale_note?: string;
  wall_segments: FloorPlanWallSegment[];
  rooms: FloorPlanRoom[];
  bounds: FloorPlanBounds;
  floor_height: number | null;
  ceiling_height: number | null;
  generated_at: string | null;
}

export interface FloorPlanInsufficientData {
  status: "insufficient_data";
  project_id: number;
  reason: string | null;
  detail?: string;
  generated_at: string | null;
}

export type FloorPlanResult = FloorPlanSuccess | FloorPlanInsufficientData;
