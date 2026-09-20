import type { CreativeTemplateLayer } from "@campaignfoundry/CampaignOrchestration/creative-templates";
import type { Track, TrackProperty } from "@campaignfoundry/CampaignOrchestration/tracks";

/**
 * One keyframe stop placed on the whole-creative ruler (TL6).
 *
 * `trackIndex`/`stopIndex` are the address `setTrackStop` takes, so a dragged
 * diamond commits through exactly the same action the inspector's number box
 * does — one writer for one edit (TL6's own row: "dragging a diamond writes the
 * same `t` the form commits").
 */
export interface TrackDiamond {
  readonly trackIndex: number;
  readonly stopIndex: number;
  readonly property: TrackProperty;
  /** The stop's own `t`, committed — never an in-flight drag position (§9.3.3). */
  readonly t: number;
  /** Where it sits on the ruler, in seconds. */
  readonly sec: number;
}

/**
 * Why a track's stops are not on the ruler, when they are not.
 *
 * Counted rather than hidden: a layer whose only motion is beat-clocked would
 * otherwise show an empty diamond lane and read as "no keyframes", which is the
 * opposite of true.
 */
export interface UnplaceableTracks {
  readonly count: number;
}

/**
 * The picked layer's stops, split into what the ruler can honestly show and
 * what it cannot.
 *
 * **Only `pose`-clock stops are placed, and this is the same boundary K5 drew
 * for the same reason.** `clockSample` maps a `pose` stop's `t` straight onto
 * the whole-creative clock, so `t × durationSec` is its exact position. A
 * `beat`-clock stop's `t` is beat-LOCAL: at `t = 0.5` it fires at the midpoint
 * of *every* beat, so it has no single second to sit at — one diamond would be
 * a lie and N diamonds would make a drag ambiguous about which occurrence it
 * moved. An `effect`-clock stop reads `effectT ?? local`, which is worse: its
 * position depends on a resolver input the editor does not hold at all.
 *
 * So they are counted and named, not placed. Prefilling or placing them needs
 * the resolver's own beat mapping (`beatAt` + `beatLocal`), which is the export
 * §9.4 records the domain owing the editor and which no lane has taken yet.
 */
export function trackDiamonds(
  layer: CreativeTemplateLayer | undefined,
  durationSec: number,
): { readonly placed: readonly TrackDiamond[]; readonly unplaceable: UnplaceableTracks } {
  const tracks: readonly Track[] = layer?.tracks ?? [];
  const placed: TrackDiamond[] = [];
  let unplaceable = 0;
  tracks.forEach((track, trackIndex) => {
    // A track's stops share one clock (K1b), so the first stop names it for all.
    if (track.stops[0]!.clock !== "pose") {
      unplaceable += track.stops.length;
      return;
    }
    track.stops.forEach((stop, stopIndex) => {
      placed.push({
        trackIndex,
        stopIndex,
        property: track.property,
        t: stop.t,
        sec: stop.t * durationSec,
      });
    });
  });
  return { placed, unplaceable: { count: unplaceable } };
}

/**
 * A dragged second back to the `t` the domain stores.
 *
 * Clamped into `[0, 1]` here rather than trusting the range input: the input's
 * own `max` is the duration, but a zero-length clip would divide by zero and a
 * rounding step can land a hair past the end.
 */
export function tAtSecond(sec: number, durationSec: number): number {
  if (!(durationSec > 0)) return 0;
  const raw = sec / durationSec;
  return raw < 0 ? 0 : raw > 1 ? 1 : raw;
}
