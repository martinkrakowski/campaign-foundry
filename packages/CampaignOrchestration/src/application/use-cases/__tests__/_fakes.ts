import { vi } from "vitest";
import type {
  BackgroundSource,
  CompliancePort,
  CompositorPort,
  ExportPort,
  ImageGeneratorPort,
} from "../../../index.js";

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
