import { describe, test, expect, vi } from "vitest";
import { GenerateCampaignUseCase } from "../GenerateCampaignUseCase.use-case.js";
import type { GenerateCampaignDeps } from "../GenerateCampaignUseCase.use-case.js";
import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";
import type { Product } from "../../../domain/entities/Product.js";
import type { Variant } from "../../../domain/entities/Variant.js";
import type { Treatment } from "../../../domain/value-objects/Treatment.vo.js";
import {
  fakeCompliance,
  fakeCompositor,
  fakeImageGenerator,
  fakePlan,
  fakePlanner,
  fakeVariant,
  recordingExporter,
  type RecordingExporter,
} from "./_fakes.js";

const product = (id: string, over: Partial<Product> = {}): Product => ({
  id,
  name: id,
  primaryColor: "#1473E6",
  logoPath: `assets/inputs/${id}.png`,
  ...over,
});

const baseBrief = (over: Partial<CampaignBrief> = {}): CampaignBrief => ({
  id: "camp",
  targetRegion: "DE",
  targetAudience: "audience",
  campaignMessage: "Hello",
  products: [product("alpha"), product("beta")],
  ...over,
});

const TWO_TREATMENTS: Treatment[] = [
  { id: "bold-bottom", layout: "headline-bottom", tone: "bold" },
  { id: "subtle-top", layout: "headline-top", tone: "subtle" },
];

const deps = (over: Partial<GenerateCampaignDeps> = {}): GenerateCampaignDeps => ({
  imageGenerator: fakeImageGenerator(),
  proceduralGenerator: fakeImageGenerator(),
  planner: fakePlanner(),
  compositor: fakeCompositor(),
  compliance: fakeCompliance(),
  exporter: recordingExporter(),
  now: () => new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

describe("GenerateCampaignUseCase — validation", () => {
  test.each([
    ["a non-slug campaign id", baseBrief({ id: "Bad Id" }), /path-safe slug/],
    ["a non-slug product id", baseBrief({ products: [product("Alpha"), product("beta")] }), /Product ids must be path-safe/],
    ["duplicate product ids", baseBrief({ products: [product("alpha"), product("alpha")] }), /unique product ids/],
    ["fewer than two products", baseBrief({ products: [product("alpha")] }), /at least 2 unique products/],
    [
      "a non-slug treatment id",
      baseBrief({ treatments: [{ id: "Bad", layout: "headline-top", tone: "bold" }] }),
      /Treatment ids must be path-safe/,
    ],
    [
      "duplicate treatment ids",
      baseBrief({
        treatments: [
          { id: "dup", layout: "headline-top", tone: "bold" },
          { id: "dup", layout: "headline-bottom", tone: "subtle" },
        ],
      }),
      /unique treatment ids/,
    ],
  ])("rejects %s before touching any port", async (_label, brief, message) => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(brief);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(message);
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    expect(d.compositor.compositeAsset).not.toHaveBeenCalled();
  });

  test("accepts a single product with one unique id is still rejected (boundary)", async () => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief({ products: [product("solo")] }));
    expect(result.success).toBe(false);
  });
});

describe("GenerateCampaignUseCase — legal gate", () => {
  test("halts the run on prohibited copy without generating anything", async () => {
    const d = deps({ compliance: fakeCompliance({ legalPass: false }) });
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.halted).toBe(true);
      expect(result.value.assets).toEqual([]);
    }
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    const exporter = d.exporter as RecordingExporter;
    expect(exporter.saved).toHaveLength(0);
  });

  test("falls back to a default halt reason when the check supplies none", async () => {
    const compliance = {
      validateLegalCopy: vi.fn(async () => ({ passed: false })),
      validateBrandColorDensity: vi.fn(async () => ({ passed: true, score: 0.5 })),
    };
    const result = await new GenerateCampaignUseCase(deps({ compliance })).execute(baseBrief());
    if (result.success) {
      const halt = result.value.log.entries.find((e) => e.stage === "ExecuteLegalGateCheck");
      expect(halt?.message).toMatch(/prohibited terminology detected/);
    }
  });

  test("ignores an empty localized message rather than gating on it", async () => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(
      baseBrief({ campaignMessage: "Hello", localizedMessage: "" }),
    );
    expect(result.success).toBe(true);
    // Only the (non-empty) campaign message is checked.
    expect(d.compliance.validateLegalCopy).toHaveBeenCalledTimes(1);
  });

  test("checks the localized message too — halts when only it is prohibited", async () => {
    const compliance = {
      validateLegalCopy: vi.fn(async (text: string) =>
        text === "Bleib wild" ? { passed: false, reason: "bad" } : { passed: true },
      ),
      validateBrandColorDensity: vi.fn(async () => ({ passed: true, score: 0.5 })),
    };
    const result = await new GenerateCampaignUseCase(deps({ compliance })).execute(
      baseBrief({ campaignMessage: "Stay wild", localizedMessage: "Bleib wild" }),
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.halted).toBe(true);
    expect(compliance.validateLegalCopy).toHaveBeenCalledTimes(2);
  });
});

