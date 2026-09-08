"use client";

import React, { useEffect, useState } from "react";

export default function BottomControlHints() {
  const [isTouch, setIsTouch] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsTouch("ontouchstart" in window || navigator.maxTouchPoints > 0);
    }
  }, []);

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
      <div className="bg-black/75 backdrop-blur-md border border-white/15 text-white/80 px-5 py-2 rounded-full text-xs font-medium flex items-center gap-4 shadow-2xl">
        {isTouch ? (
          <>
            <span><b className="text-purple-400 font-bold">Tap Hotspot</b> Walk</span>
            <span className="text-white/30">|</span>
            <span><b className="text-purple-400 font-bold">Drag</b> Rotate 360°</span>
            <span className="text-white/30">|</span>
            <span><b className="text-purple-400 font-bold">Pinch</b> Zoom</span>
          </>
        ) : (
          <>
            <span><b className="text-purple-400 font-bold">W / S</b> Glide Walk</span>
            <span className="text-white/30">|</span>
            <span><b className="text-purple-400 font-bold">A / D</b> Rotate 360°</span>
            <span className="text-white/30">|</span>
            <span><b className="text-purple-400 font-bold">Drag</b> Free Look</span>
            <span className="text-white/30">|</span>
            <span><b className="text-purple-400 font-bold">Scroll</b> Zoom</span>
          </>
        )}
      </div>
    </div>
  );
}
