"use client";

import { useState, useCallback, useRef, useMemo } from "react";

interface UploadZoneProps {
  onUpload: (files: File[]) => void;
  isUploading: boolean;
  uploadProgress?: { percent: number; loadedMb: number; totalMb: number } | null;
}

export default function UploadZone({ onUpload, isUploading, uploadProgress }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [previewFiles, setPreviewFiles] = useState<File[]>([]);
  const [uploadMode, setUploadMode] = useState<"one-by-one" | "batch">("one-by-one");
  
  const batchInputRef = useRef<HTMLInputElement>(null);
  const singleInputRef = useRef<HTMLInputElement>(null);

  const isValidFile = (f: File) => {
    const ext = "." + f.name.toLowerCase().split(".").pop();
    const ALLOWED_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".zip", ".splat", ".ply", ".lcc"];
    return f.type.startsWith("image/") || ALLOWED_EXTS.includes(ext);
  };

  const appendFiles = useCallback((incoming: File[]) => {
    const valid = incoming.filter(isValidFile);
    if (valid.length === 0) return;

    setPreviewFiles((prev) => {
      const existingKeys = new Set(prev.map((f) => `${f.name}_${f.size}`));
      const uniqueNew = valid.filter((f) => !existingKeys.has(`${f.name}_${f.size}`));
      const combined = [...prev, ...uniqueNew];
      return combined.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
      );
    });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      appendFiles(files);
    },
    [appendFiles]
  );

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    appendFiles(files);
    // Reset input value so re-selecting the same single image triggers onChange
    e.target.value = "";
  };

  const removeFile = (indexToRemove: number) => {
    setPreviewFiles((prev) => prev.filter((_, idx) => idx !== indexToRemove));
  };

  const handleUpload = () => {
    if (previewFiles.length > 0) {
      onUpload(previewFiles);
    }
  };

  const previewItems = useMemo(() => {
    return previewFiles.map((file) => ({
      name: file.name,
      size: (file.size / (1024 * 1024)).toFixed(1),
      url: URL.createObjectURL(file),
    }));
  }, [previewFiles]);

  return (
    <div className="glass p-8 space-y-6">
      {/* Header & Mode Switcher */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <span>📸</span> Upload Room Capture
          </h2>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            Build your 3D reconstruction by adding photos one by one or uploading in bulk.
          </p>
        </div>

        {/* Upload Strategy Switcher */}
        <div className="flex items-center bg-black/30 p-1 rounded-xl border border-white/10 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setUploadMode("one-by-one")}
            className={`px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
              uploadMode === "one-by-one"
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-500/20"
                : "text-[var(--text-secondary)] hover:text-white"
            }`}
          >
            <span>➕</span> One-by-One
          </button>
          <button
            type="button"
            onClick={() => setUploadMode("batch")}
            className={`px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
              uploadMode === "batch"
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-500/20"
                : "text-[var(--text-secondary)] hover:text-white"
            }`}
          >
            <span>📦</span> Batch / Dropzone
          </button>
        </div>
      </div>

      {/* Hidden File Inputs */}
      <input
        ref={singleInputRef}
        type="file"
        multiple={false}
        accept="image/*,.heic"
        className="hidden"
        onChange={handleFileSelect}
      />
      <input
        ref={batchInputRef}
        type="file"
        multiple={true}
        accept="image/*,.zip,.splat,.ply,.lcc,.heic"
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* Upload Controls Section */}
      {uploadMode === "one-by-one" ? (
        <div className="bg-[rgba(99,102,241,0.05)] border border-indigo-500/20 rounded-2xl p-6 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-2xl text-indigo-400">
            📸
          </div>
          <div>
            <h3 className="font-bold text-sm text-white">Upload Images One by One</h3>
            <p className="text-xs text-[var(--text-secondary)] max-w-md mt-1">
              Select photos single image at a time. Each image will be appended to your staging list below for 3D processing.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => singleInputRef.current?.click()}
              disabled={isUploading}
              className="px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-500/25 transition-all flex items-center gap-2 disabled:opacity-50 cursor-pointer"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Choose Image One by One
            </button>

            <button
              type="button"
              onClick={() => batchInputRef.current?.click()}
              disabled={isUploading}
              className="px-4 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 text-white text-xs font-medium rounded-xl transition-all disabled:opacity-50"
            >
              Select Multiple / Folder
            </button>
          </div>
        </div>
      ) : (
        /* Drop Zone Mode */
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`
            relative flex flex-col items-center justify-center gap-4 p-10
            border-2 border-dashed rounded-2xl cursor-pointer
            transition-all duration-300
            ${
              isDragging
                ? "border-[var(--accent-primary)] bg-[rgba(99,102,241,0.08)] scale-[1.01]"
                : "border-[var(--border-glass)] hover:border-[rgba(255,255,255,0.2)] bg-black/10"
            }
          `}
          onClick={() => batchInputRef.current?.click()}
        >
          <svg
            width="44"
            height="44"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-indigo-400"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>

          <div className="text-center space-y-1">
            <p className="text-sm font-semibold text-white">
              {isDragging ? "Release photos here" : "Click or drag photos & 3D files here"}
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              Supports JPG, PNG, WEBP, ZIP archives, or 3D files (.splat, .ply, .lcc)
            </p>
          </div>
        </div>
      )}

      {/* Staged Preview Grid with One-by-One Item Management */}
      {previewFiles.length > 0 && (
        <div className="space-y-4 pt-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <p className="text-xs font-bold text-white tracking-wide uppercase">
                {previewFiles.length} {previewFiles.length === 1 ? "Photo" : "Photos"} Staged
              </p>
            </div>
            
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => singleInputRef.current?.click()}
                disabled={isUploading}
                className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold transition-colors flex items-center gap-1 disabled:opacity-50"
              >
                <span>➕</span> Add One More
              </button>

              <button
                type="button"
                onClick={() => setPreviewFiles([])}
                disabled={isUploading}
                className="text-xs text-rose-400 hover:text-rose-300 font-medium transition-colors disabled:opacity-50"
              >
                Clear All
              </button>
            </div>
          </div>

          {/* Individual Photo Cards */}
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 max-h-56 overflow-y-auto p-1">
            {previewItems.map((item, i) => (
              <div
                key={`${item.name}_${i}`}
                className="group relative aspect-square rounded-xl overflow-hidden bg-black/40 border border-white/10 hover:border-indigo-500/50 transition-all shadow-sm"
              >
                <img
                  src={item.url}
                  alt={item.name}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
                
                {/* Delete button one-by-one */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(i);
                  }}
                  disabled={isUploading}
                  className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/70 hover:bg-rose-600 text-white flex items-center justify-center text-xs font-bold opacity-80 hover:opacity-100 transition-all border border-white/20 shadow"
                  title="Remove image"
                >
                  ✕
                </button>

                {/* Info Overlay */}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-1.5 pt-4 text-[10px] text-white opacity-0 group-hover:opacity-100 transition-opacity truncate">
                  <p className="truncate font-medium">{item.name}</p>
                  <p className="text-[9px] text-white/60">{item.size} MB</p>
                </div>
              </div>
            ))}

            {/* Quick Add Button Tile inside Grid */}
            {!isUploading && (
              <button
                type="button"
                onClick={() => singleInputRef.current?.click()}
                className="aspect-square rounded-xl border border-dashed border-indigo-500/40 hover:border-indigo-400 bg-indigo-500/5 hover:bg-indigo-500/10 flex flex-col items-center justify-center gap-1 text-indigo-400 hover:text-indigo-300 transition-all text-xs font-medium"
              >
                <span className="text-lg">➕</span>
                <span>Add 1 More</span>
              </button>
            )}
          </div>

          {/* Capture Quality Guidance Banner */}
          {previewFiles.length > 0 && previewFiles.length < 30 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-xs text-amber-200 flex items-start gap-2">
              <span className="text-base">⚠️</span>
              <div>
                <p className="font-semibold">Capture Quality Recommendation:</p>
                <p className="text-[11px] text-amber-200/80 mt-0.5">
                  You have staged {previewFiles.length} photos. For a high-density 3D Gaussian Splat model (like Project #99 with ~7.6M splats), we recommend capturing at least 30–150+ sharp, overlapping photos around the space.
                </p>
              </div>
            </div>
          )}

          {/* Submit Upload Button */}
          <button
            onClick={handleUpload}
            disabled={isUploading}
            className="btn-primary w-full flex flex-col items-center justify-center gap-2 p-3 mt-4"
          >
            {isUploading ? (
              <div className="w-full space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold text-white">
                  <span className="flex items-center gap-2">
                    <span className="animate-spin inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full" />
                    Uploading {previewFiles.length} Photos…
                  </span>
                  <span className="font-mono text-cyan-300">
                    {uploadProgress?.percent ?? 0}% ({uploadProgress?.loadedMb ?? 0} MB / {uploadProgress?.totalMb ?? 0} MB)
                  </span>
                </div>
                <div className="w-full h-2.5 bg-black/40 rounded-full overflow-hidden border border-white/10">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 via-cyan-400 to-emerald-400 transition-all duration-200"
                    style={{ width: `${uploadProgress?.percent ?? 0}%` }}
                  />
                </div>
                <p className="text-[11px] text-white/70 text-center font-normal pt-1">
                  💡 Tip: Compressing photos into a single <b>ZIP file</b> (e.g. <code>photos.zip</code>) uploads up to 5x faster!
                </p>
              </div>
            ) : (
              <>Upload {previewFiles.length} {previewFiles.length === 1 ? "Image" : "Images"} & Start 3D Reconstruction</>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

