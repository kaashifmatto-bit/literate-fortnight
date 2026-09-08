"use client";

import type { Project } from "@/lib/types";

interface ProjectCardProps {
  project: Project;
  onDelete: (id: number) => void;
  onSelect: (id: number) => void;
}

export default function ProjectCard({ project, onDelete, onSelect }: ProjectCardProps) {
  const getStatusColor = (status: Project["status"]) => {
    switch (status) {
      case "processing":
        return "badge-processing";
      case "completed":
        return "badge-completed";
      case "failed":
        return "badge-failed";
      case "uploaded":
      case "uploading":
      default:
        return "badge-uploaded";
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "N/A";
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="glass p-6 hover:border-[rgba(255,255,255,0.15)] transition-all duration-300 flex flex-col justify-between">
      <div>
        <div className="flex justify-between items-start gap-4 mb-4">
          <h3 className="font-bold text-lg truncate" title={project.name}>
            {project.name.replace(/\.(ply|lcc|splat|obj|glb|gltf)$/i, "")}
          </h3>
          <div className="flex flex-col items-end gap-1">
            <span className={`badge ${getStatusColor(project.status)}`}>
              {project.status}
            </span>
            {project.quality_badge && (
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold whitespace-nowrap ${
                project.quality_color === 'emerald' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
                project.quality_color === 'amber' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' :
                'bg-blue-500/20 text-blue-400 border border-blue-500/30'
              }`}>
                {project.quality_badge}
              </span>
            )}
          </div>
        </div>

        <div className="space-y-2 text-sm text-[var(--text-secondary)] mb-6">
          <div className="flex justify-between">
            <span>Photos:</span>
            <span className="text-white font-medium">{project.image_count}</span>
          </div>
          {project.point_count ? (
            <div className="flex justify-between">
              <span>3D Density:</span>
              <span className="text-white font-medium">
                {project.point_count >= 1000000 
                  ? `${(project.point_count / 1000000).toFixed(2)}M splats`
                  : `${(project.point_count / 1000).toFixed(0)}K splats`}
              </span>
            </div>
          ) : null}
          <div className="flex justify-between">
            <span>Created:</span>
            <span className="text-white font-medium">{formatDate(project.created_at)}</span>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => onSelect(project.id)}
          className="btn-primary flex-1 py-2 text-sm"
        >
          {project.status === "completed" ? "View Walkthrough" : "Track Progress"}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Are you sure you want to delete ${project.name}?`)) {
              onDelete(project.id);
            }
          }}
          className="p-2 border border-[var(--border-glass)] hover:border-[var(--error)] hover:bg-[rgba(239,68,68,0.1)] rounded-lg transition-colors text-[var(--text-secondary)] hover:text-[var(--error)]"
          title="Delete Project"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </button>
      </div>
    </div>
  );
}
