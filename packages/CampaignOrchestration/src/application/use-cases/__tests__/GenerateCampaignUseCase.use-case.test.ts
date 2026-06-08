import { describe, test, expect, vi } from "vitest";
import { GenerateCampaignUseCase } from "../GenerateCampaignUseCase.use-case.js";
import type { GenerateCampaignDeps } from "../GenerateCampaignUseCase.use-case.js";
import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";
import type { Product } from "../../../domain/entities/Product.js";
import type { Treatment } from "../../../domain/value-objects/Treatment.vo.js";
import {
  fakeCompliance,
  fakeCompositor,
  fakeImageGenerator,
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
  compositor: fakeCompositor(),
  compliance: fakeCompliance(),
  exporter: recordingExporter(),
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
