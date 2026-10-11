import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hashBytes } from "../../brief-files.js";
import type { DecisionStorePort } from "../../ports/decision-store.port.js";
import { PgDecisionStore } from "../../ports/pg-decision-store.js";
import { PgPoolStore } from "../../ports/pg-pool-store.js";
import type { PoolStorePort } from "../../ports/pool-store.port.js";
import { importDecisions, importDecisionsRow, importPool, importPoolRow } from "../rows-step.js";
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
async function poolRow(
  env: Env,
): Promise<{ body: string; revision: string; at: string } | undefined> {
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

  /** The store as a writer that read "nothing stored" just before another writer stored a pool. */
  const readsNothing = (): PoolStorePort =>
    Object.create(pools, { readPool: { value: async () => undefined } }) as PoolStorePort;

  test("a pool stored between the read and the write is refused and left as it was", async () => {
    await pools.writePool({ ...POOL, model: "a user edited this pool after the switch" } as never);
    const before = await poolRow(env);
    const result = await importPoolRow(readsNothing(), "camp", CANONICAL);
    expect(result).toEqual({
      kind: "pool",
      status: "refused",
      reason: `a different pool is already stored for camp (revision ${before?.revision})`,
    });
    expect(await poolRow(env)).toEqual(before);
  });

  test("the same pool stored between the read and the write is skipped and not rewritten", async () => {
    await pools.writePool(POOL as never);
    const before = await poolRow(env);
    const result = await importPoolRow(readsNothing(), "camp", HAND_EDITED);
    expect(result).toEqual({
      kind: "pool",
      status: "skipped",
      revision: hashBytes(CANONICAL),
      recanonicalised: true,
    });
    expect(await poolRow(env)).toEqual(before);
  });

  test("a pool store failure that is not a conflict is thrown, not turned into a refusal", async () => {
    const broken = Object.create(pools, {
      writePool: {
        value: async () => {
          throw new Error("the pool store went away");
        },
      },
    }) as PoolStorePort;
    await expect(importPoolRow(broken, "camp", CANONICAL)).rejects.toThrow(
      "the pool store went away",
    );
  });

  test("a file that is not JSON, not a pool, or another campaign's pool is refused and nothing is written", async () => {
    const notJson = await importPoolRow(pools, "camp", Buffer.from("{", "utf8"));
    expect(notJson.status).toBe("refused");
    expect(notJson.reason).toMatch(/^briefs\/camp\/pools\.json is not JSON \(/);
    const notPool = await importPoolRow(pools, "camp", Buffer.from('{"entries":[]}', "utf8"));
    expect(notPool).toEqual({
      kind: "pool",
      status: "refused",
      reason: "briefId must be a string",
    });
    const other = Buffer.from(JSON.stringify({ ...POOL, briefId: "other" }), "utf8");
    expect(await importPoolRow(pools, "camp", other)).toEqual({
      kind: "pool",
      status: "refused",
      reason: 'pools.json names briefId "other", not "camp"',
    });
    expect(await poolRow(env)).toBeUndefined();
  });

  test("a pool file that is not valid UTF-8 is refused and nothing is written", async () => {
    const head = Buffer.from(
      '{"briefId":"camp","generatedAt":"2026-09-01T10:00:00.000Z","model":"a-mod',
      "utf8",
    );
    const tail = Buffer.from('el","entries":[]}', "utf8");
    const broken = Buffer.concat([head, Buffer.from([0xff]), tail]);
    expect(await importPoolRow(pools, "camp", broken)).toEqual({
      kind: "pool",
      status: "refused",
      reason: "briefs/camp/pools.json is not valid UTF-8",
    });
    expect(await poolRow(env)).toBeUndefined();
  });
});

const DECISIONS = {
  "camp/a.png": { verdict: "approved", actor: "ana", at: "2026-09-01T10:00:00.000Z", run: "r1" },
  "camp/b.png": { verdict: "rejected", actor: "ben", at: "2026-09-02T11:30:00.000Z", run: "r1" },
};
const DEC_CANONICAL = Buffer.from(`${JSON.stringify(DECISIONS, null, 2)}\n`, "utf8");
const DEC_HAND = Buffer.from(JSON.stringify(DECISIONS), "utf8");

