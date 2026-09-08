"use client";

import PanoWalkthrough from "./PanoWalkthrough";

interface PhotoWalkthroughProps {
  projectId: number;
  viewMode: "walkthrough" | "dollhouse" | "floorplan";
  file?: File | null;
  splatUrl?: string;
  onFallback?: () => void;
}

export default function PhotoWalkthrough({ projectId, onFallback }: PhotoWalkthroughProps) {
  return <PanoWalkthrough projectId={projectId || 1} onFallback={onFallback} />;
}
