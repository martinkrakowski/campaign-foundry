import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { testServerConfig } from "../../db/__tests__/test-server-config.js";
import { pgClient, poolOptions } from "../../db/pg-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import type { SqlClient } from "../../db/sql-client.js";
import { CANONICAL_TEMPLATES, type CreativeTemplate } from "@campaignfoundry/CampaignOrchestration";
import { PgTemplateStore } from "../pg-template-store.js";
import { MAX_TEMPLATES_PER_ORG, TemplateLimitExceededError } from "../template-store.port.js";

/**
 * PGlite (every other template-store test) is one connection: its "concurrent"
 * saves serialize on the connection itself, so nothing there can make two
 * saves arrive at Postgres at the same instant — which is exactly the cap
 * race the per-org advisory lock exists to close. This file is the proof
 * against a real server, over an actual two-connection pool — skipped unless
 * `TEST_DATABASE_URL` is set (CI's `postgres:17` service;
 * `.github/workflows/ci.yml`), never against the owner's real database.
 *
 * It owns a schema it creates and drops, so it can run beside every other
 * test's own database (or its own re-run) without clashing on `template`,
 * `org` or `schema_migrations`.
 */
const url = process.env.TEST_DATABASE_URL;

/** A valid org template to save: the canonical image-text seed under a new id. */
function orgTemplate(overrides: Partial<CreativeTemplate> = {}): CreativeTemplate {
  const base = CANONICAL_TEMPLATES["image-text"];
  return { ...base, id: "org-banner", version: 1, name: "Org Banner", ...overrides };
}

/** Insert a template row directly, the way a previous save would have. */
async function seedRow(db: SqlClient, orgId: string, template: CreativeTemplate): Promise<void> {
  await db.query(
    `insert into template (org_id, id, version, name, unit, creative_type, layers, created_by)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      orgId,
      template.id,
      template.version,
      template.name,
      template.unit,
      template.creativeType,
      JSON.stringify(template.layers),
      "u1",
    ],
  );
}

describe.skipIf(!url)("PgTemplateStore races two real connections at the cap (fix round)", () => {
  const schema = `tmpl_cap_test_${randomUUID().replaceAll("-", "_")}`;
  const orgId = `cap-race-${randomUUID().slice(0, 18)}`;
  // Set in `beforeAll`: `testServerConfig` throws on an unset URL, and the
  // describe body runs even when the tests are skipped.
  let config: ReturnType<typeof testServerConfig>;
  let db: SqlClient;

  beforeAll(async () => {
    config = testServerConfig({ url, poolMax: "2" }, "TEST_DATABASE_URL");
    // Every connection in the pool starts in this schema (a libpq startup
    // option, applied per connection — `search_path` cannot be set once for a
    // pool the way a single session could). `CREATE SCHEMA` itself is
    // unaffected by search_path, since it names the schema explicitly, so this
    // is safe to run before the schema exists.
    db = pgClient(
      config,
      (cfg) => new pg.Pool({ ...poolOptions(cfg), options: `-c search_path=${schema}` }),
    );
    await db.query(`create schema if not exists "${schema}"`);
    await migrate(db, await loadMigrations());
    // Its own org: the cap is per org, and this file fills the org to one
    // below it, so sharing any other test's org would clash.
    await db.query("insert into org (id, name) values ($1, $2)", [orgId, "Cap race"]);
    for (let i = 0; i < MAX_TEMPLATES_PER_ORG - 1; i += 1) {
      await seedRow(db, orgId, orgTemplate({ id: `filler-${i}`, version: 1 }));
    }
  });

  afterAll(async () => {
    await db.query(`drop schema if exists "${schema}" cascade`);
    await db.end();
  });

  test("a save of a NEW id waits behind the org advisory lock another transaction holds", async () => {
    // Connection A is a raw client, deliberately NOT the store's pool: it
    // holds the org advisory lock itself, in an open transaction, while
    // connection B (the store, over the pool) starts a save of a brand-new id
    // for the same org. NOTE: the lock key here is coupled ON PURPOSE to the
    // exact key `pg-template-store.ts` takes — `hashtext('template:' || org)`.
    // If the store ever changes its key, this test must change with it: it is
    // the proof that the save SERIALIZES per org, not per (org, id).
    //
    // Under the pre-fix (org, id)-keyed lock, B takes a DIFFERENT lock (its
    // own id is new), does not wait, counts the 49 committed rows on its own
    // snapshot, admits, and commits — `settled` would be true long before the
    // 400 ms probe. Under the org-keyed lock B blocks inside its transaction
    // until A commits, so `settled` must still be false at 400 ms, and B must
    // complete normally after A commits.
    const store = new PgTemplateStore(db, orgId);
    const connectionA = new pg.Client({
      ...poolOptions(config),
      options: `-c search_path=${schema}`,
    });
    await connectionA.connect();
    try {
      await connectionA.query("BEGIN");
      await connectionA.query("select pg_advisory_xact_lock(hashtext('template:' || $1))", [orgId]);

      let settled = false;
      const saveB = store
        .saveTemplate(orgTemplate({ id: `blocked-${randomUUID().slice(0, 8)}`, version: 1 }), "u1")
        .then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);

      await connectionA.query("COMMIT");
      await saveB;
      expect(settled).toBe(true);
    } finally {
      await connectionA.end();
    }
  });

  test("two DISTINCT new ids racing at cap - 1 admit exactly one under real concurrency", async () => {
    // With the advisory lock keyed on (org, id) — the pre-fix shape — the two
    // saves take DIFFERENT locks, so neither waits for the other: both count
    // the same 49 distinct ids on their own READ COMMITTED snapshots (neither
    // has committed yet), both satisfy `distinct_ids < MAX_TEMPLATES_PER_ORG`,
    // and both admit — 51 rows. Only the ORG-keyed lock serializes them, so
    // the second save's INSERT recounts on a snapshot taken after the first
    // committed and selects nothing to insert.
    //
    // One deterministic scheduling (the blocking test above) cannot catch a
    // timing race on its own, so this shape is repeated: each round races two
    // fresh ids at the boundary and then deletes the admitted row, putting the
    // org back at MAX - 1 for the next round.
    const store = new PgTemplateStore(db, orgId);
    for (let round = 0; round < 20; round += 1) {
      const idA = `racer-a-${round}-${randomUUID().slice(0, 8)}`;
      const idB = `racer-b-${round}-${randomUUID().slice(0, 8)}`;
      const results = await Promise.allSettled([
        store.saveTemplate(orgTemplate({ id: idA, version: 1 }), "u1"),
        store.saveTemplate(orgTemplate({ id: idB, version: 1 }), "u1"),
      ]);
      const admitted = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(admitted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.reason).toBeInstanceOf(TemplateLimitExceededError);

      const { rows } = await db.query<{ n: number }>(
        "select count(*)::int as n from template where org_id = $1",
        [orgId],
      );
      expect(rows[0]!.n).toBe(MAX_TEMPLATES_PER_ORG);

      // Reset to MAX - 1 for the next round: whichever id was admitted is
      // removed (deleting both ids is simpler than reading which one won).
      await db.query("delete from template where org_id = $1 and id in ($2, $3)", [
        orgId,
        idA,
        idB,
      ]);
    }
  });
});
