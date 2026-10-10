import { existsSync, readFileSync, rmSync } from "node:fs";
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
import { collectRefs } from "../../asset-files.js";
import { isAssetId } from "../../ports/asset-store.port.js";
import { resolveRefTargets } from "../asset-step.js";
import { importTenant } from "../import-tenant.js";
import { getAssetStore, getBriefStore } from "../../ports/index.js";
import { objectStoreClient } from "../../object-store/index.js";
import type { AssetStorePort } from "../../ports/asset-store.port.js";
import type { BriefStorePort } from "../../ports/brief-store.port.js";
import type { SqlClient } from "../../db/sql-client.js";
import type { ScannedCampaign } from "../scan.js";
import type { StepContext } from "../steps.js";
import {
  failOnNth,
  ON_A_REAL_TEST_SERVER,
  restoreApplyEnvironment,
  useApplyEnvironment,
} from "./fixtures/apply-harness.js";
import {
  MP3,
  NOT_A_PNG,
  PNG,
  type BriefOverrides,
  briefBody,
  dropRoot,
  makeRoot,
  writeAt,
  writeBrief,
  writeHtmlLayerBrief,
} from "./fixtures/tree.js";

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

function scannedWith(
  root: string,
  slug: string,
  refs: ScannedCampaign["refs"] = [],
): {
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
  const metaPath = join(ctx.projectRoot, "briefs", slug, "campaign.json");
  if (existsSync(metaPath)) {
    expected.set(`briefs/${slug}/campaign.json`, hashBytes(readFileSync(metaPath)));
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

  test("a brief absent from the reviewed digest is refused", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      expected.delete(relative(ctx.projectRoot, scanned.sourcePath));
      const result = await preflight(ctx, scanned, expected);
      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.reason : "").toMatch(/not in the reviewed digest/);
    } finally {
      dropRoot(root);
    }
  });

  test("a ref target absent from the reviewed digest is refused", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      for (const key of expected.keys()) if (key.startsWith("assets/")) expected.delete(key);
      const result = await preflight(ctx, scanned, expected);
      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.reason : "").toMatch(/not in the reviewed digest/);
    } finally {
      dropRoot(root);
    }
  });
});

