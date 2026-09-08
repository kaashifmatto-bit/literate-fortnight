"use client";

// W1-48 — Full-listing scene assembly: the frontend testing/setup surface.
// Before this component existed, creating a listing and adding rooms only
// worked via direct API calls (POST /api/listings, POST .../rooms) - there
// was no way to exercise the feature from the browser at all. This panel
// covers the whole loop: pick 2+ completed projects -> assemble them into a
// listing -> open the merged walkthrough -> check the §3.3 room pass rate
// -> nudge room placement if two rooms don't line up -> delete when done
// testing.
import { useEffect, useState, useCallback } from "react";
import type { Project, Listing, ListingScene } from "@/lib/types";
import {
  listListings,
  createListing,
  addListingRoom,
  updateListingRoomPlacement,
  removeListingRoom,
  deleteListing,
  getListingScene,
  autoGenerateListingObjects,
} from "@/lib/api";

interface ListingsPanelProps {
  projects: Project[];
}

// Simple default spacing so newly-added rooms don't start stacked on top of
// each other in the shared listing frame - real captures are usually a few
// meters across, and the canonical frame normalizes each room to roughly a
// radius-2.5 sphere (see Gate H1), so 8 units of separation keeps rooms
// clear of one another without requiring the user to set placement by hand
// before ever seeing the result. Purely a starting point - PATCH afterward
// to actually line up doorways.
const DEFAULT_ROOM_SPACING = 8;

