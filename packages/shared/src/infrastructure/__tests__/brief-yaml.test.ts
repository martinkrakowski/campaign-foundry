import { describe, test, expect } from "vitest";
import { parse } from "yaml";
import { dumpBrief } from "../brief-yaml.js";

// Moved from `apps/web/src/components/campaign/__tests__/dump-brief.test.ts` (R4.3):
// the web fork of the serialiser was deleted, so its unit tests follow the one
// shared implementation. Two assertions were corrected, because they described the
// deleted fork's over-quoting contract rather than the real one: the fork quoted
// `campaignMessage` ("Stay wild. Stay hydrated.") with `quoteYamlScalar`, while the
// canonical writer — the `yaml` package's emitter at the 1.2 default schema — emits
// it plain, exactly as the API's canonical dump always did. `#1473E6` stays quoted
// (a plain scalar may not start with `#`). The deleted `quoteYamlScalar` tests have
// no surviving subject; quoting is now covered by the byte-for-byte round-trip
// corpus tests in `apps/api/server/lib/__tests__/brief-corpus.test.ts`.

const brief = {
  id: "camp",
  targetRegion: "DE",
  targetAudience: "fans",
  campaignMessage: "Stay wild. Stay hydrated.",
  localizedMessage: "Bleib wild",
  products: [
    {
      id: "alpha",
      name: "Alpha",
      primaryColor: "#1473E6",
      logoPath: "assets/inputs/a.png",
      inputAsset: "assets/inputs/bg.png",
    },
  ],
  mode: "variation",
  type: "short-video",
  variation: {
    count: 12,
    seed: 42,
    minDistance: 2,
    coverage: { perProduct: 1, perRatio: 1 },
    axes: {
      layout: ["headline-top", "headline-bottom"],
      tone: ["bold", "subtle"],
      background: { source: ["procedural"] },
      paletteShift: [0, 0.1, 0.2],
    },
  },
  output: { formats: ["static"], platforms: ["instagram-feed", "linkedin", "x"] },
};

