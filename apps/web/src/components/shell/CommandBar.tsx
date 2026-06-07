"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { assetKey, useRun } from "@/lib/run-context";
import { ASPECT_RATIOS } from "@/lib/aspect-ratios";

interface CommandBarProps {
  onToggleTelemetry: () => void;
}

/** Which confirmation is open, if any. */
type Confirm = "run" | "regenerate";

/** Floating bottom orchestrator bar: status, telemetry toggle, regenerate, Execute. */
export function CommandBar({ onToggleTelemetry }: CommandBarProps) {
  const { execute, regenerateRejected, loading, error, hasRun, halted, brief, assets, decisions } =
    useRun();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // What a full run will (re)generate: products × aspect ratios × treatments.
  const expectedCount =
    brief.products.length * ASPECT_RATIOS.length * (brief.treatments?.length ?? 1);

  const rejectedCount = useMemo(
    () => assets.filter((a) => decisions[assetKey(a)] === "rejected").length,
    [assets, decisions],
  );

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

  // Confirm-dialog copy per action — the dialog itself is presentational.
  const dialog =
    confirm === "run"
      ? {
          title: hasRun ? "Regenerate the entire pipeline?" : "Run the entire pipeline?",
          confirmLabel: hasRun ? "Regenerate" : "Generate",
          onConfirm: execute,
          description: (
            <>
              This {hasRun ? "regenerates" : "generates"} all{" "}
              <span className="text-text-primary">{expectedCount} creatives</span> (every product ×
              aspect ratio × treatment) and may consume GenAI quota/credits.
            </>
          ),
        }
      : confirm === "regenerate"
        ? {
            title: "Regenerate rejected creatives?",
            confirmLabel: "Regenerate rejected",
            onConfirm: regenerateRejected,
            description: (
              <>
                This re-rolls only the{" "}
                <span className="text-text-primary">{rejectedCount} rejected</span>{" "}
                {rejectedCount === 1 ? "creative" : "creatives"} and returns{" "}
                {rejectedCount === 1 ? "it" : "them"} to review. Approved and pending creatives are
                left untouched.
              </>
            ),
          }
        : null;

  return (
    <div
      ref={barRef}
      tabIndex={-1}
      className="absolute bottom-6 left-1/2 z-20 flex w-full max-w-[800px] -translate-x-1/2 flex-col rounded-xl border border-border bg-surface p-2 shadow-2xl outline-none"
    >
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

        <div className="flex items-center gap-2">
          {/* Re-roll just the rejected creatives — only meaningful once some exist. */}
          {rejectedCount > 0 && (
            <button
              type="button"
              onClick={() => setConfirm("regenerate")}
              disabled={loading}
              aria-haspopup="dialog"
              className="flex items-center space-x-2 rounded-full border border-border bg-surface-2 px-4 py-1.5 text-[13px] text-text-primary transition-colors hover:bg-border-hover disabled:cursor-not-allowed disabled:text-text-muted"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>Regenerate Rejected ({rejectedCount})</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setConfirm("run")}
            disabled={loading}
            aria-busy={loading || undefined}
            aria-haspopup="dialog"
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

      {dialog &&
        createPortal(
          <ConfirmDialog
            title={dialog.title}
            description={dialog.description}
            confirmLabel={dialog.confirmLabel}
            restoreFocusRef={barRef}
            onConfirm={() => {
              setConfirm(null);
              void dialog.onConfirm();
            }}
            onClose={() => setConfirm(null)}
          />,
          document.body,
        )}
    </div>
  );
}

/**
 * Confirms a pipeline action — a run (re)generates creatives and can consume GenAI
 * quota/credits, so it shouldn't fire on an accidental click. Presentational: the
 * caller supplies the copy. Portalled to <body> because the CommandBar's transform
 * would otherwise trap a fixed overlay. Closes on backdrop click, Cancel, or Escape;
 * traps focus and restores it on close.
 */
function ConfirmDialog({
  title,
  description,
  confirmLabel,
  restoreFocusRef,
  onConfirm,
  onClose,
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Restore focus to the trigger only if it's still focusable. Confirming a run
      // disables the trigger (loading), so focusing it would silently drop focus to
      // <body>; fall back to a stable container in that case.
      const prev = previouslyFocused;
      if (prev && prev.isConnected && !(prev as HTMLButtonElement).disabled) {
        prev.focus();
      } else {
        restoreFocusRef?.current?.focus();
      }
    };
  }, [onClose, restoreFocusRef]);

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Confirm pipeline action"
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <p className="mt-2 text-[13px] leading-5 text-text-muted">{description}</p>
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border px-4 py-1.5 text-[13px] text-text-muted transition-colors hover:text-white"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="rounded-full bg-white px-5 py-1.5 text-[13px] font-semibold text-black transition-colors hover:bg-gray-200"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
