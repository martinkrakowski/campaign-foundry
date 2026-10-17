import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { dumpBrief } from "@campaignfoundry/shared";
import { collectRefs } from "../../asset-files.js";
import { hashBytes } from "../../brief-files.js";
import { parseBriefText } from "../../load-brief.js";
import { isAssetId, type AssetStorePort } from "../../ports/asset-store.port.js";
import { getAssetStore, getBriefStore } from "../../ports/index.js";
import { resolveRefTargets } from "../asset-step.js";
import { classifyExisting, latestBodies } from "../existing-campaigns.js";
import { importTenant } from "../import-tenant.js";
import {
  normaliseCampaign,
  normaliseWrote,
  type NormaliseDeps,
  type NormaliseInput,
} from "../normalise-step.js";
import type { StepContext } from "../steps.js";
import {
  failOnNth,
  ON_A_REAL_TEST_SERVER,
  restoreApplyEnvironment,
  useApplyEnvironment,
} from "./fixtures/apply-harness.js";
import { NOT_A_PNG, PNG, briefBody, dropRoot, makeRoot, writeAt } from "./fixtures/tree.js";

type Env = Awaited<ReturnType<typeof useApplyEnvironment>>;

/** Another valid PNG: the same magic bytes, one more byte. */
const PNG_2 = Buffer.concat([PNG, Buffer.from([0])]);
/** A root-level file both fixtures name: D219 writes it as an asset of the campaign that names it. */
const SHARED = "assets/inputs/a.png";

const briefs = () => getBriefStore(importTenant("local"));
const assets = () => getAssetStore(importTenant("local"));

function ctxWith(root: string): StepContext {
  return {
    orgId: "local",
    switchedAt: new Date("2026-10-01T00:00:00Z"),
    projectRoot: root,
    outputRoot: join(root, "output"),
    includeSamples: false,
    fsOnly: false,
  };
}

/**
 * A brief as the PARSER returns it, so that the stored body is what the parser writes
 * back (`bodyDrift` is then `undefined`). `own` false: only the root-level ref.
 */
function parsed(slug: string, message = "Hello", own = true) {
  const product = {
    id: "p1",
    name: "P1",
    primaryColor: "#111111",
    logoPath: own ? `assets/inputs/${slug}/logo.png` : SHARED,
    ...(own ? { inputAsset: SHARED } : {}),
  };
  const body = briefBody({ id: slug, campaignMessage: message, products: [product] });
  return parseBriefText(`${slug}.yaml`, dumpBrief(body));
}

/** Campaign `slug` stored with path refs, and the files they name on disk. */
async function seed(root: string, slug: string, own = true) {
  if (own) writeAt(root, `assets/inputs/${slug}/logo.png`, PNG);
  writeAt(root, SHARED, PNG_2);
  return briefs().createBrief(parsed(slug, "Hello", own));
}

/** What the wiring will hand the step: the campaign as classified NOW, its stored body, the reviewed hashes. */
async function input(env: Env, ctx: StepContext, slug: string): Promise<NormaliseInput> {
  const row = (await latestBodies(env.db, "local")).find((found) => found.slug === slug);
  if (row === undefined) throw new Error(`fixture: no latest body for ${slug}`);
  const campaign = classifyExisting(ctx, row);
  if (campaign?.state !== "normalise") {
    throw new Error(`fixture: ${slug} is not class (P): ${JSON.stringify(campaign)}`);
  }
  const targets = resolveRefTargets(ctx, {
    slug,
    sourcePath: "",
    name: null,
    type: null,
    brief: campaign.brief,
    refs: campaign.refs,
    sample: false,
  });
  const expected = new Map(
    targets.map((target) => [target.ref, hashBytes(readFileSync(target.path))]),
  );
  return { campaign, body: row.body, expected };
}

const deps = (over: Partial<NormaliseDeps> = {}): NormaliseDeps => ({
  briefs: briefs(),
  assets: assets(),
  draftCount: async () => 0,
  ...over,
});

