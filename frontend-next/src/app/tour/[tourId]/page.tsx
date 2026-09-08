"use client";

import { use } from "react";
import PanoWalkthrough from "@/components/PanoWalkthrough";

interface PageProps {
  params: Promise<{ tourId: string }>;
}

export default function TourPage({ params }: PageProps) {
  const { tourId } = use(params);
  const projectId = parseInt(tourId, 10);

  return (
    <div className="w-screen h-screen overflow-hidden bg-[#030305] relative flex flex-col select-none text-white">
      <PanoWalkthrough projectId={projectId} />
    </div>
  );
}
