/**
 * ArticulAIT — Typed API Client
 */
import type {
  Project,
  ProjectDetail,
  UploadResponse,
  HealthResponse,
  DetectedObject,
  Listing,
  ListingRoom,
  ListingScene,
  FloorPlanResult,
} from "./types";

export const getApiBase = () => {
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  if (typeof window !== "undefined") {
    // On Windows, 'localhost' resolves to IPv6 ::1 first, which fails if Uvicorn is bound to IPv4 0.0.0.0.
    // Mapping 'localhost' to '127.0.0.1' ensures reliable IPv4 connectivity.
    const host = window.location.hostname === "localhost" ? "127.0.0.1" : window.location.hostname;
    return `http://${host}:8000`;
  }
  return "http://127.0.0.1:8000";
};

export const API_BASE = typeof window !== "undefined" ? getApiBase() : (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000");

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Disable aggressive Next.js App Router caching for backend API calls
  const finalInit = { cache: 'no-store' as RequestCache, ...init };
  const primaryBase = getApiBase();
  try {
    const res = await fetch(`${primaryBase}${path}`, finalInit);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `API Error ${res.status}`);
    }
    return res.json();
  } catch (primaryErr: any) {
    // If backend is mid-reload (e.g. uvicorn auto-reloading), wait 600ms and retry once
    await new Promise((r) => setTimeout(r, 600));
    try {
      const retryRes = await fetch(`${primaryBase}${path}`, finalInit);
      if (retryRes.ok) return retryRes.json();
    } catch {}

    // Retrying with alternative host format (localhost <-> 127.0.0.1) on network failure
    const altBase = primaryBase.includes("localhost")
      ? primaryBase.replace("localhost", "127.0.0.1")
      : primaryBase.includes("127.0.0.1")
      ? primaryBase.replace("127.0.0.1", "localhost")
      : "http://127.0.0.1:8000";
    try {
      const fallbackRes = await fetch(`${altBase}${path}`, finalInit);
      if (!fallbackRes.ok) {
        const err = await fallbackRes.json().catch(() => ({ detail: fallbackRes.statusText }));
        throw new Error(err.detail || `API Error ${fallbackRes.status}`);
      }
      return fallbackRes.json();
    } catch (fallbackErr: any) {
      throw (fallbackErr && fallbackErr.message && fallbackErr.message !== "Failed to fetch") ? fallbackErr : primaryErr;
    }
  }
}

// ── Upload ──────────────────────────────────────────────────
export async function uploadImages(
  files: File[],
  onProgress?: (percent: number, loadedBytes: number, totalBytes: number) => void,
  force: boolean = false
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((f) => formData.append("files", f));
    // force=true bypasses the backend's SHA-256 content-fingerprint cache,
    // which otherwise silently reuses an old completed project (no new
    // reconstruction at all) whenever this exact photo set was uploaded
    // before - see uploadRes.status === "cached_match" handling in
    // page.tsx, which now surfaces this instead of redirecting silently.
    if (force) formData.append("force", "true");

    const xhr = new XMLHttpRequest();
    const primaryBase = getApiBase();
    xhr.open("POST", `${primaryBase}/api/upload`);

    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          onProgress(pct, e.loaded, e.total);
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data as UploadResponse);
        } catch (err) {
          reject(new Error("Invalid JSON response from upload server"));
        }
      } else {
        try {
          const err = JSON.parse(xhr.responseText);
          let errMsg = err.detail;
          if (typeof errMsg === "object" && errMsg !== null) {
            errMsg = errMsg.message || JSON.stringify(errMsg);
          }
          reject(new Error(errMsg || `Upload failed with status ${xhr.status}`));
        } catch {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      }
    };

    xhr.onerror = () => {
      reject(new Error("Network error during image upload. Make sure the backend server is running."));
    };

    xhr.send(formData);
  });
}

// ── 3D Asset Versions (Row 89: "3D asset management — stored, versioned,
// retrievable") ────────────────────────────────────────────────────────
export interface AssetVersion {
  id: number;
  version_number: number;
  format: string;
  original_filename: string | null;
  size_bytes: number | null;
  is_current: boolean;
  created_at: string | null;
  // Which component renders this format: "gsplat" (SplatViewer, via
  // scene.splat) for splat/ply/lcc, or "mesh" (MeshAssetLoader ->
  // MeshCheckViewer, via scene_mesh.glb|obj) for glb/obj. Both are real,
  // working viewers - the viewer pages switch between them based on this.
  viewer: "gsplat" | "mesh";
}

