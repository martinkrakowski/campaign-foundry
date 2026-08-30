"use client";

import { useEffect, useMemo, useState } from "react";
import { API, assetKey, assetLabel, useRun } from "@/lib/run-context";

/** Always-visible PLATFORM_PROFILES (static) — same list as wizard STATIC_PLATFORMS. */
const STATIC_PLATFORMS = ["instagram-feed", "linkedin", "x"] as const;

/**
 * Motion PLATFORM_PROFILES. Offered once the run holds a motion creative: the
 * API only produces those while its ffmpeg probe is on, so the run is the proof.
 */
const MOTION_PLATFORMS = ["instagram-story", "instagram-reel", "tiktok", "youtube-short"] as const;

/** Clip length shown on motion export rows, in whole seconds (the brief's `duration` axis). */
const formatDuration = (seconds: number): string => `${seconds}s`;

/** Print export queue — the HITL-approved creatives + their proofs, ready to ship. */
export default function ExportPage() {
  const {
    assets,
    hasRun,
    decisions,
    brief,
    packages,
    packaging,
    packageError,
    packageSelected,
    loadPackages,
  } = useRun();
  const [platform, setPlatform] = useState<string>(STATIC_PLATFORMS[0]);

  useEffect(() => {
    void loadPackages();
  }, [loadPackages]);

  // Only approved creatives are exported — the HITL gate.
  const approved = useMemo(
    () => assets.filter((a) => decisions[assetKey(a)] === "approved"),
    [assets, decisions],
  );

  // Awaiting review — undecided only (excludes rejected, which aren't "pending").
  const pending = useMemo(
    () => assets.filter((a) => decisions[assetKey(a)] === undefined).length,
    [assets, decisions],
  );

  // Decisions live in the browser, so packaging must be told which creatives passed
  // review. Once the reviewer has decided anything, only approved keys are sent;
  // with no decisions at all the whole run is packaged (the CLI/API default).
  const hasDecisions = pending < assets.length;
  const approvedKeys = useMemo(() => approved.map(assetKey), [approved]);

  // Motion platforms join the picker once the run contains a motion creative.
  const hasMotion = assets.some((a) => a.format === "motion");
  const platforms: readonly string[] = hasMotion ? [...STATIC_PLATFORMS, ...MOTION_PLATFORMS] : STATIC_PLATFORMS;
  // A selection made while a motion platform was visible must not survive a run
  // switch that hides it: nothing hidden is ever packaged, and with no visible
  // selection there is nothing to package.
  const activePlatform = platforms.includes(platform) ? platform : null;

  // One proof PDF per product that has at least one approved creative; dedupe by path.
  const proofs = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of approved) if (a.proofPath) map.set(a.proofPath, a.productId);
    return [...map.entries()];
  }, [approved]);

  if (!hasRun || assets.length === 0) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col p-4 pb-12 sm:p-8">
        <h2 className="mb-6 text-lg font-semibold text-text-emphasis">Print Export Queue</h2>
        <p className="text-text-muted">
          Run the orchestration pipeline to generate PNG renders and CMYK PDF physical proofs.
        </p>
      </div>
    );
  }

  const selected = activePlatform === null ? undefined : packages.find((p) => p.platformId === activePlatform);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-8 p-4 pb-12 sm:p-8">
      {approved.length === 0 ? (
        <div>
          <span className="font-mono text-[11px] uppercase tracking-widest text-text-muted">Export</span>
          <h2 className="mb-6 text-lg font-semibold text-text-emphasis">Print Export Queue</h2>
          <p className="max-w-md text-text-muted">
            No creatives approved yet. Approve creatives in the <span className="text-text-primary">Grid</span>{" "}
            to add them here — only approved creatives are exported ({pending} pending review).
          </p>
        </div>
      ) : (
        <>
          <div>
            <span className="font-mono text-[11px] uppercase tracking-widest text-text-muted">Export</span>
            <h2 className="text-lg font-semibold text-text-emphasis">Print Export Queue</h2>
            <p className="mt-1 text-[13px] text-text-muted">
              {approved.length} of {assets.length} creatives approved for export.
            </p>
          </div>

          <section className="w-full">
            <h3 className="mb-3 font-mono text-[11px] uppercase tracking-widest text-text-muted">
              Proof PDFs ({proofs.length})
            </h3>
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
              {proofs.map(([path, productId]) => (
                <Row key={path} label={productId} sub={path} href={`${API}/output/${path}`} cta="Download .PDF" />
              ))}
            </div>
          </section>

          <section className="w-full">
            <h3 className="mb-3 font-mono text-[11px] uppercase tracking-widest text-text-muted">
              Approved renders ({approved.length})
            </h3>
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
              {approved.map((asset) =>
                asset.videoPath !== undefined ? (
                  <Row
                    key={assetKey(asset)}
                    label={`${assetLabel(asset)}${asset.durationSec !== undefined ? ` · ${formatDuration(asset.durationSec)}` : ""}`}
                    sub={`${asset.videoPath} · poster ${asset.outputPath}`}
                    href={`${API}/output/${asset.videoPath}`}
                    cta="Download .MP4"
                  />
                ) : (
                  <Row
                    key={assetKey(asset)}
                    label={assetLabel(asset)}
                    sub={asset.outputPath}
                    href={`${API}/output/${asset.outputPath}`}
                    cta="Download .PNG"
                  />
                ),
              )}
            </div>
          </section>
        </>
      )}

      <section className="w-full">
        <h2 className="text-lg font-semibold text-text-emphasis">Platform packages</h2>
        <p className="mt-1 text-[13px] text-text-muted">
          Copy already-rendered creatives into per-platform folders. Never re-renders.
        </p>
        {/* Toggle buttons (aria-pressed), not the tabs pattern: the list below is a
            plain section, not a tabpanel, and arrow-key roving would be overkill here. */}
        <div role="group" aria-label="Platforms" className="mt-4 flex flex-wrap gap-2">
          {platforms.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={activePlatform === id}
              onClick={() => setPlatform(id)}
              className={
                activePlatform === id
                  ? "rounded-full border border-brand-primary bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text-emphasis"
                  : "rounded-full border border-border px-3 py-1.5 font-mono text-[12px] text-text-muted"
              }
            >
              {id}
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              activePlatform !== null && void packageSelected([activePlatform], hasDecisions ? approvedKeys : undefined)
            }
            disabled={packaging || activePlatform === null}
            title={activePlatform === null ? "Select a platform first" : undefined}
            className="rounded-full bg-white px-4 py-1.5 text-[13px] font-semibold text-black transition-colors hover:bg-gray-200 disabled:bg-surface-2 disabled:text-text-muted"
          >
            {packaging ? "Packaging…" : "Package"}
          </button>
          {selected ? (
            <a
              href={`${API}/campaigns/packages/${encodeURIComponent(brief.id)}/${selected.platformId}.zip`}
              download
              className="rounded-full border border-border bg-surface-2 px-4 py-1.5 text-[13px] text-text-emphasis transition-colors hover:bg-border-hover"
            >
              Download zip
            </a>
          ) : (
            // No package on disk for this platform yet — the zip route would 404.
            <button
              type="button"
              disabled
              title="Package this platform first"
              className="rounded-full border border-border px-4 py-1.5 text-[13px] text-text-muted disabled:cursor-not-allowed"
            >
              Download zip
            </button>
          )}
        </div>
        {packageError && <p className="mt-2 text-[13px] text-error">{packageError}</p>}
        {selected && selected.items.length > 0 && (
          <div className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
            {selected.items.map((item) => (
              <div
                key={`${item.productId}/${item.aspectRatio}/${item.treatment}/${item.packagedPath}`}
                className="flex items-center justify-between gap-4 p-4"
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-text-primary">
                    {item.productId} @ {item.aspectRatio} · {item.treatment}
                    {item.format === "motion" && item.durationSec !== undefined && ` · ${formatDuration(item.durationSec)}`}
                  </div>
                  <div className="truncate font-mono text-[11px] text-text-muted">{item.packagedPath}</div>
                </div>
                <span className="flex shrink-0 gap-1">
                  <CheckBadge label="size" verdict={item.checks.size} />
                  {item.checks.duration !== undefined && <CheckBadge label="duration" verdict={item.checks.duration} />}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function CheckBadge({ label, verdict }: { label: string; verdict: "pass" | "fail" }) {
  return (
    <span
      title={label}
      className={
        verdict === "pass"
          ? "rounded border border-success/50 bg-success/20 px-2 py-0.5 text-[10px] text-success"
          : "rounded border border-error/50 bg-error/20 px-2 py-0.5 text-[10px] text-error"
      }
    >
      {verdict === "pass" ? "PASS" : "FAIL"}
    </span>
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
        className="shrink-0 rounded-full border border-border bg-surface-2 px-4 py-1.5 text-xs text-text-emphasis transition-colors hover:bg-border-hover"
      >
        {cta}
      </a>
    </div>
  );
}
