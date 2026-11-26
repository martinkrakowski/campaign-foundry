import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pg from "pg";
import { testServerConfig } from "../../db/__tests__/test-server-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient } from "../../db/sql-client.js";
import { PgPublishedClipStore, publishedClipLockName } from "../pg-published-clip-store.js";

/**
 * PGlite is one connection, so it cannot show that the per-key advisory lock
 * actually BLOCKS a second writer. This file does, over a two-connection pool:
 * while one connection holds the key's lock (as a public-media reconcile does
 * around its ledger check and removal), `record` must wait, and only then run
 * its object check and write. Skipped unless `TEST_DATABASE_URL` is set.
 */
const url = process.env.TEST_DATABASE_URL;

const sleep = (ms: number): Promise<"timeout"> =>
  new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), ms);
  });

describe.skipIf(!url)("PgPublishedClipStore.record per-key lock", () => {
  const schema = `pcl_test_${randomUUID().replaceAll("-", "_")}`;
  let db: SqlClient;

  beforeAll(async () => {
    const config = testServerConfig({ url, poolMax: "2" }, "TEST_DATABASE_URL");
    db = pgClient(
      config,
      (cfg) => new pg.Pool({ ...poolOptions(cfg), options: `-c search_path=${schema}` }),
    );
    await db.query(`create schema if not exists "${schema}"`);
    await migrate(db, await loadMigrations());
  });

  afterAll(async () => {
    await db.query(`drop schema if exists "${schema}" cascade`);
    await db.end();
  });

  test("record waits for a holder of the key's lock, then runs its object check", async () => {
    const campaignId = randomUUID();
    await db.query(
      `insert into campaign (id, org_id, slug) values ($1::uuid, 'local', 'lock-one')`,
      [campaignId],
    );
    const key = "local/aaa/0123.mp4";
    let announce!: () => void;
    const held = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        publishedClipLockName("local", key),
      ]);
      announce();
      await released;
    });
    await held;

    let checked = false;
    const recording = new PgPublishedClipStore(db).record(
      "local",
      campaignId,
      key,
      "https://pub/a.mp4",
      "0123",
      async () => {
        checked = true;
        return true;
      },
    );
    // While the lock is held, record neither checks the object nor writes.
    expect(await Promise.race([recording, sleep(400)])).toBe("timeout");
    expect(checked).toBe(false);

    release();
    await holder;
    await expect(recording).resolves.toBe("recorded");
    expect(checked).toBe(true);
  });
});
