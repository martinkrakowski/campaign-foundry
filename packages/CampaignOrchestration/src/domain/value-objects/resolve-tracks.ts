/**
 * K1b: the track resolver, beside `beatAt` (K-D2, K-D8). Pure — no compositor
 * caller yet (K2 wires it).
 *
 * `resolveTracks(layers, beats, clocks)` walks the layer list (K-D4's one
 * addressing scheme — a track carries no `layer` field of its own) and folds
 * each layer's tracks into a `Pose`. A layer that is absent from `layers`,
 * `enabled: false`, or has no (or an empty) `tracks` list contributes the
 * identity pose (`Pose`'s `0, 0, 1, 1`) — "absent" is the caller's read of a
 * missing `byLayer` key, which is what {@link poseOf} does.
 *
 * Two tracks on one (layer, property) compose per K-D9, folded in
 * *declaration order*: `dx`/`dy` **add**, `opacity`/`scale` **multiply**.
 * Order matters for multiply — float multiplication is associative in real
 * arithmetic but not bit-for-bit in IEEE-754, so a left-to-right fold in
 * declaration order and the same fold reversed can disagree in the last bit
 * (see the module's test fixture). It never matters for exactly two
 * operands, because IEEE-754 multiplication is exactly commutative for a
 * single pair — three or more tracks are needed to observe the drift.
 *
 * A stop's `t` is read against one of three clocks (K-D8): `pose` is the
 * whole-creative `clocks.t` directly; `beat` is the beat-local progress
 * `clamp01((t - beat.startT) / (beat.endT - beat.startT))` that
 * `NodeCanvasCompositor.drawBeat` already computes (~1064); `effect` is
 * `clocks.effectT ?? local`, unifying the compositor's `effectT ?? local`
 * (timeline path) and `effectT ?? t` (legacy path) — the two collapse to one
 * expression because the legacy path defines `local` as `t` (below). A
 * track's stops are assumed to share one clock — the one named by its first
 * stop; the validator (`layerTracksProblem`) permits a track to mix clocks
 * across its stops (it only refuses a duplicate `t` within one clock), but
 * nothing in the plan or the compositor's own mechanism gives a mixed-clock
 * track a meaning, so stops on any other clock are silently ignored, the
 * same "resolves to nothing" shape K-D4 already uses for an absent layer.
 *
 * `beats` is the ALREADY-RESOLVED timeline (`CopyTimeline.vo.ts`'s
 * `resolveTimeline` output), or an empty list for the legacy (timeline-less)
 * path. The legacy path never calls `beatAt`, which throws on an empty list
 * — it uses one implicit beat spanning `[0, 1]` with `local = t` exactly (not
 * `clamp01(t)`; K-D8 names it bare). With a real timeline, the beat is
 * selected by `beatAt(beats, clocks.copyT ?? clocks.t)` — matching
 * `draw()`'s own `copyT ?? t` — and during a crossfade instant that returns
 * two beats (`current`, `incoming`), which is why `copy` is one entry per
 * `(beat, mix)`.
 *
 * `copy` folds every ENABLED, tracked layer of a text kind (`static-text`,
 * `animated-text`) into ONE pose per pair, because K-D6 already collapses
 * two text layers to one beat block and the compositor draws copy once per
 * `drawBeat` call — `copy`'s length is the number of live beats at this
 * instant (1, or 2 during a crossfade), never the number of text layers.
 * Every other trackable kind (`image`, `video`) resolves independently, one
 * entry per layer, into `byLayer`. A returned pose excludes the crossfade
 * `mix` weight — the caller applies it last, exactly where
 * `opacity = (riseAlpha * fx.alpha) * layerAlpha` does today, so `copy[i].pose`
 * composed with `copy[i].mix` reproduces that expression byte for byte.
 */
import { beatAt, type ResolvedBeat } from "./CopyTimeline.vo.js";
import { DEFAULT_EASING, EASINGS } from "./easing.js";
import type { LayerKind } from "./layer-kinds.js";
import type { Stop, Track } from "./tracks.js";

