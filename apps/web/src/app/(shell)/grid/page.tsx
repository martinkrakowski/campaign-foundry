"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API, assetKey, useRun, type Asset } from "@/lib/run-context";
import { ASPECT_RATIOS } from "@/lib/aspect-ratios";
import { cn } from "@/lib/cn";

/** Rank an aspect ratio by the shared display order. */
const ratioRank = (r: string): number => {
  const i = ASPECT_RATIOS.indexOf(r as (typeof ASPECT_RATIOS)[number]);
  return i === -1 ? ASPECT_RATIOS.length : i;
};

/** Creative image URL, cache-busted per run (runs overwrite the same paths). */
const assetSrc = (a: Asset, version: number): string =>
  `${API}/output/${a.outputPath}?v=${version}`;

/** Review grid — the HITL surface where a human approves or rejects creatives. */
export default function GridPage() {
  const { assets, decisions, decide, loading, assetVersion, regeneratingKeys } = useRun();
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const closePreview = useCallback(() => setPreviewKey(null), []);
  // Derive the previewed asset from the live list (not a snapshot), so its
  // compliance/logo metadata can never go stale against the cache-busted image; if
  // a run replaces or removes it, the lookup returns null and the modal closes.
  const previewAsset = useMemo(
    /* istanbul ignore next -- the loading effect clears previewKey before assets change, so find() always hits */
    () => (previewKey ? (assets.find((a) => assetKey(a) === previewKey) ?? null) : null),
    [previewKey, assets],
  );
  // Close the modal when a run starts so it never shows mid-regeneration metadata.
  useEffect(() => {
    if (loading) setPreviewKey(null);
  }, [loading]);

  // Pivot: product → ratio → [treatment variants]. The matrix is the story —
  // each ratio slot shows its treatments side-by-side for direct comparison.
  const products = useMemo(() => {
    const byProduct = new Map<string, Map<string, Asset[]>>();
    for (const a of assets) {
      const ratios = byProduct.get(a.productId) ?? new Map<string, Asset[]>();
      ratios.set(a.aspectRatio, [...(ratios.get(a.aspectRatio) ?? []), a]);
      byProduct.set(a.productId, ratios);
    }
    return [...byProduct.entries()].map(([productId, ratios]) => ({
      productId,
      ratios: [...ratios.entries()].sort((a, b) => ratioRank(a[0]) - ratioRank(b[0])),
    }));
  }, [assets]);

  const review = useMemo(() => {
    let approved = 0;
    let rejected = 0;
    for (const a of assets) {
      const d = decisions[assetKey(a)];
      if (d === "approved") approved += 1;
      else if (d === "rejected") rejected += 1;
    }
    return { approved, rejected, pending: assets.length - approved - rejected };
  }, [assets, decisions]);

  if (assets.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <h2 className="mb-2 text-[22px] font-bold text-white">Start orchestrating assets</h2>
        <p className="max-w-md text-[13px] text-text-muted">
          {loading
            ? "Running the pipeline — resolving assets, compositing brand layers, and checking compliance…"
            : "Execute the pipeline below to resolve missing assets, composite brand layers, and run brand-compliance checks."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-12 p-6 pb-40">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-surface px-4 py-2 font-mono text-[11px]">
        <span className="uppercase tracking-wider text-text-muted">Review</span>
        <span className="text-success">✓ {review.approved} approved</span>
        <span className="text-error">✗ {review.rejected} rejected</span>
        <span className="text-text-muted">○ {review.pending} pending</span>
        <span className="ml-auto hidden text-text-muted md:inline">
          Approved creatives are what the Export tab ships.
        </span>
      </div>
      {products.map(({ productId, ratios }) => (
        <section key={productId}>
          <h2 className="mb-5 font-mono text-[11px] uppercase tracking-widest text-text-muted">
            {productId}
          </h2>
          <div className="flex flex-col gap-8">
            {ratios.map(([ratio, items]) => (
              <div key={ratio}>
                <h3 className="mb-3 font-mono text-[11px] text-text-muted">{ratio}</h3>
                <div className="flex flex-wrap justify-center gap-6">
                  {items.map((asset) => (
                    <Artboard
                      key={assetKey(asset)}
                      asset={asset}
                      version={assetVersion}
                      loading={
                        loading &&
                        (regeneratingKeys === null || regeneratingKeys.has(assetKey(asset)))
                      }
                      decision={decisions[assetKey(asset)]}
                      onDecide={(d) => decide(assetKey(asset), d)}
                      onPreview={() => setPreviewKey(assetKey(asset))}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {previewAsset && (
        <PreviewModal asset={previewAsset} version={assetVersion} onClose={closePreview} />
      )}
    </div>
  );
}

function ComplianceBadge({ asset }: { asset: Asset }) {
  return (
    <>
      <span
        className={cn(
          "rounded border px-1.5 py-0.5 text-[10px]",
          asset.passedCompliance
            ? "border-success/50 bg-success/20 text-success"
            : "border-warning/50 bg-warning/20 text-warning",
        )}
      >
        {asset.passedCompliance ? "PASS" : "LOW"} {(asset.complianceScore * 100).toFixed(1)}%
      </span>
      <span
        className={cn(
          "rounded border px-1.5 py-0.5 text-[10px]",
          asset.logoApplied
            ? "border-success/50 bg-success/20 text-success"
            : "border-error/50 bg-error/20 text-error",
        )}
      >
        {asset.logoApplied ? "LOGO" : "NO LOGO"}
      </span>
    </>
  );
}

const SOURCE_BADGE: Record<Asset["backgroundSource"], { label: string; cls: string }> = {
  firefly: { label: "FIREFLY", cls: "border-brand-primary/50 bg-brand-primary/20 text-brand-primary" },
  imagen: { label: "IMAGEN", cls: "border-info/50 bg-info/20 text-info" },
  openrouter: { label: "OPENROUTER", cls: "border-info/50 bg-info/20 text-info" },
  procedural: { label: "FALLBACK", cls: "border-warning/50 bg-warning/20 text-warning" },
  reused: { label: "REUSED", cls: "border-success/50 bg-success/20 text-success" },
};

/** Background provenance — makes the graceful GenAI fallback visible in review. */
function SourceBadge({ source }: { source: Asset["backgroundSource"] }) {
  const { label, cls } = SOURCE_BADGE[source];
  return (
    <span
      className={cn("rounded border px-1.5 py-0.5 text-[10px]", cls)}
      title={
        source === "procedural"
          ? "Background: procedural (Imagen unavailable — graceful fallback)"
          : `Background: ${source}`
      }
    >
      {label}
    </span>
  );
}

function Artboard({
  asset,
  version,
  loading,
  decision,
  onDecide,
  onPreview,
}: {
  asset: Asset;
  version: number;
  loading: boolean;
  decision?: "approved" | "rejected";
  onDecide: (decision: "approved" | "rejected") => void;
  onPreview: () => void;
}) {
  return (
    <figure
      className={cn(
        // Surface tile matching the sidebar; only the border colour signals the
        // review decision (green = approved, red = rejected), default = sidebar border.
        "group flex flex-col items-center gap-3 rounded-xl border bg-surface p-3 transition-colors",
        decision === "approved"
          ? "border-success"
          : decision === "rejected"
            ? "border-error"
            : "border-border",
      )}
    >
      <div className="flex items-center gap-2 font-mono text-xs text-text-muted">
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-primary">
          {asset.treatment}
        </span>
        <SourceBadge source={asset.backgroundSource} />
        <ComplianceBadge asset={asset} />
      </div>

      <div className="relative w-[240px] overflow-hidden rounded border border-border bg-black shadow-2xl">
        {/* Plain <img>: the pipeline serves arbitrarily-sized PNGs via the API proxy. */}
        <img
          src={assetSrc(asset, version)}
          alt={`${asset.productId} ${asset.aspectRatio} ${asset.treatment}`}
          loading="lazy"
          className="block h-auto w-full"
        />

        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-6 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={onPreview}
            className="w-full rounded-full bg-white py-2 text-center text-sm font-semibold text-black transition-colors hover:bg-gray-200"
          >
            Preview
          </button>
          <a
            href={assetSrc(asset, version)}
            download
            className="w-full rounded-full border border-border bg-surface-2 py-2 text-center text-sm text-white transition-colors hover:bg-border-hover"
          >
            Download .PNG
          </a>
          {asset.proofPath && (
            <a
              href={`${API}/output/${asset.proofPath}`}
              download
              className="w-full rounded-full border border-border bg-surface-2 py-2 text-center text-sm text-white transition-colors hover:bg-border-hover"
            >
              Print Proof (.PDF)
            </a>
          )}
        </div>

        {/* Regeneration indicator — shown over each creative while a run is in flight. */}
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/60 backdrop-blur-sm">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-white border-t-transparent" />
            <span className="text-[11px] font-medium text-white">Regenerating…</span>
          </div>
        )}
      </div>

      <figcaption className="flex gap-2">
        <button
          type="button"
          onClick={() => onDecide("approved")}
          className={cn(
            "rounded-full border px-4 py-1 text-xs font-medium transition-colors",
            decision === "approved"
              ? "border-success bg-success/20 text-success"
              : "border-border text-text-muted hover:text-white",
          )}
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => onDecide("rejected")}
          className={cn(
            "rounded-full border px-4 py-1 text-xs font-medium transition-colors",
            decision === "rejected"
              ? "border-error bg-error/20 text-error"
              : "border-border text-text-muted hover:text-white",
          )}
        >
          Reject
        </button>
      </figcaption>
    </figure>
  );
}

/** Full-size creative preview. Closes on backdrop click, the × button, or Escape. */
function PreviewModal({
  asset,
  version,
  onClose,
}: {
  asset: Asset;
  version: number;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Modal focus management: move focus in on open, trap Tab inside, restore on close.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, [tabindex]:not([tabindex="-1"])',
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
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/80 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${asset.productId} ${asset.aspectRatio} ${asset.treatment} preview`}
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close preview"
        className="absolute right-6 top-6 text-text-muted transition-colors hover:text-white"
      >
        <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      <img
        src={assetSrc(asset, version)}
        alt={`${asset.productId} ${asset.aspectRatio} ${asset.treatment}`}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] max-w-[90vw] rounded-lg border border-border object-contain shadow-2xl"
      />

      <div
        className="flex items-center gap-2 font-mono text-xs text-text-muted"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-text-primary">
          {asset.productId} · {asset.aspectRatio} · {asset.treatment}
        </span>
        <SourceBadge source={asset.backgroundSource} />
        <ComplianceBadge asset={asset} />
      </div>
    </div>
  );
}
