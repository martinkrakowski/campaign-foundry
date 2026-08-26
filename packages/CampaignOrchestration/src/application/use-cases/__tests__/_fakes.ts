import { vi } from "vitest";
import { err, ok } from "@campaignfoundry/shared";
import type { Variant } from "../../../domain/entities/Variant.js";
import type { VariationPlan } from "../../../domain/value-objects/VariationPlan.vo.js";
import type {
  BackgroundSource,
  CompliancePort,
  CompositorPort,
  ExportPort,
  ImageGeneratorPort,
} from "../../../index.js";
import type { VariationPlanner } from "../GenerateCampaignUseCase.use-case.js";

/**
 * Reusable in-memory port fakes — the whole point of the hexagonal seams. They
 * let the use case be exercised with zero real I/O, and every method is a
 * `vi.fn()` so a test can assert what the ports were called with.
 */

export const fakeImageGenerator = (source: BackgroundSource = "procedural"): ImageGeneratorPort => ({
  resolveBackground: vi.fn(async () => ({ image: new Uint8Array([1, 2, 3]), source })),
});

export const fakeCompositor = (logoApplied = true): CompositorPort => ({
  compositeAsset: vi.fn(async () => ({ image: new Uint8Array([4, 5, 6]), logoApplied })),
});

export interface FakeComplianceOptions {
  /** Legal gate verdict (default: pass). */
  legalPass?: boolean;
  legalReason?: string;
  /** Brand-colour density score 0..1 (default 0.5 → passes the 0.02 floor). */
  density?: number;
  /** When true, the density check returns no numeric score (covers the `?? 0` path). */
  scoreless?: boolean;
}

export const fakeCompliance = (opts: FakeComplianceOptions = {}): CompliancePort => {
  const { legalPass = true, legalReason = "Prohibited terminology: guaranteed", density = 0.5, scoreless = false } = opts;
  return {
    validateLegalCopy: vi.fn(async () => (legalPass ? { passed: true } : { passed: false, reason: legalReason })),
    validateBrandColorDensity: vi.fn(async () =>
      scoreless ? { passed: true } : { passed: density >= 0.02, score: density },
    ),
  };
};

export type RecordingExporter = ExportPort & {
  readonly saved: Array<{ path: string; bytes: number }>;
  readonly proofs: string[];
};

export const fakeVariant = (over: Partial<Variant> = {}): Variant => ({
  index: 0,
  seed: 1,
  productId: "alpha",
  aspectRatio: "1:1",
  layout: "headline-bottom",
  tone: "bold",
  backgroundSource: "procedural",
  paletteShift: 0,
  ...over,
});

export const fakePlan = (variants: Variant[], over: Partial<VariationPlan> = {}): VariationPlan => ({
  policyHash: "hash",
  seed: 42,
  variants,
  estimate: { creatives: variants.length, axisProductSize: 24, feasible: true, genaiCalls: 0 },
  policy: {} as VariationPlan["policy"],
  briefId: "camp",
  ...over,
});

export const fakePlanner = (plan: VariationPlan | Error = fakePlan([fakeVariant()])): VariationPlanner => ({
  plan: vi.fn(() => (plan instanceof Error ? err(plan) : ok(plan))),
  replan: vi.fn((current: VariationPlan, index: number, attempt: number) => {
    if (index < 0 || index >= current.variants.length) {
      return err(new Error(`Invalid variant index ${index}.`));
    }
    const next: Variant = { ...current.variants[index], seed: attempt + 100, tone: "subtle" };
    return ok({
      ...current,
      variants: current.variants.map((variant, slot) => (slot === index ? next : variant)),
    });
  }),
});

export const recordingExporter = (): RecordingExporter => {
  const saved: Array<{ path: string; bytes: number }> = [];
  const proofs: string[] = [];
  return {
    saved,
    proofs,
    saveToDirectory: vi.fn(async (buf: Uint8Array, path: string) => {
      saved.push({ path, bytes: buf.length });
    }),
    generatePrintProof: vi.fn(async (_buf: Uint8Array, path: string) => {
      proofs.push(path);
    }),
  };
};
