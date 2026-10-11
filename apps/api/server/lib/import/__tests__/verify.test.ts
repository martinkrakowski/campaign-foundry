import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { main } from "../../../../bin/import.js";
import { renderObjectKey } from "@campaignfoundry/Distribution";
import { objectStoreClient } from "../../object-store/index.js";
import { renderPrefix } from "../../object-store/object-keys.js";
import type { StoredBrief } from "../../ports/brief-store.port.js";
import { PgReportStore } from "../../ports/pg-report-store.js";
import {
  getAssetStore,
  getBriefStore,
  getDecisionStore,
  getPoolStore,
  getReportStore,
} from "../../ports/index.js";
import { replan, type CampaignEntry } from "../apply.js";
import { importTenant } from "../import-tenant.js";
import type { StepContext } from "../steps.js";
import type { ReportFieldPlan } from "../plan.js";
import { renderFingerprints } from "../render-file.js";
import {
  summarise,
  verifyCampaign,
  verifyImport,
  verifyRenders,
  verifyRows,
  type VerifyStores,
} from "../verify.js";
import {
  ON_A_REAL_TEST_SERVER,
  restoreApplyEnvironment,
  useApplyEnvironment,
} from "./fixtures/apply-harness.js";
import { PNG, briefBody, dropRoot, makeRoot, writeAt, writeBrief } from "./fixtures/tree.js";

const SWITCHED_AT = "2026-10-01T00:00:00Z";
type Env = Awaited<ReturnType<typeof useApplyEnvironment>>;

