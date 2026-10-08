import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import pg from "pg";
import { testServerConfig } from "../../db/__tests__/test-server-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient, SqlQuery } from "../../db/sql-client.js";
import { queueCampaignPurges } from "../purge-org.js";
import { seedCampaign } from "../../deletion/__tests__/purge-org-fixtures.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)(
  "queueCampaignPurges back-fill lock (FU-purge-org-hardening, W2 concurrency)",
  () => {
    const schema = `fubackfill_${randomUUID().replaceAll("-", "")}`;
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

    test("a second back-fill waits for the first and adds no second row", async () => {
      const id = await seedCampaign(db, "acme", "orphan", { tombstoned: true });

      let fired = false;
      let announce!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        announce = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });

      // A: queueCampaignPurges paused inside its transaction at the first
      // `insert into deletion`. By then the `for update` select has locked the
      // campaign row.
      const wrappedA: SqlClient = {
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

      const a = queueCampaignPurges(wrappedA, "acme", "u1");
      a.catch(() => undefined);
      await lockTaken;

      // The campaign row is locked by A's `for update`: NOWAIT must reject
      await expect(
        db.query(`select id from campaign where id = $1 for update nowait`, [id]),
      ).rejects.toMatchObject({ code: "55P03" });

      // B starts on the raw db, unawaited: it blocks on the same campaign-row lock
      const b = queueCampaignPurges(db, "acme", "u2");
      b.catch(() => undefined);

      // Release A; both complete
      release();
      await Promise.all([a, b]);

      // Exactly one pending deletion row for the campaign
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from deletion
           where org_id = 'acme' and kind = 'campaign' and subject = $1 and purged_at is null`,
        [id],
      );
      expect(rows[0]!.n).toBe(1);
    });
  },
);
