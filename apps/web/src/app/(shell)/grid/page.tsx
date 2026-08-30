"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { API, assetKey, assetLabel, useRun, type Asset } from "@/lib/run-context";
import { ASPECT_RATIOS } from "@/lib/aspect-ratios";
import { cn } from "@/lib/cn";
import { descriptorBeats, descriptorHeadline } from "@/components/campaign/messages";

/** Rank an aspect ratio by the shared display order. */
const ratioRank = (r: string): number => {
  const i = ASPECT_RATIOS.indexOf(r as (typeof ASPECT_RATIOS)[number]);
  return i === -1 ? ASPECT_RATIOS.length : i;
};

/** Creative image URL, cache-busted per run (runs overwrite the same paths). */
const assetSrc = (a: Asset, version: number): string =>
  `${API}/output/${a.outputPath}?v=${version}`;

/** Motion clip URL (same cache-buster); the PNG above is its poster. */
const videoSrc = (a: Asset & { videoPath: string }, version: number): string =>
  `${API}/output/${a.videoPath}?v=${version}`;

const isMotion = (a: Asset): a is Asset & { videoPath: string } => typeof a.videoPath === "string";

/**
 * Start playback; resolves true once the browser has actually started playing and
 * false when it refused (autoplay policy, unsupported source). Older engines
 * return nothing from `play()` — treat that as started.
 */
const startPlayback = async (video: HTMLVideoElement): Promise<boolean> => {
  const pending = video.play();
  if (pending === undefined) return true;
  try {
    await pending;
    return true;
  } catch {
    return false;
  }
};

const stopPlayback = (video: HTMLVideoElement): void => {
  video.pause();
  video.currentTime = 0;
};

const PAGE_SIZE = 24;

const formatOf = (a: Asset): "static" | "motion" => a.format ?? "static";

const uniqueSorted = (values: string[]): string[] => [...new Set(values)].sort();

const TILE_CLASS = "relative w-[240px] overflow-hidden rounded border border-border bg-black shadow-2xl";

interface GridFilters {
  product: string;
  ratio: string;
  format: string;
  layout: string;
  tone: string;
  background: string;
  page: number;
}

const DEFAULT_FILTERS: GridFilters = {
  product: "",
  ratio: "",
  format: "",
  layout: "",
  tone: "",
  background: "",
  page: 1,
};

/** A stored filter value only applies while it is one of the current options; otherwise it is "All". */
const effective = (value: string, options: string[]): string => (options.includes(value) ? value : "");

