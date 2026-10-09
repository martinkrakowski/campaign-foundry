import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isReservedCampaignId, type CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { dumpBrief, errorMessage } from "@campaignfoundry/shared";
import { blocksImport, classifyRefs } from "./classify.js";
import { collectRefs } from "../asset-files.js";
import { hashBytes, isErrno, isExistsError } from "../brief-files.js";
import { UUID_PATTERN } from "../object-store/object-keys.js";
import {
  candidateAt,
  countUnreferencedInputs,
  resolveRefTargets,
  type RefTarget,
  type UnreferencedInputs,
  writeOrReuse,
} from "./asset-step.js";
import { getAssetStore, getBriefStore } from "../ports/index.js";
import type { AssetStorePort } from "../ports/asset-store.port.js";
import type { BriefStorePort } from "../ports/brief-store.port.js";
import { parseBriefText } from "../load-brief.js";
import { importTenant } from "./import-tenant.js";
import { rewriteBriefRefs } from "./ref-rewrite.js";
import type { ScannedCampaign } from "./scan.js";
import { type CampaignOutcome, type ImportStep, type StepContext } from "./steps.js";

export interface ImportDeps {
  readonly briefs: BriefStorePort;
  readonly assets: AssetStorePort;
}

export interface MintedAsset {
  readonly id: string;
  readonly name: string;
  readonly key: string;
}

/** What one `importCampaign` call did (D222, PT-8-3). */
export interface CampaignResult {
  readonly outcome: CampaignOutcome;
  readonly reason?: string;
  readonly partial?: boolean;
  readonly minted: {
    readonly campaignId?: string;
    readonly assets: readonly MintedAsset[];
  };
  readonly unreferencedInputs: UnreferencedInputs;
}

/** The files preflight read and hashed, ready to write. */
export interface Preflight {
  readonly brief: CampaignBrief;
  readonly targets: readonly RefTarget[];
  readonly targetBytes: ReadonlyMap<string, Buffer>;
}

export type PreflightResult =
  | { readonly ok: true; readonly preflight: Preflight }
  | { readonly ok: false; readonly reason: string };

/** True when two briefs name a different set of refs (collectRefs order, N10). */
function refsDiffer(a: CampaignBrief, b: CampaignBrief): boolean {
  const ra = collectRefs(a);
  const rb = collectRefs(b);
  return ra.length !== rb.length || !ra.every((ref, i) => ref === rb[i]);
}

/**
 * All checks that must pass BEFORE the first write (N3, D222): a reserved slug
 * (D181) or a uuid-shaped slug (N6); any ref `classifyRefs` marked unsafe,
 * missing or refused; and a brief file or ref-target whose sha256 does not match
 * the reviewed digest (`expected`), keyed as `digestSourceFiles` keys it. The
 * brief and every target are read ONCE here and the bytes reused for the writes
 * (N10), so a mismatch refuses before any row or object is touched.
 */
export async function preflight(
  ctx: StepContext,
  scanned: ScannedCampaign,
  expected: ReadonlyMap<string, string>,
): Promise<PreflightResult> {
  if (isReservedCampaignId(scanned.slug)) {
    return { ok: false, reason: `${scanned.slug} is a reserved campaign id.` };
  }
  if (UUID_PATTERN.test(scanned.slug)) {
    return { ok: false, reason: `a uuid-shaped slug is refused: ${scanned.slug}` };
  }
  for (const ref of scanned.refs) {
    if (blocksImport(ref)) {
      return { ok: false, reason: `ref ${JSON.stringify(ref.ref)}: ${ref.reason}` };
    }
  }
  const briefKey = relative(ctx.projectRoot, scanned.sourcePath);
  const briefBytes = readFileSync(scanned.sourcePath);
  const expectedBrief = expected.get(briefKey);
  if (expectedBrief === undefined) {
    return { ok: false, reason: `${briefKey} is not in the reviewed digest` };
  }
  if (expectedBrief !== hashBytes(briefBytes)) {
    return { ok: false, reason: `${briefKey} changed since the digest` };
  }
  let brief: CampaignBrief;
  try {
    brief = parseBriefText(scanned.sourcePath, briefBytes.toString("utf8"));
  } catch (error) {
    return { ok: false, reason: `${briefKey}: ${errorMessage(error)}` };
  }
  // N10: import the body whose bytes were hashed (this read), never a parse from
  // another read. If the on-disk brief changed between the step's parse and this
  // one, its ref set differs — refuse instead of storing the other body.
  if (refsDiffer(brief, scanned.brief)) {
    return { ok: false, reason: `${briefKey} changed since the digest` };
  }
  const targets = resolveRefTargets(ctx, scanned);
  const targetBytes = new Map<string, Buffer>();
  for (const target of targets) {
    const bytes = readFileSync(target.path);
    const key = relative(ctx.projectRoot, target.path);
    const expectedHash = expected.get(key);
    if (expectedHash === undefined) {
      return { ok: false, reason: `${key} is not in the reviewed digest` };
    }
    if (expectedHash !== hashBytes(bytes)) {
      return { ok: false, reason: `${key} changed since the digest` };
    }
    targetBytes.set(target.ref, bytes);
  }
  return { ok: true, preflight: { brief, targets, targetBytes } };
}