// All 3D asset formats this app can store a version of AND actually render
// somewhere: splat/ply/lcc via SplatViewer's Gaussian Splat renderer,
// glb/obj via MeshAssetLoader's mesh renderer. Kept in one place so the
// version-upload picker and the "Open 3D File" flow agree on what's valid.
export const SUPPORTED_ASSET_FORMATS = ["splat", "ply", "lcc", "glb", "obj"] as const;

export async function listAssetVersions(projectId: number): Promise<{
  project_id: number;
  versions: AssetVersion[];
}> {
  return apiFetch(`/api/projects/${projectId}/versions`);
}

export async function restoreAssetVersion(
  projectId: number,
  versionId: number
): Promise<{ status: string; project_id: number; version_id: number; version_number: number; viewer: "gsplat" | "mesh" }> {
  return apiFetch(`/api/projects/${projectId}/versions/${versionId}/restore`, { method: "POST" });
}

// Uploads a new 3D file INTO an existing project - archived as the next
// version of that project's asset (see backend/routes/upload.py's
// _record_asset_version) rather than creating an unrelated new project, the
// way picking a brand-new file via "Open 3D File" does.
export async function uploadNewAssetVersion(
  projectId: number,
  file: File
): Promise<{ status: string; project_id: number; version_number: number; version_id: number }> {
  const ext = (file.name.split(".").pop() || "splat").toLowerCase();
  if (!(SUPPORTED_ASSET_FORMATS as readonly string[]).includes(ext)) {
    throw new Error(
      `"${file.name}" is a .${ext} file - supported formats are .splat, .ply, .lcc, .glb, or .obj.`
    );
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("file_format", ext);
  formData.append("project_id", String(projectId));

  return apiFetch(`/api/upload/scene`, {
    method: "POST",
    body: formData,
  });
}

export async function uploadSplatFile(file: File): Promise<{
  status: string;
  project_id: number;
  scene_id: string;
  splat_url: string;
  ply_url: string;
  filename: string;
  size: number;
}> {
  // Was previously always POSTed to /api/upload/splat, which force-tags
  // EVERY file as ".splat" server-side regardless of what was actually
  // selected - a .ply upload here got its raw PLY bytes written straight
  // into scene.splat with no PLY->splat conversion, and scene_clean.ply was
  // never created at all (the viewer only worked because of app.py's
  // missing-asset fallback route papering over it). Surfaced by the new
  // asset-versions panel showing "SPLAT" as the format for an uploaded
  // .ply file. Detecting the real extension and routing through
  // /api/upload/scene (which respects file_format) fixes both the mislabel
  // and the missing real PLY handling.
  const ext = (file.name.split(".").pop() || "splat").toLowerCase();
  const knownFormats = ["splat", "ply", "lcc", "glb", "obj"];
  const fileFormat = knownFormats.includes(ext) ? ext : "splat";

  const formData = new FormData();
  formData.append("file", file);
  formData.append("file_format", fileFormat);
  return apiFetch("/api/upload/scene", {
    method: "POST",
    body: formData,
  });
}

// ── Projects ────────────────────────────────────────────────
export async function listProjects(includeSplats = false): Promise<{ projects: Project[] }> {
  return apiFetch(`/api/projects?include_splats=${includeSplats}`);
}

export async function getProject(id: number): Promise<ProjectDetail> {
  return apiFetch(`/api/projects/${id}`);
}

export async function deleteProject(id: number): Promise<{ message: string }> {
  return apiFetch(`/api/projects/${id}`, { method: "DELETE" });
}

export async function getDetectedObjects(
  id: number
): Promise<{ project_id: number; objects: DetectedObject[] }> {
  return apiFetch(`/api/projects/${id}/objects`);
}

export async function saveRenderedFrame(
  projectId: number,
  filename: string,
  imageBase64: string
): Promise<{ status: string; filename: string; project_id: number; bytes: number }> {
  return apiFetch(`/api/projects/${projectId}/frames`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, image_base64: imageBase64 }),
  });
}

export async function getFramesStatus(projectId: number): Promise<{
  project_id: number;
  expected_total: number;
  captured: number;
  missing: string[];
  complete: boolean;
}> {
  return apiFetch(`/api/projects/${projectId}/frames/status`);
}

// Ensures poses.json/cameras.json actually has real poses before a capture
// pass tries to fly the camera to them - regenerates them on the backend if
// they came back empty (see prepare_frame_capture's docstring for why that
// can happen even for a project that went through reality_capture_bypass).
export async function prepareFrameCapture(projectId: number): Promise<{
  project_id: number;
  regenerated: boolean;
  message?: string;
  pose_count?: number;
}> {
  return apiFetch(`/api/projects/${projectId}/frames/prepare`, { method: "POST" });
}

