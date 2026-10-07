"use client";

import { useState, useEffect, useRef } from "react";
import { Button, ConfirmDialog, DrawerShell, DialogHead, Eyebrow, Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  deleteAsset,
  formatBytes,
  isBriefsApiError,
  listAssets,
  unknownErrorMessage,
  type AssetEntry,
} from "@/lib/briefs-api";
import { refMatchesAsset, isAssetId } from "@/lib/asset-refs";
import * as messages from "@/components/campaign/messages";
export { formatBytes };

/** What a deleted row is remembered by: the id where the backend has one, else the name. */
function keyOf(asset: AssetEntry): string {
  return asset.id !== undefined && isAssetId(asset.id) ? asset.id : asset.name;
}

/** One message per status the delete route answers that the picker words itself. */
function deleteFailureMessage(err: unknown, name: string): string {
  if (isBriefsApiError(err)) {
    if (err.status === 409) return messages.assetDeleteInUse(name);
    if (err.status === 404) return messages.assetDeleteGone(name);
  }
  return unknownErrorMessage(err, messages.assetDeleteFailed);
}

export interface AssetPickerDrawerProps {
  briefId: string;
  open: boolean;
  onClose: () => void;
  onSelect?: (asset: AssetEntry) => void;
  /**
   * Whatever ref the target field currently holds, so the bin can say which of its
   * entries is already chosen.
   *
   * Named for the ref rather than for a path because under the object backend it
   * is an asset id (D203) and matching by path or filename loses the highlight on
   * the very asset the field already has — see `refMatchesAsset`, which is the one
   * place that decides what "already chosen" means.
   */
  selectedRef?: string;
  /**
   * Refs held by other fields of the open draft — none of them may be deleted from
   * the bin, because the route only removes the row and the editor would keep a
   * broken ref with nothing that could resolve it.
   */
  protectedRefs?: readonly string[];
  /**
   * Called once when the server confirmed the asset is gone — deleted by this request,
   * or answered already gone (404) — and only while the drawer still belongs to the
   * campaign the delete was sent for. Lets a caller (the Sidebar's Project Bin) drop the
   * row from its own list without refetching.
   */
  onDeleted?: (asset: AssetEntry) => void;
}

