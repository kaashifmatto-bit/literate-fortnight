"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import UploadZone from "@/components/UploadZone";
import ProjectCard from "@/components/ProjectCard";
import PipelineTracker from "@/components/PipelineTracker";
import ListingsPanel from "@/components/ListingsPanel";
import { listProjects, uploadImages, deleteProject, startPipeline, connectPipelineWs } from "@/lib/api";
import type { Project, PipelineStep, WsPipelineMessage } from "@/lib/types";

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [activeProjectStatus, setActiveProjectStatus] = useState<string>("idle");
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStep[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ percent: number; loadedMb: number; totalMb: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when an upload hits the SHA-256 content-fingerprint cache instead
  // of running a fresh reconstruction - see handleUpload below.
  const [cacheNotice, setCacheNotice] = useState<{ projectId: number; imageCount: number | null; createdAt: string | null } | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);

  // Load projects list
  const fetchProjects = async () => {
    try {
      const res = await listProjects(false);
      const EXCLUDED_EXTENSIONS = [".splat", ".ply", ".lcc", ".obj", ".glb", ".gltf"];
      const photoProjects = (res.projects || []).filter(
        (p) => p.image_count > 1 && (!p.name || !EXCLUDED_EXTENSIONS.some((ext) => p.name.toLowerCase().endsWith(ext)))
      );
      setProjects(photoProjects);
      
      // If a project is currently processing, track it
      const active = photoProjects.find((p) => p.status === "processing");
      if (active) {
        setActiveProjectId(active.id);
        setActiveProjectStatus(active.status);
      }
    } catch (err: unknown) {
      console.error(err);
      setError("Failed to load projects list");
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  // Listen to WebSocket updates when there's an active project
  useEffect(() => {
    if (!activeProjectId) return;

    const ws = connectPipelineWs(
      activeProjectId,
      (data) => {
        const msg = data as WsPipelineMessage;
        setPipelineSteps(msg.steps || []);
        setActiveProjectStatus(msg.project_status);
        if (msg.project_status === "completed" || msg.project_status === "failed") {
          fetchProjects(); // Refresh project list to show updated status
          setActiveProjectId(null);
        }
      },
      () => {
        // On connection close, refresh projects
        fetchProjects();
      }
    );

    return () => {
      ws.close();
    };
  }, [activeProjectId]);

  // Handle uploading files
  const handleUpload = async (files: File[], force: boolean = false) => {
    setIsUploading(true);
    setUploadProgress({ percent: 0, loadedMb: 0, totalMb: 0 });
    setError(null);
    setCacheNotice(null);
    try {
      // 1. Upload files and get project ID with real-time byte progress
      const uploadRes = await uploadImages(files, (percent, loadedBytes, totalBytes) => {
        setUploadProgress({
          percent,
          loadedMb: Math.round((loadedBytes / (1024 * 1024)) * 10) / 10,
          totalMb: Math.round((totalBytes / (1024 * 1024)) * 10) / 10,
        });
      }, force);

      setIsUploading(false);
      setUploadProgress(null);

      // Handle instant fingerprint cache match (§7.1). Was: silently
      // navigated to the old project as if a fresh reconstruction had just
      // run - there was no way to tell "this really is new" from "this was
      // instantly reused" apart, so uploading photos that happened to match
      // (byte-for-byte) an earlier completed project's content hash looked
      // identical to a real regeneration. Now this is surfaced explicitly,
      // with a one-click way to force a genuinely fresh reconstruction of
      // these same files instead of reusing the cached one.
      if (uploadRes.status === "cached_match") {
        setPendingFiles(files);
        setCacheNotice({
          projectId: uploadRes.project_id,
          imageCount: uploadRes.image_count ?? null,
          createdAt: uploadRes.created_at ?? null,
        });
        return;
      }

      if (uploadRes.skipped_model_files && uploadRes.skipped_model_files.length > 0) {
        setError(
          `Note: ${uploadRes.skipped_model_files.length} 3D model file(s) in your selection were ignored ` +
          `(not used as photos): ${uploadRes.skipped_model_files.join(", ")}`
        );
      }

      // 2. Set as active project and trigger pipeline
      setActiveProjectId(uploadRes.project_id);
      setActiveProjectStatus("processing");

      await startPipeline(uploadRes.project_id);
      fetchProjects();
    } catch (err: unknown) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Error uploading files");
      setIsUploading(false);
      setUploadProgress(null);
    }
  };

  // "These exact photos already produced a completed project" - offered
  // when handleUpload gets a cached_match instead of running anything new.
  const handleForceRegenerate = () => {
    if (!pendingFiles) return;
    const files = pendingFiles;
    setCacheNotice(null);
    setPendingFiles(null);
    handleUpload(files, true);
  };

  const handleViewCachedProject = () => {
    if (!cacheNotice) return;
    window.location.href = `/viewer/${cacheNotice.projectId}`;
  };

  // Handle deleting a project
  const handleDelete = async (id: number) => {
    try {
      await deleteProject(id);
      if (activeProjectId === id) {
        setActiveProjectId(null);
      }
      fetchProjects();
    } catch (err) {
      console.error(err);
      setError("Failed to delete project");
    }
  };

  // Handle selecting a project to view or track
  const handleSelectProject = (id: number) => {
    const proj = projects.find((p) => p.id === id);
    if (!proj) return;
    
    if (proj.status === "completed") {
      // Navigate to the viewer page
      window.location.href = `/viewer/${id}`;
    } else {
      // Open the status tracker for this project
      setActiveProjectId(id);
      setActiveProjectStatus(proj.status);
    }
  };

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar />

      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-10 space-y-10">
        {error && (
          <div className="bg-[rgba(239,68,68,0.1)] border border-[var(--error)] text-[var(--error)] p-4 rounded-xl flex justify-between items-center">
            <span className="text-sm font-medium">{error}</span>
            <button onClick={() => setError(null)} className="text-xs font-bold hover:underline">
              Dismiss
            </button>
          </div>
        )}

        {cacheNotice && (
          <div className="bg-[rgba(245,158,11,0.1)] border border-amber-500/40 text-amber-200 p-4 rounded-xl space-y-3">
            <p className="text-sm font-medium">
              These exact photos already produced Project #{cacheNotice.projectId}
              {cacheNotice.imageCount ? ` (${cacheNotice.imageCount} photos)` : ""}
              {cacheNotice.createdAt ? ` on ${new Date(cacheNotice.createdAt).toLocaleString()}` : ""} —
              nothing new was reconstructed just now. Choose what to do:
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleForceRegenerate}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition-colors"
              >
                Force a fresh reconstruction of these photos
              </button>
              <button
                onClick={handleViewCachedProject}
                className="px-4 py-2 border border-amber-500/40 hover:bg-amber-500/10 rounded-xl text-xs font-bold transition-colors"
              >
                View the existing Project #{cacheNotice.projectId}
              </button>
              <button
                onClick={() => { setCacheNotice(null); setPendingFiles(null); }}
                className="px-4 py-2 text-xs font-medium text-amber-200/70 hover:underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
          {/* Main Upload / Status Panel */}
          <div className="lg:col-span-2 space-y-8">
            {activeProjectId ? (
              <div className="space-y-6">
                <div className="glass p-6 flex justify-between items-center">
                  <div>
                    <h3 className="font-bold text-lg">Active Project processing</h3>
                    <p className="text-sm text-[var(--text-secondary)]">Project ID: {activeProjectId}</p>
                  </div>
                  {activeProjectStatus !== "processing" && (
                    <button
                      onClick={() => setActiveProjectId(null)}
                      className="px-4 py-2 border border-[var(--border-glass)] hover:bg-[var(--bg-secondary)] rounded-xl text-sm font-medium transition-colors"
                    >
                      Back to Upload
                    </button>
                  )}
                </div>
                <PipelineTracker steps={pipelineSteps} status={activeProjectStatus} />
              </div>
            ) : (
              <UploadZone onUpload={handleUpload} isUploading={isUploading} uploadProgress={uploadProgress} />
            )}
          </div>

          {/* Quick Info & Guidelines */}
          <div className="glass p-8 space-y-6">
            <h2 className="text-xl font-bold">Quick Guidelines</h2>
            <ul className="space-y-4 text-sm text-[var(--text-secondary)]">
              <li className="flex gap-3">
                <span className="text-[var(--accent-primary)] font-bold">01</span>
                <span>Move in a slow circle or grid patterns around the room.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-[var(--accent-primary)] font-bold">02</span>
                <span>Ensure overlapping viewpoints (60–80% overlap between photos).</span>
              </li>
            </ul>

            <div className="pt-4 border-t border-white/10 space-y-3">
              <h3 className="text-sm font-bold text-indigo-300 flex items-center gap-2">
                <span>📁</span> Open Local 3D File
              </h3>
              <p className="text-xs text-[var(--text-secondary)]">
                Select 3D format to view or inspect geometry statistics locally:
              </p>

              <div className="flex flex-col gap-2">
                <select
                  id="unified-3d-format-selector"
                  aria-label="Select 3D File Format"
                  defaultValue=""
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "mesh") {
                      window.location.href = "/mesh-check";
                    } else if (val === "gaussian") {
                      window.location.href = "/viewer/local";
                    }
                  }}
                  className="w-full py-2.5 px-3 bg-zinc-900 border border-indigo-500/40 text-white text-xs font-semibold rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer shadow-sm"
                >
                  <option value="" disabled>Select 3D File Format (Splat, PLY, LCC, GLB, OBJ)...</option>
                  <option value="gaussian">🔸 Gaussian Splatting / Point Cloud (.splat, .ply, .lcc)</option>
                  <option value="mesh">🔷 3D Surface Mesh (.glb, .obj)</option>
                </select>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <Link
                    href="/viewer/local"
                    className="py-2 px-3 bg-indigo-600/80 hover:bg-indigo-500 text-white text-[11px] font-bold rounded-xl shadow-md transition-all text-center"
                  >
                    Splat / PLY / LCC
                  </Link>
                  <Link
                    href="/mesh-check"
                    className="py-2 px-3 bg-emerald-600/80 hover:bg-emerald-500 text-white text-[11px] font-bold rounded-xl shadow-md transition-all text-center"
                  >
                    GLB / OBJ Mesh
                  </Link>
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* Project List */}
        <div className="space-y-6">
          <h2 className="text-2xl font-black tracking-tight">Your Walkthroughs</h2>
          {projects.length === 0 ? (
            <div className="glass p-12 text-center text-[var(--text-secondary)]">
              No walkthroughs generated yet. Upload captures to get started!
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {projects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onDelete={handleDelete}
                  onSelect={handleSelectProject}
                />
              ))}
            </div>
          )}
        </div>

        {/* W1-48: Multi-Room Listing assembly + testing surface */}
        <ListingsPanel projects={projects} />
      </main>
    </div>
  );
}
