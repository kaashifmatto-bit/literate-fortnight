"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getHealth } from "@/lib/api";
import type { HealthResponse } from "@/lib/types";

export default function Navbar() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
    getHealth()
      .then(setHealth)
      .catch((err) => console.error("Error fetching system health:", err));
  }, []);

  return (
    <header className="border-b border-[var(--border-glass)] bg-[rgba(10,10,15,0.8)] backdrop-blur-md sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-[#6366f1] to-[#8b5cf6] flex items-center justify-center font-black text-white text-lg shadow-md shadow-indigo-500/20">
              A
            </div>
            <span className="font-extrabold text-xl tracking-tight bg-gradient-to-r from-white via-white to-[var(--text-secondary)] bg-clip-text text-transparent">
              Articul<span className="text-[var(--accent-primary)]">AIT</span>
            </span>
          </Link>
          <nav className="hidden md:flex gap-6 text-sm">
            <Link
              href="/"
              className="text-white hover:text-[var(--accent-primary)] transition-colors font-medium"
            >
              Studio
            </Link>
            <Link
              href="/mesh-check"
              className="text-[var(--text-secondary)] hover:text-white transition-colors font-medium flex items-center gap-1.5"
            >
              <span>📦</span> Mesh Inspector
            </Link>
          </nav>
        </div>

        {isMounted && health && (
          <div suppressHydrationWarning className="flex items-center gap-4 text-xs bg-[var(--bg-secondary)] border border-[var(--border-glass)] py-1.5 px-3 rounded-full">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[var(--success)] animate-pulse" />
              <span className="text-[var(--text-secondary)]">API:</span>
              <span className="font-medium">v{health.version}</span>
            </div>
            {health.gpu.available && (
              <div className="hidden sm:flex items-center gap-1.5 border-l border-[var(--border-glass)] pl-3">
                <span className="text-[var(--text-secondary)]">GPU:</span>
                <span className="font-medium text-white truncate max-w-[120px]" title={health.gpu.name}>
                  {health.gpu.name}
                </span>
                <span className="text-[var(--text-secondary)]">({health.gpu.vram_gb} GB)</span>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
