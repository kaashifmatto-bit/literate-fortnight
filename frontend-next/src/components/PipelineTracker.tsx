"use client";

import type { PipelineStep } from "@/lib/types";

interface PipelineTrackerProps {
  steps: PipelineStep[];
  status: string;
}

export default function PipelineTracker({ steps, status }: PipelineTrackerProps) {
  const getStepStatusIcon = (stepStatus: PipelineStep["status"]) => {
    switch (stepStatus) {
      case "completed":
        return (
          <div className="w-6 h-6 rounded-full bg-[rgba(34,197,94,0.15)] border border-[var(--success)] text-[var(--success)] flex items-center justify-center font-bold text-xs">
            ✓
          </div>
        );
      case "running":
        return (
          <div className="w-6 h-6 rounded-full bg-[rgba(99,102,241,0.15)] border border-[var(--accent-primary)] text-[var(--accent-primary)] flex items-center justify-center pulse-glow">
            <span className="animate-spin inline-block w-3 h-3 border-2 border-transparent border-t-[var(--accent-primary)] rounded-full" />
          </div>
        );
      case "failed":
        return (
          <div className="w-6 h-6 rounded-full bg-[rgba(239,68,68,0.15)] border border-[var(--error)] text-[var(--error)] flex items-center justify-center font-bold text-xs">
            ✕
          </div>
        );
      case "pending":
      default:
        return (
          <div className="w-6 h-6 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-glass)] text-[var(--text-secondary)] flex items-center justify-center text-xs">
            -
          </div>
        );
    }
  };

  // Filter out any duplicate step entries by step_number
  const displaySteps = steps.filter(
    (step, idx, self) => self.findIndex((s) => s.step_number === step.step_number) === idx
  );

  return (
    <div className="glass p-8 space-y-6">
      <div className="flex justify-between items-center border-b border-[var(--border-glass)] pb-4">
        <h2 className="text-xl font-bold">Pipeline Status</h2>
        <span className={`badge uppercase ${
          status === "completed" ? "badge-completed" : status === "failed" ? "badge-failed" : "badge-processing"
        }`}>
          {status}
        </span>
      </div>

      <div className="space-y-6 relative before:absolute before:left-3 before:top-2 before:bottom-2 before:w-[2px] before:bg-[var(--border-glass)]">
        {displaySteps.map((step, idx) => (
          <div key={`step-${step.step_number}-${idx}`} className="flex gap-4 items-start relative z-10">
            {getStepStatusIcon(step.status)}
            <div className="flex-1 min-w-0">
              <div className="flex justify-between items-baseline mb-1">
                <h4 className="font-semibold text-sm truncate">{step.step_name}</h4>
                {step.status === "running" && (
                  <span className="text-xs font-semibold text-[var(--accent-primary)]">
                    {Math.round(step.progress)}%
                  </span>
                )}
              </div>
              <p className="text-xs text-[var(--text-secondary)]">
                {step.message || (step.status === "pending" ? "Waiting to start..." : "")}
              </p>
              {step.status === "running" && (
                <div className="w-full bg-[var(--bg-secondary)] h-1.5 rounded-full mt-2 overflow-hidden">
                  <div
                    className="bg-[var(--accent-primary)] h-full transition-all duration-300"
                    style={{ width: `${step.progress}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
