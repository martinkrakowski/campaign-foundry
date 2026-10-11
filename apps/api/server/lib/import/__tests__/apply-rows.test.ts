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
import { replan, type CampaignEntry } from "../apply.js";
import { importTenant } from "../import-tenant.js";
import type { StepContext } from "../steps.js";
import { importRowsStep } from "../rows-step.js";
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
/** A result path in the OS temp dir, removed after the test. */
function freshResult(label: string): string {
  const path = join(tmpdir(), `cf-apply-rows-${label}-${process.pid}.json`);
  rmSync(path, { force: true });
  results.push(path);
  return path;
}

/** Run `apply` on the tree with its real digest; answers the exit code, stdout, stderr and the campaign lines. */
async function apply(
  env: Env,
  root: string,
  output: string,
  label: string,
): Promise<{
  code: number;
  out: string[];
  err: string[];
  lines: CampaignEntry[];
  summary: Record<string, unknown>;
}> {
  const digest = (await replan(ctxWith(root, output))).digest;
  env.reinstall();
  const out: string[] = [];
  const err: string[] = [];
  const result = freshResult(label);
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
    { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
  );
  const parsed = readFileSync(result, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    code,
    out,
    err,
    lines: parsed.filter((line) => line.kind === "campaign") as unknown as CampaignEntry[],
    summary: parsed.find((line) => line.kind === "summary") ?? {},
  };
}

/** Every stored row of the three kinds, with what a rewrite would change. */
async function stored(
  env: Env,
): Promise<{ reports: string[]; pools: string[]; decisionSets: string[] }> {
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
  };
}

const BLOCKED =
  "not written: the report for camp was refused, and a decision names the report it was given against";
const THEIR_REPORT = '{"assets":["a run made after the switch"]}';
const DECISION_MAP = JSON.parse(DECISIONS.toString("utf8")) as never;
const OTHER_DECISIONS = {
  "camp/a.png": {
    verdict: "rejected",
    actor: "bo",
    at: "2026-09-02T10:00:00.000Z",
    run: "r2",
  },
} as never;

/** A statement that changes a decisions row (the `decision` or the `decision_set` table). */
const DECISION_WRITE = /\b(insert\s+into\s+decision|delete\s+from\s+decision|update\s+decision)/i;

/** The only statement a skipped decisions row may send that is not a read: the insert-only claim. */
const INSERT_ONLY_CLAIM =
  /^\s*insert into decision_set \(org_id, campaign_id, revision\) values \(\$1, \$2, \$3\)\s+on conflict \(org_id, campaign_id\) do nothing returning 1\s*$/;

/** Every decisions row's version: a rewrite changes it even when the content is the same. */
async function decisionVersions(env: Env): Promise<string[]> {
  const result = await env.db.query<{ v: string }>(
    `select 'set ' || campaign_id || ' ' || xmin::text || ' ' || ctid::text as v
       from decision_set where org_id = $1
     union all
     select 'row ' || campaign_id || ' ' || asset_key || ' ' || xmin::text || ' ' || ctid::text as v
       from decision where org_id = $1
     order by v`,
    ["local"],
  );
  return result.rows.map((row) => row.v);
}

const getBriefStoreFor = () => getBriefStore(importTenant("local"));

