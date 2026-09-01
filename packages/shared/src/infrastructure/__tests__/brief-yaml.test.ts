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
  test("emits canonical key order and quotes unsafe strings", () => {
    const yaml = dumpBrief(brief);
    expect(yaml.indexOf("id:")).toBeLessThan(yaml.indexOf("targetRegion:"));
    expect(yaml.indexOf("products:")).toBeLessThan(yaml.indexOf("mode:"));
    expect(yaml.indexOf("mode:")).toBeLessThan(yaml.indexOf("variation:"));
    expect(yaml).toContain("id: camp");
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
});