/** A layer's resolved motion state (K-D8): the resolver's whole output shape. */
export interface Pose {
  readonly dx: number;
  readonly dy: number;
  readonly opacity: number;
  readonly scale: number;
}

/** "No tracks" (K-D8): the neutral element for both fold operators at once. */
export const IDENTITY_POSE: Pose = { dx: 0, dy: 0, opacity: 1, scale: 1 };

/**
 * The resolver's view of a layer (K-D4): just enough to decide whether it
 * contributes a pose at all, and which bucket (`byLayer` or `copy`) it lands
 * in. `enabled` absent means enabled, matching `CreativeTemplateLayer`.
 */
export interface TrackedLayer {
  readonly id: string;
  readonly enabled?: boolean;
  readonly kind: LayerKind;
  readonly tracks?: readonly Track[];
}

/** The three independent clocks a pose may be sampled at once (K-D8). */
export interface ClockSet {
  /** The whole-creative pose clock (`pose`-clock stops read this directly). */
  readonly t: number;
  /** Selects the current beat via `beatAt`; defaults to `t` (`draw()`'s `copyT ?? t`). */
  readonly copyT?: number;
  /** The text-effect clock (`effect`-clock stops read `effectT ?? local`). */
  readonly effectT?: number;
}

/** One text pose at one live beat, before the caller applies its `mix`. */
export interface CopyPose {
  readonly beat: ResolvedBeat;
  readonly mix: number;
  readonly pose: Pose;
}

export interface ResolvedTracks {
  readonly byLayer: ReadonlyMap<string, Pose>;
  readonly copy: readonly CopyPose[];
}

/** The layer kinds whose pose is sequenced copy, not an independent layer (K-D6). */
const TEXT_LAYER_KINDS: ReadonlySet<LayerKind> = new Set(["static-text", "animated-text"]);

/**
 * The legacy path's one implicit beat, `[0, 1]` (K-D8). Exported so a test
 * can name the exact object `resolveTracks` returns for it.
 */
export const IMPLICIT_BEAT: ResolvedBeat = { text: "", startT: 0, endT: 1, fadeInT: 0 };

/** One live beat at this instant, and the crossfade weight the caller applies to it. */
interface LivePair {
  readonly beat: ResolvedBeat;
  readonly mix: number;
  /** This beat's own local progress — `t` on the legacy path (K-D8), else beat-local. */
  readonly local: number;
}

export function resolveTracks(
  layers: readonly TrackedLayer[],
  beats: readonly ResolvedBeat[],
  clocks: ClockSet,
): ResolvedTracks {
  const pairs = livePairs(beats, clocks);

  const byLayer = new Map<string, Pose>();
  const textTracks: Track[] = [];
  for (const layer of layers) {
    const tracks = enabledTracks(layer);
    if (TEXT_LAYER_KINDS.has(layer.kind)) {
      textTracks.push(...tracks);
      continue;
    }
    byLayer.set(layer.id, foldPose(tracks, clocks, pairs[0].local));
  }

  const copy: CopyPose[] = pairs.map(({ beat, mix, local }) => ({
    beat,
    mix,
    pose: foldPose(textTracks, clocks, local),
  }));

  return { byLayer, copy };
}

/**
 * `byLayer.get(id)`, defaulting to the identity pose — the caller's read of
 * K-D4's "absent ... resolves to nothing": a layer id `resolveTracks` never
 * saw contributes the same pose as one it saw and found disabled or
 * trackless.
 */
export function poseOf(resolved: ResolvedTracks, layerId: string): Pose {
  return resolved.byLayer.get(layerId) ?? IDENTITY_POSE;
}

/** A layer's own tracks, or none at all if it is disabled or carries none (K-D4). */
function enabledTracks(layer: TrackedLayer): readonly Track[] {
  if (layer.enabled === false) return [];
  return layer.tracks ?? [];
}

