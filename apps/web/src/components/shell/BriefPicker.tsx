"use client";

import { useEffect, useRef, useState } from "react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { API, useRun } from "@/lib/run-context";

interface BriefEntry {
  file: string;
  brief: CampaignBrief;
}

/**
 * Modal that lists the briefs in the project's `briefs/` folder so a reviewer can
 * load their own spec instead of the built-in demo. Auto-opens once on first visit
 * (run-context remembers the dismissal); reopenable from the sidebar. Closes on a
 * pick, the × button, the backdrop, or Escape; traps focus.
 */
export function BriefPicker() {
  const { briefPickerOpen, closeBriefPicker, setBrief, brief: current } = useRun();
  const [entries, setEntries] = useState<BriefEntry[] | null>(null);
  const [error, setError] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // (Re)load the list each time the picker opens. Parse defensively (check res.ok and
  // guard JSON) so an API error — a non-2xx `{ error }` body, or a non-JSON 5xx from the
  // proxy when the API is down — surfaces as an error state, not a misleading empty list.
  useEffect(() => {
    if (!briefPickerOpen) return;
    let active = true;
    setEntries(null);
    setError(false);
    (async () => {
      try {
        const res = await fetch(`${API}/campaigns/briefs`);
        const raw = await res.text();
        let data: { briefs?: BriefEntry[] } | null = null;
        try {
          data = JSON.parse(raw) as { briefs?: BriefEntry[] };
        } catch {
          data = null;
        }
        if (!res.ok || !data) throw new Error(`Briefs request failed (HTTP ${res.status})`);
        if (active) setEntries(data.briefs ?? []);
      } catch {
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
        'a[href], button, [tabindex]:not([tabindex="-1"])',
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
      previouslyFocused?.focus?.();
    };
  }, [briefPickerOpen, closeBriefPicker]);

  if (!briefPickerOpen) return null;

  const select = (entry: BriefEntry) => {
    setBrief(entry.brief);
    closeBriefPicker();
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
                <button
                  key={entry.file}
                  type="button"
                  onClick={() => select(entry)}
                  className="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left transition-colors hover:bg-surface-2"
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
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
