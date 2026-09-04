"use client";

import { useEffect, useState } from "react";
import { listBriefs, type BriefEntry } from "@/lib/briefs-api";
import type { CampaignMode } from "@/components/campaign/editor-state";
import * as messages from "@/components/campaign/messages";

/** What a chosen row hands the dialog: the source's id and the mode its copy inherits. */
export interface StartFromSource {
  readonly id: string;
  readonly mode: CampaignMode;
}

/**
 * W2 (D71) — "start from an existing campaign" inside the create dialog. Lists the
 * store's briefs with the row shape the brief picker uses (id · products ·
 * treatments · region) and hands a choice back as a selection, not a navigation.
 * The blank default row is the dialog's resting state: a blank create is the common
 * case, so selecting nothing is what the dialog opens with (the caller owns that
 * selection; this component only renders it). The row labels the brief by its id —
 * which *is* a slug — but no slug is ever derived or previewed for the new campaign
 * (D65).
 */
export function StartFromExistingPicker({
  selectedId,
  onSelect,
}: {
  readonly selectedId: string | null;
  readonly onSelect: (source: StartFromSource | null) => void;
}) {
  const [entries, setEntries] = useState<BriefEntry[] | null>(null);
  const [error, setError] = useState(false);

  // Load once per mount — the dialog mounts this only while open, so each open
  // re-reads the store. Parse defensively so an API error surfaces as the error
  // state, not a misleading empty list.
  useEffect(() => {
    let active = true;
    setEntries(null);
    setError(false);
    (async () => {
      try {
        const briefs = await listBriefs();
        /* istanbul ignore next -- `active` is the unmount-race guard; false only if the dialog closes mid-fetch */
        if (active) setEntries(briefs);
      } catch {
        /* istanbul ignore next -- same unmount-race guard on the error path */
        if (active) setError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return <p className="p-4 text-[13px] text-error">{messages.startFromExistingError}</p>;
  }
  if (entries === null) {
    return <p className="p-4 text-[13px] text-text-muted">{messages.startFromExistingLoading}</p>;
  }
  if (entries.length === 0) {
    // An empty store is not an error: this will be the first campaign.
    return <p className="p-4 text-[13px] text-text-muted">{messages.startFromExistingEmpty}</p>;
  }
  return (
    <div className="max-h-56 divide-y divide-border overflow-auto rounded-lg border border-border">
      <button
        type="button"
        aria-pressed={selectedId === null}
        onClick={() => onSelect(null)}
        className={`flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left transition-colors hover:bg-surface-2 ${
          selectedId === null ? "bg-surface-2" : ""
        }`}
      >
        <span className="text-[13px] font-medium text-text-primary">{messages.startFromExistingBlank}</span>
      </button>
      {entries.map((entry) => {
        const id = entry.brief.id;
        const selected = selectedId === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect({ id, mode: entry.brief.mode ?? "brief" })}
            className={`flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left transition-colors hover:bg-surface-2 ${
              selected ? "bg-surface-2" : ""
            }`}
          >
            <span className="font-mono text-[13px] text-text-primary">{id}</span>
            <span className="text-[11px] text-text-muted">
              {messages.startFromRowMeta(
                entry.brief.products.length,
                entry.brief.treatments?.length ?? 1,
                entry.brief.targetRegion,
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
