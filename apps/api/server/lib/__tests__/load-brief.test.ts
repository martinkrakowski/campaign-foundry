import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBrief,
  parseRegenerateOnly,
  loadBrief,
  SUPPORTED_AXES,
  SUPPORTED_FORMATS,
} from "../load-brief.js";

const valid = {
  id: "camp",
  targetRegion: "DE",
  targetAudience: "aud",
  campaignMessage: "Hello",
  products: [{ id: "alpha" }, { id: "beta" }],
};

describe("parseBrief", () => {
  test("accepts a structurally valid brief", () => {
    expect(parseBrief(valid).id).toBe("camp");
  });

  test.each([
    ["a non-object", 42, /must be an object/],
    ["null", null, /must be an object/],
    ["a missing required field (campaignMessage)", { id: "camp", targetRegion: "DE", targetAudience: "a", products: valid.products }, /missing required field/],
    ["a non-slug id", { ...valid, id: "Bad Id" }, /Campaign id must be a path-safe/],
    ["non-array products", { ...valid, products: "x" }, /"products" must be an array/],
    ["a non-slug product id", { ...valid, products: [{ id: "Alpha" }, { id: "beta" }] }, /Product id must be a path-safe/],
  ])("rejects %s", (_label, input, message) => {
    expect(() => parseBrief(input)).toThrow(message);
  });

  test("validates optional treatments structurally", () => {
    expect(() => parseBrief({ ...valid, treatments: "x" })).toThrow(/"treatments" must be an array/);
    expect(() => parseBrief({ ...valid, treatments: [{ id: "Bad", layout: "headline-top", tone: "bold" }] })).toThrow(
      /Treatment id must be a path-safe/,
    );
    expect(() =>
      parseBrief({ ...valid, treatments: [{ id: "t", layout: "sideways", tone: "bold" }] }),
    ).toThrow(/invalid layout/);
    expect(() =>
      parseBrief({ ...valid, treatments: [{ id: "t", layout: "headline-top", tone: "loud" }] }),
    ).toThrow(/invalid tone/);
    expect(() =>
      parseBrief({
        ...valid,
        treatments: [
          { id: "dup", layout: "headline-top", tone: "bold" },
          { id: "dup", layout: "headline-bottom", tone: "subtle" },
        ],
      }),
    ).toThrow(/Duplicate treatment id/);
    // A valid treatments array passes.
    expect(parseBrief({ ...valid, treatments: [{ id: "t", layout: "headline-top", tone: "bold" }] }).treatments).toHaveLength(1);
  });
});

const staticAxes = {
  layout: ["headline-top", "headline-bottom"],
  tone: ["bold", "subtle"],
  background: { source: ["procedural"] },
  paletteShift: [0, 0.1, 0.2],
};

const v2Brief = {
  ...valid,
  mode: "variation",
  variation: {
    count: 12,
    seed: 42,
    minDistance: 2,
    coverage: { perProduct: 1, perRatio: 1 },
    axes: staticAxes,
  },
  output: {
    formats: ["static"],
    platforms: ["instagram-feed", "linkedin", "x"],
  },
};