export type ProbeDecision =
  | { readonly kind: "absent" }
  | { readonly kind: "versionless" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * The id the WRITE path would reuse for `target` by walking the candidate names
 * against existing rows, confirming bytes by sha256 before trusting a name.
 * `undefined` when no existing candidate matches — i.e. the write would mint a
 * brand-new asset, so the stored body can never equal the rewrite (D221).
 */
async function reuseIdAt(
  assets: AssetStorePort,
  slug: string,
  target: RefTarget,
  bytes: Buffer,
): Promise<string | { missing: string }> {
  const entries = await assets.listAssets(slug);
  const byName = new Map(entries.map((e) => [e.name, e.id as string]));
  const sourceSha = hashBytes(bytes);
  for (let index = 0; ; index++) {
    const candidate = candidateAt(target.name, target.from, index);
    const existing = byName.get(candidate);
    if (existing === undefined) return { missing: candidate };
    const stored = await assets.readAsset(slug, candidate);
    if (hashBytes(stored!) === sourceSha) return existing;
  }
}

/**
 * Read-only probe (D221, PT-8-3): absent → the run must create; versionless → the
 * run completes the reservation; a versioned body that rewrites to itself is
 * `unchanged`; anything else is `refused` (a body that differs, or a ref whose
 * bytes no existing asset matches).
 */
export async function probeCampaign(
  briefs: BriefStorePort,
  assets: AssetStorePort,
  ctx: StepContext,
  scanned: ScannedCampaign,
  files: Preflight,
): Promise<ProbeDecision> {
  const meta = await briefs.campaignMeta(scanned.slug);
  if (meta === undefined) return { kind: "absent" };
  if (!meta.hasVersion) return { kind: "versionless" };

  const refToId = new Map<string, string>();
  for (const target of files.targets) {
    const found = await reuseIdAt(assets, scanned.slug, target, files.targetBytes.get(target.ref)!);
    if (typeof found === "object") {
      return {
        kind: "refused",
        reason: `asset ${found.missing} for ref ${JSON.stringify(target.ref)} is not in the store`,
      };
    }
    refToId.set(target.ref, found);
  }
  const rewritten = rewriteBriefRefs(files.brief, scanned.slug, refToId);
  const stored = await briefs.findBriefById(scanned.slug);
  if (dumpBrief(rewritten) === dumpBrief(stored!.brief)) return { kind: "unchanged" };
  return {
    kind: "refused",
    reason: `campaign ${scanned.slug} body differs from the rewritten source`,
  };
}

/**
 * The per-campaign import (D220, D222): preflight all checks, probe, then create
 * campaign + assets + brief in the order the plan fixes (N3). A failure after
 * `createCampaign` is caught per campaign and returned `refused` with
 * `partial: true`; every minted id/key is carried so a rerun can complete it.
 */
export async function importCampaign(
  deps: ImportDeps,
  ctx: StepContext,
  scanned: ScannedCampaign,
  expected: ReadonlyMap<string, string>,
): Promise<CampaignResult> {
  const empty: UnreferencedInputs = { count: 0, names: [] };
  const pf = await preflight(ctx, scanned, expected);
  if (!pf.ok)
    return {
      outcome: "refused",
      reason: pf.reason,
      minted: { assets: [] },
      unreferencedInputs: empty,
    };

  const { brief, targets, targetBytes } = pf.preflight;
  const unreferenced = countUnreferencedInputs(ctx, scanned.slug, targets);
  const probe = await probeCampaign(deps.briefs, deps.assets, ctx, scanned, {
    brief,
    targets,
    targetBytes,
  });
  if (probe.kind === "unchanged")
    return { outcome: "unchanged", minted: { assets: [] }, unreferencedInputs: unreferenced };
  if (probe.kind === "refused")
    return {
      outcome: "refused",
      reason: probe.reason,
      minted: { assets: [] },
      unreferencedInputs: unreferenced,
    };

  let campaignId: string | undefined;
  if (probe.kind === "absent") {
    try {
      const resolved = await deps.briefs.createCampaign(scanned.slug, {
        name: scanned.name ?? undefined,
        type: scanned.type ?? undefined,
      });
      campaignId = resolved.campaignId;
    } catch (error) {
      if (isExistsError(error)) {
        return {
          outcome: "refused",
          reason: "refused: slug reserved",
          minted: { assets: [] },
          unreferencedInputs: unreferenced,
        };
      }
      throw error;
    }
  }

  const refToId = new Map<string, string>();
  const mintedAssets: MintedAsset[] = [];
  try {
    for (const target of targets) {
      const written = await writeOrReuse(
        deps.assets,
        scanned.slug,
        target.name,
        targetBytes.get(target.ref)!,
        target.from,
      );
      refToId.set(target.ref, written.id);
      if (!written.reused)
        mintedAssets.push({ id: written.id, name: written.name, key: written.key });
    }
    const rewritten = rewriteBriefRefs(brief, scanned.slug, refToId);
    await deps.briefs.createBrief(rewritten);
  } catch (error) {
    return {
      outcome: "refused",
      reason: errorMessage(error),
      partial: true,
      minted: { campaignId, assets: mintedAssets },
      unreferencedInputs: unreferenced,
    };
  }

  return {
    outcome: probe.kind === "absent" ? "created" : "completed",
    minted: { campaignId, assets: mintedAssets },
    unreferencedInputs: unreferenced,
  };
}

/** `importCampaignStep`'s context: the reviewed hashes ride the context (D221). */
export type HashedContext = StepContext & { readonly expectedHashes: ReadonlyMap<string, string> };

/** True only when the step context carried the reviewed source hashes. */
export function hasExpectedHashes(ctx: StepContext): ctx is HashedContext {
  return "expectedHashes" in ctx;
}

function campaignMetaFromFile(
  ctx: StepContext,
  slug: string,
): { name: string | null; type: string | null } {
  try {
    const raw = readFileSync(join(ctx.projectRoot, "briefs", slug, "campaign.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown; type?: unknown };
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      type: typeof parsed.type === "string" ? parsed.type : null,
    };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { name: null, type: null };
    throw error;
  }
}

/**
 * The `ImportStep` for PT-8b (D220, D222): adapts the `{ slug, sourcePath }`
 * shape the plan hands a step into the per-campaign import, re-reading and
 * re-classifying the brief from `sourcePath`, reading `briefs/<slug>/campaign.json`
 * for name/type, and reading the reviewed hashes out of a widened context behind
 * {@link hasExpectedHashes} so `StepContext` itself is not widened (D221).
 */
export const importCampaignStep: ImportStep = async (ctx, campaign): Promise<CampaignResult> => {
  if (!hasExpectedHashes(ctx)) {
    return {
      outcome: "refused",
      reason: "no reviewed source hashes in the step context",
      minted: { assets: [] },
      unreferencedInputs: { count: 0, names: [] },
    };
  }
  const raw = readFileSync(campaign.sourcePath, "utf8");
  const brief = parseBriefText(campaign.sourcePath, raw);
  const { name, type } = campaignMetaFromFile(ctx, campaign.slug);
  const draft: ScannedCampaign = {
    slug: campaign.slug,
    sourcePath: campaign.sourcePath,
    name,
    type,
    brief,
    refs: [],
    sample: false,
  };
  const scanned: ScannedCampaign = { ...draft, refs: classifyRefs(ctx, draft) };
  return importCampaign(
    {
      briefs: getBriefStore(importTenant(ctx.orgId)),
      assets: getAssetStore(importTenant(ctx.orgId)),
    },
    ctx,
    scanned,
    ctx.expectedHashes,
  );
};
