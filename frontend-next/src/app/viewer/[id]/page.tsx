"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import SplatViewer from "@/components/SplatViewer";
import PhotoWalkthrough from "@/components/PhotoWalkthrough";
import PanoWalkthrough from "@/components/PanoWalkthrough";
import StreetViewViewer from "@/components/StreetViewViewer";
import GuidedTourViewer from "@/components/GuidedTourViewer";
import VersionHistoryPanel from "@/components/VersionHistoryPanel";
import MeshAssetLoader from "@/components/MeshAssetLoader";
import { getProject, getDetectedObjects, startPipeline, listAssetVersions, getApiBase } from "@/lib/api";
import type { ProjectDetail, DetectedObject } from "@/lib/types";

interface PageProps {
  params: Promise<{ id: string }>;
}

const DL_ICON = (
  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
  </svg>
);

export default function ViewerPage({ params }: PageProps) {
  const { id: projectIdStr } = use(params);
  const projectId = parseInt(projectIdStr, 10);

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [objects, setObjects] = useState<DetectedObject[]>([]);
  const [viewMode, setViewMode] = useState<"streetview" | "walkthrough" | "dollhouse" | "floorplan">("walkthrough");
  const [walkthroughType, setWalkthroughType] = useState<"splat" | "photo" | "guided">("photo");
  const [splatFormat, setSplatFormat] = useState<"splat" | "ply" | "lcc">("splat");
  // Defaults to "medium" rather than the full-resolution asset: a directly
  // uploaded/imported model (e.g. an AI-generated world export) can be
  // several million splats, well beyond what a typical reconstructed room
  // produces, and loading that at full density by default was making the
  // viewer heavy enough to visibly lag on ordinary hardware. Falls back to
  // "high" automatically via the backend's existing asset auto-fallback for
  // any project that doesn't have LOD tiers generated yet.
  const [qualityTier, setQualityTier] = useState<"high" | "medium" | "low">("medium");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenState, setRegenState] = useState<"idle" | "starting" | "started" | "error">("idle");
  const [regenMessage, setRegenMessage] = useState<string | null>(null);

  // ── Generate Photo Tour frames from a directly-imported 3D model ──
  // Reality-capture-bypass projects (a Marble .ply, etc.) get a synthetic
  // poses.json/cameras.json orbit but no real photos, so the Ultra HD Photo
  // Tour tab has nothing to render. This drives SplatViewer's capture pass.
  const [captureTrigger, setCaptureTrigger] = useState(0);
  const [captureState, setCaptureState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);

  // ── 3D Asset Version History (Row 89: "3D asset management — stored,
  // versioned, retrievable") ──
  const [showVersions, setShowVersions] = useState(false);
  // Bumped after a version restore/upload so splatUrl (below) picks up a
  // fresh cache-busting query param - the file on disk changed but the base
  // URL string wouldn't, so SplatViewer's fetch-on-splatUrl-change effect
  // would otherwise never notice.
  const [assetReloadNonce, setAssetReloadNonce] = useState(0);
  // The FORMAT of whichever version is currently active - the real source
  // of truth for which viewer component to render. This can't be inferred
  // from project.scene.splat_path (that only gets set/updated for
  // splat/ply/lcc versions - a .glb/.obj version never touches it, so it
  // silently keeps pointing at whatever gsplat file existed before). Fetched
  // straight from the versions list instead, both on initial load and after
  // any restore/upload.
  const [currentAssetFormat, setCurrentAssetFormat] = useState<string | null>(null);
  const isMeshFormat = currentAssetFormat === "glb" || currentAssetFormat === "obj";

  const refreshCurrentAssetFormat = () => {
    if (isNaN(projectId)) return;
    listAssetVersions(projectId)
      .then((res) => {
        const current = res.versions.find((v) => v.is_current);
        setCurrentAssetFormat(current ? current.format : null);
      })
      .catch(() => setCurrentAssetFormat(null));
  };

  const reloadAsset = () => {
    setAssetReloadNonce(Date.now());
    // splatFormat was set once from the ORIGINAL scene.splat_path's
    // extension at initial load and never otherwise updated. A restored or
    // newly-uploaded gsplat-renderable version always (re)writes scene.splat
    // + its LOD tiers fresh (see backend/routes/upload.py's
    // _write_canonical_scene_files and the pipeline re-run in
    // restore_asset_version), regardless of whether it was originally a
    // .ply/.splat/.lcc - so resetting to "splat" here always points at the
    // right, freshly-regenerated file instead of a stale
    // scene_clean.ply/scene.lcc path from a previous version that may not
    // exist for the new one.
    setSplatFormat("splat");
    refreshCurrentAssetFormat();
  };

  const handleGenerateFrames = () => {
    if (captureState === "running") return;
    setCaptureState("running");
    setCaptureMsg("Capturing frames from the 3D model…");
    setCaptureTrigger(Date.now());
  };

  useEffect(() => {
    if (isNaN(projectId)) return;
    Promise.all([getProject(projectId), getDetectedObjects(projectId)])
      .then(([projData, objData]) => {
        setProject(projData);
        setObjects(objData.objects);
        setLoading(false);
        // Default to Ultra HD Photo Tour (360° panoramic sphere walkthrough)
        setWalkthroughType("photo");
        
        // Match format toggle to actual database path if present
        if (projData.scene?.splat_path) {
          if (projData.scene.splat_path.endsWith(".lcc")) setSplatFormat("lcc");
          else if (projData.scene.splat_path.endsWith(".ply")) setSplatFormat("ply");
          else setSplatFormat("splat");
        }
        // Default to Street View if coordinates are available
        if (projData.latitude && projData.longitude) {
          setViewMode("streetview");
        }
      })
      .catch(() => {
        setError("Failed to load walkthrough details. Make sure the API server is active.");
        setLoading(false);
      });
    refreshCurrentAssetFormat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Lets a user re-run the full reconstruction pipeline (real COLMAP SfM +
  // Gaussian Splat training) from the browser instead of needing to hit the
  // API directly. Useful after a code/data fix upstream (e.g. stale/corrupt
  // pose data) - re-processing picks up whatever the backend currently does.
  const handleRegenerate = async () => {
    if (regenState === "starting") return;
    const confirmed = window.confirm(
      `Re-run 3D reconstruction for project #${projectId}? This re-does COLMAP pose estimation and Gaussian Splat training from scratch and can take several minutes. Continue?`
    );
    if (!confirmed) return;

    setRegenState("starting");
    setRegenMessage(null);
    try {
      const res = await startPipeline(projectId, true);
      setRegenState("started");
      setRegenMessage(res.message || "Reprocessing started.");
    } catch (err) {
      console.error("Failed to start pipeline:", err);
      setRegenState("error");
      setRegenMessage(err instanceof Error ? err.message : "Failed to start reprocessing.");
    }
  };

  const isLuma = project?.scene?.splat_path?.startsWith("luma:") || false;
  const rawSplatPath = project?.scene?.splat_path;
  const rawPlyPath = project?.scene?.ply_path;
  const validSplatPath = (rawSplatPath && !rawSplatPath.includes("undefined")) ? rawSplatPath : `/data/project_${projectId}/scene.splat`;
  const validPlyPath = (rawPlyPath && !rawPlyPath.includes("undefined")) ? rawPlyPath : `/data/project_${projectId}/scene_clean.ply`;

  const splatTierUrl = qualityTier === "high"
    ? validSplatPath
    : `/data/project_${projectId}/scene_lod_${qualityTier}.splat`;

  const cacheBust = assetReloadNonce ? `${assetReloadNonce}` : "";
  const withCacheBust = (url: string) => (cacheBust ? `${url}${url.includes("?") ? "&" : "?"}_v=${cacheBust}` : url);

  const apiBase = getApiBase();

  const splatUrl = isLuma
    ? ""
    : withCacheBust(
        splatFormat === "lcc"
          ? `${apiBase}/data/project_${projectId}/scene.lcc`
          : splatFormat === "ply"
          ? `${apiBase}${validPlyPath}`
          : `${apiBase}${splatTierUrl}`
      );

  // Only reachable when currentAssetFormat is "glb"/"obj" (see isMeshFormat
  // above) - scene_mesh.glb / scene_mesh.obj is exactly what
  // _write_canonical_scene_files (backend/routes/upload.py) writes for
  // those formats on upload or restore.
  const meshUrl = withCacheBust(`${apiBase}/data/project_${projectId}/scene_mesh.${currentAssetFormat}`);

  /* ── Loading ── */
  if (loading) {
    return (
      <div className="flex flex-col min-h-screen bg-[#030305]">
        <Navbar />
        <div className="flex-1 flex items-center justify-center">
          <span className="animate-spin inline-block w-8 h-8 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full" />
        </div>
      </div>
    );
  }

  /* ── Error ── */
  if (error || !project) {
    return (
      <div className="flex flex-col min-h-screen bg-[#030305]">
        <Navbar />
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center gap-4 text-white">
          <p className="text-red-400 font-bold text-lg">{error || "Project not found"}</p>
          <Link href="/" className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-bold text-xs">
            Back to Studio
          </Link>
        </div>
      </div>
    );
  }

  /* ── Failed State (§6.5) ── */
  const outputStatus = project.output_status || (project.status === "completed" ? "completed" : "failed");
  const reasonCode = project.reason_code || "PIPELINE_EXCEPTION";

  const HUMAN_READABLE_REASONS: Record<string, string> = {
    INSUFFICIENT_FRAME_OVERLAP: "Not enough photo overlap. Please ensure you take photos much closer together (every 1-2 steps) so the AI can connect them.",
    REGISTRATION_FAILURE: "The AI could not connect the photos. This usually happens if photos are out of order, too far apart, or blurry. Please retake with denser coverage.",
    VOCAB_TREE_MISSING: "System configuration error: Missing vocabulary tree. Please contact support.",
    LOW_PARALLAX: "The photos were taken from the exact same spot. Please physically walk forward between each photo.",
    INSUFFICIENT_POSE_CONFIDENCE: "The AI was unsure about the camera path. Please ensure good lighting and clear distinct features in each room.",
    NO_IMAGES_FOUND: "No images were found in the uploaded batch. Please try uploading again.",
    TRAINING_DIVERGED: "The 3D reconstruction failed to stabilize. This can happen with very blank walls or highly reflective surfaces like large mirrors.",
    PIPELINE_EXCEPTION: "An unexpected system error occurred during processing. Our team has been notified.",
    NONE: "An unknown error prevented reconstruction."
  };

  if (outputStatus === "failed" && project.status !== "processing") {
    const userMessage = HUMAN_READABLE_REASONS[reasonCode] || HUMAN_READABLE_REASONS["NONE"];
    
    return (
      <div className="flex flex-col min-h-screen bg-[#030305] text-white">
        <Navbar />
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center gap-6">
          <div className="max-w-md p-8 bg-red-950/40 border border-red-500/40 rounded-3xl backdrop-blur-2xl shadow-2xl flex flex-col items-center gap-5">
            <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-400 text-3xl shadow-inner">
              ❌
            </div>
            <div className="space-y-2">
              <h3 className="text-2xl font-black text-red-200">Reconstruction Failed</h3>
              <p className="text-sm text-red-300 leading-relaxed max-w-sm mx-auto pt-2 font-medium">
                {userMessage}
              </p>
              {project.failure_reason && (
                <div className="mt-4 p-2 bg-black/60 rounded-lg border border-red-500/20 text-left">
                  <p className="text-[10px] text-red-400/70 font-mono uppercase tracking-wider mb-1">Diagnostic Detail</p>
                  <code className="text-xs text-red-400/90 font-mono block break-words">
                    {project.failure_reason}
                  </code>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 w-full pt-2">
              <Link href="/" className="w-full py-3 px-5 bg-white/10 hover:bg-white/20 text-white rounded-xl font-bold text-xs transition-all">
                ← Return to Dashboard
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── 2.5D Fallback State (§6.5) ──
     FIX (dashboard "Walkthrough" landed on a bare shell - no .splat/.ply/.lcc
     downloads, no Guided Tour (BÉZIER) tab, no Versions panel): this used to
     be an early-return branch rendering ONLY <Navbar/> + one viewer, with
     none of the tabs/downloads/Regenerate/Versions chrome the full branch
     below has. That was true even before the earlier A/D-rotation fix (which
     only changed WHICH viewer rendered inside this shell, DepthParallaxViewer
     -> PanoWalkthrough) - the missing chrome was a pre-existing gap, not
     something introduced by that fix.
     Per the explicit instruction "just dont change how the walkthrough is
     working please atleast its running", this does NOT touch how the
     walkthrough itself renders: the initial-load effect above already sets
     walkthroughType to "photo" (not "splat") whenever
     isSplatCompleted = has_scene && output_status === "completed" is false -
     which is exactly the case for a fallback_2.5d project. So falling through
     to the full branch below still renders the SAME <PanoWalkthrough
     projectId={projectId} topInset={76} /> by default (see the
     walkthroughType === "photo" case further down) - identical component,
     identical props, identical A/D behavior - just now surrounded by the
     same tabs/downloads/Regenerate/Versions UI every other project gets,
     instead of a stripped-down early return. Removed the dedicated
     early-return entirely so fallback_2.5d projects go through the one
     shared UI below rather than duplicating it. */
  return (
    <div className="w-screen h-screen overflow-hidden bg-[#030305] relative flex flex-col select-none text-white">
      {/* ═══ TOP OVERLAY HEADER ═══ */}
      <div className="absolute top-3 inset-x-4 z-40 flex items-center justify-between gap-2.5 pointer-events-none flex-nowrap overflow-x-auto no-scrollbar">
        {/* Left: Branding & Status */}
        <div className="flex items-center gap-2 flex-shrink-0 pointer-events-auto">
          <div className="bg-black/85 backdrop-blur-xl border border-white/15 px-3 py-1.5 rounded-xl text-xs font-semibold shadow-2xl flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-bold tracking-tight">ArticulAIT Studio</span>
            <span className="text-emerald-300 font-mono text-[10px] bg-emerald-950/80 px-1.5 py-0.5 rounded border border-emerald-500/30">
              #{projectId}
            </span>
          </div>
        </div>

        {/* Center: View Modes & Engine Toggle */}
        <div className="flex items-center gap-2 flex-shrink-0 pointer-events-auto">
          <div className="flex items-center gap-1 bg-black/85 backdrop-blur-xl border border-white/15 p-1 rounded-xl shadow-2xl">
            {(["streetview", "walkthrough", "dollhouse", "floorplan"] as const).map(mode => {
              if (mode === "streetview" && (!project?.latitude || !project?.longitude)) return null;
              return (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`px-3 py-1.5 text-xs font-bold uppercase rounded-lg transition-all ${
                    viewMode === mode
                      ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/40 border border-indigo-400/40"
                      : "text-white/70 hover:text-white hover:bg-white/10"
                  }`}
                >
                  {mode === "walkthrough" ? "Walkthrough" : mode === "dollhouse" ? "Dollhouse" : mode === "streetview" ? "Street View" : "Floor Plan"}
                </button>
              );
            })}
          </div>

          {viewMode === "walkthrough" && (
            <div className="flex items-center gap-1.5 bg-black/90 backdrop-blur-2xl border border-white/20 p-1 rounded-xl shadow-2xl">
              <button
                onClick={() => setWalkthroughType("photo")}
                className={`px-3 py-1.5 text-xs font-black rounded-lg transition-all duration-300 flex items-center gap-2 ${
                  walkthroughType === "photo"
                    ? "bg-gradient-to-r from-violet-600 via-purple-600 to-pink-500 text-white border border-fuchsia-300/70 shadow-[0_0_20px_rgba(217,70,239,0.7)]"
                    : "text-white/70 hover:text-white hover:bg-white/10"
                }`}
                title="Flagship Ultra HD Photographic Tour (Raw 1080p Quality)"
              >
                <span className="relative flex h-2 w-2 flex-shrink-0">
                  {walkthroughType === "photo" && (
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-fuchsia-300 opacity-80" />
                  )}
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${walkthroughType === "photo" ? "bg-fuchsia-200" : "bg-white/40"}`} />
                </span>
                <span className="tracking-tight text-white drop-shadow font-extrabold text-[11px]">📸 Photo Tour</span>
                <span className={`px-1.5 py-0.5 text-[8px] rounded font-black uppercase tracking-wider transition-colors ${
                  walkthroughType === "photo"
                    ? "bg-black/50 text-fuchsia-200 border border-fuchsia-300/60"
                    : "bg-white/10 text-white/50"
                }`}>
                  RECOMMENDED
                </span>
              </button>

              <button
                onClick={() => setWalkthroughType("splat")}
                className={`px-3 py-1.5 text-xs font-black rounded-lg transition-all duration-300 flex items-center gap-2 ${
                  walkthroughType === "splat"
                    ? "bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 text-white border border-cyan-300/70 shadow-[0_0_20px_rgba(20,184,166,0.6)]"
                    : "text-white/70 hover:text-white hover:bg-white/10"
                }`}
                title="Free-roam 3D Gaussian Splatting Engine (Beta)"
              >
                <span className="relative flex h-2 w-2 flex-shrink-0">
                  {walkthroughType === "splat" && (
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-300 opacity-80" />
                  )}
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${walkthroughType === "splat" ? "bg-cyan-200" : "bg-white/40"}`} />
                </span>
                <span className="tracking-tight text-white drop-shadow font-extrabold text-[11px]">✨ Free Explore 3D</span>
                <span className={`px-1.5 py-0.5 text-[8px] rounded font-black uppercase tracking-wider transition-colors ${
                  walkthroughType === "splat"
                    ? "bg-black/40 text-cyan-200 border border-cyan-300/50"
                    : "bg-white/10 text-white/50"
                }`}>
                  BETA
                </span>
              </button>

              <button
                onClick={() => setWalkthroughType("guided")}
                className={`px-3 py-1.5 text-xs font-black rounded-lg transition-all duration-300 flex items-center gap-2 ${
                  walkthroughType === "guided"
                    ? "bg-gradient-to-r from-violet-600 via-indigo-600 to-purple-500 text-white border border-violet-300/70 shadow-[0_0_20px_rgba(139,92,246,0.7)]"
                    : "text-white/70 hover:text-white hover:bg-white/10"
                }`}
                title="Scripted Bézier Camera Flythrough (§9.1)"
              >
                <span className="relative flex h-2 w-2 flex-shrink-0">
                  {walkthroughType === "guided" && (
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-300 opacity-80" />
                  )}
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${walkthroughType === "guided" ? "bg-violet-200" : "bg-white/40"}`} />
                </span>
                <span className="tracking-tight text-white drop-shadow font-extrabold text-[11px]">🎬 Guided Tour</span>
                <span className={`px-1.5 py-0.5 text-[8px] rounded font-black uppercase tracking-wider transition-colors ${
                  walkthroughType === "guided"
                    ? "bg-black/40 text-violet-200 border border-violet-300/50"
                    : "bg-white/10 text-white/50"
                }`}>
                  BÉZIER
                </span>
              </button>
            </div>
          )}

          {(walkthroughType === "splat" || walkthroughType === "guided" || viewMode !== "walkthrough") && (
            <div className="flex items-center gap-1 bg-black/85 backdrop-blur-md border border-white/15 p-1 rounded-xl shadow-2xl text-[10px]">
              <button
                onClick={() => setSplatFormat("splat")}
                className={`px-2 py-1 rounded font-bold transition-all ${
                  splatFormat === "splat"
                    ? "bg-emerald-600 text-white shadow"
                    : "text-white/60 hover:text-white"
                }`}
                title="Packed .splat format (Fast)"
              >
                .splat
              </button>
              <button
                onClick={() => setSplatFormat("ply")}
                className={`px-3 py-1 text-xs font-bold rounded flex items-center gap-1 transition-colors ${
                  splatFormat === "ply"
                    ? "bg-amber-600 text-white shadow-inner"
                    : "bg-black/30 text-amber-200/50 hover:bg-black/50 hover:text-amber-200"
                }`}
              >
                .PLY
              </button>
              <button
                onClick={() => setSplatFormat("lcc")}
                className={`px-3 py-1 text-xs font-bold rounded flex items-center gap-1 transition-colors ${
                  splatFormat === "lcc"
                    ? "bg-emerald-600 text-white shadow-inner"
                    : "bg-black/30 text-emerald-200/50 hover:bg-black/50 hover:text-emerald-200"
                }`}
                title="Local Canonical Container (.zip with scene.splat)"
              >
                .LCC
              </button>
            </div>
          )}

          {splatFormat === "splat" && (walkthroughType === "splat" || walkthroughType === "guided" || viewMode !== "walkthrough") && (
            <div className="flex items-center gap-1 bg-black/85 backdrop-blur-md border border-white/15 p-1 rounded-xl shadow-2xl text-[10px]">
              {(["low", "medium", "high"] as const).map((tier) => (
                <button
                  key={tier}
                  onClick={() => setQualityTier(tier)}
                  className={`px-2 py-1 rounded font-bold uppercase transition-all ${
                    qualityTier === tier
                      ? "bg-indigo-600 text-white shadow"
                      : "text-white/60 hover:text-white"
                  }`}
                  title={
                    tier === "high"
                      ? "Full resolution (heaviest - can lag on large scenes)"
                      : tier === "medium"
                      ? "~50% of splats (default - lighter, still detailed)"
                      : "~25% of splats (fastest, lowest detail)"
                  }
                >
                  {tier}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: Downloads + Exit */}
        <div className="flex items-center gap-2 flex-shrink-0 pointer-events-auto">
          <div className="flex items-center gap-1 bg-black/85 backdrop-blur-md border border-white/15 p-1 rounded-xl shadow-2xl">
            <a
              href={`${apiBase}/data/project_${projectId}/scene.splat`}
              download={`scene_project_${projectId}.splat`}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold text-emerald-300 hover:text-white hover:bg-emerald-600/80 rounded-lg transition-all cursor-pointer"
              title="Download .splat (compact binary)"
            >
              {DL_ICON} .splat
            </a>
            <div className="w-px h-3.5 bg-white/15" />
            <a
              href={`${apiBase}/data/project_${projectId}/scene_clean.ply`}
              download={`scene_${projectId}_clean.ply`}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold text-sky-300 hover:text-white hover:bg-sky-600/80 rounded-lg transition-all cursor-pointer"
              title="Download .ply (pruned Gaussian Splatting)"
            >
              {DL_ICON} .ply
            </a>
            <div className="w-px h-3.5 bg-white/15" />
            <a
              href={`${apiBase}/data/project_${projectId}/scene.lcc`}
              download={`scene_project_${projectId}.lcc`}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold text-amber-300 hover:text-white hover:bg-amber-600/80 rounded-lg transition-all cursor-pointer"
              title="Download .lcc (Local Canonical Container with coordinate frame metadata)"
            >
              {DL_ICON} .lcc
            </a>
          </div>

          <Link
            href="/"
            className="px-3 py-1.5 text-xs font-bold bg-black/85 hover:bg-red-950/70 text-white/80 hover:text-red-200 border border-white/15 hover:border-red-500/50 rounded-xl backdrop-blur-md transition-all shadow-2xl block"
          >
            ✕ Exit
          </Link>
        </div>
      </div>

      {/* Frame capture status banner */}
      {captureMsg && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-40 pointer-events-none">
          <div className={`px-4 py-2 rounded-xl text-xs font-semibold backdrop-blur-md border shadow-2xl ${
            captureState === "error"
              ? "bg-red-950/85 text-red-200 border-red-500/40"
              : captureState === "done"
              ? "bg-emerald-950/85 text-emerald-200 border-emerald-500/40"
              : "bg-fuchsia-950/85 text-fuchsia-200 border-fuchsia-500/40"
          }`}>
            {captureState === "error" ? "⚠️ " : captureState === "done" ? "✅ " : "🎬 "}{captureMsg}
          </div>
        </div>
      )}

      {/* Regenerate status banner */}
      {regenMessage && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-40 pointer-events-none">
          <div className={`px-4 py-2 rounded-xl text-xs font-semibold backdrop-blur-md border shadow-2xl ${
            regenState === "error"
              ? "bg-red-950/85 text-red-200 border-red-500/40"
              : "bg-indigo-950/85 text-indigo-200 border-indigo-500/40"
          }`}>
            {regenState === "error" ? "⚠️ " : "🔄 "}{regenMessage}
            {regenState === "started" && " — this can take several minutes; refresh the page when it's done."}
          </div>
        </div>
      )}

      {/* Regenerate 3D — standalone floating button, deliberately NOT part of
          the top header row above. That row is flex-nowrap + overflow-x-auto
          with a hidden scrollbar (no-scrollbar) and was already packed with
          6+ button groups; anything appended there risked being pushed
          off-screen with no visible way to scroll to it (this happened -
          see task history). Bottom-left is the one corner neither
          PanoWalkthrough's nor SplatViewer's own HUD overlays use. */}
      <div className="absolute bottom-6 left-6 z-40 pointer-events-auto flex items-center gap-2">
        <button
          onClick={handleRegenerate}
          disabled={regenState === "starting"}
          title="Re-run 3D reconstruction (COLMAP + Gaussian Splat training) from scratch"
          className={`px-4 py-2.5 text-xs font-bold rounded-xl backdrop-blur-md transition-all shadow-2xl border flex items-center gap-2 ${
            regenState === "starting"
              ? "bg-black/85 text-white/50 border-white/10 cursor-wait"
              : "bg-black/85 hover:bg-indigo-950/80 text-white/85 hover:text-indigo-200 border-white/20 hover:border-indigo-500/60"
          }`}
        >
          <span>{regenState === "starting" ? "⏳" : "🔄"}</span>
          <span>{regenState === "starting" ? "Starting…" : "Regenerate 3D"}</span>
        </button>

        {(walkthroughType === "splat" || walkthroughType === "guided") && (
          <button
            onClick={handleGenerateFrames}
            disabled={captureState === "running"}
            title="Render still frames from this 3D model at its saved camera poses, so the Ultra HD Photo Tour has real images to show"
            className={`px-4 py-2.5 text-xs font-bold rounded-xl backdrop-blur-md transition-all shadow-2xl border flex items-center gap-2 ${
              captureState === "running"
                ? "bg-black/85 text-white/50 border-white/10 cursor-wait"
                : "bg-black/85 hover:bg-fuchsia-950/80 text-white/85 hover:text-fuchsia-200 border-white/20 hover:border-fuchsia-500/60"
            }`}
          >
            <span>{captureState === "running" ? "⏳" : "🎬"}</span>
            <span>{captureState === "running" ? "Capturing…" : "Generate Photo Tour"}</span>
          </button>
        )}

        <button
          onClick={() => setShowVersions((v) => !v)}
          title="View and restore prior versions of this 3D asset, or upload a new one"
          className={`px-4 py-2.5 text-xs font-bold rounded-xl backdrop-blur-md transition-all shadow-2xl border flex items-center gap-2 ${
            showVersions
              ? "bg-indigo-600 text-white border-indigo-400/50"
              : "bg-black/85 hover:bg-indigo-950/80 text-white/85 hover:text-indigo-200 border-white/20 hover:border-indigo-500/60"
          }`}
        >
          <span>📜</span>
          <span>Versions</span>
        </button>
      </div>

      {showVersions && !isNaN(projectId) && (
        <VersionHistoryPanel
          projectId={projectId}
          onClose={() => setShowVersions(false)}
          onChanged={reloadAsset}
        />
      )}

      {/* ═══ 3D SCENE VIEWPORT (FULL BLEED 100% W x 100% H) ═══ */}
      <div className="w-full h-full relative overflow-hidden">
        {isLuma ? (
          <iframe src="/luma_mock_v15.html" className="w-full h-full border-none" title="Luma" />
        ) : viewMode === "streetview" && project.latitude && project.longitude ? (
          <StreetViewViewer
            apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || ""}
            latitude={project.latitude}
            longitude={project.longitude}
            heading={project.heading || 0}
            onEnterProperty={() => setViewMode("walkthrough")}
          />
        ) : viewMode === "walkthrough" && walkthroughType === "guided" ? (
          <GuidedTourViewer
            splatUrl={splatUrl}
            projectId={projectId}
            onExit={() => setWalkthroughType("splat")}
          />
        ) : viewMode === "walkthrough" && walkthroughType === "photo" ? (
          <PanoWalkthrough projectId={projectId} topInset={76} />
        ) : isMeshFormat ? (
          <MeshAssetLoader
            key={`mesh-${projectId}-${assetReloadNonce}`}
            url={meshUrl}
            onError={(msg) => {
              console.warn("[MeshAssetLoader]", msg);
              setCurrentAssetFormat(null);
            }}
          />
        ) : (
          <SplatViewer
            splatUrl={splatUrl}
            viewMode={viewMode === "streetview" ? "walkthrough" : viewMode}
            sceneBounds={project.scene?.bounds ?? null}
            projectId={projectId}
            onFallback={() => setWalkthroughType("photo")}
            captureTrigger={captureTrigger}
            onCaptureProgress={(done, total) => setCaptureMsg(`Capturing frame ${done} of ${total}…`)}
            onCaptureComplete={({ saved, failed, error }) => {
              if (error) {
                setCaptureState("error");
                setCaptureMsg(error);
              } else {
                setCaptureState("done");
                setCaptureMsg(
                  failed > 0
                    ? `Captured ${saved} frame${saved === 1 ? "" : "s"}, ${failed} failed. Switch to Ultra HD Photo Tour to view.`
                    : `Captured ${saved} frame${saved === 1 ? "" : "s"}. Switch to Ultra HD Photo Tour to view.`
                );
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

