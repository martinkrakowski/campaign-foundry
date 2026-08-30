"use client";

import type { Dispatch } from "react";
import { useState, useEffect, useRef } from "react";
import { Button, Input, DrawerShell, DialogHead, Eyebrow, Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import { approvedHeadlines, toBrief } from "@/components/campaign/editor-state";
import {
  getPool,
  generatePool,
  patchPool,
  isBriefsApiError,
  unknownErrorMessage,
  POOL_SUGGESTION_COUNT,
  type CopyPool,
  type CopyPoolEntry,
} from "@/lib/briefs-api";
import { HEADLINE_POOL_REF } from "@/components/campaign/editor-state";

function PoolEntryRow({
  entry,
  busy,
  onStatus,
  onEdit,
}: {
  entry: CopyPoolEntry;
  busy: boolean;
  onStatus: (status: CopyPoolEntry["status"]) => void;
  onEdit: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const approved = entry.status === "approved";

  const save = async (text: string) => {
    if (await onEdit(text)) setDraft(null);
  };

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
      {draft === null ? (
        <span className="min-w-0 flex-1 text-[13px] text-text-primary">{entry.text}</span>
      ) : (
        <Input
          aria-label={`Edit ${entry.id}`}
          className="min-w-0 flex-1"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      <span
        className={cn(
          "font-mono text-[11px] uppercase tracking-widest",
          approved ? "text-success" : "text-error",
        )}
      >
        {entry.status}
      </span>
      {entry.reason ? <span className="text-[11px] text-text-muted">{entry.reason}</span> : null}
      {draft === null ? (
        <>
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={approved}
            aria-label={`${approved ? "Reject" : "Approve"} ${entry.id}`}
            disabled={busy}
            onClick={() => onStatus(approved ? "rejected" : "approved")}
          >
            {approved ? "Reject" : "Approve"}
          </Button>
          <Button variant="ghost" size="sm" aria-label={`Edit ${entry.id}`} disabled={busy} onClick={() => setDraft(entry.text)}>
            Edit
          </Button>
        </>
      ) : (
        <>
          <Button size="sm" aria-label={`Save ${entry.id}`} disabled={busy || draft.trim() === ""} onClick={() => void save(draft)}>
            Save
          </Button>
          <Button variant="ghost" size="sm" aria-label={`Cancel ${entry.id}`} disabled={busy} onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </>
      )}
    </li>
  );
}

const HEADLINE_AXIS_DROPPED = "No approved headlines — the headline axis was turned off";

export function HeadlinePoolDrawer({
  state,
  dispatch,
  open,
  onClose,
}: {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  open: boolean;
  onClose: () => void;
}) {
  const { briefId, pool } = state;
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [unavailable, setUnavailable] = useState<string | undefined>();
  const currentBrief = useRef(briefId);
  currentBrief.current = briefId;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setUnavailable(undefined);
    setError(undefined);
    getPool(briefId, controller.signal)
      .then((loaded) => {
        if (!cancelled) dispatch({ type: "loadPool", briefId, pool: loaded });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(unknownErrorMessage(cause, "Could not load the headline pool"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [briefId, dispatch, open]);

  const apply = async (change: () => Promise<CopyPool>): Promise<boolean> => {
    // Scope the outcome to the brief that was current when the change started: the
    // reducer already drops a mismatched pool, but the local error and unavailable
    // states would otherwise surface the old brief's failure in the new drawer.
    const forBrief = briefId;
    setBusy(true);
    setError(undefined);
    try {
      dispatch({ type: "setPool", briefId: forBrief, pool: await change() });
      return true;
    } catch (cause) {
      if (currentBrief.current !== forBrief) return false;
      if (isBriefsApiError(cause) && cause.status === 503) setUnavailable(cause.message);
      else setError(unknownErrorMessage(cause, "Headline pool update failed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const entries = pool?.entries ?? [];
  const approved = approvedHeadlines(pool);

  if (!open) return null;

  return (
    <DrawerShell open={open} onClose={onClose} ariaLabel="Headline Pool">
      <DialogHead headingLevel={3}
        title="Headline Pool"
        onClose={onClose}
        closeText="Close"
        className="-mx-4 -mt-4 mb-4"
      />
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Eyebrow as="h4">Headlines ({approved} approved)</Eyebrow>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || loading || unavailable !== undefined}
            isLoading={busy}
            onClick={() => void apply(async () => (await generatePool(toBrief(state))).pool)}
          >
            Generate {POOL_SUGGESTION_COUNT} suggestions
          </Button>
        </div>
        <p className="text-[12px] text-text-muted">
          Approved entries become the <code>headline: {HEADLINE_POOL_REF}</code> axis in the policy section.
        </p>
        {unavailable ? <p className="text-[13px] text-warning">{unavailable}</p> : null}
        {state.headlineAxisDropped ? (
          <p role="status" className="text-[13px] text-warning">
            {HEADLINE_AXIS_DROPPED}
          </p>
        ) : null}
        {error ? <p className="text-[13px] text-error">{error}</p> : null}
        {loading ? (
          // Static blocks plus one spoken sentence: a pulsing skeleton would be a
          // fifth looping animation, and D27 permits exactly four.
          <div className="space-y-2">
            <p role="status" className="text-[13px] text-text-muted">
              Loading headlines…
            </p>
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : entries.length === 0 ? (
          <p className="text-[13px] text-text-muted">No headlines yet.</p>
        ) : (
          <ul className="space-y-2">
            {entries.map((entry) => (
              <PoolEntryRow
                key={entry.id}
                entry={entry}
                busy={busy || loading}
                onStatus={(status) => void apply(() => patchPool(briefId, [{ id: entry.id, status }]))}
                onEdit={(text) => apply(() => patchPool(briefId, [{ id: entry.id, status: entry.status, text }]))}
              />
            ))}
          </ul>
        )}
      </div>
    </DrawerShell>
  );
}
