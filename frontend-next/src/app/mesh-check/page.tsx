"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import MeshCheckViewer, { MeshStats } from "@/components/MeshCheckViewer";
import { getApiBase } from "@/lib/api";

export default function MeshCheckPage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [stats, setStats] = useState<MeshStats | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleStatsLoaded = useCallback((loadedStats: MeshStats) => {
    setStats(loadedStats);
  }, []);

  const handleViewerError = useCallback((err: string) => {
    setErrorMessage(err);
  }, []);

  const validateAndSetFile = (file: File) => {
    setErrorMessage(null);
    setStats(null);

    const ext = file.name.toLowerCase().split(".").pop();
    if (ext !== "glb" && ext !== "gltf" && ext !== "obj") {
      setErrorMessage(
        `Invalid file extension '.${ext}'. Only .glb and .obj files are supported.`
      );
      setSelectedFile(null);
      return;
    }

    setSelectedFile(file);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      validateAndSetFile(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      validateAndSetFile(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleReset = () => {
    setSelectedFile(null);
    setStats(null);
    setErrorMessage(null);
  };

  const handleSaveToBackend = async () => {
    if (!selectedFile) return;
    try {
      const ext = selectedFile.name.toLowerCase().split(".").pop() || "glb";
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("file_format", ext === "gltf" ? "glb" : ext);

      const apiBase = getApiBase();
      const res = await fetch(`${apiBase}/api/upload/scene`, {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        const data = await res.json();
        alert(`Successfully saved 3D model to local backend field! (Project ID: ${data.project_id})`);
      } else {
        alert("Failed to save 3D model to backend field.");
      }
    } catch (err) {
      console.error(err);
      alert("Error uploading 3D model to backend API.");
    }
  };

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar />

      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-10 space-y-8">
        {/* Header Title */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-white/10">
          <div>
            <div className="flex items-center gap-3">
              <Link
                href="/"
                className="text-xs font-semibold text-[var(--text-secondary)] hover:text-white transition-colors flex items-center gap-1"
              >
                ← Back to Studio
              </Link>
              <span className="text-white/20">•</span>
              <span className="text-xs font-bold text-indigo-400 uppercase tracking-wider">
                Client-Side Inspection Tool
              </span>
            </div>
            <h1 className="text-3xl font-black tracking-tight mt-1">
              3D Mesh Inspector
            </h1>
            <p className="text-sm text-[var(--text-secondary)] mt-1">
              Upload any <code className="text-emerald-400 font-mono">.glb</code> or{" "}
              <code className="text-emerald-400 font-mono">.obj</code> file to preview
              and inspect geometry statistics directly in your browser.
            </p>
          </div>

          {selectedFile && (
            <button
              onClick={handleReset}
              className="px-4 py-2.5 bg-white/10 hover:bg-white/20 text-white text-xs font-bold rounded-xl border border-white/15 transition-all shadow-lg flex items-center justify-center gap-2"
            >
              <span>📁</span> Check Another Model
            </button>
          )}
        </div>

        {/* Error Notification */}
        {errorMessage && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-2xl flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-lg">⚠️</span>
              <span className="text-sm font-medium">{errorMessage}</span>
            </div>
            <button
              onClick={() => setErrorMessage(null)}
              className="text-xs font-bold text-red-400 hover:underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Upload Zone or 3D Viewer */}
        {!selectedFile ? (
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`glass p-12 text-center rounded-3xl border-2 border-dashed transition-all flex flex-col items-center justify-center min-h-[400px] ${
              isDragOver
                ? "border-indigo-500 bg-indigo-500/10 scale-[1.01]"
                : "border-white/20 hover:border-indigo-400/50"
            }`}
          >
            <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-3xl mb-4 shadow-xl">
              📦
            </div>
            <h3 className="text-xl font-bold mb-2">
              Drag & Drop your 3D Model here
            </h3>
            <p className="text-sm text-[var(--text-secondary)] max-w-md mb-4">
              Inspect geometry statistics and preview 3D meshes directly in your browser.
            </p>

            {/* Dropdown Format Selector */}
            <div className="mb-6 flex flex-col items-center gap-2">
              <label htmlFor="mesh-format-dropdown" className="text-xs text-indigo-300 font-semibold uppercase tracking-wider">
                Target 3D Format Dropdown
              </label>
              <select
                id="mesh-format-dropdown"
                aria-label="Target 3D Format Dropdown"
                defaultValue="glb"
                className="px-4 py-2 bg-zinc-900 border border-indigo-500/40 text-white text-xs font-semibold rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer shadow-md"
              >
                <option value="glb">🔷 GLTF / GLB Binary Mesh (.glb)</option>
                <option value="obj">📐 Wavefront Geometry Mesh (.obj)</option>
                <option value="splat">🔸 Gaussian Splatting (.splat)</option>
                <option value="ply">⚪ Point Cloud / Mesh (.ply)</option>
                <option value="lcc">📦 ArticulAIT LCC Container (.lcc)</option>
              </select>
            </div>

            <label className="cursor-pointer px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-xl shadow-lg shadow-indigo-500/25 transition-all">
              <span>Browse 3D Files</span>
              <input
                type="file"
                accept=".glb,.gltf,.obj,.splat,.ply,.lcc"
                onChange={handleFileChange}
                className="hidden"
              />
            </label>

            <div className="mt-8 pt-6 border-t border-white/10 flex items-center gap-6 text-xs text-[var(--text-secondary)]">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400" /> Client-Side Preview
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-indigo-400" /> Auto Bounding Box
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-violet-400" /> Local Field Persistence
              </span>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* 3D Canvas Container */}
            <div className="lg:col-span-2 h-[550px] relative">
              <MeshCheckViewer
                file={selectedFile}
                onStatsLoaded={handleStatsLoaded}
                onError={handleViewerError}
              />
            </div>

            {/* Info Panel & Stats */}
            <div className="space-y-6">
              <div className="glass p-6 rounded-2xl space-y-6">
                <div className="flex items-center justify-between pb-4 border-b border-white/10">
                  <h3 className="font-bold text-lg flex items-center gap-2">
                    <span>📊</span> Mesh Statistics
                  </h3>
                  <span className="text-xs px-2.5 py-1 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-semibold uppercase">
                    {selectedFile.name.split(".").pop()?.toUpperCase()}
                  </span>
                </div>

                <div className="space-y-4 text-sm">
                  <div>
                    <span className="text-xs text-[var(--text-secondary)] block">
                      Filename
                    </span>
                    <span className="font-mono font-medium text-white break-all">
                      {selectedFile.name}
                    </span>
                  </div>

                  {stats && (
                    <>
                      <div className="grid grid-cols-2 gap-4 pt-2">
                        <div className="p-3 bg-white/5 rounded-xl border border-white/5">
                          <span className="text-xs text-[var(--text-secondary)] block">
                            File Size
                          </span>
                          <span className="text-lg font-black text-emerald-400">
                            {stats.fileSizeFormatted}
                          </span>
                        </div>

                        <div className="p-3 bg-white/5 rounded-xl border border-white/5">
                          <span className="text-xs text-[var(--text-secondary)] block">
                            Vertices
                          </span>
                          <span className="text-lg font-black text-indigo-400">
                            {stats.vertexCount.toLocaleString()}
                          </span>
                        </div>
                      </div>

                      <div className="p-3 bg-white/5 rounded-xl border border-white/5">
                        <span className="text-xs text-[var(--text-secondary)] block">
                          Triangles / Polygons
                        </span>
                        <span className="text-xl font-black text-violet-300">
                          {stats.triangleCount.toLocaleString()}
                        </span>
                      </div>

                      <div className="p-3 bg-white/5 rounded-xl border border-white/5">
                        <span className="text-xs text-[var(--text-secondary)] block mb-1">
                          Bounding Box Extents (W × H × D)
                        </span>
                        <span className="font-mono text-xs text-white">
                          {stats.boundingBox.x}m × {stats.boundingBox.y}m ×{" "}
                          {stats.boundingBox.z}m
                        </span>
                      </div>

                      {/* Sanity Check Indicator */}
                      <div className="pt-2">
                        {stats.triangleCount > 50000 ? (
                          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs flex items-center gap-2 font-medium">
                            <span>✅</span> High-Detail Mesh (Passed Sanity Check)
                          </div>
                        ) : stats.triangleCount > 5000 ? (
                          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-2 font-medium">
                            <span>⚡</span> Low-Poly / Decimated Surface Mesh
                          </div>
                        ) : (
                          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs flex items-center gap-2 font-medium">
                            <span>⚠️</span> Very Low Triangle Count (Fragmented or Sparse Mesh)
                          </div>
                        )}
                      </div>

                      {/* Save to Backend Field Button */}
                      <div className="pt-3 border-t border-white/10">
                        <button
                          onClick={handleSaveToBackend}
                          className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-indigo-500/20 transition-all flex items-center justify-center gap-2 cursor-pointer"
                        >
                          <span>💾</span> Save Model to Backend Field
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Interaction Guide */}
              <div className="glass p-6 rounded-2xl space-y-3 text-xs text-[var(--text-secondary)]">
                <h4 className="font-bold text-white text-sm mb-2">Controls Guide</h4>
                <div className="flex justify-between items-center py-1 border-b border-white/5">
                  <span>Rotate Model</span>
                  <span className="text-white font-medium">Left Click + Drag</span>
                </div>
                <div className="flex justify-between items-center py-1 border-b border-white/5">
                  <span>Zoom In / Out</span>
                  <span className="text-white font-medium">Mouse Wheel Scroll</span>
                </div>
                <div className="flex justify-between items-center py-1">
                  <span>Pan Camera</span>
                  <span className="text-white font-medium">Right Click + Drag</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
