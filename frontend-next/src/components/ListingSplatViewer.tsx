"use client";

// W1-48 — the REAL Gate E deliverable, not the photo-tour walkthrough.
//
// PanoWalkthrough.tsx (via /listing/[listingId]/page.tsx) merges every
// room's WAYPOINT GRAPH (photo-panorama poses) into one navigable scene.
// That's useful and already verified working, but it is explicitly NOT
// what W1-48's own "DONE WHEN" bar describes: "each reconstructable room is
// a genuine splat (no per-room 2.5D fallback inside the listing)", building
// on "W1-27 splat renders in PlayCanvas/SuperSplat". This component is that
// real deliverable: it loads every room's own trained 3D Gaussian Splat
// (.splat, from GET /api/listings/{id}/scene's per-room splat_url) into ONE
// shared PlayCanvas scene, each placed at that room's stored offset/yaw/
// scale transform, and can play the same multi-room Bezier/Catmull-Rom
// camera path the assembled scene already computes server-side.
//
// Reuses SplatViewer.tsx's PLY/splat binary handling (isPlyBuffer,
// splatToPly, downsamplePlyBinary, sanitizePlyBuffer, MAX_CLIENT_SPLATS)
// rather than a second, divergent copy of that ~200-line binary parser -
// see SplatViewer.tsx's own export comments.
//
// Composition approach: for each room, a PARENT "room container" Entity
// gets the room's listing-frame placement (offset_x/y/z position, yaw_deg
// as a Y-axis rotation, scale as uniform localScale) - this is the exact
// same right-handed rotate-about-Y math backend/services/
// listing_assembly_service.py's _rotate_xz uses for every waypoint
// position, so the splat entities land in the SAME shared frame the merged
// camera path already assumes. The actual splat Entity is a CHILD of that
// container with its own untouched 180°-X-axis local flip (the existing
// COLMAP/gsplat Y-down -> PlayCanvas Y-up correction SplatViewer.tsx
// already applies for a single room) - rigid-body composition, so this
// component doesn't need to know or touch that inner convention at all.
//
// KNOWN LIMITATION (documented, not hidden): total splat count across all
// rooms is divided evenly by room count before per-room downsampling, as a
// first-pass perf mitigation. This has NOT been profiled against the real
// §3.3 budget (~5s load, >=30fps mobile / >=60fps desktop) on real
// hardware - that still needs to happen with real multi-room data before
// this can be called performance-verified, not just functionally working.

import React, { useEffect, useRef, useState, useCallback } from "react";
import * as pc from "playcanvas";
import { getListingScene, getApiBase } from "@/lib/api";
import type { ListingScene, ListingRoomSummary, ListingCameraPathWaypoint } from "@/lib/types";
import {
  isPlyBuffer,
  splatToPly,
  downsamplePlyBinary,
  sanitizePlyBuffer,
  MAX_CLIENT_SPLATS,
} from "@/components/SplatViewer";

interface ListingSplatViewerProps {
  listingId: number;
}

type RoomLoadStatus =
  | "pending"
  | "loading"
  | "loaded"
  | "loaded_fallback" // room's own reconstruction fell back to 2.5D - splat_url exists but isn't a genuine trained splat
  | "no_splat" // room has no scene.splat on disk at all yet
  | "error";

interface RoomStatusEntry {
  status: RoomLoadStatus;
  room: ListingRoomSummary;
  vertexCount?: number;
  errorMessage?: string;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return el.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function catmullRomVec3(
  p0: pc.Vec3, p1: pc.Vec3, p2: pc.Vec3, p3: pc.Vec3, u: number, out: pc.Vec3
): pc.Vec3 {
  const u2 = u * u;
  const u3 = u2 * u;
  out.x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * u + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3);
  out.y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * u + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3);
  out.z = 0.5 * (2 * p1.z + (-p0.z + p2.z) * u + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * u2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * u3);
  return out;
}

