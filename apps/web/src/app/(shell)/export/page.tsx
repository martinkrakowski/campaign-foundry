"use client";

import { useMemo } from "react";
import { API, assetKey, useRun } from "@/lib/run-context";

/** Print export queue — PNG renders and CMYK proof PDFs ready for download. */
export default function ExportPage() {
  const { assets, hasRun } = useRun();

  // One proof PDF is produced per product; dedupe by path.
  const proofs = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of assets) if (a.proofPath) map.set(a.proofPath, a.productId);
    return [...map.entries()];
  }, [assets]);

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

  return (
    <div className="flex h-full flex-col items-start gap-8 p-8 pb-40">
      <h2 className="text-xl font-bold text-white">Print Export Queue</h2>

      <section className="w-full max-w-4xl">
        <h3 className="mb-3 font-mono text-[11px] uppercase tracking-widest text-text-muted">
          Proof PDFs ({proofs.length})
        </h3>
        <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-2xl divide-y divide-border">
          {proofs.map(([path, productId]) => (
            <Row key={path} label={productId} sub={path} href={`${API}/output/${path}`} cta="Download .PDF" />
          ))}
        </div>
      </section>

      <section className="w-full max-w-4xl">
        <h3 className="mb-3 font-mono text-[11px] uppercase tracking-widest text-text-muted">
          Renders ({assets.length})
        </h3>
        <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-2xl divide-y divide-border">
          {assets.map((asset) => (
            <Row
              key={assetKey(asset)}
              label={`${asset.productId} @ ${asset.aspectRatio}`}
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
