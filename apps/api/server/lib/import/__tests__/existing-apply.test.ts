import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dumpBrief } from "@campaignfoundry/shared";
import { main } from "../../../../bin/import.js";
import { collectRefs } from "../../asset-files.js";
import { parseBriefText } from "../../load-brief.js";
import { isAssetId } from "../../ports/asset-store.port.js";
import { getAssetStore, getBriefStore } from "../../ports/index.js";
import { applyCampaigns, openResult, replan, ResultWriter } from "../apply.js";
import type { HashedContext, CampaignResult } from "../campaign-step.js";
import { applyExistingNormalise, replanExisting, type ExistingReplan } from "../existing-apply.js";
import { importTenant } from "../import-tenant.js";
import type { NormaliseResult } from "../normalise-step.js";
import type { PlannedCampaign, StepAddition, StepContext, StepLine } from "../steps.js";
import {
  ON_A_REAL_TEST_SERVER,
  restoreApplyEnvironment,
  useApplyEnvironment,
} from "./fixtures/apply-harness.js";
import {
  NOT_A_PNG,
  PNG,
  briefBody,
  dropRoot,
  makeRoot,
  writeAt,
  writeBrief,
} from "./fixtures/tree.js";

const SWITCHED_AT = "2026-10-01T00:00:00Z";
type Env = Awaited<ReturnType<typeof useApplyEnvironment>>;

const briefs = () => getBriefStore(importTenant("local"));
const assets = () => getAssetStore(importTenant("local"));

/** The minimal product shape the class-(P) fixtures name path refs with. */
function product(logoPath: string, inputAsset?: string) {
  return {
    id: "p1",
    name: "P1",
    primaryColor: "#111111",
    logoPath,
    ...(inputAsset === undefined ? {} : { inputAsset }),
  };
}

/** Path relative to the source tree for a campaign's input asset. */
function campLogo(slug: string, file = "logo.png"): string {
  return `assets/inputs/${slug}/${file}`;
}

/**
 * Seed a campaign whose STORED body round-trips the parser byte-for-byte
 * (PT-8e 3): `createBrief` stores `JSON.stringify` of the parsed brief, which is
 * exactly what `bodyDrift` requires. Passing the raw `briefBody` would store a
 * body the parser would write back differently, making every normalise refuse.
 */
async function seedClassP(
  slug: string,
  overrides: Omit<Parameters<typeof briefBody>[0], "id"> = {},
) {
  const parsed = parseBriefText(`${slug}.yaml`, dumpBrief(briefBody({ id: slug, ...overrides })));
  return briefs().createBrief(parsed);
}

/** Seed a class-(P) campaign after writing its PNG logo to the tree. */
async function seedClassPWithLogo(
  root: string,
  slug: string,
  file = "logo.png",
  bytes: Buffer = PNG,
) {
  const path = campLogo(slug, file);
  writeAt(root, path, bytes);
  return seedClassP(slug, { products: [product(path)] });
}

/** A source tree with an empty `briefs/` and an output dir: no source campaigns, only assets. */
function tree(): { root: string; output: string } {
  const root = makeRoot();
  const output = join(root, "output");
  mkdirSync(output, { recursive: true });
  mkdirSync(join(root, "briefs"), { recursive: true });
  return { root, output };
}

function ctxWith(root: string): StepContext {
  return {
    orgId: "local",
    switchedAt: new Date(SWITCHED_AT),
    projectRoot: root,
    outputRoot: join(root, "output"),
    includeSamples: false,
    fsOnly: false,
  };
}

/** The source digest `apply` would re-plan for this tree (no source briefs). */
async function sourceDigest(root: string): Promise<string> {
  return (await replan(ctxWith(root))).digest;
}

/** Re-plan both source tree and existing class-(P) campaigns against the DB. */
async function replanSourceAndExisting(
  env: Env,
  root: string,
): Promise<{ digest: string; replanned: ExistingReplan }> {
  const digest = await sourceDigest(root);
  const replanned = await replanExisting(env.db, ctxWith(root));
  return { digest, replanned };
}

function freshResult(label: string): string {
  return join(tmpdir(), `cf-existing-apply-${label}-${process.pid}.json`);
}

