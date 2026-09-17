import { useEffect, useMemo, useRef, useState } from "react";
import type { CampaignBrief, PreviewCellSelection } from "@campaignfoundry/CampaignOrchestration";

/** Same path as `briefs-api`'s `API`. Local so this module stays dependency-free. */
const API = "/api/pipeline";

/** Keystrokes must not fire a render per press: the request settles before it is sent. */
export const PREVIEW_FRAME_DEBOUNCE_MS = 300;

/** One rendered frame, as the preview route answers it. */
export interface PreviewFrameState {
  /** `data:image/png;base64,…` — the frame the compositor drew, at the requested ratio. */
  readonly dataUrl: string;
  /** The route's content fingerprint for the frame (`x-preview-frame-cache-key`). */
  readonly cacheKey: string;
}

/**
 * Whether the brief's background axis asks for a generated or pooled source —
 * in which case the preview frame's background is a procedural stand-in, and the
 * caption must say so (D52). Derived from the BRIEF here, never from the cached
 * response: the preview route is procedural-only, so no background source travels
 * in a request. Procedural briefs get no label — their frame IS the real background.
 */
export function briefBackgroundIsStandIn(brief: CampaignBrief): boolean {
  const axes = brief.variation?.axes as { background?: { source?: unknown } } | undefined;
  const sources = axes?.background?.source;
  return (
    Array.isArray(sources) &&
    sources.some((source) => source === "genai" || source === "asset-pool")
  );
}

/**
 * The fetch key (CC2): a stable string built from exactly the parts of `brief`
 * a preview fetch can ever answer differently for — never the object's
 * identity. `toBrief(state)` (`BriefEditor.tsx:589`) builds a new object on
 * every keystroke, so keying on identity fired a request for every field,
 * including ones the server-side compositor never reads
 * (`targetAudience`/`targetRegion` ride the request only as
 * `BackgroundContext`, and the preview route wires `ProceduralBackgroundGenerator`
 * DIRECTLY (D52 credit safety) — it reads only `product.primaryColor`, the
 * ratio and a `paletteShift` this route never sets, so those two fields
 * cannot move a single pixel of the composited frame).
 *
 * Covers both what `PreviewCreativeFrameUseCase.buildCompositeRequest` reads
 * (`PreviewCreativeFrameUseCase.use-case.ts:340-373`) — the previewed
 * product's colour/logo, the message, `style`, `output.platforms` (safe
 * insets) and `template` — and what the DOCK itself reads straight off
 * `brief` beyond the cell (`briefBackgroundIsStandIn`'s axis, for the
 * caption; `output.sizes` and `variation.axes.duration`, for the canvas and
 * scrub range; `copy.timeline`, for a motion cell's per-beat scenes). The
 * cell's own axes (canvas, layout, tone, anchor, motion, durationSec, atSec)
 * are already destructured as separate `useMemo` deps below — this key takes
 * only the previewed PRODUCT's id, not the whole `products` array or the
 * rest of the cell, so a caller that already knows which product (but has no
 * full `PreviewCellSelection` to hand, e.g. `BriefEditor`'s own rail memo)
 * can call it too.
 */
export function previewFetchKey(brief: CampaignBrief, productId: string | undefined): string {
  const product = brief.products.find((candidate) => candidate.id === productId);
  return JSON.stringify({
    product:
      product === undefined
        ? undefined
        : { primaryColor: product.primaryColor, logoPath: product.logoPath },
    message: brief.localizedMessage ?? brief.campaignMessage,
    style: brief.style,
    template: brief.template,
    platforms: brief.output?.platforms,
    sizes: brief.output?.sizes,
    timeline: brief.copy?.timeline,
    backgroundSource: brief.variation?.axes?.background?.source,
    duration: brief.variation?.axes?.duration,
  });
}

