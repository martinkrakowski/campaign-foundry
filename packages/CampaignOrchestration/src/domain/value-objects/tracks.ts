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
 * with no timeline). **A track's stops all share one clock** — the one its
 * first stop names (K1b review) — so two clocks on one property is
 * expressed as two separate (single-clock) tracks, which compose per K-D9,
 * not as stops on different clocks inside one track: a mixed-clock track
 * was previously accepted here and had its off-clock stops silently
 * ignored by the resolver (K1b), the exact kind of data loss this domain
 * refuses everywhere else.
 *
 * Two tracks may target the same (layer, property): each property fixes how
 * its tracks combine (`dx`/`dy` sum, `opacity`/`scale` multiply, in
 * declaration order), and that composition is never refused here.
 */
import type { EasingKind } from "./easing.js";
import { EASING_KINDS } from "./easing.js";
import type { LayerKind } from "./layer-kinds.js";

/**
 * A track's four initial pose properties (the keyframing plan's §1 "The
 * model"), not exactly what the compositor moves today: `accent-wipe`
 * animates the extent of a fixed-gradient clip rect, which none of these
 * four represents. **K2 decided this, not just deferred it**
 * (`motion-tracks.ts`'s `accentWipeFraction`): the wipe stays the one
 * drawer-local animation `paintAccent` computes directly, because reusing an
 * existing property as a stand-in for a clip fraction would be a fifth
 * property in disguise. Nothing wider until something needs it (an unread
 * property is the D134 mistake).
 */
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
 * The layer kinds a track may nest on (plan review 2026-09-15): only the
 * kinds K2/K3 drive — `image`, `video`, `static-text`, `animated-text`. This
 * is narrower than "every kind this compositor draws": `shade` (`paintShade`)
 * and `logo` (`drawLogo`) read neither `eased` nor `motion` at all — they
 * have no pose mechanism today — and `accent`'s only motion, the wipe, is a
 * clip-extent animation that none of `TRACK_PROPERTIES` represents (see its
 * own doc comment). Accepting tracks on a kind with no pose mechanism would
 * be the exact D134 mistake this comment cites elsewhere: a vocabulary
 * member nothing reads.
 *
 * `html` refuses for a different reason: it renders through two independent
 * paths that must agree pixel for pixel (HL1) — the canvas compositor's own
 * drawer and the markup assembler, which has no motion mechanism at all — so
 * a track on it would render on one path and not the other. `fill` refuses
 * because no creative type accepts it yet (D131) and this compositor draws
 * it nowhere.
 *
 * Widening is additive later and never breaks a stored brief: `accent` when
 * K2 gives the wipe a representable property, `shade`/`logo` with a generic
 * per-drawer pose wrapper (K4 territory). Narrowing later would refuse
 * tracks a brief already carries, which this list is written to avoid.
 *
 * Exported for K5, the same reason `TEXT_LAYER_KINDS` is: the editor decides
 * which layers are offered a Tracks section, and a second list there would be
 * free to drift from the one this boundary actually enforces — offering a
 * control whose every dispatch `layerTracksProblem` then refuses.
 */
export const TRACKABLE_LAYER_KINDS: readonly LayerKind[] = [
  "image",
  "video",
  "static-text",
  "animated-text",
];

/**
 * The trackable kinds whose pose is sequenced copy (K1b review, resolver
 * fix round 2): `beat` and `effect` clocks both need a *beat* to be
 * beat-local against (K-D8) — `beat` reads the beat-local progress a copy
 * timeline derives, `effect` falls back to it with no timeline — and only a
 * text layer's pose is resolved per beat (`resolveTracks`'s `copy`, K-D6).
 * `image`/`video` resolve into `byLayer`, one pose per layer with no
 * per-beat multiplicity, so a `beat`/`effect`-clock track on one has no
 * defined value during a crossfade: which of the (at most two) live beats'
 * local progress would it read? Nothing decides that, so it is refused here
 * instead of resolved to an arbitrary, discontinuous answer. Exported so
 * `resolve-tracks.ts` reads this same list rather than keeping its own copy
 * that could drift from what the boundary actually allows.
 */
export const TEXT_LAYER_KINDS: readonly LayerKind[] = ["static-text", "animated-text"];

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
 * included — before any entry is walked. A present list must be an array of
 * well-formed tracks; empty is the same as absent.
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
    const problem = trackProblem(kind, tracks[i]);
    if (problem !== undefined) {
      return { path: `[${i}]${problem.path}`, must: problem.must, value: problem.value };
    }
  }
  return undefined;
}

/**
 * One track's contract: a non-null, non-array object naming a vocabulary
 * `property`, carrying only `property` and `stops`, a non-empty array of
 * well-formed stops that all share one clock (K1b review), each stop's
 * clock legal for `kind` (`beat`/`effect` need a text layer, K1b review fix
 * round 2), and no duplicate `t` within that clock (K-D9) — declaration
 * order is otherwise free.
 */
function trackProblem(kind: LayerKind, track: unknown): LayerTracksProblem | undefined {
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
  // K1b review: a track's stops all share ONE clock — the one its first stop
  // names. Two clocks on one property is expressed as two separate
  // (single-clock) tracks, which compose per K-D9 — not as stops on
  // different clocks inside one track, which used to be accepted here and
  // had its off-clock stops silently ignored by the resolver (data loss with
  // no message, closed at this boundary instead). K-D9's only OTHER
  // refusal is a duplicate `t` within that one clock — declaration order is
  // otherwise free (a track's stops need not be written t-ascending).
  let trackClock: StopClock | undefined;
  const seenT = new Set<number>();
  for (let i = 0; i < stops.length; i += 1) {
    const problem = stopProblem(stops[i]);
    if (problem !== undefined) {
      return { path: `.stops[${i}]${problem.path}`, must: problem.must, value: problem.value };
    }
    const stop = stops[i] as { readonly t: number; readonly clock: StopClock };
    if (stop.clock !== "pose" && !TEXT_LAYER_KINDS.includes(kind)) {
      return {
        path: `.stops[${i}].clock`,
        must: `be "pose" for layer kind "${kind}" (a beat- or effect-clock track needs a beat, which only a text layer has)`,
        value: stop.clock,
      };
    }
    if (trackClock === undefined) {
      trackClock = stop.clock;
    } else if (stop.clock !== trackClock) {
      return {
        path: `.stops[${i}].clock`,
        must: `be "${trackClock}", the clock this track's first stop names (a track's stops share one clock)`,
        value: stop.clock,
      };
    }
    if (seenT.has(stop.t)) {
      return {
        path: `.stops[${i}].t`,
        must: `be unique among this track's "${stop.clock}"-clock stops (duplicate ${stop.t})`,
        value: stop.t,
      };
    }
    seenT.add(stop.t);
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
