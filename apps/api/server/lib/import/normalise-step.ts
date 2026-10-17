import { readFileSync } from "node:fs";
import { errorMessage } from "@campaignfoundry/shared";
import { hashBytes, isErrno } from "../brief-files.js";
import type { AssetStorePort } from "../ports/asset-store.port.js";
import type { BriefStorePort } from "../ports/brief-store.port.js";
import { resolveRefTargets, writeOrReuse } from "./asset-step.js";
import type { MintedAsset } from "./campaign-step.js";
import type { ExistingCampaign } from "./existing-campaigns.js";
import { bodyDrift, ownInputs } from "./normalise-inputs.js";
import { rewriteBriefRefs } from "./ref-rewrite.js";
import type { StepContext } from "./steps.js";

/** What the normalise needs from the target. `briefs` and `assets` are the import tenant's stores. */
export interface NormaliseDeps {
  readonly briefs: Pick<BriefStorePort, "getRevision" | "rewriteBrief">;
  readonly assets: AssetStorePort;
  /** How many unsaved drafts the campaign (by uuid) has NOW (PT-8e 8). */
  readonly draftCount: (campaignId: string) => Promise<number>;
}

/** A class-(P) campaign `classifyExisting` answered `normalise` for. */
export type Normalisable = Extract<ExistingCampaign, { readonly state: "normalise" }>;

export interface NormaliseInput {
  readonly campaign: Normalisable;
  /** The stored body the campaign was classified from (`LatestBody.body`). */
  readonly body: string;
  /** Ref to sha256, as the reviewed second digest covers them (PT-8e 1). */
  readonly expected: ReadonlyMap<string, string>;
}

/** A file of the campaign's own inputs folder that fails the upload rules: listed, not imported. */
export interface NotImported {
  readonly name: string;
  readonly reason: string;
}

/** Why a campaign was refused: for the result line, not for a reader. */
export type Refusal = "draft" | "body" | "source" | "failed";

/**
 * What normalising ONE campaign came to (PT-8e 3). `normalised`: the new version is
 * written and `revision` is its revision. `conflict`: the revision moved (before the
 * first write, or a 409 from the version write). `refused`: see `refusal`. In every
 * case `minted` is exactly the assets THIS call created; they are left in place.
 */
export interface NormaliseResult {
  readonly slug: string;
  readonly campaignId: string;
  readonly status: "normalised" | "refused" | "conflict";
  readonly refusal?: Refusal;
  readonly reason?: string;
  readonly revision?: string;
  readonly minted: { readonly assets: readonly MintedAsset[] };
  readonly notImported: readonly NotImported[];
}

/** One asset to write: a ref target (with the ref it replaces) or an own input no ref names. */
interface PlannedWrite {
  readonly name: string;
  readonly from: string;
  readonly bytes: Buffer;
  readonly ref?: string;
}

interface Prepared {
  readonly writes: readonly PlannedWrite[];
  readonly notImported: readonly NotImported[];
}

/** An answer given before any write: nothing minted. */
function stopped(
  campaign: Normalisable,
  status: "refused" | "conflict",
  reason: string,
  refusal?: Refusal,
): NormaliseResult {
  return {
    slug: campaign.slug,
    campaignId: campaign.campaignId,
    status,
    ...(refusal === undefined ? {} : { refusal }),
    reason,
    minted: { assets: [] },
    notImported: [],
  };
}

/** True when the call changed the target: it created an asset or wrote the version. */
export function normaliseWrote(result: NormaliseResult): boolean {
  return result.status === "normalised" || result.minted.assets.length > 0;
}

/**
 * Every check and every file read, BEFORE the first write: the draft (PT-8e 8), the
 * body round trip (PT-8e 3), each ref target's bytes against the reviewed hashes
 * (PT-8e 1), the own inputs (PT-8e 2), and LAST the revision (PT-8e 3). Each file is
 * read once; the bytes checked here are the bytes written. It sends no write.
 */
