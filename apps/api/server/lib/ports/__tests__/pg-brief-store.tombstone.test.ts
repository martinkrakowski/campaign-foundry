import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetObjectStoreClient, setObjectStoreClient } from "../../object-store/index.js";
import { purgeOrg, requestOrgDeletion } from "../../deletion/purge-org.js";
import {
  finishCampaignPurges,
  orgRow,
  seedOrg,
} from "../../deletion/__tests__/purge-org-fixtures.js";
import { PgBriefStore } from "../pg-brief-store.js";

const minimalBrief: CampaignBrief = {
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "test-camp",
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build great things",
  products: [{ id: "prod-1", name: "Product 1", primaryColor: "#1473E6", logoPath: "logo.png" }],
};

const brief = (id: string, message = "Build great things"): CampaignBrief => ({
  ...minimalBrief,
  id,
  campaignMessage: message,
});

describe("PgBriefStore tombstone guard (FU-purge-org-hardening, W1)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  let savedStore: string | undefined;

  beforeEach(async () => {
    db = await migratedDatabase();
    savedStore = process.env.OBJECT_STORE;
    process.env.OBJECT_STORE = "s3";
    store = new InMemoryObjectStore();
    setObjectStoreClient(store);
  });
  afterEach(async () => {
    await db.end();
    resetObjectStoreClient();
    if (savedStore === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = savedStore;
  });

  test("createCampaign refuses a tombstoned org and inserts nothing", async () => {
    await seedOrg(db, "acme", undefined, { campaigns: 0 });
    await requestOrgDeletion(db, { orgId: "acme", requestedBy: "op" });

    await expect(new PgBriefStore(db, "acme", "u").createCampaign("x")).rejects.toMatchObject({
      code: "EFORBIDDEN",
      statusCode: 403,
      message: "This account belongs to no organisation.",
    });
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from campaign where org_id = 'acme'`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  test("createBrief refuses a tombstoned org and inserts nothing", async () => {
    await seedOrg(db, "acme", undefined, { campaigns: 0 });
    await requestOrgDeletion(db, { orgId: "acme", requestedBy: "op" });

    await expect(new PgBriefStore(db, "acme", "u").createBrief(brief("x"))).rejects.toMatchObject({
      code: "EFORBIDDEN",
      statusCode: 403,
      message: "This account belongs to no organisation.",
    });
    const { rows: camps } = await db.query<{ n: number }>(
      `select count(*)::int as n from campaign where org_id = 'acme'`,
    );
    expect(camps[0]!.n).toBe(0);
    const { rows: versions } = await db.query<{ n: number }>(
      `select count(*)::int as n from brief_version bv
         join campaign c on c.id = bv.campaign_id where c.org_id = 'acme'`,
    );
    expect(versions[0]!.n).toBe(0);
  });

  test("a create that lands after the purge count is refused and nothing survives the purge", async () => {
    await seedOrg(db, "acme", undefined, { campaigns: 0 });
    await requestOrgDeletion(db, { orgId: "acme", requestedBy: "op" });
    const row = await orgRow(db, "acme");

    let lateOutcome: { ok: unknown } | { error: unknown } | undefined;
    async function late(): Promise<void> {
      try {
        const result = await new PgBriefStore(db, "acme", "u").createCampaign("late");
        lateOutcome = { ok: result };
      } catch (error) {
        lateOutcome = { error };
      }
    }

    const proxy: SqlClient = {
      ...db,
      query: async <R>(text: string, params?: readonly unknown[]) => {
        const r = await db.query<R>(text, params);
        if (text.includes("select count(*)::int as n from campaign")) {
          await late();
        }
        return r;
      },
    };

    const outcome = await purgeOrg(proxy, "acme", row);

    expect(outcome).toBe("purged");
    expect(lateOutcome).toMatchObject({ error: expect.objectContaining({ code: "EFORBIDDEN" }) });
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from campaign where org_id = 'acme'`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  test("a campaign created before the tombstone is queued and purged normally", async () => {
    await seedOrg(db, "acme", store, { campaigns: 0 });
    await new PgBriefStore(db, "acme", "u").createCampaign("early");
    await requestOrgDeletion(db, { orgId: "acme", requestedBy: "op" });
    const row = await orgRow(db, "acme");

    const first = await purgeOrg(db, "acme", row);
    expect(first).toBe("retry");
    await finishCampaignPurges(db, "acme");

    const second = await purgeOrg(db, "acme", row);
    expect(second).toBe("purged");

    const { rows: camps } = await db.query<{ n: number }>(
      `select count(*)::int as n from campaign where org_id = 'acme'`,
    );
    expect(camps[0]!.n).toBe(0);
    const { rows: del } = await db.query<{ purged_at: Date | null }>(
      `select purged_at from deletion where org_id = 'acme' and kind = 'campaign'`,
    );
    expect(del[0]!.purged_at).not.toBeNull();
  });

  test("a create in a live org still works and an org that is absent still fails on its foreign key", async () => {
    const live = new PgBriefStore(db, "local", "local");
    const created = await live.createCampaign("a");
    expect(created).toEqual({ campaignId: expect.any(String), slug: "a" });

    const caught = await new PgBriefStore(db, "no-such-org", "u")
      .createCampaign("b")
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).not.toBe("EFORBIDDEN");
    expect((caught as Error).message).toMatch(/foreign key/i);
  });

  // Covers hasGenuineReservation (line 644): the only pg-brief-store method not
  // exercised by this file before this lane. `campaignMeta` is already covered;
  // this exercises the wrapper that delegates to it.
  test("hasGenuineReservation reports a real campaign and a missing one", async () => {
    const store = new PgBriefStore(db, "local", "local");
    await store.createCampaign("reserved-check");
    expect(await store.hasGenuineReservation("reserved-check")).toBe(true);
    expect(await store.hasGenuineReservation("no-such-campaign")).toBe(false);
  });
});