// ── Pipeline ────────────────────────────────────────────────
export async function startPipeline(
  projectId?: number,
  force: boolean = false
): Promise<{
  status: string;
  project_id: number;
  message: string;
}> {
  const query = new URLSearchParams();
  if (projectId) query.append("project_id", projectId.toString());
  if (force) query.append("force", "true");
  const path = `/api/walkthrough/generate${query.toString() ? `?${query.toString()}` : ""}`;
  return apiFetch(path, { method: "POST" });
}

export async function getPipelineStatus(): Promise<{
  step: number;
  message: string;
}> {
  return apiFetch("/api/walkthrough/status");
}

// ── Health ──────────────────────────────────────────────────
export async function getHealth(): Promise<HealthResponse> {
  return apiFetch("/api/health");
}

// ── W1-48: Multi-room Listings ─────────────────────────────────
export async function listListings(): Promise<{ listings: Listing[] }> {
  return apiFetch(`/api/listings`);
}

export async function createListing(name: string): Promise<Listing> {
  return apiFetch(`/api/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function deleteListing(listingId: number): Promise<{ message: string }> {
  return apiFetch(`/api/listings/${listingId}`, { method: "DELETE" });
}

export async function addListingRoom(
  listingId: number,
  payload: { project_id: number; room_label: string; room_order: number; offset_x?: number; offset_y?: number; offset_z?: number; yaw_deg?: number; scale?: number }
): Promise<ListingRoom> {
  return apiFetch(`/api/listings/${listingId}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateListingRoomPlacement(
  listingId: number,
  projectId: number,
  payload: { offset_x?: number; offset_y?: number; offset_z?: number; yaw_deg?: number; scale?: number; room_label?: string; room_order?: number }
): Promise<ListingRoom> {
  return apiFetch(`/api/listings/${listingId}/rooms/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function removeListingRoom(listingId: number, projectId: number): Promise<{ message: string }> {
  return apiFetch(`/api/listings/${listingId}/rooms/${projectId}`, { method: "DELETE" });
}

// Fetches the assembled scene mainly for its rooms[]/pass_rate diagnostics
// (used by ListingsPanel to show pass/fail per room without opening the
// full 3D viewer) - the viewer itself fetches this same endpoint again for
// the actual waypoints/camera path.
export async function getListingScene(listingId: number): Promise<ListingScene> {
  return apiFetch(`/api/listings/${listingId}/scene`);
}

// Runs YOLO object detection across EVERY room/project in a listing and
// persists hotspots for each, then returns the freshly assembled scene
// (backend/routes/listings.py's POST /auto-generate - the endpoint already
// existed server-side but had no caller anywhere in the frontend before
// this, so it was unreachable from the browser). Deliberately no request
// body: min_confidence/max_per_waypoint/force_refresh are plain FastAPI
// query params on that endpoint, not a Pydantic body model.
export async function autoGenerateListingObjects(
  listingId: number,
  opts: { minConfidence?: number; maxPerWaypoint?: number; forceRefresh?: boolean } = {}
): Promise<ListingScene> {
  const query = new URLSearchParams();
  if (opts.minConfidence !== undefined) query.append("min_confidence", String(opts.minConfidence));
  if (opts.maxPerWaypoint !== undefined) query.append("max_per_waypoint", String(opts.maxPerWaypoint));
  if (opts.forceRefresh) query.append("force_refresh", "true");
  const qs = query.toString();
  return apiFetch(`/api/listings/${listingId}/auto-generate${qs ? `?${qs}` : ""}`, { method: "POST" });
}

// ── WebSocket ───────────────────────────────────────────────
export function connectPipelineWs(
  projectId: number,
  onMessage: (data: unknown) => void,
  onClose?: () => void
): WebSocket {
  const wsUrl = `${getApiBase().replace("http", "ws")}/api/ws/pipeline/${projectId}`;
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (event) => onMessage(JSON.parse(event.data));
  ws.onclose = () => onClose?.();
  return ws;
}

// ── Floor Plan ──────────────────────────────────────────────
export async function generateFloorplan(projectId: number): Promise<FloorPlanResult> {
  return apiFetch(`/api/projects/${projectId}/floorplan/generate`, { method: "POST" });
}

export async function getFloorplan(projectId: number): Promise<FloorPlanResult> {
  return apiFetch(`/api/projects/${projectId}/floorplan`);
}
