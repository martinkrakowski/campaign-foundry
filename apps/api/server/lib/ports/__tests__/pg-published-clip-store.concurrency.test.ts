import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { testServerConfig } from "../../db/__tests__/test-server-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient } from "../../db/sql-client.js";
import {
  PgPublishedClipStore,
  PublishedClipRecordRefusedError,
  publishedClipLockName,
} from "../pg-published-clip-store.js";

/**
 * PGlite (every other database test) is one connection: it can prove a
 * record's sequential outcomes, but it cannot make a `record()` arrive at
 * Postgres while another transaction holds the lock it must wait on — neither
 * the per-key advisory lock a public-media reconcile holds, nor the campaign
 * row lock CFAR6-record's `for share` exists to survive. This file is the
 * proof against a real server, over an actual two-connection pool — skipped
 * unless `TEST_DATABASE_URL` is set (CI's `postgres:17` service), never
 * against a real database.
 *
 * It owns a schema it creates and drops, so it can run beside every other
 * test's own database (or its own re-run) without clashing on `campaign`,
 * `published_clip`, `org` or `schema_migrations`.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgPublishedClipStore.record under concurrency (CFAR6-record)", () => {
  const schema = `cfar6j_test_${randomUUID().replaceAll("-", "_")}`;
  let db: SqlClient;
  // The pool's two connections are busy — one in the tombstone transaction,
  // one in the racing `record()` — so lock-wait inspection runs on its own
  // client, never competing for a pooled connection.
  let observer: pg.Client;

  beforeAll(async () => {
    const config = testServerConfig({ url, poolMax: "2" }, "TEST_DATABASE_URL");
    // Every connection in the pool starts in this schema (a libpq startup
    // option, applied per connection — `search_path` cannot be set once for a
    // pool the way a single session could). `CREATE SCHEMA` itself is
    // unaffected by search_path, since it names the schema explicitly, so this
    // is safe to run before the schema exists.
    db = pgClient(
      config,
      (cfg) => new pg.Pool({ ...poolOptions(cfg), options: `-c search_path=${schema}` }),
    );
    observer = new pg.Client({ ...poolOptions(config), options: `-c search_path=${schema}` });
    await db.query(`create schema if not exists "${schema}"`);
    await migrate(db, await loadMigrations());
    await observer.connect();
  });

  afterAll(async () => {
    await observer.end();
    await db.query(`drop schema if exists "${schema}" cascade`);
    await db.end();
  });

  const seedCampaign = async (orgId: string, slug: string): Promise<string> => {
    await db.query("insert into org (id, name) values ($1, $2)", [orgId, "Cfar six j"]);
    const campaignId = randomUUID();
    await db.query(`insert into campaign (id, org_id, slug) values ($1::uuid, $2, $3)`, [
      campaignId,
      orgId,
      slug,
    ]);
    return campaignId;
  };

  /**
   * Positive proof that `record()`'s insert statement has reached Postgres and
   * is WAITING on a row lock: `pg_blocking_pids` names the holder of the lock
   * each blocked backend waits for. Without the `for share` in record()'s CTE
   * the insert never blocks, this never fires, and the deadline throws — so
   * the race is actually exercised, not merely slept past.
   */
  const waitUntilRecordIsBlocked = async (): Promise<void> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { rows } = await observer.query<{ n: number }>(
        `select count(*)::int as n
           from pg_stat_activity
          where cardinality(pg_blocking_pids(pid)) > 0
            and query ilike '%published_clip%'
            and pid <> pg_backend_pid()`,
      );
      if (rows[0]!.n > 0) return;
      if (Date.now() > deadline) {
        throw new Error(
          "record() never blocked on the tombstone's row lock: the for share is missing or never reached Postgres.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  test("record blocks on a concurrent for-update tombstone transaction and refuses once deleted_at commits", async () => {
    const orgId = `cfar6j-${randomUUID().slice(0, 18)}`;
    const campaignId = await seedCampaign(orgId, "cfar6j-one");

    // Connection 1: take the `for update` lock the tombstone transaction
    // takes, signal that it is held, then — only after the racing record has
    // been OBSERVED waiting on that lock at Postgres — tombstone and commit.
    let releaseLockHeld: () => void = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      releaseLockHeld = resolve;
    });
    let releaseTombstone: () => void = () => {};
    const recordIsBlocked = new Promise<void>((resolve) => {
      releaseTombstone = resolve;
    });
    const tombstone = db.transaction(async (tx) => {
      await tx.query(`select id from campaign where org_id = $1 and id = $2::uuid for update`, [
        orgId,
        campaignId,
      ]);
      releaseLockHeld();
      // Held until the test has seen connection 2's statement waiting on
      // this transaction's lock: without the `for share` in record()'s CTE
      // it would sail past, insert the row against the pre-tombstone
      // snapshot, and answer "recorded".
      await recordIsBlocked;
      await tx.query(`update campaign set deleted_at = now() where org_id = $1 and id = $2::uuid`, [
        orgId,
        campaignId,
      ]);
    });

    // Connection 2: the export's record, for the same org and campaign,
    // while the tombstone transaction is still uncommitted.
    let settled = false;
    const record = lockHeld.then(() =>
      new PgPublishedClipStore(db).record(
        orgId,
        campaignId,
        `${orgId}/aaa/0123.mp4`,
        "https://pub/aaa.mp4",
        "0123",
      ),
    );
    record.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await waitUntilRecordIsBlocked();
    // The observation is the proof: record() is sitting on the row lock the
    // tombstone holds, so it cannot possibly have resolved (and the tombstone
    // has not committed) before the lock's fate decides the race.
    expect(settled).toBe(false);
    releaseTombstone();

    await expect(record).rejects.toBeInstanceOf(PublishedClipRecordRefusedError);
    await tombstone;

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from published_clip where org_id = $1`,
      [orgId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  test("record waits for a holder of the key's lock, then runs its object check", async () => {
    const orgId = `cfar6j-lock-${randomUUID().slice(0, 18)}`;
    const campaignId = await seedCampaign(orgId, "lock-one");
    const key = `${orgId}/aaa/0123.mp4`;
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
        publishedClipLockName(orgId, key),
      ]);
      announce();
      await released;
    });
    await held;

    let checked = false;
    const recording = new PgPublishedClipStore(db).record(
      orgId,
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
    expect(
      await Promise.race([
        recording,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 400)),
      ]),
    ).toBe("timeout");
    expect(checked).toBe(false);

    release();
    await holder;
    await expect(recording).resolves.toBe("recorded");
    expect(checked).toBe(true);
  });
});
