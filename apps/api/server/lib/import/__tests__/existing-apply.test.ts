import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dumpBrief } from "@campaignfoundry/shared";
import { renderObjectKey } from "@campaignfoundry/Distribution";
import { renderPrefix } from "../../object-store/object-keys.js";
import { main } from "../../../../bin/import.js";
import { collectRefs } from "../../asset-files.js";
import { parseBriefText } from "../../load-brief.js";
import { isAssetId } from "../../ports/asset-store.port.js";
import { getAssetStore, getBriefStore } from "../../ports/index.js";
import { applyCampaigns, openResult, replan, ResultWriter } from "../apply.js";
import type { HashedContext, CampaignResult } from "../campaign-step.js";
import {
  applyExistingNormalise,
  applyExistingRenders,
  replanExisting,
  type ExistingRenderEntry,
  type ExistingRendersCounts,
  type ExistingReplan,
  type OutOfScopeRender,
} from "../existing-apply.js";
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
  linkAt,
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

/** The stored report body naming `paths` as render output paths (D223). */
function renderBody(paths: readonly string[]): string {
  return JSON.stringify({ assets: paths.map((path) => ({ outputPath: path })) });
}

/** A campaign's uuid in the target org, as the object key is built from it. */
async function campaignIdFor(env: Env, slug: string): Promise<string> {
  const { rows } = await env.db.query<{ id: string }>(
    "select id from campaign where org_id = 'local' and slug = $1",
    [slug],
  );
  return rows[0]!.id;
}

/** A live campaign whose latest body names no path ref (empty products). */
async function seedLiveZeroRefCampaign(
  env: Env,
  slug: string,
  options?: { readonly withAsset?: boolean },
): Promise<void> {
  await briefs().createCampaign(slug);
  await briefs().createBrief(briefBody({ id: slug, products: [] }));
  if (options?.withAsset === true) {
    const id = await campaignIdFor(env, slug);
    await env.db.query(
      "insert into asset (org_id, campaign_id, kind, name, size, sha256, content_type) " +
        "values ('local', $1, 'input', 'logo.png', $2, $3, 'image/png')",
      [id, PNG.length, "deadbeef"],
    );
  }
}

/** Pin a campaign's `created_at` column to the given instant. */
async function setCreatedAt(env: Env, slug: string, iso: string): Promise<void> {
  await env.db.query("update campaign set created_at = $1 where org_id = 'local' and slug = $2", [
    iso,
    slug,
  ]);
}

/** Insert a stored `report` row naming `paths` as its render output paths. */
async function seedReport(env: Env, slug: string, paths: readonly string[]): Promise<void> {
  await env.db.query(
    "insert into report (org_id, campaign_id, body, revision) values ('local', $1, $2, $3)",
    [slug, renderBody(paths), "r-render"],
  );
}

/** A live zero-ref campaign pinned to `createdAt` (defaulting to before SWITCHED_AT), optionally with a report. */
async function seedDatedCampaign(
  env: Env,
  slug: string,
  createdAt = "2026-09-30T23:59:00Z",
  reportPaths?: readonly string[],
): Promise<void> {
  await seedLiveZeroRefCampaign(env, slug);
  await setCreatedAt(env, slug, createdAt);
  if (reportPaths !== undefined) {
    await seedReport(env, slug, reportPaths);
  }
}

/**
 * Run `applyExistingRenders` with collector callbacks, returning counts, entries, and out-of-scope items.
 */