export function AssetPickerDrawer({
  briefId,
  open,
  onClose,
  onSelect,
  selectedRef,
  protectedRefs,
  onDeleted,
}: AssetPickerDrawerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [confirmTarget, setConfirmTarget] = useState<AssetEntry | null>(null);
  const [deletingName, setDeletingName] = useState<string | undefined>();
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const [notice, setNotice] = useState("");
  const [focusTick, setFocusTick] = useState(0);
  // A synchronous latch (the mscyu pattern): `deletingName` is state, so two confirmations
  // inside one render window both reach `runDelete` before the buttons disable.
  const deletingRef = useRef(false);
  // Keys deleted while this drawer is open: every list response is filtered through it, so
  // no response, however late, can bring a deleted row back (the #703 pattern).
  const droppedRef = useRef<Set<string>>(new Set());
  // Bumped when the load effect cleans up (close, or another campaign): a refetch that began
  // before then must not write into the list of the next open.
  const epochRef = useRef(0);
  // A monotonic generation per refetch: a newer refetch superseding an older one in the
  // same open must not be overwritten when the older one lands last.
  const seqRef = useRef(0);
  // The campaign this delete was issued against, read live so a delete that resolves after a
  // campaign switch cannot write the old campaign's rows into the new bin.
  const briefIdRef = useRef(briefId);
  briefIdRef.current = briefId;
  const headingRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    epochRef.current += 1; // a refetch issued while closed must not write into this open
    droppedRef.current.clear();
    setLoading(true);
    setError(undefined);
    setConfirmTarget(null);
    setDeleteError(undefined);
    setNotice("");

    listAssets(briefId, controller.signal)
      .then((res) => {
        if (!cancelled) {
          setAssets(res.assets.filter((asset) => !droppedRef.current.has(keyOf(asset))));
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(unknownErrorMessage(cause, "Could not load assets"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      epochRef.current += 1;
      controller.abort();
    };
  }, [briefId, open]);

  useEffect(() => {
    if (focusTick > 0) headingRef.current?.focus();
  }, [focusTick]);

  /** Best-effort: a failed refetch leaves the list as it is (the row was already removed). */
  const refetch = async () => {
    const epoch = epochRef.current;
    const seq = ++seqRef.current;
    try {
      const next = await listAssets(briefId);
      if (epoch !== epochRef.current || seq !== seqRef.current) return;
      setAssets(next.assets.filter((asset) => !droppedRef.current.has(keyOf(asset))));
    } catch {
      /* the next open of the drawer reloads it */
    }
  };

  /** The asset is gone server-side (deleted by us, or already gone): drop its row, then refetch. */
  const forget = (asset: AssetEntry) => {
    droppedRef.current.add(keyOf(asset));
    setAssets((prev) => prev.filter((candidate) => keyOf(candidate) !== keyOf(asset)));
    void refetch();
  };

  /** The confirmation was accepted: close it, then send exactly one request. */
  const runDelete = (asset: AssetEntry) => {
    setConfirmTarget(null);
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeletingName(asset.name);
    setDeleteError(undefined);
    setNotice("");
    const epoch = epochRef.current;
    void (async () => {
      try {
        await deleteAsset(briefId, asset);
        if (briefIdRef.current !== briefId) return;
        forget(asset);
        onDeleted?.(asset);
        if (epoch !== epochRef.current) return;
        setNotice(messages.assetDeleted(asset.name));
        setFocusTick((tick) => tick + 1);
      } catch (err) {
        if (briefIdRef.current !== briefId) return;
        const gone = isBriefsApiError(err) && err.status === 404;
        if (gone) {
          forget(asset);
          onDeleted?.(asset);
        }
        if (epoch !== epochRef.current) return;
        if (gone) setFocusTick((tick) => tick + 1);
        setDeleteError(deleteFailureMessage(err, asset.name));
      } finally {
        deletingRef.current = false;
        setDeletingName(undefined);
      }
    })();
  };

  if (!open) return null;

  return (
    <>
      <DrawerShell open={open} onClose={onClose} ariaLabel="Asset Bin">
        <DialogHead
          headingLevel={3}
          title="Asset Bin"
          onClose={onClose}
          closeLabel="Close drawer"
          closeText="Close"
          className="-mx-4 -mt-4 mb-4"
        />

        <div className="space-y-3">
          <div ref={headingRef} tabIndex={-1} className="flex items-center justify-between">
            <Eyebrow as="h4">Assets ({assets.length})</Eyebrow>
          </div>
          <p className="text-[12px] text-text-muted">
            Uploaded campaign assets available for logos and product backgrounds.
          </p>

          {notice ? (
            <p role="status" className="text-[12px] text-text-muted">
              {notice}
            </p>
          ) : null}
          {deleteError ? (
            <p role="alert" className="text-[13px] text-error">
              {deleteError}
            </p>
          ) : null}

          {loading ? (
            <div className="space-y-2">
              <p className="text-[13px] text-text-muted" role="status">
                Loading assets…
              </p>
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : error ? (
            <p className="text-[13px] text-error" role="alert">
              {error}
            </p>
          ) : assets.length === 0 ? (
            <p className="text-[13px] text-text-muted">No assets uploaded yet.</p>
          ) : (
            <ul className="space-y-2" aria-label="Asset list">
              {assets.map((asset) => {
                const isSelected = refMatchesAsset(selectedRef, asset, briefId);
                const isProtected = isSelected || (protectedRefs ?? []).some((ref) => refMatchesAsset(ref, asset, briefId));
                const canDelete = !isProtected;
                const displayType = (asset.type ?? "image/png").replace("image/", "").toUpperCase();

                return (
                  <li
                    key={asset.name}
                    className={cn(
                      "flex items-center gap-3 rounded-md border-[1.5px] p-3 text-left transition-all",
                      "motion-safe:hover:-translate-y-px motion-safe:active:scale-[0.98]",
                      isSelected
                        ? "border-brand-primary bg-brand-primary/[0.08]"
                        : "border-border bg-surface-2 hover:border-border-hover",
                    )}
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-surface">
                      {asset.thumbnailUrl ? (
                        <img
                          src={asset.thumbnailUrl}
                          alt={asset.name}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <span className="font-mono text-[10px] text-text-muted">{displayType}</span>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate font-mono text-xs text-text-primary"
                        title={asset.name}
                      >
                        {asset.name}
                      </div>
                      <div className="flex items-center gap-1.5 font-mono text-[10px] text-text-muted">
                        <span className="uppercase tracking-wider text-text-muted">
                          {displayType}
                        </span>
                        <span>·</span>
                        <span>{formatBytes(asset.size ?? 0)}</span>
                      </div>
                    </div>

                    {onSelect ? (
                      <Button
                        variant={isSelected ? "primary" : "secondary"}
                        size="sm"
                        aria-label={`Choose ${asset.name}`}
                        disabled={deletingName === asset.name}
                        onClick={() => {
                          onSelect(asset);
                          onClose();
                        }}
                      >
                        {isSelected ? "Selected" : "Choose"}
                      </Button>
                    ) : (
                      <span
                        className="text-xs text-warning"
                        title="Hero asset"
                        aria-label="Hero asset"
                      >
                        ★
                      </span>
                    )}
                    {canDelete ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={
                          deletingName === asset.name
                            ? undefined
                            : messages.assetDeleteRowLabel(asset.name)
                        }
                        disabled={deletingName !== undefined}
                        onClick={() => setConfirmTarget(asset)}
                      >
                        {deletingName === asset.name
                          ? messages.assetDeletePending
                          : messages.assetDeleteAction}
                      </Button>
                     ) : (
                       <span className="max-w-[9rem] text-[11px] text-text-muted">
                         {isSelected ? messages.assetDeleteSelectedHint : messages.assetDeleteProtectedHint}
                       </span>
                     )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DrawerShell>

      {confirmTarget ? (
        <ConfirmDialog
          open
          title={messages.assetDeleteTitle}
          message={messages.assetDeleteMessage(confirmTarget.name)}
          confirmLabel={messages.assetDeleteConfirm}
          cancelLabel={messages.confirmCancel}
          onConfirm={() => runDelete(confirmTarget)}
          onClose={() => setConfirmTarget(null)}
        />
      ) : null}
    </>
  );
}
