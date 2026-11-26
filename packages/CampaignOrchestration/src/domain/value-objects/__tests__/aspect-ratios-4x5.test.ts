import { describe, test, expect, vi } from "vitest";
import { DEFAULT_RATIO_VALUES, RATIO_VALUES, nearestRatioForAspect } from "../aspect-ratios.js";
import { AspectRatio } from "../AspectRatio.vo.js";
import { VariationPolicy, type PlanInput } from "../VariationPolicy.vo.js";
import { nodeCryptoPolicyHasher } from "../../../infrastructure/index.js";
import type { CampaignBrief } from "../../entities/CampaignBrief.js";
import type { Product } from "../../entities/Product.js";
import type { Variant } from "../../entities/Variant.js";
import { BRIEF_SCHEMA_VERSION } from "../brief-schema-version.js";
import { DEFAULT_CAMPAIGN_TYPE } from "../campaign-types.js";
import { templateFromCanonical } from "../brief-template.js";
import {
  GenerateCampaignUseCase,
  type GenerateCampaignDeps,
} from "../../../application/use-cases/GenerateCampaignUseCase.use-case.js";
import {
  fakeAudioAssets,
  fakeCompliance,
  fakeCompositor,
  fakeImageGenerator,
  fakePlan,
  fakePlanner,
  fakeSceneAssets,
  fakeVariant,
  fakeVideoCompositor,
  recordingExporter,
} from "../../../application/use-cases/__tests__/_fakes.js";

/**
 * RW-3, lifted (2026-11-26): `"4:5"` (1080×1350) joins the ratio VOCABULARY
 * (`RATIO_VALUES`) but NOT the defaults (`DEFAULT_RATIO_VALUES`). Every brief
 * or policy that does not explicitly pin `axes.ratio` keeps resolving to
 * `["1:1", "9:16", "16:9"]`, so `policyHash` and the classic campaign matrix
 * are unchanged — the same conditional-spread reasoning D57 applied to the
 * anchor axis.
 */

describe("the 4:5 vocabulary fork with frozen defaults", () => {
  test("DEFAULT_RATIO_VALUES is strictly the original three, in order", () => {
    expect([...DEFAULT_RATIO_VALUES]).toEqual(["1:1", "9:16", "16:9"]);
  });

  test("AspectRatio.defaults() maps DEFAULT_RATIO_VALUES; all() maps the vocabulary", () => {
    expect(AspectRatio.defaults().map((r) => r.value)).toEqual([...DEFAULT_RATIO_VALUES]);
    expect(AspectRatio.all().map((r) => r.value)).toEqual(["1:1", "9:16", "16:9", "4:5"]);
  });

  test("4:5 resolves to 1080x1350 and joins the vocabulary", () => {
    const r = AspectRatio.create("4:5");
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.value.value).toBe("4:5");
      expect(r.value.width).toBe(1080);
      expect(r.value.height).toBe(1350);
      expect(r.value.slug).toBe("4x5");
    }
    expect([...RATIO_VALUES]).toContain("4:5");
  });

  test("nearestRatioForAspect iterates the defaults, so 0.8 and 0.75 resolve as before", () => {
    // |0.8 - 1.0| = 0.2 beats |0.8 - 0.5625| = 0.2375 — and 4:5 (0.8) must NOT
    // become a candidate or 0.8 would flip to "4:5" and move cache keys.
    expect(nearestRatioForAspect(0.8)).toBe("1:1");
    // |0.75 - 0.5625| = 0.1875 beats |0.75 - 1.0| = 0.25.
    expect(nearestRatioForAspect(0.75)).toBe("9:16");
  });
});