describe("parseBrief v2 fields", () => {
  test("SUPPORTED_AXES and SUPPORTED_FORMATS lock the P0 allowlist", () => {
    expect(SUPPORTED_AXES).toEqual(["layout", "tone", "background", "paletteShift"]);
    expect(SUPPORTED_FORMATS).toEqual(["static"]);
  });

  test("classic briefs omit v2 fields — they are not required", () => {
    const parsed = parseBrief(valid);
    expect(parsed.mode).toBeUndefined();
    expect(parsed.variation).toBeUndefined();
    expect(parsed.output).toBeUndefined();
  });

  test("accepts a variation brief with supported static axes and preserves fields", () => {
    const parsed = parseBrief(v2Brief);
    expect(parsed.mode).toBe("variation");
    expect(parsed.variation).toEqual(v2Brief.variation);
    expect(parsed.output).toEqual(v2Brief.output);
  });

  test("accepts mode brief and sparse v2 objects", () => {
    expect(parseBrief({ ...valid, mode: "brief" }).mode).toBe("brief");
    expect(parseBrief({ ...valid, variation: {} }).variation).toEqual({});
    expect(parseBrief({ ...valid, variation: { coverage: {}, axes: {} } }).variation).toEqual({
      coverage: {},
      axes: {},
    });
    expect(parseBrief({ ...valid, output: {} }).output).toEqual({});
    expect(
      parseBrief({
        ...valid,
        variation: {
          count: 1,
          seed: -1.5,
          minDistance: 0,
          coverage: { perProduct: 0, perRatio: 0 },
          axes: {
            layout: [],
            tone: [],
            background: {},
            paletteShift: [],
          },
        },
      }).variation?.count,
    ).toBe(1);
    expect(
      parseBrief({
        ...valid,
        variation: { axes: { background: { source: ["procedural", "asset-pool", "genai"] } } },
        output: { formats: ["static"], platforms: ["instagram-feed"] },
      }).output?.formats,
    ).toEqual(["static"]);
  });

  test.each([
    ["an invalid mode", { ...valid, mode: "random" }, /mode/],
    ["a non-string mode", { ...valid, mode: 1 }, /mode/],
    ["a non-object variation", { ...valid, variation: "x" }, /"variation" must be an object/],
    ["an array variation", { ...valid, variation: [] }, /"variation" must be an object/],
    ["a null variation", { ...valid, variation: null }, /"variation" must be an object/],
    ["a non-integer count", { ...valid, variation: { count: 1.5 } }, /variation.count/],
    ["a count below 1", { ...valid, variation: { count: 0 } }, /variation.count/],
    ["a non-number count", { ...valid, variation: { count: "12" } }, /variation.count/],
    ["a non-finite seed", { ...valid, variation: { seed: Infinity } }, /variation.seed/],
    ["a NaN seed", { ...valid, variation: { seed: Number.NaN } }, /variation.seed/],
    ["a non-number seed", { ...valid, variation: { seed: "42" } }, /variation.seed/],
    ["a non-integer minDistance", { ...valid, variation: { minDistance: 1.5 } }, /variation.minDistance/],
    ["a negative minDistance", { ...valid, variation: { minDistance: -1 } }, /variation.minDistance/],
    ["a non-object coverage", { ...valid, variation: { coverage: [] } }, /variation.coverage/],
    ["a null coverage", { ...valid, variation: { coverage: null } }, /variation.coverage/],
    ["a negative perProduct", { ...valid, variation: { coverage: { perProduct: -1 } } }, /perProduct/],
    ["a non-integer perRatio", { ...valid, variation: { coverage: { perRatio: 1.2 } } }, /perRatio/],
    ["a non-integer perProduct", { ...valid, variation: { coverage: { perProduct: 1.5 } } }, /perProduct/],
    ["a non-object axes", { ...valid, variation: { axes: [] } }, /variation.axes/],
    ["a null axes", { ...valid, variation: { axes: null } }, /variation.axes/],
    ["the motion axis", { ...valid, variation: { axes: { motion: ["ken-burns-in"] } } }, /motion/],
    ["the duration axis", { ...valid, variation: { axes: { duration: [6] } } }, /duration/],
    ["an unknown axis key", { ...valid, variation: { axes: { flavour: ["x"] } } }, /flavour/],
    ["axes.headline", { ...valid, variation: { axes: { headline: "pool://copy" } } }, /headline/],
    ["a pool:// string under axes", { ...valid, variation: { axes: { layout: ["pool://copy"] } } }, /axis "layout".*pool/],
    ["mode variation without a count", { ...valid, mode: "variation", variation: { axes: {} } }, /variation.count.*required/],
    ["mode variation without a variation block", { ...valid, mode: "variation" }, /variation.count.*required/],
    ["a non-array layout", { ...valid, variation: { axes: { layout: "headline-top" } } }, /layout/],
    ["an invalid layout value", { ...valid, variation: { axes: { layout: ["sideways"] } } }, /layout/],
    ["a non-string layout value", { ...valid, variation: { axes: { layout: [1] } } }, /layout/],
    ["an invalid tone value", { ...valid, variation: { axes: { tone: ["loud"] } } }, /tone/],
    ["a non-array tone", { ...valid, variation: { axes: { tone: "bold" } } }, /tone/],
    ["a non-object background", { ...valid, variation: { axes: { background: [] } } }, /background/],
    ["a null background", { ...valid, variation: { axes: { background: null } } }, /background/],
    [
      "a non-array background.source",
      { ...valid, variation: { axes: { background: { source: "procedural" } } } },
      /background.source/,
    ],
    [
      "an unsupported background source",
      { ...valid, variation: { axes: { background: { source: ["unsplash"] } } } },
      /unsplash/,
    ],
    [
      "a non-string background source",
      { ...valid, variation: { axes: { background: { source: [1] } } } },
      /background.source/,
    ],
    ["a non-array paletteShift", { ...valid, variation: { axes: { paletteShift: 0 } } }, /paletteShift/],
    ["a non-finite paletteShift", { ...valid, variation: { axes: { paletteShift: [Infinity] } } }, /paletteShift/],
    ["a non-number paletteShift", { ...valid, variation: { axes: { paletteShift: ["0"] } } }, /paletteShift/],
    ["a non-object output", { ...valid, output: "x" }, /"output" must be an object/],
    ["an array output", { ...valid, output: [] }, /"output" must be an object/],
    ["a null output", { ...valid, output: null }, /"output" must be an object/],
    ["empty output.formats", { ...valid, output: { formats: [] } }, /formats/],
    ["a non-array output.formats", { ...valid, output: { formats: "static" } }, /formats/],
    ["the motion format", { ...valid, output: { formats: ["motion"] } }, /motion/],
    ["a non-string format", { ...valid, output: { formats: [1] } }, /format/],
    ["empty output.platforms", { ...valid, output: { platforms: [] } }, /platforms/],
    ["a non-array output.platforms", { ...valid, output: { platforms: "instagram-feed" } }, /platforms/],
    ["an empty-string platform", { ...valid, output: { platforms: [""] } }, /platforms/],
    ["a non-string platform", { ...valid, output: { platforms: [1] } }, /platforms/],
  ])("rejects %s", (_label, input, message) => {
    expect(() => parseBrief(input)).toThrow(message);
  });
});