export default function ListingSplatViewer({ listingId }: ListingSplatViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const appRef = useRef<pc.Application | null>(null);
  const cameraRef = useRef<pc.Entity | null>(null);

  const [scene, setScene] = useState<ListingScene | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [roomStatus, setRoomStatus] = useState<Record<number, RoomStatusEntry>>({});
  const [totalVertices, setTotalVertices] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playProgress, setPlayProgress] = useState(0);

  // Mutable flythrough state read inside the app.on('update') loop, which
  // would otherwise close over stale React state.
  const isPlayingRef = useRef(false);
  const playTimeRef = useRef(0);

  // ── Step 1: fetch the assembled listing scene once (rooms + placements +
  // splat_url per room + the multi-room camera path). ──────────────────
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const s = await getListingScene(listingId);
        if (active) setScene(s);
      } catch (err) {
        if (active) setSceneError(err instanceof Error ? err.message : "Failed to load listing scene");
      }
    })();
    return () => {
      active = false;
    };
  }, [listingId]);

  // ── Step 2: build the PlayCanvas app once we know the scene, then load
  // and composite every room's splat into it. ──────────────────────────
  useEffect(() => {
    if (!scene) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const probeCanvas = document.createElement("canvas");
    const gl =
      probeCanvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false }) ||
      probeCanvas.getContext("webgl", { failIfMajorPerformanceCaveat: false });
    if (!gl) {
      setWebglError("WebGL is not supported in this browser - the real 3D splat composite can't render here.");
      return;
    }

    let app: pc.Application;
    try {
      app = new pc.Application(canvas, {
        mouse: new pc.Mouse(document.body),
        keyboard: new pc.Keyboard(window),
        touch: "ontouchstart" in window ? new pc.TouchDevice(canvas) : undefined,
        graphicsDeviceOptions: {
          preserveDrawingBuffer: false,
          antialias: true,
          alpha: true,
          powerPreference: "high-performance",
        },
      });
      appRef.current = app;
    } catch (err: unknown) {
      setWebglError("WebGL initialization failed: " + (err instanceof Error ? err.message : String(err)));
      return;
    }

    app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    app.scene.ambientLight = new pc.Color(0.25, 0.25, 0.25);

    const camera = new pc.Entity("camera");
    camera.addComponent("camera", {
      clearColor: new pc.Color(0.04, 0.04, 0.06, 1.0),
      nearClip: 0.05,
      farClip: 500,
      fov: 55,
    });
    app.root.addChild(camera);
    cameraRef.current = camera;

    const light = new pc.Entity("light");
    light.addComponent("light", { type: "directional", color: pc.Color.WHITE, intensity: 0.8, castShadows: false });
    app.root.addChild(light);
    light.setLocalEulerAngles(45, 30, 0);

    // ── Default view: orbit around the combined placement bounds of every
    // room (a "dollhouse" view of the whole listing), same drag/scroll
    // scheme as SplatViewer's dollhouse mode. Flythrough playback below
    // takes over the camera while active. ──────────────────────────────
    let orbitAzimuth = 45;
    let orbitElevation = 35;
    let orbitDistance = 20;
    const orbitTarget = new pc.Vec3(0, 0, 0);

    if (scene.rooms.length > 0) {
      const xs = scene.rooms.map((r) => r.placement?.offset_x ?? 0);
      const zs = scene.rooms.map((r) => r.placement?.offset_z ?? 0);
      orbitTarget.set(
        (Math.min(...xs) + Math.max(...xs)) / 2,
        0,
        (Math.min(...zs) + Math.max(...zs)) / 2
      );
      const spanX = Math.max(...xs) - Math.min(...xs);
      const spanZ = Math.max(...zs) - Math.min(...zs);
      orbitDistance = Math.max(8, Math.min(120, Math.max(spanX, spanZ) * 1.6 + 8));
    }

    if (app.mouse) {
      app.mouse.on(pc.EVENT_MOUSEMOVE, (e: pc.MouseEvent) => {
        if (isPlayingRef.current) return;
        if (e.buttons[pc.MOUSEBUTTON_LEFT]) {
          orbitAzimuth -= e.dx * 0.5;
          orbitElevation -= e.dy * 0.5;
          orbitElevation = Math.max(-89.9, Math.min(89.9, orbitElevation));
        } else if (e.buttons[pc.MOUSEBUTTON_RIGHT] || e.buttons[pc.MOUSEBUTTON_MIDDLE]) {
          const panSpeed = orbitDistance * 0.002;
          orbitTarget.add(camera.right.clone().mulScalar(-e.dx * panSpeed));
          orbitTarget.add(camera.up.clone().mulScalar(e.dy * panSpeed));
        }
      });
      app.mouse.on(pc.EVENT_MOUSEWHEEL, (e: pc.MouseEvent) => {
        if (isPlayingRef.current) return;
        orbitDistance *= 1 + e.wheelDelta * 0.1;
        orbitDistance = Math.max(0.5, Math.min(400, orbitDistance));
      });
      app.mouse.disableContextMenu();
    }

    // ── Flythrough playback: the real multi-room Bezier/Catmull-Rom path
    // W1-48 asks for, computed server-side in build_listing_camera_path and
    // already in the room's SHARED listing frame (same one the room
    // containers below are placed into) - no extra transform needed here. ──
    const pathWaypoints: ListingCameraPathWaypoint[] = scene.camera_path?.waypoints ?? [];
    const pathDuration = scene.camera_path?.duration_seconds ?? 0;
    const p0 = new pc.Vec3(), p1 = new pc.Vec3(), p2 = new pc.Vec3(), p3 = new pc.Vec3();
    const posOut = new pc.Vec3(), tgtOut = new pc.Vec3();

    function sampleCameraPath(timeSec: number) {
      if (pathWaypoints.length < 2 || pathDuration <= 0) return null;
      const t = Math.max(0, Math.min(1, timeSec / pathDuration));
      const n = pathWaypoints.length;
      const segF = t * (n - 1);
      const segI = Math.max(0, Math.min(n - 2, Math.floor(segF)));
      const segT = segF - segI;
      const wpAt = (i: number) => pathWaypoints[Math.max(0, Math.min(n - 1, i))];
      const w0 = wpAt(segI - 1), w1 = wpAt(segI), w2 = wpAt(segI + 1), w3 = wpAt(segI + 2);
      p0.set(w0.position.x, w0.position.y, w0.position.z);
      p1.set(w1.position.x, w1.position.y, w1.position.z);
      p2.set(w2.position.x, w2.position.y, w2.position.z);
      p3.set(w3.position.x, w3.position.y, w3.position.z);
      catmullRomVec3(p0, p1, p2, p3, segT, posOut);
      p0.set(w0.target.x, w0.target.y, w0.target.z);
      p1.set(w1.target.x, w1.target.y, w1.target.z);
      p2.set(w2.target.x, w2.target.y, w2.target.z);
      p3.set(w3.target.x, w3.target.y, w3.target.z);
      catmullRomVec3(p0, p1, p2, p3, segT, tgtOut);
      return { position: posOut, target: tgtOut };
    }

    app.on("update", (dt: number) => {
      if (isPlayingRef.current && pathWaypoints.length >= 2 && pathDuration > 0) {
        playTimeRef.current += dt;
        if (playTimeRef.current >= pathDuration) {
          playTimeRef.current = pathDuration;
          isPlayingRef.current = false;
          setIsPlaying(false);
        }
        const sample = sampleCameraPath(playTimeRef.current);
        if (sample) {
          camera.setPosition(sample.position);
          camera.lookAt(sample.target);
        }
        setPlayProgress(pathDuration > 0 ? playTimeRef.current / pathDuration : 0);
        return;
      }

      const elevationRad = orbitElevation * pc.math.DEG_TO_RAD;
      const azimuthRad = orbitAzimuth * pc.math.DEG_TO_RAD;
      const x = orbitTarget.x + orbitDistance * Math.cos(elevationRad) * Math.sin(azimuthRad);
      const y = orbitTarget.y + orbitDistance * Math.sin(elevationRad);
      const z = orbitTarget.z + orbitDistance * Math.cos(elevationRad) * Math.cos(azimuthRad);
      camera.setPosition(x, y, z);
      camera.lookAt(orbitTarget);
    });

    // ── Load and composite every room's splat ──────────────────────────
    let active = true;
    const apiBase = getApiBase();
    const roomsWithSplat = scene.rooms.filter((r) => !!r.splat_url);
    // First-pass perf mitigation: split the existing single-room budget
    // across however many rooms will actually be loaded, rather than
    // loading every room at full single-room resolution (which is exactly
    // the scenario flagged as unverified in this file's header comment).
    const perRoomBudget = roomsWithSplat.length > 0
      ? Math.max(50_000, Math.floor(MAX_CLIENT_SPLATS / roomsWithSplat.length))
      : MAX_CLIENT_SPLATS;

    const initialStatus: Record<number, RoomStatusEntry> = {};
    for (const r of scene.rooms) {
      initialStatus[r.project_id] = {
        status: r.splat_url ? "loading" : "no_splat",
        room: r,
      };
    }
    setRoomStatus(initialStatus);

    async function loadRoom(r: ListingRoomSummary) {
      if (!r.splat_url) return;
      try {
        const url = `${apiBase}${r.splat_url}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        if (!active) return;

        let finalBuffer = buffer;
        if (!isPlyBuffer(finalBuffer)) {
          finalBuffer = splatToPly(finalBuffer);
        }
        finalBuffer = downsamplePlyBinary(finalBuffer, perRoomBudget);
        const sanitized = sanitizePlyBuffer(finalBuffer);
        finalBuffer = sanitized.buffer;

        const blob = new Blob([finalBuffer], { type: "application/octet-stream" });
        const blobUrl = URL.createObjectURL(blob) + "#scene.ply";

        const asset = new pc.Asset(`splat_room_${r.project_id}`, "gsplat", { url: blobUrl, filename: "scene.ply" });
        app.assets.add(asset);

        await new Promise<void>((resolve, reject) => {
          asset.on("error", (err: Error) => reject(err));
          asset.ready(() => resolve());
          app.assets.load(asset);
        });
        if (!active) return;

        // Room container: the room's listing-frame placement (position,
        // yaw about Y, uniform scale) - see this file's header comment for
        // why this composes correctly with the splat entity's own untouched
        // 180°-X local flip below.
        const placement = r.placement || { offset_x: 0, offset_y: 0, offset_z: 0, yaw_deg: 0, scale: 1 };
        const container = new pc.Entity(`room_${r.project_id}_container`);
        container.setLocalPosition(placement.offset_x ?? 0, placement.offset_y ?? 0, placement.offset_z ?? 0);
        container.setLocalEulerAngles(0, placement.yaw_deg ?? 0, 0);
        const s = placement.scale ?? 1;
        container.setLocalScale(s, s, s);
        app.root.addChild(container);

        const splatEntity = new pc.Entity(`room_${r.project_id}_splat`);
        splatEntity.addComponent("gsplat", { asset });
        // Same fixed correction SplatViewer.tsx applies for a single room -
        // untouched here, the container above handles listing placement.
        splatEntity.setLocalEulerAngles(180, 0, 0);
        container.addChild(splatEntity);

        setRoomStatus((prev) => ({
          ...prev,
          [r.project_id]: {
            status: r.passed ? "loaded" : "loaded_fallback",
            room: r,
            vertexCount: sanitized.numVertices,
          },
        }));
        setTotalVertices((prev) => prev + sanitized.numVertices);
      } catch (err: unknown) {
        if (!active) return;
        setRoomStatus((prev) => ({
          ...prev,
          [r.project_id]: {
            status: "error",
            room: r,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    }

    Promise.all(roomsWithSplat.map(loadRoom));

    app.start();

    const handleResize = () => app.resizeCanvas();
    window.addEventListener("resize", handleResize);

    return () => {
      active = false;
      window.removeEventListener("resize", handleResize);
      if (appRef.current) {
        try {
          appRef.current.destroy();
        } catch (_) {
          // already torn down
        }
        appRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  const handlePlayToggle = useCallback(() => {
    const hasPath = (scene?.camera_path?.waypoints?.length ?? 0) >= 2;
    if (!hasPath) return;
    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      setIsPlaying(false);
    } else {
      if (playTimeRef.current >= (scene?.camera_path?.duration_seconds ?? 0)) {
        playTimeRef.current = 0;
      }
      isPlayingRef.current = true;
      setIsPlaying(true);
    }
  }, [scene]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.code === "Space") {
        e.preventDefault();
        handlePlayToggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlePlayToggle]);

  const statusList = scene ? scene.rooms.map((r) => roomStatus[r.project_id]).filter(Boolean) : [];
  const loadedGenuine = statusList.filter((s) => s.status === "loaded").length;
  const loadedFallback = statusList.filter((s) => s.status === "loaded_fallback").length;
  const noSplat = statusList.filter((s) => s.status === "no_splat").length;
  const errored = statusList.filter((s) => s.status === "error").length;
  const stillLoading = statusList.filter((s) => s.status === "loading").length;

  return (
    <div className="w-full h-full relative bg-[#0a0a0f]">
      <canvas ref={canvasRef} className="w-full h-full block" />

      {sceneError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-center p-6">
          <p className="text-[var(--error)] text-sm max-w-md">{sceneError}</p>
        </div>
      )}
      {webglError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-center p-6">
          <p className="text-[var(--error)] text-sm max-w-md">{webglError}</p>
        </div>
      )}

      {/* Per-room composite status - deliberately never hidden. A fallback
          room still renders (it has a splat_url) but is labeled honestly
          rather than presented as a genuine splat, per W1-48's own bar. */}
      <div className="absolute top-4 left-4 bg-black/70 backdrop-blur rounded-xl p-3 text-xs text-white max-w-xs space-y-1.5">
        <p className="font-bold text-sm mb-1">{scene?.name ?? "Loading listing…"}</p>
        {statusList.map((s) => (
          <div key={s.room.project_id} className="flex items-center justify-between gap-3">
            <span className="truncate" title={s.room.room_label}>{s.room.room_label}</span>
            <span
              className={
                s.status === "loaded" ? "text-emerald-400" :
                s.status === "loaded_fallback" ? "text-amber-400" :
                s.status === "loading" ? "text-[var(--text-secondary)]" :
                s.status === "no_splat" ? "text-[var(--text-secondary)]" :
                "text-[var(--error)]"
              }
            >
              {s.status === "loaded" && `✓ splat (${s.vertexCount?.toLocaleString()})`}
              {s.status === "loaded_fallback" && `⚠ fallback (${s.room.reason_code})`}
              {s.status === "loading" && "loading…"}
              {s.status === "no_splat" && "no splat yet"}
              {s.status === "error" && "load failed"}
            </span>
          </div>
        ))}
        {statusList.length > 0 && (
          <p className="text-[var(--text-secondary)] pt-1 border-t border-white/10 mt-1.5">
            {loadedGenuine} genuine · {loadedFallback} fallback · {noSplat} missing
            {errored > 0 ? ` · ${errored} failed` : ""}
            {stillLoading > 0 ? ` · ${stillLoading} loading` : ""}
            {totalVertices > 0 && ` · ${totalVertices.toLocaleString()} splats total`}
          </p>
        )}
      </div>

      {/* Flythrough control */}
      {scene && (scene.camera_path?.waypoints?.length ?? 0) >= 2 && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/70 backdrop-blur rounded-full px-4 py-2">
          <button
            onClick={handlePlayToggle}
            className="text-white text-xs font-bold px-3 py-1.5 rounded-full bg-indigo-600 hover:bg-indigo-500 transition-colors"
          >
            {isPlaying ? "Pause" : "Play Camera Path"}
          </button>
          <div className="w-40 h-1 bg-white/20 rounded-full overflow-hidden">
            <div className="h-full bg-indigo-400" style={{ width: `${Math.round(playProgress * 100)}%` }} />
          </div>
          <span className="text-[10px] text-white/60">
            {scene.camera_path?.num_rooms ?? 0} room{(scene.camera_path?.num_rooms ?? 0) === 1 ? "" : "s"}
          </span>
        </div>
      )}

      <div className="absolute bottom-6 right-6 text-[10px] text-white/40">
        Drag to orbit · Scroll to zoom · Space to play/pause
      </div>
    </div>
  );
}
