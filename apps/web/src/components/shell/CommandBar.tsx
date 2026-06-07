"use client";

import { useRun } from "@/lib/run-context";

interface CommandBarProps {
  onToggleTelemetry: () => void;
}

/** Floating bottom orchestrator bar: status, telemetry toggle, and Execute. */
export function CommandBar({ onToggleTelemetry }: CommandBarProps) {
  const { execute, loading, error, hasRun, halted } = useRun();

  const status = loading
    ? "Orchestrating…"
    : error
      ? error
      : halted
        ? "Pipeline halted — review required."
        : hasRun
          ? "Execution complete. Assets ready for human review."
          : "Standing by…";

  const statusColor = error || halted ? "text-error" : hasRun && !loading ? "text-success" : "text-text-primary";

  return (
    <div className="absolute bottom-6 left-1/2 z-20 flex w-full max-w-[800px] -translate-x-1/2 flex-col rounded-xl border border-border bg-surface p-2 shadow-2xl">
      <div className="flex items-center justify-between border-b border-border px-2 pb-4 pt-1">
        <span className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
          Pipeline Orchestrator
        </span>
        <span className={`text-[12px] ${statusColor}`}>{status}</span>
      </div>
      <div className="flex items-center justify-between px-2 pt-2">
        <button
          type="button"
          onClick={onToggleTelemetry}
          className="flex items-center space-x-2 rounded border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-muted transition-colors hover:text-white"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M4 15V9a2 2 0 012-2h12a2 2 0 012 2v6a2 2 0 01-2 2H6a2 2 0 01-2-2z" />
          </svg>
          <span>Toggle Telemetry Logs</span>
        </button>

        <button
          type="button"
          onClick={execute}
          disabled={loading}
          aria-busy={loading || undefined}
          className="flex items-center space-x-2 rounded-full bg-white px-6 py-1.5 text-[13px] font-semibold text-black transition-colors hover:bg-gray-200 disabled:bg-surface-2 disabled:text-text-muted"
        >
          {loading ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path d="M21 12l-18 12v-24z" />
            </svg>
          )}
          <span>{loading ? "Orchestrating…" : "Execute Pipeline"}</span>
        </button>
      </div>
    </div>
  );
}
