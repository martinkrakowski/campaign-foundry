"use client";

import { useMemo } from "react";
import { API, assetKey, useRun, type Asset } from "@/lib/run-context";
import { cn } from "@/lib/cn";

/** Review grid — the HITL surface where a human approves or rejects creatives. */
export default function GridPage() {
  const { assets, decisions, decide, loading } = useRun();

  const products = useMemo(() => {
    const map = new Map<string, Asset[]>();
    for (const a of assets) map.set(a.productId, [...(map.get(a.productId) ?? []), a]);
    return [...map.entries()];
  }, [assets]);

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
    <div className="flex flex-col gap-10 p-6 pb-40">
      {products.map(([productId, items]) => (
        <section key={productId}>
          <h2 className="mb-4 font-mono text-[11px] uppercase tracking-widest text-text-muted">
            {productId}
          </h2>
          <div className="flex flex-wrap gap-8">
            {items.map((asset) => (
              <Artboard
                key={assetKey(asset)}
                asset={asset}
                decision={decisions[assetKey(asset)]}
                onDecide={(d) => decide(assetKey(asset), d)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Artboard({
  asset,
  decision,
  onDecide,
}: {
  asset: Asset;
  decision?: "approved" | "rejected";
  onDecide: (decision: "approved" | "rejected") => void;
}) {
  return (
    <figure
      className={cn(
        "group flex flex-col items-center gap-3 rounded-xl border p-3 transition-colors",
        decision === "approved"
          ? "border-success/60"
          : decision === "rejected"
            ? "border-error/60"
            : "border-transparent",
      )}
    >
      <div className="flex items-center gap-2 font-mono text-xs text-text-muted">
        <span>{asset.aspectRatio}</span>
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
      </div>

      <div className="relative w-[240px] overflow-hidden rounded border border-border bg-black shadow-2xl">
        {/* Plain <img>: the pipeline serves arbitrarily-sized PNGs via the API proxy. */}
        <img
          src={`${API}/output/${asset.outputPath}`}
          alt={`${asset.productId} ${asset.aspectRatio}`}
          loading="lazy"
          className="block h-auto w-full"
        />

        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-6 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          <a
            href={`${API}/output/${asset.outputPath}`}
            download
            className="w-full rounded-full bg-white py-2 text-center text-sm font-semibold text-black transition-colors hover:bg-gray-200"
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
