import { describe, test, expect } from "vitest";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { dumpBrief } from "../dump-brief";

const brief: CampaignBrief = {
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
    expect(yaml).toContain('campaignMessage: "Stay wild. Stay hydrated."');
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
    } as unknown as CampaignBrief);
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
});
