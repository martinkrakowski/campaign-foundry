"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { assetKey, encodeMinutes, useRun } from "@/lib/run-context";
import { classicAdCount } from "@/components/campaign/derive";
import { planCampaign, type PlanResult } from "@/lib/briefs-api";

/** Match wizard PLAN_DEBOUNCE_MS without importing wizard-state. */
const PLAN_DEBOUNCE_MS = 250;

interface CommandBarProps {
  onToggleTelemetry: () => void;
}

/** Which confirmation is open, if any. */
type Confirm = "run" | "regenerate";

/** Floating bottom orchestrator bar: status, telemetry toggle, regenerate, Execute. */
export function CommandBar({ onToggleTelemetry }: CommandBarProps) {
  const {
    execute,
    regenerateRejected,
    loading,
    error,
    hasRun,
    halted,
    brief,
    assets,
    decisions,
    setEstimate,
    rerollBlockedReason,
  } =
    useRun();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  /** Ties the re-roll button to the visible explanation of why it is refused. */
  const rerollBlockedId = useId();
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const shownHashRef = useRef<string | null>(null);

  const isVariation = brief.mode === "variation";

  // What a full run will (re)generate: products × aspect ratios × treatments.
  // The formula lives in `derive.ts` (D31) so the sidebar's classic estimate and this
  // readout state the same number rather than each guessing.
  const expectedCount = classicAdCount(brief.products.length, brief.treatments?.length);

  useEffect(() => {
    if (!isVariation) {
      shownHashRef.current = null;
      setPlan(null);
      setEstimate({ status: "idle" });
      return;
    }
    // The previous estimate no longer describes this brief: clear it at once so
    // Execute stays disabled until the new one lands (the Runs page shows "estimating…").
    setPlan(null);
    setEstimate({ status: "loading" });
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void planCampaign(brief, controller.signal).then((result) => {
        if (cancelled) return;
        setPlan(result);
        // Same policyHash as the estimate already on the context: skip the redundant write.
        if (result.kind === "ok" && result.policyHash === shownHashRef.current) return;
        shownHashRef.current = result.kind === "ok" ? result.policyHash : null;
        if (result.kind === "ok") {
          setEstimate({ status: "ok", estimate: result.estimate, error: null });
        } else if (result.kind === "infeasible") {
          setEstimate({ status: "infeasible", estimate: null, error: result.error });
        } else {
          setEstimate({ status: "unavailable", estimate: null, error: null });
        }
      });
    }, PLAN_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [brief, isVariation, setEstimate]);

  const variationBlocked = isVariation && (plan === null || plan.kind === "infeasible");
  const creativeCount = plan?.kind === "ok" ? plan.estimate.creatives : expectedCount;

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
              <span className="text-text-primary">{creativeCount} creatives</span>
              {isVariation
                ? " from the variation plan"
                : " (every product × aspect ratio × treatment)"}{" "}
              and may consume GenAI quota/credits.
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
      <div className="flex items-center justify-between gap-3 border-b border-border px-2 pb-4 pt-1">
        <span className="shrink-0 font-mono text-[11px] uppercase tracking-widest text-text-muted">
          Pipeline Orchestrator
        </span>
        <span className={`truncate text-right text-[12px] ${statusColor}`}>{status}</span>
      </div>
      {isVariation && <EstimateSummary plan={plan} />}
      {/* Why the re-roll is refused — its own row, so a long sentence stays readable
          on a phone instead of being squeezed between two buttons. */}
      {rejectedCount > 0 && rerollBlockedReason !== null && (
        <p id={rerollBlockedId} role="status" className="px-2 pt-2 text-[11px] leading-tight text-warning">
          {rerollBlockedReason}
        </p>
      )}
      <div className="flex items-center justify-between gap-2 px-2 pt-2">
        <button
          type="button"
          onClick={onToggleTelemetry}
          aria-label="Toggle telemetry logs"
          className="flex shrink-0 items-center space-x-2 rounded border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-muted transition-colors hover:text-text-emphasis"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M4 15V9a2 2 0 012-2h12a2 2 0 012 2v6a2 2 0 01-2 2H6a2 2 0 01-2-2z" />
          </svg>
          <span className="hidden sm:inline">Toggle Telemetry Logs</span>
        </button>

        <div className="flex items-center gap-2">
          {/* Re-roll just the rejected creatives — only meaningful once some exist. */}
          {rejectedCount > 0 && (
            <button
              type="button"
              onClick={() => {
                // A mode change blocks the re-roll. Disabling the verb made the tap do
                // nothing at all — and `title` is unreachable on a touch device — so
                // route the blocked click through the guard, which reports the reason.
                if (rerollBlockedReason !== null) {
                  void regenerateRejected();
                  return;
                }
                setConfirm("regenerate");
              }}
              disabled={loading}
              title={rerollBlockedReason ?? undefined}
              aria-haspopup={rerollBlockedReason === null ? "dialog" : undefined}
              // `title` is unreliable (and absent on touch), so point assistive tech at
              // the visible reason instead. Not `aria-disabled`: the control is genuinely
              // interactive — the tap is what reports the refusal.
              aria-describedby={rerollBlockedReason === null ? undefined : rerollBlockedId}
              className="flex shrink-0 items-center space-x-2 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-[13px] text-text-primary transition-colors hover:bg-border-hover disabled:cursor-not-allowed disabled:text-text-muted sm:px-4"
            >
              <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>
                Regenerate<span className="hidden sm:inline"> Rejected</span> ({rejectedCount})
              </span>
            </button>
          )}

          {/* The inverse of the ground rather than a white pill — see export/page.tsx. */}
          <button
            type="button"
            onClick={() => setConfirm("run")}
            disabled={loading || variationBlocked}
            aria-busy={loading || undefined}
            aria-haspopup="dialog"
            className="flex shrink-0 items-center space-x-2 rounded-full bg-text-emphasis px-4 py-1.5 text-[13px] font-semibold text-background transition-opacity hover:opacity-90 disabled:bg-surface-2 disabled:text-text-muted sm:px-6"
          >
            {loading ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <svg className="h-4 w-4 shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path d="M21 12l-18 12v-24z" />
              </svg>
            )}
            <span>
              {loading ? "Orchestrating…" : (
                <>
                  Execute<span className="hidden sm:inline"> Pipeline</span>
                </>
              )}
            </span>
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

