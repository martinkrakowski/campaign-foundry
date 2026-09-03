import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBrief,
  parseRegenerateOnly,
  loadBrief,
  assertSafeId,
  MOTION_AXES,
  MOTION_FORMAT,
  SUPPORTED_AXES,
  SUPPORTED_FORMATS,
  TIMELINE_TRANSITIONS,
} from "../load-brief.js";
import { MAX_BEATS, MAX_WEIGHT, timelineProblem } from "@campaignfoundry/CampaignOrchestration";
import type { Capabilities } from "../../lib/capabilities.js";

const valid = {
  id: "camp",
  targetRegion: "DE",
  targetAudience: "aud",
  campaignMessage: "Hello",
  products: [{ id: "alpha" }, { id: "beta" }],
};

describe("assertSafeId", () => {
  test("accepts a path-safe slug", () => {
    expect(() => assertSafeId("camp", "Campaign id")).not.toThrow();
  });

  test("rejects a non-slug with the field label", () => {
    expect(() => assertSafeId("Bad", "Campaign id")).toThrow(/Campaign id must be a path-safe/);
    expect(() => assertSafeId(1, "briefId")).toThrow(/briefId must be a path-safe/);
  });
});

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

  describe("scalar shape checks (D68 — shape, not just presence)", () => {
    test.each([
      ["a list-typed targetRegion", { ...valid, targetRegion: ["DE", "US"] }, '"targetRegion" must be a string or null; got ["DE","US"]'],
      ["a numeric targetRegion", { ...valid, targetRegion: 1 }, '"targetRegion" must be a string or null; got 1'],
      ["a boolean targetRegion", { ...valid, targetRegion: true }, '"targetRegion" must be a string or null; got true'],
      ["an object targetRegion", { ...valid, targetRegion: { code: "DE" } }, '"targetRegion" must be a string or null; got {"code":"DE"}'],
      ["a numeric targetAudience", { ...valid, targetAudience: 7 }, '"targetAudience" must be a string or null; got 7'],
      ["an array campaignMessage", { ...valid, campaignMessage: ["Hi"] }, '"campaignMessage" must be a string or null; got ["Hi"]'],
      ["a numeric localizedMessage", { ...valid, localizedMessage: 3 }, '"localizedMessage" must be a string or null; got 3'],
    ])("rejects %s in authoring mode", (_label, input, message) => {
      expect(() => parseBrief(input)).toThrow(message);
    });

    test("rejects a list-typed targetRegion in enforcing mode too", () => {
      expect(() =>
        parseBrief({ ...valid, targetRegion: ["DE", "US"] }, { enforceCapabilities: true }),
      ).toThrow('"targetRegion" must be a string or null; got ["DE","US"]');
    });

    test("a numeric targetRegion is refused in enforcing mode — array-only narrowing would leave the .trim() crash open", () => {
      expect(() => parseBrief({ ...valid, targetRegion: 1 }, { enforceCapabilities: true })).toThrow(
        '"targetRegion" must be a string or null; got 1',
      );
    });

    test("null and empty string stay legal — the D15 authoring leniency", () => {
      expect(parseBrief({ ...valid, targetAudience: null }).targetAudience).toBeNull();
      expect(parseBrief({ ...valid, targetAudience: "" }).targetAudience).toBe("");
      expect(parseBrief({ ...valid, localizedMessage: null }).localizedMessage).toBeNull();
      // A brief with no localizedMessage key parses exactly as before.
      expect(parseBrief(valid).localizedMessage).toBeUndefined();
    });

    test.each([
      ["a string entry", ["hydra"], 'products[0]" must be an object; got "hydra"'],
      ["a null entry", [null], 'products[0]" must be an object; got null'],
      ["a numeric entry", [1], 'products[0]" must be an object; got 1'],
      ["an array entry", [["hydra"]], 'products[0]" must be an object; got ["hydra"]'],
      ["a later non-object entry", [{ id: "alpha" }, "hydra"], 'products[1]" must be an object; got "hydra"'],
    ])("products with %s names the entry and its index, not the missing id", (_label, products, message) => {
      expect(() => parseBrief({ ...valid, products })).toThrow(message);
      expect(() => parseBrief({ ...valid, products })).toThrow(/products\[\d+\]" must be an object/);
    });

    test("an empty products array still parses — the run path refuses it at MINIMUM_PRODUCTS", () => {
      expect(parseBrief({ ...valid, products: [] }).products).toEqual([]);
    });
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
  test("SUPPORTED_AXES and SUPPORTED_FORMATS lock the P0 allowlist; motion is a gated extension", () => {
    expect(SUPPORTED_AXES).toEqual([
      "layout",
      "tone",
      "ratio",
      "background",
      "paletteShift",
      "headline",
      "anchor",
    ]);
    expect(SUPPORTED_FORMATS).toEqual(["static"]);
    expect(MOTION_AXES).toEqual(["motion", "duration"]);
    expect(MOTION_FORMAT).toBe("motion");
  });

  test("accepts headline: pool://copy — the only supported pool reference", () => {
    const parsed = parseBrief({ ...valid, variation: { axes: { headline: "pool://copy" } } });
    expect(parsed.variation?.axes?.headline).toBe("pool://copy");
  });

  test("accepts a requested ratio subset and preserves it verbatim", () => {
    const parsed = parseBrief({ ...valid, variation: { count: 2, axes: { ratio: ["16:9", "1:1"] } } });
    expect(parsed.variation?.axes?.ratio).toEqual(["16:9", "1:1"]);
  });

  test("a brief with no ratio key parses exactly as before — absent means every ratio", () => {
    const parsed = parseBrief(v2Brief);
    expect(parsed.variation?.axes?.ratio).toBeUndefined();
    expect(Object.keys(parsed.variation?.axes ?? {})).toEqual(
      Object.keys(v2Brief.variation.axes),
    );
    expect(parsed.variation).toEqual(v2Brief.variation);
  });

  test.each([
    ["a non-array ratio", { ...valid, variation: { axes: { ratio: "1:1" } } }, /variation\.axes\.ratio.*must be an array/],
    ["an empty ratio list", { ...valid, variation: { axes: { ratio: [] } } }, /variation\.axes\.ratio.*at least one/],
    ["an unsupported ratio value", { ...valid, variation: { axes: { ratio: ["4:5"] } } }, /variation\.axes\.ratio.*"4:5"/],
    ["a non-string ratio value", { ...valid, variation: { axes: { ratio: [1] } } }, /variation\.axes\.ratio.*1/],
    ["a repeated ratio", { ...valid, variation: { axes: { ratio: ["9:16", "9:16"] } } }, /variation\.axes\.ratio.*"9:16".*once/],
  ])("rejects %s", (_label, input, message) => {
    expect(() => parseBrief(input)).toThrow(message);
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

  test("accepts the anchor axis as a subset of its three values and preserves it (T4)", () => {
    const parsed = parseBrief({ ...valid, variation: { count: 4, axes: { anchor: ["top", "middle", "bottom"] } } });
    expect(parsed.variation?.axes?.anchor).toEqual(["top", "middle", "bottom"]);
    expect(parseBrief({ ...valid, variation: { count: 4, axes: { anchor: ["bottom"] } } }).variation?.axes?.anchor).toEqual(["bottom"]);
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
    ["an unknown axis key", { ...valid, variation: { axes: { flavour: ["x"] } } }, /flavour/],
    ["axes.headline with another pool", { ...valid, variation: { axes: { headline: "pool://other" } } }, /variation.axes.headline.*"pool:\/\/other"/],
    ["axes.headline as a list", { ...valid, variation: { axes: { headline: ["pool://copy"] } } }, /variation.axes.headline/],
    ["a pool:// string under another axis", { ...valid, variation: { axes: { layout: ["pool://copy"] } } }, /variation.axes.layout.*pool/],
    ["mode variation without a count", { ...valid, mode: "variation", variation: { axes: {} } }, /variation.count.*required/],
    ["mode variation without a variation block", { ...valid, mode: "variation" }, /variation.count.*required/],
    ["a non-array layout", { ...valid, variation: { axes: { layout: "headline-top" } } }, /layout/],
    ["an invalid layout value", { ...valid, variation: { axes: { layout: ["sideways"] } } }, /layout/],
    ["a non-string layout value", { ...valid, variation: { axes: { layout: [1] } } }, /layout/],
    ["an invalid tone value", { ...valid, variation: { axes: { tone: ["loud"] } } }, /tone/],
    ["a non-array tone", { ...valid, variation: { axes: { tone: "bold" } } }, /tone/],
    ["an invalid anchor value", { ...valid, variation: { axes: { anchor: ["sideways"] } } }, /anchor/],
    ["a non-array anchor", { ...valid, variation: { axes: { anchor: "top" } } }, /anchor/],
    ["a non-string anchor value", { ...valid, variation: { axes: { anchor: [1] } } }, /anchor/],
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
    // A shift is a hue rotation in TURNS. 1 is a whole circle and means what 0 means, so
    // accepting it would let a brief ask for a full rotation and silently receive none.
    ["a whole-turn paletteShift", { ...valid, variation: { axes: { paletteShift: [1] } } }, /turns in \[0, 1\)/],
    ["a paletteShift past a whole turn", { ...valid, variation: { axes: { paletteShift: [1.25] } } }, /turns in \[0, 1\)/],
    // A negative shift is what made the editor's preview disagree with the render.
    ["a negative paletteShift", { ...valid, variation: { axes: { paletteShift: [-0.1] } } }, /turns in \[0, 1\)/],
    ["a wildly out-of-range paletteShift", { ...valid, variation: { axes: { paletteShift: [1e308] } } }, /turns in \[0, 1\)/],
    ["a non-number paletteShift entry", { ...valid, variation: { axes: { paletteShift: ["0.1"] } } }, /turns in \[0, 1\)/],
    ["a non-number paletteShift", { ...valid, variation: { axes: { paletteShift: ["0"] } } }, /paletteShift/],
    ["a non-object output", { ...valid, output: "x" }, /"output" must be an object/],
    ["an array output", { ...valid, output: [] }, /"output" must be an object/],
    ["a null output", { ...valid, output: null }, /"output" must be an object/],
    ["empty output.formats", { ...valid, output: { formats: [] } }, /formats/],
    ["a non-array output.formats", { ...valid, output: { formats: "static" } }, /formats/],
    ["a non-string format", { ...valid, output: { formats: [1] } }, /format/],
    ["empty output.platforms", { ...valid, output: { platforms: [] } }, /platforms/],
    ["a non-array output.platforms", { ...valid, output: { platforms: "instagram-feed" } }, /platforms/],
    ["an empty-string platform", { ...valid, output: { platforms: [""] } }, /platforms/],
    ["a non-string platform", { ...valid, output: { platforms: [1] } }, /platforms/],
  ])("rejects %s", (_label, input, message) => {
    // Structural rules only. The motion axis, duration axis and motion format are
    // capability rules, not structural ones: since D15 they parse cleanly in authoring
    // mode, and both modes are asserted in the two motion describes below.
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
    expect(() => parseRegenerateOnly([null])).toThrow(/require string/);
  });

  test("maps valid targets", () => {
    expect(parseRegenerateOnly([{ productId: "p", aspectRatio: "1:1", treatment: "default" }])).toEqual([
      { productId: "p", aspectRatio: "1:1", treatment: "default" },
    ]);
  });

  test("maps variation targets with optional attempt", () => {
    expect(parseRegenerateOnly([{ productId: "p", variantIndex: 0 }])).toEqual([
      { productId: "p", variantIndex: 0 },
    ]);
    expect(parseRegenerateOnly([{ productId: "p", variantIndex: 2, attempt: 1 }])).toEqual([
      { productId: "p", variantIndex: 2, attempt: 1 },
    ]);
  });

  test("rejects invalid variantIndex and attempt", () => {
    expect(() => parseRegenerateOnly([{ productId: "p", variantIndex: -1 }])).toThrow(/variantIndex/);
    expect(() => parseRegenerateOnly([{ productId: "p", variantIndex: 1.5 }])).toThrow(/variantIndex/);
    expect(() => parseRegenerateOnly([{ variantIndex: 0 }])).toThrow(/productId/);
    expect(() => parseRegenerateOnly([{ productId: "p", variantIndex: 0, attempt: -1 }])).toThrow(/attempt/);
    expect(() => parseRegenerateOnly([{ productId: "p", variantIndex: 0, attempt: 1.2 }])).toThrow(/attempt/);
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

const MOTION_ON = { motion: true } as const;
const MOTION_OFF = { motion: false, reason: "ffmpeg -version exited 1" } as const;

const motionBrief = (over: Record<string, unknown> = {}) => ({
  ...v2Brief,
  variation: { ...v2Brief.variation, axes: { ...staticAxes, motion: ["ken-burns-in", "headline-rise"], duration: [6] } },
  output: { formats: ["static", "motion"], platforms: ["instagram-feed", "instagram-reel"] },
  ...over,
});

describe("parseBrief motion allowlist (D8, gated on the ffmpeg capability)", () => {
  test("accepts motion, duration, formats: motion, and motion platforms when the capability is on", () => {
    const brief = parseBrief(motionBrief(), { capabilities: MOTION_ON, enforceCapabilities: true });
    expect(brief.variation?.axes?.motion).toEqual(["ken-burns-in", "headline-rise"]);
    expect(brief.variation?.axes?.duration).toEqual([6]);
    expect(brief.output?.formats).toEqual(["static", "motion"]);
    expect(brief.output?.platforms).toEqual(["instagram-feed", "instagram-reel"]);
    // Either axis alone is fine (duration defaults in the planner).
    expect(parseBrief(motionBrief({ variation: { count: 2, axes: { motion: ["accent-wipe"] } } }), { capabilities: MOTION_ON, enforceCapabilities: true }).variation?.axes?.duration).toBeUndefined();
    for (const id of ["instagram-story", "tiktok", "youtube-short"]) {
      expect(parseBrief(motionBrief({ output: { formats: ["motion"], platforms: [id] } }), { capabilities: MOTION_ON, enforceCapabilities: true }).output?.platforms).toEqual([id]);
    }
  });

  test.each([
    ["the motion axis", { ...valid, variation: { axes: { motion: ["ken-burns-in"] } } }, /axis "motion": motion output is unavailable \(ffmpeg -version exited 1\)/],
    ["the duration axis", { ...valid, variation: { axes: { duration: [6] } } }, /axis "duration": motion output is unavailable/],
    ["the motion format", { ...valid, output: { formats: ["motion"] } }, /format "motion": motion output is unavailable \(ffmpeg -version exited 1\)/],
    ["a motion platform", { ...valid, output: { platforms: ["instagram-reel"] } }, /platform "instagram-reel": motion output is unavailable/],
  ])("rejects %s with the probe reason when the capability is off", (_label, input, message) => {
    expect(() => parseBrief(input, { capabilities: MOTION_OFF, enforceCapabilities: true })).toThrow(message);
  });

  test("the default accessor is the boot probe snapshot (not probed → off) and a reasonless flag has a fallback", () => {
    expect(() => parseBrief(motionBrief(), { enforceCapabilities: true })).toThrow(/motion output is unavailable \(not probed\)/);
    expect(() => parseBrief(motionBrief(), { capabilities: { motion: false }, enforceCapabilities: true })).toThrow(/\(ffmpeg capability is off\)/);
  });

  test.each([
    ["an unknown motion kind", motionBrief({ variation: { count: 2, axes: { motion: ["spin"] } } }), /variation.axes.motion.*"spin"/],
    ["a non-array duration", motionBrief({ variation: { count: 2, axes: { duration: 6 } } }), /duration" must be an array/],
    ["a duration below 2", motionBrief({ variation: { count: 2, axes: { duration: [1] } } }), /between 2 and 30/],
    ["a duration above 30", motionBrief({ variation: { count: 2, axes: { duration: [31] } } }), /between 2 and 30/],
    ["a fractional duration", motionBrief({ variation: { count: 2, axes: { duration: [2.5] } } }), /between 2 and 30/],
    ["an unknown platform", motionBrief({ output: { platforms: ["myspace"] } }), /Unknown output platform "myspace"/],
    ["an unknown format", motionBrief({ output: { formats: ["gif"] } }), /Unsupported output format "gif"/],
  ])("rejects %s even with the capability on", (_label, input, message) => {
    expect(() => parseBrief(input, { capabilities: MOTION_ON, enforceCapabilities: true })).toThrow(message);
  });

  test.each([
    ["[static] + a motion-only platform", { formats: ["static"], platforms: ["instagram-reel"] }, /platform "instagram-reel" packages only \[motion\], which output.formats \[static\] does not request/],
    ["[motion] + a static-only platform", { formats: ["motion"], platforms: ["instagram-feed"] }, /platform "instagram-feed" packages only \[static\], which output.formats \[motion\] does not request/],
    ["no formats (static) + a motion-only platform", { platforms: ["instagram-reel"] }, /platform "instagram-reel" packages only \[motion\], which output.formats \[static\] does not request/],
    ["a format no requested platform packages", { formats: ["static", "motion"], platforms: ["instagram-reel"] }, /format "static" is requested but none of output.platforms \[instagram-reel\] can package it/],
  ])("rejects incompatible formats/platforms: %s", (_label, output, message) => {
    expect(() => parseBrief(motionBrief({ output }), { capabilities: MOTION_ON, enforceCapabilities: true })).toThrow(message);
  });

  test("accepts formats/platforms that agree: static, mixed, and motion-only", () => {
    const parse = (output: Record<string, unknown>) => parseBrief(motionBrief({ output }), { capabilities: MOTION_ON, enforceCapabilities: true }).output;
    expect(parse({ formats: ["static"], platforms: ["instagram-feed"] })?.formats).toEqual(["static"]);
    expect(parse({ formats: ["static", "motion"], platforms: ["instagram-feed", "tiktok"] })?.formats).toEqual(["static", "motion"]);
    expect(parse({ formats: ["motion"], platforms: ["instagram-reel", "youtube-short"] })?.formats).toEqual(["motion"]);
    // Platforms without formats keep the static default.
    expect(parse({ platforms: ["linkedin"] })?.platforms).toEqual(["linkedin"]);
  });

  test("formats: motion with an explicitly empty motion axis is rejected; an absent axis is accepted", () => {
    const empty = motionBrief({
      variation: { ...v2Brief.variation, axes: { ...staticAxes, motion: [] } },
      output: { formats: ["motion"], platforms: ["instagram-reel"] },
    });
    expect(() => parseBrief(empty, { capabilities: MOTION_ON, enforceCapabilities: true })).toThrow(
      /"variation.axes.motion" must select at least one motion kind when output.formats includes "motion"/,
    );
    const absent = motionBrief({
      variation: { ...v2Brief.variation, axes: staticAxes },
      output: { formats: ["motion"], platforms: ["instagram-reel"] },
    });
    expect(parseBrief(absent, { capabilities: MOTION_ON, enforceCapabilities: true }).variation?.axes?.motion).toBeUndefined();
    // Without the motion format an empty axis is merely inert.
    const inert = motionBrief({
      variation: { ...v2Brief.variation, axes: { ...staticAxes, motion: [] } },
      output: { formats: ["static"], platforms: ["instagram-feed"] },
    });
    expect(parseBrief(inert, { capabilities: MOTION_ON, enforceCapabilities: true }).output?.formats).toEqual(["static"]);
  });

  test("static platforms are accepted regardless of the capability; unknown ids are not", () => {
    expect(parseBrief({ ...valid, output: { platforms: ["instagram-feed", "linkedin", "x"] } }, { capabilities: MOTION_OFF, enforceCapabilities: true }).output?.platforms).toHaveLength(3);
    expect(() => parseBrief({ ...valid, output: { platforms: ["myspace"] } }, { capabilities: MOTION_OFF, enforceCapabilities: true })).toThrow(/Unknown output platform/);
  });

  test("loadBrief forwards the capability", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-brief-motion-"));
    try {
      const path = join(dir, "motion.json");
      writeFileSync(path, JSON.stringify(motionBrief()));
      await expect(loadBrief(path, { enforceCapabilities: true })).rejects.toThrow(/motion output is unavailable/);
      expect((await loadBrief(path, { capabilities: MOTION_ON, enforceCapabilities: true })).output?.formats).toEqual(["static", "motion"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseBrief D15 authoring vs enforcing mode", () => {
  const MOTION_OFF: Capabilities = { motion: false, reason: "test off" };
  const motionBriefWithAxis = motionBrief({ variation: { ...v2Brief.variation, axes: { motion: ["accent-wipe"] } } });
  const motionBriefWithFormat = motionBrief({ variation: { ...v2Brief.variation }, output: { formats: ["motion"] } });
  const motionPlatform = "instagram-reel"; // requires motion
  const motionBriefWithPlatform = motionBrief({ variation: { ...v2Brief.variation }, output: { formats: ["motion"], platforms: [motionPlatform] } });

  test("authoring mode (default) allows motion axis when capability is off", () => {
    const parsed = parseBrief(motionBriefWithAxis, { enforceCapabilities: false });
    expect(parsed.variation?.axes?.motion).toEqual(["accent-wipe"]);
  });

  test("authoring mode allows motion format when capability is off", () => {
    const parsed = parseBrief(motionBriefWithFormat, { enforceCapabilities: false });
    expect(parsed.output?.formats).toContain("motion");
  });

  test("authoring mode allows motion platform when capability is off", () => {
    const parsed = parseBrief(motionBriefWithPlatform, { enforceCapabilities: false });
    expect(parsed.output?.platforms).toContain(motionPlatform);
  });

  test("enforcing mode throws for motion axis when capability is off", () => {
    expect(() => parseBrief(motionBriefWithAxis, { capabilities: MOTION_OFF, enforceCapabilities: true })).toThrow(/Unsupported variation axis "motion": motion output is unavailable/);
  });

  test("enforcing mode throws for motion format when capability is off", () => {
    expect(() => parseBrief(motionBriefWithFormat, { capabilities: MOTION_OFF, enforceCapabilities: true })).toThrow(/Unsupported output format "motion": motion output is unavailable/);
  });

  test("enforcing mode throws for motion platform when capability is off", () => {
    expect(() => parseBrief(motionBriefWithPlatform, { capabilities: MOTION_OFF, enforceCapabilities: true })).toThrow(/Unsupported output format "motion": motion output is unavailable/);
  });

describe("motion requires a randomized campaign", () => {
  const classicMotion = { ...valid, output: { formats: ["motion"], platforms: ["instagram-reel"] } };

  test("run paths refuse a classic brief that requests motion — it would render stills", () => {
    expect(() => parseBrief(classicMotion, { capabilities: { motion: true }, enforceCapabilities: true })).toThrow(
      /requires mode "variation" — a classic campaign renders stills only/,
    );
  });

  test("authoring mode still accepts it, so the file stays listed and fixable", () => {
    expect(parseBrief(classicMotion).output?.formats).toEqual(["motion"]);
  });

  test("a randomized brief requesting motion is unaffected", () => {
    const randomized = {
      ...classicMotion,
      mode: "variation",
      variation: { count: 1, axes: { motion: ["ken-burns-in"], duration: [4] } },
    };
    expect(parseBrief(randomized, { capabilities: { motion: true }, enforceCapabilities: true }).mode).toBe("variation");
  });
});

});

const validTimeline = {
  transition: "fade" as const,
  keyBeat: 1,
  beats: [
    { text: "New season, new kit", weight: 2 },
    { text: "Built for the cold", weight: 3 },
    { text: "Shop now", weight: 2 },
  ],
};

const validMotionTimelineBrief = (over: Record<string, unknown> = {}) => ({
  ...motionBrief(),
  copy: {
    timeline: validTimeline,
  },
  ...over,
});

describe("parseBrief style block (T5)", () => {
  test("accepts a full style block with every vocabulary value at its bounds", () => {
    const brief = parseBrief({
      ...valid,
      style: {
        fontFamily: "Lora",
        fontWeight: 700,
        sizeScale: 0.12,
        lineHeight: 1.8,
        letterSpacing: 0.2,
        align: "right",
      },
    });
    expect(brief.style).toEqual({
      fontFamily: "Lora",
      fontWeight: 700,
      sizeScale: 0.12,
      lineHeight: 1.8,
      letterSpacing: 0.2,
      align: "right",
    });
  });

  test("accepts a partial style block and passes it through verbatim", () => {
    const brief = parseBrief({ ...valid, style: { align: "left" } });
    expect(brief.style).toEqual({ align: "left" });
  });

  test("a brief with no style block parses exactly as before", () => {
    expect(parseBrief(valid).style).toBeUndefined();
  });

  test("an empty style block is legal (every field defaults renderer-side)", () => {
    expect(parseBrief({ ...valid, style: {} }).style).toEqual({});
  });

  test("unknown style fields are rejected — style is validated, not tolerated", () => {
    expect(() => parseBrief({ ...valid, style: { famiy: "Lora" } })).toThrow(/Unsupported style field "famiy"/);
  });

  test("a non-object style block is rejected", () => {
    expect(() => parseBrief({ ...valid, style: "Lora" })).toThrow(/"style" must be an object/);
  });

  test.each([
    ["fontFamily", "Comic Sans", /"style\.fontFamily" must be one of Inter, Lora/],
    ["fontWeight", 500, /"style\.fontWeight" must be one of 400, 700/],
    ["fontWeight", "bold", /"style\.fontWeight" must be one of 400, 700/],
    ["sizeScale", 0.01, /"style\.sizeScale" must be a finite number in \[0\.02, 0\.12\]/],
    ["sizeScale", 0.5, /"style\.sizeScale" must be a finite number in \[0\.02, 0\.12\]/],
    ["sizeScale", "big", /"style\.sizeScale" must be a finite number in \[0\.02, 0\.12\]/],
    ["lineHeight", 0.9, /"style\.lineHeight" must be a finite number in \[1, 1\.8\]/],
    ["lineHeight", 2.5, /"style\.lineHeight" must be a finite number in \[1, 1\.8\]/],
    ["letterSpacing", 0.5, /"style\.letterSpacing" must be a finite number in \[-0\.05, 0\.2\]/],
    ["letterSpacing", -0.5, /"style\.letterSpacing" must be a finite number in \[-0\.05, 0\.2\]/],
    ["align", "justified", /"style\.align" must be one of left, center, right/],
  ])("rejects style.%s = %p", (field, value, message) => {
    expect(() => parseBrief({ ...valid, style: { [field]: value } })).toThrow(message);
  });
});

describe("parseBrief copy.timeline (E4.1 – E4.3)", () => {
  test("TIMELINE_TRANSITIONS locks the supported transition allowlist", () => {
    expect(TIMELINE_TRANSITIONS).toEqual(["cut", "fade"]);
  });

  describe("E4.1: accepts valid copy.timeline", () => {
    test("accepts a structurally valid timeline and preserves fields", () => {
      const brief = parseBrief(validMotionTimelineBrief());
      expect(brief.copy?.timeline).toEqual(validTimeline);
    });

    test("accepts transition: cut and optional keyBeat/transition defaults", () => {
      const cutBrief = parseBrief(
        validMotionTimelineBrief({
          copy: {
            timeline: {
              transition: "cut",
              keyBeat: 2,
              beats: [
                { text: "A", weight: 1 },
                { text: "B", weight: 2 },
              ],
            },
          },
        }),
      );
      expect(cutBrief.copy?.timeline?.transition).toBe("cut");
      expect(cutBrief.copy?.timeline?.keyBeat).toBe(2);

      // Omitted transition and keyBeat are structurally accepted
      const minimal = parseBrief(
        validMotionTimelineBrief({
          copy: {
            timeline: {
              beats: [
                { text: "A", weight: 1 },
                { text: "B", weight: 2 },
              ],
            },
          },
        }),
      );
      expect(minimal.copy?.timeline?.beats).toHaveLength(2);
      // The returned brief IS the CampaignBrief every caller goes on to use, and
      // CopyTimeline declares both fields required — defaulting them only inside the
      // validator would hand callers a value the domain says cannot exist.
      expect(minimal.copy?.timeline?.transition).toBe("fade");
      expect(minimal.copy?.timeline?.keyBeat).toBe(1);
    });

    test("accepts empty copy object (no timeline)", () => {
      const brief = parseBrief({ ...v2Brief, copy: {} });
      expect(brief.copy).toEqual({});
    });

    test("D11: authoring mode allows structurally sound timeline with dwell floor violation", () => {
      // weights [5, 1, 1] at 5s has thinnest beat at 5 * 1 / 7 = 0.71s < 1.2s floor
      const shortBeatsBrief = validMotionTimelineBrief({
        variation: {
          ...v2Brief.variation,
          axes: { ...staticAxes, motion: ["ken-burns-in"], duration: [5] },
        },
        copy: {
          timeline: {
            transition: "fade",
            keyBeat: 1,
            beats: [
              { text: "A", weight: 5 },
              { text: "B", weight: 1 },
              { text: "C", weight: 1 },
            ],
          },
        },
      });

      // Authoring mode (default / enforceCapabilities: false) allows it to save
      const parsed = parseBrief(shortBeatsBrief, { enforceCapabilities: false });
      expect(parsed.copy?.timeline?.beats).toHaveLength(3);

      // Running mode (enforceCapabilities: true) refuses it with dwell floor message from timelineProblem
      expect(() =>
        parseBrief(shortBeatsBrief, { capabilities: MOTION_ON, enforceCapabilities: true }),
      ).toThrow(/readability floor/);
    });

    test("running mode accepts valid timelines with explicit and defaulted fields", () => {
      // Explicit transition, keyBeat, and duration
      const explicit = parseBrief(
        validMotionTimelineBrief({
          variation: {
            ...v2Brief.variation,
            axes: { ...staticAxes, motion: ["ken-burns-in"], duration: [6] },
          },
          copy: {
            timeline: {
              transition: "cut",
              keyBeat: 2,
              beats: [
                { text: "A", weight: 1 },
                { text: "B", weight: 1 },
              ],
            },
          },
        }),
        { capabilities: MOTION_ON, enforceCapabilities: true },
      );
      expect(explicit.copy?.timeline?.transition).toBe("cut");
      expect(explicit.copy?.timeline?.keyBeat).toBe(2);

      // Defaulted transition, keyBeat, and omitted duration axis (falls back to DEFAULT_DURATION_SEC)
      const defaulted = parseBrief(
        validMotionTimelineBrief({
          variation: {
            ...v2Brief.variation,
            axes: { ...staticAxes, motion: ["ken-burns-in"] },
          },
          copy: {
            timeline: {
              beats: [
                { text: "A", weight: 1 },
                { text: "B", weight: 1 },
              ],
            },
          },
        }),
        { capabilities: MOTION_ON, enforceCapabilities: true },
      );
      expect(defaulted.copy?.timeline?.beats).toHaveLength(2);
      expect(defaulted.copy?.timeline?.transition).toBe("fade");
      expect(defaulted.copy?.timeline?.keyBeat).toBe(1);
      // The round trip: feeding the parsed timeline straight back to the domain check it
      // just passed must still pass. An absent keyBeat fails this.
      expect(timelineProblem(defaulted.copy!.timeline!, [6])).toBeUndefined();
    });

    test("D11: authoring mode allows timeline when motion capability is off; running mode refuses", () => {
      const brief = validMotionTimelineBrief();
      // Authoring mode: passes
      expect(parseBrief(brief, { capabilities: MOTION_OFF, enforceCapabilities: false }).copy?.timeline).toBeDefined();

      // Running mode: fails
      expect(() =>
        parseBrief(brief, { capabilities: MOTION_OFF, enforceCapabilities: true }),
      ).toThrow(/motion output is unavailable/);
    });
  });

  describe("E4.2: rejects structural violations naming offending path", () => {
    test.each([
      ["a non-object copy", { ...validMotionTimelineBrief(), copy: "invalid" }, /Campaign brief field "copy" must be an object/],
      ["a non-object copy.timeline", { ...validMotionTimelineBrief(), copy: { timeline: "invalid" } }, /Campaign brief field "copy.timeline" must be an object/],
      ["an unknown transition", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, transition: "slide" } } }), /Campaign brief field "copy.timeline.transition" must be "cut" or "fade"/],
      ["a non-string transition", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, transition: 123 } } }), /Campaign brief field "copy.timeline.transition" must be "cut" or "fade"/],
      ["non-array beats", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, beats: "invalid" } } }), /Campaign brief field "copy.timeline.beats" must be an array/],
      ["empty beats", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, beats: [] } } }), /copy\.timeline\.beats must not be empty/],
      [
        `more than MAX_BEATS (${MAX_BEATS}) beats`,
        validMotionTimelineBrief({
          copy: {
            timeline: {
              ...validTimeline,
              beats: Array.from({ length: MAX_BEATS + 1 }, (_, i) => ({ text: `Beat ${i + 1}`, weight: 1 })),
            },
          },
        }),
        /copy\.timeline\.beats holds more than 8 beats/,
      ],
      ["a non-object beat entry", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, beats: [null] } } }), /Campaign brief field "copy\.timeline\.beats\[0\]" must be an object/],
      ["a non-string beat text", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, beats: [{ text: 123, weight: 1 }] } } }), /Campaign brief field "copy\.timeline\.beats\[0\]\.text" must be a string/],
      ["a non-integer weight", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, beats: [{ text: "A", weight: 1.5 }] } } }), /copy\.timeline\.beats\[0\]\.weight must be an integer in \[1, 20\]/],
      ["a non-number weight", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, beats: [{ text: "A", weight: "2" }] } } }), /copy\.timeline\.beats\[0\]\.weight must be an integer in \[1, 20\]/],
      ["a weight below 1", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, beats: [{ text: "A", weight: 0 }] } } }), /copy\.timeline\.beats\[0\]\.weight must be an integer in \[1, 20\]/],
      ["a negative weight", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, beats: [{ text: "A", weight: -1 }] } } }), /copy\.timeline\.beats\[0\]\.weight must be an integer in \[1, 20\]/],
      ["a weight above MAX_WEIGHT", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, beats: [{ text: "A", weight: MAX_WEIGHT + 1 }] } } }), /copy\.timeline\.beats\[0\]\.weight must be an integer in \[1, 20\]/],
      ["an astronomical weight (1e308 overflow boundary)", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, beats: [{ text: "A", weight: 1e308 }] } } }), /copy\.timeline\.beats\[0\]\.weight must be an integer in \[1, 20\]/],
      ["a keyBeat below 1", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, keyBeat: 0 } } }), /copy\.timeline\.keyBeat must be an integer in \[1, 3\]/],
      ["a keyBeat above beats.length", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, keyBeat: 4 } } }), /copy\.timeline\.keyBeat must be an integer in \[1, 3\]/],
      ["a non-integer keyBeat", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, keyBeat: 1.5 } } }), /copy\.timeline\.keyBeat must be an integer in \[1, 3\]/],
      ["a non-number keyBeat", validMotionTimelineBrief({ copy: { timeline: { ...validTimeline, keyBeat: "1" } } }), /copy\.timeline\.keyBeat must be an integer in \[1, 3\]/],
    ])("rejects %s in authoring mode", (_label, input, message) => {
      expect(() => parseBrief(input, { enforceCapabilities: false })).toThrow(message);
    });
  });

  describe("E4.3: rejects invalid D5 combinations in authoring mode", () => {
    test("rejects copy.timeline together with axes.headline: pool://copy", () => {
      const conflictBrief = validMotionTimelineBrief({
        variation: {
          ...validMotionTimelineBrief().variation,
          axes: {
            ...validMotionTimelineBrief().variation.axes,
            headline: "pool://copy",
          },
        },
      });
      expect(() => parseBrief(conflictBrief, { enforceCapabilities: false })).toThrow(
        /Campaign brief cannot combine "copy\.timeline" with "variation\.axes\.headline"/,
      );
    });

    test("rejects copy.timeline on a classic brief (mode not variation)", () => {
      const classicWithTimeline = {
        ...valid,
        copy: { timeline: validTimeline },
        output: { formats: ["motion"], platforms: ["instagram-reel"] },
      };
      expect(() => parseBrief(classicWithTimeline, { enforceCapabilities: false })).toThrow(
        /Campaign brief field "copy\.timeline" requires motion output/,
      );
    });

    test("rejects copy.timeline on a variation brief without formats: motion", () => {
      const staticVariationWithTimeline = {
        ...v2Brief,
        copy: { timeline: validTimeline },
        output: { formats: ["static"], platforms: ["instagram-feed"] },
      };
      expect(() => parseBrief(staticVariationWithTimeline, { enforceCapabilities: false })).toThrow(
        /Campaign brief field "copy\.timeline" requires motion output/,
      );
    });

    test("rejects copy.timeline on a variation brief with omitted output.formats (defaults to static)", () => {
      const noFormatsVariationWithTimeline = {
        ...v2Brief,
        copy: { timeline: validTimeline },
        output: { platforms: ["instagram-feed"] },
      };
      expect(() => parseBrief(noFormatsVariationWithTimeline, { enforceCapabilities: false })).toThrow(
        /Campaign brief field "copy\.timeline" requires motion output/,
      );
    });
  });

  describe("Non-negotiable: all briefs/*.yaml load and non-timeline briefs parse identically", () => {
    test("loads every existing brief in briefs/*.yaml", async () => {
      const briefFiles = [
        "briefs/sample-campaign.yaml",
        "briefs/sample-campaign-orange.yaml",
        "briefs/sample-campaign-reuse.yaml",
        "briefs/sample-campaign-variants.yaml",
        "briefs/sample-motion.yaml",
        "briefs/sample-pooled.yaml",
        "briefs/sample-randomized.yaml",
      ];
      for (const file of briefFiles) {
        const loaded = await loadBrief(file);
        expect(loaded.id).toBeDefined();
        expect(loaded.copy?.timeline).toBeUndefined();
      }
    });

    test("a brief with no copy.timeline parses and serializes byte-for-byte as before", () => {
      const parsedClassic = parseBrief(valid);
      expect(parsedClassic.copy).toBeUndefined();

      const parsedV2 = parseBrief(v2Brief);
      expect(parsedV2.copy).toBeUndefined();
      expect(JSON.stringify(parsedV2)).toBe(JSON.stringify(v2Brief));
    });
  });
});
