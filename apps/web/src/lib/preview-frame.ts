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
  return Array.isArray(sources) && sources.some((source) => source === "genai" || source === "asset-pool");
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
): PreviewFrameResult {
  const [frame, setFrame] = useState<PreviewFrameState | null>(null);
  const [failed, setFailed] = useState(false);

  // The request object is stabilized on the cell's VALUES (not object identity),
  // so a parent re-render cannot re-fire the effect for an unchanged look.
  const request = useMemo(
    () => (brief !== undefined && cell !== undefined ? { brief, cell } : null),
    [brief, cell?.productId, cell?.ratio, cell?.layout, cell?.tone, cell?.anchor],
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
  const identity =
    request === null
      ? null
      : [
          request.brief.id,
          request.cell.productId,
          request.cell.ratio,
          request.cell.layout,
          request.cell.tone,
          request.cell.anchor ?? "",
          // The background axis is part of WHAT is previewed: without it, a
          // procedural frame lingers while the caption already says "stand-in".
          (request.brief.variation?.axes?.background?.source ?? []).join(","),
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