/** Review grid — the HITL surface where a human approves or rejects creatives. */
export default function GridPage() {
  const { brief, assets, decisions, decide, loading, assetVersion, regeneratingKeys } = useRun();
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  // Filters and the page belong to one brief + run: a brief switch or a new run
  // (assetVersion bump) drops them back to defaults instead of hiding the new
  // creatives behind a stale selection. Keyed state, so no reset effect is needed.
  const filtersKey = `${brief.id}:${assetVersion}`;
  const [filterState, setFilterState] = useState({ key: filtersKey, filters: DEFAULT_FILTERS });
  const filters = filterState.key === filtersKey ? filterState.filters : DEFAULT_FILTERS;
  const updateFilters = useCallback(
    (patch: Partial<GridFilters>) =>
      setFilterState((prev) => ({
        key: filtersKey,
        filters: { ...(prev.key === filtersKey ? prev.filters : DEFAULT_FILTERS), ...patch },
      })),
    [filtersKey],
  );
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

  const hasDescriptors = assets.some((a) => a.descriptor);

  const filterOptions = useMemo(
    () => ({
      products: uniqueSorted(assets.map((a) => a.productId)),
      ratios: uniqueSorted(assets.map((a) => a.aspectRatio)),
      formats: uniqueSorted(assets.map((a) => formatOf(a))),
      // A descriptor that lost a field to normalisation contributes no option for it —
      // `flatMap` over `?? []` drops it rather than offering an "undefined" filter.
      layouts: uniqueSorted(assets.flatMap((a) => (a.descriptor?.layout ? [a.descriptor.layout] : []))),
      tones: uniqueSorted(assets.flatMap((a) => (a.descriptor?.tone ? [a.descriptor.tone] : []))),
      backgrounds: uniqueSorted(
        assets.flatMap((a) => (a.descriptor?.backgroundSource ? [a.descriptor.backgroundSource] : [])),
      ),
    }),
    [assets],
  );

  const applyFilter =
    (name: keyof Omit<GridFilters, "page">) =>
    (value: string) =>
      updateFilters({ [name]: value, page: 1 });

  // Each select's effective value is checked against the live options, so a value
  // that no longer exists (e.g. a product missing from the new run) acts as "All".
  const productFilter = effective(filters.product, filterOptions.products);
  const ratioFilter = effective(filters.ratio, filterOptions.ratios);
  const formatFilter = effective(filters.format, filterOptions.formats);
  const layoutFilter = effective(filters.layout, filterOptions.layouts);
  const toneFilter = effective(filters.tone, filterOptions.tones);
  const backgroundFilter = effective(filters.background, filterOptions.backgrounds);
  const page = filters.page;

  const filtered = useMemo(
    () =>
      assets.filter((a) => {
        if (productFilter && a.productId !== productFilter) return false;
        if (ratioFilter && a.aspectRatio !== ratioFilter) return false;
        if (formatFilter && formatOf(a) !== formatFilter) return false;
        if (layoutFilter && a.descriptor?.layout !== layoutFilter) return false;
        if (toneFilter && a.descriptor?.tone !== toneFilter) return false;
        if (backgroundFilter && a.descriptor?.backgroundSource !== backgroundFilter) return false;
        return true;
      }),
    [assets, productFilter, ratioFilter, formatFilter, layoutFilter, toneFilter, backgroundFilter],
  );

  const visible = filtered.slice(0, page * PAGE_SIZE);
  const canShowMore = visible.length < filtered.length;

  // Pivot: product → ratio → [treatment variants]. The matrix is the story —
  // each ratio slot shows its treatments side-by-side for direct comparison.
  const products = useMemo(() => {
    const byProduct = new Map<string, Map<string, Asset[]>>();
    for (const a of visible) {
      const ratios = byProduct.get(a.productId) ?? new Map<string, Asset[]>();
      ratios.set(a.aspectRatio, [...(ratios.get(a.aspectRatio) ?? []), a]);
      byProduct.set(a.productId, ratios);
    }
    return [...byProduct.entries()].map(([productId, ratios]) => ({
      productId,
      ratios: [...ratios.entries()].sort((a, b) => ratioRank(a[0]) - ratioRank(b[0])),
    }));
  }, [visible]);

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
        <h2 className="mb-2 text-lg font-semibold text-text-emphasis">Start orchestrating assets</h2>
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
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2">
        <FilterSelect
          label="Product"
          value={productFilter}
          options={filterOptions.products}
          onChange={applyFilter("product")}
        />
        <FilterSelect
          label="Ratio"
          value={ratioFilter}
          options={filterOptions.ratios}
          onChange={applyFilter("ratio")}
        />
        <FilterSelect
          label="Format"
          value={formatFilter}
          options={filterOptions.formats}
          onChange={applyFilter("format")}
        />
        {hasDescriptors && (
          <>
            <FilterSelect
              label="Layout"
              value={layoutFilter}
              options={filterOptions.layouts}
              onChange={applyFilter("layout")}
            />
            <FilterSelect
              label="Tone"
              value={toneFilter}
              options={filterOptions.tones}
              onChange={applyFilter("tone")}
            />
            <FilterSelect
              label="Background source"
              value={backgroundFilter}
              options={filterOptions.backgrounds}
              onChange={applyFilter("background")}
            />
          </>
        )}
        <span className="ml-auto font-mono text-[11px] text-text-muted">
          Showing {visible.length} of {filtered.length}
        </span>
      </div>
      {products.length === 0 ? (
        <p className="text-[13px] text-text-muted">No creatives match the current filters.</p>
      ) : (
        products.map(({ productId, ratios }) => (
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
        ))
      )}

      {canShowMore && (
        <button
          type="button"
          onClick={() => updateFilters({ page: page + 1 })}
          className="self-center rounded-full border border-border bg-surface px-5 py-2 text-[13px] text-text-primary transition-colors hover:bg-border-hover"
        >
          Show more
        </button>
      )}

      {previewAsset && (
        <PreviewModal asset={previewAsset} version={assetVersion} onClose={closePreview} />
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 font-mono text-[11px] text-text-muted">
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-border bg-surface-2 px-2 py-1 text-text-primary"
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function DescriptorChip({
  children,
  title,
  className,
}: {
  children: string;
  /** Hover text when the chip's own content is clipped. */
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted",
        className,
      )}
    >
      {children}
    </span>
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
  // Hover actions + the in-flight indicator, shared by the still and motion tiles. The
  // motion tile keeps the scrim light so the clip stays visible while it plays.
  const overlay = (
    <>
      <div
        className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 opacity-0 transition-opacity group-hover:opacity-100",
          isMotion(asset) ? "bg-black/40" : "bg-black/80 backdrop-blur-sm",
        )}
      >
        <button
          type="button"
          onClick={onPreview}
          className="w-full rounded-full bg-white py-2 text-center text-sm font-semibold text-black transition-colors hover:bg-gray-200"
        >
          Preview
        </button>
        {isMotion(asset) && (
          <a
            href={videoSrc(asset, version)}
            download
            className="w-full rounded-full border border-border bg-surface-2 py-2 text-center text-sm text-text-emphasis transition-colors hover:bg-border-hover"
          >
            Download .MP4
          </a>
        )}
        <a
          href={assetSrc(asset, version)}
          download
          className="w-full rounded-full border border-border bg-surface-2 py-2 text-center text-sm text-text-emphasis transition-colors hover:bg-border-hover"
        >
          {isMotion(asset) ? "Download poster .PNG" : "Download .PNG"}
        </a>
        {asset.proofPath && (
          <a
            href={`${API}/output/${asset.proofPath}`}
            download
            className="w-full rounded-full border border-border bg-surface-2 py-2 text-center text-sm text-text-emphasis transition-colors hover:bg-border-hover"
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
    </>
  );

  return (
    <figure
      className={cn(
        // Surface tile matching the sidebar; only the border colour signals the
        // review decision (green = approved, red = rejected), default = sidebar border.
        // content-visibility skips offscreen paint at N=100 without a virtualization lib.
        "group flex flex-col items-center gap-3 rounded-xl border bg-surface p-3 transition-colors [contain-intrinsic-size:280px_400px] [content-visibility:auto]",
        decision === "approved"
          ? "border-success"
          : decision === "rejected"
            ? "border-error"
            : "border-border",
      )}
    >
      <div className="flex items-center gap-2 font-mono text-xs text-text-muted">
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-primary">
          {assetLabel(asset)}
        </span>
        {asset.descriptor && (
          <>
            {/* Each chip renders only what survived normalisation. An absent field is a
                chip that is not there, never an empty pill. */}
            {asset.descriptor.layout !== undefined && (
              <DescriptorChip>{asset.descriptor.layout}</DescriptorChip>
            )}
            {asset.descriptor.tone !== undefined && (
              <DescriptorChip>{asset.descriptor.tone}</DescriptorChip>
            )}
            {asset.descriptor.backgroundSource !== undefined && (
              <DescriptorChip>{asset.descriptor.backgroundSource}</DescriptorChip>
            )}
            {typeof asset.descriptor.paletteShift === "number" && (
              <DescriptorChip>{`shift ${asset.descriptor.paletteShift}`}</DescriptorChip>
            )}
            {asset.descriptor.motion !== undefined && (
              <DescriptorChip>{`${asset.descriptor.motion} · ${asset.descriptor.durationSec ?? asset.durationSec ?? "?"}s`}</DescriptorChip>
            )}
            {typeof asset.descriptor.beats === "number" && (
              <DescriptorChip>{descriptorBeats(asset.descriptor.beats)}</DescriptorChip>
            )}
            {typeof asset.descriptor.headline === "string" && (
              // Every other chip in this row is a short enum — a layout, a tone, a motion
              // kind. A pooled headline is arbitrary author text with no length limit, and
              // the row does not wrap, so an unbounded chip stretches the tile past its
              // artboard and breaks the grid. Bound it and keep the full text on hover.
              <DescriptorChip
                title={asset.descriptor.headline}
                className="max-w-[10rem] truncate"
              >
                {descriptorHeadline(asset.descriptor.headline)}
              </DescriptorChip>
            )}
          </>
        )}
        <SourceBadge source={asset.backgroundSource} />
        <ComplianceBadge asset={asset} />
      </div>

      {isMotion(asset) ? (
        <MotionCell asset={asset} version={version}>
          {overlay}
        </MotionCell>
      ) : (
        <div className={TILE_CLASS}>
          {/* Plain <img>: the pipeline serves arbitrarily-sized PNGs via the API proxy. */}
          <img
            src={assetSrc(asset, version)}
            alt={assetLabel(asset)}
            loading="lazy"
            className="block h-auto w-full"
          />
          {overlay}
        </div>
      )}

      <figcaption className="flex gap-2">
        <button
          type="button"
          onClick={() => onDecide("approved")}
          className={cn(
            "rounded-full border px-4 py-1 text-xs font-medium transition-colors",
            decision === "approved"
              ? "border-success bg-success/20 text-success"
              : "border-border text-text-muted hover:text-text-emphasis",
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
              : "border-border text-text-muted hover:text-text-emphasis",
          )}
        >
          Reject
        </button>
      </figcaption>
    </figure>
  );
}

/**
 * Motion cell: the poster shows until the reviewer hovers (or presses the play
 * control, for keyboard users); leaving the tile rewinds. Muted and
 * `preload="metadata"` so a 100-cell grid does not pull 100 clips.
 */
function MotionCell({
  asset,
  version,
  children,
}: {
  asset: Asset & { videoPath: string };
  version: number;
  children: ReactNode;
}) {
  // The element arrives through a callback ref, so the controls exist only once
  // it is mounted (the first render has none) — no null guard on every handler.
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playFailed, setPlayFailed] = useState(false);
  const label = assetLabel(asset);

  // `playing` flips only once `play()` has resolved, so a refused playback keeps
  // the play control (and shows why) instead of a pause control over a still poster.
  const controls =
    video === null
      ? undefined
      : {
          play: () => {
            void startPlayback(video).then((started) => {
              setPlaying(started);
              setPlayFailed(!started);
            });
          },
          stop: () => {
            stopPlayback(video);
            setPlaying(false);
          },
        };

  return (
    <div className={TILE_CLASS} onMouseEnter={controls?.play} onMouseLeave={controls?.stop}>
      <video
        ref={setVideo}
        src={videoSrc(asset, version)}
        poster={assetSrc(asset, version)}
        muted
        loop
        playsInline
        preload="metadata"
        aria-label={label}
        className="block h-auto w-full"
      />
      {children}
      {playFailed && !playing && (
        <span
          role="status"
          className="absolute bottom-2 left-2 z-20 rounded border border-error/50 bg-black/70 px-2 py-1 font-mono text-[10px] text-error"
        >
          can&apos;t play
        </span>
      )}
      <button
        type="button"
        onClick={playing ? controls?.stop : controls?.play}
        aria-pressed={playing}
        aria-label={`${playing ? "Pause" : "Play"} ${label}`}
        className="absolute bottom-2 right-2 z-20 rounded-full border border-border bg-black/70 px-2 py-1 font-mono text-[10px] text-white"
      >
        {playing ? "❚❚" : "▶"} {asset.durationSec !== undefined ? `${asset.durationSec}s` : "clip"}
      </button>
    </div>
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
      aria-label={`${assetLabel(asset)} preview`}
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

      {isMotion(asset) ? (
        <video
          src={videoSrc(asset, version)}
          poster={assetSrc(asset, version)}
          controls
          autoPlay
          muted
          loop
          playsInline
          aria-label={assetLabel(asset)}
          onClick={(e) => e.stopPropagation()}
          className="max-h-[85vh] max-w-[90vw] rounded-lg border border-border object-contain shadow-2xl"
        />
      ) : (
        <img
          src={assetSrc(asset, version)}
          alt={assetLabel(asset)}
          onClick={(e) => e.stopPropagation()}
          className="max-h-[85vh] max-w-[90vw] rounded-lg border border-border object-contain shadow-2xl"
        />
      )}

      <div
        className="flex items-center gap-2 font-mono text-xs text-text-muted"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-text-primary">
          {assetLabel(asset)}
        </span>
        <SourceBadge source={asset.backgroundSource} />
        <ComplianceBadge asset={asset} />
      </div>
    </div>
  );
}