/** Run `apply` through `main()` against the harness environment. */
async function runApply(
  env: Env,
  root: string,
  output: string,
  extra: readonly string[],
): Promise<{ code: number; err: string[] }> {
  env.reinstall();
  const err: string[] = [];
  const code = await main(
    [
      "apply",
      "--project-root",
      root,
      "--output-root",
      output,
      "--switched-at",
      SWITCHED_AT,
      "--org",
      "local",
      ...extra,
    ],
    { stdout: () => {}, stderr: (line) => err.push(line) },
  );
  return { code, err };
}

/** Run `apply` with an expected plan/digest and result path. */
async function runPlannedApply(
  env: Env,
  root: string,
  output: string,
  plan: { digest: string; existingDigest?: string },
  result: string,
): Promise<{ code: number; err: string[] }> {
  return runApply(env, root, output, [
    "--expect",
    plan.digest,
    ...(plan.existingDigest !== undefined ? ["--expect-existing", plan.existingDigest] : []),
    "--result",
    result,
  ]);
}

/** `plan` against the harness target, returning the source digest and the class-(P) second digest. */
async function runPlan(
  env: Env,
  root: string,
  output: string,
): Promise<{ digest: string; existingDigest: string }> {
  env.reinstall();
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    [
      "plan",
      "--project-root",
      root,
      "--output-root",
      output,
      "--switched-at",
      SWITCHED_AT,
      "--org",
      "local",
    ],
    { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
  );
  expect(code).toBe(0);
  expect(err).toEqual([]);
  const json = JSON.parse(out[3] ?? "{}") as {
    digest: string;
    existingCampaigns: { digest: string } | null;
  };
  expect(json.existingCampaigns).not.toBeNull();
  return { digest: json.digest, existingDigest: json.existingCampaigns!.digest };
}

/** Read non-empty JSON lines from a result file. */
function readResultLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The JSON-lines `--result` file, split into header, existing entries and summary. */
function parseResult(path: string): {
  existing: Record<string, unknown>[];
  summary?: { kind: string; refused: number; partial: boolean };
} {
  const lines = readResultLines(path);
  const existing = lines.filter((line) => line.kind === "existing");
  const summaries = lines.filter((line) => line.kind === "summary");
  return {
    existing,
    summary: summaries[0] as { kind: string; refused: number; partial: boolean } | undefined,
  };
}

async function briefVersionCount(env: Env): Promise<number> {
  const { rows } = await env.db.query<{ n: number }>(
    "select count(*)::int as n from brief_version bv join campaign c on c.id = bv.campaign_id where c.org_id = 'local'",
  );
  return rows[0]!.n;
}

async function assetCount(env: Env): Promise<number> {
  const { rows } = await env.db.query<{ n: number }>(
    "select count(*)::int as n from asset where org_id = 'local'",
  );
  return rows[0]!.n;
}

/** Each campaign's latest version row, by slug. */
async function latestRows(
  env: Env,
): Promise<{ slug: string; version: number; actor: string; body: string }[]> {
  const { rows } = await env.db.query<{
    slug: string;
    version: number;
    actor: string;
    body: string;
  }>(
    `select distinct on (c.slug) c.slug, bv.version, bv.actor, bv.body
       from campaign c
       join brief_version bv on bv.campaign_id = c.id
      where c.org_id = 'local'
      order by c.slug, bv.version desc`,
  );
  return rows;
}