const REPORT = Buffer.from('{\n  "assets":  [ ]  }\n', "utf8");
const THEIRS = '{"assets":["a run made after the switch"]}';
const POOL = {
  briefId: "camp",
  generatedAt: "2026-09-01T10:00:00.000Z",
  model: "a-model",
  entries: [{ id: "e1", text: "Fresh every day", status: "approved" }],
};
const POOL_CANONICAL = Buffer.from(`${JSON.stringify(POOL, null, 2)}\n`, "utf8");
const DECISIONS = Buffer.from(
  `${JSON.stringify(
    {
      "camp/a.png": {
        verdict: "approved",
        actor: "ana",
        at: "2026-09-01T10:00:00.000Z",
        run: "r1",
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const LOGO_REF = "assets/inputs/camp/logo.png";

/** Any statement that changes a row. */
const WRITE = /\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i;
/** What every verify call must have sent: no row change, no object put, no object delete. */
const READ_ONLY = { writes: [], puts: 0, deletes: 0 };
/** One campaign `camp` with a PNG input; `files` adds its report, pool and decisions. */
function tree(files: { report?: Buffer; pool?: Buffer; decisions?: Buffer }): {
  root: string;
  output: string;
} {
  const root = makeRoot();
  const output = join(root, "output");
  mkdirSync(output, { recursive: true });
  writeAt(root, LOGO_REF, PNG);
  writeBrief(root, "camp.yaml", {
    id: "camp",
    products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: LOGO_REF }],
  });
  if (files.report) writeAt(output, "reports/camp.json", files.report);
  if (files.pool) writeAt(root, "briefs/camp/pools.json", files.pool);
  if (files.decisions) writeAt(output, "decisions/camp.json", files.decisions);
  return { root, output };
}

function ctxWith(root: string, output: string): StepContext {
  return {
    orgId: "local",
    switchedAt: new Date(SWITCHED_AT),
    projectRoot: root,
    outputRoot: output,
    includeSamples: false,
    fsOnly: false,
  };
}

const results: string[] = [];
/** Run `apply` on the tree with its real digest; answers the exit code and the campaign lines. */
async function apply(
  env: Env,
  root: string,
  output: string,
  label: string,
): Promise<{ code: number; lines: CampaignEntry[] }> {
  const digest = (await replan(ctxWith(root, output))).digest;
  env.reinstall();
  const result = join(tmpdir(), `cf-verify-${label}-${process.pid}.json`);
  rmSync(result, { force: true });
  results.push(result);
  const flags = ["--project-root", root, "--output-root", output, "--org", "local"];
  const code = await main(
    ["apply", ...flags, "--switched-at", SWITCHED_AT, "--expect", digest, "--result", result],
    { stdout: () => {}, stderr: () => {} },
  );
  const lines = readFileSync(result, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.kind === "campaign") as unknown as CampaignEntry[];
  return { code, lines };
}
/** The target's stores, as verify reads them. Call it AFTER `env.reinstall()`. */
function stores(): VerifyStores {
  const scope = importTenant("local");
  return {
    briefs: getBriefStore(scope),
    assets: getAssetStore(scope),
    reports: getReportStore(scope),
    pools: getPoolStore(scope),
    decisions: getDecisionStore(scope),
    objects: objectStoreClient(),
  };
}

/** Run `work`; answer what it returned and what it SENT: row changes, object puts, object deletes. */
async function watched<T>(
  env: Env,
  work: () => Promise<T>,
): Promise<{ got: T; sent: { writes: string[]; puts: number; deletes: number } }> {
  env.reinstall();
  const from = env.queries.length;
  const puts = env.objects.putCount;
  const deletes = env.objects.deleteCount;
  const got = await work();
  return {
    got,
    sent: {
      writes: env.queries.slice(from).filter((text) => WRITE.test(text)),
      puts: env.objects.putCount - puts,
      deletes: env.objects.deleteCount - deletes,
    },
  };
}

/** `verifyImport` over the tree, re-planned as `apply` re-plans it. */
async function verify(env: Env, root: string, output: string) {
  const ctx = ctxWith(root, output);
  const planned = await replan(ctx);
  return watched(env, () => verifyImport(stores(), ctx, planned));
}

/** `verifyCampaign` for `camp` on the real stores, except that its latest version reads as `latest` says. */
async function withLatest(
  env: Env,
  root: string,
  output: string,
  latest: (stored: StoredBrief) => StoredBrief | undefined,
) {
  const ctx = ctxWith(root, output);
  const planned = await replan(ctx);
  return watched(env, async () => {
    const real = stores();
    const stored = (await real.briefs.findBriefById("camp"))!;
    const briefs: VerifyStores["briefs"] = {
      campaignMeta: (ref) => real.briefs.campaignMeta(ref),
      findBriefById: async () => latest(stored),
    };
    const campaign = planned.result.campaigns[0]!;
    return verifyCampaign({ ...real, briefs }, ctx, campaign, planned.expectedHashes);
  });
}
describe.skipIf(ON_A_REAL_TEST_SERVER)("verify: campaigns, assets and rows", () => {
  let env: Env;
  let root: string | undefined;
  beforeEach(async () => {
    env = await useApplyEnvironment();
  });
  afterEach(async () => {
    dropRoot(root);
    root = undefined;
    for (const path of results.splice(0)) rmSync(path, { force: true });
    await restoreApplyEnvironment();
  });

  test("a clean import verifies: the campaign, its asset, report, pool and decisions all match, and nothing is written", async () => {
    const t = tree({ report: REPORT, pool: POOL_CANONICAL, decisions: DECISIONS });
    root = t.root;
    expect((await apply(env, t.root, t.output, "v1")).code).toBe(0);
    const { got, sent } = await verify(env, t.root, t.output);
    expect(got.checks.map((check) => `${check.entity}:${check.status}`)).toEqual([
      "campaign:match",
      "asset:match",
      "report:match",
      "pool:match",
      "decisions:match",
    ]);
    expect(got.checks[1]).toMatchObject({
      item: LOGO_REF,
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(got.counts).toEqual({
      campaign: { checked: 1, matched: 1 },
      asset: { checked: 1, matched: 1 },
      report: { checked: 1, matched: 1 },
      pool: { checked: 1, matched: 1 },
      decisions: { checked: 1, matched: 1 },
      render: { checked: 0, matched: 0 },
    });
    expect(got.ok).toBe(true);
    expect(sent).toEqual(READ_ONLY);
  });

  test("one flipped byte in a stored object is a mismatch that names the asset", async () => {
    const t = tree({});
    root = t.root;
    const applied = await apply(env, t.root, t.output, "v2");
    expect(applied.code).toBe(0);
    const key = applied.lines[0]!.minted.assets[0]!.key;
    const flipped = Buffer.from((await env.objects.get(key))!.bytes);
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 0xff;
    await env.objects.put(key, flipped);
    const { got, sent } = await verify(env, t.root, t.output);
    expect(got.checks).toEqual([
      {
        entity: "campaign",
        slug: "camp",
        status: "mismatch",
        reason: "1 of its assets do not match",
      },
      {
        entity: "asset",
        slug: "camp",
        item: LOGO_REF,
        status: "mismatch",
        reason: "the stored bytes differ from the source file (logo.png)",
      },
    ]);
    expect(got.counts.asset).toEqual({ checked: 1, matched: 0 });
    expect(got.ok).toBe(false);
    expect(sent).toEqual(READ_ONLY);
  });
  test("a campaign the target does not hold is a mismatch, and its rows are not checked", async () => {
    const t = tree({ report: REPORT });
    root = t.root;
    const { got, sent } = await verify(env, t.root, t.output);
    expect(got.checks).toEqual([
      {
        entity: "campaign",
        slug: "camp",
        status: "mismatch",
        reason: "no campaign row in the target",
      },
    ]);
    expect(got.counts.report).toEqual({ checked: 0, matched: 0 });
    expect(got.ok).toBe(false);
    expect(sent).toEqual(READ_ONLY);
  });

  test("a campaign row with no saved version is a mismatch", async () => {
    const t = tree({});
    root = t.root;
    env.reinstall();
    await getBriefStore(importTenant("local")).createCampaign("camp", {});
    const { got, sent } = await verify(env, t.root, t.output);
    expect(got.checks).toEqual([
      {
        entity: "campaign",
        slug: "camp",
        status: "mismatch",
        reason: "the campaign has no saved version",
      },
    ]);
    expect(sent).toEqual(READ_ONLY);
  });

  test("a same-slug campaign that holds none of the source's assets is a mismatch that names the missing asset", async () => {
    const t = tree({ report: REPORT });
    root = t.root;
    env.reinstall();
    const briefs = getBriefStore(importTenant("local"));
    await briefs.createCampaign("camp", {});
    await briefs.createBrief(
      briefBody({
        id: "camp",
        products: [{ id: "p1", name: "SOMEONE ELSE", primaryColor: "#222222", logoPath: LOGO_REF }],
      }),
    );
    const { got, sent } = await verify(env, t.root, t.output);
    expect(got.checks).toEqual([
      {
        entity: "campaign",
        slug: "camp",
        status: "mismatch",
        reason: "1 of its assets do not match",
      },
      {
        entity: "asset",
        slug: "camp",
        item: LOGO_REF,
        status: "mismatch",
        reason: "no asset named logo.png is stored for camp",
      },
    ]);
    expect(sent).toEqual(READ_ONLY);
  });

  test("a source file that is not the reviewed one is a mismatch, not a comparison", async () => {
    const t = tree({});
    root = t.root;
    expect((await apply(env, t.root, t.output, "v6")).code).toBe(0);
    const ctx = ctxWith(t.root, t.output);
    const campaign = (await replan(ctx)).result.campaigns[0]!;
    const { got, sent } = await watched(env, () =>
      verifyCampaign(stores(), ctx, campaign, new Map()),
    );
    expect(got).toEqual([
      {
        entity: "campaign",
        slug: "camp",
        status: "mismatch",
        reason: "the source cannot be compared: briefs/camp.yaml is not in the reviewed digest",
      },
    ]);
    expect(sent).toEqual(READ_ONLY);
  });
  test("an asset row whose object is gone is a mismatch", async () => {
    const t = tree({});
    root = t.root;
    const applied = await apply(env, t.root, t.output, "v7");
    expect(applied.code).toBe(0);
    await env.objects.delete(applied.lines[0]!.minted.assets[0]!.key);
    const { got, sent } = await verify(env, t.root, t.output);
    expect(got.checks[1]).toMatchObject({
      entity: "asset",
      status: "mismatch",
      reason: expect.stringMatching(
        /^asset logo\.png \([0-9a-f-]{36}\) has a row but its bytes cannot be read$/,
      ),
    });
    expect(got.ok).toBe(false);
    expect(sent).toEqual(READ_ONLY);
  });

  test("a stored brief that differs from the rewritten source is a mismatch, its assets still match", async () => {
    const t = tree({});
    root = t.root;
    expect((await apply(env, t.root, t.output, "v8")).code).toBe(0);
    const { got, sent } = await withLatest(env, t.root, t.output, (stored) => ({
      ...stored,
      brief: { ...stored.brief, campaignMessage: "changed since the import" },
    }));
    expect(got.map((check) => `${check.entity}:${check.status}`)).toEqual([
      "campaign:mismatch",
      "asset:match",
    ]);
    expect(got[0]!.reason).toBe("the stored brief differs from the rewritten source");
    expect(sent).toEqual(READ_ONLY);
  });

  test("a latest version that cannot be read is a mismatch", async () => {
    const t = tree({});
    root = t.root;
    expect((await apply(env, t.root, t.output, "v9")).code).toBe(0);
    const { got, sent } = await withLatest(env, t.root, t.output, () => undefined);
    expect(got[0]).toEqual({
      entity: "campaign",
      slug: "camp",
      status: "mismatch",
      reason: "the latest version cannot be read",
    });
    expect(sent).toEqual(READ_ONLY);
  });
  test("a different report in the target is a mismatch with the store's reason, the pool still matches", async () => {
    const t = tree({ report: REPORT, pool: POOL_CANONICAL });
    root = t.root;
    expect((await apply(env, t.root, t.output, "v10")).code).toBe(0);
    await new PgReportStore(env.db, "local").writeReport("camp", THEIRS);
    const { got, sent } = await verify(env, t.root, t.output);
    expect(got.checks.map((check) => `${check.entity}:${check.status}`)).toEqual([
      "campaign:match",
      "asset:match",
      "report:mismatch",
      "pool:match",
    ]);
    expect(got.checks[2]!.reason).toMatch(
      /^a different report is already stored for camp \(revision [0-9a-f]{64}\)$/,
    );
    expect(got.counts.report).toEqual({ checked: 1, matched: 0 });
    expect(got.ok).toBe(false);
    expect(sent).toEqual(READ_ONLY);
  });

  test("a source row the target does not hold is a mismatch: not stored, and verify does not write it", async () => {
    const t = tree({ report: REPORT });
    root = t.root;
    expect((await apply(env, t.root, t.output, "v11")).code).toBe(0);
    // A pool file that appeared after the import: the target has no pool row.
    writeAt(t.root, "briefs/camp/pools.json", POOL_CANONICAL);
    const { got, sent } = await verify(env, t.root, t.output);
    expect(got.checks[2]).toEqual({ entity: "report", slug: "camp", status: "match" });
    expect(got.checks[3]).toEqual({
      entity: "pool",
      slug: "camp",
      status: "mismatch",
      reason: "not stored in the target",
    });
    expect(sent).toEqual(READ_ONLY);
    const rows = await env.db.query("select 1 from pool where org_id = $1", ["local"]);
    expect(rows.rows).toEqual([]);
  });
});

const RENDER = "camp/p1/1x1.png";
const OLD_SHAPE = "p1/old.mp4";
/** A report whose one row names RENDER under two fields, and a path of the old `<productId>/…` shape. */
const REPORT_R = Buffer.from(
  JSON.stringify({ assets: [{ outputPath: RENDER, proofPath: RENDER, videoPath: OLD_SHAPE }] }),
  "utf8",
);

/** `tree`, plus the render file RENDER names. */
function renderTree(files: Parameters<typeof tree>[0]): { root: string; output: string } {
  const t = tree(files);
  writeAt(t.output, RENDER, PNG);
  return t;
}

/** The key the app reads `path` of campaign `camp` with. Call it after the import. */
async function renderKey(env: Env, path: string): Promise<string> {
  env.reinstall();
  const meta = await getBriefStore(importTenant("local")).campaignMeta("camp");
  return renderObjectKey(renderPrefix("local", meta!.campaignId), "camp", path);
}

const statuses = (checks: readonly { entity: string; status: string }[]): string[] =>
  checks.map((check) => `${check.entity}:${check.status}`);

describe.skipIf(ON_A_REAL_TEST_SERVER)("verify: renders and expected refusals", () => {
  let env: Env;
  let root: string | undefined;
  beforeEach(async () => {
    env = await useApplyEnvironment();
  });
  afterEach(async () => {
    dropRoot(root);
    root = undefined;
    for (const path of results.splice(0)) rmSync(path, { force: true });
    await restoreApplyEnvironment();
  });
  test("a render object with the source file's bytes matches, once per path; a path the plan refused is expected and not counted", async () => {
    const t = renderTree({ report: REPORT_R });
    root = t.root;
    await apply(env, t.root, t.output, "r1");
    await env.objects.put(await renderKey(env, RENDER), PNG);
    const { got, sent } = await verify(env, t.root, t.output);
    expect(statuses(got.checks)).toEqual([
      "campaign:match",
      "asset:match",
      "report:match",
      "render:match",
      "render:expected",
    ]);
    expect(got.checks[3]).toEqual({
      entity: "render",
      slug: "camp",
      item: RENDER,
      status: "match",
    });
    expect(got.checks[4]).toMatchObject({
      item: OLD_SHAPE,
      reason: expect.stringMatching(/^not written: .*render area/),
    });
    expect(got.counts.render).toEqual({ checked: 1, matched: 1 });
    expect(got.ok).toBe(true);
    expect(sent).toEqual(READ_ONLY);
  });

  test("one flipped byte in a render object is a mismatch that names its key", async () => {
    const t = renderTree({ report: REPORT_R });
    root = t.root;
    await apply(env, t.root, t.output, "r2");
    const key = await renderKey(env, RENDER);
    const flipped = Buffer.from(PNG);
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 0xff;
    await env.objects.put(key, flipped);
    const { got, sent } = await verify(env, t.root, t.output);
    expect(got.checks[3]).toEqual({
      entity: "render",
      slug: "camp",
      item: RENDER,
      status: "mismatch",
      reason: `the object at ${key} differs from the source file`,
    });
    expect(got.counts.render).toEqual({ checked: 1, matched: 0 });
    expect(got.ok).toBe(false);
    expect(sent).toEqual(READ_ONLY);
  });
  test("a render the target does not hold is a mismatch", async () => {
    const t = renderTree({ report: REPORT_R });
    root = t.root;
    await apply(env, t.root, t.output, "r3");
    const key = await renderKey(env, RENDER);
    await env.objects.put(key, PNG);
    await env.objects.delete(key);
    const { got, sent } = await verify(env, t.root, t.output);
    expect(got.checks[3]).toMatchObject({
      entity: "render",
      status: "mismatch",
      reason: `no object is stored at ${key}`,
    });
    expect(got.ok).toBe(false);
    expect(sent).toEqual(READ_ONLY);
  });

  test("a render the import does not write is expected: over the cap, no source file, no key; a file that is not the reviewed one is a mismatch", async () => {
    const t = renderTree({ report: REPORT_R });
    root = t.root;
    const ctx = ctxWith(t.root, t.output);
    const planned = await replan(ctx);
    const reviewed = renderFingerprints(planned.files);
    const campaign = { campaignId: "00000000-0000-4000-8000-000000000001", slug: "camp" };
    const ok = (path: string): ReportFieldPlan => ({
      field: "outputPath",
      path,
      status: "ok",
      resolved: join(t.output, path),
    });
    const { got, sent } = await watched(env, async () => [
      ...(await verifyRenders(env.objects, ctx, campaign, [ok(RENDER)], reviewed, 10)),
      ...(await verifyRenders(env.objects, ctx, campaign, [ok("camp/p1/gone.png")], new Map())),
      ...(await verifyRenders(env.objects, ctx, campaign, [ok("camp/p1/../p1/1x1.png")], reviewed)),
      ...(await verifyRenders(env.objects, ctx, campaign, [ok(RENDER)], new Map())),
    ]);
    expect(got.map((check) => [check.status, check.reason])).toEqual([
      ["expected", `not written: ${PNG.length} bytes is over the render cap`],
      ["expected", "not written: no source file"],
      ["expected", expect.stringMatching(/^not written: Refusing an object key/)],
      ["mismatch", `${RENDER} is not in the reviewed digest`],
    ]);
    expect(sent).toEqual(READ_ONLY);
  });
  test("rows the plan already refuses are expected, and so are decisions left unwritten because of such a report", async () => {
    const t = tree({
      report: Buffer.from("[1]"),
      pool: Buffer.from("{not json"),
      decisions: DECISIONS,
    });
    root = t.root;
    await apply(env, t.root, t.output, "r5");
    const { got, sent } = await verify(env, t.root, t.output);
    expect(statuses(got.checks)).toEqual([
      "campaign:match",
      "asset:match",
      "report:expected",
      "pool:expected",
      "decisions:expected",
    ]);
    expect(got.counts.report).toEqual({ checked: 0, matched: 0 });
    expect(got.counts.pool).toEqual({ checked: 0, matched: 0 });
    expect(got.counts.decisions).toEqual({ checked: 0, matched: 0 });
    expect(got.ok).toBe(true);
    expect(sent).toEqual(READ_ONLY);
  });

  test("a file changed since the digest is a mismatch, also when the plan's refusal list names it", async () => {
    const t = tree({ report: REPORT });
    root = t.root;
    await apply(env, t.root, t.output, "r6");
    const planned = await replan(ctxWith(t.root, t.output));
    writeAt(t.output, "reports/camp.json", '{"assets":[],"changed":true}');
    const source = {
      projectRoot: t.root,
      outputRoot: t.output,
      expectedHashes: planned.expectedHashes,
    };
    const listed = [
      { slug: "camp", sourcePath: join(t.output, "reports", "camp.json"), reason: "listed" },
    ];
    const { got, sent } = await watched(env, () => verifyRows(stores(), source, "camp", listed));
    expect(got).toEqual([
      {
        entity: "report",
        slug: "camp",
        status: "mismatch",
        reason: "reports/camp.json changed since the digest",
      },
    ]);
    expect(sent).toEqual(READ_ONLY);
  });
  test("a store that throws while a row is read makes that row a mismatch, and the rows after it are not checked", async () => {
    const t = tree({ report: REPORT, pool: POOL_CANONICAL });
    root = t.root;
    await apply(env, t.root, t.output, "r7");
    const planned = await replan(ctxWith(t.root, t.output));
    const source = {
      projectRoot: t.root,
      outputRoot: t.output,
      expectedHashes: planned.expectedHashes,
    };
    const { got, sent } = await watched(env, () => {
      const real = stores();
      const reports: VerifyStores["reports"] = {
        getRevision: async () => {
          throw new Error("the report store is down");
        },
      };
      return verifyRows({ ...real, reports }, source, "camp", []);
    });
    expect(got).toEqual([
      { entity: "report", slug: "camp", status: "mismatch", reason: "the report store is down" },
    ]);
    expect(sent).toEqual(READ_ONLY);
  });

  test("a different stored report is a mismatch although one of its render paths is on the refusal list; equal stored decisions still match; no render is checked", async () => {
    const t = renderTree({ report: REPORT_R, decisions: DECISIONS });
    root = t.root;
    await apply(env, t.root, t.output, "r8");
    await new PgReportStore(env.db, "local").writeReport("camp", THEIRS);
    const { got, sent } = await verify(env, t.root, t.output);
    expect(statuses(got.checks)).toEqual([
      "campaign:match",
      "asset:match",
      "report:mismatch",
      "decisions:match",
    ]);
    expect(got.counts.render).toEqual({ checked: 0, matched: 0 });
    expect(got.ok).toBe(false);
    expect(sent).toEqual(READ_ONLY);
  });
  test("decisions left unwritten because a DIFFERENT report is stored are a mismatch", async () => {
    const t = tree({ report: REPORT });
    root = t.root;
    await apply(env, t.root, t.output, "r9");
    await new PgReportStore(env.db, "local").writeReport("camp", THEIRS);
    writeAt(t.output, "decisions/camp.json", DECISIONS);
    const { got, sent } = await verify(env, t.root, t.output);
    expect(statuses(got.checks)).toEqual([
      "campaign:match",
      "asset:match",
      "report:mismatch",
      "decisions:mismatch",
    ]);
    expect(got.checks[3]!.reason).toMatch(/^not written: the report for camp was refused/);
    expect(sent).toEqual(READ_ONLY);
  });

  test("nothing to check is ok, with every count at zero", () => {
    const empty = summarise([]);
    expect(empty.ok).toBe(true);
    expect(empty.checks).toEqual([]);
    expect(Object.values(empty.counts)).toEqual(Array(6).fill({ checked: 0, matched: 0 }));
  });
});
