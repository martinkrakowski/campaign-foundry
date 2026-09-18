"use client";

import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";
import { Eyebrow } from "./eyebrow";
import { Skeleton } from "./skeleton";

/** How a row reads. `info` is the quiet default. */
export type LogPanelLevel = "info" | "warn" | "error";

const LEVEL_COLOR: Record<LogPanelLevel, string> = {
  info: "text-info",
  warn: "text-warning",
  error: "text-error",
};

/**
 * One row.
 *
 * Deliberately **not** `LogEntry` from the app's run context (LP1/SG-D21). A
 * run entry carries a `timestamp` and a `stage` because a run produced it; the
 * other caller for this panel is the validation view, whose rows are a section
 * and a field message that **no run produced**. Naming the two columns for what
 * they do to the layout — a dim leading `meta`, a bracketed `label` — lets both
 * wear the panel without either inventing the other's data. Fabricating a stage
 * so a validation error could pretend to be telemetry would make the Copy
 * control emit a log claiming a run that never happened.
 */
export interface LogPanelEntry {
  /** The dim leading column: a formatted time for a run, a field for an error. */
  readonly meta?: string;
  /** The bracketed token: a run stage, or the section an error belongs to. */
  readonly label?: string;
  readonly message: string;
  /** Defaults to `info`. */
  readonly level?: LogPanelLevel;
}

/**
 * The surface every log panel wears. Exported so a consumer composing its own
 * root (or a test asserting the chrome did not drift) names it by derivation
 * rather than by restating the string.
 */
export const LOG_PANEL_SURFACE =
  "flex flex-col overflow-hidden rounded-xl border border-border bg-surface";

export interface LogPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "title"> {
  /** The panel's heading. Rendered in an `Eyebrow`. */
  readonly title: ReactNode;
  readonly entries: readonly LogPanelEntry[];
  /**
   * A source is working but has not spoken yet. Only consulted while `entries`
   * is empty — a panel with rows shows them rather than a skeleton.
   */
  readonly loading?: boolean;
  /** Announced (`role="status"`) above the skeletons while `loading`. */
  readonly loadingMessage?: string;
  /** Shown when there is nothing to report and nothing is pending. */
  readonly emptyMessage?: string;
  /**
   * The Copy control's accessible name in its resting state. Omit the prop to
   * render no Copy control at all — the copied-state name is shared, because
   * both copy controls in this app state it in both states rather than letting
   * the text name the control (inside a `<label>` the computed name comes out
   * as the field's text instead).
   */
  readonly copyLabel?: string;
  /** Instance controls for the header's right end — expand, close, refresh. */
  readonly actions?: ReactNode;
  /** Extra classes for the body's scroller. */
  readonly bodyClassName?: string;
}

/** `meta [label] message`, the one line shape both callers' rows reduce to. */
const asText = (entries: readonly LogPanelEntry[]): string =>
  entries
    .map((e) =>
      [e.meta, e.label === undefined ? undefined : `[${e.label}]`, e.message]
        .filter((part) => part !== undefined && part !== "")
        .join(" "),
    )
    .join("\n");

/**
 * A scrolling monospace log surface with a titled header, an optional Copy
 * control and a slot for instance controls (LP1).
 *
 * **Extracted from `TelemetryDrawer`, which now wears it** (SG-D21). The owner
 * asked to reuse the telemetry drawer as the validation screen; the *chrome* is
 * reusable and the *data binding* is not — the drawer reads `useRun()`, and a
 * validation error comes from the brief projection instead. So the panel takes
 * its rows as a prop and knows nothing about runs, which is also what keeps it
 * in this package: a kit component reaching into the app's run state would be a
 * layer violation as well as a coupling.
 *
 * **What stays with the consumer:** position, size, and any hidden-but-mounted
 * behaviour. The drawer floats over the grid and is `inert` while closed; the
 * validation view renders in the middle column and is neither. Those belong to
 * the instance, so this component contributes only the surface and forwards the
 * rest — `id`, `aria-hidden`, `inert` and `className` all land on the root.
 */
export function LogPanel({
  title,
  entries,
  loading = false,
  loadingMessage,
  emptyMessage,
  copyLabel,
  actions,
  className,
  bodyClassName,
  ...rest
}: LogPanelProps): ReactNode {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending "Copied" reset on unmount (avoids a setState-after-unmount).
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copy = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(asText(entries));
      setCopied(true);
      // Reset the prior timer so rapid clicks don't flip "Copied" back early.
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (e.g. insecure context) — skip silently.
    }
  };

  return (
    <div className={cn(LOG_PANEL_SURFACE, className)} {...rest}>
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface-2 px-4">
        <Eyebrow>{title}</Eyebrow>
        <div className="flex items-center gap-3">
          {copyLabel === undefined ? null : (
            <button
              type="button"
              onClick={copy}
              disabled={entries.length === 0}
              className="font-mono text-[10px] uppercase tracking-wider text-text-muted transition-colors hover:text-text-emphasis disabled:opacity-40"
              aria-label={copied ? "Copied ✓" : copyLabel}
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          )}
          {actions}
        </div>
      </div>
      {/* The log panel is a surface, not a black terminal. A ground painted `#000000`
          in both themes cannot carry theme text: `text-text-primary` is near-black in
          the light theme, which measured 1.18:1 — invisible — and the state colours are
          darker still. `surface-2` is the panel-on-a-panel token, and the skeletons are
          lifted to `border` so they do not vanish into it. */}
      <div
        className={cn(
          "flex-1 overflow-y-auto bg-surface-2 p-4 font-mono text-[11px] leading-5",
          bodyClassName,
        )}
      >
        {entries.length === 0 ? (
          // A source is working but has not spoken yet: the wait is announced by the
          // status sentence, and the skeleton only stands in for the lines to come.
          loading ? (
            <div className="space-y-2">
              <p role="status" className="text-text-muted">
                {loadingMessage}
              </p>
              <Skeleton className="h-3 w-3/4 bg-border" />
              <Skeleton className="h-3 w-1/2 bg-border" />
            </div>
          ) : (
            <div className="text-text-muted">{emptyMessage}</div>
          )
        ) : (
          entries.map((entry, i) => (
            <div key={i}>
              {entry.meta === undefined ? null : (
                <>
                  <span className="text-text-muted">{entry.meta}</span>{" "}
                </>
              )}
              {entry.label === undefined ? null : (
                <>
                  <span className={cn("font-semibold", LEVEL_COLOR[entry.level ?? "info"])}>
                    [{entry.label}]
                  </span>{" "}
                </>
              )}
              <span className="text-text-primary">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