describe("VariationPolicy keeps its hash on the frozen defaults", () => {
  const product = (id: string): Product => ({
    id,
    name: id,
    primaryColor: "#1473E6",
    logoPath: `assets/inputs/${id}-logo.png`,
  });

  // The fixture shape of briefs/sample-*.yaml — the only hashed fields are the
  // resolved policy axes, so reconstructing them reproduces the golden hashes
  // pinned in apps/api/server/lib/__tests__/policy-hash-stability.test.ts.
  const fixtureBrief = (over: Partial<CampaignBrief> = {}): CampaignBrief => ({
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id: "sample",
    targetRegion: "DE",
    targetAudience: "Urban outdoor enthusiasts, 25-40",
    campaignMessage: "Stay wild. Stay hydrated.",
    products: [product("hydra-bottle"), product("trail-pack")],
    mode: "variation",
    ...over,
  });

  const randomized = fixtureBrief({
    id: "sample-randomized",
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
  });

  const motion = fixtureBrief({
    id: "sample-motion",
    variation: {
      count: 8,
      seed: 3,
      minDistance: 2,
      coverage: { perProduct: 1, perRatio: 1 },
      axes: {
        layout: ["headline-top", "headline-bottom"],
        tone: ["bold", "subtle"],
        background: { source: ["procedural"] },
        paletteShift: [0, 0.1],
        motion: ["ken-burns-in", "headline-rise"],
        duration: [6],
      },
    },
    output: { formats: ["static", "motion"], platforms: ["instagram-feed", "instagram-reel"] },
  });

  const POOL_TEXTS = ["Every trail deserves a cold sip.", "Stay wild. Stay hydrated."];
  const pooled = fixtureBrief({
    id: "sample-pooled",
    variation: {
      count: 12,
      seed: 7,
      minDistance: 2,
      coverage: { perProduct: 1, perRatio: 1 },
      axes: {
        layout: ["headline-top", "headline-bottom"],
        tone: ["bold", "subtle"],
        background: { source: ["procedural"] },
        paletteShift: [0, 0.1],
        headline: "pool://copy",
      },
    },
    output: { formats: ["static"], platforms: ["instagram-feed", "linkedin", "x"] },
  });

  // Golden literals restated from policy-hash-stability.test.ts (T4/D57).
  const GOLDEN_HASHES: Record<string, string> = {
    "sample-motion.yaml": "f7291c1016b5d2c4b3b1ff363b86629ffc7c923c66720f98c16cedb5f70b79fb",
    "sample-randomized.yaml": "9f738749b56900e8fb399cad847f079478d116cbc09286f767438e44dc722846",
    "sample-pooled.yaml": "beb5a8cdb07c5bb94fef66f4e89a0ece83a97d994493af521e5b197a782bcf6b",
  };

  test("an unpinned brief resolves to the pre-4:5 golden hashes", () => {
    const fromBrief = (b: CampaignBrief, input: PlanInput = {}) =>
      VariationPolicy.fromBrief(b, input, nodeCryptoPolicyHasher);

    const randomizedPolicy = fromBrief(randomized);
    expect(randomizedPolicy.success).toBe(true);
    if (randomizedPolicy.success) {
      expect(randomizedPolicy.value.ratios).toEqual(["1:1", "9:16", "16:9"]);
      expect(randomizedPolicy.value.policyHash).toBe(GOLDEN_HASHES["sample-randomized.yaml"]);
    }

    const motionPolicy = fromBrief(motion);
    expect(motionPolicy.success).toBe(true);
    if (motionPolicy.success) {
      expect(motionPolicy.value.ratios).toEqual(["1:1", "9:16", "16:9"]);
      expect(motionPolicy.value.policyHash).toBe(GOLDEN_HASHES["sample-motion.yaml"]);
    }

    const pooledPolicy = fromBrief(pooled, { headlines: POOL_TEXTS });
    expect(pooledPolicy.success).toBe(true);
    if (pooledPolicy.success) {
      expect(pooledPolicy.value.ratios).toEqual(["1:1", "9:16", "16:9"]);
      expect(pooledPolicy.value.policyHash).toBe(GOLDEN_HASHES["sample-pooled.yaml"]);
    }
  });

  test('pinning ratios: ["4:5"] resolves it and hashes differently from the default', () => {
    const result = VariationPolicy.fromBrief(
      randomized,
      { ratios: ["4:5"] },
      nodeCryptoPolicyHasher,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.ratios).toEqual(["4:5"]);
    const unpinned = VariationPolicy.fromBrief(randomized, {}, nodeCryptoPolicyHasher);
    expect(unpinned.success).toBe(true);
    if (!unpinned.success) return;
    expect(result.value.policyHash).not.toBe(unpinned.value.policyHash);
  });
});

