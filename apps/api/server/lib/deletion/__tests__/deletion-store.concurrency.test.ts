import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pg from "pg";
import { databaseConfig } from "../../db/database-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient, SqlQuery } from "../../db/sql-client.js";
import { claimDue } from "../deletion-store.js";

/**
 * PGlite (every other database test) is one connection: it can serialise a
 * "second sweeper" call, but it cannot make two sweepers arrive at Postgres at
 * the same instant, which is the one thing `skip locked` is for. This file is the
 * proof over a real server, over an actual two-connection pool — skipped unless
 * `TEST_DATABASE_URL` is set (CI's `postgres:17` service; never against the
 * owner's Aiven service).
 *
 * It owns a schema it creates and drops, so it runs beside every other test's
 * own database without clashing on `deletion`, `campaign`, `org` or
 * `schema_migrations`.
 *
 * **`TEST_DATABASE_URL` and not `TEST_PG_URL` is also why this file is NOT in the
 * lane's manifest.** CI's manifest-replay step runs before the `Test` step that
 * exports `TEST_DATABASE_URL`, so a manifest entry witnessed only here would
 * replay with no real server and turn CI red on a claim the gate cannot check.
 */
const url = process.env.TEST_DATABASE_URL;

const sleep = (ms: number): Promise<"timeout"> =>
  new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), ms);
  });

describe.skipIf(!url)(
  "two sweepers claiming the same due row: skip locked lets the second move on instead of blocking (PT-9g1)",
  () => {
    const schema = `pt9g1_sweep_${randomUUID().replaceAll("-", "_")}`;
    let db: SqlClient;

    beforeAll(async () => {
      const config = databaseConfig({ url, poolMax: "2" }, () => {
        throw new Error("a local TEST_DATABASE_URL needs no CA");
      });
      db = pgClient(
        config,
        (cfg) => new pg.Pool({ ...poolOptions(cfg), options: `-c search_path=${schema}` }),
      );
      await db.query(`create schema if not exists "${schema}"`);
      // 0001_org.sql seeds the "local" org itself; nothing to add here.
      await migrate(db, await loadMigrations());
    });

    afterAll(async () => {
      await db.query(`drop schema if exists "${schema}" cascade`);
      await db.end();
    });

    /**
     * Hold the first sweeper's transaction open AFTER its `for update skip locked`
     * subselect has taken the row lock, but BEFORE the transaction commits — so a
     * second sweeper actually contends on the ROW lock, rather than merely
     * filtering the now-committed `claimed_until`. A naive "start A unawaited, then
     * call B" test would NOT exercise this: A commits in milliseconds and B's
     * `WHERE … claimed_until < now()` simply excludes the row by its new value,
     * green on a `for update` mutant. The pause is the witness.
     */
    function pausingClient(
      inner: SqlClient,
      pattern: RegExp,
      lockTaken: () => void,
      release: Promise<void>,
    ): SqlClient {
      return {
        ...inner,
        transaction: (work) =>
          inner.transaction(async (tx) => {
            const wrapped: SqlQuery = {
              query: async <R>(text: string, params?: readonly unknown[]) => {
                const result = await tx.query<R>(text, params);
                if (pattern.test(text)) {
                  lockTaken();
                  await release;
                }
                return result;
              },
              exec: (text: string) => tx.exec(text),
            };
            return work(wrapped);
          }),
      };
    }

    test("two sweepers claiming the same due row: skip locked lets the second move on instead of blocking", async () => {
      // Exactly ONE due row. A and B both reach for it; under `skip locked` B
      // skips past A's locked row and finds nothing else, returning `undefined`
      // promptly. Under a `for update` mutant B blocks on A's open lock.
      const subject = randomUUID();
      await db.query(
        `insert into deletion (org_id, kind, subject, requested_by, not_before)
           values ('local', 'campaign', $1, 'tester', now())`,
        [subject],
      );

      let announce!: () => void;
      const announced = new Promise<void>((resolve) => {
        announce = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });

      // A (first sweeper): claims the single due row, then pauses holding the row
      // lock inside its still-open transaction.
      const a = claimDue(pausingClient(db, /update deletion/, announce, released));
      a.catch(() => undefined);
      await announced;

      // B (second sweeper): runs on the pool's other connection while A's row is
      // locked. `claimDue(db).then(() => "settled")` wins the race when B returns
      // promptly (skip locked); `sleep(300)` wins when B blocks (the mutant).
      const b = claimDue(db);
      const outcome = await Promise.race([
        b.then(() => "settled"),
        sleep(300).then(() => "timeout"),
      ]);

      // Release A and drain B FIRST, so a red run never wedges `afterAll`'s schema
      // drop against an open transaction on the row.
      release();
      const claimed = await a;
      expect(claimed).toBeDefined();
      expect(claimed!.subject).toBe(subject);
      expect(claimed!.attempts).toBe(1);
      await b.catch(() => undefined);

      // The mutant-sensitive assertion, last: under the correct `skip locked`
      // behaviour B skips A's row and settles; under `for update` B blocked until
      // the 300 ms timeout, so this is the line that goes red.
      expect(outcome).toBe("settled");
    });
  },
);
