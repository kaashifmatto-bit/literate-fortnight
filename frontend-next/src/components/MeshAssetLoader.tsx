"use client";

/**
 * ArticulAIT — Mesh Asset Loader
 *
 * Bridges a server-hosted .glb/.obj URL into MeshCheckViewer, which only
 * accepts an in-memory File (it calls URL.createObjectURL(file) for
 * glb/gltf and FileReader.readAsText(file) for obj - both need a real
 * File/Blob, not a URL string). MeshCheckViewer itself was already in the
 * codebase but wasn't wired into any page - nothing rendered .glb/.obj
 * uploads anywhere. This component is what plugs it in for the 3D asset
 * version history: when a project's current asset version is a mesh format
 * rather than a Gaussian Splat, the viewer pages render this instead of
 * SplatViewer.
 */

import { useEffect, useState } from "react";
import MeshCheckViewer, { type MeshStats } from "./MeshCheckViewer";

interface MeshAssetLoaderProps {
  url: string;
  filename?: string;
  onStatsLoaded?: (stats: MeshStats) => void;
  onError?: (errorMessage: string) => void;
}

export default function MeshAssetLoader({ url, filename, onStatsLoaded, onError }: MeshAssetLoaderProps) {
  const [file, setFile] = useState<File | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setFetchError(null);

    fetch(url, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch mesh file (HTTP ${res.status})`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const name = filename || url.split("/").pop()?.split("?")[0] || "scene_mesh.glb";
        setFile(new File([blob], name, { type: blob.type }));
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setFetchError(msg);
        onError?.(msg);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (fetchError) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#030305] text-red-300 text-sm p-6 text-center">
        Failed to load mesh file: {fetchError}
      </div>
    );
  }

  if (!file) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#030305] text-white/50 text-sm gap-3">
        <span className="animate-spin inline-block w-5 h-5 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full" />
        Loading mesh file…
      </div>
    );
  }

  return <MeshCheckViewer file={file} onStatsLoaded={onStatsLoaded} onError={onError} />;
}