describe.skipIf(ON_A_REAL_TEST_SERVER)("campaign-step: probe", () => {
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
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
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
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
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
  objects: { putCount: number; deleteCount: number },
): Promise<{ campaigns: number; assets: number; versions: number; objects: number }> {
  const campaigns = (
    await db.query<{ n: number }>(`select count(*)::int as n from campaign where org_id=$1`, [
      "local",
    ])
  ).rows[0]!.n;
  const assets = (
    await db.query<{ n: number }>(`select count(*)::int as n from asset where org_id=$1`, ["local"])
  ).rows[0]!.n;
  const versions = (await db.query<{ n: number }>(`select count(*)::int as n from brief_version`))
    .rows[0]!.n;
  // Net objects: reuses cost a put + a best-effort delete (D227/Known limit), so
  // `putCount` overcounts until discards are subtracted.
  return { campaigns, assets, versions, objects: objects.putCount - objects.deleteCount };
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
): Promise<{
  ctx: StepContext;
  scanned: ScannedCampaign;
  expected: Map<string, string>;
  deps: ImportDeps;
}> {
  const { ctx, scanned, expected } = buildScanned(root, overrides.id, overrides);
  return { ctx, scanned, expected, deps: makeDeps() };
}

/** A 1x1 PNG whose bytes differ from `PNG`, for collision/suffix tests. */
const PNG2 = Buffer.concat([PNG, Buffer.from("second-bytes")]);

/**
 * Write `firstRef`/`secondRef` (both `assets/inputs/...`) with the given bytes,
 * build a two-product brief naming them, and run `importCampaign` once.
 */
async function importTwoLogos(
  root: string,
  firstRef: string,
  secondRef: string,
  firstBytes: Buffer,
  secondBytes: Buffer,
): Promise<{
  ctx: StepContext;
  scanned: ScannedCampaign;
  expected: Map<string, string>;
  deps: ImportDeps;
  result: CampaignResult;
}> {
  const ctx = ctxWith(root);
  writeAt(root, firstRef, firstBytes);
  writeAt(root, secondRef, secondBytes);
  const overrides: BriefOverrides = {
    id: "camp",
    products: [
      { id: "p1", name: "P1", primaryColor: "#111111", logoPath: firstRef },
      { id: "p2", name: "P2", primaryColor: "#222222", logoPath: secondRef },
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
  const deps = makeDeps();
  const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
  return { ctx, scanned, expected, deps, result };
}

/** `importIt` + the single `importCampaign` call, returning the result. */
async function run(
  root: string,
  overrides: BriefOverrides,
): Promise<{
  ctx: StepContext;
  scanned: ScannedCampaign;
  expected: Map<string, string>;
  deps: ImportDeps;
  result: CampaignResult;
}> {
  const { ctx, scanned, expected, deps } = await importIt(root, overrides);
  const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
  return { ctx, scanned, expected, deps, result };
}

/** Seed a versionful campaign row + asset row + brief_version, returning the asset id. */
async function seedCampaign(root: string, slug: string, assetBytes: Buffer): Promise<string> {
  const { assets, briefs } = makeDeps();
  await briefs.createCampaign(slug);
  const written = await assets.writeAsset(slug, "logo.png", assetBytes);
  const id = written.id!;
  const brief = briefBody({
    id: slug,
    products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: id }],
  });
  await briefs.createBrief(brief);
  return id;
}

describe.skipIf(ON_A_REAL_TEST_SERVER)("campaign-step: importCampaign", () => {
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
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
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
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      expect((await importCampaign(deps, ctx, scanned, expected)).outcome).toBe("created");
      const before = await campaignCounts(env.db, env.objects);

      const second = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(second.outcome).toBe("unchanged");
      expect(second.minted.assets.length).toBe(0);
      expect(second.minted.campaignId).toBeUndefined();
      expect(await campaignCounts(env.db, env.objects)).toEqual(before);
      expect(env.objects.putCount).toBe(before.objects);
    } finally {
      dropRoot(root);
    }
  });
});

describe.skipIf(ON_A_REAL_TEST_SERVER)("campaign-step: interruption and resumability (N2)", () => {
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
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
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
      const counts = await campaignCounts(env.db, env.objects);
      expect(counts).toEqual({ campaigns: 1, assets: 1, versions: 1, objects: 1 });
      expect(counts.assets).toBe(counts.objects);
      const entries = await deps.assets.listAssets("camp");
      expect(entries.map((e) => e.name).sort()).toEqual(["logo.png"]);
      expect(again.minted.assets).toHaveLength(1);
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
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
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
      const versions = (
        await env.db.query<{ n: number }>(`select count(*)::int as n from brief_version`)
      ).rows[0]!.n;
      expect(versions).toBe(1);
    } finally {
      dropRoot(root);
    }
  });

  async function threeInputs(): Promise<{ root: string; overrides: BriefOverrides }> {
    const root = makeRoot();
    return {
      root,
      overrides: {
        id: "camp",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/camp/a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "assets/inputs/camp/b.png" },
          { id: "p3", name: "P3", primaryColor: "#333333", logoPath: "assets/inputs/camp/c.png" },
        ],
      },
    };
  }

  test("an importCampaign interrupted after the second asset is completed by the next run", async () => {
    const { root, overrides } = await threeInputs();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", overrides);
      const deps: ImportDeps = {
        briefs: getBriefStore(importTenant("local")),
        assets: failOnNth(getAssetStore(importTenant("local")), "writeAsset", 3),
      };
      const first = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(first.outcome).toBe("refused");
      expect(first.partial).toBe(true);

      const again = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(again.outcome).toBe("completed");
      const counts = await campaignCounts(env.db, env.objects);
      expect(counts.campaigns).toBe(1);
      expect(counts.versions).toBe(1);
      expect(counts.assets).toBe(3);
      expect(counts.assets).toBe(counts.objects);
      const entries = await deps.assets.listAssets("camp");
      expect(entries.map((e) => e.name).sort()).toEqual(["a.png", "b.png", "c.png"]);
      expect(again.minted.assets).toHaveLength(1);
      expect(again.minted.assets[0].name).toBe("c.png");
    } finally {
      dropRoot(root);
    }
  });

  test("an importCampaign interrupted before createBrief is completed by the next run", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const deps: ImportDeps = {
        briefs: getBriefStore(importTenant("local")),
        assets: getAssetStore(importTenant("local")),
      };
      // First call to createBrief fails (injected); rerun succeeds (counter moves past 1).
      const wrapped = failOnNth(deps.briefs, "createBrief", 1);
      const first = (await importCampaign(
        { briefs: wrapped, assets: deps.assets },
        ctx,
        scanned,
        expected,
      )) as CampaignResult;
      expect(first.outcome).toBe("refused");
      expect(first.partial).toBe(true);
      expect(first.minted.assets.length).toBe(1);

      const again = (await importCampaign(
        { briefs: wrapped, assets: deps.assets },
        ctx,
        scanned,
        expected,
      )) as CampaignResult;
      expect(again.outcome).toBe("completed");
      const counts = await campaignCounts(env.db, env.objects);
      expect(counts).toEqual({ campaigns: 1, assets: 1, versions: 1, objects: 1 });
      expect(counts.assets).toBe(counts.objects);
      const entries = await deps.assets.listAssets("camp");
      expect(entries.map((e) => e.name).sort()).toEqual(["logo.png"]);
      expect(again.minted.assets).toHaveLength(0);
    } finally {
      dropRoot(root);
    }
  });
});

