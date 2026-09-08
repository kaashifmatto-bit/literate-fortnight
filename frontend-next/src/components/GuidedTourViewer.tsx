"use client";

/**
 * ArticulAIT — GuidedTourViewer (§5.2G / M2 §9.1)
 * Plays a smooth Catmull-Rom Bézier camera path through the loaded 3DGS scene.
 * Camera position & look-at target are evaluated from real COLMAP poses (or
 * scene-bounds fallback) at 60fps using requestAnimationFrame.
 *
 * Controls:
 *  - ▶ Play / ⏸ Pause / ↺ Reset
 *  - Progress scrub bar (click to seek)
 *  - Speed: 0.5× / 1× / 1.5× / 2×
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import * as pc from "playcanvas";
import JSZip from "jszip";

interface Vec3 { x: number; y: number; z: number; }
interface PathWaypoint {
  frame: number;
  time_sec: number;
  t: number;
  position: Vec3;
  target: Vec3;
}
interface CameraPath {
  duration_seconds: number;
  total_waypoints: number;
  path_type: string;
  waypoints: PathWaypoint[];
  scene_bounds?: {
    center: Vec3;
    half_extents: Vec3;
    max_extent: number;
  } | null;
}

interface GuidedTourViewerProps {
  splatUrl?: string;
  file?: File | null;
  projectId?: number;
  onExit?: () => void;
}

// ── Lerp helper ──────────────────────────────────────────────────────────────
function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/** Evaluate the precomputed waypoint list at an arbitrary time_sec (linear interp between samples) */
function evaluatePathAtTime(waypoints: PathWaypoint[], timeSec: number): { position: Vec3; target: Vec3 } {
  if (!waypoints.length) return { position: { x: 0, y: 0, z: 10 }, target: { x: 0, y: 0, z: 0 } };
  if (timeSec <= waypoints[0].time_sec) return { position: waypoints[0].position, target: waypoints[0].target };
  const last = waypoints[waypoints.length - 1];
  if (timeSec >= last.time_sec) return { position: last.position, target: last.target };

  // Binary search for the surrounding pair
  let lo = 0, hi = waypoints.length - 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (waypoints[mid + 1].time_sec < timeSec) lo = mid + 1;
    else hi = mid;
  }
  const w0 = waypoints[lo];
  const w1 = waypoints[lo + 1];
  const span = w1.time_sec - w0.time_sec;
  const t = span > 0 ? (timeSec - w0.time_sec) / span : 0;
  return {
    position: lerpVec3(w0.position, w1.position, t),
    target: lerpVec3(w0.target, w1.target, t),
  };
}

import { getApiBase } from "@/lib/api";

async function fetchCameraPath(projectId: number): Promise<CameraPath> {
  const apiBase = getApiBase();
  const res = await fetch(`${apiBase}/api/projects/${projectId}/camera_path`);
  if (!res.ok) throw new Error(`Camera path API error: ${res.status}`);
  return res.json();
}

async function loadSplatBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Splat fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  // LCC = zip container → extract scene.splat or scene.ply
  if (url.endsWith(".lcc") || url.endsWith(".zip")) {
    const zip = await JSZip.loadAsync(buf);
    for (const name of Object.keys(zip.files)) {
      if (name.endsWith(".splat") || name.endsWith(".ply")) {
        return zip.files[name].async("arraybuffer");
      }
    }
  }
  return buf;
}

function isPlyBuffer(buf: ArrayBuffer): boolean {
  const header = new TextDecoder().decode(buf.slice(0, 4));
  return header.startsWith("ply");
}

