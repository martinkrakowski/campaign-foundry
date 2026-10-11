import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { main } from "../../../../bin/import.js";
import { hashBytes } from "../../brief-files.js";
import { PgDecisionStore } from "../../ports/pg-decision-store.js";
import { PgReportStore } from "../../ports/pg-report-store.js";
import { getBriefStore, getPoolStore, setPoolStore } from "../../ports/index.js";
import type { AssetStorePort } from "../../ports/asset-store.port.js";
import type { PoolStorePort } from "../../ports/pool-store.port.js";
import type { CampaignEntry } from "../apply.js";
import { importTenant } from "../import-tenant.js";
import {
  ON_A_REAL_TEST_SERVER,
  failOnNth,
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
const POOL_HAND = Buffer.from(JSON.stringify(POOL), "utf8");
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
const BLOCKED =
  "not written: the report for camp was refused, and a decision names the report it was given against";

/** One campaign `camp` with a PNG input; `files` adds its report, pool and decisions. */
function tree(files: { report?: Buffer; pool?: Buffer; decisions?: Buffer }): {
  root: string;
  output: string;
} {
  const root = makeRoot();
  const output = join(root, "output");
  mkdirSync(output, { recursive: true });
  writeAt(root, "assets/inputs/camp/logo.png", PNG);
  writeBrief(root, "camp.yaml", {
    id: "camp",
    products: [
      { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/camp/logo.png" },
    ],
  });
  if (files.report) writeAt(output, "reports/camp.json", files.report);
  if (files.pool) writeAt(root, "briefs/camp/pools.json", files.pool);
  if (files.decisions) writeAt(output, "decisions/camp.json", files.decisions);
  return { root, output };
}

/** A probe as the plan JSON holds it. Typed here, so the test does not lean on the code's own type. */
type Probe = {
  slug: string;
  state: string;
  reason?: string;
  rows?: {
    kind: string;
    predicted: string;
    revision?: string;
    reason?: string;
    recanonicalised?: boolean;
  }[];
};
type Planned = { code: number; err: string[]; digest: string; probes: Probe[]; writes: string[] };

/** Any statement that changes a row. */
const WRITE = /\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i;

/**
 * Run `plan` on the tree against the harness's target. `writes` is every INSERT,
 * UPDATE or DELETE the run sent: it must always be empty. `prepare` runs after the
 * stores are reset, for a test that swaps one of them.
 */
async function plan(
  env: Env,
  root: string,
  output: string,
  prepare: () => void = () => {},
): Promise<Planned> {
  env.reinstall();
  prepare();
  const out: string[] = [];
  const err: string[] = [];
  const from = env.queries.length;
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
  const json = JSON.parse(out[3]!) as { digest: string; probes: Probe[] };
  return {
    code,
    err,
    digest: json.digest,
    probes: json.probes,
    writes: env.queries.slice(from).filter((text) => WRITE.test(text)),
  };
}

const results: string[] = [];
/** Run `apply` with `--expect digest`; answers the exit code, stderr and the campaign lines. */
async function apply(
  env: Env,
  root: string,
  output: string,
  digest: string,
  label: string,
): Promise<{ code: number; err: string[]; lines: CampaignEntry[] }> {
  env.reinstall();
  const err: string[] = [];
  const result = join(tmpdir(), `cf-plan-rows-${label}-${process.pid}.json`);
  rmSync(result, { force: true });
  results.push(result);
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
      "--expect",
      digest,
      "--result",
      result,
    ],
    { stdout: () => {}, stderr: (line) => err.push(line) },
  );
  const lines = readFileSync(result, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.kind === "campaign") as unknown as CampaignEntry[];
  return { code, err, lines };
}

/** Every stored row of the three kinds, with what a rewrite would change. */
async function stored(env: Env): Promise<Record<string, string[]>> {
  const q = async (sql: string): Promise<string[]> =>
    (await env.db.query<{ v: string }>(sql, ["local"])).rows.map((r) => r.v);
  return {
    reports: await q(
      "select campaign_id || ' ' || revision || ' ' || updated_at::text as v from report where org_id = $1",
    ),
    pools: await q(
      "select campaign_id || ' ' || revision || ' ' || updated_at::text as v from pool where org_id = $1",
    ),
    decisionSets: await q(
      "select campaign_id || ' ' || revision as v from decision_set where org_id = $1",
    ),
    decisions: await q("select count(*)::text as v from decision where org_id = $1"),
  };
}
const NOTHING_STORED = { reports: [], pools: [], decisionSets: [], decisions: ["0"] };

