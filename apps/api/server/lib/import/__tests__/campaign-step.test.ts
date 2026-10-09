import { readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { classifyRefs } from "../classify.js";
import {
  importCampaign,
  importCampaignStep,
  preflight,
  probeCampaign,
  type CampaignResult,
  type HashedContext,
  type ImportDeps,
} from "../campaign-step.js";
import { hashBytes } from "../../brief-files.js";
import { resolveRefTargets } from "../asset-step.js";
import { importTenant } from "../import-tenant.js";
import { getAssetStore, getBriefStore } from "../../ports/index.js";
import type { SqlClient } from "../../db/sql-client.js";
import type { ScannedCampaign } from "../scan.js";
import type { StepContext } from "../steps.js";
import {
  failOnNth,
  restoreApplyEnvironment,
  useApplyEnvironment,
} from "./fixtures/apply-harness.js";
import { MP3, PNG, type BriefOverrides, briefBody, dropRoot, makeRoot, writeAt, writeBrief } from "./fixtures/tree.js";

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

function scannedWith(root: string, slug: string, refs: ScannedCampaign["refs"] = []): {
  ctx: StepContext;
  scanned: ScannedCampaign;
} {
  const ctx = ctxWith(root);
  const sourcePath = writeBrief(root, `${slug}.yaml`, { id: slug });
  const scanned: ScannedCampaign = {
    slug,
    sourcePath,
    name: null,
    type: null,
    brief: briefBody({ id: slug }),
    refs,
    sample: false,
  };
  return { ctx, scanned };
}

function buildScanned(
  root: string,
  slug: string,
  overrides: BriefOverrides,
): { ctx: StepContext; scanned: ScannedCampaign; expected: Map<string, string> } {
  const ctx = ctxWith(root);
  const sourcePath = writeBrief(root, `${slug}.yaml`, overrides);
  const brief = briefBody(overrides);
  for (const product of brief.products ?? []) {
    if (typeof product.logoPath === "string") writeAt(root, product.logoPath, PNG);
    if (typeof product.inputAsset === "string") writeAt(root, product.inputAsset, PNG);
  }
  if (brief.audio !== undefined) writeAt(root, brief.audio.path, MP3);
  for (const beat of brief.copy?.timeline?.beats ?? []) {
    if (typeof beat.background === "string") writeAt(root, beat.background, PNG);
  }
  const draft: ScannedCampaign = {
    slug,
    sourcePath,
    name: null,
    type: null,
    brief,
    refs: [],
    sample: false,
  };
  const scanned: ScannedCampaign = { ...draft, refs: classifyRefs(ctx, draft) };
  const expected = new Map<string, string>();
  expected.set(relative(ctx.projectRoot, sourcePath), hashBytes(readFileSync(sourcePath)));
  for (const target of resolveRefTargets(ctx, scanned)) {
    expected.set(relative(ctx.projectRoot, target.path), hashBytes(readFileSync(target.path)));
  }
  return { ctx, scanned, expected };
}

describe("campaign-step: preflight", () => {
  test("a reserved slug is refused before any write", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned } = scannedWith(root, "briefs");
      const result = await preflight(ctx, scanned, new Map());
      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.reason : "").toContain("reserved");
    } finally {
      dropRoot(root);
    }
  });

  test("a uuid-shaped slug is refused before any write", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned } = scannedWith(root, "11111111-1111-1111-1111-111111111111");
      const result = await preflight(ctx, scanned, new Map());
      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.reason : "").toMatch(/uuid/);
    } finally {
      dropRoot(root);
    }
  });

  test("preflight succeeds and resolves the ref target", async () => {
    const root = makeRoot();
    try {
      writeAt(root, join("assets/inputs/logo.png"), PNG);
      const ctx = ctxWith(root);
      const overrides = {
        id: "camp",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/logo.png" },
        ],
      };
      const sourcePath = writeBrief(root, "camp.yaml", overrides);
      const brief = briefBody(overrides);
      const draft: ScannedCampaign = {
        slug: "camp",
        sourcePath,
        name: null,
        type: null,
        brief,
        refs: [],
        sample: false,
      };
      const scanned: ScannedCampaign = { ...draft, refs: classifyRefs(ctx, draft) };
      const expected = new Map<string, string>();
      expected.set(relative(ctx.projectRoot, sourcePath), hashBytes(readFileSync(sourcePath)));
      for (const target of resolveRefTargets(ctx, scanned)) {
        expected.set(relative(ctx.projectRoot, target.path), hashBytes(readFileSync(target.path)));
      }

      const result = await preflight(ctx, scanned, expected);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.preflight.targets.length).toBe(1);
        expect(result.preflight.targetBytes.get("assets/inputs/logo.png")).toEqual(PNG);
      }
    } finally {
      dropRoot(root);
    }
  });
});