describe.skipIf(ON_A_REAL_TEST_SERVER)(
  "campaign-step: refusals before the first write (N3)",
  () => {
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
            {
              id: "p1",
              name: "P1",
              primaryColor: "#111111",
              logoPath: "assets/inputs/camp/logo.png",
            },
          ],
        });
        rmSync(join(ctx.projectRoot, "assets/inputs/camp/logo.png"));
        const rescanned: ScannedCampaign = { ...scanned, refs: classifyRefs(ctx, scanned) };
        const deps = makeDeps();
        const result = (await importCampaign(deps, ctx, rescanned, expected)) as CampaignResult;
        expect(result.outcome).toBe("refused");
        expect((await campaignCounts(env.db, env.objects)).campaigns).toBe(0);
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
            {
              id: "p1",
              name: "P1",
              primaryColor: "#111111",
              logoPath: "assets/inputs/briefs/logo.png",
            },
          ],
        });
        const deps = makeDeps();
        const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
        expect(result.outcome).toBe("refused");
        expect(result.reason).toMatch(/reserved/);
        expect((await campaignCounts(env.db, env.objects)).campaigns).toBe(0);
      } finally {
        dropRoot(root);
      }
    });

    test("a uuid-shaped slug is refused and nothing is written", async () => {
      const root = makeRoot();
      try {
        const { ctx, scanned, expected } = buildScanned(
          root,
          "11111111-1111-1111-1111-111111111111",
          {
            id: "11111111-1111-1111-1111-111111111111",
            products: [
              {
                id: "p1",
                name: "P1",
                primaryColor: "#111111",
                logoPath: "assets/inputs/11111111-1111-1111-1111-111111111111/logo.png",
              },
            ],
          },
        );
        const deps = makeDeps();
        const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
        expect(result.outcome).toBe("refused");
        expect(result.reason).toMatch(/uuid/);
        expect((await campaignCounts(env.db, env.objects)).campaigns).toBe(0);
      } finally {
        dropRoot(root);
      }
    });

    test("a ref refused by the upload rules when the step runs refuses the campaign with no row left", async () => {
      const root = makeRoot();
      try {
        const { ctx, scanned, expected } = buildScanned(root, "camp", {
          id: "camp",
          products: [
            {
              id: "p1",
              name: "P1",
              primaryColor: "#111111",
              logoPath: "assets/inputs/camp/logo.png",
            },
          ],
        });
        writeAt(root, join("assets/inputs/camp/logo.png"), NOT_A_PNG);
        const rescanned: ScannedCampaign = { ...scanned, refs: classifyRefs(ctx, scanned) };
        const deps = makeDeps();
        const result = (await importCampaign(deps, ctx, rescanned, expected)) as CampaignResult;
        expect(result.outcome).toBe("refused");
        expect((await campaignCounts(env.db, env.objects)).campaigns).toBe(0);
        expect(env.objects.putCount).toBe(0);
      } finally {
        dropRoot(root);
      }
    });

    test("an EEXIST at createCampaign is listed as refused: slug reserved and nothing else is written", async () => {
      const root = makeRoot();
      try {
        const { ctx, scanned, expected } = buildScanned(root, "camp", {
          id: "camp",
          products: [
            {
              id: "p1",
              name: "P1",
              primaryColor: "#111111",
              logoPath: "assets/inputs/camp/logo.png",
            },
          ],
        });
        const briefs = getBriefStore(importTenant("local"));
        const assets = getAssetStore(importTenant("local"));
        await briefs.createCampaign("camp");
        const blind: BriefStorePort = new Proxy(briefs, {
          get(target, prop, receiver) {
            if (prop === "campaignMeta") return () => Promise.resolve(undefined);
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const deps: ImportDeps = { briefs: blind, assets };
        const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
        expect(result.outcome).toBe("refused");
        expect(result.reason).toBe("refused: slug reserved");
        expect(result.partial).toBeUndefined();
        expect((await campaignCounts(env.db, env.objects)).assets).toBe(0);
        expect(env.objects.putCount).toBe(0);
      } finally {
        dropRoot(root);
      }
    });

    test("a slug used by a campaign with a different body is refused and not renamed", async () => {
      const root = makeRoot();
      try {
        const over = (message: string) => ({
          id: "camp",
          campaignMessage: message,
          products: [
            {
              id: "p1",
              name: "P1",
              primaryColor: "#111111",
              logoPath: "assets/inputs/camp/logo.png",
            },
          ],
        });
        const { ctx: c1, scanned: s1, expected: e1 } = buildScanned(root, "camp", over("Hello"));
        const deps = makeDeps();
        expect((await importCampaign(deps, c1, s1, e1)).outcome).toBe("created");

        const {
          ctx: c2,
          scanned: s2,
          expected: e2,
        } = buildScanned(root, "camp", over("A different message"));
        const again = (await importCampaign(deps, c2, s2, e2)) as CampaignResult;
        expect(again.outcome).toBe("refused");
        expect(
          (await env.db.query<{ n: number }>(`select count(*)::int as n from brief_version`))
            .rows[0]!.n,
        ).toBe(1);
        const slugs = (
          await env.db.query<{ slug: string }>(`select slug from campaign where org_id=$1`, [
            "local",
          ])
        ).rows;
        expect(slugs.map((r) => r.slug)).toEqual(["camp"]);
      } finally {
        dropRoot(root);
      }
    });
  },
);

describe.skipIf(ON_A_REAL_TEST_SERVER)("campaign-step: brief integrity (N4, N5, D220)", () => {
  beforeEach(async () => {
    await useApplyEnvironment();
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("no path ref remains in any imported brief", async () => {
    const root = makeRoot();
    try {
      const { deps } = await run(root, {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
            inputAsset: "assets/inputs/camp/input.png",
          },
        ],
      });
      const stored = await deps.briefs.findBriefById("camp");
      expect(stored).toBeDefined();
      expect(collectRefs(stored!.brief).every(isAssetId)).toBe(true);
    } finally {
      dropRoot(root);
    }
  });

  test("a slug is imported exactly as the brief names it", async () => {
    const root = makeRoot();
    try {
      const { deps } = await run(root, {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const meta = await deps.briefs.campaignMeta("camp");
      expect(meta).toBeDefined();
      expect(meta!.slug).toBe("camp");
    } finally {
      dropRoot(root);
    }
  });
});

describe.skipIf(ON_A_REAL_TEST_SERVER)("campaign-step: importCampaignStep", () => {
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
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
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

  test("the stored version is stamped import:pt-8", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const hashedCtx: HashedContext = { ...ctx, expectedHashes: expected };
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

  test("the campaign row carries the campaign meta name and type, or null without one, with team_id null", async () => {
    const root = makeRoot();
    try {
      writeAt(
        root,
        join("briefs/camp/campaign.json"),
        JSON.stringify({ name: "Summer Hydration", type: "social-post" }),
      );
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const hashedCtx: HashedContext = { ...ctx, expectedHashes: expected };
      const result = (await importCampaignStep(hashedCtx, {
        slug: scanned.slug,
        sourcePath: scanned.sourcePath,
      })) as CampaignResult;
      expect(result.outcome).toBe("created");
      const row = (
        await env.db.query<{ name: string | null; type: string | null; team_id: string | null }>(
          `select name, type, team_id from campaign where org_id=$1 and slug=$2`,
          ["local", "camp"],
        )
      ).rows[0];
      expect(row?.name).toBe("Summer Hydration");
      expect(row?.type).toBe("social-post");
      expect(row?.team_id).toBeNull();
    } finally {
      dropRoot(root);
    }
  });

  test("a campaign.json with non-string meta stores null name and type", async () => {
    const root = makeRoot();
    try {
      writeAt(root, join("briefs/camp/campaign.json"), JSON.stringify({ name: 123, type: true }));
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const hashedCtx: HashedContext = { ...ctx, expectedHashes: expected };
      await importCampaignStep(hashedCtx, { slug: scanned.slug, sourcePath: scanned.sourcePath });
      const row = (
        await env.db.query<{ name: string | null; type: string | null }>(
          `select name, type from campaign where org_id=$1 and slug=$2`,
          ["local", "camp"],
        )
      ).rows[0];
      expect(row?.name).toBeNull();
      expect(row?.type).toBeNull();
    } finally {
      dropRoot(root);
    }
  });

  test("the step refuses a brief it cannot parse and writes nothing", async () => {
    const root = makeRoot();
    try {
      const sourcePath = writeHtmlLayerBrief(root, "camp.yaml", "camp");
      writeAt(root, "assets/inputs/camp/logo.png", PNG);
      const ctx = ctxWith(root);
      const expected = new Map<string, string>();
      expected.set(relative(ctx.projectRoot, sourcePath), hashBytes(readFileSync(sourcePath)));
      const hashedCtx: HashedContext = { ...ctx, expectedHashes: expected };
      const result = (await importCampaignStep(hashedCtx, {
        slug: "camp",
        sourcePath,
      })) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect(result.reason).toMatch(/camp\.yaml/);
      expect((await campaignCounts(env.db, env.objects)).campaigns).toBe(0);
    } finally {
      dropRoot(root);
    }
  });

  test("the step refuses a brief file that is gone and writes nothing", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      rmSync(scanned.sourcePath);
      const hashedCtx: HashedContext = { ...ctx, expectedHashes: expected };
      const result = (await importCampaignStep(hashedCtx, {
        slug: scanned.slug,
        sourcePath: scanned.sourcePath,
      })) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect(result.reason).toMatch(/camp\.yaml/);
      expect((await campaignCounts(env.db, env.objects)).campaigns).toBe(0);
    } finally {
      dropRoot(root);
    }
  });
});

describe.skipIf(ON_A_REAL_TEST_SERVER)("campaign-step: asset names (D219/D221)", () => {
  beforeEach(async () => {
    await useApplyEnvironment();
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("two different files with one name take the plain name and the root suffix", async () => {
    const root = makeRoot();
    try {
      const { deps, result } = await importTwoLogos(
        root,
        "assets/inputs/camp/logo.png",
        "assets/inputs/logo.png",
        PNG,
        PNG2,
      );
      expect(result.outcome).toBe("created");
      const entries = await deps.assets.listAssets("camp");
      expect(entries.map((e) => e.name).sort()).toEqual(["logo-root.png", "logo.png"]);
      const stored = await deps.briefs.findBriefById("camp");
      expect(stored).toBeDefined();
    } finally {
      dropRoot(root);
    }
  });

  test("a different own file with a taken name takes the slug suffix", async () => {
    const root = makeRoot();
    try {
      const { deps, result } = await importTwoLogos(
        root,
        "assets/inputs/logo.png",
        "assets/inputs/camp/logo.png",
        PNG,
        PNG2,
      );
      expect(result.outcome).toBe("created");
      const entries = await deps.assets.listAssets("camp");
      expect(entries.map((e) => e.name).sort()).toEqual(["logo-camp.png", "logo.png"]);
    } finally {
      dropRoot(root);
    }
  });

  test("identical bytes under one name reuse one asset row", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected, deps, result } = await importTwoLogos(
        root,
        "assets/inputs/camp/logo.png",
        "assets/inputs/logo.png",
        PNG,
        PNG,
      );
      expect(result.outcome).toBe("created");
      const second = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(second.outcome).toBe("unchanged");
      const entries = await deps.assets.listAssets("camp");
      expect(entries).toHaveLength(1);
    } finally {
      dropRoot(root);
    }
  });

  test("a second importCampaign reports unchanged for a campaign whose refs took a suffixed name", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected, deps, result } = await importTwoLogos(
        root,
        "assets/inputs/camp/logo.png",
        "assets/inputs/logo.png",
        PNG,
        PNG2,
      );
      expect(result.outcome).toBe("created");
      const second = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(second.outcome).toBe("unchanged");
      expect(second.minted.assets.length).toBe(0);
      const entries = await deps.assets.listAssets("camp");
      expect(entries.map((e) => e.name).sort()).toEqual(["logo-root.png", "logo.png"]);
    } finally {
      dropRoot(root);
    }
  });

  test("an other-campaign ref imports that one file and no other", async () => {
    const root = makeRoot();
    try {
      writeAt(root, "assets/inputs/other/logo.png", PNG);
      writeAt(root, "assets/inputs/other/extra.png", PNG2);
      const { deps, result } = await run(root, {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/other/logo.png",
          },
        ],
      });
      expect(result.outcome).toBe("created");
      const entries = await deps.assets.listAssets("camp");
      expect(entries.map((e) => e.name).sort()).toEqual(["logo.png"]);
    } finally {
      dropRoot(root);
    }
  });

  test("a root-level ref becomes an asset of the referencing campaign", async () => {
    const root = makeRoot();
    try {
      const { deps, result } = await run(root, {
        id: "camp",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/logo.png" },
        ],
      });
      expect(result.outcome).toBe("created");
      const entries = await deps.assets.listAssets("camp");
      expect(entries.map((e) => e.name)).toEqual(["logo.png"]);
    } finally {
      dropRoot(root);
    }
  });

  test("an input no ref names is counted and not written", async () => {
    const root = makeRoot();
    try {
      writeAt(root, "assets/inputs/camp/extra.png", PNG2);
      const { deps, result } = await run(root, {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      expect(result.outcome).toBe("created");
      expect(result.unreferencedInputs.names).toEqual(["extra.png"]);
      expect(result.unreferencedInputs.count).toBe(1);
      const entries = await deps.assets.listAssets("camp");
      expect(entries.map((e) => e.name)).toEqual(["logo.png"]);
    } finally {
      dropRoot(root);
    }
  });
});