describe("GenerateCampaignUseCase — happy path", () => {
  test("produces the full product × ratio matrix for a single (default) treatment", async () => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief());
    expect(result.success).toBe(true);
    if (!result.success) return;

    // 2 products × 3 ratios × 1 default treatment = 6 creatives.
    expect(result.value.assets).toHaveLength(6);
    expect(result.value.halted).toBe(false);

    // Order is product → ratio → treatment, and paths are NOT namespaced by treatment.
    expect(result.value.assets.map((a) => a.outputPath)).toEqual([
      "alpha/1x1.png",
      "alpha/9x16.png",
      "alpha/16x9.png",
      "beta/1x1.png",
      "beta/9x16.png",
      "beta/16x9.png",
    ]);

    // One background resolved per (product × ratio) cell; one proof per product.
    expect(d.imageGenerator.resolveBackground).toHaveBeenCalledTimes(6);
    expect(d.compositor.compositeAsset).toHaveBeenCalledTimes(6);
    const exporter = d.exporter as RecordingExporter;
    expect(exporter.saved).toHaveLength(6);
    expect(exporter.proofs).toEqual(["proofs/alpha.pdf", "proofs/beta.pdf"]);

    // Per-asset fields are stamped from the port results.
    const first = result.value.assets[0];
    expect(first).toMatchObject({
      productId: "alpha",
      aspectRatio: "1:1",
      treatment: "default",
      backgroundSource: "procedural",
      complianceScore: 0.5,
      passedCompliance: true,
      logoApplied: true,
      proofPath: "proofs/alpha.pdf",
    });
  });

  test("namespaces output by treatment when a brief requests more than one", async () => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief({ treatments: TWO_TREATMENTS }));
    expect(result.success).toBe(true);
    if (!result.success) return;

    // 2 products × 3 ratios × 2 treatments = 12; backgrounds still resolved once per cell.
    expect(result.value.assets).toHaveLength(12);
    expect(d.imageGenerator.resolveBackground).toHaveBeenCalledTimes(6);
    expect(d.compositor.compositeAsset).toHaveBeenCalledTimes(12);
    expect(result.value.assets[0].outputPath).toBe("alpha/1x1/bold-bottom.png");
    expect(result.value.assets[1].outputPath).toBe("alpha/1x1/subtle-top.png");
  });

  test("the use case resolves the copy: localized message wins, else campaign message", async () => {
    const withLocale = deps();
    await new GenerateCampaignUseCase(withLocale).execute(
      baseBrief({ campaignMessage: "EN", localizedMessage: "DE" }),
    );
    expect(vi.mocked(withLocale.compositor.compositeAsset).mock.calls[0][0].message).toBe("DE");

    const noLocale = deps();
    await new GenerateCampaignUseCase(noLocale).execute(baseBrief({ campaignMessage: "EN" }));
    expect(vi.mocked(noLocale.compositor.compositeAsset).mock.calls[0][0].message).toBe("EN");
  });

  test("propagates the background source onto every asset and warns on procedural", async () => {
    const imagen = deps({ imageGenerator: fakeImageGenerator("imagen") });
    const imagenResult = await new GenerateCampaignUseCase(imagen).execute(baseBrief());
    if (imagenResult.success) {
      expect(imagenResult.value.assets.every((a) => a.backgroundSource === "imagen")).toBe(true);
      const warns = imagenResult.value.log.entries.filter((e) => e.level === "warn");
      expect(warns).toHaveLength(0);
    }

    const procedural = deps({ imageGenerator: fakeImageGenerator("procedural") });
    const proceduralResult = await new GenerateCampaignUseCase(procedural).execute(baseBrief());
    if (proceduralResult.success) {
      const proceduralWarn = proceduralResult.value.log.entries.find(
        (e) => e.stage === "ResolveBackgroundAssets" && e.level === "warn",
      );
      expect(proceduralWarn?.message).toMatch(/procedural fallback/);
    }
  });

  test("records a warn when a creative misses its logo or fails density", async () => {
    const d = deps({
      compositor: fakeCompositor(false),
      compliance: fakeCompliance({ density: 0.001 }),
    });
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief());
    if (!result.success) return;
    expect(result.value.assets[0].passedCompliance).toBe(false);
    expect(result.value.assets[0].logoApplied).toBe(false);
    const compositeWarn = result.value.log.entries.find(
      (e) => e.stage === "CompositeVariations" && e.level === "warn",
    );
    expect(compositeWarn?.message).toMatch(/below threshold|logo missing/);
  });

  test("defaults the compliance score to 0 when the check returns none", async () => {
    const d = deps({ compliance: fakeCompliance({ scoreless: true }) });
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief());
    if (result.success) expect(result.value.assets[0].complianceScore).toBe(0);
  });

  test("counts only the operations the run will touch", async () => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief());
    if (result.success) expect(result.value.log.totalOperations).toBe(6);
  });
});

