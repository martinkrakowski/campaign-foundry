import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hashBytes } from "../../brief-files.js";
import type { DecisionStorePort } from "../../ports/decision-store.port.js";
import { PgDecisionStore } from "../../ports/pg-decision-store.js";
import { PgPoolStore } from "../../ports/pg-pool-store.js";
import type { PoolStorePort } from "../../ports/pool-store.port.js";
import { importPoolRow, importReport } from "../rows-step.js";
import {
  ON_A_REAL_TEST_SERVER,
  restoreApplyEnvironment,
  useApplyEnvironment,
} from "./fixtures/apply-harness.js";
import { dropRoot, makeRoot, writeAt } from "./fixtures/tree.js";

type Env = Awaited<ReturnType<typeof useApplyEnvironment>>;

const POOL = {
  briefId: "camp",
  generatedAt: "2026-09-01T10:00:00.000Z",
  model: "a-model",
  entries: [{ id: "e1", text: "Fresh every day", status: "approved" }],
};
/** The bytes the store itself keeps: the canonical form. */
const CANONICAL = Buffer.from(`${JSON.stringify(POOL, null, 2)}\n`, "utf8");
/** The same pool as a hand left it: one line, no trailing newline. */
const HAND_EDITED = Buffer.from(JSON.stringify(POOL), "utf8");

/** The stored pool row for `camp`, read straight from the table. */
async function poolRow(env: Env): Promise<{ body: string; revision: string; at: string } | undefined> {
  const { rows } = await env.db.query<{ body: string; revision: string; at: string }>(
    "select body, revision, updated_at::text as at from pool where org_id = $1 and campaign_id = $2",
    ["local", "camp"],
  );
  return rows[0];
}

describe.skipIf(ON_A_REAL_TEST_SERVER)("rows-step: importPoolRow", () => {
  let env: Env;
  let pools: PoolStorePort;
  beforeEach(async () => {
    env = await useApplyEnvironment();
    pools = new PgPoolStore(env.db, "local");
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("a canonical pool file keeps its revision", async () => {
    const result = await importPoolRow(pools, "camp", CANONICAL);
    expect(result).toEqual({ kind: "pool", status: "written", revision: hashBytes(CANONICAL) });
    expect((await poolRow(env))?.revision).toBe(hashBytes(CANONICAL));
  });

  test("a hand-edited pool file is stored in the canonical form and says so", async () => {
    const result = await importPoolRow(pools, "camp", HAND_EDITED);
    expect(result).toEqual({
      kind: "pool",
      status: "written",
      revision: hashBytes(CANONICAL),
      recanonicalised: true,
    });
    expect((await poolRow(env))?.body).toBe(CANONICAL.toString("utf8"));
  });

  test("a second import of a hand-edited pool is skipped and the row is not touched", async () => {
    await importPoolRow(pools, "camp", HAND_EDITED);
    const before = await poolRow(env);
    const result = await importPoolRow(pools, "camp", HAND_EDITED);
    expect(result).toEqual({
      kind: "pool",
      status: "skipped",
      revision: hashBytes(CANONICAL),
      recanonicalised: true,
    });
    expect(await poolRow(env)).toEqual(before);
  });

  test("a different stored pool is refused and left as it was", async () => {
    await pools.writePool({ ...POOL, model: "a user edited this pool after the switch" } as never);
    const before = await poolRow(env);
    const result = await importPoolRow(pools, "camp", CANONICAL);
    expect(result).toEqual({
      kind: "pool",
      status: "refused",
      reason: `a different pool is already stored for camp (revision ${before?.revision})`,
    });
    expect(await poolRow(env)).toEqual(before);
  });

  test("a file that is not JSON, not a pool, or another campaign's pool is refused and nothing is written", async () => {
    const notJson = await importPoolRow(pools, "camp", Buffer.from("{", "utf8"));
    expect(notJson.status).toBe("refused");
    expect(notJson.reason).toMatch(/^briefs\/camp\/pools\.json is not JSON \(/);
    const notPool = await importPoolRow(pools, "camp", Buffer.from('{"entries":[]}', "utf8"));
    expect(notPool).toEqual({ kind: "pool", status: "refused", reason: "briefId must be a string" });
    const other = Buffer.from(JSON.stringify({ ...POOL, briefId: "other" }), "utf8");
    expect(await importPoolRow(pools, "camp", other)).toEqual({
      kind: "pool",
      status: "refused",
      reason: 'pools.json names briefId "other", not "camp"',
    });
    expect(await poolRow(env)).toBeUndefined();
  });
});