function EstimateSummary({ plan }: { plan: PlanResult | null }) {
  return (
    <div className="border-b border-border px-2 py-2">
      <h3 className="font-mono text-[11px] uppercase tracking-widest text-text-muted">Estimate</h3>
      {plan === null ? (
        <p className="mt-1 text-[12px] text-text-muted">Estimating…</p>
      ) : plan.kind === "ok" ? (
        <>
          <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[12px] text-text-primary sm:grid-cols-4">
            <div>
              <dt className="text-text-muted">creatives</dt>
              <dd>{plan.estimate.creatives}</dd>
            </div>
            <div>
              <dt className="text-text-muted">axisProductSize</dt>
              <dd>{plan.estimate.axisProductSize}</dd>
            </div>
            <div>
              <dt className="text-text-muted">feasible</dt>
              <dd>{plan.estimate.feasible ? "yes" : "no"}</dd>
            </div>
            <div>
              <dt className="text-text-muted">genaiCalls</dt>
              <dd>{plan.estimate.genaiCalls}</dd>
            </div>
            {plan.estimate.frames !== undefined && (
              <>
                <div>
                  <dt className="text-text-muted">frames</dt>
                  <dd>{plan.estimate.frames}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">encode</dt>
                  <dd>{encodeMinutes(plan.estimate.frames)}</dd>
                </div>
              </>
            )}
          </dl>
          {plan.estimate.genaiCalls > 0 && (
            <p className="mt-1 text-[12px] text-warning">
              Cost warning: this plan makes {plan.estimate.genaiCalls} GenAI calls.
            </p>
          )}
        </>
      ) : plan.kind === "infeasible" ? (
        <p className="mt-1 text-[12px] text-error">{plan.error}</p>
      ) : (
        <p className="mt-1 text-[12px] text-text-muted">estimate unavailable</p>
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
      /* istanbul ignore next -- the dialog always contains focusable controls */
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Confirm pipeline action"
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-text-emphasis">{title}</h2>
        <p className="mt-2 text-[13px] leading-5 text-text-muted">{description}</p>
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border px-4 py-1.5 text-[13px] text-text-muted transition-colors hover:text-text-emphasis"
          >
            Cancel
          </button>
          {/* The inverse of the ground rather than a white pill — see export/page.tsx. */}
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="rounded-full bg-text-emphasis px-5 py-1.5 text-[13px] font-semibold text-background transition-opacity hover:opacity-90"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
