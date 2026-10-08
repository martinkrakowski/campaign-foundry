import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import pg from "pg";
import { testServerConfig } from "../../db/__tests__/test-server-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient, SqlQuery } from "../../db/sql-client.js";
import { PgBriefStore } from "../pg-brief-store.js";
import { requestOrgDeletion } from "../../deletion/purge-org.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)(
  "PgBriefStore org tombstone lock (FU-purge-org-hardening, W1 concurrency)",
  () => {
    const schema = `fuorglock_${randomUUID().replaceAll("-", "_")}`;
    let db: SqlClient;

    beforeAll(async () => {
      const config = testServerConfig({ url, poolMax: "3" }, "TEST_DATABASE_URL");
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

    beforeEach(async () => {
      await db.query(`delete from deletion where org_id = 'acme'`);
      await db.query(`delete from campaign where org_id = 'acme'`);
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from org where id = 'acme'`,
      );
      if (rows[0]!.n > 0) {
        await db.query(`update org set deleted_at = null where id = 'acme'`);
      } else {
        await db.query(`insert into org (id, name, slug) values ($1, $2, $1)`, ["acme", "Acme"]);
      }
    });

    // Tests 6-8 share the reasoning: both statements run on `tx` inside
    // `db.transaction`, so a `query` wrapper on `db` itself never sees them.
    // Blocking is proven by `nowait` probes (SQLSTATE 55P03) and by awaiting
    // both promises — no sleep, no polling.

    test("two creates in a live org do not block each other", async () => {
      let paused = false;
      let announce!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        announce = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });

      const wrapped: SqlClient = {
        ...db,
        transaction: (work) =>
          db.transaction((tx) => {
            const intercept: SqlQuery = {
              ...tx,
              query: async <R>(text: string, params?: readonly unknown[]) => {
                if (!paused && text.includes("insert into campaign")) {
                  paused = true;
                  announce();
                  await released;
                }
                return tx.query<R>(text, params);
              },
            };
            return work(intercept);
          }),
      };

      const store1 = new PgBriefStore(wrapped, "acme", "u1");
      const store2 = new PgBriefStore(db, "acme", "u2");

      // C1 pauses AFTER assertOrgLive has taken the FOR SHARE on the org row.
      const c1 = store1.createCampaign("a");
      c1.catch(() => undefined);
      await lockTaken;

      try {
        // C2 must not block: FOR SHARE is compatible with itself.
        await store2.createCampaign("b");

        release();
        await c1;

        const { rows } = await db.query<{ n: number }>(
          `select count(*)::int as n from campaign where org_id = 'acme'`,
        );
        expect(rows[0]!.n).toBe(2);
      } finally {
        release();
        await c1.catch(() => undefined);
      }
    });

    test("an in-flight create holds the org row against a tombstone", async () => {
      let paused = false;
      let announce!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        announce = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });

      const wrapped: SqlClient = {
        ...db,
        transaction: (work) =>
          db.transaction((tx) => {
            const intercept: SqlQuery = {
              ...tx,
              query: async <R>(text: string, params?: readonly unknown[]) => {
                if (!paused && text.includes("insert into campaign")) {
                  paused = true;
                  announce();
                  await released;
                }
                return tx.query<R>(text, params);
              },
            };
            return work(intercept);
          }),
      };

      const store = new PgBriefStore(wrapped, "acme", "u1");
      const c1 = store.createCampaign("a");
      c1.catch(() => undefined);
      await lockTaken;

      try {
        // C1 holds FOR SHARE: FOR UPDATE NOWAIT must reject (conflict)
        await expect(
          db.query(`select 1 from org where id = $1 for update nowait`, ["acme"]),
        ).rejects.toMatchObject({ code: "55P03" });

        // FOR SHARE NOWAIT must succeed (compatible with itself)
        await db.query(`select 1 from org where id = $1 for share nowait`, ["acme"]);

        release();
        await c1;

        // After releasing C1, requestOrgDeletion must get the FOR UPDATE and succeed
        const result = await requestOrgDeletion(db, {
          orgId: "acme",
          requestedBy: "op",
        });
        expect(result).toBe("requested");

        // A new create against the tombstoned org must be refused
        await expect(
          new PgBriefStore(db, "acme", "u2").createCampaign("after-tombstone"),
        ).rejects.toMatchObject({ code: "EFORBIDDEN" });
      } finally {
        release();
        await c1.catch(() => undefined);
      }
    });

    test("a pending tombstone blocks a create, and a create after it commits is refused", async () => {
      let fired = false;
      let announce!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        announce = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });

      // T: requestOrgDeletion paused at its first `insert into deletion`,
      // holding FOR UPDATE on the org row (with deleted_at set, uncommitted)
      const wrappedT: SqlClient = {
        ...db,
        transaction: (work) =>
          db.transaction((tx) => {
            const intercept: SqlQuery = {
              ...tx,
              query: async <R>(text: string, params?: readonly unknown[]) => {
                if (!fired && text.includes("insert into deletion")) {
                  fired = true;
                  announce();
                  await released;
                }
                return tx.query<R>(text, params);
              },
            };
            return work(intercept);
          }),
      };

      const t = requestOrgDeletion(wrappedT, {
        orgId: "acme",
        requestedBy: "op",
      });
      t.catch(() => undefined);
      await lockTaken;

      let late: Promise<unknown> | undefined;
      try {
        // T holds FOR UPDATE: FOR SHARE NOWAIT must reject
        await expect(
          db.query(`select deleted_at from org where id = $1 for share nowait`, ["acme"]),
        ).rejects.toMatchObject({ code: "55P03" });

        // T holds FOR UPDATE: FOR KEY SHARE NOWAIT must also reject
        await expect(
          db.query(`select deleted_at from org where id = $1 for key share nowait`, ["acme"]),
        ).rejects.toMatchObject({ code: "55P03" });

        // A create with lock_timeout is blocked by T's FOR UPDATE. NOTE: this
        // step is NOT a witness for assertOrgLive's `for share` — with `for share`
        // removed, the insert's own FK check still waits on T's FOR UPDATE and
        // times out the same way. The deterministic witness for `for share` is
        // test 7's `for update nowait` probe, which fails if the lock is absent.
        const wrappedWithTimeout: SqlClient = {
          ...db,
          transaction: (work) =>
            db.transaction(async (tx) => {
              await tx.query(`set local lock_timeout = '200ms'`);
              return work(tx);
            }),
        };

        await expect(
          new PgBriefStore(wrappedWithTimeout, "acme", "u3").createCampaign("blocked"),
        ).rejects.toMatchObject({ code: "55P03" });

        // The blocked create inserted nothing
        const { rows: count1 } = await db.query<{ n: number }>(
          `select count(*)::int as n from campaign where org_id = 'acme'`,
        );
        expect(count1[0]!.n).toBe(0);

        // Start late create unawaited, then release T
        late = new PgBriefStore(db, "acme", "u4").createCampaign("late");
        late.catch(() => undefined);

        release();
        const result = await t;
        expect(result).toBe("requested");

        // The late create sees the committed tombstone and is refused
        await expect(late).rejects.toMatchObject({ code: "EFORBIDDEN" });

        const { rows: count2 } = await db.query<{ n: number }>(
          `select count(*)::int as n from campaign where org_id = 'acme'`,
        );
        expect(count2[0]!.n).toBe(0);
      } finally {
        release();
        await t.catch(() => undefined);
        if (late) await late.catch(() => undefined);
      }
    });
  },
);