describe("campaign-step: probe", () => {
  beforeEach(async () => {
    await useApplyEnvironment();
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("probe is absent when no campaign row exists", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/camp/logo.png" },
        ],
      });
      const pf = await preflight(ctx, scanned, expected);
      if (!pf.ok) throw new Error(pf.reason);
      const briefs = getBriefStore(importTenant("local"));
      const assets = getAssetStore(importTenant("local"));
      const decision = await probeCampaign(briefs, assets, ctx, scanned, pf.preflight);
      expect(decision.kind).toBe("absent");
    } finally {
      dropRoot(root);
    }
  });

  test("probe is versionless when the campaign row has no version", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/camp/logo.png" },
        ],
      });
      const pf = await preflight(ctx, scanned, expected);
      if (!pf.ok) throw new Error(pf.reason);
      const briefs = getBriefStore(importTenant("local"));
      const assets = getAssetStore(importTenant("local"));
      await briefs.createCampaign("camp");
      const decision = await probeCampaign(briefs, assets, ctx, scanned, pf.preflight);
      expect(decision.kind).toBe("versionless");
    } finally {
      dropRoot(root);
    }
  });
});

async function campaignCounts(
  db: SqlClient,
  putCount: number,
): Promise<{ campaigns: number; assets: number; versions: number; objects: number }> {
  const campaigns = (await db.query<{ n: number }>(`select count(*)::int as n from campaign where org_id=$1`, ["local"])).rows[0]!.n;
  const assets = (await db.query<{ n: number }>(`select count(*)::int as n from asset where org_id=$1`, ["local"])).rows[0]!.n;
  const versions = (await db.query<{ n: number }>(`select count(*)::int as n from brief_version`)).rows[0]!.n;
  return { campaigns, assets, versions, objects: putCount };
}

function makeDeps(): ImportDeps {
  return {
    briefs: getBriefStore(importTenant("local")),
    assets: getAssetStore(importTenant("local")),
  };
}

/** Build the tree, scan it, classify, and compute the reviewed hashes for `importCampaign`. */
async function importIt(
  root: string,
  overrides: BriefOverrides,
): Promise<{ ctx: StepContext; scanned: ScannedCampaign; expected: Map<string, string>; deps: ImportDeps }> {
  const { ctx, scanned, expected } = buildScanned(root, overrides.id, overrides);
  return { ctx, scanned, expected, deps: makeDeps() };
}

describe("campaign-step: importCampaign", () => {
  let env: Awaited<ReturnType<typeof useApplyEnvironment>>;
  beforeEach(async () => {
    env = await useApplyEnvironment();
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("a first importCampaign creates the campaign and writes its assets", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/camp/logo.png" },
        ],
      });
      const deps = {
        briefs: getBriefStore(importTenant("local")),
        assets: getAssetStore(importTenant("local")),
      };
      const result = await importCampaign(deps, ctx, scanned, expected);
      expect(result.outcome).toBe("created");
      expect(result.minted.campaignId).toBeDefined();
      expect(result.minted.assets.length).toBe(1);
      const stored = await deps.briefs.findBriefById("camp");
      expect(stored).toBeDefined();
    } finally {
      dropRoot(root);
    }
  });

  test("a second importCampaign over the same source writes nothing and reports unchanged", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected, deps } = await importIt(root, {
        id: "camp",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/camp/logo.png" },
        ],
      });
      expect((await importCampaign(deps, ctx, scanned, expected)).outcome).toBe("created");
      const before = await campaignCounts(env.db, env.objects.putCount);

      const second = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(second.outcome).toBe("unchanged");
      expect(second.minted.assets.length).toBe(0);
      expect(second.minted.campaignId).toBeUndefined();
      expect(await campaignCounts(env.db, env.objects.putCount)).toEqual(before);
      expect(env.objects.putCount).toBe(before.objects);
    } finally {
      dropRoot(root);
    }
  });
});