async function prepare(
  deps: NormaliseDeps,
  ctx: StepContext,
  input: NormaliseInput,
): Promise<Prepared | NormaliseResult> {
  const { campaign, body, expected } = input;
  const drafts = await deps.draftCount(campaign.campaignId);
  if (drafts > 0) {
    const reason = `the campaign has ${drafts} unsaved draft(s); a new version would discard them`;
    return stopped(campaign, "refused", reason, "draft");
  }
  const drift = bodyDrift(body, campaign.brief);
  if (drift !== undefined) return stopped(campaign, "refused", drift, "body");
  const targets = resolveRefTargets(ctx, {
    slug: campaign.slug,
    sourcePath: "",
    name: null,
    type: null,
    brief: campaign.brief,
    refs: campaign.refs,
    sample: false,
  });
  const writes: PlannedWrite[] = [];
  for (const target of targets) {
    const bytes = readFileSync(target.path);
    const named = `ref ${JSON.stringify(target.ref)}`;
    const reviewed = expected.get(target.ref);
    if (reviewed === undefined) {
      return stopped(campaign, "refused", `${named} is not in the reviewed digest`, "source");
    }
    if (reviewed !== hashBytes(bytes)) {
      return stopped(campaign, "refused", `${named} changed since the digest`, "source");
    }
    writes.push({ name: target.name, from: target.from, bytes, ref: target.ref });
  }
  const referenced = new Set(targets.map((target) => target.path));
  const notImported: NotImported[] = [];
  for (const own of ownInputs(ctx, campaign.slug)) {
    if (own.state === "failed") {
      notImported.push({ name: own.name, reason: own.reason });
    } else if (!referenced.has(own.path)) {
      writes.push({ name: own.name, from: campaign.slug, bytes: readFileSync(own.path) });
    }
  }
  const current = await deps.briefs.getRevision(campaign.slug);
  if (current !== campaign.revision) {
    const reason = `the campaign's latest revision is no longer ${campaign.revision}`;
    return stopped(campaign, "conflict", reason);
  }
  return { writes, notImported };
}

/**
 * Normalise ONE existing campaign (PT-8e; D228): its ref targets and its other own
 * inputs become assets (`writeOrReuse`: an asset already there with the same bytes is
 * reused, never overwritten), then ONE new brief version replaces every path ref by
 * its asset id, written against the planned revision. It works from the STORED body
 * only. It NEVER throws: before the first write a failure is `refused` with nothing
 * minted; after a write the answer lists what this call created, as `conflict` on a
 * 409 and `refused` otherwise. The assets stay; the next run reuses them.
 */
export async function normaliseCampaign(
  deps: NormaliseDeps,
  ctx: StepContext,
  input: NormaliseInput,
): Promise<NormaliseResult> {
  const { campaign } = input;
  let ready: Prepared | NormaliseResult;
  try {
    ready = await prepare(deps, ctx, input);
  } catch (error) {
    return stopped(campaign, "refused", errorMessage(error), "failed");
  }
  if ("status" in ready) return ready;
  const { slug, campaignId, revision } = campaign;
  const done = { slug, campaignId, notImported: ready.notImported };
  // What this call created, filled as it writes: every answer from here on carries it.
  const minted: MintedAsset[] = [];
  const kept = { assets: minted };
  try {
    const refToId = new Map<string, string>();
    for (const write of ready.writes) {
      const written = await writeOrReuse(deps.assets, slug, write.name, write.bytes, write.from);
      if (write.ref !== undefined) refToId.set(write.ref, written.id);
      if (!written.reused) minted.push({ id: written.id, name: written.name, key: written.key });
    }
    const rewritten = rewriteBriefRefs(campaign.brief, slug, refToId);
    const stored = await deps.briefs.rewriteBrief(rewritten, { expectedRevision: revision });
    return { ...done, status: "normalised", revision: stored.revision, minted: kept };
  } catch (error) {
    const reason = errorMessage(error);
    if (isErrno(error, "ECONFLICT")) return { ...done, status: "conflict", reason, minted: kept };
    return { ...done, status: "refused", refusal: "failed", reason, minted: kept };
  }
}
