import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SqlClient, SqlQuery } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { eraseUser, repairErasedActor, countActorRows, finishErasure } from "../erase-user.js";
import type { ActorCounts, EraseUserOutcome } from "../erase-user.js";
import {
  ACME_OWNER,
  BYSTANDER,
  TARGET,
  dumpDatabase,
  rowsContaining,
  seedWorld,
} from "./erase-user-fixtures.js";
import type { World } from "./erase-user-fixtures.js";

/** Insert one surviving row per actor column, all carrying `TARGET.id`. */
async function insertSurvivors(db: SqlClient, world: World): Promise<void> {
  await db.query(
    `insert into brief_version (campaign_id, version, body, revision, actor) values ($1, 3, '{}', 'r2', $2)`,
    [world.localCampaignId, TARGET.id],
  );
  await db.query(
    `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run) values ($1, $2, $3, 1, 'approved', $4, now(), 'run-2')`,
    ["local", world.localCampaignId, "ak-survivor", TARGET.id],
  );
  await db.query(
    `insert into provider_key (org_id, provider, ciphertext, iv, tag, sealed_dek, dek_iv, dek_tag, kek_version, last4, created_by) values ('local', 'firefly', 'ct', 'iv', 'tag', 'dek', 'div', 'dtag', 'v1', 'abcd', $1)`,
    [TARGET.id],
  );
  await db.query(
    `insert into campaign (org_id, slug, deleted_at, deleted_by) values ('local', 'c-survivor', now(), $1)`,
    [TARGET.id],
  );
  await db.query(
    `insert into deletion (org_id, kind, subject, requested_by, not_before) values ('local', 'campaign', 'survivor-subject', $1, now())`,
    [TARGET.id],
  );
}

/** Proxy: after `transaction` resolves, insert surviving rows, then return. */
function withPostCommitInserts(db: SqlClient, world: World): SqlClient {
  const originalTransaction = db.transaction.bind(db);
  return {
    ...db,
    transaction: async <T>(work: (tx: SqlQuery) => Promise<T>): Promise<T> => {
      const result = await originalTransaction(work);
      await insertSurvivors(db, world);
      return result;
    },
  };
}

/** Proxy: when the countActorRows select is about to run, insert one row first. */
function withInsertOnCount(db: SqlClient, insert: () => Promise<void>): SqlClient {
  return {
    ...db,
    query: async <R = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<{ rows: R[] }> => {
      if (text.includes('as "briefVersions"')) await insert();
      return db.query<R>(text, params);
    },
  };
}

/** Proxy: count how many `update` statements are issued through `query`. */
function withUpdateCounter(db: SqlClient): { client: SqlClient; count: () => number } {
  let n = 0;
  const client: SqlClient = {
    ...db,
    query: async <R = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<{ rows: R[] }> => {
      if (text.trim().startsWith("update")) n++;
      return db.query<R>(text, params);
    },
  };
  return { client, count: () => n };
}

