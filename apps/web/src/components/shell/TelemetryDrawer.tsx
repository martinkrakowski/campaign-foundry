"use client";

import { useMemo, useState } from "react";
import { useRun } from "@/lib/run-context";
import { cn } from "@/lib/cn";
import { IconButton, LogPanel, type LogPanelEntry } from "@/components/ui";

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
 *
 * **The chrome is `LogPanel` now** (LP1 / SG-D21), shared with the validation
 * view. What stayed here is everything that is *this instance* rather than
 * *a log panel*: the run binding and the `LogEntry` mapping, the floating
 * position, the expand/collapse height, the drawer's element id, and the
 * `inert` behaviour below. What left is the header row, the Copy control and
 * the scrolling monospace body with its empty and loading states — which the
 * validation view needs identically and which could not be reused while this
 * file read `useRun()` two lines from the top.
 */
/** The drawer's element id, so the control that opens it can name it. */
export const TELEMETRY_DRAWER_ID = "telemetry-drawer";

export function TelemetryDrawer({ open, onClose }: TelemetryDrawerProps) {
  const { log, loading } = useRun();
  const [expanded, setExpanded] = useState(false);

  /**
   * A run entry's two leading columns, in the panel's vocabulary: the formatted
   * clock time is the dim `meta`, the stage is the bracketed `label`. Mapped
   * here rather than in the panel because `LogEntry` is the app's run shape and
   * the panel is domain-free — this function is the seam that lets the
   * validation view hand the same panel a section and a field message instead.
   */
  const entries = useMemo<LogPanelEntry[]>(
    () =>
      log.map((entry) => ({
        meta: formatTime(entry.timestamp),
        label: entry.stage,
        message: entry.message,
        level: entry.level,
      })),
    [log],
  );

  return (
    <LogPanel
      id={TELEMETRY_DRAWER_ID}
      title="System Telemetry Stream"
      entries={entries}
      loading={loading}
      loadingMessage="Waiting for the run to report…"
      emptyMessage="[SYSTEM] Ready to orchestrate pipeline…"
      // Stated in both states, matching the brief-id copy button. Dropping the
      // label to let the text name the control is not safe as a general rule
      // here — inside a <label>, the computed name comes out as the field's text
      // instead — so both copy controls name their copied state explicitly.
      copyLabel="Copy telemetry to clipboard"
      className={cn(
        "absolute bottom-24 left-1/2 z-10 w-full max-w-[800px] -translate-x-1/2 shadow-2xl transition-all duration-300",
        open ? "opacity-100" : "h-0 opacity-0",
        open && (expanded ? "top-2" : "h-48"),
      )}
      aria-hidden={!open}
      // Collapsed but still mounted (for the slide animation) — `inert` removes its
      // buttons from the tab order and pointer events while closed; aria-hidden alone
      // wouldn't.
      inert={!open}
      actions={
        <>
          <IconButton
            label={expanded ? "Collapse telemetry" : "Expand telemetry"}
            onClick={() => setExpanded((v) => !v)}
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden
            >
              {expanded ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 14l-7 7m0 0l-7-7m7 7V3"
                />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 10l7-7m0 0l7 7m-7-7v18"
                />
              )}
            </svg>
          </IconButton>
          <IconButton label="Close telemetry" onClick={onClose}>
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </IconButton>
        </>
      }
    />
  );
}