describe("dumpBrief", () => {
  test("emits schemaVersion as the first key in canonical order (D133)", () => {
    const yaml = dumpBrief({ schemaVersion: 1, ...brief });
    expect(yaml.startsWith("schemaVersion: 1\n")).toBe(true);
    expect(yaml.indexOf("schemaVersion:")).toBeLessThan(yaml.indexOf("id:"));
  });

  test("emits template after schemaVersion and before id (D120, D123)", () => {
    const yaml = dumpBrief({
      schemaVersion: 1,
      template: {
        id: "canonical-image-text",
        version: 1,
        creativeType: "image-text",
        unit: "standard-web",
        layers: [{ id: "img", kind: "image" }],
      },
      ...brief,
    });
    expect(yaml.indexOf("schemaVersion:")).toBeLessThan(yaml.indexOf("template:"));
    expect(yaml.indexOf("template:")).toBeLessThan(yaml.indexOf("id:"));
  });

  test("emits canonical key order and quotes unsafe strings", () => {
    const yaml = dumpBrief(brief);
    expect(yaml.indexOf("id:")).toBeLessThan(yaml.indexOf("targetRegion:"));
    expect(yaml.indexOf("products:")).toBeLessThan(yaml.indexOf("mode:"));
    expect(yaml.indexOf("mode:")).toBeLessThan(yaml.indexOf("variation:"));
    // The campaign type (D108–D112) sits in canonical position between its
    // neighbours — the key still serialises if dropped from BRIEF_KEY_ORDER
    // (at the end, in remaining-keys order), so only a positional assertion
    // catches that mutation.
    expect(yaml.indexOf("mode:")).toBeLessThan(yaml.indexOf("type:"));
    expect(yaml.indexOf("type:")).toBeLessThan(yaml.indexOf("variation:"));
    expect(yaml).toContain("id: camp");
    expect(yaml).toContain("type: short-video");
    expect(yaml).toContain("campaignMessage: Stay wild. Stay hydrated.");
    expect(yaml).toContain('primaryColor: "#1473E6"');
    expect(yaml).toContain("- headline-top");
    expect(yaml).toContain("- static");
    expect(yaml).toContain("paletteShift:");
    expect(yaml).toContain("- 0.1");
  });

  test("skips undefined, dumps leftover keys, and handles empty / null / boolean values", () => {
    const yaml = dumpBrief({
      ...brief,
      localizedMessage: undefined,
      flag: true,
      empty: [],
      box: {},
      nada: null,
      nested: [1, [true], {}],
      ones: [{ id: "solo" }],
      partial: { keep: 1, drop: undefined },
      leftover: "z",
      skip: undefined,
      n: 1n,
    } as object);
    expect(yaml).not.toContain("localizedMessage:");
    expect(yaml).not.toContain("skip:");
    expect(yaml).toContain("flag: true");
    expect(yaml).toContain("empty: []");
    expect(yaml).toContain("box: {}");
    expect(yaml).toContain("nada: null");
    expect(yaml).toContain("leftover: z");
    expect(yaml).toContain("n: 1");
    expect(yaml).toContain("- 1");
    expect(yaml).toContain("- true");
    expect(yaml).toContain("- id: solo");
    expect(yaml).toContain("keep: 1");
    expect(yaml).not.toContain("drop:");
  });

  test("round-trips through the loader's schema — what is dumped parses back identical", () => {
    // One schema for load and dump (R4.3): the `yaml` package default, YAML 1.2.
    // A writer and a parser on different schemas is the real hazard, so the writer
    // is pinned to the same default the loader parses with.
    const dumped = dumpBrief(brief);
    expect(parse(dumped)).toEqual(brief);
  });

  test("a brief without type emits no type: line (D112 — existing briefs dump byte-for-byte as before)", () => {
    const withoutType: Record<string, unknown> = { ...brief };
    delete withoutType.type;
    const yaml = dumpBrief(withoutType);
    expect(yaml).not.toContain("type:");
    expect(yaml.indexOf("mode:")).toBeLessThan(yaml.indexOf("variation:"));
  });

  test("round-trips output.sizes (D113 — nested under output, already in key order)", () => {
    const withSizes = { ...brief, output: { ...brief.output, sizes: ["728x90"] } };
    const dumped = dumpBrief(withSizes);
    expect(parse(dumped)).toEqual(withSizes);
    expect(dumped).toContain("sizes:");
    expect(dumped).toContain("728x90");
  });

  test("a brief without output.sizes emits no sizes: line", () => {
    const yaml = dumpBrief(brief);
    expect(yaml).not.toMatch(/^\s*sizes:/m);
    expect(parse(yaml).output.sizes).toBeUndefined();
  });
});

