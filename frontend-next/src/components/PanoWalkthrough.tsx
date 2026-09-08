"use client";

import { useEffect, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import * as THREE from "three";

interface Waypoint {
  index: number;
  filename: string;
  image_url: string;
  raw_image_url?: string;
  position?: { x: number; y: number; z: number };
  target?: { x: number; y: number; z: number };
  connections?: number[];
  // W1-48: present when this waypoint came from a multi-room listing scene
  // (/api/listings/{id}/scene) rather than a single project's /waypoints -
  // identifies which room (Project) this waypoint's photo actually belongs
  // to, since a listing merges waypoints from several rooms into one array.
  project_id?: number;
  room_label?: string;
}

interface Hotspot {
  id: number;
  waypoint_id: number;
  // Present on a multi-room listing's merged hotspots (see
  // listing_assembly_service.py's second pass) as the global index after
  // cross-room remapping; waypoint_id is used when this is absent.
  waypoint_index?: number;
  yaw: number;
  pitch: number;
  title: string;
  description: string;
  icon_type?: string;
  // W1-48: present on a "door" room-connector hotspot once resolved by the
  // listing assembly service - the listing-global waypoint index on the
  // OTHER side of the doorway.
  target_waypoint_global_index?: number;
}

interface PanoWalkthroughProps {
  // Single-room mode (unchanged): render one project's own photo tour.
  projectId: number;
  // W1-48 multi-room mode: when set, this takes priority over projectId -
  // fetches the assembled multi-room scene from
  // GET /api/listings/{listingId}/scene instead of
  // GET /api/projects/{projectId}/waypoints, and renders every room's
  // waypoints in one continuous walkthrough. `projectId` is still required
  // by the type (kept as a harmless fallback value, e.g. the listing's
  // first room) since most of this component's helpers are unaffected
  // either way - every waypoint already carries its own image_url with the
  // correct source project baked in server-side.
  listingId?: number;
  onFallback?: () => void;
  // Pixels to push this component's own top-anchored HUD elements (mode
  // badge, auto-detect/fullscreen buttons) down by, so they clear a parent
  // page's own fixed/absolute top toolbar instead of rendering underneath
  // it. Defaults to 0 (unchanged) for standalone usage (e.g.
  // app/tour/[tourId]/page.tsx and app/listing/[listingId]/page.tsx, which
  // have no such toolbar). The 3D canvas itself always stays full-bleed
  // regardless of this value — only the HUD overlay rows shift.
  topInset?: number;
}

interface IrisUniforms {
  uCenter: { value: THREE.Vector2 };
  uResolution: { value: THREE.Vector2 };
  uRadius: { value: number };
  uFeather: { value: number };
  uIrisEnabled: { value: number };
}

import { getApiBase } from "@/lib/api";

const BASE = getApiBase();

// Cubic & Quad Easing functions
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeInQuad(t: number): number {
  return t * t;
}

const DEFAULT_FOV = 75; // degrees
const MAX_PITCH = 30;   // keep camera in clean central band — avoids equirectangular pole distortion for 2D photos

// Matterport-style: every image — real panorama or ordinary 2D photo — is
// mapped onto a full 360° equirectangular sphere. For ordinary photos we build
// a synthetic equirectangular canvas using a 2-layer technique:
//   1. Periphery: the whole photo drawn ONCE, stretched across the full 360°
//      width, blurred, then darkened with a vignette that dims smoothly the
//      further a direction is from camera-forward (brightest at front,
//      darkest at the exact antipode behind). A single blurred+dimmed copy,
//      not a second crisp copy.
//   2. Sharp forward patch: the SAME photo drawn again at its own native
//      aspect ratio, UNDISTORTED (not stretched), sized to a wide
//      SHARP_FOV_DEG and centered at FRONT_U, feathered into the dimmed
//      periphery so there's no visible seam.
//
// FIX HISTORY (image-quality complaint):
//   Round 1 had only the stretched layer (no sharp patch) — a normal
//   look-around only ever showed a heavily upscaled sliver of the photo.
//   Round 2 replaced the blurred periphery with two mirrored "cover"-fit
//   halves — technically seamless and never blurred, but a full rotation
//   showed the SAME crisp, recognizable furniture/art mirrored right next to
//   itself, which read as a broken "collision," not a real space.
//   Round 3 (this version): back to a blurred periphery — but wider
//   (SHARP_FOV_DEG raised so far more of a normal look-around stays fully
//   sharp) and now DARKENED via a vignette, so on the rare rotation that
//   does reach it, it reads as "the room fades into shadow at the edge of
//   what was captured" (the same convention real virtual-tour products use
//   for unscanned areas) rather than either a quality glitch or a
//   recognizable duplicate.
const SYNTH_EQUIRECT_W = 4096;
const SYNTH_EQUIRECT_H = 2048;
// Camera-forward (yaw=0, pitch=0) maps to world -Z. For an unflipped
// THREE.SphereGeometry (phiStart=0, phiLength=2π — this app applies no
// scale/UV flip anywhere, confirmed against the actual mesh/material setup
// below: mesh.scale is (1,1,1), material.map has repeat(1,1)/offset(0,0)),
// world -Z falls at u=0.75 on the sphere's own UV parametrization
// (x=-R·sinθ·cosφ, z=R·sinθ·sinφ, φ=u·2π ⇒ φ=270° ⇒ (x,z)=(0,-R)). Both the
// current and next mesh textures use offset(0,0) so they stay pixel-perfectly
// aligned during crossfade transitions.
const FRONT_U = 0.75;
// How much of the 360° sphere the sharp, undistorted forward patch covers.
// Wide enough that a normal look-around (drag, A/D) stays inside it for the
// large majority of a session; only turning most of the way around reaches
// the dimmed periphery.
const SHARP_FOV_DEG = 210;
// Periphery brightness at the exact antipode (behind the user). 1 = no
// darkening; lower = more of a "faded into shadow" read.
const VIGNETTE_MIN_BRIGHTNESS = 0.32;

// Draws `source` into a new canvas at (dw x dh), then feathers its alpha to
// 0 at all 4 edges (via two chained linear-gradient destination-in masks)
// so it composites onto the periphery with no hard rectangle seam.
function buildFeatheredPatch(
  source: CanvasImageSource,
  dw: number,
  dh: number,
  featherFracX: number,
  featherFracY: number
): HTMLCanvasElement {
  const patch = document.createElement("canvas");
  patch.width = dw;
  patch.height = dh;
  const pctx = patch.getContext("2d")!;
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = "high";
  pctx.drawImage(source, 0, 0, dw, dh);

  const fx = Math.min(0.49, featherFracX);
  const hGrad = pctx.createLinearGradient(0, 0, dw, 0);
  hGrad.addColorStop(0, "rgba(0,0,0,0)");
  hGrad.addColorStop(fx, "rgba(0,0,0,1)");
  hGrad.addColorStop(1 - fx, "rgba(0,0,0,1)");
  hGrad.addColorStop(1, "rgba(0,0,0,0)");
  pctx.globalCompositeOperation = "destination-in";
  pctx.fillStyle = hGrad;
  pctx.fillRect(0, 0, dw, dh);

  const fy = Math.min(0.49, featherFracY);
  const vGrad = pctx.createLinearGradient(0, 0, 0, dh);
  vGrad.addColorStop(0, "rgba(0,0,0,0)");
  vGrad.addColorStop(fy, "rgba(0,0,0,1)");
  vGrad.addColorStop(1 - fy, "rgba(0,0,0,1)");
  vGrad.addColorStop(1, "rgba(0,0,0,0)");
  pctx.globalCompositeOperation = "destination-in";
  pctx.fillStyle = vGrad;
  pctx.fillRect(0, 0, dw, dh);

  return patch;
}

// Builds a 1px-tall grayscale strip encoding a symmetric "distance from
// FRONT_U" brightness falloff (1.0 at FRONT_U, VIGNETTE_MIN_BRIGHTNESS at the
// antipode, continuous — including across the canvas's own x=0/x=W wrap,
// since du is computed mod 1 rather than assuming a single unwrapped ramp).
// Stretched to WxH and composited with "multiply" to darken the periphery.
function buildVignetteStrip(W: number, frontU: number, minBrightness: number): HTMLCanvasElement {
  const strip = document.createElement("canvas");
  strip.width = W;
  strip.height = 1;
  const sctx = strip.getContext("2d")!;
  const imgData = sctx.createImageData(W, 1);
  for (let x = 0; x < W; x++) {
    const u = x / W;
    let du = Math.abs(u - frontU);
    if (du > 0.5) du = 1 - du; // wrap to the shorter arc
    const t = du / 0.5; // 0 at front, 1 at antipode
    const brightness = 1 - t * (1 - minBrightness);
    const v = Math.max(0, Math.min(255, Math.round(brightness * 255)));
    const idx = x * 4;
    imgData.data[idx] = v;
    imgData.data[idx + 1] = v;
    imgData.data[idx + 2] = v;
    imgData.data[idx + 3] = 255;
  }
  sctx.putImageData(imgData, 0, 0);
  return strip;
}

// Builds a seamless equirectangular texture from a regular 2D photo.
function makeSyntheticEquirectTexture(source: CanvasImageSource): THREE.CanvasTexture {
  const W = SYNTH_EQUIRECT_W;
  const H = SYNTH_EQUIRECT_H;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const imgEl = source as HTMLImageElement;
  const srcW = (imgEl.naturalWidth > 0 ? imgEl.naturalWidth : imgEl.width) || W;
  const srcH = (imgEl.naturalHeight > 0 ? imgEl.naturalHeight : imgEl.height) || H;

  // 2026-08-26 perf fix (part 2): both layers below read from `source`
  // directly and each does its own high-quality resample of it. Real estate
  // photos are routinely 4000-8000px+ on the long side, and a high-quality
  // canvas resize's cost scales with the SOURCE resolution being read, not
  // just the destination - so doing that expensive read twice (once for the
  // small blur layer, once for the larger sharp patch) was likely most of
  // the remaining cost after the blur-resolution fix. Fix: if the source is
  // meaningfully bigger than the largest thing this function ever draws it
  // into (the sharp patch, ~SHARP_FOV_DEG/360 of W), resample it down ONCE
  // to that size and have both layers read from that instead. This does not
  // reduce the sharp patch's own resolution/quality at all (it's sized to
  // exactly what the patch needs) - it only avoids paying for the expensive
  // full-resolution read a second time for the (already much blurrier) layer
  // 1.
  const sharpWTarget = Math.round(W * (SHARP_FOV_DEG / 360));
  let workingSource: CanvasImageSource = source;
  const longSide = Math.max(srcW, srcH);
  if (longSide > sharpWTarget * 1.4) {
    const scale = sharpWTarget / longSide;
    const preW = Math.max(1, Math.round(srcW * scale));
    const preH = Math.max(1, Math.round(srcH * scale));
    const preCanvas = document.createElement("canvas");
    preCanvas.width = preW;
    preCanvas.height = preH;
    const prectx = preCanvas.getContext("2d")!;
    prectx.imageSmoothingEnabled = true;
    prectx.imageSmoothingQuality = "high";
    prectx.drawImage(source, 0, 0, preW, preH);
    workingSource = preCanvas;
  }

  // ── Layer 1: blurred, dimmed periphery (single copy, never mirrored) ──
  // Draw unblurred first (blurring while sampling from `source` directly can
  // behave inconsistently across browsers for very large source images), then
  // re-draw that result through a CSS blur filter. ctx.filter is reset
  // immediately after so it can never leak into the sharp patch below.
  //
  // 2026-08-26 perf fix: this used to draw+blur at the full 4096x2048 (W x H)
  // resolution - blur(22px) over ~8.4M pixels is what was showing up in
  // DevTools as "'load' handler took 3498ms" and blocking the whole page
  // (including input like scroll/zoom) for that long. This layer is a
  // deliberately soft, out-of-focus periphery by design (see FIX HISTORY
  // above) - it's never meant to be sharp - so doing the blur at a much
  // smaller resolution and scaling the already-blurred result back up costs
  // a fraction of the compute and looks visually indistinguishable, since
  // upscaling a blur only softens it slightly further. Nothing about the
  // final composited output's appearance (blur radius, vignette, sharp
  // patch) is changed - only how cheaply layer 1 gets there.
  const BLUR_DOWNSCALE = 4;
  const smallW = Math.max(1, Math.round(W / BLUR_DOWNSCALE));
  const smallH = Math.max(1, Math.round(H / BLUR_DOWNSCALE));
  const baseFill = document.createElement("canvas");
  baseFill.width = smallW;
  baseFill.height = smallH;
  const bctx = baseFill.getContext("2d")!;
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  bctx.drawImage(workingSource, 0, 0, smallW, smallH);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.filter = `blur(${22 / BLUR_DOWNSCALE}px)`;
  ctx.drawImage(baseFill, 0, 0, smallW, smallH, 0, 0, W, H);
  ctx.filter = "none";

  // Vignette: dims the periphery toward the antipode so the never-captured
  // "behind you" direction reads as intentional shadow, not a quality dip.
  const vignette = buildVignetteStrip(W, FRONT_U, VIGNETTE_MIN_BRIGHTNESS);
  ctx.globalCompositeOperation = "multiply";
  ctx.drawImage(vignette, 0, 0, W, H);
  ctx.globalCompositeOperation = "source-over";

  // ── Layer 2: sharp, undistorted forward patch ──
  const sharpW = sharpWTarget;
  const sharpAspect = srcW / srcH;
  const sharpH = Math.min(H, Math.round(sharpW / sharpAspect));
  const sharpX = Math.round(W * FRONT_U - sharpW / 2);
  const sharpY = Math.round((H - sharpH) / 2);
  const sharpPatch = buildFeatheredPatch(workingSource, sharpW, sharpH, 0.1, 0.12);
  // SHARP_FOV_DEG can exceed 180°, in which case sharpW > W/2 and a plain
  // drawImage at sharpX can run past the canvas's right edge (or start
  // before its left edge) and get clipped by the canvas bounds instead of
  // wrapping around — since this canvas IS the full 360° wrap, that would
  // leave a real gap. Normalize sharpX into [0, W) and, if the patch would
  // still overflow the right edge from there, split the draw at the wrap
  // boundary using the patch's own source-rect to crop each half correctly.
  let wrappedX = sharpX % W;
  if (wrappedX < 0) wrappedX += W;
  if (wrappedX + sharpW <= W) {
    ctx.drawImage(sharpPatch, wrappedX, sharpY);
  } else {
    const firstW = W - wrappedX;
    const secondW = sharpW - firstW;
    ctx.drawImage(sharpPatch, 0, 0, firstW, sharpH, wrappedX, sharpY, firstW, sharpH);
    ctx.drawImage(sharpPatch, firstW, 0, secondW, sharpH, 0, sharpY, secondW, sharpH);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 2026-08-26 fix (4): real, already-equirectangular panoramas (isPano===true)
// were rendered fully sharp in every direction - no softening as you rotate
// away from the front, which is the specific "back should be blurry" look
// reported missing. Unlike makeSyntheticEquirectTexture, this does NOT
// resize/reshape the photo into a narrower "patch" at a different aspect
// ratio (that function is built for a normal, non-panoramic photo that needs
// to be squeezed into a wrap; a real panorama is already the full wrap) - it
// draws the same real photo at its own native resolution twice (once sharp,
// once blurred+dimmed via the same vignette used above) and blends between
// them purely by horizontal distance from FRONT_U, so the photo itself is
// never stretched, squeezed, or cropped differently between the two copies.
function applyRotationVignetteToPano(source: CanvasImageSource, srcW: number, srcH: number): THREE.CanvasTexture {
  const W = srcW;
  const H = srcH;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Sharp base: the real photo, full resolution, completely untouched.
  ctx.drawImage(source, 0, 0, W, H);

  // Blurred, dimmed copy of the SAME photo at the SAME size (downscale-then-
  // blur-then-upscale trick from makeSyntheticEquirectTexture, so this stays
  // cheap even on large panoramas).
  const BLUR_DOWNSCALE = 4;
  const smallW = Math.max(1, Math.round(W / BLUR_DOWNSCALE));
  const smallH = Math.max(1, Math.round(H / BLUR_DOWNSCALE));
  const small = document.createElement("canvas");
  small.width = smallW;
  small.height = smallH;
  const sctx = small.getContext("2d")!;
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(source, 0, 0, smallW, smallH);

  const blurLayer = document.createElement("canvas");
  blurLayer.width = W;
  blurLayer.height = H;
  const bctx = blurLayer.getContext("2d")!;
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  bctx.filter = `blur(${22 / BLUR_DOWNSCALE}px)`;
  bctx.drawImage(small, 0, 0, smallW, smallH, 0, 0, W, H);
  bctx.filter = "none";

  const vignette = buildVignetteStrip(W, FRONT_U, VIGNETTE_MIN_BRIGHTNESS);
  bctx.globalCompositeOperation = "multiply";
  bctx.drawImage(vignette, 0, 0, W, H);
  bctx.globalCompositeOperation = "source-over";

  // Composite the blurred layer over the sharp base in narrow vertical
  // strips, each with its own opacity based on that strip's angular
  // distance from FRONT_U (0% opacity right at the front, so the sharp
  // base alone shows through there; ramping to 100% opacity past the sharp
  // zone). Plain globalAlpha + drawImage per strip - deliberately simple
  // (no separate alpha-mask canvas/compositing chain) so there's nothing
  // subtle to get wrong here. t is du normalized so 1.0 = the antipode
  // (180deg away); SHARP_FOV_DEG/360 converts the sharp patch's full
  // angular width into that same t-normalized scale.
  const STRIPS = 180;
  const stripW = W / STRIPS;
  const sharpHalfFrac = SHARP_FOV_DEG / 360;
  ctx.imageSmoothingEnabled = false;
  for (let i = 0; i < STRIPS; i++) {
    const xStart = i * stripW;
    const uCenter = (xStart + stripW / 2) / W;
    let du = Math.abs(uCenter - FRONT_U);
    if (du > 0.5) du = 1 - du;
    const t = du / 0.5;
    const alpha = t <= sharpHalfFrac ? 0 : Math.min(1, (t - sharpHalfFrac) / (1 - sharpHalfFrac));
    if (alpha <= 0.002) continue;
    ctx.globalAlpha = alpha;
    ctx.drawImage(blurLayer, xStart, 0, stripW, H, xStart, 0, stripW, H);
  }
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = true;

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}


export default function PanoWalkthrough({ projectId, listingId, onFallback, topInset = 0 }: PanoWalkthroughProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Root wrapper (canvas + every HUD overlay) - the fullscreen target, so
  // fullscreen includes the HUD rather than just the raw WebGL canvas.
  const rootRef = useRef<HTMLDivElement>(null);
  // Drag target for the 2D CSS-pan fallback (webglFailed) view only - see the
  // fallback look-around effect below.
  const fallbackContainerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Three.js References
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const materialCurrentRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const materialNextRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const meshCurrentRef = useRef<THREE.Mesh | null>(null);
  const meshNextRef = useRef<THREE.Mesh | null>(null);
  const sphereGeometryRef = useRef<THREE.SphereGeometry | null>(null);

  // 2026-08-26 fix: kept as a ref (rather than closed over directly) so the
  // scene-setup effect below doesn't have to depend on loadTextureIntoMaterial
  // itself - see that effect's comment for why that dependency was the actual
  // bug. Always points at the latest loadTextureIntoMaterial via the sync
  // effect right after its declaration.
  const loadTextureIntoMaterialRef = useRef<
    ((url: string, material: THREE.MeshBasicMaterial | null, mesh: THREE.Mesh | null) => Promise<boolean>) | null
  >(null);

  // Radial iris-wipe shader uniforms, keyed per-material so either buffer
  // (current/next) can drive the reveal effect whichever role it plays.
  const irisUniformsMapRef = useRef<WeakMap<THREE.MeshBasicMaterial, IrisUniforms>>(new WeakMap());

  // Preload cache: textures (and, for flat photos, the synthetic equirect
  // wrap already baked) for waypoints adjacent to the current one, warmed
  // ahead of time so a transition never races a network fetch or the
  // canvas-based synthetic-wrap generation.
  const preloadCacheRef = useRef<Map<string, { renderTex: THREE.Texture; isPano: boolean }>>(new Map());
  const preloadingSetRef = useRef<Set<string>>(new Set());

  // Controls State
  const yawRef = useRef<number>(0);
  const pitchRef = useRef<number>(0);
  const targetYawRef = useRef<number>(0);
  const targetPitchRef = useRef<number>(0);
  const yawVelocityRef = useRef<number>(0);
  const pitchVelocityRef = useRef<number>(0);
  const friction = 0.88;

  // FOV Zoom State
  const currentFovRef = useRef<number>(75);
  const targetFovRef = useRef<number>(75);

  // Touch & Pointer state
  const isPointerDownRef = useRef<boolean>(false);
  const lastPointerXRef = useRef<number>(0);
  const lastPointerYRef = useRef<number>(0);
  const pinchStartDistRef = useRef<number>(0);
  const keysRef = useRef<Record<string, boolean>>({});

  // Transition Lock & Mode Ref
  const isTransitioningRef = useRef<boolean>(false);
  const is360Ref = useRef<boolean>(true);

  // Component Data State
  const [loading, setLoading] = useState(true);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);
  const [viewMode, setViewMode] = useState<"tour" | "dollhouse" | "floorplan">("tour");
  const [is360State, setIs360State] = useState<boolean>(true);
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [hotspots, setHotspots] = useState<Hotspot[]>([]);
  const [activeTooltip, setActiveTooltip] = useState<{ title: string; description: string; x: number; y: number } | null>(null);
  const [autoDetectState, setAutoDetectState] = useState<"idle" | "running" | "done" | "empty" | "error">("idle");
  // Diagnostic text from the backend (raw_detections_total vs. generated) so
  // "YOLO found nothing at all" reads differently from "found some but they
  // got filtered out" instead of both looking like a silent empty result.
  const [autoDetectMessage, setAutoDetectMessage] = useState<string | null>(null);
  const [autoDetectCount, setAutoDetectCount] = useState<number | null>(null);

  const mapCanvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const minimapPointsRef = useRef<{ index: number; sx: number; sy: number }[]>([]);
  const [textureLoading, setTextureLoading] = useState<boolean>(false);
  const [webglFailed, setWebglFailed] = useState<boolean>(false);
  const [yaw2D, setYaw2D] = useState<number>(0);
  const [pitch2D, setPitch2D] = useState<number>(0);

  // Helper to resolve image URL
  const resolveUrl = useCallback((wp: Waypoint) => {
    if (wp.image_url) {
      if (wp.image_url.startsWith("http")) return wp.image_url;
      if (wp.image_url.startsWith("/")) return `${BASE}${wp.image_url}`;
    }
    if (wp.raw_image_url) {
      if (wp.raw_image_url.startsWith("http")) return wp.raw_image_url;
      if (wp.raw_image_url.startsWith("/")) return `${BASE}${wp.raw_image_url}`;
    }
    const baseName = wp.filename ? wp.filename.replace(/\.[^/.]+$/, "") : "";
    return `${BASE}/data/project_${projectId}/images/${baseName || "0"}.jpg`;
  }, [projectId]);

  // Pure texture-processing step: given an already-loaded THREE.Texture,
  // produces the final render-ready texture (the real pano texture, wrapped
  // and filtered; or a freshly-built synthetic equirect for a flat photo).
  // Touches no mesh/material, so it's safe to run ahead of time for preloading.
  const buildRenderTexture = useCallback((tex: THREE.Texture): { renderTex: THREE.Texture; isPano: boolean } => {
    const img = tex.image as { width?: number; height?: number } | undefined;
    const aspect = img && img.width && img.height ? img.width / img.height : 2;
    const isPano = aspect >= 1.85 && aspect <= 2.15;

    // 2026-08-26 fix: both branches used to set generateMipmaps=true with
    // LinearMipmapLinearFilter. Mipmap chain generation for a large,
    // non-power-of-two photo (real estate panoramas routinely are, e.g.
    // 4000x2000) can silently corrupt on some GPU/driver combinations
    // (common under software-rendered or virtualized graphics) - the
    // corrupted mip levels show up as exactly the blocky/checkerboard or
    // solid-black patches reported while rotating (rotation changes how
    // much the sphere surface is minified on screen, which is what decides
    // which mip level gets sampled - the straight-on forward view can look
    // fine while a rotated view samples a broken level). Disabling mipmaps
    // and using plain bilinear filtering removes the failure mode entirely;
    // it costs a little minification sharpness at extreme zoom-out, not a
    // change to the photo, the wrap, or the sphere itself.
    // 2026-08-26 fix (4) RESTORED: sharp-front/blurred-back treatment via
    // applyRotationVignetteToPano, confirmed wanted after all.
    let renderTex: THREE.Texture;
    if (isPano) {
      const imgEl = tex.image as HTMLImageElement;
      const srcW = (imgEl.naturalWidth > 0 ? imgEl.naturalWidth : imgEl.width) || 4096;
      const srcH = (imgEl.naturalHeight > 0 ? imgEl.naturalHeight : imgEl.height) || 2048;
      renderTex = applyRotationVignetteToPano(tex.image as CanvasImageSource, srcW, srcH);
      renderTex.wrapS = THREE.RepeatWrapping;
      renderTex.wrapT = THREE.ClampToEdgeWrapping;
      renderTex.repeat.set(1, 1);
      renderTex.offset.set(0, 0);
      renderTex.generateMipmaps = false;
      renderTex.minFilter = THREE.LinearFilter;
      renderTex.magFilter = THREE.LinearFilter;
      if (rendererRef.current) {
        renderTex.anisotropy = rendererRef.current.capabilities.getMaxAnisotropy();
      }
      tex.dispose();
    } else {
      renderTex = makeSyntheticEquirectTexture(tex.image as CanvasImageSource);
      renderTex.generateMipmaps = false;
      renderTex.minFilter = THREE.LinearFilter;
      renderTex.magFilter = THREE.LinearFilter;
      renderTex.wrapS = THREE.RepeatWrapping;
      renderTex.wrapT = THREE.ClampToEdgeWrapping;
      renderTex.repeat.set(1, 1);
      renderTex.offset.set(0, 0);
      if (rendererRef.current) {
        renderTex.anisotropy = rendererRef.current.capabilities.getMaxAnisotropy();
      }
    }

    return { renderTex, isPano };
  }, []);

  // Cheap, synchronous step: assigns an already-built render texture onto a
  // mesh/material slot and configures the sphere geometry/side.
  const assignRenderTexture = useCallback((renderTex: THREE.Texture, isPano: boolean, material: THREE.MeshBasicMaterial | null, mesh: THREE.Mesh | null): boolean => {
    if (!material || !mesh) return isPano;
    if (sphereGeometryRef.current) {
      mesh.geometry = sphereGeometryRef.current;
    }
    mesh.position.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    material.side = THREE.BackSide;

    if (material.map && material.map !== renderTex) {
      material.map.dispose();
    }
    material.map = renderTex;
    material.needsUpdate = true;

    return isPano;
  }, []);

  // Injects a radial iris-wipe mask into a standard MeshBasicMaterial via
  // onBeforeCompile, rather than hand-rolling a full custom ShaderMaterial —
  // this way Three.js's built-in sRGB decode/encode and map-sampling chunks
  // stay intact and we only bolt on the circular reveal logic. uIrisEnabled
  // is off by default (material renders exactly like a plain textured
  // sphere); a transition flips it on for the incoming ("pending") mesh only.
  const attachIrisShader = useCallback((material: THREE.MeshBasicMaterial): IrisUniforms => {
    const uniforms: IrisUniforms = {
      uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uRadius: { value: 0 },
      uFeather: { value: 0.07 },
      uIrisEnabled: { value: 0 },
    };

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uCenter = uniforms.uCenter;
      shader.uniforms.uResolution = uniforms.uResolution;
      shader.uniforms.uRadius = uniforms.uRadius;
      shader.uniforms.uFeather = uniforms.uFeather;
      shader.uniforms.uIrisEnabled = uniforms.uIrisEnabled;

      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
        uniform vec2 uCenter;
        uniform vec2 uResolution;
        uniform float uRadius;
        uniform float uFeather;
        uniform float uIrisEnabled;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
        if (uIrisEnabled > 0.5) {
          vec2 res = max(uResolution, vec2(1.0, 1.0));
          vec2 screenUV = gl_FragCoord.xy / res;
          vec2 d = vec2((screenUV.x - uCenter.x) * (res.x / res.y), screenUV.y - uCenter.y);
          float dist = length(d);
          float mask = 1.0 - smoothstep(max(0.0, uRadius - uFeather), max(0.001, uRadius), dist);
          if (mask <= 0.001) discard;
          gl_FragColor.a *= mask;
        }`
      );
    };
    material.needsUpdate = true;

    return uniforms;
  }, []);

  // Texture loader: loads an image into a specific mesh/material slot with
  // high-res anisotropic filtering and projects it onto the sphere.
  // Resolves with whether the source was a genuine captured panorama.
  // Checks the preload cache first — if the target waypoint's texture was
  // already warmed in the background, this resolves instantly with no
  // network fetch or synthetic-wrap generation on the critical path.
  const loadTextureIntoMaterial = useCallback((url: string, material: THREE.MeshBasicMaterial | null, mesh: THREE.Mesh | null): Promise<boolean> => {
    if (webglFailed || !material || !mesh) return Promise.resolve(false);
    const cached = preloadCacheRef.current.get(url);
    if (cached) {
      preloadCacheRef.current.delete(url);
      return Promise.resolve(assignRenderTexture(cached.renderTex, cached.isPano, material, mesh));
    }

    return new Promise((resolve) => {
      const loader = new THREE.TextureLoader();
      loader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          const { renderTex, isPano } = buildRenderTexture(tex);
          resolve(assignRenderTexture(renderTex, isPano, material, mesh));
        },
        undefined,
        () => {
          const canvas = document.createElement("canvas");
          canvas.width = 2048;
          canvas.height = 1024;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "#0f172a";
          ctx.fillRect(0, 0, 2048, 1024);
          ctx.fillStyle = "#06b6d4";
          ctx.font = "bold 48px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(`WAYPOINT ${currentFrame + 1}`, 1024, 512);

          const tex = new THREE.CanvasTexture(canvas);
          tex.colorSpace = THREE.SRGBColorSpace;
          const { renderTex, isPano } = buildRenderTexture(tex);
          resolve(assignRenderTexture(renderTex, isPano, material, mesh));
        }
      );
    });
  }, [currentFrame, buildRenderTexture, assignRenderTexture]);

  // Keep the ref in sync every render - cheap (just a pointer write), and
  // lets the scene-setup effect call the always-current loadTextureIntoMaterial
  // without needing it in that effect's own dependency array.
  useEffect(() => {
    loadTextureIntoMaterialRef.current = loadTextureIntoMaterial;
  }, [loadTextureIntoMaterial]);

  // Warms a waypoint's texture (and, for flat photos, bakes the synthetic
  // equirect wrap) into the preload cache without touching any mesh. Safe to
  // call speculatively — no-ops if already cached or in flight.
  const preloadWaypointTexture = useCallback((url: string | undefined) => {
    if (webglFailed || !url || preloadCacheRef.current.has(url) || preloadingSetRef.current.has(url)) return;
    preloadingSetRef.current.add(url);
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (tex) => {
        preloadingSetRef.current.delete(url);
        tex.colorSpace = THREE.SRGBColorSpace;
        const { renderTex, isPano } = buildRenderTexture(tex);
        preloadCacheRef.current.set(url, { renderTex, isPano });
      },
      undefined,
      () => {
        preloadingSetRef.current.delete(url);
      }
    );
  }, [buildRenderTexture]);

  // Fetch waypoints & hotspots
  useEffect(() => {
    let active = true;

    async function fetchData() {
      try {
        setLoading(true);

        // W1-48: a listingId switches this viewer into multi-room mode -
        // one request returns EVERY room's waypoints already merged into a
        // single listing-frame graph (backend/services/
        // listing_assembly_service.py), with hotspots included in the same
        // payload, so there's no second /hotspots request needed here.
        if (listingId !== undefined) {
          const sceneRes = await fetch(`${BASE}/api/listings/${listingId}/scene`);
          const sceneData = await sceneRes.json();
          if (!active) return;

          const wps: Waypoint[] = sceneData.waypoints || [];
          setWaypoints(wps);
          setTotalFrames(wps.length);
          setHotspots(sceneData.hotspots || []);
          return;
        }

        const wpRes = await fetch(`${BASE}/api/projects/${projectId}/waypoints`);
        const wpData = await wpRes.json();

        let hotData: { hotspots: Hotspot[] } = { hotspots: [] };
        try {
          const hr = await fetch(`${BASE}/api/projects/${projectId}/hotspots`);
          hotData = await hr.json();
        } catch { }

        if (!active) return;

        const wps: Waypoint[] = wpData.waypoints || [];
        setWaypoints(wps);
        setTotalFrames(wps.length);
        setHotspots(hotData.hotspots || []);
      } catch (err) {
        console.error("Failed to fetch waypoints:", err);
      } finally {
        if (active) setLoading(false);
      }
    }

    fetchData();

    return () => {
      active = false;
    };
  }, [projectId, listingId]);

  // Runs YOLO object detection (if not already cached) and converts the
  // results into hotspots placed on the correct waypoint/yaw/pitch.
  // See backend/services/detection_service.py:generate_hotspots_from_detections.
  // Not available in multi-room listing mode - detection runs per-project,
  // and a merged listing scene has no single project_id to run it against.
  const handleAutoDetectObjects = useCallback(async () => {
    if (autoDetectState === "running") return;

    setAutoDetectState("running");
    setAutoDetectMessage(null);
    try {
      let data: any;
      if (listingId !== undefined) {
        const res = await fetch(`${BASE}/api/listings/${listingId}/auto-generate`, { method: "POST" });
        if (!res.ok) throw new Error(`Listing auto-generate failed: ${res.status}`);
        data = await res.json();
        if (data.hotspots) setHotspots(data.hotspots);
        if (data.waypoints) setWaypoints(data.waypoints);
      } else {
        const targetProjId = projectId ?? waypoints[currentFrame]?.project_id;
        if (!targetProjId) return;
        const res = await fetch(`${BASE}/api/projects/${targetProjId}/hotspots/auto-generate`, { method: "POST" });
        if (!res.ok) throw new Error(`Auto-generate failed: ${res.status}`);
        data = await res.json();
        const hr = await fetch(`${BASE}/api/projects/${targetProjId}/hotspots`);
        if (hr.ok) {
          const hData = await hr.json();
          setHotspots(hData.hotspots || data.hotspots || []);
        } else {
          setHotspots(data.hotspots || []);
        }
      }

      const generated = data.generated ?? (data.hotspots || []).length;
      setAutoDetectCount(generated);
      setAutoDetectMessage(data.message ?? null);
      setAutoDetectState(generated > 0 ? "done" : "empty");
      setTimeout(() => setAutoDetectState("idle"), generated > 0 ? 2500 : 4000);
    } catch (err) {
      console.error("Auto object detection failed:", err);
      setAutoDetectState("error");
      setAutoDetectMessage(err instanceof Error ? err.message : "Detection failed");
      setTimeout(() => setAutoDetectState("idle"), 3000);
    }
  }, [projectId, listingId, waypoints, currentFrame, autoDetectState]);

  // Fullscreen toggle for the walkthrough - requests fullscreen on the
  // component's own root element (not document.body) so the rest of the
  // host page's chrome stays out of it, matching what "full screen for the
  // walkthrough" actually means here.
  const toggleFullscreen = useCallback(() => {
    if (typeof document === "undefined") return;
    if (!document.fullscreenElement) {
      rootRef.current?.requestFullscreen?.().catch((err) => {
        console.error("Failed to enter fullscreen:", err);
      });
    } else {
      document.exitFullscreen?.().catch((err) => {
        console.error("Failed to exit fullscreen:", err);
      });
    }
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onFsChange = () => setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // Preload the textures for waypoints REACHABLE from the current one so a
  // transition never races a network fetch or synthetic-wrap generation.
  // Also prunes cached entries that fell out of the adjacency window so the
  // cache doesn't grow unbounded across a long session.
  //
  // FIX (transition stutter / "feels like a presentation" complaint): this
  // used to only warm currentFrame ± 1 (linear neighbors). But the actual
  // clickable nav-ring targets are the current waypoint's `connections`
  // (the backend's wall/line-of-sight-aware graph — see the nav-ring fix
  // above), which for real captured data are almost never just the
  // sequential frame before/after. Every click-to-move was therefore
  // hitting a COLD cache — a real network fetch + texture decode + the
  // synthetic-equirect canvas build, all happening mid-transition, which is
  // exactly what makes a jump read as "loading the next slide" instead of
  // "walking". Now the actual reachable set is what's kept warm.
  useEffect(() => {
    if (waypoints.length === 0) return;

    const currWp = waypoints.find((w) => w.index === currentFrame);
    const reachable = (Array.isArray(currWp?.connections) && currWp.connections.length > 0)
      ? currWp.connections
      : [currentFrame - 1, currentFrame + 1];

    const neighborUrls = new Set<string>();
    reachable.forEach((idx) => {
      const wp = waypoints.find((w) => w.index === idx);
      if (wp) {
        const url = resolveUrl(wp);
        neighborUrls.add(url);
        preloadWaypointTexture(url);
      }
    });

    preloadCacheRef.current.forEach((entry, url) => {
      if (!neighborUrls.has(url)) {
        entry.renderTex.dispose();
        preloadCacheRef.current.delete(url);
      }
    });
  }, [currentFrame, waypoints, resolveUrl, preloadWaypointTexture]);

  // Google Street View-style dolly + Matterport-style radial iris wipe:
  // FOV zooms in while the next frame (usually already preloaded) is ready,
  // then a circular reveal grows from the click point (or screen centre for
  // keyboard moves) while dollying back out, same look direction throughout.
  const executeWalkTransitionToNode = useCallback(async (
    targetIdx: number,
    targetEntryYaw?: number,
    clickX?: number,
    clickY?: number
  ) => {
    if (isTransitioningRef.current || targetIdx === currentFrame) return;
    if (webglFailed || !materialCurrentRef.current || !meshCurrentRef.current || !materialNextRef.current || !meshNextRef.current) {
      setCurrentFrame(targetIdx);
      if (targetEntryYaw !== undefined) {
        targetYawRef.current = targetEntryYaw;
      }
      return;
    }
    isTransitioningRef.current = true;

    const targetWp = waypoints.find((w) => w.index === targetIdx);
    if (!targetWp) {
      isTransitioningRef.current = false;
      return;
    }

    const activeMaterial = materialCurrentRef.current!;
    const activeMesh = meshCurrentRef.current!;
    const pendingMaterial = materialNextRef.current!;
    const pendingMesh = meshNextRef.current!;

    const targetUrl = resolveUrl(targetWp);
    // Only show a loading indicator when this is an actual cache miss (e.g.
    // a floor-plan click straight to a distant, never-preloaded waypoint) -
    // adjacent nav-ring hops are almost always already warmed and shouldn't
    // flash a spinner.
    const wasPreloaded = preloadCacheRef.current.has(targetUrl);
    if (!wasPreloaded) setTextureLoading(true);
    const texturePromise = loadTextureIntoMaterial(targetUrl, pendingMaterial, pendingMesh);

    // Also start warming the frames REACHABLE from the target (its own
    // connections graph, same fix as the effect above) so the *next* hop
    // after this one lands has zero load-triggered stutter too.
    const targetReachable = (Array.isArray(targetWp.connections) && targetWp.connections.length > 0)
      ? targetWp.connections
      : [targetIdx - 1, targetIdx + 1];
    targetReachable.forEach((idx) => {
      if (idx === currentFrame) return;
      const wp = waypoints.find((w) => w.index === idx);
      if (wp) preloadWaypointTexture(resolveUrl(wp));
    });

    // Phase 1: Dolly forward (FOV zoom in) while the next frame loads.
    const startFov = currentFovRef.current;
    const targetFovIn = 34;
    const durationIn = 260;
    const startTimeIn = performance.now();

    await new Promise<void>((res) => {
      const step = (now: number) => {
        const progress = Math.min(1.0, (now - startTimeIn) / durationIn);
        const eased = easeInQuad(progress);
        targetFovRef.current = startFov + (targetFovIn - startFov) * eased;

        if (progress < 1.0) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });

    const isPano = await texturePromise;
    if (!wasPreloaded) setTextureLoading(false);

    // Configure the radial iris reveal, centred on the click point (screen
    // centre if this move was keyboard-triggered).
    const container = containerRef.current;
    const rect = container?.getBoundingClientRect();
    const normX = rect && clickX !== undefined ? (clickX - rect.left) / rect.width : 0.5;
    const normY = rect && clickY !== undefined ? (clickY - rect.top) / rect.height : 0.5;

    const canvasW = rendererRef.current?.domElement.width || 1;
    const canvasH = rendererRef.current?.domElement.height || 1;
    const aspectRatio = canvasW / canvasH;
    const centerX = normX;
    const centerYGL = 1 - normY; // gl_FragCoord origin is bottom-left; DOM clicks are top-left origin.
    const dxMax = Math.max(centerX, 1 - centerX) * aspectRatio;
    const dyMax = Math.max(centerYGL, 1 - centerYGL);
    const maxRadius = Math.sqrt(dxMax * dxMax + dyMax * dyMax) * 1.08;

    const pendingUniforms = irisUniformsMapRef.current.get(pendingMaterial);

    // Render the pending frame on top so its iris reveal blends correctly over the active one.
    pendingMesh.renderOrder = 1;
    activeMesh.renderOrder = 0;
    pendingMaterial.opacity = 1;
    if (pendingUniforms) {
      pendingUniforms.uCenter.value.set(centerX, centerYGL);
      pendingUniforms.uResolution.value.set(canvasW, canvasH);
      pendingUniforms.uFeather.value = 0.07;
      pendingUniforms.uRadius.value = 0;
      pendingUniforms.uIrisEnabled.value = 1;
    }

    setCurrentFrame(targetIdx);

    // Phase 2: Radial iris reveal grows from the click point while dollying back out.
    const durationOut = 320;
    const startTimeOut = performance.now();
    await new Promise<void>((res) => {
      const step = (now: number) => {
        const progress = Math.min(1.0, (now - startTimeOut) / durationOut);
        const eased = easeOutCubic(progress);

        targetFovRef.current = targetFovIn + (DEFAULT_FOV - targetFovIn) * eased;
        if (pendingUniforms) pendingUniforms.uRadius.value = maxRadius * eased;

        if (progress < 1.0) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });

    // Transition complete: the incoming frame is now fully revealed everywhere.
    // Swap buffer roles and reset both materials to their safe idle states.
    if (pendingUniforms) pendingUniforms.uIrisEnabled.value = 0;
    activeMaterial.opacity = 0;
    const activeUniforms = irisUniformsMapRef.current.get(activeMaterial);
    if (activeUniforms) {
      activeUniforms.uIrisEnabled.value = 0;
      activeUniforms.uRadius.value = 0;
    }

    materialCurrentRef.current = pendingMaterial;
    meshCurrentRef.current = pendingMesh;
    materialNextRef.current = activeMaterial;
    meshNextRef.current = activeMesh;

    is360Ref.current = isPano;
    setIs360State(isPano);
    // Rotation range never changes - every frame is a full 360 sphere.

    if (targetEntryYaw !== undefined) {
      // Smoothly arrive at the bearing without spinning the long way around.
      let delta = targetEntryYaw - yawRef.current;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      targetYawRef.current = yawRef.current + delta;
    }
    // No entry yaw: keep looking the same direction (camera persists across frames).

    isTransitioningRef.current = false;
  }, [currentFrame, waypoints, resolveUrl, loadTextureIntoMaterial, preloadWaypointTexture]);

  // Navigate Graph: Advance frame-by-frame smoothly straight ahead.
  const navigateGraph = useCallback((direction: "forward" | "backward") => {
    if (isTransitioningRef.current || waypoints.length === 0) return;

    const nextFrame = direction === "forward"
      ? Math.min(waypoints.length - 1, currentFrame + 1)
      : Math.max(0, currentFrame - 1);

    if (nextFrame === currentFrame) return;

    // Maintain current straight-ahead camera look direction without auto-rotating left or right
    executeWalkTransitionToNode(nextFrame);
  }, [currentFrame, waypoints, executeWalkTransitionToNode]);

  // Setup Three.js Scene - Invariant Clean Hook Dependency
  useEffect(() => {
    if (loading || waypoints.length === 0 || !containerRef.current) return;

    let cancelled = false;
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    const scene = new THREE.Scene();
    // Default to black void as requested (no synthetic backgrounds)
    scene.background = new THREE.Color("#000000");
    const camera = new THREE.PerspectiveCamera(currentFovRef.current, width / height, 0.1, 2000);
    camera.position.set(0, 0, 0);
    // BUG FIX: cameraRef.current was never assigned anywhere in this file.
    // renderLoop() below reads `cameraRef.current` every frame (`const cam =
    // cameraRef.current; if (!cam || !rend) return;`) and project3DToScreen()
    // does the same for hotspot/nav-ring projection. Without this assignment
    // both silently no-op forever: the scene never calls renderer.render(),
    // so yaw/pitch updates from drag and A/D never reach the screen even
    // though the input handling and camera-direction math are otherwise
    // correct. This is what was making rotation look completely dead.
    cameraRef.current = camera;
    // Silent WebGL probe — prevents Three.js from logging error stack traces when GPU hardware access is disabled by Chrome
    const isWebGLSupported = (() => {
      try {
        const c = document.createElement("canvas");
        return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl")));
      } catch (_) {
        return false;
      }
    })();

    if (!isWebGLSupported) {
      setWebglFailed(true);
      return;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, failIfMajorPerformanceCaveat: false });
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      container.appendChild(renderer.domElement);
      rendererRef.current = renderer;
    } catch (err) {
      try {
        renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, failIfMajorPerformanceCaveat: false, powerPreference: "default" });
        renderer.setSize(width, height);
        renderer.setPixelRatio(1);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        container.appendChild(renderer.domElement);
        rendererRef.current = renderer;
      } catch (err2) {
        console.warn("[PanoWalkthrough] Hardware WebGL context unavailable. Engaging fallback photo mode.", err2);
        setWebglFailed(true);
        return;
      }
    }

    // Dual Mesh Setup (current + pending), crossfaded during transitions.
    // Both meshes always use the same full sphere geometry - every waypoint
    // (real panorama or ordinary photo) renders as a rotatable 360 sphere.
    const materialCurrent = new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: true, opacity: 1.0, depthWrite: false });
    const materialNext = new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: true, opacity: 0.0, depthWrite: false });
    materialCurrentRef.current = materialCurrent;
    materialNextRef.current = materialNext;

    // Attach the radial iris-wipe shader to both buffers so either one can
    // drive the reveal effect whichever role (current/pending) it plays.
    irisUniformsMapRef.current.set(materialCurrent, attachIrisShader(materialCurrent));
    irisUniformsMapRef.current.set(materialNext, attachIrisShader(materialNext));

    const sphereGeometry = new THREE.SphereGeometry(600, 60, 40);
    sphereGeometryRef.current = sphereGeometry;

    const meshCurrent = new THREE.Mesh(sphereGeometry, materialCurrent);
    const meshNext = new THREE.Mesh(sphereGeometry, materialNext);
    meshCurrent.scale.set(1, 1, 1);
    meshNext.scale.set(1, 1, 1);
    meshNext.renderOrder = 1;

    meshCurrentRef.current = meshCurrent;
    meshNextRef.current = meshNext;

    scene.add(meshCurrent);
    scene.add(meshNext);

    // Initial texture load. Goes through the ref (kept in sync by the effect
    // right after loadTextureIntoMaterial's declaration) rather than the
    // closed-over loadTextureIntoMaterial directly - see this effect's own
    // dependency array below for why.
    const initialWp = waypoints.find((w) => w.index === currentFrame) || waypoints[0];
    const initialLoadTextureIntoMaterial = loadTextureIntoMaterialRef.current;
    if (initialLoadTextureIntoMaterial) {
      initialLoadTextureIntoMaterial(resolveUrl(initialWp), materialCurrent, meshCurrent).then((isPano) => {
        if (cancelled) return;
        is360Ref.current = isPano;
        setIs360State(isPano);
      });
    }

    // Pointer & Touch Listeners
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      isPointerDownRef.current = true;
      const clientX = "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const clientY = "touches" in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
      lastPointerXRef.current = clientX;
      lastPointerYRef.current = clientY;

      if ("touches" in e && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDistRef.current = Math.hypot(dx, dy);
      }
    };

    const onPointerMove = (e: MouseEvent | TouchEvent) => {
      if (!isPointerDownRef.current) return;
      // 2026-08-26 fix: isPointerDownRef can get stuck true if a mouseup
      // ever fails to reach this page's window listener (e.g. the button was
      // released while the cursor was outside the browser window/tab) - once
      // stuck, every future mousemove was being treated as an active drag,
      // rotating the view just from hovering with no click at all. Cross-
      // check against the browser's own live button state (e.buttons - a
      // bitmask that's 0 whenever no mouse button is actually held right
      // now, regardless of what our own ref thinks) and self-correct if they
      // disagree. Touch events don't have .buttons, so this only applies to
      // real mouse input; real drags are unaffected since e.buttons is
      // non-zero for the entire duration a button is genuinely held.
      if (!("touches" in e) && (e as MouseEvent).buttons === 0) {
        isPointerDownRef.current = false;
        return;
      }

      if ("touches" in e && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        if (pinchStartDistRef.current > 0) {
          const delta = (pinchStartDistRef.current - dist) * 0.15;
          targetFovRef.current = Math.max(30, Math.min(100, targetFovRef.current + delta));
          pinchStartDistRef.current = dist;
        }
        return;
      }

      const clientX = "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const clientY = "touches" in e ? e.touches[0].clientY : (e as MouseEvent).clientY;

      const deltaX = clientX - lastPointerXRef.current;
      const deltaY = clientY - lastPointerYRef.current;
      lastPointerXRef.current = clientX;
      lastPointerYRef.current = clientY;

      const sensitivity = 0.15 * (currentFovRef.current / 75);
      yawVelocityRef.current = -deltaX * sensitivity;
      pitchVelocityRef.current = -deltaY * sensitivity;

      targetYawRef.current += yawVelocityRef.current;
      targetPitchRef.current += pitchVelocityRef.current;

      // Yaw is always free (full 360 sphere); only pitch is clamped near the poles.
      targetPitchRef.current = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, targetPitchRef.current));
    };

    const onPointerUp = () => {
      isPointerDownRef.current = false;
      pinchStartDistRef.current = 0;
      // 2026-08-26 fix: rotation used to keep gliding/drifting for a beat
      // after releasing (physics-style momentum decaying via `friction`
      // in the render loop below) - reported as feeling "continuous"
      // instead of stopping exactly where you let go, and as a plain
      // click sometimes leaving a small residual drift. Zeroing velocity
      // the instant the pointer lifts makes rotation track input 1:1:
      // it moves exactly while you're dragging and stops the moment you
      // aren't, nothing else.
      yawVelocityRef.current = 0;
      pitchVelocityRef.current = 0;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // 2026-08-26 fix: this used to scale the zoom step directly off
      // e.deltaY's raw magnitude. That magnitude isn't consistent - it
      // depends on deltaMode (pixel vs. line vs. page) and on the OS/
      // browser/input-driver combination, and on some setups (especially
      // virtualized/remote-desktop environments) it can come through as
      // very small or near-zero even for a normal, deliberate scroll -
      // which is exactly "scrolling does nothing." Using only the SIGN of
      // deltaY with a fixed step size makes every wheel tick produce the
      // same visible zoom change no matter how that number is reported.
      const ZOOM_STEP_DEG = 4;
      // TEMP diagnostic - remove once zoom is confirmed working again.
      console.log("[PanoWalkthrough][wheel-diag]", { deltaY: e.deltaY, deltaMode: e.deltaMode, before: targetFovRef.current });
      if (e.deltaY === 0) return;
      const direction = e.deltaY > 0 ? 1 : -1;
      targetFovRef.current = Math.max(30, Math.min(100, targetFovRef.current + direction * ZOOM_STEP_DEG));
      console.log("[PanoWalkthrough][wheel-diag] after:", targetFovRef.current);
    };

    const onDoubleClick = () => {
      targetYawRef.current = 0;
      targetPitchRef.current = 0;
      targetFovRef.current = 75;
    };

    const dom = container;
    dom.addEventListener("mousedown", onPointerDown);
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);
    dom.addEventListener("dblclick", onDoubleClick);

    dom.addEventListener("touchstart", onPointerDown, { passive: false });
    window.addEventListener("touchmove", onPointerMove, { passive: false });
    window.addEventListener("touchend", onPointerUp);

    dom.addEventListener("wheel", onWheel, { passive: false });

    const onResize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    // Main Render Loop
    let animationId: number;
    const renderLoop = () => {
      animationId = requestAnimationFrame(renderLoop);

      if (!isPointerDownRef.current) {
        if (Math.abs(yawVelocityRef.current) > 0.001 || Math.abs(pitchVelocityRef.current) > 0.001) {
          targetYawRef.current += yawVelocityRef.current;
          targetPitchRef.current += pitchVelocityRef.current;

          yawVelocityRef.current *= friction;
          pitchVelocityRef.current *= friction;
        } else {
          yawVelocityRef.current = 0;
          pitchVelocityRef.current = 0;
        }
      }

      // Yaw is always free (full 360 sphere); only pitch is clamped near the poles.
      targetPitchRef.current = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, targetPitchRef.current));

      // Smooth interpolation toward target (inertia feel)
      yawRef.current += (targetYawRef.current - yawRef.current) * 0.12;
      pitchRef.current += (targetPitchRef.current - pitchRef.current) * 0.12;

      // Keep yaw values bounded so they don't grow unbounded over a long session.
      while (yawRef.current > 180) { yawRef.current -= 360; targetYawRef.current -= 360; }
      while (yawRef.current < -180) { yawRef.current += 360; targetYawRef.current += 360; }

      if (webglFailed) {
        setYaw2D(yawRef.current);
        setPitch2D(pitchRef.current);
      }

      const cam = cameraRef.current;
      const rend = rendererRef.current;
      if (!cam || !rend) return;

      if (Math.abs(currentFovRef.current - targetFovRef.current) > 0.01) {
        currentFovRef.current += (targetFovRef.current - currentFovRef.current) * 0.18;
        cam.fov = currentFovRef.current;
        cam.updateProjectionMatrix();
      }

      const yawRad = THREE.MathUtils.degToRad(yawRef.current);
      const pitchRad = THREE.MathUtils.degToRad(pitchRef.current);

      const x = Math.sin(yawRad) * Math.cos(pitchRad);
      const y = Math.sin(pitchRad);
      const z = -Math.cos(yawRad) * Math.cos(pitchRad);

      cam.lookAt(x, y, z);
      rend.render(scene, cam);
    };

    animationId = requestAnimationFrame(renderLoop);

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", onResize);
      dom.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
      dom.removeEventListener("dblclick", onDoubleClick);
      dom.removeEventListener("wheel", onWheel);
      dom.removeEventListener("touchstart", onPointerDown);
      window.removeEventListener("touchmove", onPointerMove);
      window.removeEventListener("touchend", onPointerUp);
      // 2026-08-26 fix: renderer.dispose() only releases the renderer's own
      // internal program/render-list cache - it does NOT dispose geometries,
      // materials, or textures created outside it. Those were never disposed
      // here before, so every time this effect re-ran (which, before the
      // dependency-array fix below, was every single waypoint navigation)
      // the previous sphere geometry, both materials, and their loaded
      // textures leaked as orphaned GPU resources. Left unbounded, that GPU
      // memory/resource churn is what was surfacing as the
      // "VALIDATE_STATUS false" shader validation failure on longer
      // sessions/listings (e.g. the 102-waypoint multi-room listing) - not a
      // shader syntax bug. This only frees resources; it does not change the
      // panoramic sphere rendering, the iris-wipe transition, or camera math.
      if (materialCurrentRef.current) {
        materialCurrentRef.current.map?.dispose();
        materialCurrentRef.current.dispose();
        materialCurrentRef.current = null;
      }
      if (materialNextRef.current) {
        materialNextRef.current.map?.dispose();
        materialNextRef.current.dispose();
        materialNextRef.current = null;
      }
      if (sphereGeometryRef.current) {
        sphereGeometryRef.current.dispose();
        sphereGeometryRef.current = null;
      }
      if (rendererRef.current) {
        try {
          rendererRef.current.dispose();
          if (rendererRef.current.domElement && container.contains(rendererRef.current.domElement)) {
            container.removeChild(rendererRef.current.domElement);
          }
        } catch (_) { }
        rendererRef.current = null;
      }
      cameraRef.current = null;
    };
  // 2026-08-26 fix: this effect creates the WebGLRenderer, camera, scene,
  // sphere geometry, and both materials - the comment above it already says
  // "Invariant Clean Hook Dependency", i.e. it's meant to run once per real
  // mount (or when loading/listing data actually changes), not on every
  // frame navigation. It was, however, listing loadTextureIntoMaterial as a
  // dependency, and loadTextureIntoMaterial's own deps include currentFrame
  // (see its declaration above) - so it gets a new identity on every single
  // waypoint change, which meant this entire effect - full WebGL context,
  // camera, geometry, materials, and all pointer/keyboard/resize listeners -
  // was being torn down and rebuilt on every waypoint navigation instead of
  // just crossfading a texture. That churn (compounded with the leaked
  // geometry/materials fixed in the cleanup above) is the real cause of the
  // "VALIDATE_STATUS false" shader error reported after navigating a
  // 102-waypoint multi-room listing. Fix: read loadTextureIntoMaterial via
  // loadTextureIntoMaterialRef (kept in sync separately, see its useEffect
  // above) instead of depending on it directly here, so this effect only
  // re-runs when it's actually supposed to. Camera/yaw/pitch math, the
  // panoramic sphere setup, and the iris-wipe transition are all unchanged.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, waypoints, resolveUrl, attachIrisShader]);

  // Keyboard loop
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      keysRef.current[k] = true;
      if (e.code) keysRef.current[e.code.toLowerCase()] = true;

      if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "s", "a", "d"].includes(k)) {
        e.preventDefault();
      }

      if (k === "w" || k === "arrowup") {
        navigateGraph("forward");
      } else if (k === "s" || k === "arrowdown") {
        navigateGraph("backward");
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      keysRef.current[k] = false;
      if (e.code) keysRef.current[e.code.toLowerCase()] = false;
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    const keyLoop = () => {
      const keys = keysRef.current;
      const speed = 2.4;

      if (keys["a"] || keys["keya"] || keys["arrowleft"]) {
        targetYawRef.current -= speed;
      }
      if (keys["d"] || keys["keyd"] || keys["arrowright"]) {
        targetYawRef.current += speed;
      }

      animFrameRef.current = requestAnimationFrame(keyLoop);
    };

    animFrameRef.current = requestAnimationFrame(keyLoop);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [navigateGraph]);

  // Fallback-mode look-around loop (2D CSS-pan fallback only).
  // FIX ("not rotating with a and d", client demo): the yaw/pitch smoothing
  // AND all pointer/touch drag wiring used to live entirely inside the WebGL
  // scene-setup effect above, which returns immediately - before any of that
  // code ever runs - whenever isWebGLSupported is false (see
  // `setWebglFailed(true); return;` a bit above). That effect was also the
  // ONLY place yaw2D/pitch2D (the state that actually drives the fallback
  // <img>'s CSS transform, further down) ever got set. Net effect: whenever
  // the 2D fallback photo view engages (WebGL unavailable in the browser),
  // A/D - and drag, and the "Drag Free Look" HUD hint - silently did nothing:
  // targetYawRef kept incrementing correctly from the separate keyboard
  // effect above, but nothing ever read it back out to the screen. This
  // effect is that missing "read it back out" half. It is strictly gated on
  // webglFailed === true, so it can never run at the same time as, or affect
  // in any way, the already-working WebGL 3D-sphere rotation path (which
  // keeps its own independent copy of this same smoothing logic, untouched
  // above) - only the previously-dead fallback path is touched.
  useEffect(() => {
    if (!webglFailed) return;

    let animationId: number;
    const loop = () => {
      animationId = requestAnimationFrame(loop);

      if (!isPointerDownRef.current) {
        if (Math.abs(yawVelocityRef.current) > 0.001 || Math.abs(pitchVelocityRef.current) > 0.001) {
          targetYawRef.current += yawVelocityRef.current;
          targetPitchRef.current += pitchVelocityRef.current;
          yawVelocityRef.current *= friction;
          pitchVelocityRef.current *= friction;
        } else {
          yawVelocityRef.current = 0;
          pitchVelocityRef.current = 0;
        }
      }

      targetPitchRef.current = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, targetPitchRef.current));

      yawRef.current += (targetYawRef.current - yawRef.current) * 0.12;
      pitchRef.current += (targetPitchRef.current - pitchRef.current) * 0.12;

      while (yawRef.current > 180) { yawRef.current -= 360; targetYawRef.current -= 360; }
      while (yawRef.current < -180) { yawRef.current += 360; targetYawRef.current += 360; }

      setYaw2D(yawRef.current);
      setPitch2D(pitchRef.current);
    };
    animationId = requestAnimationFrame(loop);

    // Drag-to-look, mirroring the WebGL path's pointer handling above -
    // wired to the fallback image container itself since there is no
    // renderer.domElement to attach to in fallback mode.
    const dom = fallbackContainerRef.current;

    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      isPointerDownRef.current = true;
      const clientX = "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const clientY = "touches" in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
      lastPointerXRef.current = clientX;
      lastPointerYRef.current = clientY;
    };

    const onPointerMove = (e: MouseEvent | TouchEvent) => {
      if (!isPointerDownRef.current) return;
      // 2026-08-26 fix: same stuck-drag-state guard as the WebGL path's
      // onPointerMove above - see that comment for the full explanation.
      if (!("touches" in e) && (e as MouseEvent).buttons === 0) {
        isPointerDownRef.current = false;
        return;
      }
      const clientX = "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const clientY = "touches" in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
      const deltaX = clientX - lastPointerXRef.current;
      const deltaY = clientY - lastPointerYRef.current;
      lastPointerXRef.current = clientX;
      lastPointerYRef.current = clientY;

      const sensitivity = 0.15;
      yawVelocityRef.current = -deltaX * sensitivity;
      pitchVelocityRef.current = -deltaY * sensitivity;
      targetYawRef.current += yawVelocityRef.current;
      targetPitchRef.current += pitchVelocityRef.current;
      targetPitchRef.current = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, targetPitchRef.current));
    };

    const onPointerUp = () => {
      isPointerDownRef.current = false;
      yawVelocityRef.current = 0;
      pitchVelocityRef.current = 0;
    };

    const onDoubleClick = () => {
      targetYawRef.current = 0;
      targetPitchRef.current = 0;
    };

    if (dom) {
      dom.addEventListener("mousedown", onPointerDown);
      dom.addEventListener("touchstart", onPointerDown, { passive: false });
      dom.addEventListener("dblclick", onDoubleClick);
    }
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);
    window.addEventListener("touchmove", onPointerMove, { passive: false });
    window.addEventListener("touchend", onPointerUp);

    return () => {
      cancelAnimationFrame(animationId);
      if (dom) {
        dom.removeEventListener("mousedown", onPointerDown);
        dom.removeEventListener("touchstart", onPointerDown);
        dom.removeEventListener("dblclick", onDoubleClick);
      }
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
      window.removeEventListener("touchmove", onPointerMove);
      window.removeEventListener("touchend", onPointerUp);
    };
  }, [webglFailed]);

  // ── Navigation markers: show ALL nearby waypoints in every direction ────────
  // Matterport shows every reachable floor waypoint regardless of camera facing.
  // Strategy: PREFER the backend's own wall/line-of-sight-aware graph
  // (build_waypoint_graph, see backend/services/waypoint_graph.py) via
  // wp.connections when it's present - it already voxelizes the point cloud
  // and ray-casts between waypoints so a marker never points straight
  // through a wall. This matters a lot more once a scene can span multiple
  // rooms (W1-48): the old pure-Euclidean fallback below would happily
  // offer a "walk" marker straight into a different room's waypoint any
  // time it happened to land within MAX_SPATIAL_DIST world-units of the
  // current one (rooms are placed only a few metres apart in a listing
  // frame, well inside that radius) even when there is no door between
  // them. wp.connections has no such false positive: for a merged listing
  // scene, a cross-room entry only ever exists where
  // listing_assembly_service.py explicitly wired one from a "door" hotspot.
  // Only when connections is absent/empty (e.g. a degenerate single-frame
  // project, or an older cached waypoints file predating the graph build)
  // do we fall back to the original spatial-proximity heuristic.
  const MAX_SPATIAL_DIST = 12; // world-units radius to include waypoints (fallback path only)
  const currWp = waypoints.find((w) => w.index === currentFrame);
  const hasGraphConnections = Array.isArray(currWp?.connections) && currWp.connections.length > 0;
  const connIndices: number[] = hasGraphConnections
    ? (currWp!.connections as number[]).filter((idx) => idx !== currentFrame && waypoints.some((w) => w.index === idx))
    : waypoints
        .filter(w => w.index !== currentFrame)
        .filter(w => {
          if (currWp?.position && w.position) {
            const dx = w.position.x - currWp.position.x;
            const dz = w.position.z - currWp.position.z;
            return Math.sqrt(dx * dx + dz * dz) <= MAX_SPATIAL_DIST;
          }
          // No position data: show up to 3 neighbours each direction
          return Math.abs(w.index - currentFrame) <= 3;
        })
        .map(w => w.index);

  const navigationMarkers = connIndices.map((connIdx) => {
    const tgtWp = waypoints.find((w) => w.index === connIdx);
    if (!tgtWp || !currWp?.position || !tgtWp.position) {
      const yawDeg = connIdx > currentFrame ? 0 : 180;
      return { connIdx, yaw: yawDeg, pitch: -35 };
    }

    const dx = tgtWp.position.x - currWp.position.x;
    const dz = tgtWp.position.z - currWp.position.z;
    const yawRad = Math.atan2(dx, -dz);
    const yawDeg = THREE.MathUtils.radToDeg(yawRad);
    return { connIdx, yaw: yawDeg, pitch: -35 };
  });

  const activeHotspots = hotspots.filter((h) => {
    const targetId = h.waypoint_index !== undefined ? h.waypoint_index : h.waypoint_id;
    return targetId !== undefined && Number(targetId) === currentFrame;
  });

  const project3DToScreen = (yawDeg: number, pitchDeg: number) => {
    if (!cameraRef.current || !containerRef.current) return null;

    const camera = cameraRef.current;
    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    const yawRad = THREE.MathUtils.degToRad(yawDeg);
    const pitchRad = THREE.MathUtils.degToRad(pitchDeg);
    const radius = 400;

    const worldPos = new THREE.Vector3(
      radius * Math.sin(yawRad) * Math.cos(pitchRad),
      radius * Math.sin(pitchRad),
      -radius * Math.cos(yawRad) * Math.cos(pitchRad)
    );

    const cameraDir = new THREE.Vector3();
    camera.getWorldDirection(cameraDir);
    const hotspotDir = worldPos.clone().normalize();
    const dot = cameraDir.dot(hotspotDir);

    // dot <= -0.3 means the point can be up to ~107° off-axis from camera forward
    // — this lets waypoints show even when they are behind or to the sides
    if (dot <= -0.3) return null;

    const projected = worldPos.clone().project(camera);
    const screenX = (projected.x + 1) * width / 2;
    const screenY = (-projected.y + 1) * height / 2;

    if (screenX < -50 || screenX > width + 50 || screenY < -50 || screenY > height + 50) return null;

    return { x: screenX, y: screenY, dot };
  };

  // Render MiniMap Canvas
  useEffect(() => {
    if (viewMode === "tour" || !mapCanvasRef.current || waypoints.length === 0) return;
    const canvas = mapCanvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    waypoints.forEach((wp) => {
      if (wp.position) {
        minX = Math.min(minX, wp.position.x);
        maxX = Math.max(maxX, wp.position.x);
        minZ = Math.min(minZ, wp.position.z);
        maxZ = Math.max(maxZ, wp.position.z);
      }
    });

    const rangeX = (maxX - minX) || 1;
    const rangeZ = (maxZ - minZ) || 1;
    const scale = Math.min((width - 60) / rangeX, (height - 60) / rangeZ);

    const getScreenCoords = (x: number, z: number) => {
      const sx = 30 + (x - minX) * scale;
      const sy = 30 + (z - minZ) * scale;
      return { sx, sy };
    };

    ctx.strokeStyle = "rgba(99, 102, 241, 0.4)";
    ctx.lineWidth = 3;
    waypoints.forEach((wp) => {
      if (!wp.position) return;
      const { sx: x1, sy: y1 } = getScreenCoords(wp.position.x, wp.position.z);
      const conns = Array.isArray(wp.connections) && wp.connections.length > 0 ? wp.connections : [wp.index + 1];

      conns.forEach((cid) => {
        const target = waypoints.find((w) => w.index === cid);
        if (target && target.position) {
          const { sx: x2, sy: y2 } = getScreenCoords(target.position.x, target.position.z);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      });
    });

    const points: { index: number; sx: number; sy: number }[] = [];
    waypoints.forEach((wp) => {
      if (!wp.position) return;
      const { sx, sy } = getScreenCoords(wp.position.x, wp.position.z);
      const isCurrent = wp.index === currentFrame;
      points.push({ index: wp.index, sx, sy });

      ctx.beginPath();
      ctx.arc(sx, sy, isCurrent ? 9 : 5, 0, Math.PI * 2);
      ctx.fillStyle = isCurrent ? "#06b6d4" : "rgba(255, 255, 255, 0.75)";
      ctx.fill();

      if (isCurrent) {
        ctx.strokeStyle = "white";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    });
    minimapPointsRef.current = points;
  }, [viewMode, waypoints, currentFrame]);

  // Click-to-teleport: floor plan mode was purely decorative before this —
  // clicking a waypoint dot now jumps the walkthrough there via the same
  // dolly + iris transition used for the in-scene nav rings.
  const handleMinimapClick = useCallback((e: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = mapCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clickX = (e.clientX - rect.left) * scaleX;
    const clickY = (e.clientY - rect.top) * scaleY;

    let nearest: { index: number; sx: number; sy: number } | null = null;
    let nearestDist = Infinity;
    for (const p of minimapPointsRef.current) {
      const d = Math.hypot(p.sx - clickX, p.sy - clickY);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = p;
      }
    }

    const HIT_RADIUS = 22; // canvas-internal px
    if (nearest && nearestDist <= HIT_RADIUS && nearest.index !== currentFrame && !isTransitioningRef.current) {
      setViewMode("tour");
      executeWalkTransitionToNode(nearest.index);
    }
  }, [currentFrame, executeWalkTransitionToNode]);

  if (loading) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-[#050508] gap-3 select-none">
        <span className="w-10 h-10 border-4 border-cyan-500/20 border-t-cyan-500 rounded-full animate-spin" />
        <p className="text-cyan-300 text-sm font-semibold">Loading Walkthrough…</p>
      </div>
    );
  }

  if (!waypoints.length) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-[#050508] p-6 text-center select-none">
        <div className="max-w-lg p-8 bg-black/80 border border-white/15 rounded-3xl backdrop-blur-2xl shadow-2xl flex flex-col items-center gap-5">
          <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 text-3xl shadow-inner">
            📷
          </div>
          <div className="space-y-2">
            <h3 className="text-xl font-bold text-white">Panorama Tour Mode</h3>
            <p className="text-xs text-gray-300 leading-relaxed max-w-sm mx-auto">
              No photos found for this project.
            </p>
          </div>

          {onFallback && (
            <button
              onClick={onFallback}
              className="w-full py-3 px-5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold text-xs shadow-lg shadow-emerald-500/30 transition-all flex items-center justify-center gap-2"
            >
              ✨ View in 3D Splat Engine
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onClick={() => rootRef.current?.focus()}
      className="w-full h-full relative overflow-hidden bg-[#0a0a0f] select-none outline-none"
    >
      {/* 2D Fallback Photo Viewer Container when WebGL is unavailable */}
      {webglFailed && (
        <div ref={fallbackContainerRef} className="absolute inset-0 z-0 overflow-hidden bg-[#05050a] cursor-grab active:cursor-grabbing touch-none">
          {waypoints[currentFrame] && (
            <img
              src={resolveUrl(waypoints[currentFrame])}
              alt={`Waypoint ${currentFrame + 1}`}
              className="absolute h-[140%] w-auto max-w-none select-none transition-transform duration-75 ease-out"
              style={{
                left: '50%',
                top: '50%',
                // FIX ("a has become d and d has become a"): sliding the
                // image itself by +yaw2D moves it in the OPPOSITE visual
                // direction from turning a camera by +yaw - shifting the
                // photo right under a fixed viewport reveals content that
                // was to its LEFT, i.e. it reads as a left-turn. Since 'd'
                // increases yaw2D (matching the WebGL path's own, already-
                // correct d-turns-right convention - see the keyboard effect
                // above, which is unchanged), that made 'd' visually turn
                // left and 'a' visually turn right in this 2D fallback view
                // specifically. Negating just this pan term corrects it
                // without touching the keyboard mapping or the working
                // WebGL rotation at all.
                transform: `translate(-50%, -50%) translateX(${-yaw2D * 4}px) translateY(${pitch2D * 3}px) scale(1.3)`
              }}
            />
          )}
        </div>
      )}

      {/* Three.js Canvas Container */}
      <div
        ref={containerRef}
        className={`w-full h-full ${viewMode !== 'tour' ? 'opacity-0 pointer-events-none' : 'opacity-100'} transition-opacity duration-500`}
      />

      {/* Matterport Blur Overlay Container */}
      <div
        ref={overlayRef}
        className="absolute inset-0 pointer-events-none z-10 transition-all duration-100"
        style={{ backdropFilter: "blur(0px)", backgroundColor: "rgba(0,0,0,0)" }}
      />

      {/* SVG dashed stem lines — connects each ring to the ground-level vanishing point */}
      {viewMode === "tour" && (() => {
        const visibleMarkers = navigationMarkers
          .map(marker => ({ marker, proj: project3DToScreen(marker.yaw, marker.pitch) }))
          .filter(({ proj }) => proj !== null) as { marker: typeof navigationMarkers[0], proj: { x: number, y: number, dot: number } }[];
        if (!visibleMarkers.length) return null;
        const vw = containerRef.current?.clientWidth ?? 1024;
        const vh = containerRef.current?.clientHeight ?? 600;
        return (
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none z-[19]"
            viewBox={`0 0 ${vw} ${vh}`}
            xmlns="http://www.w3.org/2000/svg"
          >
            {visibleMarkers.map(({ marker, proj }) => (
              <line
                key={`line_${marker.connIdx}`}
                x1={proj.x} y1={proj.y}
                x2={vw / 2} y2={vh * 0.72}
                stroke="rgba(0,188,180,0.45)"
                strokeWidth="1"
                strokeDasharray="5 7"
              />
            ))}
          </svg>
        );
      })()}

      {/* Matterport-style navigation floor rings */}
      {viewMode === "tour" && navigationMarkers.map((marker) => {
        const proj = project3DToScreen(marker.yaw, marker.pitch);
        if (!proj) return null;
        const scale = Math.max(0.55, Math.min(1.1, proj.dot));
        return (
          <div
            key={`nav_${marker.connIdx}`}
            onClick={(e) => executeWalkTransitionToNode(marker.connIdx, undefined, e.clientX, e.clientY)}
            className="absolute z-20 cursor-pointer group"
            style={{
              left: `${proj.x}px`,
              top: `${proj.y}px`,
              transform: `translate(-50%, -50%) scale(${scale})`,
              transition: 'transform 0.15s ease',
            }}
          >
            {/* Outer ring — Matterport teal */}
            <div
              className="relative flex items-center justify-center group-hover:scale-125 transition-transform duration-200"
              style={{ width: 52, height: 52 }}
            >
              <svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Outer thin ring */}
                <circle cx="26" cy="26" r="23" stroke="#00bca0" strokeWidth="1.5" strokeOpacity="0.9" fill="none" />
                {/* Inner ring */}
                <circle cx="26" cy="26" r="17" stroke="#00bca0" strokeWidth="1" strokeOpacity="0.5" fill="none" />
                {/* Centre dot */}
                <circle cx="26" cy="26" r="4" fill="#00bca0" fillOpacity="0.95" />
              </svg>
            </div>
          </div>
        );
      })}

      {/* 3D Projected Info Hotspots */}
      {viewMode === "tour" && activeHotspots.map((hotspot) => {
        const proj = project3DToScreen(hotspot.yaw, hotspot.pitch);
        if (!proj) return null;

        const isDetectedObject = hotspot.icon_type === "object" || (hotspot as any).source === "yolo_auto";

        return (
          <div
            key={`hotspot_${hotspot.id}`}
            onClick={(e) => {
              e.stopPropagation();
              setActiveTooltip({
                title: hotspot.title,
                description: hotspot.description,
                x: proj.x,
                y: proj.y,
              });
            }}
            className="absolute z-20 cursor-pointer group flex flex-col items-center justify-center -translate-x-1/2 -translate-y-1/2"
            style={{
              left: `${proj.x}px`,
              top: `${proj.y}px`,
              transform: `translate(-50%, -50%) scale(${Math.max(0.7, proj.dot)})`,
            }}
          >
            {isDetectedObject ? (
              // Auto-detected (YOLO) objects: distinct amber tag, label always
              // visible so the auto-detect feature is actually noticeable
              // rather than indistinguishable from manually-authored hotspots.
              <div className="flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full bg-amber-500/25 border border-amber-400 shadow-[0_0_15px_rgba(245,158,11,0.6)] group-hover:scale-110 group-hover:bg-amber-500/40 transition-all">
                <span className="w-5 h-5 rounded-full bg-amber-400 text-black text-[11px] font-bold flex items-center justify-center">
                  🏷️
                </span>
                <span className="text-white text-[10px] font-bold whitespace-nowrap">
                  {hotspot.title}
                </span>
              </div>
            ) : (
              <>
                <div className="w-9 h-9 rounded-full border-2 border-emerald-400 bg-emerald-500/30 text-white font-bold text-sm flex items-center justify-center shadow-[0_0_15px_rgba(16,185,129,0.7)] group-hover:scale-110 transition-all">
                  ℹ️
                </div>
                <span className="mt-1 opacity-0 group-hover:opacity-100 transition-opacity bg-black/80 text-white text-[10px] font-semibold px-2 py-0.5 rounded border border-white/20 whitespace-nowrap">
                  {hotspot.title}
                </span>
              </>
            )}
          </div>
        );
      })}

      {/* Info Tooltip Popup */}
      {activeTooltip && (
        <div
          className="absolute z-40 bg-slate-900/90 border border-cyan-500/30 backdrop-blur-xl text-white p-4 rounded-2xl max-w-xs shadow-2xl -translate-x-1/2 -translate-y-full mb-4 animate-in fade-in zoom-in-95 duration-200"
          style={{ left: `${activeTooltip.x}px`, top: `${activeTooltip.y - 10}px` }}
        >
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <h4 className="font-bold text-cyan-300 text-sm">{activeTooltip.title}</h4>
            <button
              onClick={() => setActiveTooltip(null)}
              className="text-gray-400 hover:text-white text-xs font-bold w-5 h-5 rounded-full bg-white/10 flex items-center justify-center"
            >
              ✕
            </button>
          </div>
          <p className="text-xs text-gray-300 leading-relaxed">{activeTooltip.description}</p>
        </div>
      )}

      {textureLoading && (
        <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
          <span className="w-9 h-9 border-2 border-cyan-400/25 border-t-cyan-400 rounded-full animate-spin" />
        </div>
      )}

      {/* Mode Badge Indicator */}
      <div className="absolute left-6 z-30 flex items-center gap-2" style={{ top: 24 + topInset }}>
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-black/70 border border-cyan-500/40 text-cyan-300 backdrop-blur-md">
          {is360State ? "🌐 360° Panorama Sphere" : "🖼️ Walkthrough Tour"}
        </span>
      </div>

      {/* Position Counter HUD */}
      <div className="absolute bottom-6 right-6 z-30 flex items-center gap-3 pointer-events-none">
        <span className="text-white/90 text-xs font-bold bg-black/70 px-4 py-1.5 rounded-full border border-white/15 backdrop-blur-md shadow-xl">
          Waypoint {currentFrame + 1} of {totalFrames}
        </span>
      </div>

      {/* Control Hints HUD */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
        <div className="bg-black/75 backdrop-blur-md border border-white/15 text-white/80 px-5 py-2.5 rounded-2xl text-xs font-medium flex items-center gap-4 shadow-2xl">
          <span><b className="text-cyan-400 font-bold">W / S</b> Glide Walk</span>
          <span className="text-white/30">|</span>
          <span><b className="text-cyan-400 font-bold">A / D</b> Rotate 360°</span>
          <span className="text-white/30">|</span>
          <span><b className="text-cyan-400 font-bold">Drag</b> Free Look</span>
          <span className="text-white/30">|</span>
          <span><b className="text-cyan-400 font-bold">Scroll</b> Zoom</span>
        </div>
      </div>

      {/* Mode Switcher Buttons */}
      <div className="absolute right-6 z-30 flex items-center gap-2" style={{ top: 24 + topInset }}>
        {viewMode === "tour" && (
          <button
            onClick={handleAutoDetectObjects}
            disabled={autoDetectState === "running"}
            title={autoDetectMessage ?? "Run YOLO object detection and auto-place hotspots on recognized objects"}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition-all flex items-center gap-2 ${autoDetectState === "error"
              ? "bg-red-500/20 text-red-300 border-red-500/40"
              : autoDetectState === "done"
                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                : autoDetectState === "empty"
                  ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                  : "bg-black/60 text-white/80 border-white/15 hover:bg-black/80"
              } ${autoDetectState === "running" ? "opacity-70 cursor-wait" : ""}`}
          >
            <span>{autoDetectState === "running" ? "⏳" : autoDetectState === "done" ? "✅" : autoDetectState === "empty" ? "🕵️" : autoDetectState === "error" ? "⚠️" : "🔎"}</span>
            <span>
              {autoDetectState === "running"
                ? "Detecting…"
                : autoDetectState === "done"
                  ? `${autoDetectCount ?? ""} Tagged`.trim()
                  : autoDetectState === "empty"
                    ? "0 Found"
                    : autoDetectState === "error"
                      ? "Detection Failed"
                      : "Auto-Detect Objects"}
            </span>
          </button>
        )}
        <button
          onClick={() => setViewMode(viewMode === "tour" ? "floorplan" : "tour")}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition-all flex items-center gap-2 ${viewMode !== "tour"
            ? "bg-cyan-500 text-black border-cyan-400 shadow-[0_0_15px_rgba(6,182,212,0.4)]"
            : "bg-black/60 text-white/80 border-white/15 hover:bg-black/80"
            }`}
        >
          <span>📐</span>
          <span>{viewMode === "tour" ? "Floor Plan" : "360° Tour"}</span>
        </button>
        <button
          onClick={toggleFullscreen}
          title={isFullscreen ? "Exit full screen" : "View walkthrough in full screen"}
          className="px-3 py-2 rounded-xl text-xs font-bold border transition-all flex items-center gap-2 bg-black/60 text-white/80 border-white/15 hover:bg-black/80"
        >
          <span>{isFullscreen ? "⤡" : "⤢"}</span>
        </button>
      </div>

      {/* Interactive Floor Plan Overlay */}
      {viewMode !== "tour" && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 pointer-events-none">
          <canvas
            ref={mapCanvasRef}
            width={800}
            height={600}
            onClick={handleMinimapClick}
            className="max-w-[90%] max-h-[90%] bg-black/70 rounded-3xl border border-cyan-500/30 backdrop-blur-md shadow-2xl pointer-events-auto cursor-pointer"
          />
          <span className="text-white/50 text-[11px] font-medium bg-black/60 px-3 py-1 rounded-full pointer-events-none">
            Click a waypoint dot to jump there
          </span>
        </div>
      )}
    </div>
  );
}