describe("GenerateCampaignUseCase — selective regeneration", () => {
  test("regenerates only the targeted cell and rewrites its proof when it is the hero", async () => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief(), {
      regenerateOnly: [{ productId: "alpha", aspectRatio: "1:1", treatment: "default" }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.value.assets.map((a) => a.outputPath)).toEqual(["alpha/1x1.png"]);
    expect(d.imageGenerator.resolveBackground).toHaveBeenCalledTimes(1);
    // The 1:1 first-treatment cell is the proof hero, so alpha's proof is rewritten.
    expect((d.exporter as RecordingExporter).proofs).toEqual(["proofs/alpha.pdf"]);
  });

  test("does not rewrite a product's proof when the targeted cell is not its hero", async () => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief(), {
      regenerateOnly: [{ productId: "alpha", aspectRatio: "16:9", treatment: "default" }],
    });
    if (!result.success) return;
    expect(result.value.assets.map((a) => a.outputPath)).toEqual(["alpha/16x9.png"]);
    expect((d.exporter as RecordingExporter).proofs).toEqual([]);
  });

  test("ignores variation-shaped targets on a classic run", async () => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief(), {
      regenerateOnly: [{ productId: "alpha", variantIndex: 0 }],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.assets).toEqual([]);
  });

  test("an empty target list is a no-op run (no cells, no proofs)", async () => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief(), { regenerateOnly: [] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.assets).toEqual([]);
    expect(result.value.halted).toBe(false);
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    expect((d.exporter as RecordingExporter).proofs).toEqual([]);
  });
});

const variationBrief = (over: Partial<CampaignBrief> = {}): CampaignBrief =>
  baseBrief({ mode: "variation", variation: { count: 3, seed: 42 }, ...over });

