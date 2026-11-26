import { vi, type Mock } from "vitest";
import { err, ok } from "@campaignfoundry/shared";
import type { Variant } from "../../../domain/entities/Variant.js";
import type { VariationPlan } from "../../../domain/value-objects/VariationPlan.vo.js";
import type {
  AudioAssetPort,
  BackgroundSource,
  CompliancePort,
  CompositorPort,
  ExportPort,
  ImageGeneratorPort,
  PublicAdMediaPort,
  PublishedClipRecordPort,
  SceneAssetPort,
  VideoCompositorPort,
} from "../../../index.js";
import type { VariationPlanner } from "../GenerateCampaignUseCase.use-case.js";

/**
 * Reusable in-memory port fakes — the whole point of the hexagonal seams. They
 * let the use case be exercised with zero real I/O, and every method is a
 * `vi.fn()` so a test can assert what the ports were called with.
 */

export const fakeImageGenerator = (
  source: BackgroundSource = "procedural",
): ImageGeneratorPort => ({
  resolveBackground: vi.fn(async () => ({ image: new Uint8Array([1, 2, 3]), source })),
});

/**
 * Scene resolver fake (VE5b2): resolves each distinct path to bytes derived
 * from the path itself, so two distinct paths never share a result — a test
 * asserting the resolved `backgrounds` map actually pins which bytes landed
 * under which key, not merely that something did. `unreadable` names paths
 * that reject instead, the way an unsafe or missing scene asset would.
 */
export const fakeSceneAssets = (unreadable: readonly string[] = []): SceneAssetPort => ({
  resolveScene: vi.fn(async (path: string) => {
    if (unreadable.includes(path)) throw new Error(`fake scene resolver: "${path}" is unreadable`);
    return new Uint8Array(Buffer.from(path, "utf8"));
  }),
});

/**
 * Audio resolver fake (VE3b2): resolves the given path to bytes derived from
 * the path itself, so a test can assert the SAME resolved bytes (by value, or
 * by identity of the array reference when the use case reuses one resolution)
 * land on every motion request. `unreadable` names a path that rejects
 * instead, the way an unsafe or missing music bed would.
 */