/** The asset rows, the version rows and the objects the target holds. */
async function stored(env: Env): Promise<{ assets: number; versions: number; objects: number }> {
  const { rows } = await env.db.query<{ assets: number; versions: number }>(
    "select (select count(*)::int from asset) as assets, (select count(*)::int from brief_version) as versions",
  );
  const objects = env.objects.putCount - env.objects.deleteCount;
  return { assets: rows[0]!.assets, versions: rows[0]!.versions, objects };
}

/** A stored body with its ref fields blanked: what must NOT change. (The fixtures have product refs only.) */
function masked(body: string): string {
  const brief = JSON.parse(body) as { products: { logoPath: string; inputAsset?: string }[] };
  for (const product of brief.products) {
    product.logoPath = "REF";
    if (product.inputAsset !== undefined) product.inputAsset = "REF";
  }
  return JSON.stringify(brief);
}

/** `store`, with `hook` run once just before the first `writeAsset`: a user saving in the middle of the run. */
function beforeFirstWrite(store: AssetStorePort, hook: () => Promise<void>): AssetStorePort {
  let fired = false;
  return new Proxy(store, {
    get(target, prop): unknown {
      const value = (target as unknown as Record<string, unknown>)[prop as string];
      if (typeof value !== "function") return value;
      const call = value as (...args: unknown[]) => unknown;
      if (prop !== "writeAsset") return call.bind(target);
      return async (...args: unknown[]): Promise<unknown> => {
        if (!fired) {
          fired = true;
          await hook();
        }
        return call.apply(target, args);
      };
    },
  });
}