/** What is stored for `camp`: the set's revision and each decision's key and actor, in order. */
async function decisionRows(env: Env): Promise<{ revision: string | undefined; actors: string[] }> {
  const set = await env.db.query<{ revision: string }>(
    "select revision from decision_set where org_id = $1 and campaign_id = $2",
    ["local", "camp"],
  );
  const rows = await env.db.query<{ asset_key: string; actor: string }>(
    "select asset_key, actor from decision where org_id = $1 and campaign_id = $2 order by ordinal",
    ["local", "camp"],
  );
  return {
    revision: set.rows[0]?.revision,
    actors: rows.rows.map((r) => `${r.asset_key}=${r.actor}`),
  };
}

describe.skipIf(ON_A_REAL_TEST_SERVER)("rows-step: importDecisionsRow", () => {
  let env: Env;
  let decisions: DecisionStorePort;
  beforeEach(async () => {
    env = await useApplyEnvironment();
    decisions = new PgDecisionStore(env.db, "local");
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("decisions are written with the recorded actors and the canonical revision", async () => {
    const result = await importDecisionsRow(decisions, "camp", DEC_CANONICAL);
    expect(result).toEqual({
      kind: "decisions",
      status: "written",
      revision: hashBytes(DEC_CANONICAL),
    });
    expect(await decisionRows(env)).toEqual({
      revision: hashBytes(DEC_CANONICAL),
      actors: ["camp/a.png=ana", "camp/b.png=ben"],
    });
  });

  test("a hand-formatted decisions file gets the canonical revision and no extra flag", async () => {
    const result = await importDecisionsRow(decisions, "camp", DEC_HAND);
    expect(result).toEqual({
      kind: "decisions",
      status: "written",
      revision: hashBytes(DEC_CANONICAL),
    });
    expect((await decisionRows(env)).revision).toBe(hashBytes(DEC_CANONICAL));
  });

  test("a second import of the same decisions is skipped and nothing is touched", async () => {
    await importDecisionsRow(decisions, "camp", DEC_HAND);
    const before = await decisionRows(env);
    const result = await importDecisionsRow(decisions, "camp", DEC_HAND);
    expect(result).toEqual({
      kind: "decisions",
      status: "skipped",
      revision: hashBytes(DEC_CANONICAL),
    });
    expect(await decisionRows(env)).toEqual(before);
  });

  test("different stored decisions are refused and left as they were", async () => {
    await decisions.writeDecisions("camp", {
      "camp/a.png": {
        verdict: "rejected",
        actor: "a user",
        at: "2026-10-05T09:00:00.000Z",
        run: "r2",
      },
    });
    const before = await decisionRows(env);
    const result = await importDecisionsRow(decisions, "camp", DEC_CANONICAL);
    expect(result).toEqual({
      kind: "decisions",
      status: "refused",
      reason: `different decisions are already stored for camp (revision ${before.revision})`,
    });
    expect(await decisionRows(env)).toEqual(before);
  });

  test("a file that is not JSON, not a decision map, or has a hand-typed time is refused", async () => {
    const notJson = await importDecisionsRow(decisions, "camp", Buffer.from("[", "utf8"));
    expect(notJson.reason).toMatch(/^decisions\/camp\.json is not JSON \(/);
    expect(await importDecisionsRow(decisions, "camp", Buffer.from("[]", "utf8"))).toEqual({
      kind: "decisions",
      status: "refused",
      reason: "the decisions must be an object keyed by review key.",
    });
    const badTime = { "camp/a.png": { ...DECISIONS["camp/a.png"], at: "2026-09-01 10:00" } };
    expect(
      await importDecisionsRow(decisions, "camp", Buffer.from(JSON.stringify(badTime), "utf8")),
    ).toEqual({
      kind: "decisions",
      status: "refused",
      reason:
        'the decision for "camp/a.png" has a time that is not the ISO instant the server stamps: "2026-09-01 10:00"',
    });
    expect((await decisionRows(env)).revision).toBeUndefined();
  });

  test("a store failure that is not a conflict is thrown, not turned into a refusal", async () => {
    const failing = {
      writeDecisions: async () => {
        throw new Error("the database went away");
      },
    } as unknown as DecisionStorePort;
    await expect(importDecisionsRow(failing, "camp", DEC_CANONICAL)).rejects.toThrow(
      "the database went away",
    );
  });

  test.each(["key", "actor", "run"] as const)(
    "a decisions file with a NUL character in the %s of a decision is refused and nothing is sent to the store",
    async (field) => {
      const nul = String.fromCharCode(0);
      const map = {
        [field === "key" ? `camp/a${nul}.png` : "camp/a.png"]: {
          verdict: "approved",
          actor: field === "actor" ? `an${nul}a` : "ana",
          at: "2026-09-01T10:00:00.000Z",
          run: field === "run" ? `r${nul}1` : "r1",
        },
      };
      const bytes = Buffer.from(JSON.stringify(map), "utf8");
      const from = env.queries.length;
      expect(await importDecisionsRow(decisions, "camp", bytes)).toEqual({
        kind: "decisions",
        status: "refused",
        reason: `decisions/camp.json: the decision for ${JSON.stringify(Object.keys(map)[0])} has the character U+0000 in its ${field}, which the database cannot store`,
      });
      expect(env.queries.slice(from)).toEqual([]);
      expect((await decisionRows(env)).revision).toBeUndefined();
    },
  );

  test("a decisions file that is not valid UTF-8 is refused and nothing is written", async () => {
    const head = Buffer.from('{"camp/a.png":{"verdict":"approved","actor":"an', "utf8");
    const tail = Buffer.from('a","at":"2026-09-01T10:00:00.000Z","run":"r1"}}', "utf8");
    const broken = Buffer.concat([head, Buffer.from([0xff]), tail]);
    expect(await importDecisionsRow(decisions, "camp", broken)).toEqual({
      kind: "decisions",
      status: "refused",
      reason: "decisions/camp.json is not valid UTF-8",
    });
    expect((await decisionRows(env)).revision).toBeUndefined();
  });
});

describe.skipIf(ON_A_REAL_TEST_SERVER)("rows-step: pool and decisions from disk", () => {
  let env: Env;
  let root: string;
  beforeEach(async () => {
    env = await useApplyEnvironment();
    root = makeRoot();
  });
  afterEach(async () => {
    dropRoot(root);
    await restoreApplyEnvironment();
  });

  test("a campaign with neither file imports neither row", async () => {
    const source = {
      projectRoot: root,
      outputRoot: root,
      expectedHashes: new Map<string, string>(),
    };
    expect(await importPool(new PgPoolStore(env.db, "local"), source, "camp")).toBeUndefined();
    expect(
      await importDecisions(new PgDecisionStore(env.db, "local"), source, "camp"),
    ).toBeUndefined();
  });

  test("a pool or decisions file changed since the digest is refused and nothing is written", async () => {
    writeAt(root, "briefs/camp/pools.json", HAND_EDITED);
    writeAt(root, "decisions/camp.json", DEC_HAND);
    const stale = new Map([
      ["briefs/camp/pools.json", hashBytes(CANONICAL)],
      ["decisions/camp.json", hashBytes(DEC_CANONICAL)],
    ]);
    const source = { projectRoot: root, outputRoot: root, expectedHashes: stale };
    expect(await importPool(new PgPoolStore(env.db, "local"), source, "camp")).toEqual({
      kind: "pool",
      status: "refused",
      reason: "briefs/camp/pools.json changed since the digest",
    });
    expect(await importDecisions(new PgDecisionStore(env.db, "local"), source, "camp")).toEqual({
      kind: "decisions",
      status: "refused",
      reason: "decisions/camp.json changed since the digest",
    });
    expect(await poolRow(env)).toBeUndefined();
    expect((await decisionRows(env)).revision).toBeUndefined();
  });

  test("the reviewed pool and decisions files are written", async () => {
    writeAt(root, "briefs/camp/pools.json", HAND_EDITED);
    writeAt(root, "decisions/camp.json", DEC_CANONICAL);
    const reviewed = new Map([
      ["briefs/camp/pools.json", hashBytes(HAND_EDITED)],
      ["decisions/camp.json", hashBytes(DEC_CANONICAL)],
    ]);
    const source = { projectRoot: root, outputRoot: root, expectedHashes: reviewed };
    expect(await importPool(new PgPoolStore(env.db, "local"), source, "camp")).toEqual({
      kind: "pool",
      status: "written",
      revision: hashBytes(CANONICAL),
      recanonicalised: true,
    });
    expect(await importDecisions(new PgDecisionStore(env.db, "local"), source, "camp")).toEqual({
      kind: "decisions",
      status: "written",
      revision: hashBytes(DEC_CANONICAL),
    });
  });
});
