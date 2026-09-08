"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import SplatViewer from "@/components/SplatViewer";
import PhotoWalkthrough from "@/components/PhotoWalkthrough";
import VersionHistoryPanel from "@/components/VersionHistoryPanel";
import MeshAssetLoader from "@/components/MeshAssetLoader";
import FloorPlanViewer from "@/components/FloorPlanViewer";
import { listProjects, uploadSplatFile, listAssetVersions, getApiBase } from "@/lib/api";
import type { Project } from "@/lib/types";

export default function LocalSplatViewerPage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<"walkthrough" | "dollhouse" | "floorplan">("walkthrough");
  const [walkthroughType, setWalkthroughType] = useState<"photo" | "splat">("splat");
  const [availableProjects, setAvailableProjects] = useState<Project[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Generate Photo Tour frames from the loaded 3D model ──────────
  // A directly-imported .ply/.splat never had real photos taken of it, so
  // the "Ultra HD Photo Tour" tab has nothing to show. This drives
  // SplatViewer's capture pass (renders a still at each pose already saved
  // in this project's poses.json/cameras.json and uploads it), filling in
  // images/ so the photo tour has real frames.
  const [captureTrigger, setCaptureTrigger] = useState(0);
  const [captureState, setCaptureState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);

  // ── 3D Asset Version History (Row 89) ─────────────────────────────
  const [showVersions, setShowVersions] = useState(false);
  // The FORMAT of whichever version is currently active - the real source
  // of truth for which viewer to render. A .glb/.obj version never writes
  // scene.splat (see backend/routes/upload.py's _write_canonical_scene_files),
  // so "is there a scene.splat that loads" can't tell mesh formats apart
  // from a stale leftover splat from a previous version - only the versions
  // list actually says which format is current.
  const [currentAssetFormat, setCurrentAssetFormat] = useState<string | null>(null);
  const isMeshFormat = currentAssetFormat === "glb" || currentAssetFormat === "obj";
  const [meshReloadNonce, setMeshReloadNonce] = useState(0);

  const refreshCurrentAssetFormat = (projectId: number | null) => {
    if (!projectId) {
      setCurrentAssetFormat(null);
      return;
    }
    listAssetVersions(projectId)
      .then((res) => {
        const current = res.versions.find((v) => v.is_current);
        setCurrentAssetFormat(current ? current.format : null);
      })
      .catch(() => setCurrentAssetFormat(null));
  };

  // Reloads the currently-active scene file after a version restore/upload
  // changed what's on disk - the URL string needs to actually change or
  // SplatViewer's load effect (keyed on splatUrl) won't refetch. Also
  // refreshes currentAssetFormat so switching to/from a mesh version swaps
  // in the right viewer component below.
  const reloadActiveScene = () => {
    if (!activeProjectId) return;
    const apiBase = getApiBase();
    setActiveUrl(`${apiBase}/data/project_${activeProjectId}/scene.splat?_t=${Date.now()}`);
    setMeshReloadNonce(Date.now());
    refreshCurrentAssetFormat(activeProjectId);
  };

  const handleGenerateFrames = () => {
    if (captureState === "running" || !activeProjectId) return;
    setCaptureState("running");
    setCaptureMsg("Capturing frames from the 3D model…");
    setCaptureTrigger(Date.now());
  };

  useEffect(() => {
    listProjects()
      .then((data) => {
        const valid = (data.projects || []).filter((p) => p.has_scene || p.status === "completed");
        setAvailableProjects(valid);
      })
      .catch(() => { });
  }, []);

  useEffect(() => {
    refreshCurrentAssetFormat(activeProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  useEffect(() => {
    if (selectedFile || activeUrl) {
      setWalkthroughType("splat");
    }
  }, [selectedFile?.name, activeUrl]);

  const loadNewSplatFile = async (file: File) => {
    if (!file || file.size < 50) {
      alert("The selected file is empty or corrupted (0.0 MB). Please re-download or select a valid 3D model file (.splat, .ply, or .lcc).");
      return;
    }
    setUploading(true);
    // Instantly bind local File & Blob URL so viewer renders without waiting for backend
    const blobUrl = URL.createObjectURL(file);
    setSelectedFile(file);
    setActiveUrl(blobUrl);
    setWalkthroughType("splat");

    try {
      const res = await uploadSplatFile(file);
      const ext = file.name.toLowerCase().split('.').pop();
      const rawPath = ext === 'ply' ? res.ply_url : res.splat_url;
      const targetPath = rawPath && !rawPath.includes('undefined')
        ? (rawPath.startsWith('/') ? rawPath : `/data/project_${res.project_id}/${rawPath}`)
        : `/data/project_${res.project_id}/${ext === 'ply' ? 'scene_clean.ply' : 'scene.splat'}`;
      const apiBase = getApiBase();
      const sceneUrl = `${apiBase}${targetPath}?_t=${Date.now()}`;
      setActiveUrl(sceneUrl);
      setActiveProjectId(res.project_id);
      setSelectedFile(null);
    } catch (err) {
      console.warn("Background server sync note:", err);
    } finally {
      setUploading(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      await loadNewSplatFile(e.target.files[0]);
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      await loadNewSplatFile(e.dataTransfer.files[0]);
    }
  };

  const selectExistingProject = (project: Project) => {
    // Clear previous scene state before loading selected scene
    setSelectedFile(null);
    setActiveUrl(null);
    setActiveProjectId(project.id);
    setWalkthroughType("splat");
    setTimeout(() => {
      const apiBase = getApiBase();
      setActiveUrl(`${apiBase}/data/project_${project.id}/scene.splat?_t=${Date.now()}`);
    }, 10);
  };

  const isLoaded = selectedFile !== null || activeUrl !== null;

  return (
    <div className="w-screen h-screen overflow-hidden bg-[#030305] relative flex flex-col select-none text-white">
      {/* ═══ TOP OVERLAY HEADER ═══ */}
      <div className="absolute top-4 inset-x-4 z-30 flex flex-wrap items-center justify-between gap-3 pointer-events-none">
        {/* Left: Branding & File Status */}
        <div className="flex items-center gap-3 pointer-events-auto">
          <Link
            href="/"
            className="px-3.5 py-2 text-xs font-bold bg-black/80 hover:bg-white/10 border border-white/15 rounded-xl backdrop-blur-md transition-all shadow-2xl flex items-center gap-1.5"
          >
            ← Studio Dashboard
          </Link>
          <div className="bg-black/80 backdrop-blur-md border border-white/15 px-4 py-2 rounded-xl text-xs font-semibold shadow-2xl flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>ArticulAIT 3D Studio</span>
            {selectedFile && (
              <span className="text-emerald-300 font-mono text-[11px] bg-emerald-950/80 px-2 py-0.5 rounded border border-emerald-500/30">
                {selectedFile.name} ({(selectedFile.size / (1024 * 1024)).toFixed(1)} MB)
              </span>
            )}
            {activeUrl && !selectedFile && (
              <span className="text-indigo-300 font-mono text-[11px] bg-indigo-950/80 px-2 py-0.5 rounded border border-indigo-500/30">
                Project #{activeProjectId ?? "Custom"}
              </span>
            )}
          </div>
        </div>

        {/* Center/Right: View Modes & File Picker */}
        <div className="flex items-center gap-2 pointer-events-auto">
          {isLoaded && (
            <>
              <div className="flex items-center gap-1 bg-black/80 backdrop-blur-md border border-white/15 p-1 rounded-xl shadow-2xl">
                {(["walkthrough", "dollhouse", "floorplan"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setViewMode(mode)}
                    className={`px-3.5 py-1.5 text-xs font-bold uppercase rounded-lg transition-all ${viewMode === mode
                        ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/40 border border-indigo-400/40"
                        : "text-white/70 hover:text-white hover:bg-white/10"
                      }`}
                  >
                    {mode === "walkthrough" ? "Walkthrough" : mode === "dollhouse" ? "Dollhouse" : "Floor Plan"}
                  </button>
                ))}
              </div>

              {viewMode === "walkthrough" && (
                <div className="flex items-center gap-2 bg-black/90 backdrop-blur-2xl border border-white/20 p-1.5 rounded-2xl shadow-[0_12px_40px_rgba(0,0,0,0.9)]">
                  <button
                    onClick={() => setWalkthroughType("photo")}
                    className={`px-4 py-2 text-xs font-black rounded-xl transition-all duration-300 flex items-center gap-2.5 ${
                      walkthroughType === "photo"
                        ? "bg-gradient-to-r from-violet-600 via-purple-600 to-pink-500 text-white border border-fuchsia-300/70 shadow-[0_0_25px_rgba(217,70,239,0.75)] scale-[1.03]"
                        : "text-white/70 hover:text-white hover:bg-white/10"
                    }`}
                    title="Ultra-High-Definition Photographic Tour (Raw 1080p Quality)"
                  >
                    <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                      {walkthroughType === "photo" && (
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-fuchsia-300 opacity-80" />
                      )}
                      <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${walkthroughType === "photo" ? "bg-fuchsia-200" : "bg-white/40"}`} />
                    </span>
                    <span className="tracking-tight text-white drop-shadow font-extrabold text-[12px]">📸 Ultra HD Photo Tour</span>
                    <span className={`px-2 py-0.5 text-[9px] rounded-md font-black uppercase tracking-widest transition-colors ${
                      walkthroughType === "photo"
                        ? "bg-black/40 text-fuchsia-200 border border-fuchsia-300/50 shadow-inner"
                        : "bg-white/10 text-white/50"
                    }`}>
                      RAW 1080p
                    </span>
                  </button>

                  <button
                    onClick={() => setWalkthroughType("splat")}
                    className={`px-4 py-2 text-xs font-black rounded-xl transition-all duration-300 flex items-center gap-2.5 ${
                      walkthroughType === "splat"
                        ? "bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 text-white border border-cyan-300/70 shadow-[0_0_25px_rgba(20,184,166,0.75)] scale-[1.03]"
                        : "text-white/70 hover:text-white hover:bg-white/10"
                    }`}
                    title="Interactive 3D Gaussian Splatting Engine"
                  >
                    <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                      {walkthroughType === "splat" && (
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-300 opacity-80" />
                      )}
                      <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${walkthroughType === "splat" ? "bg-cyan-200" : "bg-white/40"}`} />
                    </span>
                    <span className="tracking-tight text-white drop-shadow font-extrabold text-[12px]">✨ 3D Gaussian Model</span>
                    <span className={`px-2 py-0.5 text-[9px] rounded-md font-black uppercase tracking-widest transition-colors ${
                      walkthroughType === "splat"
                        ? "bg-black/40 text-cyan-200 border border-cyan-300/50 shadow-inner"
                        : "bg-white/10 text-white/50"
                    }`}>
                      3DGS
                    </span>
                  </button>
                </div>
              )}
            </>
          )}

          {activeUrl && !selectedFile && (
            <a
              href={activeUrl}
              download
              className="px-4 py-2 text-xs font-bold bg-amber-600 hover:bg-amber-500 text-white border border-amber-400/40 rounded-xl backdrop-blur-md shadow-lg shadow-amber-500/30 transition-all flex items-center gap-2"
              title="Download 3D Model file to your computer"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download .splat
            </a>
          )}

          {activeUrl && !selectedFile && activeProjectId && (
            <button
              onClick={handleGenerateFrames}
              disabled={captureState === "running"}
              className={`px-4 py-2 text-xs font-bold rounded-xl backdrop-blur-md shadow-lg transition-all flex items-center gap-2 border ${
                captureState === "running"
                  ? "bg-black/60 text-white/50 border-white/10 cursor-wait"
                  : "bg-fuchsia-600 hover:bg-fuchsia-500 text-white border-fuchsia-400/40 shadow-fuchsia-500/30"
              }`}
              title="Render still frames from this 3D model at its saved camera poses, so the Ultra HD Photo Tour has real images to show"
            >
              <span>{captureState === "running" ? "⏳" : "🎬"}</span>
              {captureState === "running" ? "Capturing Frames…" : "Generate Photo Tour"}
            </button>
          )}

          {activeUrl && !selectedFile && activeProjectId && (
            <button
              onClick={() => setShowVersions((v) => !v)}
              className={`px-4 py-2 text-xs font-bold rounded-xl backdrop-blur-md shadow-lg transition-all flex items-center gap-2 border ${
                showVersions
                  ? "bg-indigo-600 text-white border-indigo-400/40 shadow-indigo-500/30"
                  : "bg-black/80 hover:bg-white/10 text-white border-white/15"
              }`}
              title="View and restore prior versions of this 3D asset, or upload a new one"
            >
              📜 Versions
            </button>
          )}

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="px-4 py-2 text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white border border-indigo-400/40 rounded-xl backdrop-blur-md shadow-lg shadow-indigo-500/30 transition-all cursor-pointer flex items-center gap-2 disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0l-4 4m4-4v12" />
            </svg>
            {uploading ? "Saving Scene..." : "Open 3D File (.splat/.ply/.lcc)"}
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept=".splat,.ply,.lcc"
            className="hidden"
          />
        </div>
      </div>

      {captureMsg && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-40 pointer-events-none">
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

      {showVersions && activeProjectId && (
        <VersionHistoryPanel
          projectId={activeProjectId}
          onClose={() => setShowVersions(false)}
          onChanged={reloadActiveScene}
        />
      )}

      {/* ═══ MAIN VIEWPORT OR DROPZONE ═══ */}
      <div className="w-full h-full relative overflow-hidden flex-1">
        {isLoaded ? (
          viewMode === "walkthrough" && walkthroughType === "photo" ? (
            <PhotoWalkthrough
              key={`photo-${activeProjectId ?? "custom"}-${activeUrl || ""}`}
              projectId={activeProjectId || 0}
              file={selectedFile}
              splatUrl={activeUrl || undefined}
              viewMode={viewMode}
              onFallback={() => setWalkthroughType("splat")}
            />
          ) : isMeshFormat && activeProjectId && !selectedFile ? (
            <MeshAssetLoader
              key={`mesh-${activeProjectId}-${meshReloadNonce}`}
              url={`${getApiBase()}/data/project_${activeProjectId}/scene_mesh.${currentAssetFormat}?_t=${meshReloadNonce || 0}`}
              onError={(msg) => {
                console.warn("[MeshAssetLoader]", msg);
                setCurrentAssetFormat(null);
              }}
            />
          ) : viewMode === "floorplan" && activeProjectId ? (
            <FloorPlanViewer key={`floorplan-${activeProjectId}`} projectId={activeProjectId} />
          ) : viewMode === "floorplan" && !activeProjectId ? (
            <div className="w-full h-full flex items-center justify-center bg-[#030305] text-white/50 text-sm text-center p-6">
              Floor plan generation needs a project saved on the server —
              a locally-loaded file with no project ID can&apos;t be used yet.
            </div>
          ) : (
            <SplatViewer
              key={`splat-${selectedFile?.name || activeProjectId || activeUrl || "clean"}`}
              file={selectedFile}
              splatUrl={activeUrl || undefined}
              viewMode={viewMode}
              projectId={activeProjectId || undefined}
              onOpenFile={() => fileInputRef.current?.click()}
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
          )
        ) : (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className="w-full h-full flex flex-col items-center justify-center p-6 text-center bg-[#050509] relative"
          >
            <div className="max-w-xl w-full glass p-8 space-y-6 border border-white/10 rounded-3xl shadow-2xl relative z-10">
              <div className="w-16 h-16 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 text-indigo-400 flex items-center justify-center mx-auto text-3xl font-black">
                ✨
              </div>

              <div className="space-y-2">
                <h1 className="text-2xl font-black tracking-tight text-white">Interactive 3D Walkthrough Studio</h1>
                <p className="text-xs text-white/60 leading-relaxed max-w-md mx-auto">
                  Launch full 1080p HD walkthroughs or load your custom 3D model (<code className="text-emerald-300 font-mono bg-white/5 px-1.5 py-0.5 rounded">.splat</code>, <code className="text-sky-300 font-mono bg-white/5 px-1.5 py-0.5 rounded">.ply</code>, <code className="text-amber-300 font-mono bg-white/5 px-1.5 py-0.5 rounded">.lcc</code>) locally.
                </p>
              </div>

              {/* Upload Box */}
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-emerald-500/40 hover:border-emerald-400 bg-emerald-950/10 hover:bg-emerald-950/20 p-8 rounded-2xl cursor-pointer transition-all space-y-4 group"
              >
                <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto group-hover:scale-110 transition-transform">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0l-4 4m4-4v12" />
                  </svg>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-bold text-white">
                    Click to select <span className="text-emerald-400 font-mono">3D file (.splat, .ply, .lcc)</span> from your computer
                  </p>
                  <p className="text-xs text-white/40">or drag and drop the file directly here</p>
                </div>
                <button
                  type="button"
                  className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-emerald-500/30"
                >
                  📁 Browse Local File
                </button>
              </div>

              {/* Server Projects Selector */}
              {availableProjects.length > 0 && (
                <div className="pt-4 border-t border-white/10 space-y-3">
                  <p className="text-xs text-white/50 font-medium">Or select an existing project model:</p>
                  <div className="grid grid-cols-2 gap-2">
                    {availableProjects.slice(0, 4).map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => selectExistingProject(p)}
                        className="px-3 py-2 bg-white/5 hover:bg-indigo-600/30 border border-white/10 hover:border-indigo-500/50 rounded-xl text-xs text-white font-semibold transition-all text-left truncate flex items-center justify-between"
                      >
                        <span className="truncate">{p.name || `Project #${p.id}`}</span>
                        <span className="text-[10px] text-emerald-400 font-mono ml-1">#{p.id}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
