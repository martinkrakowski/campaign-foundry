"use client";

import { useEffect, useRef, useState } from "react";
import { useRun, type LogLevel } from "@/lib/run-context";
import { cn } from "@/lib/cn";
import { Eyebrow, IconButton, Skeleton } from "@/components/ui";

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
/** The drawer's element id, so the control that opens it can name it. */
export const TELEMETRY_DRAWER_ID = "telemetry-drawer";

export function TelemetryDrawer({ open, onClose }: TelemetryDrawerProps) {
  const { log, loading } = useRun();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending "Copied" reset on unmount (avoids a setState-after-unmount).
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copyLog = async () => {
    if (!navigator.clipboard) return;
    const text = log
      .map((e) => `${formatTime(e.timestamp)} [${e.stage}] ${e.message}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      // Reset the prior timer so rapid clicks don't flip "Copied" back early.
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (e.g. insecure context) — skip silently.
    }
  };

  return (
    <div
      id={TELEMETRY_DRAWER_ID}
      className={cn(
        "absolute bottom-24 left-1/2 z-10 flex w-full max-w-[800px] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl transition-all duration-300",
        open ? "opacity-100" : "h-0 opacity-0",
        open && (expanded ? "top-2" : "h-48"),
      )}
      aria-hidden={!open}
      // Collapsed but still mounted (for the slide animation) — `inert` removes its
      // buttons from the tab order and pointer events while closed; aria-hidden alone
      // wouldn't.
      inert={!open}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface-2 px-4">
        <Eyebrow>System Telemetry Stream</Eyebrow>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={copyLog}
            disabled={log.length === 0}
            className="font-mono text-[10px] uppercase tracking-wider text-text-muted transition-colors hover:text-text-emphasis disabled:opacity-40"
            aria-label={copied ? undefined : "Copy telemetry to clipboard"}
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <IconButton
            label={expanded ? "Collapse telemetry" : "Expand telemetry"}
            onClick={() => setExpanded((v) => !v)}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              {expanded ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
              )}
            </svg>
          </IconButton>
          <IconButton label="Close telemetry" onClick={onClose}>
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </IconButton>
        </div>
      </div>
      {/* The log panel is a surface, not a black terminal. A ground painted `#000000`
          in both themes cannot carry theme text: `text-text-primary` is near-black in
          the light theme, which measured 1.18:1 — invisible — and the state colours are
          darker still. `surface-2` is the panel-on-a-panel token, and the skeletons are
          lifted to `border` so they do not vanish into it. */}
      <div className="flex-1 overflow-y-auto bg-surface-2 p-4 font-mono text-[11px] leading-5">
        {log.length === 0 ? (
          // A run is in flight but has not spoken yet: the wait is announced by the
          // status sentence, and the skeleton only stands in for the lines to come.
          loading ? (
            <div className="space-y-2">
              <p role="status" className="text-text-muted">
                Waiting for the run to report…
              </p>
              <Skeleton className="h-3 w-3/4 bg-border" />
              <Skeleton className="h-3 w-1/2 bg-border" />
            </div>
          ) : (
            <div className="text-text-muted">[SYSTEM] Ready to orchestrate pipeline…</div>
          )
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
