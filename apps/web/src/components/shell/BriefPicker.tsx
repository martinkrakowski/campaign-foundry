"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";
import { duplicateBrief, listBriefs, unknownErrorMessage, type BriefEntry } from "@/lib/briefs-api";
import { useRun } from "@/lib/run-context";

// Mirrors CampaignOrchestration SAFE_ID_PATTERN. Value-importing the package
// constant from source barrels fails the Next build (it resolves `.js` siblings).
const BRIEF_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Modal that lists the briefs in the project's `briefs/` folder so a reviewer can
 * load their own spec instead of the built-in demo. Auto-opens once on first visit
 * (run-context remembers the dismissal); reopenable from the sidebar. Closes on a
 * pick, the × button, the backdrop, or Escape; traps focus.
 */
export function BriefPicker() {
  const { briefPickerOpen, closeBriefPicker, setBrief, brief: current } = useRun();
  const router = useRouter();
  const [entries, setEntries] = useState<BriefEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const [duplicateTarget, setDuplicateTarget] = useState<BriefEntry | null>(null);
  const [duplicateId, setDuplicateId] = useState("");
  const [duplicating, setDuplicating] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // (Re)load the list each time the picker opens. Parse defensively so an API error
  // surfaces as an error state, not a misleading empty list.
  useEffect(() => {
    if (!briefPickerOpen) return;
    let active = true;
    setEntries(null);
    setError(false);
    setActionError(undefined);
    setDuplicateTarget(null);
    (async () => {
      try {
        const briefs = await listBriefs();
        /* istanbul ignore next -- `active` is the unmount-race guard; false only if the picker closes mid-fetch */
        if (active) setEntries(briefs);
      } catch {
        /* istanbul ignore next -- same unmount-race guard on the error path */
        if (active) setError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [briefPickerOpen]);

  // Focus in on open, trap Tab, restore on close.
  useEffect(() => {
    if (!briefPickerOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeBriefPicker();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button, input, [tabindex]:not([tabindex="-1"])',
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
      previouslyFocused?.focus?.();
    };
  }, [briefPickerOpen, closeBriefPicker]);

  if (!briefPickerOpen) return null;

  const select = (entry: BriefEntry) => {
    setBrief(entry.brief);
    closeBriefPicker();
  };

  const createNew = () => {
    closeBriefPicker();
    router.push("/new");
  };

  const confirmDuplicate = async () => {
    /* istanbul ignore next -- the form only renders while a target is selected */
    if (!duplicateTarget) return;
    if (!BRIEF_ID_PATTERN.test(duplicateId)) {
      setActionError("New id must be a path-safe slug (lowercase letters, digits, hyphens; max 64).");
      return;
    }
    setDuplicating(true);
    setActionError(undefined);
    try {
      const result = await duplicateBrief(duplicateTarget.brief.id, duplicateId);
      try {
        setEntries(await listBriefs());
      } catch {
        /* list refresh is best-effort; the copy still exists */
      }
      setBrief(result.brief);
      closeBriefPicker();
    } catch (err) {
      setActionError(unknownErrorMessage(err, "Duplicate failed"));
    } finally {
      setDuplicating(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm sm:p-8"
      onClick={closeBriefPicker}
      role="dialog"
      aria-modal="true"
      aria-label="Load a campaign brief"
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Load a campaign brief</h2>
            <p className="mt-0.5 text-[11px] text-text-muted">
              From the project&apos;s <span className="font-mono">briefs/</span> folder — pick one to
              load it into the workspace.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={closeBriefPicker}
            aria-label="Close"
            className="shrink-0 text-text-muted transition-colors hover:text-white"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
          <button
            type="button"
            onClick={createNew}
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-[13px] font-medium text-text-primary transition-colors hover:bg-surface-2"
          >
            Create new
          </button>
          {error ? (
            <p className="p-4 text-[13px] text-error">Could not load briefs. Is the API running?</p>
          ) : entries === null ? (
            <p className="p-4 text-[13px] text-text-muted">Loading briefs…</p>
          ) : entries.length === 0 ? (
            <p className="p-4 text-[13px] text-text-muted">
              No briefs found in <span className="font-mono">briefs/</span>.
            </p>
          ) : (
            entries.map((entry) => {
              const productCount = entry.brief.products.length;
              const treatmentCount = entry.brief.treatments?.length ?? 1;
              const isCurrent = entry.brief.id === current.id;
              return (
                <div key={entry.file} className="flex items-stretch hover:bg-surface-2">
                  <button
                    type="button"
                    onClick={() => select(entry)}
                    className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-4 py-3 text-left"
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="font-mono text-[13px] text-text-primary">{entry.file}</span>
                      {isCurrent && (
                        <span className="shrink-0 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                          current
                        </span>
                      )}
                    </span>
                    <span className="text-[11px] text-text-muted">
                      {entry.brief.id} · {productCount} product{productCount === 1 ? "" : "s"} ·{" "}
                      {treatmentCount} treatment{treatmentCount === 1 ? "" : "s"} ·{" "}
                      {entry.brief.targetRegion}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="shrink-0 px-3 text-[11px] font-medium text-text-muted hover:text-white"
                    onClick={() => {
                      setDuplicateTarget(entry);
                      setDuplicateId("");
                      setActionError(undefined);
                    }}
                  >
                    Duplicate
                  </button>
                </div>
              );
            })
          )}
        </div>

        {duplicateTarget ? (
          <form
            className="space-y-3 border-t border-border px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              void confirmDuplicate();
            }}
          >
            <p className="text-[12px] text-text-muted">
              Duplicate <span className="font-mono text-text-primary">{duplicateTarget.brief.id}</span> as
            </p>
            <Input
              value={duplicateId}
              onChange={(e) => setDuplicateId(e.target.value)}
              aria-label="New brief id"
              invalid={Boolean(actionError)}
            />
            {actionError ? <p className="text-[11px] text-error">{actionError}</p> : null}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={duplicating} isLoading={duplicating}>
                Duplicate
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDuplicateTarget(null);
                  setActionError(undefined);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