describe.skipIf(ON_A_REAL_TEST_SERVER)("normaliseCampaign: one existing campaign", () => {
  let env: Env;
  let root: string;
  let ctx: StepContext;

  beforeEach(async () => {
    env = await useApplyEnvironment();
    root = makeRoot();
    ctx = ctxWith(root);
  });
  afterEach(async () => {
    dropRoot(root);
    await restoreApplyEnvironment();
  });
  test("the stored body round-trips through the parser, so the fixture is class (P) with no drift", async () => {
    await seed(root, "camp");
    const given = await input(env, ctx, "camp");
    expect(JSON.stringify(given.campaign.brief)).toBe(given.body);
    expect([...given.expected.keys()]).toEqual(["assets/inputs/camp/logo.png", SHARED]);
  });

  test("every ref target and every own input that passes the rules becomes an asset, and a file that fails is listed", async () => {
    const before = await seed(root, "camp");
    writeAt(root, "assets/inputs/camp/extra.png", PNG);
    writeAt(root, "assets/inputs/camp/bad.png", NOT_A_PNG);
    const got = await normaliseCampaign(deps(), ctx, await input(env, ctx, "camp"));
    expect(got).toMatchObject({
      slug: "camp",
      campaignId: before.campaignId,
      status: "normalised",
    });
    expect(got.reason).toBeUndefined();
    expect(got.refusal).toBeUndefined();
    expect(got.minted.assets.map((asset) => asset.name)).toEqual([
      "logo.png",
      "a.png",
      "extra.png",
    ]);
    expect(got.notImported).toEqual([
      { name: "bad.png", reason: '"bad.png" is not a PNG or JPEG file.' },
    ]);
    expect(normaliseWrote(got)).toBe(true);
    const names = (await assets().listAssets("camp")).map((asset) => asset.name).sort();
    expect(names).toEqual(["a.png", "extra.png", "logo.png"]);
    const after = await briefs().findBriefById("camp");
    const refs = collectRefs(after!.brief);
    expect(refs.every(isAssetId)).toBe(true);
    expect(refs).toEqual([got.minted.assets[0]!.id, got.minted.assets[1]!.id]);
    expect((await assets().readAssetById(refs[0]!))?.equals(PNG)).toBe(true);
    expect((await assets().readAssetById(refs[1]!))?.equals(PNG_2)).toBe(true);
  });

  test("the new version is written as the import actor against the planned revision and differs from the old one only in its refs", async () => {
    const before = await seed(root, "camp");
    const got = await normaliseCampaign(deps(), ctx, await input(env, ctx, "camp"));
    expect(got.status).toBe("normalised");
    expect(got.revision).not.toBe(before.revision);
    expect(await briefs().getRevision("camp")).toBe(got.revision);
    const { rows } = await env.db.query<{ version: number; actor: string; body: string }>(
      "select version, actor, body from brief_version order by version",
    );
    expect(rows.map((row) => row.version)).toEqual([1, 2]);
    expect(rows[1]!.actor).toBe("import:pt-8");
    expect(rows[1]!.body).not.toBe(rows[0]!.body);
    expect(masked(rows[1]!.body)).toBe(masked(rows[0]!.body));
  });
  test("a stored body the parser would write back differently is refused, and nothing is written", async () => {
    await seed(root, "camp");
    const first = await input(env, ctx, "camp");
    const pretty = JSON.stringify(JSON.parse(first.body), null, 1);
    await env.db.query("update brief_version set body = $1", [pretty]);
    const given = await input(env, ctx, "camp");
    const before = await stored(env);
    const got = await normaliseCampaign(deps(), ctx, given);
    expect(got).toMatchObject({ status: "refused", refusal: "body", minted: { assets: [] } });
    expect(got.reason).toMatch(/^the stored body is not what the import would write back/);
    expect(await stored(env)).toEqual(before);
    expect(normaliseWrote(got)).toBe(false);
  });

  test("a campaign that has a draft is not normalised, and nothing is written", async () => {
    await seed(root, "camp");
    const given = await input(env, ctx, "camp");
    const before = await stored(env);
    const got = await normaliseCampaign(deps({ draftCount: async () => 2 }), ctx, given);
    expect(got).toMatchObject({
      status: "refused",
      refusal: "draft",
      reason: "the campaign has 2 unsaved draft(s); a new version would discard them",
      minted: { assets: [] },
    });
    expect(await stored(env)).toEqual(before);
  });
  test("a ref target that changed since the digest, or is not in it, refuses the campaign and nothing is written", async () => {
    await seed(root, "camp");
    const given = await input(env, ctx, "camp");
    const before = await stored(env);
    const unknown = await normaliseCampaign(deps(), ctx, { ...given, expected: new Map() });
    expect(unknown).toMatchObject({
      status: "refused",
      refusal: "source",
      reason: 'ref "assets/inputs/camp/logo.png" is not in the reviewed digest',
    });
    writeAt(root, SHARED, PNG);
    const changed = await normaliseCampaign(deps(), ctx, given);
    expect(changed).toMatchObject({
      status: "refused",
      refusal: "source",
      reason: 'ref "assets/inputs/a.png" changed since the digest',
      minted: { assets: [] },
    });
    expect(await stored(env)).toEqual(before);
  });

  test("a read that throws before the first write is a refusal, never a throw", async () => {
    await seed(root, "camp");
    const given = await input(env, ctx, "camp");
    const before = await stored(env);
    const broken = deps({
      draftCount: async () => {
        throw new Error("the database went away");
      },
    });
    expect(await normaliseCampaign(broken, ctx, given)).toEqual({
      slug: "camp",
      campaignId: given.campaign.campaignId,
      status: "refused",
      refusal: "failed",
      reason: "the database went away",
      minted: { assets: [] },
      notImported: [],
    });
    expect(await stored(env)).toEqual(before);
  });
  test("a revision that moved since the plan is a conflict before the first asset write", async () => {
    await seed(root, "camp");
    const given = await input(env, ctx, "camp");
    const theirs = await briefs().rewriteBrief(parsed("camp", "Changed by a user"));
    const before = await stored(env);
    const got = await normaliseCampaign(deps(), ctx, given);
    expect(got).toMatchObject({ status: "conflict", minted: { assets: [] } });
    expect(got.refusal).toBeUndefined();
    expect(got.reason).toBe(
      `the campaign's latest revision is no longer ${given.campaign.revision}`,
    );
    expect(await stored(env)).toEqual(before);
    expect(await briefs().getRevision("camp")).toBe(theirs.revision);
    expect(normaliseWrote(got)).toBe(false);
  });

  test("a 409 from the version write leaves the assets and lists exactly them as a conflict; the next run reuses them", async () => {
    await seed(root, "camp");
    const given = await input(env, ctx, "camp");
    let theirs: string | undefined;
    const racing = beforeFirstWrite(assets(), async () => {
      theirs = (await briefs().rewriteBrief(parsed("camp", "Changed by a user"))).revision;
    });
    const got = await normaliseCampaign(deps({ assets: racing }), ctx, given);
    expect(got.status).toBe("conflict");
    expect(got.reason).toBe("Brief was modified by another user.");
    expect(got.minted.assets.map((asset) => asset.name)).toEqual(["logo.png", "a.png"]);
    for (const asset of got.minted.assets) {
      expect(await assets().readAssetById(asset.id)).toBeDefined();
    }
    expect(normaliseWrote(got)).toBe(true);
    expect(await briefs().getRevision("camp")).toBe(theirs);
    expect(await stored(env)).toMatchObject({ assets: 2, versions: 2 });
    const again = await normaliseCampaign(deps(), ctx, await input(env, ctx, "camp"));
    expect(again.status).toBe("normalised");
    expect(again.minted.assets).toEqual([]);
    expect(await stored(env)).toMatchObject({ assets: 2, versions: 3 });
    const after = await briefs().findBriefById("camp");
    expect(collectRefs(after!.brief)).toEqual(got.minted.assets.map((asset) => asset.id));
  });
  test("a store that throws on the second asset write yields a result that lists the first mint, and no version is written", async () => {
    await seed(root, "camp");
    const given = await input(env, ctx, "camp");
    const failing = failOnNth(assets(), "writeAsset", 2);
    const got = await normaliseCampaign(deps({ assets: failing }), ctx, given);
    expect(got).toMatchObject({ status: "refused", refusal: "failed", reason: "injected" });
    expect(got.minted.assets.map((asset) => asset.name)).toEqual(["logo.png"]);
    expect(await assets().readAssetById(got.minted.assets[0]!.id)).toBeDefined();
    expect(await stored(env)).toMatchObject({ assets: 1, versions: 1 });
    expect(normaliseWrote(got)).toBe(true);
  });

  test("a second run over a normalised campaign writes nothing new", async () => {
    await seed(root, "camp");
    const given = await input(env, ctx, "camp");
    expect((await normaliseCampaign(deps(), ctx, given)).status).toBe("normalised");
    const row = (await latestBodies(env.db, "local")).find((found) => found.slug === "camp");
    expect(classifyExisting(ctx, row!)).toBeUndefined();
    const before = await stored(env);
    const second = await normaliseCampaign(deps(), ctx, given);
    expect(second).toMatchObject({ status: "conflict", minted: { assets: [] } });
    expect(await stored(env)).toEqual(before);
    expect(normaliseWrote(second)).toBe(false);
  });

  test("a campaign with only a root-level ref and no inputs folder of its own is normalised (D219)", async () => {
    await seed(root, "solo", false);
    const got = await normaliseCampaign(deps(), ctx, await input(env, ctx, "solo"));
    expect(got.status).toBe("normalised");
    expect(got.minted.assets.map((asset) => asset.name)).toEqual(["a.png"]);
    expect(got.notImported).toEqual([]);
    expect((await assets().listAssets("solo")).map((asset) => asset.name)).toEqual(["a.png"]);
  });
});