async function collectExistingRenders(
  env: Env,
  t: { root: string },
  normalised: Iterable<string> = [],
  noUploadOrOptions?: Iterable<string> | Parameters<typeof applyExistingRenders>[6],
  options?: Parameters<typeof applyExistingRenders>[6],
): Promise<{
  counts: ExistingRendersCounts;
  entries: ExistingRenderEntry[];
  outOfScope: OutOfScopeRender[];
}> {
  const isIterable =
    noUploadOrOptions !== undefined &&
    typeof (noUploadOrOptions as Iterable<unknown>)[Symbol.iterator] === "function";
  const imported = isIterable ? (noUploadOrOptions as Iterable<string>) : [];
  const opts = isIterable
    ? options
    : (noUploadOrOptions as Parameters<typeof applyExistingRenders>[6]);
  const entries: ExistingRenderEntry[] = [];
  const outOfScope: OutOfScopeRender[] = [];
  const counts = await applyExistingRenders(
    env.db,
    env.objects,
    ctxWith(t.root),
    new Set(imported),
    new Set(normalised),
    {
      onMinted: async () => {},
      onEntry: async (entry) => {
        entries.push(entry);
      },
      onOutOfScope: async (item) => {
        outOfScope.push(item);
      },
    },
    opts,
  );
  return { counts, entries, outOfScope };
}

/** Run `apply` expecting failure with partial existing-renders and summary entries. */
async function expectPartialPlannedApply(
  env: Env,
  t: { root: string; output: string },
  slug: string,
  label: string,
): Promise<{
  entry: Record<string, unknown>;
  summary: Record<string, unknown>;
  lines: Record<string, unknown>[];
}> {
  const result = freshResult(label);
  try {
    const plan = await runPlan(env, t.root, t.output);
    const { code, err } = await runPlannedApply(env, t.root, t.output, plan, result);
    expect(code).toBe(1);
    expect(err).toEqual([]);
    const lines = readResultLines(result);
    const entry = lines.find(
      (line) => line.kind === "existing-renders" && line.slug === slug,
    ) as Record<string, unknown>;
    expect(entry.partial).toBe(true);
    const summary = lines.find((line) => line.kind === "summary") as Record<string, unknown>;
    expect(summary.partial).toBe(true);
    const latest = await latestRows(env);
    expect(latest.find((row) => row.slug === slug)?.version).toBe(2);
    return { entry, summary, lines };
  } finally {
    rmSync(result, { force: true });
  }
}

/** Assert that a single proof render for `slug` is classified out-of-scope. */
async function expectSingleOutOfScopeProof(
  env: Env,
  t: { root: string; output: string },
  slug: string,
): Promise<void> {
  const path = `${slug}/proof.png`;
  writeAt(t.output, path, PNG);
  await seedReport(env, slug, [path]);
  const { counts, entries, outOfScope } = await collectExistingRenders(env, t);
  expect(counts.outOfScope).toBe(1);
  expect(entries).toHaveLength(0);
  expect(outOfScope).toHaveLength(1);
  expect(outOfScope[0]).toMatchObject({
    slug,
    path,
  });
}