function toDataUrl(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // keep each `String.fromCharCode` call under the argument limit
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

async function fetchPreviewFrame(
  brief: CampaignBrief,
  cell: PreviewCellSelection,
  signal: AbortSignal,
): Promise<PreviewFrameState> {
  const res = await fetch(`${API}/campaigns/preview-frame`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brief, cell }),
    signal,
  });
  if (!res.ok) throw new Error(`Preview frame request failed (${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    dataUrl: toDataUrl(bytes),
    // Absent header → an empty key: the frame still renders, it just cannot be identified.
    cacheKey: res.headers.get("x-preview-frame-cache-key") ?? "",
  };
}

export interface PreviewFrameResult {
  /** The latest frame, or `null` while nothing has arrived (the SVG placeholder shows). */
  readonly frame: PreviewFrameState | null;
  /** The last request failed — the SVG placeholder stays, never a broken-image state. */
  readonly failed: boolean;
}

/**
 * The real-frame fetch (D52): debounced, cancellation-aware, and honest about
 * failure. The request is built only when both a brief and a full cell selection
 * exist; every change to either resets to the SVG placeholder, waits out the
 * debounce, then fetches — aborting any in-flight request for superseded looks.
 * An error (or an aborted fetch) leaves the placeholder standing.
 */
export function usePreviewFrame(
  brief: CampaignBrief | undefined,
  cell: PreviewCellSelection | undefined,
  /**
   * Stable identity for a not-yet-saved draft (the editor's `tempId`). A re-slug
   * of `brief.id` is not a switch of creative — the brief has no saved identity
   * yet. Omitted → identity is `brief.id`, so a loaded brief whose id changes
   * still clears.
   */
  identityKey?: string,
): PreviewFrameResult {
  const [frame, setFrame] = useState<PreviewFrameState | null>(null);
  const [failed, setFailed] = useState(false);

  // CC2 — the request is stabilized on the cell's VALUES and on the brief's
  // FETCH KEY (`previewFetchKey`, content, never object identity), so neither
  // a parent re-render nor a keystroke in a field the frame does not read
  // (`targetAudience`, campaign name, …) can re-fire the fetching effect for
  // an unchanged look. `request.brief` below is still whichever `brief`
  // reference is CURRENT when a fetch actually does fire — the key only
  // decides whether to fire, never what a firing request sends.
  const briefFetchKey =
    brief === undefined || cell === undefined ? undefined : previewFetchKey(brief, cell.productId);
  // FI1's identity axis, same value the identity fingerprint below reads:
  // a not-yet-saved draft's live slug (`brief.id`) is NOT a switch of
  // creative (`identityKey`, the stable `tempId`, covers it) — but a real
  // identity change (a different `identityKey`, or a saved brief's `id`
  // changing because a different file loaded) must rebuild `request` even
  // when the fetch key is unchanged, or the synchronous clear below would
  // keep reading the OLD brief's id off a memo that never refreshed.
  const identityAxis = identityKey ?? brief?.id;
  const request = useMemo(
    () => (brief !== undefined && cell !== undefined ? { brief, cell } : null),
    [
      briefFetchKey,
      identityAxis,
      cell?.productId,
      cell?.canvas.ratio,
      cell?.canvas.size,
      cell?.layout,
      cell?.tone,
      cell?.anchor,
      cell?.motion,
      cell?.durationSec,
      cell?.atSec,
      // `brief` itself is deliberately not a dep: `briefFetchKey` and
      // `identityAxis` together are its value-equality proxy.
    ],
  );

  useEffect(() => {
    if (request === null) {
      setFrame(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchPreviewFrame(request.brief, request.cell, controller.signal)
        .then((next) => {
          if (!cancelled) {
            setFrame(next);
            setFailed(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setFrame(null);
            setFailed(true);
          }
        });
    }, PREVIEW_FRAME_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [request]);

  // A stale frame may smooth over a debounce during same-identity edits — but it must
  // never survive a change of WHICH creative is being previewed. Identity is the brief
  // and the cell; a switch clears to the SVG placeholder immediately, while copy and
  // style edits keep the last frame until the fresh one lands (no flicker per keystroke).
  // A new draft's live slug is not that brief: callers pass `identityKey` (tempId)
  // so renaming does not clear. A saved brief still keys on `brief.id`.
  const identity =
    request === null
      ? null
      : [
          identityKey ?? request.brief.id,
          request.cell.productId,
          // The canvas identity is whichever family the spec carries (join
          // renders an absent key as the empty string, as `anchor ?? ""` did).
          request.cell.canvas.ratio ?? request.cell.canvas.size,
          request.cell.layout,
          request.cell.tone,
          request.cell.anchor ?? "",
          // The background axis is part of WHAT is previewed: without it, a
          // procedural frame lingers while the caption already says "stand-in".
          (request.brief.variation?.axes?.background?.source ?? []).join(","),
          request.cell.motion ?? "",
          request.cell.durationSec ?? "",
        ].join("\u0000");
  const lastIdentity = useRef(identity);
  if (identity !== lastIdentity.current) {
    lastIdentity.current = identity;
    if (frame !== null || failed) {
      setFrame(null);
      setFailed(false);
    }
  }

  return { frame, failed };
}
