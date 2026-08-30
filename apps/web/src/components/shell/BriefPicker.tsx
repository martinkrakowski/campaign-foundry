"use client";

import { useEffect, useState } from "react";
import { Button, Input, MiniChip, DialogShell, DialogHead, DialogBody, DialogFoot } from "@/components/ui";
import { duplicateBrief, listBriefs, unknownErrorMessage, type BriefEntry } from "@/lib/briefs-api";
import { useRouter } from "next/navigation";
import { useRun } from "@/lib/run-context";
import { useGuardedNavigation } from "@/lib/use-guarded-navigation";

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
  const router = useRouter();
  const { briefPickerOpen, closeBriefPicker, setBrief, brief: current } = useRun();
  const { guardedAction } = useGuardedNavigation();
  const [entries, setEntries] = useState<BriefEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const [duplicateTarget, setDuplicateTarget] = useState<BriefEntry | null>(null);
  const [duplicateId, setDuplicateId] = useState("");
  const [duplicating, setDuplicating] = useState(false);

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

  const select = (entry: BriefEntry) => {
    guardedAction(() => {
      setBrief(entry.brief);
      closeBriefPicker();
    });
  };

  const createNew = () => {
    guardedAction(() => {
      router.push("/brief/new");
      closeBriefPicker();
    });
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
    <DialogShell
      open={briefPickerOpen}
      onClose={closeBriefPicker}
      ariaLabel="Load a campaign brief"
    >
      <DialogHead
        title="Load a campaign brief"
        description={
          <>
            From the project&apos;s <span className="font-mono">briefs/</span> folder — pick one to
            load it into the workspace.
          </>
        }
        onClose={closeBriefPicker}
      />

      <DialogBody className="divide-y divide-border">
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
                      <MiniChip tone="neutral" className="shrink-0">
                        current
                      </MiniChip>
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
                  className="shrink-0 px-3 text-[11px] font-medium text-text-muted hover:text-text-emphasis"
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
      </DialogBody>

      {duplicateTarget ? (
        <DialogFoot>
          <form
            className="space-y-3"
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
        </DialogFoot>
      ) : null}
    </DialogShell>
  );
}
