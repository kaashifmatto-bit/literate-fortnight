"use client";

import React from "react";
import * as THREE from "three";

export interface HotspotItem {
  id: string | number;
  type: "navigation" | "info" | "media";
  yaw: number;   // degrees
  pitch: number; // degrees
  label?: string;
  badge?: string;
  description?: string;
  targetNodeId?: string | number;
  mediaUrl?: string;
}

export interface HotspotLayerProps {
  camera: THREE.PerspectiveCamera | null;
  containerWidth: number;
  containerHeight: number;
  hotspots: HotspotItem[];
  onHotspotClick: (hotspot: HotspotItem) => void;
}

export default function HotspotLayer({
  camera,
  containerWidth,
  containerHeight,
  hotspots,
  onHotspotClick,
}: HotspotLayerProps) {
  if (!camera || containerWidth === 0 || containerHeight === 0) return null;

  return (
    <div className="absolute inset-0 pointer-events-none z-20 overflow-hidden">
      {hotspots.map((hotspot) => {
        // Project (yaw, pitch) to screen
        const yawRad = THREE.MathUtils.degToRad(hotspot.yaw);
        const pitchRad = THREE.MathUtils.degToRad(hotspot.pitch);
        const radius = 400;

        const worldPos = new THREE.Vector3(
          radius * Math.sin(yawRad) * Math.cos(pitchRad),
          radius * Math.sin(pitchRad),
          -radius * Math.cos(yawRad) * Math.cos(pitchRad)
        );

        const cameraDir = new THREE.Vector3();
        camera.getWorldDirection(cameraDir);
        const hotspotDir = worldPos.clone().normalize();
        const dot = cameraDir.dot(hotspotDir);

        if (dot <= 0.15) return null; // Behind camera

        const projected = worldPos.clone().project(camera);
        const screenX = (projected.x + 1) * containerWidth / 2;
        const screenY = (-projected.y + 1) * containerHeight / 2;

        if (
          screenX < -60 ||
          screenX > containerWidth + 60 ||
          screenY < -60 ||
          screenY > containerHeight + 60
        ) {
          return null;
        }

        const scale = Math.max(0.65, Math.min(1.2, dot));

        return (
          <div
            key={hotspot.id}
            onClick={(e) => {
              e.stopPropagation();
              onHotspotClick(hotspot);
            }}
            className="absolute pointer-events-auto cursor-pointer group flex flex-col items-center justify-center -translate-x-1/2 -translate-y-1/2 transition-transform duration-100"
            style={{
              left: `${screenX}px`,
              top: `${screenY}px`,
              transform: `translate(-50%, -50%) scale(${scale})`,
            }}
          >
            {/* Navigation Ring Pin */}
            {hotspot.type === "navigation" && (
              <div className="relative flex items-center justify-center">
                <div className="absolute w-12 h-12 rounded-full bg-cyan-400/30 animate-ping" />
                <div className="w-12 h-12 rounded-full border-2 border-white/90 bg-cyan-500/30 backdrop-blur-md flex items-center justify-center shadow-[0_0_20px_rgba(6,182,212,0.8)] group-hover:scale-110 group-hover:bg-cyan-500/50 transition-all duration-300">
                  <div className="w-4 h-4 rounded-full bg-cyan-300 shadow-[0_0_10px_#38bdf8]" />
                </div>
              </div>
            )}

            {/* Info Point Pin (Teal Ring + Number Badge) */}
            {hotspot.type === "info" && (
              <div className="relative flex items-center justify-center">
                <div className="w-10 h-10 rounded-full border-2 border-teal-400 bg-teal-950/80 backdrop-blur-md flex items-center justify-center shadow-[0_0_15px_rgba(20,184,166,0.8)] group-hover:scale-110 group-hover:border-teal-300 transition-all">
                  <span className="text-teal-200 font-bold text-xs">{hotspot.badge || "ℹ️"}</span>
                </div>
              </div>
            )}

            {/* Media Overlay Pin (Purple Camera Icon) */}
            {hotspot.type === "media" && (
              <div className="relative flex items-center justify-center">
                <div className="w-10 h-10 rounded-full border-2 border-purple-400 bg-purple-950/80 backdrop-blur-md flex items-center justify-center shadow-[0_0_15px_rgba(168,85,247,0.8)] group-hover:scale-110 group-hover:border-purple-300 transition-all">
                  <span className="text-purple-200 font-bold text-xs">📷</span>
                </div>
              </div>
            )}

            {/* Label Tooltip on Hover */}
            {hotspot.label && (
              <span className="mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-black/85 text-white text-[11px] font-bold px-3 py-1 rounded-full border border-white/20 whitespace-nowrap shadow-2xl backdrop-blur-md">
                {hotspot.label}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
