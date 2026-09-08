"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import PanoramaViewer, { PanoramaViewerRef } from "./PanoramaViewer";
import SplatViewer from "@/components/SplatViewer";
import TopToolbar from "./ui/TopToolbar";
import BottomControlHints from "./ui/BottomControlHints";
import WaypointIndicator from "./ui/WaypointIndicator";
import CompassButton from "./ui/CompassButton";
import ViewerToolbar from "./ui/ViewerToolbar";
import { HotspotItem } from "./HotspotLayer";

export interface TourViewerProps {
  tourId: string | number;
  initialPanoramaUrl?: string;
  waypoints?: Array<{
    index: number;
    filename: string;
    image_url: string;
    raw_image_url?: string;
    position?: { x: number; y: number; z: number };
    connections?: number[];
  }>;
  hotspots?: HotspotItem[];
  splatUrl?: string;
  onClose?: () => void;
}

import { getApiBase } from "@/lib/api";

const BASE = getApiBase();

export default function TourViewer({
  tourId,
  initialPanoramaUrl,
  waypoints = [],
  hotspots = [],
  splatUrl,
  onClose,
}: TourViewerProps) {
  const viewerRef = useRef<PanoramaViewerRef | null>(null);

  const [viewMode, setViewMode] = useState<"walkthrough" | "dollhouse" | "floorplan">("walkthrough");
  const [walkthroughType, setWalkthroughType] = useState<"photo" | "splat">("photo");
  const [currentFrame, setCurrentFrame] = useState(0);
  const [currentYaw, setCurrentYaw] = useState(0);
  const [activeModal, setActiveModal] = useState<{ title: string; description?: string; mediaUrl?: string } | null>(null);

  const totalFrames = waypoints.length || 1;

  // Resolve panorama image URL for a given node index
  const resolvePanoUrl = useCallback((idx: number): string => {
    const wp = waypoints.find((w) => w.index === idx);
    if (wp) {
      if (wp.image_url) {
        if (wp.image_url.startsWith("http")) return wp.image_url;
        if (wp.image_url.startsWith("/")) return `${BASE}${wp.image_url}`;
      }
      if (wp.raw_image_url) {
        if (wp.raw_image_url.startsWith("http")) return wp.raw_image_url;
        if (wp.raw_image_url.startsWith("/")) return `${BASE}${wp.raw_image_url}`;
      }
      const baseName = wp.filename ? wp.filename.replace(/\.[^/.]+$/, "") : "";
      return `${BASE}/data/project_${tourId}/images/${baseName || idx}.jpg`;
    }
    if (initialPanoramaUrl) return initialPanoramaUrl;
    return `${BASE}/data/project_${tourId}/images/${idx}.jpg`;
  }, [waypoints, initialPanoramaUrl, tourId]);

  const currentPanoUrl = resolvePanoUrl(currentFrame);

  // Filter hotspots for current waypoint node
  const currentNodeHotspots = hotspots.filter((h) => {
    if (h.targetNodeId !== undefined) return true; // Keep navigation links
    return true;
  });

  const handleHotspotClick = useCallback((hotspot: HotspotItem) => {
    if (hotspot.type === "navigation" && hotspot.targetNodeId !== undefined) {
      const targetIdx = typeof hotspot.targetNodeId === "number" ? hotspot.targetNodeId : parseInt(hotspot.targetNodeId, 10);
      viewerRef.current?.executeWalkTransition(targetIdx);
    } else {
      setActiveModal({
        title: hotspot.label || "Information Point",
        description: hotspot.description || "Interactive tour metadata point.",
        mediaUrl: hotspot.mediaUrl,
      });
    }
  }, []);

  const handleDownloadFormat = (format: "splat" | "ply" | "lcc") => {
    const url = `${BASE}/data/project_${tourId}/scene.${format}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `scene_project_${tourId}.${format}`;
    a.click();
  };

  return (
    <div className="w-screen h-screen overflow-hidden bg-[#030305] relative flex flex-col select-none text-white">
      {/* Top Header Chrome */}
      <TopToolbar
        tourId={tourId}
        viewMode={viewMode}
        walkthroughType={walkthroughType}
        onViewModeChange={setViewMode}
        onWalkthroughTypeChange={setWalkthroughType}
        onDownloadFormat={handleDownloadFormat}
        onClose={onClose}
      />

      {/* Main 3D Viewport */}
      <div className="w-full h-full relative overflow-hidden">
        {walkthroughType === "photo" ? (
          <PanoramaViewer
            ref={viewerRef}
            currentPanoramaUrl={currentPanoUrl}
            hotspots={currentNodeHotspots}
            onHotspotClick={handleHotspotClick}
            onYawChange={setCurrentYaw}
            onTransitionEnd={(newNodeId) => {
              const idx = typeof newNodeId === "number" ? newNodeId : parseInt(newNodeId, 10);
              setCurrentFrame(idx);
            }}
            onGetTextureForNode={async (nodeId) => {
              const idx = typeof nodeId === "number" ? nodeId : parseInt(nodeId, 10);
              return resolvePanoUrl(idx);
            }}
          />
        ) : (
          <SplatViewer
            splatUrl={splatUrl || `${BASE}/data/project_${tourId}/scene.splat`}
            viewMode={viewMode}
            projectId={typeof tourId === "number" ? tourId : parseInt(tourId, 10)}
            onFallback={() => setWalkthroughType("photo")}
          />
        )}
      </div>

      {/* Control Hints HUD (Walkthrough mode) */}
      {viewMode === "walkthrough" && <BottomControlHints />}

      {/* Waypoint Counter HUD */}
      <WaypointIndicator current={currentFrame + 1} total={totalFrames} />

      {/* North Compass Button */}
      {walkthroughType === "photo" && (
        <CompassButton
          yawDeg={currentYaw}
          onSnapNorth={() => viewerRef.current?.snapNorth()}
        />
      )}

      {/* Matterport Bottom Toolbar */}
      <ViewerToolbar
        variant={viewMode}
        onVariantChange={setViewMode}
        onShare={() => {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(window.location.href);
            alert("Tour link copied to clipboard!");
          }
        }}
      />

      {/* Info / Media Lightbox Modal */}
      {activeModal && (
        <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-xl flex items-center justify-center p-6 animate-in fade-in duration-200">
          <div className="bg-slate-900/90 border border-white/20 rounded-3xl p-6 max-w-lg w-full shadow-2xl relative">
            <button
              onClick={() => setActiveModal(null)}
              className="absolute top-4 right-4 text-gray-400 hover:text-white text-sm font-bold w-8 h-8 rounded-full bg-white/10 flex items-center justify-center transition-colors"
            >
              ✕
            </button>
            <h3 className="text-xl font-bold text-purple-300 mb-2">{activeModal.title}</h3>
            {activeModal.description && (
              <p className="text-sm text-gray-300 leading-relaxed mb-4">{activeModal.description}</p>
            )}
            {activeModal.mediaUrl && (
              <div className="rounded-2xl overflow-hidden border border-white/15 bg-black">
                <video src={activeModal.mediaUrl} controls autoPlay className="w-full h-auto" />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
