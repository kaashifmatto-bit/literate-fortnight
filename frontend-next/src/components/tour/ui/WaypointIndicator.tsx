"use client";

import React from "react";

export interface WaypointIndicatorProps {
  current: number;
  total: number;
}

export default function WaypointIndicator({ current, total }: WaypointIndicatorProps) {
  return (
    <div className="absolute bottom-6 right-6 z-30 flex items-center gap-3 pointer-events-none">
      <span className="text-white/90 text-xs font-bold bg-black/75 px-4 py-1.5 rounded-full border border-white/15 backdrop-blur-md shadow-xl">
        Waypoint {current} of {total}
      </span>
    </div>
  );
}
