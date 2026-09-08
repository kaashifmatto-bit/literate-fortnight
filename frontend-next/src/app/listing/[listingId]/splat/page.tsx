"use client";

import { use } from "react";
import ListingSplatViewer from "@/components/ListingSplatViewer";

interface PageProps {
  params: Promise<{ listingId: string }>;
}

// W1-48 — the real Gate E 3DGS composite view, as its own route sibling to
// the existing .../listing/[listingId]/page.tsx (the photo-tour walkthrough
// via PanoWalkthrough). Deliberately kept as a separate route rather than a
// mode toggle inside the existing page - these are two structurally
// different viewers (PlayCanvas gsplat compositing here vs. the panorama
// sphere walkthrough there), not two view-modes of the same underlying
// scene, so a clean route split keeps each simple rather than threading a
// splat/photo-tour branch through PanoWalkthrough.tsx (which the project
// instructions explicitly asked to leave its 360°/panoramic rendering
// mechanism alone).
export default function ListingSplatPage({ params }: PageProps) {
  const { listingId: listingIdStr } = use(params);
  const listingId = parseInt(listingIdStr, 10);

  return (
    <div className="w-screen h-screen overflow-hidden bg-[#030305] relative flex flex-col select-none text-white">
      <div className="absolute top-4 right-4 z-10">
        <a
          href={`/listing/${listingId}`}
          className="text-xs px-3 py-1.5 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors"
        >
          Switch to Photo Tour
        </a>
      </div>
      <ListingSplatViewer listingId={listingId} />
    </div>
  );
}
