/**
 * Keyframe tracks (K1, K-D7–K-D9): the track model that lets a preset expand
 * into keyframes (K2/K3) and a user author one directly (K4). This lane
 * (K1a) ships the value objects and the boundary validation only — no
 * resolver and no compositor caller (K1b).
 *
 * A track binds one layer to one animatable property and a list of stops;
 * the layer is implicit by nesting (`layers[i].tracks`, K-D4's one
 * addressing scheme) — a track carries no `layer` field of its own, which is
 * the second addressing scheme the plan refuses. `Stop.clock` names which of
 * three clocks a stop's `t` is measured in (K-D8): `pose` reads the
 * whole-creative `t`, `beat` a beat-local progress a copy timeline derives,
 * and `effect` the text-effect clock (falling back to the beat-local one
 * with no timeline). Two stops in one track may share a numeric `t` on
 * different clocks — they are independent axes — but not on the same one.
 *
 * Two tracks may target the same (layer, property): each property fixes how
 * its tracks combine (`dx`/`dy` sum, `opacity`/`scale` multiply, in
 * declaration order), and that composition is never refused here.
 */
import type { EasingKind } from "./easing.js";
import { EASING_KINDS } from "./easing.js";
import type { LayerKind } from "./layer-kinds.js";

/** A track's animatable properties (§1): exactly what the compositor moves today. */
export const TRACK_PROPERTIES = ["opacity", "scale", "dx", "dy"] as const;

export type TrackProperty = (typeof TRACK_PROPERTIES)[number];

/** A stop's clock vocabulary (K-D8): which moment its `t` names. */
export const STOP_CLOCKS = ["pose", "beat", "effect"] as const;

export type StopClock = (typeof STOP_CLOCKS)[number];

/**
 * One point on a track (K-D8): `t` in [0, 1] of its own `clock`, the value
 * the property takes there, and an optional easing override — absent means
 * the domain default (`easeOutCubic`, K-D7).
 */
export interface Stop {
  readonly t: number;
  readonly value: number;
  readonly easing?: EasingKind;
  readonly clock: StopClock;
}

/** One animatable property on a layer and its stops, in declaration order. */
export interface Track {
  readonly property: TrackProperty;
  readonly stops: readonly Stop[];
}

/**
 * The layer kinds a track may nest on: every kind this compositor draws
 * through its own `LAYER_DRAWERS` entry, minus `html`. `html` renders through
 * two independent paths that must agree pixel for pixel (HL1) — the canvas
 * compositor's own drawer and the markup assembler, which has no motion
 * mechanism at all — so a track on it would render on one path and not the
 * other; that is a standalone decision, not a table the plan carries, and it
 * refuses here for that reason. `fill` refuses for the plainer reason: no
 * creative type accepts it yet (D131) and this compositor draws it nowhere,
 * so a track on it would be the D134 mistake again — a vocabulary member
 * nothing reads.
 */
const TRACKABLE_LAYER_KINDS: readonly LayerKind[] = [
  "image",
  "video",
  "shade",
  "accent",
  "static-text",
  "animated-text",
  "logo",
];

/** Why a layer's `tracks` is not a shape the brief may carry; undefined when it is. */
export interface LayerTracksProblem {
  /** The tracks subpath the problem names — `[i]` for a track, `[i].stops[j]` for a stop, `.field` for one value. */
  readonly path: string;
  /** The requirement, phrased to follow "must" in a `Campaign brief field …` message. */
  readonly must: string;
  /** The offending value, for the message's `got <JSON>` clause. */
  readonly value: unknown;
}

const TRACK_FIELDS = ["property", "stops"] as const;
const STOP_FIELDS = ["t", "value", "easing", "clock"] as const;

/**
 * The one tracks decision both boundaries read (K1), shaped like
 * `layerElementsProblem`: `isLayerEntry` refuses on a defined problem and the
 * API's `validateTemplate` formats the same problem into its message shape —
 * the two cannot drift. Absent `tracks` is always fine. Only a kind in
 * `TRACKABLE_LAYER_KINDS` may carry a defined `tracks` — the empty array
 * included — before any entry is walked. A present list must be a non-empty
 * array of well-formed tracks.
 */
