import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { main } from "../../../../bin/import.js";
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
import { verifyCampaign, verifyImport, type VerifyStores } from "../verify.js";
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
  return watched(env, () =>
    verifyImport(stores(), ctx, planned.result.campaigns, planned.expectedHashes),
  );
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