describe("4:5 refusals", () => {
  const product = (id: string): Product => ({
    id,
    name: id,
    primaryColor: "#1473E6",
    logoPath: `assets/inputs/${id}.png`,
  });

  const brief = (over: Partial<CampaignBrief> = {}): CampaignBrief => ({
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id: "golden",
    targetRegion: "DE",
    targetAudience: "audience",
    campaignMessage: "Hello",
    products: [product("alpha"), product("beta")],
    ...over,
  });

  const fromBrief = (b: CampaignBrief, input: PlanInput = {}) =>
    VariationPolicy.fromBrief(b, input, nodeCryptoPolicyHasher);

  test("AspectRatio.create rejects unsupported ratios, naming the full vocabulary", () => {
    for (const value of ["4:3", ""]) {
      const r = AspectRatio.create(value);
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.message).toBe(
          `Unsupported aspect ratio "${value}" (expected one of 1:1, 9:16, 16:9, 4:5)`,
        );
      }
    }
  });

  test("a non-array or null ratios input is refused, never iterated or treated as absent", () => {
    for (const ratios of ["4:5", null] as unknown as PlanInput["ratios"][]) {
      const result = fromBrief(brief({ variation: { count: 4 } }), { ratios });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe("Invalid variation.axes.ratio: expected an array.");
      }
    }
  });

  test("an explicitly empty selection is refused as the author's", () => {
    const result = fromBrief(brief({ variation: { count: 4 } }), { ratios: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        "Invalid variation.axes.ratio: select at least one aspect ratio (expected one of 1:1, 9:16, 16:9, 4:5).",
      );
    }
  });

  test("an unsupported entry in ratios names the value and the full vocabulary", () => {
    const result = fromBrief(brief({ variation: { count: 4 } }), {
      ratios: ["4:3"] as unknown as PlanInput["ratios"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Invalid variation.axes.ratio: "4:3" is not a supported aspect ratio (expected one of 1:1, 9:16, 16:9, 4:5).',
      );
    }
  });

  test("a motion-only brief pinning 4:5 that motionRatios excludes names both sets", () => {
    const motionOnly = brief({
      variation: { count: 4, axes: { motion: ["ken-burns-in"], duration: [4] } },
      output: { formats: ["motion"], platforms: ["instagram-reel"] },
    });
    const result = fromBrief(motionOnly, { ratios: ["4:5"], motionRatios: ["9:16"] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'output.formats requests only "motion", which the requested platforms package at [9:16], but variation.axes.ratio selects [4:5] — select one of those ratios or add the static format.',
      );
    }
  });
});

describe("GenerateCampaignUseCase keeps the frozen classic matrix and renders pinned 4:5", () => {
  const product = (id: string): Product => ({
    id,
    name: id,
    primaryColor: "#1473E6",
    logoPath: `assets/inputs/${id}.png`,
  });

  const baseBrief = (over: Partial<CampaignBrief> = {}): CampaignBrief => ({
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id: "camp",
    targetRegion: "DE",
    targetAudience: "audience",
    campaignMessage: "Hello",
    products: [product("alpha"), product("beta")],
    ...over,
  });

  const deps = (over: Partial<GenerateCampaignDeps> = {}): GenerateCampaignDeps => ({
    imageGenerator: fakeImageGenerator(),
    proceduralGenerator: fakeImageGenerator(),
    planner: fakePlanner(),
    compositor: fakeCompositor(),
    videoCompositor: fakeVideoCompositor(),
    sceneAssets: fakeSceneAssets(),
    audioAssets: fakeAudioAssets(),
    compliance: fakeCompliance(),
    exporter: recordingExporter(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  });

  /** Every ratio either generator was asked for, in call order (call[1] is the AspectRatio). */
  const asked = (d: GenerateCampaignDeps): string[] =>
    [
      ...vi.mocked(d.imageGenerator.resolveBackground).mock.calls,
      ...vi.mocked(d.proceduralGenerator.resolveBackground).mock.calls,
    ].map((call) => (call[1] as { value: string }).value);

  test("an unpinned classic brief renders the three default ratios only", async () => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief());
    expect(result.success).toBe(true);
    const askedRatios = [...new Set(asked(d))].sort();
    expect(askedRatios).toEqual(["16:9", "1:1", "9:16"]);
    expect(askedRatios).not.toContain("4:5");
  });

  test("a variation brief pinning 4:5 renders 4:5 only", async () => {
    const d = deps({
      planner: fakePlanner(fakePlan([fakeVariant({ aspectRatio: "4:5" })])),
    });
    const result = await new GenerateCampaignUseCase(d).execute(
      baseBrief({
        mode: "variation",
        variation: { count: 3, seed: 42, axes: { ratio: ["4:5"] } },
      }),
    );
    expect(result.success).toBe(true);
    expect([...new Set(asked(d))].sort()).toEqual(["4:5"]);
  });

  test("an invalid ratio reaching execute fails before any port is called", async () => {
    const d = deps({
      planner: fakePlanner(
        fakePlan([fakeVariant({ aspectRatio: "4:3" as unknown as Variant["aspectRatio"] })]),
      ),
    });
    const result = await new GenerateCampaignUseCase(d).execute(
      baseBrief({ mode: "variation", variation: { count: 3, seed: 42 } }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Unsupported aspect ratio "4:3" (expected one of 1:1, 9:16, 16:9, 4:5)',
      );
    }
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    expect(d.proceduralGenerator.resolveBackground).not.toHaveBeenCalled();
    expect(d.compositor.compositeAsset).not.toHaveBeenCalled();
  });
});
