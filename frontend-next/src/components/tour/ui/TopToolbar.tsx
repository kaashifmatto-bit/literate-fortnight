"use client";

import React from "react";
import Link from "next/link";

export interface TopToolbarProps {
  tourId: string | number;
  brandName?: string;
  viewMode: "walkthrough" | "dollhouse" | "floorplan";
  walkthroughType: "photo" | "splat";
  onViewModeChange: (mode: "walkthrough" | "dollhouse" | "floorplan") => void;
  onWalkthroughTypeChange: (type: "photo" | "splat") => void;
  onDownloadFormat?: (format: "splat" | "ply" | "lcc") => void;
  onClose?: () => void;
}

const DL_ICON = (
  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
  </svg>
);

export default function TopToolbar({
  tourId,
  brandName = "ArticulAIT Studio",
  viewMode,
  walkthroughType,
  onViewModeChange,
  onWalkthroughTypeChange,
  onDownloadFormat,
  onClose,
}: TopToolbarProps) {
  return (
    <div className="absolute top-3 inset-x-4 z-40 flex items-center justify-between gap-2.5 pointer-events-none flex-nowrap overflow-x-auto no-scrollbar">
      {/* Left: Studio/Brand + Status Dot + Tour ID */}
      <div className="flex items-center gap-2 flex-shrink-0 pointer-events-auto">
        <div className="bg-black/85 backdrop-blur-xl border border-white/15 px-3 py-1.5 rounded-full text-xs font-semibold shadow-2xl flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="font-bold tracking-tight text-white">{brandName}</span>
          <span className="text-emerald-300 font-mono text-[10px] bg-emerald-950/80 px-2 py-0.5 rounded-full border border-emerald-500/30">
            #{tourId}
          </span>
        </div>
      </div>

      {/* Center: Mode Switcher & Tour Engine Toggle */}
      <div className="flex items-center gap-2 flex-shrink-0 pointer-events-auto">
        {/* Segmented Control for Modes */}
        <div className="flex items-center gap-1 bg-black/85 backdrop-blur-xl border border-white/15 p-1 rounded-full shadow-2xl">
          {(["walkthrough", "dollhouse", "floorplan"] as const).map((mode) => {
            const isActive = viewMode === mode;
            const labels = { walkthrough: "WALKTHROUGH", dollhouse: "DOLLHOUSE", floorplan: "FLOOR PLAN" };
            return (
              <button
                key={mode}
                onClick={() => onViewModeChange(mode)}
                className={`px-3.5 py-1.5 text-[11px] font-bold rounded-full transition-all duration-200 ${
                  isActive
                    ? "bg-gradient-to-r from-purple-600 to-blue-600 text-white shadow-md shadow-purple-500/30 border border-purple-400/40"
                    : "text-white/70 hover:text-white hover:bg-white/10"
                }`}
              >
                {labels[mode]}
              </button>
            );
          })}
        </div>

        {/* Photo Tour / Free Explore 3D Pill Buttons */}
        {viewMode === "walkthrough" && (
          <div className="flex items-center gap-1.5 bg-black/90 backdrop-blur-2xl border border-white/20 p-1 rounded-full shadow-2xl">
            <button
              onClick={() => onWalkthroughTypeChange("photo")}
              className={`px-3.5 py-1.5 text-xs font-black rounded-full transition-all duration-300 flex items-center gap-1.5 ${
                walkthroughType === "photo"
                  ? "bg-gradient-to-r from-violet-600 via-purple-600 to-pink-500 text-white border border-fuchsia-300/70 shadow-[0_0_20px_rgba(217,70,239,0.7)]"
                  : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              <span className="text-white drop-shadow font-extrabold text-[11px]">📷 Photo Tour</span>
              <span className={`px-1.5 py-0.5 text-[8px] rounded-full font-black uppercase tracking-wider ${
                walkthroughType === "photo" ? "bg-black/50 text-fuchsia-200 border border-fuchsia-300/60" : "bg-white/10 text-white/50"
              }`}>
                RECOMMENDED
              </span>
            </button>

            <button
              onClick={() => onWalkthroughTypeChange("splat")}
              className={`px-3.5 py-1.5 text-xs font-black rounded-full transition-all duration-300 flex items-center gap-1.5 ${
                walkthroughType === "splat"
                  ? "bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 text-white border border-cyan-300/70 shadow-[0_0_20px_rgba(20,184,166,0.6)]"
                  : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              <span className="text-white drop-shadow font-extrabold text-[11px]">✨ Free Explore 3D</span>
              <span className={`px-1.5 py-0.5 text-[8px] rounded-full font-black uppercase tracking-wider ${
                walkthroughType === "splat" ? "bg-black/40 text-cyan-200 border border-cyan-300/50" : "bg-white/10 text-white/50"
              }`}>
                BETA
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Right: Download buttons (.splat, .ply, .lcc) & Close (✕) */}
      <div className="flex items-center gap-2 flex-shrink-0 pointer-events-auto">
        <div className="flex items-center gap-1 bg-black/85 backdrop-blur-md border border-white/15 p-1 rounded-full shadow-2xl">
          <button
            onClick={() => onDownloadFormat?.("splat")}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold text-emerald-300 hover:text-white hover:bg-emerald-600/80 rounded-full transition-all"
            title="Download .splat format"
          >
            {DL_ICON} .splat
          </button>
          <div className="w-px h-3.5 bg-white/15" />
          <button
            onClick={() => onDownloadFormat?.("ply")}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold text-sky-300 hover:text-white hover:bg-sky-600/80 rounded-full transition-all"
            title="Download .ply format"
          >
            {DL_ICON} .ply
          </button>
          <div className="w-px h-3.5 bg-white/15" />
          <button
            onClick={() => onDownloadFormat?.("lcc")}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold text-amber-300 hover:text-white hover:bg-amber-600/80 rounded-full transition-all"
            title="Download .lcc format"
          >
            {DL_ICON} .lcc
          </button>
        </div>

        {onClose ? (
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-black/85 hover:bg-red-950/70 text-white/80 hover:text-red-200 border border-white/15 flex items-center justify-center font-bold text-xs transition-all shadow-2xl"
            title="Close Tour"
          >
            ✕
          </button>
        ) : (
          <Link
            href="/"
            className="w-8 h-8 rounded-full bg-black/85 hover:bg-red-950/70 text-white/80 hover:text-red-200 border border-white/15 flex items-center justify-center font-bold text-xs transition-all shadow-2xl"
            title="Exit"
          >
            ✕
          </Link>
        )}
      </div>
    </div>
  );
}
