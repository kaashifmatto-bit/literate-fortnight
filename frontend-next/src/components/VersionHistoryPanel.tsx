"use client";

/**
 * ArticulAIT — 3D Asset Version History Panel
 *
 * Row 89 of the SOW audit: "3D asset management — stored, versioned,
 * retrievable" — previously PARTIAL because storage/format handling existed
 * but nothing tracked or exposed prior versions of a project's uploaded 3D
 * asset. This panel is the "versioned, retrievable" half: it lists every
 * archived version of a project's scene file (backend/routes/upload.py's
 * _record_asset_version writes one on every upload) and lets the user
 * restore an older one or upload a brand-new version without losing what's
 * there now.
 */

import { useEffect, useState } from "react";
import { listAssetVersions, restoreAssetVersion, uploadNewAssetVersion } from "@/lib/api";
import type { AssetVersion } from "@/lib/api";

interface VersionHistoryPanelProps {
  projectId: number;
  onClose: () => void;
  /** Called after a successful restore or new-version upload so the parent
   * can reload the viewer's splatUrl (the live scene file on disk changed
   * out from under whatever URL is currently loaded). */
  onChanged: () => void;
}

function formatSize(bytes: number | null): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function VersionHistoryPanel({ projectId, onClose, onChanged }: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<AssetVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Informational, not an error: e.g. "restored, but this format can't be
  // shown here." Kept separate from `error` so it doesn't render red.
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = () => {
    setError(null);
    listAssetVersions(projectId)
      .then((res) => setVersions(res.versions))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const handleRestore = async (versionId: number, versionNumber: number) => {
    setBusyId(versionId);
    setError(null);
    setNotice(null);
    try {
      const res = await restoreAssetVersion(projectId, versionId);
      load();
      // The parent page reads the versions list itself to decide which
      // viewer (SplatViewer for gsplat, MeshAssetLoader for mesh) to mount,
      // so onChanged() is enough either way now - no special-casing needed.
      onChanged();
      setNotice(
        res.viewer === "mesh"
          ? `v${versionNumber} restored — it's a mesh (.glb/.obj), so it opens in the mesh viewer instead of the Gaussian Splat one.`
          : null
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleUploadNewVersion = async (file: File) => {
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      await uploadNewAssetVersion(projectId, file);
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="absolute top-20 right-4 z-40 w-80 max-h-[70vh] overflow-y-auto rounded-2xl border border-white/15 bg-black/90 backdrop-blur-2xl shadow-[0_12px_40px_rgba(0,0,0,0.9)] p-4 text-white">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-black uppercase tracking-wide flex items-center gap-1.5">
          📜 Version History
        </h3>
        <button
          onClick={onClose}
          className="text-white/50 hover:text-white text-xs w-6 h-6 flex items-center justify-center rounded-lg hover:bg-white/10 transition-colors"
        >
          ✕
        </button>
      </div>

      <label className="block mb-3">
        <span className="text-[11px] text-white/50 mb-1.5 block">Upload a new version of this asset</span>
        <span
          className={`block text-center text-xs font-bold rounded-xl py-2 border transition-colors cursor-pointer ${
            uploading
              ? "bg-black/60 text-white/40 border-white/10 cursor-wait"
              : "bg-indigo-600 hover:bg-indigo-500 text-white border-indigo-400/40"
          }`}
        >
          {uploading ? "⏳ Uploading…" : "📁 Choose file (.splat/.ply/.lcc/.glb/.obj)"}
          <input
            type="file"
            accept=".splat,.ply,.lcc,.glb,.obj"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUploadNewVersion(f);
              e.target.value = "";
            }}
            className="hidden"
          />
        </span>
        <span className="text-[10px] text-white/35 mt-1 block">
          .splat/.ply/.lcc open in the Gaussian Splat viewer · .glb/.obj open in the mesh viewer.
        </span>
      </label>

      {error && (
        <div className="mb-3 rounded-xl bg-red-950/60 border border-red-500/30 px-3 py-2 text-[11px] text-red-200 leading-relaxed">
          {error}
        </div>
      )}

      {notice && (
        <div className="mb-3 rounded-xl bg-amber-950/50 border border-amber-500/30 px-3 py-2 text-[11px] text-amber-200 leading-relaxed">
          {notice}
        </div>
      )}

      {versions === null ? (
        <div className="text-xs text-white/40 py-4 text-center">Loading versions…</div>
      ) : versions.length === 0 ? (
        <div className="text-xs text-white/40 py-4 text-center">No versions recorded yet.</div>
      ) : (
        <ul className="space-y-2">
          {versions.map((v) => (
            <li
              key={v.id}
              className={`rounded-xl border px-3 py-2 ${
                v.is_current ? "border-emerald-500/40 bg-emerald-950/25" : "border-white/10 bg-white/[0.04]"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold">
                  v{v.version_number}
                  {v.is_current && <span className="ml-1.5 text-emerald-400 font-semibold">● current</span>}
                </span>
                <span className="text-[9px] uppercase tracking-wider text-white/40 bg-white/5 px-1.5 py-0.5 rounded">
                  {v.format}
                </span>
              </div>
              <div className="text-[10px] text-white/50 truncate mt-1" title={v.original_filename || undefined}>
                {v.original_filename || "unnamed file"}
              </div>
              <div className="text-[10px] text-white/35 mt-0.5">
                {formatSize(v.size_bytes)}
                {v.created_at ? ` · ${new Date(v.created_at).toLocaleString()}` : ""}
              </div>
              <div className="text-[10px] text-white/35 mt-1">
                {v.viewer === "mesh" ? "🧊 Opens in mesh viewer" : "🌀 Opens in Gaussian Splat viewer"}
              </div>
              {!v.is_current && (
                <button
                  onClick={() => handleRestore(v.id, v.version_number)}
                  disabled={busyId !== null}
                  className="mt-2 w-full text-[11px] font-bold rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-wait text-white py-1.5 transition-colors"
                >
                  {busyId === v.id ? "Restoring…" : "⤺ Restore this version"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