describe.skipIf(ON_A_REAL_TEST_SERVER)("apply: report, pool and decision rows", () => {
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

  test("an imported campaign's report, pool and decisions are written and recorded on its line; a second apply writes none of them", async () => {
    const t = tree({ report: REPORT, pool: POOL_HAND, decisions: DECISIONS });
    root = t.root;
    const first = await apply(env, t.root, t.output, "r1a");
    expect(first.err).toEqual([]);
    expect(first.code).toBe(0);
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]!.outcome).toBe("created");
    expect(first.lines[0]!.minted.campaignId).toBeDefined();
    expect(first.lines[0]!.minted.assets).toHaveLength(1);
    expect(first.lines[0]!.partial).toBeUndefined();
    expect(first.lines[0]!.rows).toEqual([
      { kind: "report", status: "written", revision: hashBytes(REPORT) },
      {
        kind: "pool",
        status: "written",
        revision: hashBytes(POOL_CANONICAL),
        recanonicalised: true,
      },
      { kind: "decisions", status: "written", revision: hashBytes(DECISIONS) },
    ]);
    expect(first.out).toContain("  report: written");
    expect(first.out).toContain("  pool: written (re-canonicalised)");
    expect(first.out).toContain("  decisions: written");
    const before = await stored(env);
    expect(before.reports).toHaveLength(1);
    expect(before.pools).toHaveLength(1);
    expect(before.decisionSets).toHaveLength(1);
    const versionsBefore = await decisionVersions(env);
    expect(versionsBefore).toHaveLength(2);
    const from = env.queries.length;

    const second = await apply(env, t.root, t.output, "r1b");
    expect(second.code).toBe(0);
    expect(second.lines[0]!.outcome).toBe("unchanged");
    expect(second.lines[0]!.rows?.map((row) => `${row.kind}:${row.status}`)).toEqual([
      "report:skipped",
      "pool:skipped",
      "decisions:skipped",
    ]);
    expect(await stored(env)).toEqual(before);
    const sent = env.queries.slice(from).filter((text) => DECISION_WRITE.test(text));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(INSERT_ONLY_CLAIM);
    expect(await decisionVersions(env)).toEqual(versionsBefore);
  });

  test("a campaign the campaign step refused gets no report, pool or decision row", async () => {
    const t = tree({ report: REPORT, pool: POOL_HAND, decisions: DECISIONS });
    root = t.root;
    // A same-slug campaign a user created after the switch: the slug is taken,
    // and its body is not the one this import would write.
    env.reinstall();
    await getBriefStoreFor().createCampaign("camp", {});
    await getBriefStoreFor().createBrief(
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
    const got = await apply(env, t.root, t.output, "r2");
    expect(got.lines[0]!.outcome).toBe("refused");
    expect(got.lines[0]!.rows).toBeUndefined();
    expect(await stored(env)).toEqual({ reports: [], pools: [], decisionSets: [] });
    expect(got.code).toBe(3);
  });

  test("a refused report makes the line partial and exit 1; the pool is still written and the decisions are not", async () => {
    const t = tree({ report: REPORT, pool: POOL_CANONICAL, decisions: DECISIONS });
    root = t.root;
    // A different report is already stored for the slug.
    const theirs = '{"assets":["a run made after the switch"]}';
    await new PgReportStore(env.db, "local").writeReport("camp", theirs);
    const from = env.queries.length;
    const got = await apply(env, t.root, t.output, "r3");
    expect(got.code).toBe(1);
    const line = got.lines[0]!;
    // The campaign itself was imported, and the line still says so.
    expect(line.outcome).toBe("created");
    expect(line.minted.campaignId).toBeDefined();
    expect(line.minted.assets).toHaveLength(1);
    expect(line.partial).toBe(true);
    expect(line.rows?.map((row) => `${row.kind}:${row.status}`)).toEqual([
      "report:refused",
      "pool:written",
      "decisions:refused",
    ]);
    expect(line.rows?.[0]?.reason).toMatch(/^a different report is already stored for camp/);
    expect(line.rows?.[2]?.reason).toBe(
      "not written: the report for camp was refused, and a decision names the report it was given against",
    );
    expect(got.summary).toMatchObject({ created: 1, refused: 0, partial: true });
    const rows = await stored(env);
    expect(rows.pools).toHaveLength(1);
    expect(rows.decisionSets).toEqual([]);
    expect(env.queries.slice(from).filter((text) => DECISION_WRITE.test(text))).toEqual([]);
    expect(rows.reports).toHaveLength(1);
    expect(rows.reports[0]).toContain(hashBytes(Buffer.from(theirs, "utf8")));
    expect(got.out.join("\n")).not.toContain("nothing of theirs was written");
  });

  test("a refused report with the same decisions already stored records them skipped and writes nothing; the line stays partial and exit 1", async () => {
    const t = tree({ report: REPORT, pool: POOL_CANONICAL, decisions: DECISIONS });
    root = t.root;
    await new PgReportStore(env.db, "local").writeReport("camp", THEIR_REPORT);
    await new PgDecisionStore(env.db, "local").writeDecisions("camp", DECISION_MAP, null);
    const before = await stored(env);
    const from = env.queries.length;
    const got = await apply(env, t.root, t.output, "r5a");
    expect(got.code).toBe(1);
    expect(got.lines[0]!.partial).toBe(true);
    expect(got.summary).toMatchObject({ created: 1, refused: 0, partial: true });
    expect(got.lines[0]!.rows).toEqual([
      expect.objectContaining({ kind: "report", status: "refused" }),
      expect.objectContaining({ kind: "pool", status: "written" }),
      { kind: "decisions", status: "skipped", revision: hashBytes(DECISIONS) },
    ]);
    expect(got.out).toContain("  decisions: skipped");
    expect(env.queries.slice(from).filter((text) => DECISION_WRITE.test(text))).toEqual([]);
    const after = await stored(env);
    expect(after.reports).toEqual(before.reports);
    expect(after.decisionSets).toEqual(before.decisionSets);
  });

  test("a refused report with different decisions already stored records them refused and leaves the stored decisions as they were", async () => {
    const t = tree({ report: REPORT, pool: POOL_CANONICAL, decisions: DECISIONS });
    root = t.root;
    await new PgReportStore(env.db, "local").writeReport("camp", THEIR_REPORT);
    const store = new PgDecisionStore(env.db, "local");
    await store.writeDecisions("camp", OTHER_DECISIONS, null);
    const stored0 = await store.readDecisions("camp");
    const from = env.queries.length;
    const got = await apply(env, t.root, t.output, "r5b");
    expect(got.code).toBe(1);
    expect(got.lines[0]!.partial).toBe(true);
    expect(got.lines[0]!.rows?.[2]).toEqual({
      kind: "decisions",
      status: "refused",
      reason: BLOCKED,
    });
    expect(env.queries.slice(from).filter((text) => DECISION_WRITE.test(text))).toEqual([]);
    expect(await store.readDecisions("camp")).toEqual(stored0);
  });

  test("a refused report with no decisions file writes the pool and names no decision row", async () => {
    const t = tree({ report: REPORT, pool: POOL_CANONICAL });
    root = t.root;
    // A different report is already stored for the slug.
    const theirs = '{"assets":["a run made after the switch"]}';
    await new PgReportStore(env.db, "local").writeReport("camp", theirs);
    const got = await apply(env, t.root, t.output, "r4b");
    expect(got.code).toBe(1);
    expect(got.lines[0]!.partial).toBe(true);
    expect(got.lines[0]!.rows?.map((row) => `${row.kind}:${row.status}`)).toEqual([
      "report:refused",
      "pool:written",
    ]);
    expect(got.lines[0]!.rows?.[0]?.reason).toMatch(
      /^a different report is already stored for camp/,
    );
  });

  test("a campaign with no report file still gets its decisions", async () => {
    const t = tree({ decisions: DECISIONS });
    root = t.root;
    const got = await apply(env, t.root, t.output, "r4");
    expect(got.code).toBe(0);
    expect(got.lines[0]!.rows).toEqual([
      { kind: "decisions", status: "written", revision: hashBytes(DECISIONS) },
    ]);
  });

  test("a report with a render path that cannot be used is stored, and the field is not a campaign refusal", async () => {
    const bad = Buffer.from('{"outputPath":"camp/gone.png"}', "utf8");
    const t = tree({ report: bad });
    root = t.root;
    const got = await apply(env, t.root, t.output, "r5");
    expect(got.code).toBe(0);
    expect(got.lines).toHaveLength(1);
    expect(got.lines[0]!.outcome).toBe("created");
    expect(got.lines[0]!.rows).toEqual([
      { kind: "report", status: "written", revision: hashBytes(bad) },
    ]);
    expect(got.summary).toMatchObject({ created: 1, refused: 0, partial: false });
  });

  test("a store that throws is that row failed: the rows before it stay recorded, the campaign keeps its ids, exit 1", async () => {
    const t = tree({ report: REPORT, pool: POOL_CANONICAL, decisions: DECISIONS });
    root = t.root;
    const digestFirst = (await replan(ctxWith(t.root, t.output))).digest;
    expect(digestFirst).toHaveLength(64);
    env.reinstall();
    setPoolStore(
      failOnNth(
        getPoolStore(importTenant("local")) as PoolStorePort & AssetStorePort,
        "readPool",
        1,
      ),
    );
    const out: string[] = [];
    const result = freshResult("r6");
    const code = await main(
      [
        "apply",
        "--project-root",
        t.root,
        "--output-root",
        t.output,
        "--switched-at",
        SWITCHED_AT,
        "--org",
        "local",
        "--expect",
        digestFirst,
        "--result",
        result,
      ],
      { stdout: (line) => out.push(line), stderr: () => {} },
    );
    expect(code).toBe(1);
    const line = readFileSync(result, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.kind === "campaign") as unknown as CampaignEntry;
    expect(line.outcome).toBe("created");
    expect(line.minted.campaignId).toBeDefined();
    expect(line.partial).toBe(true);
    expect(line.rows?.map((row) => `${row.kind}:${row.status}`)).toEqual([
      "report:written",
      "pool:failed",
    ]);
    expect(out.some((l) => l.startsWith("  pool: failed: "))).toBe(true);
    expect((await stored(env)).decisionSets).toEqual([]);
  });

  test("a row written for an unchanged campaign makes a run with a refused campaign exit 1, never 3", async () => {
    const t = tree({});
    root = t.root;
    expect((await apply(env, t.root, t.output, "r7a")).code).toBe(0);
    // After the first import: the campaign's report arrives, and a second
    // brief whose logo file does not exist (refused before any write).
    writeAt(t.output, "reports/camp.json", REPORT);
    writeBrief(t.root, "bad.yaml", {
      id: "bad",
      products: [
        {
          id: "p1",
          name: "P1",
          primaryColor: "#111111",
          logoPath: "assets/inputs/bad/missing.png",
        },
      ],
    });
    const got = await apply(env, t.root, t.output, "r7b");
    const camp = got.lines.find((line) => line.slug === "camp")!;
    expect(camp.outcome).toBe("unchanged");
    expect(camp.rows).toEqual([{ kind: "report", status: "written", revision: hashBytes(REPORT) }]);
    expect(got.summary).toMatchObject({
      created: 0,
      completed: 0,
      unchanged: 1,
      refused: 1,
      partial: false,
      rowsWritten: 1,
    });
    expect(got.code).toBe(1);
  });
});

describe("apply: importRowsStep", () => {
  test("a context without the reviewed hashes is an error, never a silent import", async () => {
    await expect(
      importRowsStep(ctxWith("/nowhere", "/nowhere"), { slug: "camp", sourcePath: "x" }),
    ).rejects.toThrow("no reviewed source hashes in the step context");
  });
});