describe.skipIf(ON_A_REAL_TEST_SERVER)("campaign-step: integrity (N9, N10)", () => {
  let env: Awaited<ReturnType<typeof useApplyEnvironment>>;
  beforeEach(async () => {
    env = await useApplyEnvironment();
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("a file changed after the hashes were taken refuses the campaign before any write", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected, deps } = await importIt(root, {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      writeAt(root, "assets/inputs/camp/logo.png", PNG2);
      const changedTarget = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(changedTarget.outcome).toBe("refused");
      expect(changedTarget.reason).toMatch(/changed since the digest/);
      expect((await campaignCounts(env.db, env.objects)).campaigns).toBe(0);
      expect(env.objects.putCount).toBe(0);

      const fresh = writeBrief(root, "camp.yaml", {
        id: "camp",
        campaignMessage: "tweaked",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const rescanned: ScannedCampaign = {
        ...scanned,
        brief: briefBody({
          id: "camp",
          campaignMessage: "tweaked",
          products: [
            {
              id: "p1",
              name: "P1",
              primaryColor: "#111111",
              logoPath: "assets/inputs/camp/logo.png",
            },
          ],
        }),
        sourcePath: fresh,
      };
      const changedBrief = (await importCampaign(deps, ctx, rescanned, expected)) as CampaignResult;
      expect(changedBrief.outcome).toBe("refused");
      expect(changedBrief.reason).toMatch(/changed since the digest/);
      expect((await campaignCounts(env.db, env.objects)).campaigns).toBe(0);
    } finally {
      dropRoot(root);
    }
  });

  test("a campaign meta file changed after the hashes were taken refuses the campaign before any write", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = await importIt(root, {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      writeAt(
        root,
        join("briefs/camp/campaign.json"),
        JSON.stringify({ name: "Changed", type: "social-post" }),
      );
      const deps = makeDeps();
      const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect(result.reason).toMatch(/changed since the digest/);
      expect((await campaignCounts(env.db, env.objects)).campaigns).toBe(0);
    } finally {
      dropRoot(root);
    }
  });

  test("a campaign meta file removed after the hashes were taken refuses the campaign before any write", async () => {
    const root = makeRoot();
    try {
      writeAt(
        root,
        join("briefs/camp/campaign.json"),
        JSON.stringify({ name: "Camp", type: "social-post" }),
      );
      const { ctx, scanned, expected } = await importIt(root, {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      rmSync(join(ctx.projectRoot, "briefs/camp/campaign.json"));
      const deps = makeDeps();
      const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect(result.reason).toMatch(/changed since the digest/);
      expect((await campaignCounts(env.db, env.objects)).campaigns).toBe(0);
    } finally {
      dropRoot(root);
    }
  });

  test("the import tests query only the wrapped PGlite and reach only the in-memory object store", async () => {
    const root = makeRoot();
    try {
      const { result } = await run(root, {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      expect(result.outcome).toBe("created");
      expect(env.queries.length).toBeGreaterThan(0);
      expect(objectStoreClient()).toBe(env.objects);
      expect(process.env.DATABASE_URL).toBe("postgres://nobody@unused.invalid:5432/none");
    } finally {
      dropRoot(root);
    }
  });
});

describe.skipIf(ON_A_REAL_TEST_SERVER)("campaign-step: edge cases", () => {
  let env: Awaited<ReturnType<typeof useApplyEnvironment>>;
  beforeEach(async () => {
    env = await useApplyEnvironment();
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("a createCampaign failure that is not EEXIST is reported as partial", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const real = getBriefStore(importTenant("local"));
      const briefs: BriefStorePort = new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "createCampaign")
            return () => Promise.reject(new Error("connection terminated"));
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const deps: ImportDeps = { briefs, assets: getAssetStore(importTenant("local")) };
      const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect(result.reason).toBe("connection terminated");
      expect(result.partial).toBe(true);
      expect((await campaignCounts(env.db, env.objects)).campaigns).toBe(0);
      expect(env.objects.putCount).toBe(0);
    } finally {
      dropRoot(root);
    }
  });

  test("a probe that throws refuses the campaign without partial", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      await (getBriefStore(importTenant("local")) as BriefStorePort).createCampaign("camp");
      const briefs: BriefStorePort = new Proxy(getBriefStore(importTenant("local")), {
        get(target, prop, receiver) {
          if (prop === "campaignMeta") return () => Promise.reject(new Error("meta read failed"));
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const deps: ImportDeps = { briefs, assets: getAssetStore(importTenant("local")) };
      const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect(result.reason).toBe("meta read failed");
      expect(result.partial).toBeUndefined();
    } finally {
      dropRoot(root);
    }
  });

  test("an unreadable campaign.json is surfaced by the step", async () => {
    const root = makeRoot();
    try {
      writeAt(root, join("briefs/camp/campaign.json"), "{ not valid json");
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const hashedCtx: HashedContext = { ...ctx, expectedHashes: expected };
      const result = (await importCampaignStep(hashedCtx, {
        slug: scanned.slug,
        sourcePath: scanned.sourcePath,
      })) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect(result.reason).toMatch(/campaign\.json/);
      expect((await campaignCounts(env.db, env.objects)).campaigns).toBe(0);
    } finally {
      dropRoot(root);
    }
  });

  test("a ref whose bytes no stored asset matches refuses as missing", async () => {
    const root = makeRoot();
    try {
      await seedCampaign(root, "camp", PNG2);
      const { ctx, scanned, expected, deps } = await importIt(root, {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect(result.reason).toMatch(/is not in the store/);
    } finally {
      dropRoot(root);
    }
  });

  test("the body imported is the body whose bytes were hashed", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected, deps } = await importIt(root, {
        id: "camp",
        campaignMessage: "from-file",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      // `scanned.brief` carries a DIFFERENT campaignMessage but the SAME refs:
      // the parse from the hashed bytes must win over this one.
      const forged: ScannedCampaign = {
        ...scanned,
        brief: briefBody({
          id: "camp",
          campaignMessage: "from-scanned",
          products: [
            {
              id: "p1",
              name: "P1",
              primaryColor: "#111111",
              logoPath: "assets/inputs/camp/logo.png",
            },
          ],
        }),
      };
      const result = (await importCampaign(deps, ctx, forged, expected)) as CampaignResult;
      expect(result.outcome).toBe("created");
      const stored = await deps.briefs.findBriefById("camp");
      expect(stored).toBeDefined();
      expect(stored!.brief.campaignMessage).toBe("from-file");
    } finally {
      dropRoot(root);
    }
  });

  test("a brief that cannot be parsed refuses the campaign before any write", async () => {
    const root = makeRoot();
    try {
      const ctx = ctxWith(root);
      const sourcePath = writeHtmlLayerBrief(root, "camp.yaml", "camp");
      const expected = new Map<string, string>();
      expected.set(relative(ctx.projectRoot, sourcePath), hashBytes(readFileSync(sourcePath)));
      const scanned: ScannedCampaign = {
        slug: "camp",
        sourcePath,
        name: null,
        type: null,
        brief: briefBody({
          id: "camp",
          products: [
            {
              id: "p1",
              name: "P1",
              primaryColor: "#111111",
              logoPath: "assets/inputs/camp/logo.png",
            },
          ],
        }),
        refs: [],
        sample: false,
      };
      const deps = makeDeps();
      const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect((await campaignCounts(env.db, env.objects)).campaigns).toBe(0);
    } finally {
      dropRoot(root);
    }
  });

  test("a brief whose refs differ from the hashed bytes is refused", async () => {
    const root = makeRoot();
    try {
      const { ctx, scanned, expected, deps } = await importIt(root, {
        id: "camp",
        campaignMessage: "from-file",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const forged: ScannedCampaign = {
        ...scanned,
        brief: briefBody({
          id: "camp",
          campaignMessage: "from-file",
          products: [
            {
              id: "p1",
              name: "P1",
              primaryColor: "#111111",
              logoPath: "assets/inputs/camp/other.png",
            },
          ],
        }),
      };
      const result = (await importCampaign(deps, ctx, forged, expected)) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect(result.reason).toMatch(/changed since the digest/);
    } finally {
      dropRoot(root);
    }
  });

  function noReadAssets(base: AssetStorePort): AssetStorePort {
    return new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "readAsset") return () => Promise.resolve(undefined);
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  test("an asset row whose bytes cannot be read refuses the campaign and names the asset", async () => {
    const root = makeRoot();
    try {
      await seedCampaign(root, "camp", PNG2);
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const deps: ImportDeps = {
        briefs: getBriefStore(importTenant("local")),
        assets: noReadAssets(getAssetStore(importTenant("local"))),
      };
      const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect(result.partial).toBeUndefined();
      expect(result.reason).toMatch(
        /asset logo\.png of camp has a row but its bytes cannot be read/,
      );
    } finally {
      dropRoot(root);
    }
  });

  test("a write-path reuse that cannot read the existing bytes refuses partial and names the asset", async () => {
    const root = makeRoot();
    try {
      const briefs = getBriefStore(importTenant("local"));
      const realAssets = getAssetStore(importTenant("local"));
      await briefs.createCampaign("camp");
      await realAssets.writeAsset("camp", "logo.png", PNG2);
      const { ctx, scanned, expected } = buildScanned(root, "camp", {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const deps: ImportDeps = { briefs, assets: noReadAssets(realAssets) };
      const result = (await importCampaign(deps, ctx, scanned, expected)) as CampaignResult;
      expect(result.outcome).toBe("refused");
      expect(result.partial).toBe(true);
      expect(result.reason).toMatch(
        /asset logo\.png of camp has a row but its bytes cannot be read/,
      );
    } finally {
      dropRoot(root);
    }
  });
});