describe("GenerateCampaignUseCase — variation", () => {
  test("allows a single-product variation brief", async () => {
    const variants = [fakeVariant(), fakeVariant({ index: 1, aspectRatio: "9:16" })];
    const d = deps({ planner: fakePlanner(fakePlan(variants)) });
    const result = await new GenerateCampaignUseCase(d).execute(
      variationBrief({ products: [product("alpha")] }),
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.assets).toHaveLength(2);
  });

  test("composites a variant's pooled headline, else the resolved copy", async () => {
    const variants = [fakeVariant({ headline: "Stay wild" }), fakeVariant({ index: 1, aspectRatio: "9:16" })];
    const d = deps({ planner: fakePlanner(fakePlan(variants)) });
    const result = await new GenerateCampaignUseCase(d).execute(
      variationBrief({ localizedMessage: "Bleib wild" }),
    );
    expect(result.success).toBe(true);
    const messages = vi.mocked(d.compositor.compositeAsset).mock.calls.map((call) => call[0].message);
    expect(messages).toEqual(["Stay wild", "Bleib wild"]);
    // Provenance: the drawn headline is stamped on the descriptor (and so the report); absent otherwise.
    if (!result.success) return;
    expect(result.value.assets[0].descriptor).toMatchObject({ headline: "Stay wild" });
    expect(result.value.assets[1].descriptor).not.toHaveProperty("headline");
  });

  test("legal-gates every distinct pooled headline and halts like a prohibited campaign message", async () => {
    const compliance = {
      validateLegalCopy: vi.fn(async (text: string) =>
        text.includes("miracle") ? { passed: false, reason: "Prohibited terminology: miracle" } : { passed: true },
      ),
      validateBrandColorDensity: vi.fn(async () => ({ passed: true, score: 0.5 })),
    };
    const variants = [
      fakeVariant({ headline: "Stay wild" }),
      fakeVariant({ index: 1, aspectRatio: "9:16", headline: "A miracle cure" }),
      fakeVariant({ index: 2, aspectRatio: "16:9", headline: "Stay wild" }),
    ];
    const d = deps({ compliance, planner: fakePlanner(fakePlan(variants)) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toMatchObject({ halted: true, assets: [] });
    expect(result.value.policyHash).toBeUndefined();
    // Campaign copy first, then each distinct pooled headline once.
    expect(compliance.validateLegalCopy.mock.calls.map((call) => call[0])).toEqual([
      "Hello",
      "Stay wild",
      "A miracle cure",
    ]);
    expect(d.compositor.compositeAsset).not.toHaveBeenCalled();
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    const halt = result.value.log.entries.filter((e) => e.stage === "ExecuteLegalGateCheck").at(-1);
    expect(halt).toMatchObject({ level: "error", message: "Pipeline halted — Prohibited terminology: miracle" });
    expect(result.value.log.completedAt).toBeDefined();
  });

  test("classic still requires two products", async () => {
    const result = await new GenerateCampaignUseCase(deps()).execute(baseBrief({ products: [product("alpha")] }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/at least 2 unique products/);
  });

  test("produces count assets with v<index> paths, descriptor, and plan provenance", async () => {
    const variants = [
      fakeVariant({ index: 0, aspectRatio: "1:1" }),
      fakeVariant({ index: 1, productId: "beta", aspectRatio: "9:16", layout: "headline-top", tone: "subtle" }),
      fakeVariant({ index: 2, aspectRatio: "16:9", backgroundSource: "genai", paletteShift: 0.1 }),
    ];
    const d = deps({ planner: fakePlanner(fakePlan(variants)) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.value.assets).toHaveLength(3);
    expect(result.value.assets.map((a) => a.outputPath)).toEqual([
      "alpha/1x1/v0.png",
      "beta/9x16/v1.png",
      "alpha/16x9/v2.png",
    ]);
    expect(result.value.assets[0]).toMatchObject({
      variantIndex: 0,
      attempt: 0,
      seed: 1,
      format: "static",
      treatment: "headline-bottom-bold",
      descriptor: {
        layout: "headline-bottom",
        tone: "bold",
        backgroundSource: "procedural",
        paletteShift: 0,
      },
    });
    expect(result.value.policyHash).toBe("hash");
    expect(result.value.seed).toBe(42);
    expect(result.value.log.totalOperations).toBe(3);
    expect((d.exporter as RecordingExporter).proofs).toEqual(["proofs/alpha.pdf"]);
  });

  test("returns a planner error without touching generation ports", async () => {
    const d = deps({ planner: fakePlanner(new Error("Variation plan shortfall: accepted 1 of count 12")) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/shortfall/);
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    expect(d.proceduralGenerator.resolveBackground).not.toHaveBeenCalled();
  });

  test("routes procedural cells to proceduralGenerator and genai/asset-pool to imageGenerator", async () => {
    const variants = [
      fakeVariant({ index: 0, backgroundSource: "procedural" }),
      fakeVariant({ index: 1, productId: "beta", backgroundSource: "genai" }),
      fakeVariant({ index: 2, productId: "beta", aspectRatio: "9:16", backgroundSource: "asset-pool" }),
    ];
    const d = deps({ planner: fakePlanner(fakePlan(variants)) });
    await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(d.proceduralGenerator.resolveBackground).toHaveBeenCalledTimes(1);
    expect(d.imageGenerator.resolveBackground).toHaveBeenCalledTimes(2);
    const ctx = vi.mocked(d.proceduralGenerator.resolveBackground).mock.calls[0][2];
    expect(ctx.seed).toBe(1);
    expect(ctx.paletteShift).toBe(0);
  });

  test("passes layout and tone from the variant to the compositor", async () => {
    const d = deps({
      planner: fakePlanner(
        fakePlan([fakeVariant({ layout: "headline-top", tone: "subtle", paletteShift: 0.2 })]),
      ),
    });
    await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(vi.mocked(d.compositor.compositeAsset).mock.calls[0][0]).toMatchObject({
      layout: "headline-top",
      tone: "subtle",
    });
  });

  test("regenerateOnly + variantIndex calls replan with attempt and generates only those slots", async () => {
    const variants = [
      fakeVariant({ index: 0 }),
      fakeVariant({ index: 1, productId: "beta", aspectRatio: "9:16" }),
      fakeVariant({ index: 2, aspectRatio: "16:9" }),
    ];
    const planner = fakePlanner(fakePlan(variants));
    const d = deps({ planner });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "beta", variantIndex: 1, attempt: 3 }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(planner.replan).toHaveBeenCalledTimes(1);
    expect(planner.replan).toHaveBeenCalledWith(expect.anything(), 1, 3);
    expect(result.value.assets).toHaveLength(1);
    expect(result.value.assets[0].outputPath).toBe("beta/9x16/v1.png");
    expect(result.value.assets[0].seed).toBe(103); // attempt + 100 from the fake
    expect(result.value.assets[0].attempt).toBe(3);
    expect(d.proceduralGenerator.resolveBackground).toHaveBeenCalledTimes(1);
  });

  test("regenerateOnly defaults omitted attempt to 1 (first re-roll)", async () => {
    const planner = fakePlanner(fakePlan([fakeVariant(), fakeVariant({ index: 1, productId: "beta" })]));
    const d = deps({ planner });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "alpha", variantIndex: 0 }],
    });
    expect(planner.replan).toHaveBeenCalledWith(expect.anything(), 0, 1);
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.assets[0].attempt).toBe(1);
  });

  test("rejects a re-roll whose attempt is < 1", async () => {
    const planner = fakePlanner(fakePlan([fakeVariant()]));
    const d = deps({ planner });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "alpha", variantIndex: 0, attempt: 0 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/attempt must be an integer >= 1/);
    expect(planner.replan).not.toHaveBeenCalled();
  });

  test("returns a replan error without generating", async () => {
    const planner = fakePlanner(fakePlan([fakeVariant()]));
    planner.replan = vi.fn(() => ({ success: false as const, error: new Error("replan exhausted") }));
    const d = deps({ planner });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "alpha", variantIndex: 0, attempt: 1 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/replan exhausted/);
    expect(d.proceduralGenerator.resolveBackground).not.toHaveBeenCalled();
  });

  test("fails loud when the plan references an unknown product", async () => {
    const d = deps({ planner: fakePlanner(fakePlan([fakeVariant({ productId: "ghost" })])) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/unknown product "ghost"/);
  });

  test("fails loud when the plan references an unsupported ratio", async () => {
    const d = deps({
      planner: fakePlanner(fakePlan([fakeVariant({ aspectRatio: "21:9" as Variant["aspectRatio"] })])),
    });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/Unsupported aspect ratio/);
  });

  test("classic-only regenerateOnly targets on a variation brief are an error", async () => {
    const planner = fakePlanner(fakePlan([fakeVariant(), fakeVariant({ index: 1, productId: "beta" })]));
    const d = deps({ planner });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "alpha", aspectRatio: "1:1", treatment: "default" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/targets do not match the brief mode/);
    expect(planner.replan).not.toHaveBeenCalled();
    expect(d.proceduralGenerator.resolveBackground).not.toHaveBeenCalled();
  });

  test("rejects a variation target whose productId does not match the planned slot", async () => {
    const planner = fakePlanner(fakePlan([fakeVariant(), fakeVariant({ index: 1, productId: "beta" })]));
    const d = deps({ planner });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "beta", variantIndex: 0, attempt: 1 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/productId "beta"/);
      expect(result.error.message).toMatch(/slot 0/);
    }
    expect(planner.replan).not.toHaveBeenCalled();
  });

  test("rejects a variation target whose variantIndex is out of range", async () => {
    const planner = fakePlanner(fakePlan([fakeVariant()]));
    const d = deps({ planner });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "alpha", variantIndex: 4, attempt: 1 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/Invalid variant index 4/);
    expect(planner.replan).not.toHaveBeenCalled();
  });

  test("rejects a non-integer or negative variantIndex and a fractional attempt", async () => {
    const planner = fakePlanner(fakePlan([fakeVariant()]));
    const d = deps({ planner });
    const fractional = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "alpha", variantIndex: 1.5, attempt: 1 }],
    });
    expect(fractional.success).toBe(false);
    const negative = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "alpha", variantIndex: -1, attempt: 1 }],
    });
    expect(negative.success).toBe(false);
    const badAttempt = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "alpha", variantIndex: 0, attempt: 1.5 }],
    });
    expect(badAttempt.success).toBe(false);
    if (!badAttempt.success) expect(badAttempt.error.message).toMatch(/attempt must be an integer >= 1/);
    expect(planner.replan).not.toHaveBeenCalled();
  });

  test("de-duplicates regenerateOnly targets by variantIndex", async () => {
    const planner = fakePlanner(
      fakePlan([fakeVariant(), fakeVariant({ index: 1, productId: "beta", aspectRatio: "9:16" })]),
    );
    const d = deps({ planner });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [
        { productId: "alpha", variantIndex: 0, attempt: 1 },
        { productId: "alpha", variantIndex: 0, attempt: 2 },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(planner.replan).toHaveBeenCalledTimes(1);
    expect(planner.replan).toHaveBeenCalledWith(expect.anything(), 0, 1);
    expect(result.value.assets).toHaveLength(1);
  });

  test("re-roll keeps productId, aspectRatio, and outputPath of the slot", async () => {
    const planner = fakePlanner(
      fakePlan([
        fakeVariant({ index: 0, aspectRatio: "9:16" }),
        fakeVariant({ index: 1, productId: "beta", aspectRatio: "1:1" }),
      ]),
    );
    const d = deps({ planner });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "alpha", variantIndex: 0, attempt: 1 }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.assets[0]).toMatchObject({
      productId: "alpha",
      aspectRatio: "9:16",
      outputPath: "alpha/9x16/v0.png",
      variantIndex: 0,
      attempt: 1,
    });
  });

  test("print proof is pinned to the first 1:1 variant of each product in plan order", async () => {
    const variants = [
      fakeVariant({ index: 0, aspectRatio: "16:9" }),
      fakeVariant({ index: 1, aspectRatio: "1:1" }),
      fakeVariant({ index: 2, aspectRatio: "1:1" }),
      fakeVariant({ index: 3, productId: "beta", aspectRatio: "1:1" }),
    ];
    const d = deps({ planner: fakePlanner(fakePlan(variants)) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(true);
    expect((d.exporter as RecordingExporter).proofs).toEqual(["proofs/alpha.pdf", "proofs/beta.pdf"]);
  });

  test("re-rolling a non-pinned 1:1 variant does not rewrite the product proof", async () => {
    const variants = [
      fakeVariant({ index: 0, aspectRatio: "1:1" }),
      fakeVariant({ index: 1, aspectRatio: "1:1" }),
      fakeVariant({ index: 2, productId: "beta", aspectRatio: "1:1" }),
    ];
    const d = deps({ planner: fakePlanner(fakePlan(variants)) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "alpha", variantIndex: 1, attempt: 1 }],
    });
    expect(result.success).toBe(true);
    expect((d.exporter as RecordingExporter).proofs).toEqual([]);
  });

  test("re-rolling the pinned 1:1 variant rewrites that product's proof", async () => {
    const variants = [
      fakeVariant({ index: 0, aspectRatio: "1:1" }),
      fakeVariant({ index: 1, aspectRatio: "1:1" }),
    ];
    const d = deps({ planner: fakePlanner(fakePlan(variants)) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "alpha", variantIndex: 0, attempt: 1 }],
    });
    expect(result.success).toBe(true);
    expect((d.exporter as RecordingExporter).proofs).toEqual(["proofs/alpha.pdf"]);
  });

  test("warns on procedural variation backgrounds and records a missing logo", async () => {
    const d = deps({
      planner: fakePlanner(fakePlan([fakeVariant()])),
      compositor: fakeCompositor(false),
      compliance: fakeCompliance({ density: 0.001 }),
    });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.assets[0].passedCompliance).toBe(false);
    expect(result.value.assets[0].logoApplied).toBe(false);
    const line = result.value.log.entries.find((e) => e.stage === "CompositeVariations");
    expect(line?.message).toMatch(/below threshold/);
    expect(line?.message).toMatch(/logo missing/);
  });

  test("defaults a scoreless variation density check to 0", async () => {
    const d = deps({
      planner: fakePlanner(fakePlan([fakeVariant()])),
      compliance: fakeCompliance({ scoreless: true }),
    });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.assets[0].complianceScore).toBe(0);
  });

  test("records an info log when a variation background is not procedural", async () => {
    const d = deps({
      planner: fakePlanner(fakePlan([fakeVariant({ backgroundSource: "genai" })])),
      imageGenerator: fakeImageGenerator("imagen"),
    });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(true);
    if (!result.success) return;
    const line = result.value.log.entries.find((e) => e.stage === "ResolveBackgroundAssets");
    expect(line?.level).toBe("info");
  });
});
