import { describe, test, expect, vi } from "vitest";
import { GenerateCampaignUseCase, unionSafeInsets, unionSizeInsets } from "../GenerateCampaignUseCase.use-case.js";
import type { GenerateCampaignDeps } from "../GenerateCampaignUseCase.use-case.js";
import type { PlatformSafeZone, PlatformSafeZoneResolver } from "../../ports/out/PlatformProfilePort.js";
import type { CompositeRequest } from "../../ports/out/CompositorPort.js";
import { resolveCanvas } from "../../../domain/value-objects/aspect-ratios.js";
import { BRIEF_SCHEMA_VERSION } from "../../../domain/value-objects/brief-schema-version.js";
import { DEFAULT_CAMPAIGN_TYPE } from "../../../domain/value-objects/campaign-types.js";
import { templateFromCanonical, type BriefTemplate } from "../../../domain/value-objects/brief-template.js";
import { CANONICAL_TEMPLATES } from "../../../domain/value-objects/creative-templates.js";
import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";
import type { Product } from "../../../domain/entities/Product.js";
import type { Variant } from "../../../domain/entities/Variant.js";
import type { Treatment } from "../../../domain/value-objects/Treatment.vo.js";
import { resolveTimeline } from "../../../domain/value-objects/CopyTimeline.vo.js";
import type { CopyTimeline } from "../../../domain/value-objects/CopyTimeline.vo.js";
import { DEFAULT_DURATION_SEC } from "../../../domain/value-objects/variation-defaults.js";
import {
  fakeCompliance,
  fakeCompositor,
  fakeImageGenerator,
  fakePlan,
  fakePlanner,
  fakeVariant,
  fakeVideoCompositor,
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
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(over.type ?? DEFAULT_CAMPAIGN_TYPE),
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
  videoCompositor: fakeVideoCompositor(),
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
    ["zero products", baseBrief({ products: [] }), /at least one unique product/],
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
    [
      "an out-of-range style.sizeScale (a programmatic brief the parser never saw, T5)",
      baseBrief({ style: { sizeScale: 9 } }),
      /"style\.sizeScale" must be a finite number in \[0\.02, 0\.12\]/,
    ],
  ])("rejects %s before touching any port", async (_label, brief, message) => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(brief);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(message);
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    expect(d.compositor.compositeAsset).not.toHaveBeenCalled();
  });

  test("accepts a classic brief with exactly one product (boundary)", async () => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief({ products: [product("solo")] }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.assets.length).toBeGreaterThan(0);
    expect(result.value.assets.every((a) => a.productId === "solo")).toBe(true);
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

describe("GenerateCampaignUseCase — display sizes (A4b)", () => {
  /**
   * A stub compositor that honours the canvas it receives: the returned bytes
   * are a header PNG whose IHDR records `resolveCanvas`'s dimensions, so the
   * output's pixel size is assertable with no real generator behind the port.
   * Only the IHDR is read — nothing in this suite decodes the image.
   */
  const headerPng = (width: number, height: number): Uint8Array => {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG signature
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13); // IHDR chunk length
    bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
    view.setUint32(16, width);
    view.setUint32(20, height);
    bytes.set([8, 6, 0, 0, 0], 24); // bit depth, colour, compression, filter, interlace
    return bytes;
  };

  /** The existing PNG-size read (preview-frame.test.ts's IHDR offsets), named. */
  const pngSize = (bytes: Uint8Array): { width: number; height: number } => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  };

  const canvasHonouringCompositor = () => {
    const inner = fakeCompositor();
    // Every rendered output, with the canvas that produced it — the same bytes
    // the exporter saves, so the PNG's pixel dimensions are assertable.
    const outputs: Array<{ canvas: CompositeRequest["canvas"]; image: Uint8Array }> = [];
    const compositeAsset = vi.fn(async (request: CompositeRequest) => {
      const { width, height } = resolveCanvas(request.canvas);
      const image = headerPng(width, height);
      outputs.push({ canvas: request.canvas, image });
      return { image, logoApplied: true };
    });
    return { ...inner, compositeAsset, outputs };
  };

  /** A3's google-display profile, as the composition root's resolver would hand it over. */
  const googleDisplayZones: PlatformSafeZoneResolver = (id) =>
    id === "google-display"
      ? {
          safeInsets: { top: 0, right: 0, bottom: 0, left: 0 },
          formats: ["static"],
          sizes: [
            { size: "300x250", insets: { top: 8, right: 8, bottom: 8, left: 8 } },
            { size: "728x90", insets: { top: 0, right: 0, bottom: 0, left: 0 } },
          ],
        }
      : undefined;

  const displayBrief = (over: Partial<CampaignBrief> = {}): CampaignBrief =>
    baseBrief({
      output: { platforms: ["google-display"], sizes: ["728x90", "300x250"] },
      ...over,
    });

  test("renders the requested size cells at their exact pixels alongside the social ratios", async () => {
    const compositor = canvasHonouringCompositor();
    const d = deps({ compositor, platformSafeZones: googleDisplayZones });
    const result = await new GenerateCampaignUseCase(d).execute(displayBrief());
    expect(result.success).toBe(true);
    if (!result.success) return;

    // 2 products × (3 ratios + 2 sizes) = 10 creatives; ratios still render.
    expect(result.value.assets).toHaveLength(10);
    const canvases = vi
      .mocked(d.compositor.compositeAsset)
      .mock.calls.map((call) => call[0].canvas);
    expect(canvases).toContainEqual({ size: "728x90" });
    expect(canvases).toContainEqual({ size: "300x250" });
    expect(canvases).toContainEqual({ ratio: "1:1" });
    expect(canvases).toContainEqual({ ratio: "9:16" });
    expect(canvases).toContainEqual({ ratio: "16:9" });

    // The output PNG's IHDR carries the display unit's own dimensions (D113: never scaled).
    const saved = (compositor as { outputs: Array<{ canvas: CompositeRequest["canvas"]; image: Uint8Array }> }).outputs;
    const leaderboard = saved.find((s) => s.canvas.size === "728x90");
    const rectangle = saved.find((s) => s.canvas.size === "300x250");
    expect(leaderboard).toBeDefined();
    expect(rectangle).toBeDefined();
    expect(pngSize(leaderboard!.image)).toEqual({ width: 728, height: 90 });
    expect(pngSize(rectangle!.image)).toEqual({ width: 300, height: 250 });
    // The exporter saved exactly those renders.
    const exporter = d.exporter as RecordingExporter;
    expect(exporter.saved.map((s) => s.path)).toContain("alpha/728x90.png");
    expect(exporter.saved.map((s) => s.path)).toContain("alpha/300x250.png");

    // Display assets carry their size, not a ratio; ratio assets are untouched.
    const leaderboardAsset = result.value.assets.find((a) => a.outputPath === "alpha/728x90.png");
    expect(leaderboardAsset).toMatchObject({ productId: "alpha", size: "728x90", treatment: "default" });
    expect(leaderboardAsset).not.toHaveProperty("aspectRatio");
    const ratioAsset = result.value.assets.find((a) => a.outputPath === "alpha/1x1.png");
    expect(ratioAsset).toMatchObject({ productId: "alpha", aspectRatio: "1:1", treatment: "default" });
    expect(ratioAsset).not.toHaveProperty("size");
  });

  test("composites display cells with the display profile's insets for that size (F5)", async () => {
    const d = deps({ compositor: canvasHonouringCompositor(), platformSafeZones: googleDisplayZones });
    const result = await new GenerateCampaignUseCase(d).execute(displayBrief());
    expect(result.success).toBe(true);
    if (!result.success) return;
    const requests = vi.mocked(d.compositor.compositeAsset).mock.calls.map((call) => call[0]);
    const bySize = (size: string) => requests.filter((r) => r.canvas.size === size);
    // 300x250 takes the profile's 8 px inset; 728x90 takes its (present) zeros;
    // ratio cells still receive no insets on the classic path.
    expect(bySize("300x250")[0].safeInsets).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
    expect(bySize("728x90")[0].safeInsets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(requests.find((r) => r.canvas.ratio === "1:1")).not.toHaveProperty("safeInsets");
  });

  test("a size no requested platform offers renders without insets", async () => {
    const d = deps({ platformSafeZones: googleDisplayZones });
    const result = await new GenerateCampaignUseCase(d).execute(
      baseBrief({ output: { platforms: ["instagram-feed"], sizes: ["728x90"] } }),
    );
    expect(result.success).toBe(true);
    const request = vi.mocked(d.compositor.compositeAsset).mock.calls.find(
      (call) => call[0].canvas.size === "728x90",
    );
    expect(request).toBeDefined();
    expect(request![0]).not.toHaveProperty("safeInsets");
  });

  test("counts size cells in totalOperations", async () => {
    const d = deps({ platformSafeZones: googleDisplayZones });
    const result = await new GenerateCampaignUseCase(d).execute(displayBrief());
    // Assert success first: a failed generation must fail this test, not silently
    // skip the totalOperations assertion.
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.log.totalOperations).toBe(10);
  });

  test("duplicate output.sizes collapse to one cell per size, never two cells on one path", async () => {
    const d = deps({ platformSafeZones: googleDisplayZones });
    const result = await new GenerateCampaignUseCase(d).execute(
      baseBrief({ output: { platforms: ["google-display"], sizes: ["728x90", "728x90"] } }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    // 2 products × (3 ratios + 1 deduped size) = 8 creatives.
    expect(result.value.assets).toHaveLength(8);
    expect(result.value.assets.filter((a) => a.size === "728x90")).toHaveLength(2);
    expect(result.value.assets.map((a) => a.outputPath).filter((p) => p === "alpha/728x90.png")).toHaveLength(1);
    expect(result.value.log.totalOperations).toBe(8);
  });

  test("regenerates a targeted display cell by its size identity", async () => {
    const d = deps({ platformSafeZones: googleDisplayZones });
    const result = await new GenerateCampaignUseCase(d).execute(displayBrief(), {
      regenerateOnly: [{ productId: "alpha", size: "728x90", treatment: "default" }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.assets.map((a) => a.outputPath)).toEqual(["alpha/728x90.png"]);
    // Not the 1:1 hero, so no proof is rewritten.
    expect((d.exporter as RecordingExporter).proofs).toEqual([]);
  });

  test("rejects an unknown display size before touching any port", async () => {
    const d = deps();
    // A programmatic brief that bypassed parsing — the exact caller this
    // defense-in-depth check exists for — so the type is deliberately forged.
    const output = { sizes: ["999x99"] } as unknown as NonNullable<CampaignBrief["output"]>;
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief({ output }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/output\.sizes entry "999x99" is not a display size/);
    }
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    expect(d.compositor.compositeAsset).not.toHaveBeenCalled();
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

  test("randomized-only targets on a classic brief are an error, not a silent no-op", async () => {
    // This used to "succeed" with zero assets: every cell was skipped and the run
    // reported completion having regenerated nothing. The targets came from a run
    // produced under the other mode — the user needs to be told, and told what to do.
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief(), {
      regenerateOnly: [{ productId: "alpha", variantIndex: 0 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/came from a randomized run, but the brief is now a classic campaign/);
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
  });

  test("a mixed target list is refused on a classic brief — nothing is silently dropped", async () => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief(), {
      regenerateOnly: [
        { productId: "alpha", aspectRatio: "1:1", treatment: "default" },
        { productId: "alpha", variantIndex: 0 },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/came from a randomized run/);
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
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

  test("threads a drawn anchor into the composite request and descriptor, absent otherwise (T4)", async () => {
    const variants = [fakeVariant({ anchor: "middle" }), fakeVariant({ index: 1, aspectRatio: "9:16" })];
    const d = deps({ planner: fakePlanner(fakePlan(variants)) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(true);
    const requests = vi.mocked(d.compositor.compositeAsset).mock.calls.map((call) => call[0]);
    expect(requests[0]).toMatchObject({ anchor: "middle" });
    expect(requests[1]).not.toHaveProperty("anchor");
    if (!result.success) return;
    expect(result.value.assets[0].descriptor).toMatchObject({ anchor: "middle" });
    expect(result.value.assets[1].descriptor).not.toHaveProperty("anchor");
  });

  test("threads the brief's style into every composite request, classic and variation (T5)", async () => {
    const style = { fontFamily: "Lora" as const, align: "left" as const };
    // Classic: every treatment cell renders with the brief's style.
    const classicD = deps();
    await new GenerateCampaignUseCase(classicD).execute(baseBrief({ style }));
    const classicRequests = vi.mocked(classicD.compositor.compositeAsset).mock.calls.map((call) => call[0]);
    expect(classicRequests.length).toBeGreaterThan(0);
    for (const request of classicRequests) {
      expect(request.style).toEqual(style);
    }
    // Variation: every variant cell renders with the brief's style.
    const variationD = deps({ planner: fakePlanner(fakePlan([fakeVariant(), fakeVariant({ index: 1 })])) });
    await new GenerateCampaignUseCase(variationD).execute(variationBrief({ style }));
    const variationRequests = vi.mocked(variationD.compositor.compositeAsset).mock.calls.map((call) => call[0]);
    expect(variationRequests.length).toBeGreaterThan(0);
    for (const request of variationRequests) {
      expect(request.style).toEqual(style);
    }
    // A style-less brief requests nothing — the renderer's defaults stand (D54).
    const plainD = deps();
    await new GenerateCampaignUseCase(plainD).execute(baseBrief());
    for (const request of vi.mocked(plainD.compositor.compositeAsset).mock.calls.map((call) => call[0])) {
      expect(request.style).toBeUndefined();
    }
  });

  test("threads the brief's template into every composite request — classic, variation static and motion (C3)", async () => {
    // A template whose order differs from the canonical image-text list, so
    // this can only pass if the resolved list came from the brief, not a
    // canonical fallback that happens to agree.
    const template = {
      id: "canonical-image-text" as const,
      version: 1,
      creativeType: "image-text" as const,
      unit: "standard-web" as const,
      layers: [
        { id: "image", kind: "image" as const },
        { id: "accent", kind: "accent" as const },
        { id: "shade", kind: "shade" as const },
        { id: "static-text", kind: "static-text" as const },
        { id: "logo", kind: "logo" as const },
      ],
    };
    // Classic: every treatment cell's request carries the brief's template.
    const classicD = deps();
    await new GenerateCampaignUseCase(classicD).execute(baseBrief({ template }));
    const classicRequests = vi.mocked(classicD.compositor.compositeAsset).mock.calls.map((call) => call[0]);
    expect(classicRequests.length).toBeGreaterThan(0);
    for (const request of classicRequests) {
      expect(request.template).toEqual(template);
    }
    // Variation, static slot: same template rides the variant's request.
    const variationD = deps({ planner: fakePlanner(fakePlan([fakeVariant()])) });
    await new GenerateCampaignUseCase(variationD).execute(variationBrief({ template }));
    const variationRequests = vi.mocked(variationD.compositor.compositeAsset).mock.calls.map((call) => call[0]);
    expect(variationRequests.length).toBeGreaterThan(0);
    for (const request of variationRequests) {
      expect(request.template).toEqual(template);
    }
    // Variation, motion slot: the video port receives the same template.
    const motionD = deps({
      planner: fakePlanner(fakePlan([fakeVariant({ motion: "ken-burns-in", durationSec: 6 })])),
    });
    await new GenerateCampaignUseCase(motionD).execute(variationBrief({ template }));
    expect(motionD.videoCompositor.compositeVideo).toHaveBeenCalledWith(
      expect.objectContaining({ template }),
    );
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

  test("classic still refuses zero products — the floor is 1, never 0", async () => {
    const result = await new GenerateCampaignUseCase(deps()).execute(baseBrief({ products: [] }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/at least one unique product/);
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
    if (!result.success) expect(result.error.message).toMatch(/came from a classic run, but the brief is now a randomized campaign/);
    expect(planner.replan).not.toHaveBeenCalled();
    expect(d.proceduralGenerator.resolveBackground).not.toHaveBeenCalled();
  });

  test("a mixed target list is refused on a randomized brief — nothing is silently dropped", async () => {
    const planner = fakePlanner(fakePlan([fakeVariant(), fakeVariant({ index: 1, productId: "beta" })]));
    const d = deps({ planner });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [
        { productId: "alpha", variantIndex: 0, attempt: 1 },
        { productId: "alpha", aspectRatio: "1:1", treatment: "default" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/came from a classic run/);
    expect(planner.replan).not.toHaveBeenCalled();
  });

  test("an empty target list is a no-op run on a randomized brief too", async () => {
    const planner = fakePlanner(fakePlan([fakeVariant()]));
    const d = deps({ planner });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), { regenerateOnly: [] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.assets).toEqual([]);
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

  test("a still removes the slot's mp4 (a re-rolled motion slot leaves no stale clip)", async () => {
    const d = deps({ planner: fakePlanner(fakePlan([fakeVariant({ index: 0, aspectRatio: "9:16" })])) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "alpha", variantIndex: 0, attempt: 1 }],
    });
    expect(result.success).toBe(true);
    expect((d.exporter as RecordingExporter).removed).toEqual(["alpha/9x16/v0.mp4"]);
  });

  test("a static variation row keeps the pre-motion key order (reports stay byte-identical)", async () => {
    const d = deps({ planner: fakePlanner(fakePlan([fakeVariant()])) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.value.assets[0])).toEqual([
      "productId",
      "aspectRatio",
      "outputPath",
      "proofPath",
      "complianceScore",
      "passedCompliance",
      "logoApplied",
      "treatment",
      "backgroundSource",
      "variantIndex",
      "attempt",
      "seed",
      "format",
      "descriptor",
    ]);
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

const motionVariant = (over: Partial<Variant> = {}): Variant =>
  fakeVariant({ motion: "ken-burns-in", durationSec: 6, ...over });

const firstCompositeCall = (d: GenerateCampaignDeps): Record<string, unknown> =>
  vi.mocked(d.compositor.compositeAsset).mock.calls[0][0] as unknown as Record<string, unknown>;

describe("GenerateCampaignUseCase — motion variants", () => {
  test("encodes a motion variant through the video port and saves mp4 + poster", async () => {
    const variants = [motionVariant(), fakeVariant({ index: 1, aspectRatio: "9:16" })];
    const d = deps({ planner: fakePlanner(fakePlan(variants)) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(d.videoCompositor.compositeVideo).toHaveBeenCalledTimes(1);
    expect(d.videoCompositor.compositeVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        durationSec: 6,
        fps: 30,
        motion: "ken-burns-in",
        sampleAt: [0, 0.25, 0.5, 0.75, 1],
        layout: "headline-bottom",
        tone: "bold",
      }),
    );
    // The still compositor only ran for the static slot.
    expect(d.compositor.compositeAsset).toHaveBeenCalledTimes(1);
    // Cells run concurrently, so assert membership rather than interleaving order.
    const saved = (d.exporter as RecordingExporter).saved;
    expect(saved).toHaveLength(3);
    expect(saved).toEqual(
      expect.arrayContaining([
        { path: "alpha/1x1/v0.mp4", bytes: 4 },
        { path: "alpha/1x1/v0.png", bytes: 3 },
        { path: "alpha/9x16/v1.png", bytes: 3 },
      ]),
    );
    expect(result.value.assets[0]).toMatchObject({
      outputPath: "alpha/1x1/v0.png",
      videoPath: "alpha/1x1/v0.mp4",
      durationSec: 6,
      format: "motion",
      complianceScore: 0.5,
      passedCompliance: true,
      logoApplied: true,
      descriptor: { layout: "headline-bottom", motion: "ken-burns-in", durationSec: 6 },
    });
    expect(result.value.assets[1]).toMatchObject({ format: "static" });
    expect(result.value.assets[1]).not.toHaveProperty("videoPath");
    // Only the still slot clears a clip; the motion slot just wrote its own.
    expect((d.exporter as RecordingExporter).removed).toEqual(["alpha/9x16/v1.mp4"]);
    // Every sampled frame was brand-checked (5) plus the one static composite.
    expect(d.compliance.validateBrandColorDensity).toHaveBeenCalledTimes(6);
    expect(result.value.log.entries.some((e) => /ken-burns-in 6s/.test(e.message) && e.level === "info")).toBe(true);
  });

  test("records the minimum sampled-frame score and fails the asset when one frame fails", async () => {
    const d = deps({
      planner: fakePlanner(fakePlan([motionVariant()])),
      compliance: fakeCompliance({ densities: [0.5, 0.4, 0.01, 0.6, 0.3] }),
    });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.assets[0]).toMatchObject({ complianceScore: 0.01, passedCompliance: false });
    expect(result.value.log.entries.some((e) => /below threshold/.test(e.message) && e.level === "warn")).toBe(true);
  });

  test("a scoreless frame counts as 0 and a missing logo warns", async () => {
    const d = deps({
      planner: fakePlanner(fakePlan([motionVariant()])),
      compliance: fakeCompliance({ scoreless: true }),
      videoCompositor: fakeVideoCompositor({ logoApplied: false }),
    });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.assets[0]).toMatchObject({ complianceScore: 0, passedCompliance: true, logoApplied: false });
    expect(result.value.log.entries.some((e) => /logo missing/.test(e.message) && e.level === "warn")).toBe(true);
  });

  test("no sampled frames is no evidence: the asset fails with score 0", async () => {
    const d = deps({
      planner: fakePlanner(fakePlan([motionVariant()])),
      videoCompositor: fakeVideoCompositor({ frames: 0 }),
    });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.assets[0]).toMatchObject({ complianceScore: 0, passedCompliance: false });
    expect(d.compliance.validateBrandColorDensity).not.toHaveBeenCalled();
  });

  test("a motion variant without durationSec encodes the domain default duration", async () => {
    const d = deps({ planner: fakePlanner(fakePlan([motionVariant({ durationSec: undefined })])) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(true);
    expect(d.videoCompositor.compositeVideo).toHaveBeenCalledWith(
      expect.objectContaining({ durationSec: DEFAULT_DURATION_SEC }),
    );
    if (result.success) expect(result.value.assets[0].durationSec).toBe(DEFAULT_DURATION_SEC);
  });

  test("a pinned 1:1 motion variant proofs from its poster; a non-pinned one does not", async () => {
    const variants = [motionVariant({ index: 0 }), motionVariant({ index: 1 })];
    const d = deps({ planner: fakePlanner(fakePlan(variants)) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief());
    expect(result.success).toBe(true);
    expect((d.exporter as RecordingExporter).proofs).toEqual(["proofs/alpha.pdf"]);
    expect(d.exporter.generatePrintProof).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]), "proofs/alpha.pdf");
  });

  test("a motion re-roll keeps the slot identity and returns the regenerated motion asset", async () => {
    const d = deps({ planner: fakePlanner(fakePlan([motionVariant(), motionVariant({ index: 1 })])) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief(), {
      regenerateOnly: [{ productId: "alpha", variantIndex: 1, attempt: 2 }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.assets).toHaveLength(1);
    expect(result.value.assets[0]).toMatchObject({ variantIndex: 1, attempt: 2, videoPath: "alpha/1x1/v1.mp4" });
  });

  const threeBeatTimeline = (beats: { text: string; weight: number }[]): CopyTimeline => ({
    transition: "fade",
    keyBeat: 1,
    beats,
  });

  test("E3.5 threads authored beats through to the request the compositor receives", async () => {
    const timeline = threeBeatTimeline([
      { text: "New season, new kit", weight: 2 },
      { text: "Built for the cold", weight: 3 },
      { text: "Shop now", weight: 2 },
    ]);
    const d = deps({ planner: fakePlanner(fakePlan([motionVariant()])) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief({ copy: { timeline } }));
    expect(result.success).toBe(true);
    // Assert on the request the port received, not a mock call count.
    const request = vi.mocked(d.videoCompositor.compositeVideo).mock.calls[0]?.[0];
    expect(request).toBeDefined();
    expect(request.timeline).toEqual(timeline);
    expect(request.timeline?.beats).toHaveLength(3);
  });

  test("E3.1 a prohibited term in any beat halts the run before a frame is drawn", async () => {
    const compliance = {
      validateLegalCopy: vi.fn(async (text: string) =>
        text.includes("miracle") ? { passed: false, reason: "Prohibited terminology: miracle" } : { passed: true },
      ),
      validateBrandColorDensity: vi.fn(async () => ({ passed: true, score: 0.5 })),
    };
    const timeline = threeBeatTimeline([
      { text: "New season", weight: 2 },
      { text: "A miracle cure", weight: 3 },
      { text: "Shop now", weight: 2 },
    ]);
    const d = deps({ compliance, planner: fakePlanner(fakePlan([motionVariant()])) });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief({ copy: { timeline } }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toMatchObject({ halted: true, assets: [] });
    // The gate fires before enquiry, background or composite: nothing is generated.
    expect(d.compositor.compositeAsset).not.toHaveBeenCalled();
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    expect(d.videoCompositor.compositeVideo).not.toHaveBeenCalled();
    const halt = result.value.log.entries.filter((e) => e.stage === "ExecuteLegalGateCheck").at(-1);
    expect(halt?.message).toMatch(/Prohibited terminology: miracle/);
  });

  test("a timeline on a classic brief is refused before the legal gate sweeps its beats", async () => {
    // Without this, a classic brief carrying a prohibited term only in copy.timeline
    // returns halted:true on copy no output could ever render.
    const compliance = {
      validateLegalCopy: vi.fn(async (text: string) =>
        text.includes("miracle") ? { passed: false, reason: "Prohibited terminology: miracle" } : { passed: true },
      ),
      validateBrandColorDensity: vi.fn(async () => ({ passed: true, score: 0.5 })),
    };
    const d = deps({ compliance });
    const result = await new GenerateCampaignUseCase(d).execute(
      baseBrief({ copy: { timeline: threeBeatTimeline([{ text: "A miracle cure", weight: 1 }]) } }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/must be in variation mode/);
    // Refused during ValidateBriefIntegrity, so no port was touched at all.
    expect(compliance.validateLegalCopy).not.toHaveBeenCalled();
  });

  test("an unrunnable timeline is refused at the boundary, not thrown from the compositor", async () => {
    // Three beats over the default 6 s clip give each 2 s; weights 1:1:20 put the first
    // two under MIN_DWELL_SEC. timelineProblem is the same check the parser runs.
    const d = deps({ planner: fakePlanner(fakePlan([motionVariant()])) });
    const result = await new GenerateCampaignUseCase(d).execute(
      variationBrief({
        copy: {
          timeline: threeBeatTimeline([
            { text: "One", weight: 1 },
            { text: "Two", weight: 1 },
            { text: "Three", weight: 20 },
          ]),
        },
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/dwell|1\.2/);
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    expect(d.videoCompositor.compositeVideo).not.toHaveBeenCalled();
  });

  test("a runnable timeline on a variation brief still passes validation", async () => {
    const d = deps({ planner: fakePlanner(fakePlan([motionVariant()])) });
    const result = await new GenerateCampaignUseCase(d).execute(
      variationBrief({
        copy: { timeline: threeBeatTimeline([{ text: "One", weight: 1 }, { text: "Two", weight: 1 }]) },
      }),
    );
    expect(result.success).toBe(true);
  });

  test("a timeline on a brief whose template does not accept text layers is refused before generation (image-html)", async () => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(
      variationBrief({
        template: {
          id: "canonical-image-html",
          version: 1,
          creativeType: "image-html",
          unit: "standard-web",
          layers: CANONICAL_TEMPLATES["image-html"].layers,
        },
        copy: { timeline: threeBeatTimeline([{ text: "One", weight: 1 }, { text: "Two", weight: 1 }]) },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/does not accept text layers for "copy\.timeline"/);
    }
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    expect(d.videoCompositor.compositeVideo).not.toHaveBeenCalled();
  });

  test("a timeline on a brief whose template omits text layers is refused before generation", async () => {
    const d = deps();
    const videoTemplateNoText: BriefTemplate = {
      id: "canonical-video",
      version: 1,
      creativeType: "video",
      unit: "standard-web",
      layers: CANONICAL_TEMPLATES["video"].layers.filter((l) => l.kind !== "animated-text"),
    };
    const result = await new GenerateCampaignUseCase(d).execute(
      variationBrief({
        template: videoTemplateNoText,
        copy: { timeline: threeBeatTimeline([{ text: "One", weight: 1 }, { text: "Two", weight: 1 }]) },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/requires an enabled text layer in "template\.layers"/);
    }
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    expect(d.videoCompositor.compositeVideo).not.toHaveBeenCalled();
  });

  test("a timeline on a brief whose template has its text layer disabled is refused before generation", async () => {
    const d = deps();
    const videoTemplateDisabledText: BriefTemplate = {
      id: "canonical-video",
      version: 1,
      creativeType: "video",
      unit: "standard-web",
      layers: CANONICAL_TEMPLATES["video"].layers.map((l) =>
        l.kind === "animated-text" ? { ...l, enabled: false } : l,
      ),
    };
    const result = await new GenerateCampaignUseCase(d).execute(
      variationBrief({
        template: videoTemplateDisabledText,
        copy: { timeline: threeBeatTimeline([{ text: "One", weight: 1 }, { text: "Two", weight: 1 }]) },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/requires an enabled text layer in "template\.layers"/);
    }
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    expect(d.videoCompositor.compositeVideo).not.toHaveBeenCalled();
  });

  test("variation.axes.headline on a brief with no enabled text layer is refused before generation", async () => {
    const d = deps();
    const videoTemplateDisabledText: BriefTemplate = {
      id: "canonical-video",
      version: 1,
      creativeType: "video",
      unit: "standard-web",
      layers: CANONICAL_TEMPLATES["video"].layers.map((l) =>
        l.kind === "animated-text" ? { ...l, enabled: false } : l,
      ),
    };
    const result = await new GenerateCampaignUseCase(d).execute(
      variationBrief({
        template: videoTemplateDisabledText,
        variation: { count: 3, seed: 42, axes: { headline: "pool://copy" } },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/requires an enabled text layer in "template\.layers"/);
    }
    expect(d.imageGenerator.resolveBackground).not.toHaveBeenCalled();
    expect(d.videoCompositor.compositeVideo).not.toHaveBeenCalled();
  });

  test("E3.2 with no timeline the sampled times are exactly the fixed set (D10)", async () => {
    const d = deps({ planner: fakePlanner(fakePlan([motionVariant()])) });
    await new GenerateCampaignUseCase(d).execute(variationBrief());
    const request = vi.mocked(d.videoCompositor.compositeVideo).mock.calls[0]?.[0];
    expect(request?.sampleAt).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  test("E3.2 every beat contributes at least one sampled frame, and the fixed set survives", async () => {
    // 1:1:20 over 6 s puts beats 1 and 2 inside [0, 0.09] — entirely between the fixed
    // samples 0 and 0.25, so without the union neither is ever brand-density checked.
    const timeline = threeBeatTimeline([
      { text: "One", weight: 1 },
      { text: "Two", weight: 1 },
      { text: "Three", weight: 20 },
    ]);
    const d = deps({ planner: fakePlanner(fakePlan([motionVariant({ durationSec: 60 })])) });
    // The duration axis has to match the clip: #107 refuses a timeline whose beats breach
    // the dwell floor, and 1:1:20 over the default 6 s would. Over 60 s each beat clears it.
    await new GenerateCampaignUseCase(d).execute(
      variationBrief({ copy: { timeline }, variation: { count: 3, seed: 42, axes: { duration: [60] } } }),
    );
    const request = vi.mocked(d.videoCompositor.compositeVideo).mock.calls[0]?.[0];
    const sampleAt = request?.sampleAt ?? [];

    // The fixed set is still there — the union adds, it does not replace.
    for (const fixed of [0, 0.25, 0.5, 0.75, 1]) expect(sampleAt).toContain(fixed);
    // Sorted and free of duplicates, so the adapter walks the clip once.
    expect([...sampleAt].sort((a, b) => a - b)).toEqual([...sampleAt]);
    expect(new Set(sampleAt).size).toBe(sampleAt.length);
    // And every beat's own window holds one.
    for (const beat of resolveTimeline(timeline, 60)) {
      expect(sampleAt.some((t) => t >= beat.startT && t <= beat.endT)).toBe(true);
    }
  });

  test("E3.3 the descriptor and the log line name the beat count; without a timeline neither does", async () => {
    const timeline = threeBeatTimeline([
      { text: "One", weight: 1 },
      { text: "Two", weight: 1 },
      { text: "Three", weight: 1 },
    ]);
    const withTimeline = deps({ planner: fakePlanner(fakePlan([motionVariant()])) });
    const sequenced = await new GenerateCampaignUseCase(withTimeline).execute(
      variationBrief({ copy: { timeline } }),
    );
    expect(sequenced.success).toBe(true);
    if (!sequenced.success) return;
    expect(sequenced.value.assets[0]?.descriptor?.beats).toBe(3);
    const line = sequenced.value.log.entries.filter((e) => e.stage === "CompositeVariations").at(-1);
    expect(line?.message).toMatch(/3 beats/);

    // Absent, not zero: no timeline is a different statement from a sequence of length 0.
    const legacyDeps = deps({ planner: fakePlanner(fakePlan([motionVariant()])) });
    const legacy = await new GenerateCampaignUseCase(legacyDeps).execute(variationBrief());
    expect(legacy.success).toBe(true);
    if (!legacy.success) return;
    expect(legacy.value.assets[0]?.descriptor).not.toHaveProperty("beats");
    const legacyLine = legacy.value.log.entries.filter((e) => e.stage === "CompositeVariations").at(-1);
    expect(legacyLine?.message).not.toMatch(/beats/);
  });
});

const ZONES: Record<string, PlatformSafeZone> = {
  "instagram-feed": { ratio: "1:1", safeInsets: { top: 0, right: 0, bottom: 0, left: 0 }, formats: ["static"] },
  "instagram-reel": { ratio: "9:16", safeInsets: { top: 250, right: 0, bottom: 340, left: 60 }, formats: ["motion"] },
  tiktok: { ratio: "9:16", safeInsets: { top: 120, right: 120, bottom: 400, left: 0 }, formats: ["motion"] },
};
const resolver: PlatformSafeZoneResolver = (id) => ZONES[id];

describe("unionSafeInsets (D11)", () => {
  test("takes the max per side across platforms sharing a ratio", () => {
    const union = unionSafeInsets(["instagram-reel", "tiktok", "instagram-feed"], resolver);
    expect(union.get("9:16")).toEqual({ top: 250, right: 120, bottom: 400, left: 60 });
    expect(union.get("1:1")).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(union.has("16:9")).toBe(false);
  });

  test("ignores unknown platform ids and is empty without platforms or a resolver", () => {
    expect(unionSafeInsets(["nope", "tiktok"], resolver).get("9:16")).toEqual(ZONES.tiktok.safeInsets);
    expect(unionSafeInsets(undefined, resolver).size).toBe(0);
    expect(unionSafeInsets(["tiktok"], undefined).size).toBe(0);
  });

  test("a display profile contributes no ratio (its insets are per size, F5)", () => {
    const zones: Record<string, PlatformSafeZone> = {
      ...ZONES,
      "google-display": {
        safeInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        formats: ["static"],
        sizes: [{ size: "300x250", insets: { top: 8, right: 8, bottom: 8, left: 8 } }],
      },
    };
    expect(unionSafeInsets(["google-display", "instagram-feed"], (id) => zones[id]).size).toBe(1);
  });
});

describe("unionSizeInsets (F5)", () => {
  const displayZones: Record<string, PlatformSafeZone> = {
    "google-display": {
      safeInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      formats: ["static"],
      sizes: [
        { size: "300x250", insets: { top: 8, right: 8, bottom: 8, left: 8 } },
        { size: "728x90", insets: { top: 0, right: 0, bottom: 0, left: 0 } },
      ],
    },
    "display-web": {
      safeInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      formats: ["static"],
      sizes: [{ size: "300x250", insets: { top: 10, right: 2, bottom: 8, left: 8 } }],
    },
  };
  const displayResolver: PlatformSafeZoneResolver = (id) => displayZones[id];

  test("takes the max per side across display platforms offering the same size", () => {
    const union = unionSizeInsets(["google-display", "display-web"], displayResolver);
    expect(union.get("300x250")).toEqual({ top: 10, right: 8, bottom: 8, left: 8 });
    expect(union.get("728x90")).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  test("social profiles contribute nothing, and it is empty without platforms or a resolver", () => {
    expect(unionSizeInsets(["instagram-feed"], resolver).size).toBe(0);
    expect(unionSizeInsets(undefined, displayResolver).size).toBe(0);
    expect(unionSizeInsets(["google-display"], undefined).size).toBe(0);
    expect(unionSizeInsets(["nope"], displayResolver).size).toBe(0);
  });
});

describe("GenerateCampaignUseCase — safe insets at generation (D11)", () => {
  const withPlatforms = (platforms?: readonly string[]): CampaignBrief =>
    variationBrief(platforms ? { output: { formats: ["static"], platforms } } : {});

  test("variation + platforms passes the per-ratio union; untargeted ratios get nothing", async () => {
    const variants = [fakeVariant({ aspectRatio: "9:16" }), fakeVariant({ index: 1, aspectRatio: "16:9" })];
    const d = deps({ planner: fakePlanner(fakePlan(variants)), platformSafeZones: resolver });
    const result = await new GenerateCampaignUseCase(d).execute(withPlatforms(["instagram-reel", "tiktok"]));
    expect(result.success).toBe(true);
    const calls = vi.mocked(d.compositor.compositeAsset).mock.calls.map((c) => c[0]);
    expect(calls[0].safeInsets).toEqual({ top: 250, right: 120, bottom: 400, left: 60 });
    expect(calls[1]).not.toHaveProperty("safeInsets");
  });

  test("a motion variant receives the same insets", async () => {
    const d = deps({ planner: fakePlanner(fakePlan([motionVariant({ aspectRatio: "9:16" })])), platformSafeZones: resolver });
    await new GenerateCampaignUseCase(d).execute(withPlatforms(["instagram-reel"]));
    expect(d.videoCompositor.compositeVideo).toHaveBeenCalledWith(
      expect.objectContaining({ safeInsets: ZONES["instagram-reel"].safeInsets }),
    );
  });

  test("a brief without platforms, or a root without a resolver, passes no insets (zero path)", async () => {
    const noPlatforms = deps({ planner: fakePlanner(fakePlan([fakeVariant({ aspectRatio: "9:16" })])), platformSafeZones: resolver });
    await new GenerateCampaignUseCase(noPlatforms).execute(withPlatforms());
    expect(firstCompositeCall(noPlatforms)).not.toHaveProperty("safeInsets");

    const noResolver = deps({ planner: fakePlanner(fakePlan([fakeVariant({ aspectRatio: "9:16" })])) });
    await new GenerateCampaignUseCase(noResolver).execute(withPlatforms(["instagram-reel"]));
    expect(firstCompositeCall(noResolver)).not.toHaveProperty("safeInsets");
  });

  test("classic mode never passes insets even with platforms and a resolver", async () => {
    const d = deps({ platformSafeZones: resolver });
    await new GenerateCampaignUseCase(d).execute(baseBrief({ output: { formats: ["static"], platforms: ["instagram-reel"] } }));
    for (const call of vi.mocked(d.compositor.compositeAsset).mock.calls) {
      expect(call[0]).not.toHaveProperty("safeInsets");
    }
    expect(d.videoCompositor.compositeVideo).not.toHaveBeenCalled();
  });
});

describe("GenerateCampaignUseCase — campaign type in background context (T4)", () => {
  test("classic path (site 1) passes brief.type into the image generator context", async () => {
    const d = deps();
    const result = await new GenerateCampaignUseCase(d).execute(baseBrief({ type: "short-video" }));
    expect(result.success).toBe(true);
    const ctx = vi.mocked(d.imageGenerator.resolveBackground).mock.calls[0][2];
    expect(ctx.campaignType).toBe("short-video");
  });

  test("variation path (site 2) passes brief.type into the image generator context", async () => {
    const d = deps({
      planner: fakePlanner(fakePlan([fakeVariant({ backgroundSource: "genai" })])),
    });
    const result = await new GenerateCampaignUseCase(d).execute(variationBrief({ type: "short-video" }));
    expect(result.success).toBe(true);
    const ctx = vi.mocked(d.imageGenerator.resolveBackground).mock.calls[0][2];
    expect(ctx.campaignType).toBe("short-video");
  });
});