describe("campaign-step: interruption and resumability (N2)", () => {
  let env: Awaited<ReturnType<typeof useApplyEnvironment>>;
  beforeEach(async () => {
    env = await useApplyEnvironment();
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("an importCampaign interrupted after createCampaign is completed by the next run", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/camp/logo.png" },
        ],
      });
      const briefs = getBriefStore(importTenant("local"));
      const assets = failOnNth(getAssetStore(importTenant("local")), "writeAsset", 1);
      const deps: ImportDeps = { briefs, assets };
      const first = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(first.outcome).toBe("refused");
      expect(first.partial).toBe(true);

      const again = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(again.outcome).toBe("completed");
      const rows = (await env.db.query<{ n: number }>(
        `select count(*)::int as n from campaign where org_id=$1`,
        ["local"],
      )).rows[0]!.n;
      expect(rows).toBe(1);
      const versions = (await env.db.query<{ n: number }>(`select count(*)::int as n from brief_version`)).rows[0]!.n;
      expect(versions).toBe(1);
      const meta = await briefs.campaignMeta("camp");
      expect(meta).toBeDefined();
    } finally {
      dropRoot(root);
    }
  });

  test("a versionless campaign row is completed without calling createCampaign", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/camp/logo.png" },
        ],
      });
      const briefs = getBriefStore(importTenant("local"));
      const assets = getAssetStore(importTenant("local"));
      await briefs.createCampaign("camp", { name: "Camp", type: "static" });
      const deps: ImportDeps = {
        briefs: failOnNth(briefs, "createCampaign", 1),
        assets,
      };
      const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(result.outcome).toBe("completed");
      expect(result.minted.campaignId).toBeUndefined();
      const versions = (await env.db.query<{ n: number }>(`select count(*)::int as n from brief_version`)).rows[0]!.n;
      expect(versions).toBe(1);
    } finally {
      dropRoot(root);
    }
  });
});

describe("campaign-step: refusals before the first write (N3)", () => {
  let env: Awaited<ReturnType<typeof useApplyEnvironment>>;
  beforeEach(async () => {
    env = await useApplyEnvironment();
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("a ref that is missing when the step runs refuses the campaign with no row left", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/camp/logo.png" },
        ],
      });
      rmSync(join(ctx.projectRoot, "assets/inputs/camp/logo.png"));
      const rescanned: ScannedCampaign = { ...scanned, refs: classifyRefs(ctx, scanned) };
      const deps = makeDeps();
      const result = (await importCampaign(deps, ctx, rescanned, expected)) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect((await campaignCounts(env.db, env.objects.putCount)).campaigns).toBe(0);
      expect(env.objects.putCount).toBe(0);
    } finally {
      dropRoot(root);
    }
  });

  test("a reserved slug is refused by the step and nothing is written", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "briefs", {
        id: "briefs",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/briefs/logo.png" },
        ],
      });
      const deps = makeDeps();
      const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect(result.reason).toMatch(/reserved/);
      expect((await campaignCounts(env.db, env.objects.putCount)).campaigns).toBe(0);
    } finally {
      dropRoot(root);
    }
  });
});

describe("campaign-step: importCampaignStep", () => {
  let env: Awaited<ReturnType<typeof useApplyEnvironment>>;
  beforeEach(async () => {
    env = await useApplyEnvironment();
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("the step without reviewed hashes refuses and writes nothing", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/camp/logo.png" },
        ],
      });
      const deps: ImportDeps = {
        briefs: getBriefStore(importTenant("local")),
        assets: getAssetStore(importTenant("local")),
      };
      const result = (await importCampaignStep(ctx, {
        slug: scanned.slug,
        sourcePath: scanned.sourcePath,
      })) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect(result.reason).toBe("no reviewed source hashes in the step context");
      expect(await deps.briefs.campaignMeta("camp")).toBeUndefined();
    } finally {
      dropRoot(root);
    }
  });

  test("the step with reviewed hashes imports and stamps import:pt-8", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/camp/logo.png" },
        ],
      });
      const hashedCtx: HashedContext = { ...ctx, expectedHashes: expected };
      const deps: ImportDeps = {
        briefs: getBriefStore(importTenant("local")),
        assets: getAssetStore(importTenant("local")),
      };
      const result = (await importCampaignStep(hashedCtx, {
        slug: scanned.slug,
        sourcePath: scanned.sourcePath,
      })) as CampaignResult;
      expect(result.outcome).toBe("created");
      const { rows } = await env.db.query<{ actor: string }>(
        `select bv.actor from brief_version bv
           join campaign c on c.id = bv.campaign_id
          where c.org_id = $1 and c.slug = $2`,
        ["local", scanned.slug],
      );
      expect(rows[0]?.actor).toBe("import:pt-8");
    } finally {
      dropRoot(root);
    }
  });
});