export const fakeAudioAssets = (unreadable: readonly string[] = []): AudioAssetPort => ({
  resolveAudio: vi.fn(async (path: string) => {
    if (unreadable.includes(path)) throw new Error(`fake audio resolver: "${path}" is unreadable`);
    return new Uint8Array(Buffer.from(path, "utf8"));
  }),
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
  /** Per-call density scores (sampled motion frames); falls back to `density` once exhausted. */
  densities?: readonly number[];
  /** When true, the density check returns no numeric score (covers the `?? 0` path). */
  scoreless?: boolean;
}

export const fakeCompliance = (opts: FakeComplianceOptions = {}): CompliancePort => {
  const {
    legalPass = true,
    legalReason = "Prohibited terminology: guaranteed",
    density = 0.5,
    scoreless = false,
  } = opts;
  let call = 0;
  return {
    validateLegalCopy: vi.fn(async () =>
      legalPass ? { passed: true } : { passed: false, reason: legalReason },
    ),
    validateBrandColorDensity: vi.fn(async () => {
      const score = opts.densities?.[call] ?? density;
      call += 1;
      return scoreless ? { passed: true } : { passed: score >= 0.02, score };
    }),
  };
};

/** Motion port fake: `frames` sampled frames (default 5, one byte each so tests can tell them apart). */
export const fakeVideoCompositor = (
  opts: { logoApplied?: boolean; frames?: number } = {},
): VideoCompositorPort => ({
  compositeVideo: vi.fn(async () => ({
    video: new Uint8Array([7, 8, 9, 10]),
    poster: new Uint8Array([4, 5, 6]),
    sampledFrames: Array.from({ length: opts.frames ?? 5 }, (_, i) => new Uint8Array([i])),
    logoApplied: opts.logoApplied ?? true,
  })),
  // VE2: the single-frame seam answers distinguishable bytes, never a spawn.
  compositeFrame: vi.fn(async () => ({
    image: new Uint8Array([11, 12, 13]),
    logoApplied: opts.logoApplied ?? true,
  })),
});

export type RecordingExporter = ExportPort & {
  readonly saved: Array<{ path: string; bytes: number }>;
  readonly proofs: string[];
  readonly removed: string[];
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

export const fakePlan = (
  variants: Variant[],
  over: Partial<VariationPlan> = {},
): VariationPlan => ({
  policyHash: "hash",
  copyHash: "copy-hash",
  seed: 42,
  variants,
  estimate: { creatives: variants.length, axisProductSize: 24, feasible: true, genaiCalls: 0 },
  policy: {} as VariationPlan["policy"],
  briefId: "camp",
  ...over,
});

export const fakePlanner = (
  plan: VariationPlan | Error = fakePlan([fakeVariant()]),
): VariationPlanner => ({
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
  const removed: string[] = [];
  return {
    saved,
    proofs,
    removed,
    saveToDirectory: vi.fn(async (buf: Uint8Array, path: string) => {
      saved.push({ path, bytes: buf.length });
    }),
    generatePrintProof: vi.fn(async (_buf: Uint8Array, path: string) => {
      proofs.push(path);
    }),
    remove: vi.fn(async (path: string) => {
      removed.push(path);
    }),
  };
};

export interface FakePublicAdMediaOptions {
  /** `publish` rejects instead of returning a published object. */
  publishFails?: Error;
  /** `remove` rejects instead of resolving (cleanup failures, unpublish failures). */
  removeFails?: Error;
}

export type FakePublicAdMedia = PublicAdMediaPort & {
  readonly publish: Mock;
  readonly remove: Mock;
  readonly removeOrg: Mock;
  readonly urlFor: Mock;
  readonly removed: string[];
};

/**
 * Public ad-media fake (PT-4k): `publish` mints an unguessable public key of
 * the real shape — `org/<orgId>/<32-hex-random>/<hash>.mp4` — and `remove`
 * records what it was asked to remove, so a test can assert no orphan is left
 * behind and no object is removed twice.
 */
export const fakePublicAdMedia = (opts: FakePublicAdMediaOptions = {}): FakePublicAdMedia => {
  const removed: string[] = [];
  const published = new Map<string, string>();
  let seq = 0;
  const port = {
    publish: vi.fn(async (orgId: string, _bytes: Uint8Array, contentHash: string) => {
      if (opts.publishFails) throw opts.publishFails;
      seq += 1;
      const key = `org/${orgId}/${String(seq).padStart(32, "0")}/${contentHash}.mp4`;
      published.set(key, orgId);
      return { key, url: `https://media.example.invalid/${key}` };
    }),
    remove: vi.fn(async (key: string) => {
      if (opts.removeFails) throw opts.removeFails;
      removed.push(key);
      published.delete(key);
    }),
    removeOrg: vi.fn(async (orgId: string) => {
      removed.push(`org/${orgId}/*`);
      for (const [key, owner] of published) {
        if (owner === orgId) published.delete(key);
      }
    }),
    urlFor: vi.fn((key: string) => `https://media.example.invalid/${key}`),
    listPages: vi.fn(async function* (orgId: string) {
      for (const [key, owner] of published) {
        if (owner === orgId) {
          yield [{ key, size: 1, lastModified: new Date() }];
        }
      }
    }),
  } satisfies PublicAdMediaPort;
  return Object.assign(port, { removed });
};

export type FakePublishedClipRecordPort = PublishedClipRecordPort & {
  readonly record: Mock;
  readonly find: Mock;
  readonly listForCampaign: Mock;
  readonly remove: Mock;
};

/**
 * In-memory published-clip ledger fake: content-addressed per
 * `(orgId, campaignId, contentHash)`, with every method a `vi.fn()` so tests
 * can assert call order and refusal paths observed zero writes.
 */
export const fakePublishedClipRecord = (
  seed: ReadonlyArray<{
    orgId: string;
    campaignId: string;
    contentHash: string;
    record: { key: string; url: string };
  }> = [],
): FakePublishedClipRecordPort => {
  const byHash = new Map<string, { key: string; url: string }>();
  for (const entry of seed) {
    byHash.set(`${entry.orgId}/${entry.campaignId}/${entry.contentHash}`, entry.record);
  }
  return {
    record: vi.fn(
      async (orgId: string, campaignId: string, key: string, url: string, contentHash: string) => {
        const id = `${orgId}/${campaignId}/${contentHash}`;
        if (byHash.has(id)) return "exists" as const;
        byHash.set(id, { key, url });
        return "recorded" as const;
      },
    ),
    find: vi.fn(async (orgId: string, campaignId: string, contentHash: string) =>
      byHash.get(`${orgId}/${campaignId}/${contentHash}`),
    ),
    listForCampaign: vi.fn(async (orgId: string, campaignId: string) => {
      const prefix = `${orgId}/${campaignId}/`;
      return [...byHash.entries()]
        .filter(([id]) => id.startsWith(prefix))
        .map(([, record]) => record);
    }),
    remove: vi.fn(async (orgId: string, key: string) => {
      for (const [id, record] of byHash) {
        if (record.key === key && id.startsWith(`${orgId}/`)) byHash.delete(id);
      }
    }),
  };
};
