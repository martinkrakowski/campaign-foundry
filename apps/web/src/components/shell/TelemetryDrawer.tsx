"use client";

import { useRun, type LogLevel } from "@/lib/run-context";
import { cn } from "@/lib/cn";

const LEVEL_COLOR: Record<LogLevel, string> = {
  info: "text-info",
  warn: "text-warning",
  error: "text-error",
};

const formatTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toLocaleTimeString("en-US", { hour12: false });
};

interface TelemetryDrawerProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Floating telemetry log drawer. Renders the `log[]` returned by the last run
 * (the live-streaming variant is a follow-up — see the plan).
 */
export function TelemetryDrawer({ open, onClose }: TelemetryDrawerProps) {
  const { log } = useRun();

  return (
    <div
      className={cn(
        "absolute bottom-24 left-1/2 z-10 flex w-full max-w-[800px] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl transition-all duration-300",
        open ? "h-48 opacity-100" : "h-0 opacity-0",
      )}
      aria-hidden={!open}
    >
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-surface-2 px-4">
        <span className="font-mono text-[11px] uppercase tracking-wider text-text-muted">
          System Telemetry Stream
        </span>
        <button type="button" onClick={onClose} className="text-text-muted hover:text-white" aria-label="Close telemetry">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto bg-black p-4 font-mono text-[11px] leading-5">
        {log.length === 0 ? (
          <div className="text-text-muted">[SYSTEM] Ready to orchestrate pipeline…</div>
        ) : (
          log.map((entry, i) => (
            <div key={i}>
              <span className="text-text-muted">{formatTime(entry.timestamp)}</span>{" "}
              <span className={cn("font-semibold", LEVEL_COLOR[entry.level])}>[{entry.stage}]</span>{" "}
              <span className="text-text-primary">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