export default function GuidedTourViewer({ splatUrl, file, projectId, onExit }: GuidedTourViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<pc.Application | null>(null);
  const cameraEntityRef = useRef<pc.Entity | null>(null);
  const pathRef = useRef<CameraPath | null>(null);
  const animFrameRef = useRef<number>(0);
  const startWallTimeRef = useRef<number>(0);
  const pausedAtRef = useRef<number>(0);       // path time_sec at pause point

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1.0);
  const [pathType, setPathType] = useState<string>("—");
  const speedRef = useRef(1.0);

  // ── Sync speed ref instantly ──────────────────────────────────────────────
  useEffect(() => { speedRef.current = speed; }, [speed]);

  // ── Setup PlayCanvas & load Splat ─────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return;
    let active = true;

    const canvas = canvasRef.current;
    const app = new pc.Application(canvas, {
      mouse: new pc.Mouse(canvas),
      graphicsDeviceOptions: { antialias: true, alpha: false, powerPreference: "high-performance" },
    });
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    app.start();
    appRef.current = app;

    // Camera
    const camEntity = new pc.Entity("GuidedCamera");
    camEntity.addComponent("camera", { clearColor: new pc.Color(0.02, 0.02, 0.04), fov: 60 });
    app.root.addChild(camEntity);
    cameraEntityRef.current = camEntity;

    // Ambient light
    const light = new pc.Entity("Light");
    light.addComponent("light", { type: "directional", intensity: 1.2 });
    light.setEulerAngles(45, 30, 0);
    app.root.addChild(light);

    async function init() {
      try {
        // 1. Fetch camera path
        if (!projectId) throw new Error("No projectId provided for guided tour");
        const path = await fetchCameraPath(projectId);
        if (!active) return;
        pathRef.current = path;
        setDuration(path.duration_seconds);
        setPathType(path.path_type === "catmull_rom_poses" ? "Real Camera Poses" : "Scene Orbit");

        // 2. Load splat asset
        let rawBuf: ArrayBuffer | null = null;
        if (file) {
          rawBuf = await file.arrayBuffer();
        } else if (splatUrl && !splatUrl.includes("undefined")) {
          rawBuf = await loadSplatBuffer(splatUrl);
        }
        if (!rawBuf || !active) return;

        // Convert .splat → PLY if needed
        let plyBuf = rawBuf;
        if (!isPlyBuffer(rawBuf)) {
          plyBuf = splatToPly(rawBuf);
        }

        const blob = new Blob([plyBuf], { type: "application/octet-stream" });
        const blobUrl = URL.createObjectURL(blob) + "#scene.ply";

        const asset = new pc.Asset("guided_splat", "gsplat", { url: blobUrl, filename: "scene.ply" });
        app.assets.add(asset);

        asset.ready(() => {
          if (!active) return;
          const splatEntity = new pc.Entity("Splat");
          splatEntity.addComponent("gsplat", { asset });
          splatEntity.setLocalEulerAngles(180, 0, 0);
          app.root.addChild(splatEntity);

          // Position camera at path start
          if (path.waypoints.length > 0) {
            const { position: p, target: tgt } = path.waypoints[0];
            camEntity.setPosition(p.x, -p.y, -p.z);
            camEntity.lookAt(new pc.Vec3(tgt.x, -tgt.y, -tgt.z));
          }

          if (active) setIsLoading(false);
        });

        asset.on("error", (err: Error) => {
          if (active) setError("Splat load failed: " + String(err));
        });
        app.assets.load(asset);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      }
    }

    init();

    const onResize = () => app.resizeCanvas();
    window.addEventListener("resize", onResize);

    return () => {
      active = false;
      cancelAnimationFrame(animFrameRef.current);
      window.removeEventListener("resize", onResize);
      app.destroy();
      appRef.current = null;
    };
  }, [splatUrl, file, projectId]);

  // ── Playback animation loop ────────────────────────────────────────────────
  const runLoop = useCallback(() => {
    const path = pathRef.current;
    const cam = cameraEntityRef.current;
    if (!path || !cam) return;

    const elapsed = (performance.now() - startWallTimeRef.current) / 1000 * speedRef.current;
    const rawTime = pausedAtRef.current + elapsed;
    const clampedTime = Math.min(rawTime, path.duration_seconds);

    setCurrentTime(clampedTime);

    const { position: p, target: tgt } = evaluatePathAtTime(path.waypoints, clampedTime);
    // Account for the 180° X rotation on the splatEntity
    cam.setPosition(p.x, -p.y, -p.z);
    cam.lookAt(new pc.Vec3(tgt.x, -tgt.y, -tgt.z));

    if (clampedTime >= path.duration_seconds) {
      setIsPlaying(false);
      return;
    }

    animFrameRef.current = requestAnimationFrame(runLoop);
  }, []);

  const play = useCallback(() => {
    const path = pathRef.current;
    if (!path) return;
    if (pausedAtRef.current >= path.duration_seconds) {
      pausedAtRef.current = 0;
    }
    startWallTimeRef.current = performance.now();
    setIsPlaying(true);
    cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = requestAnimationFrame(runLoop);
  }, [runLoop]);

  const pause = useCallback(() => {
    setIsPlaying(false);
    cancelAnimationFrame(animFrameRef.current);
    const path = pathRef.current;
    if (path) {
      const elapsed = (performance.now() - startWallTimeRef.current) / 1000 * speedRef.current;
      pausedAtRef.current = Math.min(pausedAtRef.current + elapsed, path.duration_seconds);
    }
  }, []);

  const reset = useCallback(() => {
    setIsPlaying(false);
    cancelAnimationFrame(animFrameRef.current);
    pausedAtRef.current = 0;
    setCurrentTime(0);
    const path = pathRef.current;
    const cam = cameraEntityRef.current;
    if (path?.waypoints.length && cam) {
      const { position: p, target: tgt } = path.waypoints[0];
      cam.setPosition(p.x, -p.y, -p.z);
      cam.lookAt(new pc.Vec3(tgt.x, -tgt.y, -tgt.z));
    }
  }, []);

  const seek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    const wasPlaying = isPlaying;
    if (wasPlaying) {
      cancelAnimationFrame(animFrameRef.current);
      setIsPlaying(false);
    }
    pausedAtRef.current = t;
    setCurrentTime(t);
    const path = pathRef.current;
    const cam = cameraEntityRef.current;
    if (path && cam) {
      const { position: p, target: tgt } = evaluatePathAtTime(path.waypoints, t);
      cam.setPosition(p.x, -p.y, -p.z);
      cam.lookAt(new pc.Vec3(tgt.x, -tgt.y, -tgt.z));
    }
    if (wasPlaying) setTimeout(play, 0);
  }, [isPlaying, play]);

  const fmt = (s: number) => `${Math.floor(s / 60).toString().padStart(2, "0")}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="w-full h-full relative overflow-hidden bg-[#030305] select-none">

      {/* PlayCanvas Canvas */}
      <canvas ref={canvasRef} className="w-full h-full block" />

      {/* Loading Overlay */}
      {isLoading && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#030305]/95 z-50 gap-4">
          <div className="relative w-16 h-16">
            <span className="absolute inset-0 border-4 border-violet-500/20 rounded-full" />
            <span className="absolute inset-0 border-4 border-t-violet-500 rounded-full animate-spin" />
          </div>
          <div className="text-center space-y-1">
            <p className="text-white font-bold text-sm">Preparing Cinematic Tour</p>
            <p className="text-violet-300/70 text-xs">Loading Bézier path + 3D scene…</p>
          </div>
        </div>
      )}

      {/* Error Overlay */}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#030305]/95 z-50 gap-4 p-6">
          <div className="max-w-sm p-6 bg-red-950/60 border border-red-500/40 rounded-2xl text-center space-y-3">
            <div className="text-3xl">❌</div>
            <p className="text-red-200 font-bold text-sm">{error}</p>
            <button onClick={onExit} className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-xl text-xs font-bold transition-all">
              ← Back to Viewer
            </button>
          </div>
        </div>
      )}

      {/* ── Path Type Badge ── */}
      {!isLoading && !error && (
        <div className="absolute top-4 left-4 z-30 flex items-center gap-2">
          <div className="flex items-center gap-2 bg-black/80 backdrop-blur-xl border border-violet-500/40 px-3 py-1.5 rounded-xl shadow-xl">
            <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
            <span className="text-violet-200 text-[11px] font-bold tracking-wide">🎬 Cinematic Tour</span>
            <span className="text-[9px] text-violet-300/60 border border-violet-500/30 px-1.5 py-0.5 rounded font-mono uppercase">
              {pathType}
            </span>
          </div>
        </div>
      )}

      {/* ── Exit Button ── */}
      {onExit && (
        <div className="absolute top-4 right-4 z-30">
          <button
            onClick={onExit}
            className="px-3 py-1.5 text-xs font-bold bg-black/80 hover:bg-red-950/80 text-white/80 hover:text-red-200 border border-white/15 hover:border-red-500/40 rounded-xl backdrop-blur-md transition-all"
          >
            ✕ Exit Tour
          </button>
        </div>
      )}

      {/* ── Cinematic HUD Controls ── */}
      {!isLoading && !error && (
        <div className="absolute bottom-0 inset-x-0 z-30 p-4 bg-gradient-to-t from-black/95 via-black/60 to-transparent">

          {/* Progress Bar */}
          <div className="mb-3 px-1">
            <input
              type="range"
              min={0}
              max={duration}
              step={0.05}
              value={currentTime}
              onChange={seek}
              className="w-full h-1.5 cursor-pointer appearance-none rounded-full bg-white/10 accent-violet-500"
              style={{ accentColor: "#8b5cf6" }}
            />
            <div className="flex justify-between text-[10px] text-white/40 mt-1 font-mono">
              <span>{fmt(currentTime)}</span>
              <span>{fmt(duration)}</span>
            </div>
          </div>

          {/* Controls Row */}
          <div className="flex items-center justify-between gap-3">

            {/* Left: transport buttons */}
            <div className="flex items-center gap-2">
              {/* Reset */}
              <button
                onClick={reset}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white text-xs transition-all"
                title="Reset to Start"
              >
                ↺
              </button>

              {/* Play / Pause */}
              <button
                onClick={isPlaying ? pause : play}
                className={`w-11 h-11 flex items-center justify-center rounded-full font-bold text-sm transition-all shadow-lg ${
                  isPlaying
                    ? "bg-violet-600 hover:bg-violet-500 shadow-violet-500/40 text-white"
                    : "bg-white hover:bg-violet-100 text-black"
                }`}
                title={isPlaying ? "Pause" : "Play Cinematic Tour"}
              >
                {isPlaying ? "⏸" : "▶"}
              </button>
            </div>

            {/* Center: title */}
            <div className="flex flex-col items-center pointer-events-none">
              <span className="text-white/80 text-xs font-bold tracking-wide">Scripted Bézier Flythrough</span>
              <span className="text-white/30 text-[10px]">§5.2G · M2 §9.1</span>
            </div>

            {/* Right: speed selector */}
            <div className="flex items-center gap-1 bg-black/60 border border-white/15 rounded-xl p-1">
              {([0.5, 1.0, 1.5, 2.0] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-all ${
                    speed === s
                      ? "bg-violet-600 text-white shadow"
                      : "text-white/50 hover:text-white hover:bg-white/10"
                  }`}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>

          {/* Progress fill indicator */}
          <div className="mt-3 h-0.5 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-violet-500 to-pink-500 rounded-full transition-none"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inline splatToPly converter (mirrors SplatViewer.tsx) ───────────────────