describe("parseRegenerateOnly", () => {
  test("returns undefined when absent", () => {
    expect(parseRegenerateOnly(undefined)).toBeUndefined();
    expect(parseRegenerateOnly(null)).toBeUndefined();
  });

  test("rejects a non-array and an empty array", () => {
    expect(() => parseRegenerateOnly("x")).toThrow(/must be an array/);
    expect(() => parseRegenerateOnly([])).toThrow(/at least one target/);
  });

  test("rejects entries with non-string fields", () => {
    expect(() => parseRegenerateOnly([{ productId: "p", aspectRatio: "1:1" }])).toThrow(/require string/);
  });

  test("maps valid targets", () => {
    expect(parseRegenerateOnly([{ productId: "p", aspectRatio: "1:1", treatment: "default" }])).toEqual([
      { productId: "p", aspectRatio: "1:1", treatment: "default" },
    ]);
  });
});

describe("loadBrief", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("loads a JSON brief", async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-brief-"));
    const path = join(dir, "c.json");
    writeFileSync(path, JSON.stringify(valid));
    expect((await loadBrief(path)).id).toBe("camp");
  });

  test("loads a YAML brief", async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-brief-"));
    const path = join(dir, "c.yaml");
    writeFileSync(path, "id: camp\ntargetRegion: DE\ntargetAudience: a\ncampaignMessage: Hi\nproducts:\n  - id: alpha\n  - id: beta\n");
    expect((await loadBrief(path)).products).toHaveLength(2);
  });
});