describe("eraseUser pass two (PT-9l3)", () => {
  let db: SqlClient;
  let world: World;

  beforeEach(async () => {
    db = await migratedDatabase();
    world = await seedWorld(db);
  }, 30_000);

  afterEach(async () => {
    await db.end();
  });

  test("pass two repairs rows written between the commit and the repair", async () => {
    const proxy = withPostCommitInserts(db, world);
    const outcome = await eraseUser(proxy, { userId: TARGET.id }, { apply: true });
    expect(outcome.outcome).toBe("erased");
    if (outcome.outcome !== "erased") throw new Error("expected erased");

    expect(outcome.repaired).toEqual({
      briefVersions: 1,
      decisions: 1,
      providerKeys: 1,
      campaignsDeletedBy: 1,
      deletionsRequestedBy: 1,
    });
    expect(outcome.remaining).toEqual({
      briefVersions: 0,
      decisions: 0,
      providerKeys: 0,
      campaignsDeletedBy: 0,
      deletionsRequestedBy: 0,
    });

    // Pass one and pass two use the same token: read a row repaired in pass one
    // (brief_version v1) and a row repaired in pass two (v3) and compare.
    const { rows: passOne } = await db.query<{ actor: string }>(
      `select actor from brief_version where campaign_id = $1 and version = 1`,
      [world.localCampaignId],
    );
    const { rows: passTwo } = await db.query<{ actor: string }>(
      `select actor from brief_version where campaign_id = $1 and version = 3`,
      [world.localCampaignId],
    );
    expect(passOne[0]!.actor).toBe(outcome.token);
    expect(passTwo[0]!.actor).toBe(outcome.token);
    expect(passOne[0]!.actor).toBe(passTwo[0]!.actor);
  });

  test("pass two repairs each column alone for briefVersions", async () => {
    const column = "briefVersions" as const;
    const proxy = {
      ...db,
      transaction: async <T>(work: (tx: SqlQuery) => Promise<T>): Promise<T> => {
        const result = await db.transaction(work);
        await db.query(
          `insert into brief_version (campaign_id, version, body, revision, actor) values ($1, 3, '{}', 'r2', $2)`,
          [world.localCampaignId, TARGET.id],
        );
        return result;
      },
    };
    const outcome = await eraseUser(proxy, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");
    expect(outcome.repaired[column]).toBe(1);
    for (const k of [
      "decisions",
      "providerKeys",
      "campaignsDeletedBy",
      "deletionsRequestedBy",
    ] as const) {
      expect(outcome.repaired[k]).toBe(0);
    }
  });

  test("pass two repairs each column alone for decisions", async () => {
    const proxy = {
      ...db,
      transaction: async <T>(work: (tx: SqlQuery) => Promise<T>): Promise<T> => {
        const result = await db.transaction(work);
        await db.query(
          `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run) values ($1, $2, $3, 1, 'approved', $4, now(), 'run-2')`,
          ["local", world.localCampaignId, "ak-survivor", TARGET.id],
        );
        return result;
      },
    };
    const outcome = await eraseUser(proxy, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");
    expect(outcome.repaired.decisions).toBe(1);
    expect(outcome.repaired.briefVersions).toBe(0);
    expect(outcome.repaired.providerKeys).toBe(0);
    expect(outcome.repaired.campaignsDeletedBy).toBe(0);
    expect(outcome.repaired.deletionsRequestedBy).toBe(0);
  });

  test("pass two repairs each column alone for providerKeys", async () => {
    const proxy = {
      ...db,
      transaction: async <T>(work: (tx: SqlQuery) => Promise<T>): Promise<T> => {
        const result = await db.transaction(work);
        await db.query(
          `insert into provider_key (org_id, provider, ciphertext, iv, tag, sealed_dek, dek_iv, dek_tag, kek_version, last4, created_by) values ('local', 'firefly', 'ct', 'iv', 'tag', 'dek', 'div', 'dtag', 'v1', 'abcd', $1)`,
          [TARGET.id],
        );
        return result;
      },
    };
    const outcome = await eraseUser(proxy, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");
    expect(outcome.repaired.providerKeys).toBe(1);
    expect(outcome.repaired.briefVersions).toBe(0);
    expect(outcome.repaired.decisions).toBe(0);
    expect(outcome.repaired.campaignsDeletedBy).toBe(0);
    expect(outcome.repaired.deletionsRequestedBy).toBe(0);
  });

  test("pass two repairs each column alone for campaignsDeletedBy", async () => {
    const proxy = {
      ...db,
      transaction: async <T>(work: (tx: SqlQuery) => Promise<T>): Promise<T> => {
        const result = await db.transaction(work);
        await db.query(
          `insert into campaign (org_id, slug, deleted_at, deleted_by) values ('local', 'c-survivor', now(), $1)`,
          [TARGET.id],
        );
        return result;
      },
    };
    const outcome = await eraseUser(proxy, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");
    expect(outcome.repaired.campaignsDeletedBy).toBe(1);
    expect(outcome.repaired.briefVersions).toBe(0);
    expect(outcome.repaired.decisions).toBe(0);
    expect(outcome.repaired.providerKeys).toBe(0);
    expect(outcome.repaired.deletionsRequestedBy).toBe(0);
  });

  test("pass two repairs each column alone for deletionsRequestedBy", async () => {
    const proxy = {
      ...db,
      transaction: async <T>(work: (tx: SqlQuery) => Promise<T>): Promise<T> => {
        const result = await db.transaction(work);
        await db.query(
          `insert into deletion (org_id, kind, subject, requested_by, not_before) values ('local', 'campaign', 'survivor-subject', $1, now())`,
          [TARGET.id],
        );
        return result;
      },
    };
    const outcome = await eraseUser(proxy, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");
    expect(outcome.repaired.deletionsRequestedBy).toBe(1);
    expect(outcome.repaired.briefVersions).toBe(0);
    expect(outcome.repaired.decisions).toBe(0);
    expect(outcome.repaired.providerKeys).toBe(0);
    expect(outcome.repaired.campaignsDeletedBy).toBe(0);
  });

  test("a row written AFTER pass two is counted and reported, not repaired", async () => {
    const proxy = withInsertOnCount(db, async () => {
      await db.query(
        `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run) values ($1, $2, $3, 1, 'approved', $4, now(), 'run-3')`,
        ["local", world.localCampaignId, "ak-after-scan", TARGET.id],
      );
    });
    const outcome = await eraseUser(proxy, { userId: TARGET.id }, { apply: true });
    expect(outcome.outcome).toBe("erased");
    if (outcome.outcome !== "erased") throw new Error("expected erased");

    expect(outcome.remaining).toEqual({
      briefVersions: 0,
      decisions: 1,
      providerKeys: 0,
      campaignsDeletedBy: 0,
      deletionsRequestedBy: 0,
    });

    // The surviving row still holds the raw id — pass two never saw it.
    const { rows } = await db.query<{ actor: string }>(
      `select actor from decision where asset_key = $1`,
      ["ak-after-scan"],
    );
    expect(rows[0]!.actor).toBe(TARGET.id);
  });

  test("pass two touches only the erased user, not another user or org", async () => {
    const beforeBystander = await rowsContaining(db, BYSTANDER.id);
    const beforeAcme = await rowsContaining(db, ACME_OWNER.id);

    const proxy = withPostCommitInserts(db, world);
    await eraseUser(proxy, { userId: TARGET.id }, { apply: true });

    expect(await rowsContaining(db, BYSTANDER.id)).toEqual(beforeBystander);
    expect(await rowsContaining(db, ACME_OWNER.id)).toEqual(beforeAcme);
  });

  test("repairErasedActor is idempotent: a second run returns five zeros and changes nothing", async () => {
    const outcome = await eraseUser(db, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");
    const { token } = outcome;

    await insertSurvivors(db, world);
    await repairErasedActor(db, TARGET.id, token);

    const before = await dumpDatabase(db);
    const second = await repairErasedActor(db, TARGET.id, token);
    expect(second).toEqual({
      briefVersions: 0,
      decisions: 0,
      providerKeys: 0,
      campaignsDeletedBy: 0,
      deletionsRequestedBy: 0,
    });
    expect(await dumpDatabase(db)).toEqual(before);
  });

  test("a dry run runs neither pass: no update statements, no repaired/remaining keys", async () => {
    const { client, count } = withUpdateCounter(db);
    const outcome = await eraseUser(client, { userId: TARGET.id }, { apply: false });
    expect(count()).toBe(0);

    expect(outcome.outcome).toBe("planned");
    const json = JSON.stringify(outcome);
    expect(json).not.toContain("repaired");
    expect(json).not.toContain("remaining");
    expect("repaired" in outcome).toBe(false);
    expect("remaining" in outcome).toBe(false);
  });
});

describe("finishErasure (PT-9l3)", () => {
  let db: SqlClient;
  let world: World;

  beforeEach(async () => {
    db = await migratedDatabase();
    world = await seedWorld(db);
  }, 30_000);

  afterEach(async () => {
    await db.end();
  });

  async function erasedToken(): Promise<string> {
    const outcome = await eraseUser(db, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");
    return outcome.token;
  }

  test("finishErasure repairs a planted surviving row and returns remaining all zero", async () => {
    const token = await erasedToken();
    await insertSurvivors(db, world);

    const result = await finishErasure(db, TARGET.id, token);
    expect(result.repaired).toEqual({
      briefVersions: 1,
      decisions: 1,
      providerKeys: 1,
      campaignsDeletedBy: 1,
      deletionsRequestedBy: 1,
    });
    expect(result.remaining).toEqual({
      briefVersions: 0,
      decisions: 0,
      providerKeys: 0,
      campaignsDeletedBy: 0,
      deletionsRequestedBy: 0,
    });

    const { rows } = await db.query<{ actor: string }>(
      `select actor from decision where asset_key = $1`,
      ["ak-survivor"],
    );
    expect(rows[0]!.actor).toBe(token);
  });

  test("finishErasure throws 'not an erasure token' when the token has no deletion row", async () => {
    const token = `erased:00000000-0000-4000-8000-000000000000`;
    const before = await dumpDatabase(db);

    await expect(finishErasure(db, TARGET.id, token)).rejects.toThrow(
      "erase: that token is not an erasure token.",
    );
    expect(await dumpDatabase(db)).toEqual(before);
  });

  test("finishErasure throws on a malformed token: 'erased:'", async () => {
    await expect(finishErasure(db, TARGET.id, "erased:")).rejects.toThrow(
      "erase: that token is not an erasure token.",
    );
  });

  test("finishErasure throws on a malformed token: 'erased:not-a-uuid'", async () => {
    await expect(finishErasure(db, TARGET.id, "erased:not-a-uuid")).rejects.toThrow(
      "erase: that token is not an erasure token.",
    );
  });

  test("finishErasure throws on a malformed token: bare uuid", async () => {
    await expect(
      finishErasure(db, TARGET.id, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow("erase: that token is not an erasure token.");
  });

  test("finishErasure refuses to run when the user still exists, even with a real token", async () => {
    const token = await erasedToken();
    // TARGET was erased, but BYSTANDER still exists.
    const before = await dumpDatabase(db);
    await expect(finishErasure(db, BYSTANDER.id, token)).rejects.toThrow(
      "erase: that user still exists; run a normal erasure.",
    );
    expect(await dumpDatabase(db)).toEqual(before);
  });
});

describe("repairErasedActor standalone (PT-9l3)", () => {
  test("returns five zeros and changes nothing when nothing survives", async () => {
    const db = await migratedDatabase();
    const world = await seedWorld(db);
    const outcome = await eraseUser(db, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");

    const before = await dumpDatabase(db);
    const result = await repairErasedActor(db, TARGET.id, outcome.token);
    expect(result).toEqual({
      briefVersions: 0,
      decisions: 0,
      providerKeys: 0,
      campaignsDeletedBy: 0,
      deletionsRequestedBy: 0,
    });
    expect(await dumpDatabase(db)).toEqual(before);
    await db.end();
  }, 30_000);

  test("countActorRows returns all zeros after a clean erasure", async () => {
    const db = await migratedDatabase();
    await seedWorld(db);
    const outcome = await eraseUser(db, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");

    const remaining = await countActorRows(db, TARGET.id);
    expect(remaining).toEqual({
      briefVersions: 0,
      decisions: 0,
      providerKeys: 0,
      campaignsDeletedBy: 0,
      deletionsRequestedBy: 0,
    });
    await db.end();
  }, 30_000);
});
