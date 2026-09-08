"use client";

import React from "react";

export interface CompassButtonProps {
  yawDeg: number;
  onSnapNorth?: () => void;
}

export default function CompassButton({ yawDeg, onSnapNorth }: CompassButtonProps) {
  // Rotate compass needle inversely to camera yaw
  const rotation = -yawDeg;

  return (
    <button
      onClick={onSnapNorth}
      className="absolute bottom-6 left-6 z-30 w-11 h-11 rounded-full bg-black/80 hover:bg-black border border-white/20 backdrop-blur-md shadow-2xl flex items-center justify-center transition-all hover:scale-105 group"
      title="Snap View to North (0° Yaw)"
    >
      <div
        className="w-7 h-7 flex items-center justify-center transition-transform duration-100 ease-out"
        style={{ transform: `rotate(${rotation}deg)` }}
      >
        <svg viewBox="0 0 24 24" className="w-6 h-6">
          {/* Red North Pointer */}
          <polygon points="12,2 16,12 12,10 8,12" fill="#ef4444" />
          {/* South Pointer */}
          <polygon points="12,22 16,12 12,10 8,12" fill="#94a3b8" />
        </svg>
      </div>
      <span className="absolute top-1 text-[9px] font-black text-red-400 drop-shadow">N</span>
    </button>
  );
}