export default function ListingsPanel({ projects }: ListingsPanelProps) {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loadingListings, setLoadingListings] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedOrder, setSelectedOrder] = useState<number[]>([]);
  const [newListingName, setNewListingName] = useState("");
  const [assembling, setAssembling] = useState(false);

  // Per-listing UI state, keyed by listing id.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [sceneById, setSceneById] = useState<Record<number, ListingScene | "loading" | "error">>({});
  const [roomEdits, setRoomEdits] = useState<Record<string, { offset_x: string; offset_z: string; yaw_deg: string; scale: string }>>({});
  const [savingRoomKey, setSavingRoomKey] = useState<string | null>(null);
  const [autoDetectingId, setAutoDetectingId] = useState<number | null>(null);

  const completedProjects = projects.filter((p) => p.status === "completed");

  const refreshListings = useCallback(async () => {
    try {
      const res = await listListings();
      setListings(res.listings || []);
    } catch (err) {
      console.error("Failed to load listings:", err);
      setError("Failed to load listings");
    } finally {
      setLoadingListings(false);
    }
  }, []);

  useEffect(() => {
    refreshListings();
  }, [refreshListings]);

  const toggleSelected = (id: number) => {
    setSelectedOrder((prev) => {
      if (prev.includes(id)) {
        return prev.filter((item) => item !== id);
      } else {
        return [...prev, id];
      }
    });
  };

  const handleAssemble = async () => {
    if (selectedOrder.length < 1 || !newListingName.trim()) return;
    setAssembling(true);
    setError(null);
    try {
      const listing = await createListing(newListingName.trim());
      const selected = selectedOrder
        .map((id) => completedProjects.find((p) => p.id === id))
        .filter((p): p is Project => p !== undefined);

      let i = 0;
      for (const project of selected) {
        await addListingRoom(listing.id, {
          project_id: project.id,
          room_label: project.name.replace(/\.(ply|lcc|splat|obj|glb|gltf)$/i, ""),
          room_order: i,
          offset_x: i * DEFAULT_ROOM_SPACING,
          offset_y: 0,
          offset_z: 0,
          yaw_deg: 0,
          scale: 1,
        });
        i += 1;
      }
      setSelectedOrder([]);
      setNewListingName("");
      await refreshListings();
      window.location.href = `/listing/${listing.id}`;
    } catch (err) {
      console.error("Failed to assemble listing:", err);
      setError(err instanceof Error ? err.message : "Failed to assemble listing");
      await refreshListings();
    } finally {
      setAssembling(false);
    }
  };

  const handleDeleteListing = async (id: number) => {
    if (!confirm("Delete this listing? Its member projects are untouched - only the listing/room links are removed.")) return;
    try {
      await deleteListing(id);
      await refreshListings();
    } catch (err) {
      console.error("Failed to delete listing:", err);
      setError("Failed to delete listing");
    }
  };

  const handleRemoveRoom = async (listingId: number, projectId: number) => {
    try {
      await removeListingRoom(listingId, projectId);
      await refreshListings();
      setSceneById((prev) => {
        const next = { ...prev };
        delete next[listingId];
        return next;
      });
    } catch (err) {
      console.error("Failed to remove room:", err);
      setError("Failed to remove room from listing");
    }
  };

  const handleCheckPassRate = async (listingId: number) => {
    setSceneById((prev) => ({ ...prev, [listingId]: "loading" }));
    try {
      const scene = await getListingScene(listingId);
      setSceneById((prev) => ({ ...prev, [listingId]: scene }));
    } catch (err) {
      console.error("Failed to fetch listing scene:", err);
      setSceneById((prev) => ({ ...prev, [listingId]: "error" }));
    }
  };

  const handleAutoDetect = async (listingId: number) => {
    setAutoDetectingId(listingId);
    setSceneById((prev) => ({ ...prev, [listingId]: "loading" }));
    try {
      // Runs YOLO detection across every room in this listing (project-by-
      // project, same detector already used for a single walkthrough) and
      // returns the freshly assembled scene with generated/message on top -
      // reuse the same pass-rate card below rather than a second UI.
      const scene = await autoGenerateListingObjects(listingId);
      setSceneById((prev) => ({ ...prev, [listingId]: scene }));
    } catch (err) {
      console.error("Failed to auto-detect objects for listing:", err);
      setSceneById((prev) => ({ ...prev, [listingId]: "error" }));
      setError(err instanceof Error ? err.message : "Failed to auto-detect objects across this listing's rooms");
    } finally {
      setAutoDetectingId(null);
    }
  };

  const roomKey = (listingId: number, projectId: number) => `${listingId}:${projectId}`;

  const startEditingRoom = (listingId: number, room: Listing["rooms"][number]) => {
    setRoomEdits((prev) => ({
      ...prev,
      [roomKey(listingId, room.project_id)]: {
        offset_x: String(room.offset_x),
        offset_z: String(room.offset_z),
        yaw_deg: String(room.yaw_deg),
        scale: String(room.scale ?? 1),
      },
    }));
  };

  const handleSaveRoomPlacement = async (listingId: number, projectId: number) => {
    const key = roomKey(listingId, projectId);
    const edit = roomEdits[key];
    if (!edit) return;
    setSavingRoomKey(key);
    try {
      await updateListingRoomPlacement(listingId, projectId, {
        offset_x: parseFloat(edit.offset_x) || 0,
        offset_z: parseFloat(edit.offset_z) || 0,
        yaw_deg: parseFloat(edit.yaw_deg) || 0,
        // A room scaled to (near) zero would vanish and be hard to recover
        // from in this UI (Adjust would just show 0 again) - floor it well
        // above zero rather than silently accepting a value that breaks
        // the room's own geometry.
        scale: Math.max(0.01, parseFloat(edit.scale) || 1),
      });
      await refreshListings();
      setRoomEdits((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      // Placement changed - any previously-fetched pass-rate/room summary
      // for this listing is still valid (placement doesn't affect pass/fail),
      // but the 3D viewer will need a fresh scene fetch, which it always
      // does on its own load, so nothing else to invalidate here.
    } catch (err) {
      console.error("Failed to save room placement:", err);
      setError("Failed to save room placement");
    } finally {
      setSavingRoomKey(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-black tracking-tight">Multi-Room Listings</h2>
        <span className="text-xs text-[var(--text-secondary)]">W1-48 — assemble reconstructed rooms into one navigable scene</span>
      </div>

      {error && (
        <div className="bg-[rgba(239,68,68,0.1)] border border-[var(--error)] text-[var(--error)] p-3 rounded-xl flex justify-between items-center text-sm">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-xs font-bold hover:underline">Dismiss</button>
        </div>
      )}

      {/* Builder */}
      <div className="glass p-6 space-y-4">
        <h3 className="font-bold text-base">Assemble a new listing</h3>
        {completedProjects.length < 2 ? (
          <p className="text-sm text-[var(--text-secondary)]">
            You need at least 2 completed walkthroughs to assemble a listing. Upload and reconstruct more rooms first.
          </p>
        ) : (
          <>
            <p className="text-sm text-[var(--text-secondary)]">
              Pick 2 or more completed walkthroughs to treat as rooms of the same listing. Rooms are placed with a simple
              default spacing to start — adjust each room&apos;s offset/yaw below once you can see how they line up.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-64 overflow-y-auto pr-1">
              {completedProjects.map((p) => {
                const orderIndex = selectedOrder.indexOf(p.id);
                const isSelected = orderIndex !== -1;
                return (
                  <label
                    key={p.id}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-sm transition-colors ${
                      isSelected
                        ? "bg-indigo-600/20 border-indigo-500/50 text-white"
                        : "border-[var(--border-glass)] hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelected(p.id)}
                      className="accent-indigo-500"
                    />
                    <span className="truncate flex-1" title={p.name}>
                      #{p.id} {p.name.replace(/\.(ply|lcc|splat|obj|glb|gltf)$/i, "")}
                    </span>
                    {isSelected && (
                      <span className="bg-indigo-600 text-white text-[10px] font-extrabold px-1.5 py-0.5 rounded-full">
                        #{orderIndex + 1}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                value={newListingName}
                onChange={(e) => setNewListingName(e.target.value)}
                placeholder="Listing name (e.g. '123 Main St')"
                className="flex-1 py-2.5 px-3 bg-zinc-900 border border-[var(--border-glass)] text-white text-sm rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                onClick={handleAssemble}
                disabled={selectedOrder.length < 1 || !newListingName.trim() || assembling}
                className="btn-primary px-6 py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {assembling ? "Assembling…" : `Assemble${selectedOrder.length >= 1 ? ` (${selectedOrder.length} room${selectedOrder.length === 1 ? "" : "s"})` : ""}`}
              </button>
            </div>
            {(selectedOrder.length < 1 || !newListingName.trim()) && (
              <p className="text-xs text-amber-400/90">
                {selectedOrder.length < 1 && !newListingName.trim()
                  ? "Select at least 1 walkthrough above and enter a listing name to enable Assemble."
                  : selectedOrder.length < 1
                    ? "Select at least 1 walkthrough above to enable Assemble."
                    : "Enter a listing name to enable Assemble."}
              </p>
            )}
            {selectedOrder.length === 1 && (
              <p className="text-xs text-[var(--text-secondary)]">
                Only 1 room selected — that&apos;ll assemble and open fine, but W1-48 is specifically about multi-room
                scenes, so pick 2+ if you want to actually test room-to-room continuity. You can add more rooms to this
                listing afterward via &quot;Edit Rooms&quot;.
              </p>
            )}
          </>
        )}
      </div>

      {/* Existing listings */}
      {loadingListings ? (
        <div className="glass p-8 text-center text-[var(--text-secondary)] text-sm">Loading listings…</div>
      ) : listings.length === 0 ? (
        <div className="glass p-8 text-center text-[var(--text-secondary)] text-sm">
          No listings yet — assemble one above from your completed walkthroughs.
        </div>
      ) : (
        <div className="space-y-4">
          {listings.map((listing) => {
            const scene = sceneById[listing.id];
            return (
              <div key={listing.id} className="glass p-6 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-bold text-lg">{listing.name}</h3>
                    <p className="text-xs text-[var(--text-secondary)]">
                      {listing.rooms.length} room{listing.rooms.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-wrap justify-end">
                    <a
                      href={`/listing/${listing.id}`}
                      className="btn-primary px-4 py-2 text-xs whitespace-nowrap"
                    >
                      Open Walkthrough
                    </a>
                    <a
                      href={`/listing/${listing.id}/splat`}
                      title="The real W1-48 deliverable: every room's own trained 3D Gaussian Splat composited into one scene at its placement transform, instead of the photo-panorama walkthrough"
                      className="px-4 py-2 border border-indigo-500/50 text-indigo-300 hover:bg-indigo-500/10 rounded-xl text-xs font-medium transition-colors whitespace-nowrap"
                    >
                      Open 3D Splat View
                    </a>
                    <button
                      onClick={() => handleCheckPassRate(listing.id)}
                      className="px-4 py-2 border border-[var(--border-glass)] hover:bg-[var(--bg-secondary)] rounded-xl text-xs font-medium transition-colors whitespace-nowrap"
                    >
                      Check Pass Rate
                    </button>
                    <button
                      onClick={() => handleAutoDetect(listing.id)}
                      disabled={autoDetectingId === listing.id}
                      title="Runs object detection across every room in this listing and places hotspots for each"
                      className="px-4 py-2 border border-[var(--border-glass)] hover:bg-[var(--bg-secondary)] rounded-xl text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {autoDetectingId === listing.id ? "Detecting…" : "Auto-Detect Objects (All Rooms)"}
                    </button>
                    <button
                      onClick={() => setExpandedId(expandedId === listing.id ? null : listing.id)}
                      className="px-4 py-2 border border-[var(--border-glass)] hover:bg-[var(--bg-secondary)] rounded-xl text-xs font-medium transition-colors whitespace-nowrap"
                    >
                      {expandedId === listing.id ? "Hide Rooms" : "Edit Rooms"}
                    </button>
                    <button
                      onClick={() => handleDeleteListing(listing.id)}
                      className="px-4 py-2 border border-[var(--border-glass)] hover:border-[var(--error)] hover:bg-[rgba(239,68,68,0.1)] rounded-xl text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--error)] transition-colors whitespace-nowrap"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {scene === "loading" && (
                  <p className="text-xs text-[var(--text-secondary)]">
                    {autoDetectingId === listing.id ? "Detecting objects across all rooms…" : "Checking pass rate…"}
                  </p>
                )}
                {scene === "error" && (
                  <p className="text-xs text-[var(--error)]">Failed to fetch this listing&apos;s assembled scene.</p>
                )}
                {scene && scene !== "loading" && scene !== "error" && (
                  <div className={`p-3 rounded-lg border text-sm space-y-2 ${
                    scene.meets_pass_target
                      ? "border-emerald-500/40 bg-emerald-500/10"
                      : "border-amber-500/40 bg-amber-500/10"
                  }`}>
                    {scene.message && (
                      <p className="text-xs text-indigo-300">
                        {scene.message}
                        {typeof scene.raw_detections_total === "number" && (
                          <span className="text-[var(--text-secondary)]"> ({scene.raw_detections_total} raw detection(s) total)</span>
                        )}
                      </p>
                    )}
                    <p className="font-semibold">
                      {scene.rooms_passed} / {scene.rooms_reconstructable_total} reconstructable room
                      {scene.rooms_reconstructable_total === 1 ? "" : "s"} are genuine splats
                      {scene.rooms_excluded_insufficient_input > 0 &&
                        ` (${scene.rooms_excluded_insufficient_input} excluded — insufficient photo input, not held against this listing)`}
                      {" — "}
                      {scene.is_full_3dgs_pass
                        ? "full 3DGS pass for this listing"
                        : "not a full 3DGS pass"}
                    </p>
                    {/* Per §9.1: the SOW's >=75% figure is a portfolio-wide target
                        across listings, not a per-listing partial-credit bar - a
                        single listing only passes when ALL its reconstructable
                        rooms are genuine splats. Shown here so it isn't misread
                        as "75% of this listing's rooms is good enough". */}
                    {!scene.is_full_3dgs_pass && scene.rooms_reconstructable_total > 0 && (
                      <p className="text-[10px] text-[var(--text-secondary)]">
                        The ≥75% target (§3.3) is measured across listings, not within one — this single listing needs
                        all {scene.rooms_reconstructable_total} reconstructable room{scene.rooms_reconstructable_total === 1 ? "" : "s"} to pass.
                      </p>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs text-[var(--text-secondary)]">
                      {scene.rooms.map((r) => (
                        <div key={r.listing_room_id} className="flex justify-between gap-2">
                          <span>{r.room_label} (#{r.project_id})</span>
                          <span className={r.passed ? "text-emerald-400" : r.reconstructable ? "text-amber-400" : "text-[var(--text-secondary)]"}>
                            {r.passed ? "✓ splat" : r.reconstructable ? `✗ ${r.reason_code}` : `– ${r.reason_code} (insufficient input)`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {expandedId === listing.id && (
                  <div className="space-y-2 pt-2 border-t border-white/10">
                    {listing.rooms.map((room) => {
                      const key = roomKey(listing.id, room.project_id);
                      const edit = roomEdits[key];
                      return (
                        <div key={room.id} className="flex flex-wrap items-center gap-2 text-xs bg-black/20 p-3 rounded-lg">
                          <span className="font-semibold w-32 truncate" title={room.room_label}>{room.room_label}</span>
                          <span className="text-[var(--text-secondary)]">#{room.project_id}</span>
                          {edit ? (
                            <>
                              <label className="flex items-center gap-1">
                                X
                                <input
                                  type="number"
                                  value={edit.offset_x}
                                  onChange={(e) => setRoomEdits((p) => ({ ...p, [key]: { ...edit, offset_x: e.target.value } }))}
                                  className="w-16 bg-zinc-900 border border-[var(--border-glass)] rounded px-1.5 py-1"
                                />
                              </label>
                              <label className="flex items-center gap-1">
                                Z
                                <input
                                  type="number"
                                  value={edit.offset_z}
                                  onChange={(e) => setRoomEdits((p) => ({ ...p, [key]: { ...edit, offset_z: e.target.value } }))}
                                  className="w-16 bg-zinc-900 border border-[var(--border-glass)] rounded px-1.5 py-1"
                                />
                              </label>
                              <label className="flex items-center gap-1">
                                Yaw°
                                <input
                                  type="number"
                                  value={edit.yaw_deg}
                                  onChange={(e) => setRoomEdits((p) => ({ ...p, [key]: { ...edit, yaw_deg: e.target.value } }))}
                                  className="w-16 bg-zinc-900 border border-[var(--border-glass)] rounded px-1.5 py-1"
                                />
                              </label>
                              <label className="flex items-center gap-1" title="Uniform scale - each room reconstructs at its own independent scale, so two rooms placed side by side can look mismatched in size until tuned here">
                                Scale
                                <input
                                  type="number"
                                  step="0.05"
                                  min="0.01"
                                  value={edit.scale}
                                  onChange={(e) => setRoomEdits((p) => ({ ...p, [key]: { ...edit, scale: e.target.value } }))}
                                  className="w-16 bg-zinc-900 border border-[var(--border-glass)] rounded px-1.5 py-1"
                                />
                              </label>
                              <button
                                onClick={() => handleSaveRoomPlacement(listing.id, room.project_id)}
                                disabled={savingRoomKey === key}
                                className="btn-primary px-3 py-1"
                              >
                                {savingRoomKey === key ? "Saving…" : "Save"}
                              </button>
                              <button
                                onClick={() => setRoomEdits((p) => { const n = { ...p }; delete n[key]; return n; })}
                                className="px-3 py-1 border border-[var(--border-glass)] rounded"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <span className="text-[var(--text-secondary)]">
                                offset ({room.offset_x}, {room.offset_z}) yaw {room.yaw_deg}° scale {room.scale ?? 1}×
                              </span>
                              <button
                                onClick={() => startEditingRoom(listing.id, room)}
                                className="px-3 py-1 border border-[var(--border-glass)] rounded hover:bg-[var(--bg-secondary)]"
                              >
                                Adjust
                              </button>
                              <button
                                onClick={() => handleRemoveRoom(listing.id, room.project_id)}
                                className="px-3 py-1 border border-[var(--border-glass)] rounded hover:border-[var(--error)] hover:text-[var(--error)]"
                              >
                                Remove
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
