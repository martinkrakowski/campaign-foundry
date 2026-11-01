/**
 * A video layer's span (VT2): one window of normalised `t` in [0, 1] over
 * which the compositor paints the layer (`2026-10-12_motion-sequence-editor.md`
 * VT-D2 — spans store normalised `t`, never seconds; absence means the whole
 * duration). A video layer holds one span; paint order stays layer-list order.
 */
import type { LayerKind } from "./layer-kinds.js";

export interface VideoSpan {
  readonly startT: number;
  readonly endT: number;
}

/** Why a layer's span is not a shape the brief may carry; undefined when it is. */
export interface VideoSpanProblem {
  /** The span subpath the problem names — `.startT`, `.endT`, or a refused key. */
  readonly path: string;
  /** The requirement, phrased to follow "must" in a `Campaign brief field …` message. */
  readonly must: string;
  /** The offending value, for the message's `got <JSON>` clause. */
  readonly value: unknown;
}

const SPAN_FIELDS = ["startT", "endT"] as const;
const SECONDS_KEYS = ["start", "end", "dur", "startSec", "endSec"] as const;

/**
 * Whether `t` (a normalised frame clock) falls inside `span`, matching the
 * half-open window `beatAt` uses: inside when `startT <= t < endT`, and also
 * at `t === 1` when the span runs to the end. The encoded last frame
 * (`t = 1`) still belongs to a clip that runs to the end.
 */
export function videoSpanCovers(span: VideoSpan, t: number): boolean {
  if (t < span.startT) return false;
  if (t < span.endT) return true;
  return span.endT === 1 && t === 1;
}

/**
 * Whether two spans overlap — the complement of the half-open cover rule. A
 * clip cannot start at `1` because `startT < endT` and `endT <= 1`, so the
 * closed point at `1` does not invent an overlap the half-open test misses.
 */
export function videoSpansOverlap(a: VideoSpan, b: VideoSpan): boolean {
  return a.startT < b.endT && b.startT < a.endT;
}

function unitProblem(value: unknown, path: string): VideoSpanProblem | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return { path, must: "be a finite number in [0, 1]", value };
  }
  return undefined;
}

/**
 * The one span decision both boundaries read (VT2): `isLayerEntry` refuses on
 * a defined problem and the API's `validateTemplate` formats the same problem
 * into its message shape — the two cannot drift. Absent `span` is always
 * fine (the whole duration). Only kind `video` may carry a defined `span`,
 * which must be a non-null, non-array object with exactly `startT` / `endT`,
 * both finite numbers in [0, 1], `startT < endT`. `{ startT: 0, endT: 1 }`
 * is valid at the boundary and is deleted by the editor's canonical form.
 */
export function layerSpanProblem(kind: LayerKind, span: unknown): VideoSpanProblem | undefined {
  if (span === undefined) return undefined;
  if (kind !== "video") {
    return { path: "", must: `be absent for layer kind "${kind}"`, value: span };
  }
  if (typeof span !== "object" || span === null || Array.isArray(span)) {
    return { path: "", must: "be an object", value: span };
  }
  const rec = span as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!(SPAN_FIELDS as readonly string[]).includes(key)) {
      return { path: `.${key}`, must: 'be one of "startT", "endT"', value: rec[key] };
    }
  }
  const start = unitProblem(rec.startT, ".startT");
  if (start !== undefined) return start;
  const end = unitProblem(rec.endT, ".endT");
  if (end !== undefined) return end;
  if ((rec.startT as number) >= (rec.endT as number)) {
    return { path: "", must: "have startT < endT", value: span };
  }
  return undefined;
}

/**
 * The time-shaped keys a video layer may not carry (VT2): an own `spans`
 * property is refused in every case with one must-text — a video layer holds
 * one span, never a list — and an own `start` / `end` / `dur` / `startSec` /
 * `endSec` is a seconds field, refused rather than converted. `layerSpanProblem`
 * owns the `span` object itself; this owns the keys AROUND it, so the two
 * decisions never overlap.
 */
export function layerTimeFieldProblem(
  layer: Record<string, unknown>,
): VideoSpanProblem | undefined {
  if (Object.prototype.hasOwnProperty.call(layer, "spans")) {
    return { path: "spans", must: "be absent; a video layer holds one span", value: layer.spans };
  }
  for (const key of SECONDS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(layer, key)) {
      return {
        path: key,
        must: "be absent; clip time is span.startT and span.endT as normalised t, never seconds",
        value: layer[key],
      };
    }
  }
  return undefined;
}
