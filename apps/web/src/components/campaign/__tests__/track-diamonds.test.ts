import { describe, test, expect } from "vitest";
import type { CreativeTemplateLayer } from "@campaignfoundry/CampaignOrchestration/creative-templates";
import { tAtSecond, trackDiamonds } from "../track-diamonds";

/**
 * TL6 — which stops the whole-creative ruler can honestly place, and where.
 *
 * The boundary is the same one K5 drew, for the same reason: `pose` maps onto
 * the ruler exactly, and the other two clocks do not map onto it at all.
 */
const layer = (tracks: CreativeTemplateLayer["tracks"]): CreativeTemplateLayer =>
  ({ id: "headline", kind: "static-text", tracks }) as CreativeTemplateLayer;

describe("trackDiamonds", () => {
  test("a pose stop's second is t × duration", () => {
    const { placed } = trackDiamonds(
      layer([{ property: "opacity", stops: [{ t: 0.25, value: 1, clock: "pose" }] }]),
      8,
    );
    expect(placed).toEqual([{ trackIndex: 0, stopIndex: 0, property: "opacity", t: 0.25, sec: 2 }]);
  });

  test("every stop of every pose track is placed, with its own address", () => {
    // The address is what `setTrackStop` takes, so a dragged key and a typed
    // one reach the same writer.
    const { placed } = trackDiamonds(
      layer([
        { property: "opacity", stops: [{ t: 0, value: 0, clock: "pose" }] },
        {
          property: "scale",
          stops: [
            { t: 0, value: 1, clock: "pose" },
            { t: 1, value: 2, clock: "pose" },
          ],
        },
      ]),
      4,
    );
    expect(placed.map((d) => [d.trackIndex, d.stopIndex, d.property])).toEqual([
      [0, 0, "opacity"],
      [1, 0, "scale"],
      [1, 1, "scale"],
    ]);
  });

  test("beat and effect stops are COUNTED, never placed", () => {
    // Not hidden: a layer whose only motion is beat-clocked would otherwise
    // read as having no keyframes at all, which is the opposite of true.
    const { placed, unplaceable } = trackDiamonds(
      layer([
        {
          property: "opacity",
          stops: [
            { t: 0, value: 0, clock: "beat" },
            { t: 1, value: 1, clock: "beat" },
          ],
        },
        { property: "dy", stops: [{ t: 0.5, value: 10, clock: "effect" }] },
      ]),
      4,
    );
    expect(placed).toEqual([]);
    expect(unplaceable.count).toBe(3);
  });

  test("a layer mixing clocks places one half and counts the other", () => {
    const { placed, unplaceable } = trackDiamonds(
      layer([
        { property: "opacity", stops: [{ t: 0.5, value: 1, clock: "pose" }] },
        { property: "dy", stops: [{ t: 0.5, value: 10, clock: "beat" }] },
      ]),
      10,
    );
    expect(placed.map((d) => d.sec)).toEqual([5]);
    expect(unplaceable.count).toBe(1);
  });

  test("no layer, and a layer with no tracks, both answer empty", () => {
    expect(trackDiamonds(undefined, 8)).toEqual({ placed: [], unplaceable: { count: 0 } });
    expect(trackDiamonds(layer(undefined), 8)).toEqual({
      placed: [],
      unplaceable: { count: 0 },
    });
  });
});

describe("tAtSecond", () => {
  test("inverts the placement", () => {
    expect(tAtSecond(2, 8)).toBe(0.25);
  });

  test("a zero-length clip answers 0 rather than dividing by it", () => {
    expect(tAtSecond(3, 0)).toBe(0);
  });

  test("clamps into [0, 1] rather than trusting the input's own max", () => {
    // The range's `max` is the duration, but its frame step can land a hair
    // past the end — and `layerTracksProblem` refuses a `t` outside [0, 1],
    // so an unclamped drag would silently refuse instead of moving the key.
    expect(tAtSecond(9, 8)).toBe(1);
    expect(tAtSecond(-1, 8)).toBe(0);
  });
});
