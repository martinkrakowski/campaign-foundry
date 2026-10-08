import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { queueCampaignPurges } from "../purge-org.js";
import { seedCampaign, seedOrg, snapshot } from "./purge-org-fixtures.js";

describe("queueCampaignPurges back-fill (FU-purge-org-hardening, W2)", () => {
  let db: SqlClient;

  beforeEach(async () => {
    db = await migratedDatabase();
  });
  afterEach(async () => {
    await db.end();
  });

  test("two interleaved back-fills leave exactly one pending purge row for the campaign", async () => {
    await seedOrg(db, "acme", undefined, { campaigns: 0 });
    const id = await seedCampaign(db, "acme", "orphan", { tombstoned: true });

    let fired = false;
    const proxy: SqlClient = {
      ...db,
      query: async (text, params) => {
        if (!fired && text.includes("insert into deletion")) {
          fired = true;
          await queueCampaignPurges(db, "acme", "u2");
        }
        return db.query(text, params);
      },
    };

    await queueCampaignPurges(proxy, "acme", "u1");

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion
         where org_id = 'acme' and kind = 'campaign' and subject = $1 and purged_at is null`,
      [id],
    );
    expect(rows[0]!.n).toBe(1);
  });

  test("queueCampaignPurges run twice leaves exactly one pending row per orphan", async () => {
    await seedOrg(db, "acme", undefined, { campaigns: 0 });
    const id1 = await seedCampaign(db, "acme", "orphan-a", { tombstoned: true });
    const id2 = await seedCampaign(db, "acme", "orphan-b", { tombstoned: true });

    await queueCampaignPurges(db, "acme", "u");
    await queueCampaignPurges(db, "acme", "u");

    for (const id of [id1, id2]) {
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from deletion
           where org_id = 'acme' and kind = 'campaign' and subject = $1 and purged_at is null`,
        [id],
      );
      expect(rows[0]!.n).toBe(1);
    }
  });

  test("queueCampaignPurges back-fills this org's orphans only", async () => {
    await seedOrg(db, "acme", undefined, { campaigns: 0 });
    await seedOrg(db, "beta", undefined, { campaigns: 0 });
    await seedCampaign(db, "acme", "orphan", { tombstoned: true });
    await seedCampaign(db, "beta", "beta-orphan", { tombstoned: true });
    const beforeBeta = await snapshot(db, "beta");

    await queueCampaignPurges(db, "acme", "u");

    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
  });

  test("a back-fill leaves a campaign that already has a pending row alone", async () => {
    await seedOrg(db, "acme", undefined, { campaigns: 0 });

    // Case 1: an orphan with an EXISTING pending row keeps its id and gets no second row.
    const existing = await seedCampaign(db, "acme", "with-pending", { tombstoned: true });
    await db.query(
      `insert into deletion (org_id, kind, subject, requested_by, not_before)
         values ('acme', 'campaign', $1, 'u', now())`,
      [existing],
    );
    await queueCampaignPurges(db, "acme", "u");
    const { rows: c1 } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion
         where org_id = 'acme' and kind = 'campaign' and subject = $1 and purged_at is null`,
      [existing],
    );
    expect(c1[0]!.n).toBe(1);

    // Case 2: a tombstoned campaign whose deletion row is PURGED gets a new pending row.
    const repurged = await seedCampaign(db, "acme", "re-purged", { tombstoned: true });
    await db.query(
      `insert into deletion (org_id, kind, subject, requested_by, not_before, purged_at)
         values ('acme', 'campaign', $1, 'u', now(), now())`,
      [repurged],
    );
    await queueCampaignPurges(db, "acme", "u");
    const { rows: c2 } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion
         where org_id = 'acme' and kind = 'campaign' and subject = $1 and purged_at is null`,
      [repurged],
    );
    expect(c2[0]!.n).toBe(1);
  });
});
