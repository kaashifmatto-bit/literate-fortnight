"use client";

import React, { useState } from "react";

export interface ViewerToolbarProps {
  variant: "walkthrough" | "dollhouse" | "floorplan";
  onVariantChange: (v: "walkthrough" | "dollhouse" | "floorplan") => void;
  onToggleThumbnails?: () => void;
  onAutoPlay?: () => void;
  onMeasure?: () => void;
  onShare?: () => void;
}

export default function ViewerToolbar({
  variant,
  onVariantChange,
  onToggleThumbnails,
  onAutoPlay,
  onMeasure,
  onShare,
}: ViewerToolbarProps) {
  const [isPlaying, setIsPlaying] = useState(false);

  return (
    <>
      {/* Bottom Left Toolbar */}
      <div className="absolute bottom-6 left-20 z-30 flex items-center gap-1.5 bg-black/80 backdrop-blur-md border border-white/15 p-1.5 rounded-full shadow-2xl">
        {/* 1. Frames / Thumbnail Strip */}
        <button
          onClick={onToggleThumbnails}
          className="p-2 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors"
          title="Toggle Thumbnail Strip"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth="2" />
            <path d="M3 15h18M9 3v18" strokeWidth="2" />
          </svg>
        </button>

        {/* 2. Play Auto-Tour */}
        <button
          onClick={() => {
            setIsPlaying(!isPlaying);
            onAutoPlay?.();
          }}
          className={`p-2 rounded-full transition-colors ${
            isPlaying ? "text-purple-400 bg-purple-500/20" : "text-white/70 hover:text-white hover:bg-white/10"
          }`}
          title={isPlaying ? "Pause Guided Tour" : "Play Guided Tour"}
        >
          {isPlaying ? (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <div className="w-px h-4 bg-white/15 my-auto" />

        {/* 3. Dollhouse View Icon (Cube) */}
        <button
          onClick={() => onVariantChange("dollhouse")}
          className={`p-2 rounded-full transition-colors ${
            variant === "dollhouse" ? "text-purple-300 bg-purple-600/40 border border-purple-400/50" : "text-white/70 hover:text-white hover:bg-white/10"
          }`}
          title="Dollhouse 3D View"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeWidth="2" d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <polyline strokeWidth="2" points="3.27 6.96 12 12.01 20.73 6.96" />
            <line strokeWidth="2" x1="12" y1="22.08" x2="12" y2="12" />
          </svg>
        </button>

        {/* 4. Floor Plan Icon (L-Shape top down) */}
        <button
          onClick={() => onVariantChange("floorplan")}
          className={`p-2 rounded-full transition-colors ${
            variant === "floorplan" ? "text-purple-300 bg-purple-600/40 border border-purple-400/50" : "text-white/70 hover:text-white hover:bg-white/10"
          }`}
          title="Floor Plan Mode"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeWidth="2" d="M3 3h18v18H3V3z" />
            <path strokeWidth="2" d="M9 3v18M3 12h18" />
          </svg>
        </button>

        {/* 5. Walk Mode Icon (Person silhouette - Active Highlighted) */}
        <button
          onClick={() => onVariantChange("walkthrough")}
          className={`p-2 rounded-full transition-colors ${
            variant === "walkthrough" ? "text-purple-300 bg-purple-600/40 border border-purple-400/50" : "text-white/70 hover:text-white hover:bg-white/10"
          }`}
          title="Inside 360° Walk Mode"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="4" r="2" />
            <path d="M15.8 8.2c-.4-.4-1-.6-1.6-.6h-4.4c-.6 0-1.2.2-1.6.6L5.5 11c-.4.4-.4 1 0 1.4s1 .4 1.4 0l2.1-2.1V15l-1.8 3.6c-.3.6.1 1.4.8 1.4h.2c.5 0 .9-.3 1.1-.7l1.7-3.3h2l1.7 3.3c.2.4.6.7 1.1.7h.2c.7 0 1.1-.8.8-1.4L15 15V10.3l2.1 2.1c.4.4 1 .4 1.4 0s.4-1 0-1.4l-2.7-2.8z" />
          </svg>
        </button>

        {/* 6. Measure Tool Icon */}
        <button
          onClick={onMeasure}
          className="p-2 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors"
          title="Measure Distance Tool"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeWidth="2" d="M2 12l5-5 5 5 5-5 5 5" />
            <path strokeWidth="2" d="M2 17l5-5 5 5 5-5 5 5" />
          </svg>
        </button>
      </div>

      {/* Bottom Right Share & More Menu */}
      <div className="absolute bottom-6 right-48 z-30 flex items-center gap-1.5 bg-black/80 backdrop-blur-md border border-white/15 p-1.5 rounded-full shadow-2xl">
        <button
          onClick={onShare}
          className="p-2 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors"
          title="Share Tour Link"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="18" cy="5" r="3" strokeWidth="2" />
            <circle cx="6" cy="12" r="3" strokeWidth="2" />
            <circle cx="18" cy="19" r="3" strokeWidth="2" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" strokeWidth="2" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" strokeWidth="2" />
          </svg>
        </button>

        <button
          className="p-2 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors"
          title="More Options"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="5" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="12" cy="19" r="1.5" />
          </svg>
        </button>
      </div>
    </>
  );
}