export function layerTracksProblem(
  kind: LayerKind,
  tracks: unknown,
): LayerTracksProblem | undefined {
  if (tracks === undefined) return undefined;
  if (!TRACKABLE_LAYER_KINDS.includes(kind)) {
    return { path: "", must: `be absent for layer kind "${kind}"`, value: tracks };
  }
  if (!Array.isArray(tracks)) {
    return { path: "", must: "be an array of tracks", value: tracks };
  }
  for (let i = 0; i < tracks.length; i += 1) {
    const problem = trackProblem(tracks[i]);
    if (problem !== undefined) {
      return { path: `[${i}]${problem.path}`, must: problem.must, value: problem.value };
    }
  }
  return undefined;
}

/**
 * One track's contract: a non-null, non-array object naming a vocabulary
 * `property`, carrying only `property` and `stops`, and a non-empty array of
 * well-formed, in-order stops.
 */
function trackProblem(track: unknown): LayerTracksProblem | undefined {
  if (typeof track !== "object" || track === null || Array.isArray(track)) {
    return { path: "", must: "be an object", value: track };
  }
  const record = track as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!(TRACK_FIELDS as readonly string[]).includes(field)) {
      return {
        path: `.${field}`,
        must: `be one of ${TRACK_FIELDS.map((f) => `"${f}"`).join(", ")}`,
        value: record[field],
      };
    }
  }
  const property = record.property;
  if (typeof property !== "string" || !(TRACK_PROPERTIES as readonly string[]).includes(property)) {
    return {
      path: ".property",
      must: `be one of ${TRACK_PROPERTIES.map((p) => `"${p}"`).join(", ")}`,
      value: property,
    };
  }
  const stops = record.stops;
  if (!Array.isArray(stops) || stops.length === 0) {
    return { path: ".stops", must: "be a non-empty array of stops", value: stops };
  }
  // One `t` sequence per clock (K-D8): two stops on different clocks are
  // independent axes, so only a same-clock comparison can mean "out of
  // order" or "duplicate". K-D9's only refusal — a duplicate `t` — is the
  // equal case of this same strictly-increasing check, not a second rule.
  const lastTByClock = new Map<StopClock, number>();
  for (let i = 0; i < stops.length; i += 1) {
    const problem = stopProblem(stops[i]);
    if (problem !== undefined) {
      return { path: `.stops[${i}]${problem.path}`, must: problem.must, value: problem.value };
    }
    const stop = stops[i] as { readonly t: number; readonly clock: StopClock };
    const prevT = lastTByClock.get(stop.clock);
    if (prevT !== undefined && stop.t <= prevT) {
      return {
        path: `.stops[${i}].t`,
        must: `be strictly greater than the previous "${stop.clock}"-clock stop's t (${prevT})`,
        value: stop.t,
      };
    }
    lastTByClock.set(stop.clock, stop.t);
  }
  return undefined;
}

/**
 * One stop's contract: `t` and `value` finite numbers ( `t` in [0, 1]),
 * `clock` a vocabulary member, and an optional `easing` override from the
 * same vocabulary.
 */
function stopProblem(stop: unknown): LayerTracksProblem | undefined {
  if (typeof stop !== "object" || stop === null || Array.isArray(stop)) {
    return { path: "", must: "be an object", value: stop };
  }
  const record = stop as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!(STOP_FIELDS as readonly string[]).includes(field)) {
      return {
        path: `.${field}`,
        must: `be one of ${STOP_FIELDS.map((f) => `"${f}"`).join(", ")}`,
        value: record[field],
      };
    }
  }
  const t = record.t;
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 1) {
    return { path: ".t", must: "be a number in [0, 1]", value: t };
  }
  const value = record.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { path: ".value", must: "be a finite number", value };
  }
  const clock = record.clock;
  if (typeof clock !== "string" || !(STOP_CLOCKS as readonly string[]).includes(clock)) {
    return {
      path: ".clock",
      must: `be one of ${STOP_CLOCKS.map((c) => `"${c}"`).join(", ")}`,
      value: clock,
    };
  }
  if (record.easing !== undefined) {
    const easing = record.easing;
    if (typeof easing !== "string" || !(EASING_KINDS as readonly string[]).includes(easing)) {
      return {
        path: ".easing",
        must: `be one of ${EASING_KINDS.map((e) => `"${e}"`).join(", ")}`,
        value: easing,
      };
    }
  }
  return undefined;
}
