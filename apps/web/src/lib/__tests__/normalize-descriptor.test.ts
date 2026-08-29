import { describe, test, expect } from "vitest";
import { normalizeDescriptor, normalizeRunResult } from "../run-context";
import type { Asset, RunResult } from "../run-context";

const asset = (descriptor?: unknown): Asset =>
  ({
    productId: "alpha",
    aspectRatio: "1:1",
    outputPath: "alpha/1x1.png",
    complianceScore: 1,
    passedCompliance: true,
    logoApplied: true,
    treatment: "headline-top-bold",
    backgroundSource: "procedural",
    ...(descriptor !== undefined ? { descriptor } : {}),
  }) as unknown as Asset;

describe("normalizeDescriptor — keep what is usable, drop the rest", () => {
  test("a well-formed descriptor survives whole", () => {
    const input = {
      layout: "headline-top",
      tone: "bold",
      backgroundSource: "procedural",
      paletteShift: 0.1,
      motion: "ken-burns-in",
      durationSec: 6,
      beats: 3,
      headline: "Stay wild",
    };
    expect(normalizeDescriptor(input)).toEqual(input);
  });

  test("an unusable field is dropped and its neighbours are kept", () => {
    // The point of the lane: a partial descriptor must not cost the fields that are fine,
    // and must not leave `undefined` to be rendered as an empty chip.
    expect(normalizeDescriptor({ layout: 42, tone: "bold", backgroundSource: "procedural" })).toEqual({
      tone: "bold",
      backgroundSource: "procedural",
    });
    expect(normalizeDescriptor({ paletteShift: "0.1", beats: 3 })).toEqual({ beats: 3 });
  });

  test("an empty or whitespace-only string is not a usable field", () => {
    // It would otherwise pass the chip's presence check and render the empty pill this
    // function exists to prevent — and the filter options, which test truthiness, already
    // treated it as absent, so the two disagreed about the same descriptor.
    expect(normalizeDescriptor({ layout: "", tone: "bold" })).toEqual({ tone: "bold" });
    expect(normalizeDescriptor({ layout: "   ", tone: "bold" })).toEqual({ tone: "bold" });
    expect(normalizeDescriptor({ layout: "", tone: "" })).toBeUndefined();
    // A real value keeps its surrounding text intact, trimmed.
    expect(normalizeDescriptor({ headline: "  Stay wild  " })).toEqual({ headline: "Stay wild" });
  });

  test("a non-finite number is not a number", () => {
    expect(normalizeDescriptor({ paletteShift: Number.NaN, tone: "bold" })).toEqual({ tone: "bold" });
    expect(normalizeDescriptor({ durationSec: Number.POSITIVE_INFINITY, tone: "bold" })).toEqual({
      tone: "bold",
    });
  });

  test("nothing usable is the same as nothing at all", () => {
    expect(normalizeDescriptor({})).toBeUndefined();
    expect(normalizeDescriptor({ layout: 1, tone: 2 })).toBeUndefined();
  });

  test("a value that is not an object is not a descriptor", () => {
    for (const value of [null, undefined, "descriptor", 7, true, ["layout"]]) {
      expect(normalizeDescriptor(value)).toBeUndefined();
    }
  });
});

describe("normalizeRunResult — narrow provenance, never drop a creative", () => {
  const run = (assets: Asset[]): RunResult => ({ assets, log: { campaignId: "c" } }) as unknown as RunResult;

  test("a junk descriptor costs the provenance, not the asset", () => {
    const out = normalizeRunResult(run([asset("nonsense")]));
    expect(out.assets).toHaveLength(1);
    expect(out.assets[0]?.outputPath).toBe("alpha/1x1.png");
    expect(out.assets[0]?.descriptor).toBeUndefined();
  });

  test("an asset with no descriptor is passed through untouched", () => {
    const input = run([asset()]);
    const out = normalizeRunResult(input);
    expect(out.assets[0]).toBe(input.assets[0]);
  });

  test("a partial descriptor keeps its usable fields", () => {
    const out = normalizeRunResult(run([asset({ layout: "headline-top", tone: 9, beats: 2 })]));
    expect(out.assets[0]?.descriptor).toEqual({ layout: "headline-top", beats: 2 });
  });

  test("a result with no assets array is returned as it came", () => {
    const input = { log: { campaignId: "c" } } as unknown as RunResult;
    expect(normalizeRunResult(input)).toBe(input);
  });
});