/**
 * The beat(s) live at this instant, at most two (a crossfade), each with its
 * own local progress and the crossfade weight the caller (or the `copy`
 * fold) applies to its pose. An empty `beats` list is the legacy path: one
 * implicit beat with `local = t`, `beatAt` never called (K-D8) — calling it
 * on an empty list throws.
 */
function livePairs(beats: readonly ResolvedBeat[], clocks: ClockSet): readonly LivePair[] {
  if (beats.length === 0) {
    return [{ beat: IMPLICIT_BEAT, mix: 1, local: clocks.t }];
  }
  const pair = beatAt(beats, clocks.copyT ?? clocks.t);
  if (pair.mix > 0 && pair.incoming !== undefined) {
    return [
      { beat: pair.current, mix: 1 - pair.mix, local: beatLocal(clocks.t, pair.current) },
      { beat: pair.incoming, mix: pair.mix, local: beatLocal(clocks.t, pair.incoming) },
    ];
  }
  return [{ beat: pair.current, mix: 1, local: beatLocal(clocks.t, pair.current) }];
}

/**
 * Beat-local progress (K-D8, matching `NodeCanvasCompositor.drawBeat`'s own
 * `local`): `beat.endT > beat.startT` always holds for a beat `resolveTimeline`
 * produced (a beat's weight is a positive integer), so this never divides by
 * zero. Only an upper clamp is needed — `t` is always at or past `beat.startT`
 * for a beat `livePairs` passes here (`beatAt`'s own selection invariant: a
 * beat is only ever "current" or "incoming" once its window has started) —
 * but `t` can run PAST an outgoing beat's `endT` during the next beat's
 * crossfade, exactly as `drawBeat`'s own `local` does for that same call.
 */
function beatLocal(t: number, beat: ResolvedBeat): number {
  const raw = (t - beat.startT) / (beat.endT - beat.startT);
  return raw > 1 ? 1 : raw;
}

/** Folds every track into one pose (K-D9): `dx`/`dy` add, `opacity`/`scale` multiply, in declaration order. */
function foldPose(tracks: readonly Track[], clocks: ClockSet, local: number): Pose {
  let dx = 0;
  let dy = 0;
  let opacity = 1;
  let scale = 1;
  for (const track of tracks) {
    const value = trackValue(track, clocks, local);
    switch (track.property) {
      case "dx":
        dx += value;
        break;
      case "dy":
        dy += value;
        break;
      case "opacity":
        opacity *= value;
        break;
      case "scale":
        scale *= value;
        break;
    }
  }
  return { dx, dy, opacity, scale };
}

/**
 * One track's value at this instant. A track's stops are assumed to share
 * one clock — the one its first stop names (the module contract explains
 * why a mixed-clock track is not given a fold-across-clocks meaning here).
 */
function trackValue(track: Track, clocks: ClockSet, local: number): number {
  const clock = track.stops[0]!.clock;
  const x = clockSample(clock, clocks, local);
  const stops = track.stops
    .filter((stop) => stop.clock === clock)
    .slice()
    .sort((a, b) => a.t - b.t);
  return sampleStops(stops, x);
}

function clockSample(clock: Stop["clock"], clocks: ClockSet, local: number): number {
  switch (clock) {
    case "pose":
      return clocks.t;
    case "beat":
      return local;
    case "effect":
      return clocks.effectT ?? local;
  }
}

/**
 * The value of a sorted, non-empty stop list at `x`: holds at the boundary
 * stop's value before the first and after the last, else eases between the
 * bracketing pair with the STARTING stop's easing (K1b's own rule — an
 * ending stop's easing never applies to the segment before it).
 */
function sampleStops(stops: readonly Stop[], x: number): number {
  const first = stops[0]!;
  if (x <= first.t) return first.value;
  const last = stops[stops.length - 1]!;
  if (x >= last.t) return last.value;
  let i = 0;
  while (x > stops[i + 1]!.t) i += 1;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  const progress = (x - a.t) / (b.t - a.t);
  const ease = EASINGS[a.easing ?? DEFAULT_EASING];
  return a.value + (b.value - a.value) * ease(progress);
}