describe("dumpBrief layer and props order (L3b, D134)", () => {
  // Layers written with their keys scrambled — and props written in reverse
  // union order — so the assertions below can only pass if the writer orders
  // them, not if the fixture happens to be ordered already.
  const templated = {
    ...brief,
    template: {
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [
        { kind: "image", id: "bg" },
        { kind: "shade", id: "tint", props: { alpha: 0.5 } },
        { kind: "accent", id: "band", props: { fadeHeight: 0.06, solidHeight: 0.05 } },
        { kind: "static-text", id: "head", props: { typeFloor: 0.4, anchor: "top" } },
        { kind: "logo", id: "mark", props: { margin: 0.04, width: 0 } },
      ],
    },
  };

  test("emits a layer's keys as id, kind, props", () => {
    const yaml = dumpBrief(templated);
    expect(yaml.indexOf("id: bg")).toBeLessThan(yaml.indexOf("kind: image"));
    expect(yaml.indexOf("id: tint")).toBeLessThan(yaml.indexOf("kind: shade"));
    expect(yaml.indexOf("kind: shade")).toBeLessThan(yaml.indexOf("props:"));
    expect(yaml.indexOf("props:")).toBeLessThan(yaml.indexOf("alpha: 0.5"));
  });

  test("emits props keys in the order the LayerProps union declares them", () => {
    const yaml = dumpBrief(templated);
    expect(yaml.indexOf("solidHeight:")).toBeLessThan(yaml.indexOf("fadeHeight:"));
    expect(yaml.indexOf("anchor:")).toBeLessThan(yaml.indexOf("typeFloor:"));
    expect(yaml.indexOf("width:")).toBeLessThan(yaml.indexOf("margin:"));
  });

  test("a shade layer's props round-trip through YAML verbatim", () => {
    const yaml = dumpBrief(templated);
    const parsed = parse(yaml) as typeof templated;
    expect(parsed.template.layers[1]).toEqual({ kind: "shade", id: "tint", props: { alpha: 0.5 } });
  });

  test("a layer key named after an Object.prototype member survives the dump", () => {
    // `constructor` is also an inherited member of the writer's accumulator;
    // an own layer key of that name must still be emitted (L3b review).
    const withPrototypeKey = {
      ...brief,
      template: {
        id: "canonical-image-text",
        version: 1,
        creativeType: "image-text",
        unit: "standard-web",
        layers: [{ id: "bg", kind: "image", constructor: "x" }],
      },
    };
    const yaml = dumpBrief(withPrototypeKey);
    expect(yaml).toContain("constructor: x");
    expect(parse(yaml)).toEqual(withPrototypeKey);
  });

  test("a template whose layers carry no props dumps and reparses exactly as today", () => {
    const propless = {
      ...brief,
      template: {
        id: "canonical-video",
        version: 1,
        creativeType: "video",
        unit: "standard-web",
        layers: [
          { id: "video", kind: "video" },
          { id: "shade", kind: "shade" },
          { id: "animated-text", kind: "animated-text" },
          { id: "logo", kind: "logo" },
        ],
      },
    };
    const yaml = dumpBrief(propless);
    expect(parse(yaml)).toEqual(propless);
    // Byte-stable: what parse reads back dumps again unchanged.
    expect(dumpBrief(parse(yaml) as object)).toBe(yaml);
  });

  test("entries the order cannot name pass through untouched", () => {
    // A template that is not an object with a layers array, a layer that is
    // not an object, and a props that is not an object are all emitted as
    // written — the writer reorders keys, it never validates them.
    const yaml = dumpBrief({
      ...brief,
      template: { id: "x", layers: ["junk", { id: "tint", kind: "shade", props: null }] },
    });
    expect(yaml).toContain("template:");
    expect(yaml).toContain("- junk");
    expect(yaml).toContain("props: null");
    expect(parse(yaml)).toEqual({
      ...brief,
      template: { id: "x", layers: ["junk", { id: "tint", kind: "shade", props: null }] },
    });
  });

  test("a disabled layer survives a YAML round trip in its declared key position (id, kind, enabled, props)", () => {
    const withDisabledLayer = {
      ...brief,
      template: {
        id: "canonical-image-text",
        version: 1,
        creativeType: "image-text",
        unit: "standard-web",
        layers: [
          { kind: "image", id: "bg" },
          // Keys deliberately scrambled to prove the writer orders them
          { props: { alpha: 0.5 }, enabled: false, kind: "shade", id: "tint" },
          { id: "band", kind: "accent", enabled: true },
        ],
      },
    };
    const yaml = dumpBrief(withDisabledLayer);
    // Declared key position: id, kind, enabled, props
    expect(yaml.indexOf("id: tint")).toBeLessThan(yaml.indexOf("kind: shade"));
    expect(yaml.indexOf("kind: shade")).toBeLessThan(yaml.indexOf("enabled: false"));
    expect(yaml.indexOf("enabled: false")).toBeLessThan(yaml.indexOf("props:"));
    expect(yaml.indexOf("props:")).toBeLessThan(yaml.indexOf("alpha: 0.5"));

    // Round-trip determinism and byte-identity
    const parsed = parse(yaml) as typeof withDisabledLayer;
    expect(parsed.template.layers[1]).toEqual({
      id: "tint",
      kind: "shade",
      enabled: false,
      props: { alpha: 0.5 },
    });
    expect(dumpBrief(parsed)).toBe(yaml);
  });

  test("a layer with no enabled behaves exactly as today — an existing brief round-trips byte-identically", () => {
    // templated has no enabled field on any layer; dumping and reparsing produces byte-identical YAML
    const yaml = dumpBrief(templated);
    expect(yaml).not.toContain("enabled:");
    const reparsed = parse(yaml) as typeof templated;
    expect(dumpBrief(reparsed)).toBe(yaml);
  });
});