function splatToPly(buffer: ArrayBuffer): ArrayBuffer {
  const numVertices = Math.floor(buffer.byteLength / 32);
  const headerStr = `ply\nformat binary_little_endian 1.0\ncomment align\nelement vertex ${numVertices}\nproperty float x\nproperty float y\nproperty float z\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nproperty float opacity\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nend_header\n`;
  const encoder = new TextEncoder();
  let headerBytes = encoder.encode(headerStr);
  const padRemainder = headerBytes.length % 4;
  if (padRemainder !== 0) {
    const pad = 4 - padRemainder;
    headerBytes = encoder.encode(headerStr.replace("comment align", "comment align" + " ".repeat(pad)));
  }
  const out = new ArrayBuffer(headerBytes.length + numVertices * 56);
  const outView = new DataView(out);
  new Uint8Array(out).set(headerBytes, 0);
  const inView = new DataView(buffer);
  let off = headerBytes.length;
  const SH_C0 = 0.28209479177387814;
  for (let i = 0; i < numVertices; i++) {
    const base = i * 32;
    outView.setFloat32(off, inView.getFloat32(base, true), true);
    outView.setFloat32(off + 4, inView.getFloat32(base + 4, true), true);
    outView.setFloat32(off + 8, inView.getFloat32(base + 8, true), true);
    const r = inView.getUint8(base + 24), g = inView.getUint8(base + 25), b = inView.getUint8(base + 26), a = inView.getUint8(base + 27);
    outView.setFloat32(off + 12, (r / 255 - 0.5) / SH_C0, true);
    outView.setFloat32(off + 16, (g / 255 - 0.5) / SH_C0, true);
    outView.setFloat32(off + 20, (b / 255 - 0.5) / SH_C0, true);
    let alpha = a / 255; if (alpha < 0.001) alpha = 0.001; if (alpha > 0.999) alpha = 0.999;
    outView.setFloat32(off + 24, Math.log(alpha / (1 - alpha)), true);
    const s0 = inView.getFloat32(base + 12, true), s1 = inView.getFloat32(base + 16, true), s2 = inView.getFloat32(base + 20, true);
    outView.setFloat32(off + 28, (isFinite(s0) && s0 > 0) ? Math.log(s0) : -4.5, true);
    outView.setFloat32(off + 32, (isFinite(s1) && s1 > 0) ? Math.log(s1) : -4.5, true);
    outView.setFloat32(off + 36, (isFinite(s2) && s2 > 0) ? Math.log(s2) : -4.5, true);
    const q0 = (inView.getUint8(base + 28) - 128) / 128, q1 = (inView.getUint8(base + 29) - 128) / 128;
    const q2 = (inView.getUint8(base + 30) - 128) / 128, q3 = (inView.getUint8(base + 31) - 128) / 128;
    let qLen = Math.sqrt(q0*q0 + q1*q1 + q2*q2 + q3*q3) || 1;
    outView.setFloat32(off + 40, q0 / qLen, true); outView.setFloat32(off + 44, q1 / qLen, true);
    outView.setFloat32(off + 48, q2 / qLen, true); outView.setFloat32(off + 52, q3 / qLen, true);
    off += 56;
  }
  return out;
}
