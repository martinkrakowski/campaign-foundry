"use client";

import { useMemo } from "react";
import { API, assetKey, useRun } from "@/lib/run-context";

/** Print export queue — the HITL-approved creatives + their proofs, ready to ship. */
export default function ExportPage() {
  const { assets, hasRun, decisions } = useRun();

  // Only approved creatives are exported — the HITL gate.
  const approved = useMemo(
    () => assets.filter((a) => decisions[assetKey(a)] === "approved"),
    [assets, decisions],
  );

  // One proof PDF per product that has at least one approved creative; dedupe by path.
  const proofs = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of approved) if (a.proofPath) map.set(a.proofPath, a.productId);
    return [...map.entries()];
  }, [approved]);

  if (!hasRun || assets.length === 0) {
    return (
      <div className="flex h-full flex-col items-start p-8 pb-40">
        <h2 className="mb-6 text-xl font-bold text-white">Print Export Queue</h2>
        <p className="text-text-muted">
          Run the orchestration pipeline to generate PNG renders and CMYK PDF physical proofs.
        </p>
      </div>
    );
  }

  if (approved.length === 0) {
    return (
      <div className="flex h-full flex-col items-start p-8 pb-40">
        <h2 className="mb-6 text-xl font-bold text-white">Print Export Queue</h2>
        <p className="max-w-md text-text-muted">
          No creatives approved yet. Approve creatives in the <span className="text-text-primary">Grid</span> to
          add them here — only approved creatives are exported ({assets.length} pending review).
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-start gap-8 p-8 pb-40">
      <div>
        <h2 className="text-xl font-bold text-white">Print Export Queue</h2>
        <p className="mt-1 text-[13px] text-text-muted">
          {approved.length} of {assets.length} creatives approved for export.
        </p>
      </div>

      <section className="w-full max-w-4xl">
        <h3 className="mb-3 font-mono text-[11px] uppercase tracking-widest text-text-muted">
          Proof PDFs ({proofs.length})
        </h3>
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
          {proofs.map(([path, productId]) => (
            <Row key={path} label={productId} sub={path} href={`${API}/output/${path}`} cta="Download .PDF" />
          ))}
        </div>
      </section>

      <section className="w-full max-w-4xl">
        <h3 className="mb-3 font-mono text-[11px] uppercase tracking-widest text-text-muted">
          Approved renders ({approved.length})
        </h3>
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
          {approved.map((asset) => (
            <Row
              key={assetKey(asset)}
              label={`${asset.productId} @ ${asset.aspectRatio} · ${asset.treatment}`}
              sub={asset.outputPath}
              href={`${API}/output/${asset.outputPath}`}
              cta="Download .PNG"
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function Row({ label, sub, href, cta }: { label: string; sub: string; href: string; cta: string }) {
  return (
    <div className="flex items-center justify-between gap-4 p-4">
      <div className="min-w-0">
        <div className="truncate text-[13px] text-text-primary">{label}</div>
        <div className="truncate font-mono text-[11px] text-text-muted">{sub}</div>
      </div>
      <a
        href={href}
        download
        className="shrink-0 rounded-full border border-border bg-surface-2 px-4 py-1.5 text-xs text-white transition-colors hover:bg-border-hover"
      >
        {cta}
      </a>
    </div>
  );
}
