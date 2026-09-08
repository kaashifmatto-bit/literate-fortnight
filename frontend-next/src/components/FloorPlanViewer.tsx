"use client";

/**
 * ArticulAIT — Floor Plan Viewer
 *
 * Renders the vectorized 2D floor plan (wall segments + room polygons)
 * produced by backend/services/floorplan_service.py from a project's
 * reconstructed point cloud. Not the earlier "floorplan" view mode in
 * SplatViewer.tsx (that's just a top-down camera angle over the live 3D
 * splat) — this is a real derived 2D diagram, fetched/generated via
 * /api/projects/{id}/floorplan[/generate].
 *
 * IMPORTANT — read before assuming the numbers mean feet/meters: this
 * pipeline has no real-world scale calibration anywhere (SfM scale is
 * arbitrary, and pose_router.normalize_poses_canonical rescales every
 * project to a fixed canonical radius). Wall lengths and room areas shown
 * here are in that same arbitrary "canonical" unit — proportions are
 * correct, absolute numbers are not verified real-world measurements.
 * The backend's own `scale_note` field says this too; it's surfaced in
 * the UI rather than silently dropped.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { generateFloorplan, getFloorplan } from "@/lib/api";
import type { FloorPlanResult, FloorPlanSuccess } from "@/lib/types";

interface FloorPlanViewerProps {
  projectId: number;
}

const ROOM_FILL_COLORS = [
  "rgba(99, 102, 241, 0.18)",
  "rgba(16, 185, 129, 0.18)",
  "rgba(244, 114, 182, 0.18)",
  "rgba(251, 191, 36, 0.18)",
  "rgba(56, 189, 248, 0.18)",
];

export default function FloorPlanViewer({ projectId }: FloorPlanViewerProps) {
  const [floorplan, setFloorplan] = useState<FloorPlanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const draggingRef = useRef<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const fitToBounds = useCallback((fp: FloorPlanSuccess) => {
    const container = containerRef.current;
    if (!container) return;
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;
    const spanU = fp.bounds.max_u - fp.bounds.min_u || 1;
    const spanV = fp.bounds.max_v - fp.bounds.min_v || 1;
    const fitScale = Math.min(w / spanU, h / spanV) * 0.85;
    setScale(fitScale);
    setPan({
      x: w / 2 - ((fp.bounds.min_u + fp.bounds.max_u) / 2) * fitScale,
      y: h / 2 - ((fp.bounds.min_v + fp.bounds.max_v) / 2) * fitScale,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getFloorplan(projectId)
      .then((fp) => {
        if (cancelled) return;
        setFloorplan(fp);
        if (fp.status === "success") fitToBounds(fp);
      })
      .catch((err) => {
        if (cancelled) return;
        // A 404 (no floor plan generated yet) is expected, not an error —
        // apiFetch throws for any non-ok response, so distinguish it by
        // message rather than treating every failure as fatal.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes("no floor plan")) {
          setFloorplan(null);
        } else {
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, fitToBounds]);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const fp = await generateFloorplan(projectId);
      setFloorplan(fp);
      if (fp.status === "success") fitToBounds(fp);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((s) => Math.max(2, Math.min(2000, s * factor)));
  };
  const handleMouseDown = (e: React.MouseEvent) => {
    draggingRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    setPan({ x: e.clientX - draggingRef.current.x, y: e.clientY - draggingRef.current.y });
  };
  const handleMouseUp = () => {
    draggingRef.current = null;
  };

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#030305] text-white/50 text-sm gap-3">
        <span className="animate-spin inline-block w-5 h-5 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full" />
        Loading floor plan…
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-[#030305] text-red-300 text-sm gap-3 p-6 text-center">
        <p>Failed to load floor plan: {error}</p>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="px-4 py-2 text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl disabled:opacity-50"
        >
          {generating ? "Generating…" : "Retry"}
        </button>
      </div>
    );
  }

  if (!floorplan || floorplan.status === "insufficient_data") {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-[#030305] text-white/70 text-sm gap-4 p-6 text-center">
        {floorplan?.status === "insufficient_data" ? (
          <>
            <p className="text-amber-300 font-semibold">Couldn&apos;t generate a floor plan from this project.</p>
            <p className="text-white/50 text-xs max-w-md">
              Reason: <code className="text-white/70">{floorplan.reason}</code>
              {floorplan.detail ? ` — ${floorplan.detail}` : ""}
            </p>
          </>
        ) : (
          <p>No floor plan has been generated for this project yet.</p>
        )}
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm transition-colors shadow-lg shadow-indigo-500/20 disabled:opacity-50"
        >
          {generating ? "Generating…" : "Generate Floor Plan"}
        </button>
      </div>
    );
  }

  const fp = floorplan;

  return (
    <div ref={containerRef} className="relative w-full h-full bg-[#0a0a0f] overflow-hidden">
      <svg
        className="w-full h-full cursor-grab active:cursor-grabbing"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${scale})`}>
          {fp.rooms.map((room) => (
            <g key={room.id}>
              <polygon
                points={room.polygon.map((p) => `${p.u},${p.v}`).join(" ")}
                fill={ROOM_FILL_COLORS[(room.id - 1) % ROOM_FILL_COLORS.length]}
                stroke="rgba(129, 140, 248, 0.4)"
                strokeWidth={1 / scale}
              />
              <text
                x={room.centroid.u}
                y={room.centroid.v}
                fontSize={12 / scale}
                fill="rgba(255,255,255,0.85)"
                textAnchor="middle"
                style={{ userSelect: "none" }}
              >
                Room {room.id} · {room.area.toFixed(2)} u²
              </text>
            </g>
          ))}
          {fp.wall_segments.map((seg, i) => (
            <line
              key={i}
              x1={seg.start.u}
              y1={seg.start.v}
              x2={seg.end.u}
              y2={seg.end.v}
              stroke="#e5e7eb"
              strokeWidth={Math.max(seg.thickness, 1.5 / scale)}
              strokeLinecap="round"
            />
          ))}
        </g>
      </svg>

      <div className="absolute top-4 left-4 bg-black/70 backdrop-blur-md border border-white/10 rounded-xl px-3 py-2 text-[11px] text-white/70 max-w-xs">
        <p className="font-semibold text-white/90 mb-1">
          {fp.wall_segments.length} walls · {fp.rooms.length} room{fp.rooms.length === 1 ? "" : "s"}
        </p>
        {fp.scale_note && <p className="text-amber-300/90">{fp.scale_note}</p>}
      </div>

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/60 text-[11px] font-semibold bg-black/55 px-3 py-1.5 rounded-lg pointer-events-none whitespace-nowrap">
        Drag to Pan &nbsp;|&nbsp; Scroll to Zoom
      </div>

      <button
        onClick={handleGenerate}
        disabled={generating}
        className="absolute top-4 right-4 px-3 py-1.5 text-[11px] font-bold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-50"
      >
        {generating ? "Regenerating…" : "Regenerate"}
      </button>
    </div>
  );
}