describe.skipIf(ON_A_REAL_TEST_SERVER)("existing class-(P) apply normalisation", () => {
  let env: Env;
  let root: string | undefined;

  beforeEach(async () => {
    env = await useApplyEnvironment();
  });
  afterEach(async () => {
    dropRoot(root);
    root = undefined;
    await restoreApplyEnvironment();
  });

  test("apply fails closed before opening --result when class-(P) campaigns exist and --expect-existing is omitted", async () => {
    const t = tree();
    root = t.root;
    await seedClassPWithLogo(t.root, "p-camp");
    const result = freshResult("1");
    try {
      const digest = await sourceDigest(t.root);
      const { code, err } = await runPlannedApply(env, t.root, t.output, { digest }, result);
      expect(code).toBe(1);
      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(
        /apply needs --expect-existing <digest> when class-\(P\) campaigns would be normalised/,
      );
      expect(existsSync(result)).toBe(false);
      expect(await briefVersionCount(env)).toBe(1);
      expect(await assetCount(env)).toBe(0);
      expect(env.objects.putCount).toBe(0);
    } finally {
      rmSync(result, { force: true });
    }
  });

  test("apply fails closed before opening --result when --expect-existing mismatches the recomputed existing digest", async () => {
    // With zero class-(P) campaigns, a non-empty wrong --expect-existing is still refused.
    {
      const t = tree();
      root = t.root;
      const result = freshResult("2b");
      try {
        const digest = await sourceDigest(t.root);
        const { code, err } = await runApply(env, t.root, t.output, [
          "--expect",
          digest,
          "--expect-existing",
          "0".repeat(64),
          "--result",
          result,
        ]);
        expect(code).toBe(1);
        expect(err).toHaveLength(1);
        expect(err[0]).toContain("does not match the existing-campaigns digest");
        expect(existsSync(result)).toBe(false);
        expect(await briefVersionCount(env)).toBe(0);
        expect(env.objects.putCount).toBe(0);
      } finally {
        rmSync(result, { force: true });
        dropRoot(t.root);
      }
    }
    // With a class-(P) campaign present, a wrong --expect-existing is refused.
    {
      const t = tree();
      root = t.root;
      env.reinstall();
      const stored = await seedClassPWithLogo(t.root, "old");
      const result = freshResult("2a");
      try {
        const { digest, replanned } = await replanSourceAndExisting(env, t.root);
        const { code, err } = await runApply(env, t.root, t.output, [
          "--expect",
          digest,
          "--expect-existing",
          "0".repeat(64),
          "--result",
          result,
        ]);
        expect(code).toBe(1);
        expect(err).toHaveLength(1);
        expect(err[0]).toContain("does not match the existing-campaigns digest");
        expect(err[0]).toContain(replanned.digest);
        expect(existsSync(result)).toBe(false);
        expect(await briefVersionCount(env)).toBe(1);
        expect(await assetCount(env)).toBe(0);
        expect(env.objects.putCount).toBe(0);
        expect(stored.revision).toBeDefined();
      } finally {
        rmSync(result, { force: true });
        dropRoot(t.root);
      }
    }
  });

  test("applyCampaigns records objects a later step mints and counts them", async () => {
    const t = tree();
    root = t.root;
    const hashedCtx = { ...ctxWith(t.root), expectedHashes: new Map() } as HashedContext;
    const object = { key: "k/1", path: "p/1" };
    const first = async (): Promise<CampaignResult> => ({
      outcome: "created",
      minted: {
        campaignId: "c-1",
        assets: [{ id: "a-1", name: "logo.png", key: "k/a" }],
      },
      unreferencedInputs: { count: 0, names: [] },
    });
    const one = async (
      _ctx: StepContext,
      _campaign: PlannedCampaign,
      line: StepLine,
    ): Promise<StepAddition> => {
      await line.recordMinted(object);
      return { rows: [], minted: { objects: [object] } };
    };
    const minted: unknown[] = [];
    const counts = await applyCampaigns(
      hashedCtx,
      [{ slug: "camp", sourcePath: "x" }],
      [first, one],
      async () => {},
      async (slug, mintedObject) => {
        minted.push([slug, mintedObject]);
      },
    );
    expect(minted).toEqual([["camp", object]]);
    expect(counts.objectsMinted).toBe(1);
  });

  test("ResultWriter.object appends an object line", async () => {
    const result = freshResult("obj");
    try {
      const handle = await openResult(result);
      const writer = new ResultWriter(handle, SWITCHED_AT, "local", "d");
      await writer.header();
      await writer.object({ key: "k/1", path: "p/1" });
      await writer.summary({
        created: 0,
        completed: 0,
        unchanged: 0,
        refused: 0,
        partial: false,
        rowsWritten: 0,
        objectsMinted: 1,
      });
      await handle.close();
      const lines = readResultLines(result);
      expect(lines[1]).toMatchObject({ kind: "object", key: "k/1", path: "p/1" });
      expect(lines[2]).toMatchObject({ kind: "summary", objectsMinted: 1 });
    } finally {
      rmSync(result, { force: true });
    }
  });

  test("replanExisting skips campaigns whose latest version already uses asset ids", async () => {
    const t = tree();
    root = t.root;
    await seedClassPWithLogo(t.root, "path");
    // An already-normalised campaign: its refs are asset ids, so it is not class (P).
    await briefs().createCampaign("idonly");
    const asset = await assets().writeAsset("idonly", "logo.png", PNG);
    await briefs().createBrief(
      briefBody({ id: "idonly", products: [product(asset.id as string)] }),
    );
    const replanned = await replanExisting(env.db, ctxWith(t.root));
    expect(replanned.normaliseCount).toBe(1);
    expect(replanned.items).toHaveLength(1);
    expect(replanned.items[0]).toMatchObject({
      campaign: { slug: "path", state: "normalise" },
    });
  });

  test("plan refuses --expect-existing as a flag it does not take", async () => {
    const err: string[] = [];
    const code = await main(["plan", "--switched-at", SWITCHED_AT, "--expect-existing", "abc"], {
      stdout: () => {},
      stderr: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(err).toEqual(["--expect-existing is not a flag this command takes."]);
  });

  test("batch class-(P) normalisation rewrites path refs to asset ids as import:pt-8, imports unreferenced own inputs, leaves existing report row untouched, and a second apply writes no new version", async () => {
    const t = tree();
    root = t.root;
    writeAt(t.root, campLogo("old", "extra.png"), PNG);
    writeAt(t.root, campLogo("old", "bad.png"), NOT_A_PNG);
    const oldBrief = await seedClassPWithLogo(t.root, "old");
    const twoBrief = await seedClassPWithLogo(t.root, "two");
    await env.db.query(
      "insert into report (org_id, campaign_id, body, revision) values ('local', $1, $2, $3)",
      [oldBrief.campaignId, JSON.stringify({ legacy: "row" }), "r-legacy"],
    );
    const reportBefore = await env.db.query<{ body: string; revision: string }>(
      "select body, revision from report where org_id = 'local' and campaign_id = $1",
      [oldBrief.campaignId],
    );
    const r1 = freshResult("4a");
    const r2 = freshResult("4b");
    try {
      const plan = await runPlan(env, t.root, t.output);
      const { code: first, err } = await runPlannedApply(env, t.root, t.output, plan, r1);
      expect(first).toBe(0);
      expect(err).toEqual([]);
      env.reinstall();

      // Both campaigns' latest version is 2, written by the import actor.
      const latest = await latestRows(env);
      expect(latest.map((row) => [row.slug, row.version, row.actor])).toEqual([
        ["old", 2, "import:pt-8"],
        ["two", 2, "import:pt-8"],
      ]);
      expect(latest.some((row) => row.slug === "old")).toBe(true);

      // Every ref in the latest brief is an asset id that reads back the reviewed bytes.
      for (const row of latest) {
        const stored = await briefs().findBriefById(row.slug);
        expect(stored).toBeDefined();
        const refs = collectRefs(stored!.brief);
        expect(refs.length).toBeGreaterThan(0);
        for (const ref of refs) {
          expect(isAssetId(ref)).toBe(true);
          expect((await assets().readAssetById(ref))?.equals(PNG)).toBe(true);
        }
      }

      // The unreferenced valid own input was imported; the bad-extension one is listed.
      const parsed1 = parseResult(r1);
      const oldEntry = parsed1.existing.find((entry) => entry.slug === "old")!;
      const twoEntry = parsed1.existing.find((entry) => entry.slug === "two")!;
      expect(oldEntry.status).toBe("normalised");
      expect(twoEntry.status).toBe("normalised");
      expect(
        (oldEntry.minted as { assets: { name: string; id: string; key: string }[] }).assets.map(
          (asset) => asset.name,
        ),
      ).toEqual(["logo.png", "extra.png"]);
      expect(
        (oldEntry.minted as { assets: { name: string; id: string; key: string }[] }).assets.every(
          (asset) => asset.id && asset.key,
        ),
      ).toBe(true);
      expect(oldEntry.notImported).toEqual([
        { name: "bad.png", reason: '"bad.png" is not a PNG or JPEG file.' },
      ]);

      // The stored report row is untouched.
      const reportAfter = await env.db.query<{ body: string; revision: string }>(
        "select body, revision from report where org_id = 'local' and campaign_id = $1",
        [oldBrief.campaignId],
      );
      expect(reportAfter.rows).toEqual(reportBefore.rows);

      // A second apply over the same source writes no new version.
      const putsBeforeSecond = env.objects.putCount;
      const { code: second, err: secondErr } = await runPlannedApply(
        env,
        t.root,
        t.output,
        { digest: plan.digest },
        r2,
      );
      expect(second).toBe(0);
      expect(secondErr).toEqual([]);
      expect(await briefVersionCount(env)).toBe(4);
      expect(await latestRows(env)).toEqual(latest);
      expect(env.objects.putCount).toBe(putsBeforeSecond);
      expect(twoBrief.revision).toBeDefined();
    } finally {
      rmSync(r1, { force: true });
      rmSync(r2, { force: true });
    }
  });

  test("one clean class-(P) campaign reusing its assets alongside a refused one: mixed normalised + refused exits 1", async () => {
    const t = tree();
    root = t.root;
    await seedClassPWithLogo(t.root, "clean");
    await seedClassP("blocked", {
      products: [product(campLogo("blocked"))],
    });
    // Pre-store the clean campaign's asset so the normalise reuses it: assetsMinted 0.
    await assets().writeAsset("clean", "logo.png", PNG);
    const result = freshResult("5b");
    try {
      const { digest, replanned } = await replanSourceAndExisting(env, t.root);
      expect(replanned.normaliseCount).toBe(1);
      const { code, err } = await runPlannedApply(
        env,
        t.root,
        t.output,
        { digest, existingDigest: replanned.digest },
        result,
      );
      expect(code).toBe(1);
      expect(err).toEqual([]);
      const parsed = parseResult(result);
      expect(parsed.existing.map((entry) => [entry.slug, entry.status])).toEqual([
        ["blocked", "refused"],
        ["clean", "normalised"],
      ]);
      const clean = parsed.existing.find((entry) => entry.slug === "clean")!;
      expect((clean.minted as { assets: unknown[] }).assets).toEqual([]);
      const latest = await latestRows(env);
      expect(latest.find((row) => row.slug === "clean")?.version).toBe(2);
      expect(latest.find((row) => row.slug === "blocked")?.version).toBe(1);
    } finally {
      rmSync(result, { force: true });
    }
  });

  test("a draft-bearing class-(P) campaign is refused without writing and exits 3", async () => {
    const t = tree();
    root = t.root;
    const drafted = await seedClassPWithLogo(t.root, "drafted");
    await env.db.query(
      "insert into draft (campaign_id, user_id, org_id, state, base_revision) " +
        "select id, 'user-1', 'local', '{}'::jsonb, $1::text from campaign " +
        "where org_id = 'local' and slug = 'drafted'",
      [drafted.revision],
    );
    const result = freshResult("5a");
    try {
      const { digest, replanned } = await replanSourceAndExisting(env, t.root);
      const { code, err } = await runPlannedApply(
        env,
        t.root,
        t.output,
        { digest, existingDigest: replanned.digest },
        result,
      );
      expect(code).toBe(3);
      expect(err).toEqual([]);
      expect(await briefVersionCount(env)).toBe(1);
      expect(await assetCount(env)).toBe(0);
      expect(env.objects.putCount).toBe(0);
      const parsed = parseResult(result);
      expect(parsed.existing).toHaveLength(1);
      expect(parsed.existing[0]).toMatchObject({
        slug: "drafted",
        status: "refused",
        refusal: "draft",
        minted: { assets: [] },
      });
      expect(parsed.summary?.refused).toBe(1);
      expect(parsed.summary?.partial).toBe(false);
    } finally {
      rmSync(result, { force: true });
    }
  });

  test("mid-write 409 conflict on rewriteBrief records conflict, keeps minted assets on the result line, and marks the run partial (exit 1)", async () => {
    const t = tree();
    root = t.root;
    await seedClassPWithLogo(t.root, "conflict");
    const ctx = ctxWith(t.root);
    const replanned = await replanExisting(env.db, ctx);
    const realBriefs = briefs();
    const conflictError = new Error("conflict") as Error & { code: string };
    conflictError.code = "ECONFLICT";
    const rewriteBrief = vi.fn(async () => {
      throw conflictError;
    });
    const stores = {
      briefs: {
        getRevision: async (slug: string) => realBriefs.getRevision(slug),
        rewriteBrief,
      },
      assets: assets(),
      draftCount: async () => 0,
    };
    let entry: NormaliseResult | undefined;
    const counts = await applyExistingNormalise(
      env.db,
      ctx,
      replanned,
      async (got) => {
        entry = got;
      },
      stores,
    );
    expect(rewriteBrief).toHaveBeenCalledTimes(1);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("conflict");
    expect(entry!.reason).toBe("conflict");
    expect(entry!.minted.assets).toHaveLength(1);
    expect(entry!.minted.assets[0]!.id).toBeDefined();
    expect(entry!.minted.assets[0]!.key).toBeDefined();
    expect((await assets().readAssetById(entry!.minted.assets[0]!.id))?.equals(PNG)).toBe(true);
    expect(counts).toMatchObject({
      normalised: 0,
      refused: 0,
      assetsMinted: 1,
      partial: true,
    });
    expect(counts.normalisedSlugs.has("conflict")).toBe(false);
  });

  test("an existing non-class-P campaign and no --expect-existing gives a refused line in the result file and exit 3", async () => {
    const t = tree();
    root = t.root;
    const logo = campLogo("camp");
    writeAt(t.root, logo, PNG);
    writeBrief(t.root, "camp.yaml", {
      id: "camp",
      products: [product(logo)],
    });
    // Pre-existing campaign in the DB whose body differs from the import tree:
    // not class (P) because it is a source campaign taking the import path.
    env.reinstall();
    await briefs().createCampaign("camp");
    await briefs().createBrief(
      briefBody({
        id: "camp",
        products: [
          {
            id: "p1",
            name: "SOMEONE ELSE",
            primaryColor: "#222222",
            logoPath: logo,
          },
        ],
      }),
    );
    const result = freshResult("non-class-p");
    try {
      const digest = await sourceDigest(t.root);
      const { code, err } = await runPlannedApply(env, t.root, t.output, { digest }, result);
      expect(code).toBe(3);
      expect(err).toEqual([]);
      const lines = readResultLines(result);
      const campaignLine = lines.find((line) => line.kind === "campaign");
      expect(campaignLine).toMatchObject({
        slug: "camp",
        outcome: "refused",
      });
      expect(campaignLine?.["rows"]).toBeUndefined();
      const summaryLine = lines.find((line) => line.kind === "summary");
      expect(summaryLine).toMatchObject({
        refused: 1,
        created: 0,
        completed: 0,
        unchanged: 0,
        partial: false,
      });
      expect(await briefVersionCount(env)).toBe(1);
      expect(await assetCount(env)).toBe(0);
      expect(env.objects.putCount).toBe(0);
    } finally {
      rmSync(result, { force: true });
    }
  });

  test("plan and apply hash the same set when a class-(P) campaign is in both the source tree and DB", async () => {
    const t = tree();
    root = t.root;
    const sharedLogo = campLogo("shared");
    writeAt(t.root, sharedLogo, PNG);
    writeBrief(t.root, "shared.yaml", {
      id: "shared",
      products: [product(sharedLogo)],
    });
    await seedClassP("shared", {
      products: [product(sharedLogo)],
    });
    await seedClassPWithLogo(t.root, "outside");
    const result = freshResult("hash-same-set");
    try {
      const plan = await runPlan(env, t.root, t.output);
      const { code, err } = await runPlannedApply(env, t.root, t.output, plan, result);
      expect(code).toBe(1);
      expect(err).toEqual([]);
      const parsed = parseResult(result);
      expect(parsed.existing.find((entry) => entry.slug === "outside")?.status).toBe("normalised");
      expect(parsed.existing.find((entry) => entry.slug === "shared")).toBeUndefined();
      const latest = await latestRows(env);
      expect(latest.find((row) => row.slug === "outside")?.version).toBe(2);
      expect(latest.find((row) => row.slug === "outside")?.actor).toBe("import:pt-8");
      expect(latest.find((row) => row.slug === "shared")?.version).toBe(1);
    } finally {
      rmSync(result, { force: true });
    }
  });

  test("a scan refusal with a truthy slug matching a stored class-(P) campaign is not normalised", async () => {
    const t = tree();
    root = t.root;
    await seedClassPWithLogo(t.root, "refused");
    writeBrief(t.root, "refused.yaml", {
      id: "refused",
      products: [product(campLogo("refused", "missing.png"))],
    });
    const result = freshResult("refused-slug");
    try {
      const plan = await runPlan(env, t.root, t.output);
      const { code, err } = await runPlannedApply(env, t.root, t.output, plan, result);
      expect(code).toBe(3);
      expect(err).toEqual([]);
      const parsed = parseResult(result);
      expect(
        parsed.existing.find((entry) => entry.slug === "refused" && entry.status === "normalised"),
      ).toBeUndefined();
      const latest = await latestRows(env);
      expect(latest.find((row) => row.slug === "refused")?.version).toBe(1);
    } finally {
      rmSync(result, { force: true });
    }
  });
});