/** What `apply` recorded, said the way `plan` predicts it. The test's own table, not the code's. */
const WORD = { written: "write", skipped: "skip", refused: "refuse", failed: "failed" } as const;
function asPredicted(rows: CampaignEntry["rows"]): unknown[] {
  return (rows ?? []).map(({ kind, status, ...rest }) => ({
    kind,
    predicted: WORD[status],
    ...rest,
  }));
}

describe.skipIf(ON_A_REAL_TEST_SERVER)("plan: predicted report, pool and decision rows", () => {
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

  test("the plan digest and --expect do not move when the target does", async () => {
    const t = tree({ report: REPORT, pool: POOL_HAND, decisions: DECISIONS });
    root = t.root;
    const empty = await plan(env, t.root, t.output);
    expect(empty.code).toBe(0);
    expect(empty.digest).toHaveLength(64);
    const first = await apply(env, t.root, t.output, empty.digest, "d1");
    expect(first.err).toEqual([]);
    expect(first.code).toBe(0);
    const full = await plan(env, t.root, t.output);
    expect(full.digest).toBe(empty.digest);
    await new PgReportStore(env.db, "local").writeReport("camp", THEIRS);
    const changed = await plan(env, t.root, t.output);
    expect(changed.digest).toBe(empty.digest);
    // The digest reviewed against the EMPTY target is still the one `apply` takes.
    const second = await apply(env, t.root, t.output, empty.digest, "d2");
    expect(second.err).toEqual([]);
    expect(second.code).toBe(1);
    expect(second.lines[0]!.rows?.[0]).toMatchObject({ kind: "report", status: "refused" });
  });

  test("on an empty target plan predicts a write for every row, flags the pool it would re-canonicalise, and writes nothing", async () => {
    const t = tree({ report: REPORT, pool: POOL_HAND, decisions: DECISIONS });
    root = t.root;
    const got = await plan(env, t.root, t.output);
    expect(got.err).toEqual([]);
    expect(got.code).toBe(0);
    expect(got.probes).toHaveLength(1);
    expect(got.probes[0]!.state).toBe("absent");
    expect(got.probes[0]!.rows).toEqual([
      { kind: "report", predicted: "write", revision: hashBytes(REPORT) },
      {
        kind: "pool",
        predicted: "write",
        revision: hashBytes(POOL_CANONICAL),
        recanonicalised: true,
      },
      { kind: "decisions", predicted: "write", revision: hashBytes(DECISIONS) },
    ]);
    expect(got.writes).toEqual([]);
    expect(await stored(env)).toEqual(NOTHING_STORED);
    expect(env.objects.putCount).toBe(0);
  });

  test("the prediction follows the target and is what apply then records: write, then skip, then refuse", async () => {
    const t = tree({ report: REPORT, pool: POOL_HAND, decisions: DECISIONS });
    root = t.root;
    const empty = await plan(env, t.root, t.output);
    const first = await apply(env, t.root, t.output, empty.digest, "p1");
    expect(first.code).toBe(0);
    expect(first.lines[0]!.rows).toHaveLength(3);
    expect(empty.probes[0]!.rows).toEqual(asPredicted(first.lines[0]!.rows));

    const full = await plan(env, t.root, t.output);
    expect(full.probes[0]!.state).toBe("unchanged");
    expect(full.probes[0]!.rows?.map((row) => `${row.kind}:${row.predicted}`)).toEqual([
      "report:skip",
      "pool:skip",
      "decisions:skip",
    ]);
    expect(full.probes[0]!.rows?.[1]?.recanonicalised).toBe(true);
    expect(full.writes).toEqual([]);

    await new PgReportStore(env.db, "local").writeReport("camp", THEIRS);
    const before = await stored(env);
    const changed = await plan(env, t.root, t.output);
    const rows = changed.probes[0]!.rows;
    expect(rows?.map((row) => `${row.kind}:${row.predicted}`)).toEqual([
      "report:refuse",
      "pool:skip",
      "decisions:skip",
    ]);
    expect(rows?.[0]?.reason).toMatch(/^a different report is already stored for camp/);
    expect(rows?.[2]).toEqual({
      kind: "decisions",
      predicted: "skip",
      revision: hashBytes(DECISIONS),
    });
    expect(changed.writes).toEqual([]);
    expect(await stored(env)).toEqual(before);
    expect([full.digest, changed.digest]).toEqual([empty.digest, empty.digest]);
    const second = await apply(env, t.root, t.output, empty.digest, "p2");
    expect(second.code).toBe(1);
    expect(rows).toEqual(asPredicted(second.lines[0]!.rows));
  });

  test("a refused report predicts decisions that are not stored, or are different, as refused, and writes nothing", async () => {
    const t = tree({ report: REPORT, pool: POOL_CANONICAL, decisions: DECISIONS });
    root = t.root;
    await new PgReportStore(env.db, "local").writeReport("camp", THEIRS);
    const none = await plan(env, t.root, t.output);
    expect(none.probes[0]!.rows?.[2]).toEqual({
      kind: "decisions",
      predicted: "refuse",
      reason: BLOCKED,
    });
    await new PgDecisionStore(env.db, "local").writeDecisions(
      "camp",
      {
        "camp/a.png": {
          verdict: "rejected",
          actor: "bo",
          at: "2026-09-02T10:00:00.000Z",
          run: "r2",
        },
      } as never,
      null,
    );
    const before = await stored(env);
    const different = await plan(env, t.root, t.output);
    expect(different.probes[0]!.rows?.[2]).toEqual({
      kind: "decisions",
      predicted: "refuse",
      reason: BLOCKED,
    });
    expect([none.writes, different.writes]).toEqual([[], []]);
    expect(await stored(env)).toEqual(before);
  });

  test("a different stored pool is predicted pool:refuse, nothing written", async () => {
    const t = tree({ pool: POOL_CANONICAL });
    root = t.root;
    const empty = await plan(env, t.root, t.output);
    const first = await apply(env, t.root, t.output, empty.digest, "d1");
    expect(first.code).toBe(0);
    writeAt(
      t.root,
      "briefs/camp/pools.json",
      Buffer.from(`${JSON.stringify({ ...POOL, model: "another-model" }, null, 2)}\n`, "utf8"),
    );
    const before = await stored(env);
    const got = await plan(env, t.root, t.output);
    expect(got.code).toBe(0);
    expect(got.probes[0]!.rows).toEqual([
      {
        kind: "pool",
        predicted: "refuse",
        reason: expect.stringMatching(
          /^a different pool is already stored for camp \(revision [0-9a-f]{64}\)$/,
        ),
      },
    ]);
    expect(got.writes).toEqual([]);
    expect(await stored(env)).toEqual(before);
  });

  test("a campaign whose probe is refused gets no row prediction", async () => {
    const t = tree({ report: REPORT, pool: POOL_HAND, decisions: DECISIONS });
    root = t.root;
    // A same-slug campaign a user created after the switch, with another body.
    env.reinstall();
    const briefs = getBriefStore(importTenant("local"));
    await briefs.createCampaign("camp", {});
    await briefs.createBrief(
      briefBody({
        id: "camp",
        products: [
          {
            id: "p1",
            name: "SOMEONE ELSE",
            primaryColor: "#222222",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      }),
    );
    const got = await plan(env, t.root, t.output);
    expect(got.code).toBe(0);
    expect(got.probes[0]!.state).toBe("refused");
    expect(got.probes[0]!.rows).toBeUndefined();
    expect("rows" in got.probes[0]!).toBe(false);
    expect(await stored(env)).toEqual(NOTHING_STORED);
  });

  test("a campaign with no report file gets its decisions predicted, and one with no row file gets an empty list", async () => {
    const t = tree({ decisions: DECISIONS });
    root = t.root;
    const got = await plan(env, t.root, t.output);
    expect(got.probes[0]!.rows).toEqual([
      { kind: "decisions", predicted: "write", revision: hashBytes(DECISIONS) },
    ]);
    rmSync(join(t.output, "decisions/camp.json"));
    const none = await plan(env, t.root, t.output);
    expect(none.code).toBe(0);
    expect(none.probes[0]!.rows).toEqual([]);
  });

  test("a store that throws during the probe is that row failed: nothing is claimed for it or for the rows after it, and plan exits 0", async () => {
    const t = tree({ report: REPORT, pool: POOL_CANONICAL, decisions: DECISIONS });
    root = t.root;
    const got = await plan(env, t.root, t.output, () =>
      setPoolStore(
        failOnNth(
          getPoolStore(importTenant("local")) as PoolStorePort & AssetStorePort,
          "readPool",
          1,
        ),
      ),
    );
    expect(got.err).toEqual([]);
    expect(got.code).toBe(0);
    expect(got.probes[0]!.rows).toEqual([
      { kind: "report", predicted: "write", revision: hashBytes(REPORT) },
      { kind: "pool", predicted: "failed", reason: "injected" },
    ]);
    expect(got.writes).toEqual([]);
    expect(await stored(env)).toEqual(NOTHING_STORED);
  });
});
