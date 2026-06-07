"use client";

import { useEffect, useMemo, useState } from "react";

const API = "/api/pipeline";

// Demo brief (the HITL surface would let a human edit this; kept inline for the first view).
const SAMPLE_BRIEF = {
  id: "summer-hydration-2026",
  targetRegion: "DE",
  targetAudience: "Urban outdoor enthusiasts, 25-40",
  campaignMessage: "Stay wild. Stay hydrated.",
  localizedMessage: "Bleib wild. Bleib hydriert.",
  products: [
    { id: "acme-hydra-bottle", name: "Hydra Bottle", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
    { id: "acme-trail-pack", name: "Trail Pack", primaryColor: "#E0218A", logoPath: "assets/inputs/trail-logo.png" },
  ],
};

interface Asset {
  productId: string;
  aspectRatio: string;
  outputPath: string;
  proofPath?: string;
  complianceScore: number;
  passedCompliance: boolean;
}
interface RunResult {
  halted: boolean;
  assets: Asset[];
  error?: string;
}
type Decision = "approved" | "rejected";

const assetKey = (a: Asset) => `${a.productId}/${a.aspectRatio}`;

export default function GalleryPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the last run (if any) so the gallery isn't empty on refresh.
  useEffect(() => {
    let active = true;
    fetch(`${API}/campaigns/result`)
      .then((r) => r.json() as Promise<RunResult>)
      .then((d) => {
        if (active && d.assets?.length) setAssets(d.assets);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/campaigns/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(SAMPLE_BRIEF),
      });
      const data = (await res.json()) as RunResult;
      if (!res.ok) throw new Error(data.error ?? "Generation failed");
      setAssets(data.assets ?? []);
      setDecisions({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  }

  function decide(key: string, decision: Decision) {
    setDecisions((prev) => {
      const next = { ...prev };
      if (next[key] === decision) delete next[key];
      else next[key] = decision;
      return next;
    });
  }

  const products = useMemo(() => {
    const map = new Map<string, Asset[]>();
    for (const a of assets) map.set(a.productId, [...(map.get(a.productId) ?? []), a]);
    return [...map.entries()];
  }, [assets]);

  const counts = useMemo(() => {
    let approved = 0;
    let rejected = 0;
    for (const a of assets) {
      const d = decisions[assetKey(a)];
      if (d === "approved") approved++;
      else if (d === "rejected") rejected++;
    }
    return { approved, rejected, pending: assets.length - approved - rejected };
  }, [assets, decisions]);

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <h1>Campaign Forge</h1>
          <p>Human-in-the-loop creative review</p>
        </div>
        <div className="actions">
          {assets.length > 0 && (
            <span className="counts">
              {counts.approved} approved · {counts.rejected} rejected · {counts.pending} pending
            </span>
          )}
          <button className="btn" onClick={generate} disabled={loading}>
            {loading ? "Generating…" : assets.length ? "Regenerate" : "Generate creatives"}
          </button>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {assets.length === 0 && !loading && (
        <div className="empty">
          No creatives yet. Click <strong>Generate creatives</strong> to run the pipeline.
        </div>
      )}

      {products.map(([productId, items]) => (
        <section className="product" key={productId}>
          <h2>{productId}</h2>
          <div className="grid">
            {items.map((asset) => {
              const key = assetKey(asset);
              const decision = decisions[key];
              return (
                <figure className={`card ${decision ?? ""}`} key={key}>
                  <div className="thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`${API}/output/${asset.outputPath}`} alt={`${asset.productId} ${asset.aspectRatio}`} loading="lazy" />
                    <span className="ratio">{asset.aspectRatio}</span>
                  </div>
                  <figcaption>
                    <span className={`badge ${asset.passedCompliance ? "ok" : "warn"}`}>
                      {asset.passedCompliance ? "● brand ok" : "▲ low brand"} · {(asset.complianceScore * 100).toFixed(1)}%
                    </span>
                    <div className="decide">
                      <button className={`pill approve ${decision === "approved" ? "on" : ""}`} onClick={() => decide(key, "approved")}>
                        Approve
                      </button>
                      <button className={`pill reject ${decision === "rejected" ? "on" : ""}`} onClick={() => decide(key, "rejected")}>
                        Reject
                      </button>
                    </div>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      ))}
    </main>
  );
}