/** Assert that a single render for `slug` is refused with `reasonSubstring`. */
async function expectSingleRefusedRender(
  env: Env,
  t: { root: string },
  slug: string,
  reasonSubstring: string,
): Promise<void> {
  const { counts, entries } = await collectExistingRenders(env, t, [slug]);
  expect(counts.partial).toBe(true);
  expect(entries).toHaveLength(1);
  expect(entries[0]!.slug).toBe(slug);
  expect(entries[0]!.renders).toHaveLength(1);
  const render = entries[0]!.renders[0]!;
  expect(render.status).toBe("refused");
  if (render.status === "refused") {
    expect(render.reason).toContain(reasonSubstring);
  }
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

  test("set (b) imports renders named by a normalised campaign's stored report and resumes idempotently on a second apply, while excluding a campaign later edited by a user", async () => {
    const t = tree();
    root = t.root;
    const slug = "pre";
    await seedClassPWithLogo(t.root, slug);
    writeAt(t.output, `${slug}/proof.png`, PNG);
    const meta = await briefs().campaignMeta(slug);
    expect(meta).toBeDefined();
    const campaignId = meta!.campaignId;
    const key = renderObjectKey(renderPrefix("local", campaignId), slug, `${slug}/proof.png`);
    await seedReport(env, slug, [`${slug}/proof.png`]);
    const r1 = freshResult("b-first");
    const r2 = freshResult("b-second");
    const r3 = freshResult("b-user");
    try {
      const plan = await runPlan(env, t.root, t.output);
      const { code, err } = await runPlannedApply(env, t.root, t.output, plan, r1);
      expect(code).toBe(0);
      expect(err).toEqual([]);
      const obj = await env.objects.get(key);
      expect(obj).toBeDefined();
      expect(Buffer.from(obj!.bytes).equals(PNG)).toBe(true);
      const lines = readResultLines(r1);
      const objIndex = lines.findIndex((line) => line.kind === "object" && line.key === key);
      const erIndex = lines.findIndex(
        (line) => line.kind === "existing-renders" && line.slug === slug,
      );
      expect(objIndex).toBeGreaterThan(-1);
      expect(erIndex).toBeGreaterThan(-1);
      expect(objIndex).toBeLessThan(erIndex);
      const entry = lines[erIndex] as Record<string, unknown>;
      expect(entry.scope).toBe("normalised");
      expect((entry.renders as Record<string, unknown>[])[0]!.status).toBe("written");

      env.reinstall();
      const digest2 = await sourceDigest(t.root);
      const { code: code2, err: err2 } = await runPlannedApply(
        env,
        t.root,
        t.output,
        { digest: digest2 },
        r2,
      );
      expect(code2).toBe(0);
      expect(err2).toEqual([]);
      const entry2 = readResultLines(r2).find(
        (line) => line.kind === "existing-renders" && line.slug === slug,
      ) as Record<string, unknown>;
      expect(entry2.scope).toBe("normalised");
      expect((entry2.renders as Record<string, unknown>[])[0]!.status).toBe("skipped");
      const obj2 = await env.objects.get(key);
      expect(Buffer.from(obj2!.bytes).equals(PNG)).toBe(true);

      // A post-normalisation USER edit: version 3 authored by a user (not the
      // import actor), so the campaign leaves set (b); it also holds an asset row
      // (the logo the normalise minted), so it leaves set (c) too.
      // `apply`'s closeClosed reset the process database; reinstall it before the
      // user-tenant store builds against it.
      env.reinstall();
      const userBriefs = getBriefStore({
        orgId: "local",
        userId: "user-1",
        roles: ["owner"],
        teamIds: [],
      });
      const stored = await briefs().findBriefById(slug);
      expect(stored).toBeDefined();
      const refs = collectRefs(stored!.brief);
      expect(refs.length).toBeGreaterThan(0);
      const edited = {
        ...stored!.brief,
        products: [
          ...stored!.brief.products,
          { id: "p2", name: "P2", primaryColor: "#333333", logoPath: refs[0] },
        ],
      };
      await userBriefs.rewriteBrief(edited, { expectedRevision: stored!.revision });
      await env.db.query(
        "update report set body = $1 where org_id = 'local' and campaign_id = $2",
        [renderBody([`${slug}/proof.png`, `${slug}/v3.png`]), slug],
      );
      writeAt(t.output, `${slug}/v3.png`, PNG);

      env.reinstall();
      const digest3 = await sourceDigest(t.root);
      const { code: code3, err: err3 } = await runPlannedApply(
        env,
        t.root,
        t.output,
        { digest: digest3 },
        r3,
      );
      expect(code3).toBe(0);
      expect(err3).toEqual([]);
      const v3key = renderObjectKey(renderPrefix("local", campaignId), slug, `${slug}/v3.png`);
      expect(await env.objects.get(v3key)).toBeUndefined();
      expect(Buffer.from((await env.objects.get(key))!.bytes).equals(PNG)).toBe(true);
    } finally {
      rmSync(r1, { force: true });
      rmSync(r2, { force: true });
      rmSync(r3, { force: true });
    }
  });

  test("set (c) imports renders for a live no-upload campaign created before --switched-at, and refuses scope to a campaign created at/after --switched-at or holding an asset row", async () => {
    const t = tree();
    root = t.root;
    const before = "2026-09-30T23:59:00Z";
    await seedLiveZeroRefCampaign(env, "pre-no-upload");
    await seedLiveZeroRefCampaign(env, "at-switch");
    await seedLiveZeroRefCampaign(env, "pre-with-asset", { withAsset: true });
    await setCreatedAt(env, "pre-no-upload", before);
    await setCreatedAt(env, "at-switch", SWITCHED_AT);
    await setCreatedAt(env, "pre-with-asset", before);
    for (const slug of ["pre-no-upload", "at-switch", "pre-with-asset"]) {
      writeAt(t.output, `${slug}/proof.png`, PNG);
      await seedReport(env, slug, [`${slug}/proof.png`]);
    }
    const result = freshResult("c-boundaries");
    try {
      const digest = await sourceDigest(t.root);
      const { code, err } = await runPlannedApply(env, t.root, t.output, { digest }, result);
      expect(code).toBe(0);
      expect(err).toEqual([]);
      const lines = readResultLines(result);

      const preKey = renderObjectKey(
        renderPrefix("local", await campaignIdFor(env, "pre-no-upload")),
        "pre-no-upload",
        "pre-no-upload/proof.png",
      );
      expect(await env.objects.get(preKey)).toBeDefined();
      const preEntry = lines.find(
        (line) => line.kind === "existing-renders" && line.slug === "pre-no-upload",
      ) as Record<string, unknown>;
      expect(preEntry.scope).toBe("no-upload");
      expect((preEntry.renders as Record<string, unknown>[])[0]!.status).toBe("written");

      for (const slug of ["at-switch", "pre-with-asset"]) {
        const listed = lines.filter(
          (line) => line.kind === "out-of-scope-render" && line.slug === slug,
        );
        expect(listed).toHaveLength(1);
        expect((listed[0]! as Record<string, unknown>).path).toBe(`${slug}/proof.png`);
        const key = renderObjectKey(
          renderPrefix("local", await campaignIdFor(env, slug)),
          slug,
          `${slug}/proof.png`,
        );
        expect(await env.objects.get(key)).toBeUndefined();
      }
    } finally {
      rmSync(result, { force: true });
    }
  });

  test("out-of-scope report paths: only a path with a source file on disk AND a head-confirmed missing S3 object is listed; an already-stored S3 render, an absent disk file, or an unresolvable campaign/key is neither listed nor touched", async () => {
    const t = tree();
    root = t.root;
    const late = "late";
    await seedLiveZeroRefCampaign(env, late);
    await setCreatedAt(env, late, "2026-10-02T00:00:00Z");
    const lateId = await campaignIdFor(env, late);
    const paths = [
      `${late}/on-disk-missing-s3.png`,
      `${late}/on-disk-already-in-s3.png`,
      `${late}/absent-on-disk.png`,
      `${late}/mystery.xyz`,
      "other/proof.png",
    ];
    writeAt(t.output, `${late}/on-disk-missing-s3.png`, PNG);
    writeAt(t.output, `${late}/on-disk-already-in-s3.png`, PNG);
    writeAt(t.output, `${late}/mystery.xyz`, PNG);
    writeAt(t.output, "other/proof.png", PNG);
    await seedReport(env, late, paths);
    const alreadyKey = renderObjectKey(
      renderPrefix("local", lateId),
      late,
      `${late}/on-disk-already-in-s3.png`,
    );
    const original = Buffer.from("already-in-s3-bytes\n");
    await env.objects.put(alreadyKey, original);

    // A tombstoned campaign: its uuid resolves through the any-state lookup, so
    // its missing render is listed, never claimed to be missing.
    await seedLiveZeroRefCampaign(env, "tomb");
    writeAt(t.output, "tomb/proof.png", PNG);
    await seedReport(env, "tomb", ["tomb/proof.png"]);
    await env.db.query(
      "update campaign set deleted_at = now() where org_id = 'local' and slug = 'tomb'",
    );

    // A report whose campaign row does not exist at all: no uuid resolves, so
    // nothing is claimed missing and nothing is emitted.
    writeAt(t.output, "ghost/proof.png", PNG);
    await seedReport(env, "ghost", ["ghost/proof.png"]);

    const result = freshResult("oos-listing");
    try {
      const putsBefore = env.objects.putCount;
      const digest = await sourceDigest(t.root);
      const { code, err } = await runPlannedApply(env, t.root, t.output, { digest }, result);
      expect(code).toBe(0);
      expect(err).toEqual([]);
      const lines = readResultLines(result);
      const listed = lines.filter((line) => line.kind === "out-of-scope-render");
      expect(
        listed.map((line) => [
          (line as Record<string, unknown>).slug,
          (line as Record<string, unknown>).path,
        ]),
      ).toEqual([
        [late, `${late}/on-disk-missing-s3.png`],
        [late, `${late}/mystery.xyz`],
        ["tomb", "tomb/proof.png"],
      ]);
      const stored = await env.objects.get(alreadyKey);
      expect(stored).toBeDefined();
      expect(Buffer.from(stored!.bytes).equals(original)).toBe(true);
      expect(env.objects.putCount).toBe(putsBefore);
    } finally {
      rmSync(result, { force: true });
    }
  });

  test("set (a) campaigns imported by applyCampaigns are skipped by applyExistingRenders so their renders are not imported twice", async () => {
    const t = tree();
    root = t.root;
    const slug = "camp";
    writeAt(t.root, campLogo(slug), PNG);
    writeBrief(t.root, `${slug}.yaml`, { id: slug, products: [product(campLogo(slug))] });
    writeAt(t.output, `reports/${slug}.json`, Buffer.from(renderBody([`${slug}/rend.png`])));
    writeAt(t.output, `${slug}/rend.png`, PNG);
    const result = freshResult("a-skip");
    try {
      const digest = await sourceDigest(t.root);
      const { code, err } = await runPlannedApply(env, t.root, t.output, { digest }, result);
      expect(code).toBe(0);
      expect(err).toEqual([]);
      const lines = readResultLines(result);
      expect(
        lines.filter((line) => line.kind === "existing-renders" && line.slug === slug),
      ).toHaveLength(0);
      expect(
        lines.filter((line) => line.kind === "out-of-scope-render" && line.slug === slug),
      ).toHaveLength(0);
      const campaignId = await campaignIdFor(env, slug);
      const key = renderObjectKey(renderPrefix("local", campaignId), slug, `${slug}/rend.png`);
      expect(await env.objects.get(key)).toBeDefined();
      const campaignLine = lines.find(
        (line) => line.kind === "campaign" && line.slug === slug,
      ) as Record<string, unknown>;
      const renders = (campaignLine.renders as Record<string, unknown>[]) ?? [];
      expect(renders.filter((render) => render.path === `${slug}/rend.png`)).toHaveLength(1);
    } finally {
      rmSync(result, { force: true });
    }
  });

  test("in-scope existing campaign with a missing render file on disk marks the existing-renders entry partial and exits 1 while keeping the normalised version", async () => {
    const t = tree();
    root = t.root;
    const slug = "missing-r";
    await seedClassPWithLogo(t.root, slug);
    await seedReport(env, slug, [`${slug}/missing.png`]);
    const { entry } = await expectPartialPlannedApply(env, t, slug, "partial-missing");
    const renders = entry.renders as Record<string, unknown>[];
    expect(renders).toHaveLength(1);
    expect(renders[0]!.status).toBe("missing");
  });

  test("readOutputRender refuses symlinks and paths escaping outputRoot", async () => {
    const t = tree();
    root = t.root;
    const slug = "sym-c";
    await seedLiveZeroRefCampaign(env, slug);
    await setCreatedAt(env, slug, "2026-09-30T23:59:00Z");
    writeAt(t.output, `${slug}/real.png`, PNG);
    linkAt(t.output, `${slug}/link.png`, join(t.output, `${slug}/real.png`));
    await seedReport(env, slug, [`${slug}/link.png`, `${slug}/../escape.png`]);
    const result = freshResult("refused-sym");
    try {
      const digest = await sourceDigest(t.root);
      const { code, err } = await runPlannedApply(env, t.root, t.output, { digest }, result);
      expect(code).toBe(1);
      expect(err).toEqual([]);
      const lines = readResultLines(result);
      const entry = lines.find(
        (line) => line.kind === "existing-renders" && line.slug === slug,
      ) as Record<string, unknown>;
      expect(entry.partial).toBe(true);
      const renders = entry.renders as Record<string, unknown>[];
      expect(renders.map((render) => render.status).sort()).toEqual(["refused", "refused"]);
      const linkKey = renderObjectKey(
        renderPrefix("local", await campaignIdFor(env, slug)),
        slug,
        `${slug}/link.png`,
      );
      expect(await env.objects.get(linkKey)).toBeUndefined();
      expect(env.objects.putCount).toBe(0);
    } finally {
      rmSync(result, { force: true });
    }
  });

  test("out-of-scope report path with an unresolvable object key is neither listed nor touched", async () => {
    const t = tree();
    root = t.root;
    const slug = "oos-bad-key";
    await seedLiveZeroRefCampaign(env, slug);
    await setCreatedAt(env, slug, "2026-10-02T00:00:00Z");
    const badPath = "mismatched-slug/render.png";
    writeAt(t.output, badPath, PNG);
    await seedReport(env, slug, [badPath]);

    const result = freshResult("oos-bad-key");
    try {
      const digest = await sourceDigest(t.root);
      const { code, err } = await runPlannedApply(env, t.root, t.output, { digest }, result);
      expect(code).toBe(0);
      expect(err).toEqual([]);
      const lines = readResultLines(result);
      expect(lines.filter((line) => line.kind === "out-of-scope-render")).toHaveLength(0);
      expect(env.objects.putCount).toBe(0);
    } finally {
      rmSync(result, { force: true });
    }
  });

  test("an out-of-scope report naming a directory and one naming a symlink, with no stored object: neither is listed", async () => {
    const t = tree();
    root = t.root;
    const dirSlug = "oos-dir";
    await seedDatedCampaign(env, dirSlug, "2026-10-02T00:00:00Z");
    mkdirSync(join(t.output, dirSlug, "folder.png"), { recursive: true });
    await seedReport(env, dirSlug, [`${dirSlug}/folder.png`]);

    const symSlug = "oos-sym";
    await seedDatedCampaign(env, symSlug, "2026-10-02T00:00:00Z");
    writeAt(t.output, `${symSlug}/target.png`, PNG);
    linkAt(t.output, `${symSlug}/sym.png`, join(t.output, `${symSlug}/target.png`));
    await seedReport(env, symSlug, [`${symSlug}/sym.png`]);

    const { counts, entries, outOfScope } = await collectExistingRenders(env, t);
    expect(counts.outOfScope).toBe(0);
    expect(entries).toHaveLength(0);
    expect(outOfScope).toHaveLength(0);
  });

  test.each([
    {
      desc: "an unparseable stored report body",
      label: "bad-json-report",
      slug: "bad-json-r",
      body: "this is not json {",
      revision: "r-bad",
      stepError: /^the stored report body for bad-json-r is not JSON/,
    },
    {
      desc: "a non-object JSON stored report body",
      label: "non-obj-report",
      slug: "non-obj-r",
      body: JSON.stringify(["not", "an", "object"]),
      revision: "r-arr",
      stepError: "the stored report body for non-obj-r is not a JSON object",
    },
  ])(
    "in-scope existing campaign with $desc records a stepError, marks the entry partial and exits 1",
    async ({ label, slug, body, revision, stepError }) => {
      const t = tree();
      root = t.root;
      await seedClassPWithLogo(t.root, slug);
      await env.db.query(
        "insert into report (org_id, campaign_id, body, revision) values ('local', $1, $2, $3)",
        [slug, body, revision],
      );
      const { entry } = await expectPartialPlannedApply(env, t, slug, label);
      expect(entry.scope).toBe("normalised");
      expect(entry.renders).toEqual([]);
      expect(entry.minted).toEqual([]);
      if (typeof stepError === "string") {
        expect(entry.stepError).toBe(stepError);
      } else {
        expect(entry.stepError).toMatch(stepError);
      }
    },
  );

  test("applyExistingRenders records a stepError for null and primitive JSON report bodies", async () => {
    const t = tree();
    root = t.root;
    for (const [slug, body] of [
      ["null-body", "null"],
      ["string-body", JSON.stringify("just a string")],
    ] as const) {
      await env.db.query(
        "insert into report (org_id, campaign_id, body, revision) values ('local', $1, $2, $3)",
        [slug, body, "r-sub"],
      );
      const { counts, entries } = await collectExistingRenders(env, t, [slug]);
      expect(counts.partial).toBe(true);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.stepError).toBe(`the stored report body for ${slug} is not a JSON object`);
    }
  });

  test("applyExistingRenders records a stepError when the campaign target cannot be resolved for a scoped report", async () => {
    const t = tree();
    root = t.root;
    const slug = "missing-target";
    await seedReport(env, slug, [`${slug}/proof.png`]);
    const { counts, entries } = await collectExistingRenders(env, t, [slug]);
    expect(counts.partial).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      slug,
      scope: "normalised",
      partial: true,
      stepError: `the target holds no campaign ${slug}; none of its renders was written`,
    });
  });

  test("classifyRenderScope catches unparseable brief body and classifies report out-of-scope", async () => {
    const t = tree();
    root = t.root;
    const slug = "malformed-brief";
    await briefs().createCampaign(slug);
    await setCreatedAt(env, slug, "2026-09-30T23:59:00Z");
    await env.db.query(
      "insert into brief_version (campaign_id, version, actor, body, revision) " +
        "select id, 1, 'user-1', 'not valid json {', 'r-malformed' from campaign " +
        "where org_id = 'local' and slug = $1",
      [slug],
    );
    await expectSingleOutOfScopeProof(env, t, slug);
  });

  test("readOutputRender and hasRenderSourceOnDisk safely reject escaping paths", async () => {
    const t = tree();
    root = t.root;
    const scopedSlug = "scoped-escape";
    await seedDatedCampaign(env, scopedSlug, "2026-09-30T23:59:00Z", ["../escape-outside.png"]);

    const oosSlug = "oos-escape";
    await seedDatedCampaign(env, oosSlug, "2026-10-02T00:00:00Z", ["../escape-oos.png"]);

    const { counts, entries, outOfScope } = await collectExistingRenders(env, t, [scopedSlug]);
    expect(counts.partial).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.slug).toBe(scopedSlug);
    expect(entries[0]!.renders[0]!.status).toBe("refused");
    expect(outOfScope).toHaveLength(0);
  });

  test("stored campaign without brief_version row is handled as out-of-scope", async () => {
    const t = tree();
    root = t.root;
    const slug = "no-brief-camp";
    await briefs().createCampaign(slug);
    await expectSingleOutOfScopeProof(env, t, slug);
  });

  test("empty report paths for scoped and out-of-scope campaigns", async () => {
    const t = tree();
    root = t.root;
    const scopedSlug = "scoped-empty-paths";
    await seedDatedCampaign(env, scopedSlug, "2026-09-30T23:59:00Z", []);

    const oosSlug = "oos-empty-paths";
    await seedDatedCampaign(env, oosSlug, "2026-10-02T00:00:00Z", []);

    const { counts, entries, outOfScope } = await collectExistingRenders(env, t);
    expect(counts.objectsMinted).toBe(0);
    expect(counts.partial).toBe(false);
    expect(counts.outOfScope).toBe(0);
    expect(entries).toHaveLength(0);
    expect(outOfScope).toHaveLength(0);
  });

  test("stampOutputRender refuses directory paths and files exceeding options.maxBytes", async () => {
    const t = tree();
    root = t.root;
    const slug = "dir-and-cap";
    await seedDatedCampaign(env, slug);

    mkdirSync(join(t.output, `${slug}/adir`), { recursive: true });
    writeAt(t.output, `${slug}/big.png`, PNG);

    await seedReport(env, slug, [`${slug}/adir`, `${slug}/big.png`]);

    const { counts, entries } = await collectExistingRenders(env, t, [], { maxBytes: 10 });
    expect(counts.partial).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.renders).toHaveLength(2);
    expect(entries[0]!.renders[0]!.status).toBe("refused");
    expect(entries[0]!.renders[1]!.status).toBe("refused");
  });

  test("stampOutputRender refuses escaping paths for a scoped campaign", async () => {
    const t = tree();
    root = t.root;
    const slug = "stamp-escape";
    await seedDatedCampaign(env, slug, "2026-09-30T23:59:00Z", [
      "../escape-outside.png",
      `${slug}/../escape-rel.png`,
    ]);

    const { counts, entries } = await collectExistingRenders(env, t, [slug]);
    expect(counts.partial).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.slug).toBe(slug);
    expect(entries[0]!.renders).toHaveLength(2);
    expect(entries[0]!.renders[0]!.status).toBe("refused");
    expect(entries[0]!.renders[1]!.status).toBe("refused");
  });

  test("stampOutputRender refuses a render under a symlinked parent directory", async () => {
    const t = tree();
    root = t.root;
    const slug = "sym-parent-camp";
    await seedDatedCampaign(env, slug);

    const realDir = join(t.output, "real-parent");
    mkdirSync(realDir, { recursive: true });
    writeAt(t.output, "real-parent/render.png", PNG);
    mkdirSync(join(t.output, slug), { recursive: true });
    symlinkSync(realDir, join(t.output, slug, "symdir"));

    await seedReport(env, slug, [`${slug}/symdir/render.png`]);
    await expectSingleRefusedRender(env, t, slug, "symlink");
  });

  test("stampOutputRender refuses a directory at the report's path", async () => {
    const t = tree();
    root = t.root;
    const slug = "dir-path-camp";
    await seedDatedCampaign(env, slug);

    mkdirSync(join(t.output, slug, "folder.png"), { recursive: true });

    await seedReport(env, slug, [`${slug}/folder.png`]);
    await expectSingleRefusedRender(env, t, slug, "is not a regular file");
  });

  test("campaign with version > 1 and import actor but non-zero path refs is classified out-of-scope", async () => {
    const t = tree();
    root = t.root;
    const slug = "imp-actor-with-refs";
    await briefs().createCampaign(slug);
    await setCreatedAt(env, slug, "2026-09-30T23:59:00Z");
    const logo = campLogo(slug);
    writeAt(t.root, logo, PNG);
    const briefWithRef = briefBody({ id: slug, products: [product(logo)] });
    await env.db.query(
      "insert into brief_version (campaign_id, version, actor, body, revision) " +
        "select id, 2, 'import:pt-8', $1, 'r-imp' from campaign " +
        "where org_id = 'local' and slug = $2",
      [JSON.stringify(briefWithRef), slug],
    );
    await expectSingleOutOfScopeProof(env, t, slug);
  });

  test("applyExistingRenders defaults objects store when undefined", async () => {
    const t = tree();
    root = t.root;
    const counts = await applyExistingRenders(
      env.db,
      undefined,
      ctxWith(t.root),
      new Set(),
      new Set(),
      {
        onMinted: async () => {},
        onEntry: async () => {},
        onOutOfScope: async () => {},
      },
    );
    expect(counts.objectsMinted).toBe(0);
    expect(counts.partial).toBe(false);
    expect(counts.outOfScope).toBe(0);
  });

  test("applyExistingNormalise falls back to default stores when partial stores are passed", async () => {
    const t = tree();
    root = t.root;
    const ctx = ctxWith(t.root);
    const replanned = { items: [], normaliseCount: 0, digest: "abc" };
    const counts = await applyExistingNormalise(env.db, ctx, replanned, async () => {}, {
      draftCount: async () => 0,
    });
    expect(counts.normalised).toBe(0);
  });
});
