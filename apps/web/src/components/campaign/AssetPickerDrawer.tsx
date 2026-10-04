"use client";

import { useState, useEffect } from "react";
import { Button, DrawerShell, DialogHead, Eyebrow, Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatBytes, listAssets, unknownErrorMessage, type AssetEntry } from "@/lib/briefs-api";
import { refMatchesAsset } from "@/lib/asset-refs";
export { formatBytes };

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
}

export function AssetPickerDrawer({
  briefId,
  open,
  onClose,
  onSelect,
  selectedRef,
}: AssetPickerDrawerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [assets, setAssets] = useState<AssetEntry[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);

    listAssets(briefId, controller.signal)
      .then((res) => {
        if (!cancelled) setAssets(res.assets);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(unknownErrorMessage(cause, "Could not load assets"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [briefId, open]);

  if (!open) return null;

  return (
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
        <div className="flex items-center justify-between">
          <Eyebrow as="h4">Assets ({assets.length})</Eyebrow>
        </div>
        <p className="text-[12px] text-text-muted">
          Uploaded campaign assets available for logos and product backgrounds.
        </p>

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
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </DrawerShell>
  );
}
