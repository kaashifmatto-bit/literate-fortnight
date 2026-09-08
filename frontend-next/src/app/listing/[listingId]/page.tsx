"use client";

import { use } from "react";
import PanoWalkthrough from "@/components/PanoWalkthrough";

interface PageProps {
  params: Promise<{ listingId: string }>;
}

// W1-48 — Full-listing scene assembly: a thin route so the assembled
// multi-room walkthrough (GET /api/listings/{listingId}/scene, see
// backend/services/listing_assembly_service.py) is actually reachable in
// the viewer, not just an internal prop nothing calls. Mirrors the
// existing single-room .../app/tour/[tourId]/page.tsx wrapper exactly -
// PanoWalkthrough itself does all the work once given a listingId.
//
// Scoped deliberately narrow: this only exercises the Photo Tour /
// panorama walkthrough surface (W1-48's own "DONE WHEN" bar: "the camera
// moves room-to-room; each reconstructable room is a genuine splat").
// It does NOT attempt a multi-room "dollhouse"/floorplan 3DGS view (the
// app/viewer/[id]/page.tsx SplatViewer path) - that would mean compositing
// several independent .splat files into one GPU scene at their placement
// transforms, which is real, separate, still-open work, not something to
// fake here.
export default function ListingTourPage({ params }: PageProps) {
  const { listingId: listingIdStr } = use(params);
  const listingId = parseInt(listingIdStr, 10);

  return (
    <div className="w-screen h-screen overflow-hidden bg-[#030305] relative flex flex-col select-none text-white">
      <PanoWalkthrough projectId={0} listingId={listingId} />
    </div>
  );
}
