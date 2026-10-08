import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetObjectStoreClient, setObjectStoreClient } from "../../object-store/index.js";
import {
  ORG_BLOCKED_MESSAGE,
  purgeOrg,
  queueCampaignPurges,
  requestOrgDeletion,
} from "../purge-org.js";
import { requestCampaignDeletion } from "../request.js";
import {
  finishCampaignPurges,
  objectSnapshot,
  orgRow,
  seedCampaign,
  seedOrg,
  snapshot,
} from "./purge-org-fixtures.js";

function saveStore(): string | undefined {
  return process.env.OBJECT_STORE;
}
function restoreStore(saved: string | undefined): void {
  if (saved === undefined) delete process.env.OBJECT_STORE;
  else process.env.OBJECT_STORE = saved;
}

describe("purgeOrg while campaigns remain (PT-9m2, D241)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  let savedStore: string | undefined;

  beforeEach(async () => {
    db = await migratedDatabase();
    savedStore = saveStore();
    process.env.OBJECT_STORE = "s3";
    store = new InMemoryObjectStore();
    setObjectStoreClient(store);
  });
  afterEach(async () => {
    await db.end();
    resetObjectStoreClient();
    restoreStore(savedStore);
  });

  async function countPendingCampaignRows(orgId: string, subject: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion
         where org_id = $1 and kind = 'campaign' and subject = $2 and purged_at is null`,
      [orgId, subject],
    );
    return rows[0]!.n;
  }

  test("queueCampaignPurges tombstones every live campaign and queues one purge each", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store, { campaigns: 1 });
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(store, "beta");

    // A third campaign, already tombstoned with its own unpurged queue row.
    const third = await seedCampaign(db, "acme", "acme-three");
    const thirdOutcome = await requestCampaignDeletion(db, {
      orgId: "acme",
      campaignId: third,
      requestedBy: "operator",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(thirdOutcome).toEqual({ outcome: "requested", deletionId: expect.any(String) });

    const blocked = await queueCampaignPurges(db, "acme", "operator");
    expect(blocked).toBe(false);

    // acme's three campaigns are all tombstoned; the two that were live were done by
    // this call (deleted_by = operator); the third keeps its original tombstone.
    const { rows: campaigns } = await db.query<{ id: string; deleted_by: string | null }>(
      `select id, deleted_by from campaign where org_id = 'acme' order by id`,
    );
    expect(campaigns).toHaveLength(3);
    for (const c of campaigns) expect(c.deleted_by).toBe("operator");

    // Exactly three unpurged campaign deletion rows for acme, all requested by operator.
    const { rows: del } = await db.query<{ subject: string; requested_by: string }>(
      `select subject, requested_by from deletion
         where org_id = 'acme' and kind = 'campaign' and purged_at is null
         order by subject`,
    );
    expect(del).toHaveLength(3);
    expect(del.map((d) => d.requested_by)).toEqual(["operator", "operator", "operator"]);
    // No row was queued for another org.
    expect(await countPendingCampaignRows("beta", "x")).toBe(0);

    // beta's campaign is live with zero deletion rows.
    const { rows: betaCampaigns } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from campaign where org_id = 'beta'`,
    );
    expect(betaCampaigns).toHaveLength(1);
    expect(betaCampaigns[0]!.deleted_at).toBeNull();

    // B is untouched: rows and bytes.
    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
  });

  test("queueCampaignPurges queues a tombstoned campaign that has no deletion row", async () => {
    const acme = await seedOrg(db, "acme", store, { campaigns: 1 });
    await seedOrg(db, "beta", store, { campaigns: 1 });
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(store, "beta");

    // Tombstone acme's single live campaign by raw SQL — no deletion row, the
    // case data from before PT-9f would leave behind.
    const only = acme.campaigns[0]!.id;
    await db.query(`update campaign set deleted_at = now() where id = $1::uuid`, [only]);
    expect(await countPendingCampaignRows("acme", only)).toBe(0);

    await queueCampaignPurges(db, "acme", "operator");
    expect(await countPendingCampaignRows("acme", only)).toBe(1);

    await queueCampaignPurges(db, "acme", "operator");
    expect(await countPendingCampaignRows("acme", only)).toBe(1); // idempotent

    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
  });

  test("queueCampaignPurges reports blocked and leaves a campaign with a running job live", async () => {
    const acme = await seedOrg(db, "acme", store, { campaigns: 2 });
    await seedOrg(db, "beta", store, { campaigns: 1 });
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(store, "beta");
    const [x, y] = acme.campaigns;

    // A running job keyed by the campaign's SLUG blocks the tombstone+queue.
    await db.query(
      `insert into job (id, org_id, campaign_id, status, lease_expires_at)
         values ($1, 'acme', $2, 'running', now() + interval '1 minute')`,
      ["job-x-slug", x.slug],
    );

    let blocked = await queueCampaignPurges(db, "acme", "operator");
    expect(blocked).toBe(true);
    // X is live and has no deletion row; Y is tombstoned and queued.
    const { rows: xLive } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from campaign where id = $1::uuid`,
      [x.id],
    );
    expect(xLive[0]!.deleted_at).toBeNull();
    expect(await countPendingCampaignRows("acme", x.id)).toBe(0);
    expect(await countPendingCampaignRows("acme", y.id)).toBe(1);

    // Settle the job; the next call frees X.
    await db.query(`update job set status = 'completed' where id = $1`, ["job-x-slug"]);
    blocked = await queueCampaignPurges(db, "acme", "operator");
    expect(blocked).toBe(false);
    expect(await countPendingCampaignRows("acme", x.id)).toBe(1);

    // Repeat the blocked case with the job keyed by X's uuid text (D246): a
    // fresh live campaign Z plus a uuid-keyed running job.
    const z = await seedCampaign(db, "acme", "z-live");
    await db.query(
      `insert into job (id, org_id, campaign_id, status, lease_expires_at)
         values ($1, 'acme', $2::text, 'running', now() + interval '1 minute')`,
      ["job-z-uuid", z],
    );
    blocked = await queueCampaignPurges(db, "acme", "operator");
    expect(blocked).toBe(true);
    const { rows: zLive } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from campaign where id = $1::uuid`,
      [z],
    );
    expect(zLive[0]!.deleted_at).toBeNull();
    expect(await countPendingCampaignRows("acme", z)).toBe(0);

    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
  });

  test("purgeOrg answers retry and keeps every row while campaign purges are pending", async () => {
    await seedOrg(db, "acme", store);
    await seedOrg(db, "beta", store);
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(store, "beta");
    const beforeAcme = await snapshot(db, "acme");
    const beforeAcmeObj = await objectSnapshot(store, "acme");

    await requestOrgDeletion(db, { orgId: "acme", requestedBy: "operator" });
    const row = await orgRow(db, "acme");

    const result = await purgeOrg(db, "acme", row);
    expect(result).toBe("retry");

    const afterAcme = await snapshot(db, "acme");
    const afterAcmeObj = await objectSnapshot(store, "acme");
    // Rows that a pending campaign purge must NOT have touched.
    for (const table of [
      "member",
      "team",
      "team_member",
      "invitation",
      "provider_key",
      "usage",
      "decision",
      "report",
      "pool",
      "job",
      "asset",
      "draft",
      "last_opened",
    ] as const) {
      expect(afterAcme[table]).toEqual(beforeAcme[table]);
    }
    // org.name is untouched: only "purged" anonymises it.
    expect(JSON.parse(afterAcme.org[0]!).name).toBe("Name of acme");
    const { rows: del } = await db.query<{ purged_at: Date | null; requested_by: string }>(
      `select purged_at, requested_by from deletion where id = $1`,
      [row.id],
    );
    expect(del[0]!.purged_at).toBeNull();
    expect(del[0]!.requested_by).toBe("operator");
    expect(afterAcmeObj).toEqual(beforeAcmeObj);
    // The campaigns were queued (tombstoned), but their rows remain.
    const { rows: camps } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from campaign where org_id = 'acme' order by id`,
    );
    expect(camps).toHaveLength(2);
    for (const c of camps) expect(c.deleted_at).not.toBeNull();

    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
  });

  test("purgeOrg answers retry and records the blocker while a campaign has a running job", async () => {
    const acme = await seedOrg(db, "acme", store, { campaigns: 1 });
    await seedOrg(db, "beta", store, { campaigns: 1 });
    const beforeBeta = await snapshot(db, "beta");
    const beforeBetaObj = await objectSnapshot(store, "beta");

    await requestOrgDeletion(db, { orgId: "acme", requestedBy: "operator" });
    const row = await orgRow(db, "acme");
    const c = acme.campaigns[0]!;
    await db.query(
      `insert into job (id, org_id, campaign_id, status, lease_expires_at)
         values ($1, 'acme', $2, 'running', now() + interval '1 minute')`,
      ["job-block", c.slug],
    );

    const result = await purgeOrg(db, "acme", row);
    expect(result).toBe("retry");
    const { rows: del } = await db.query<{ last_error: string | null }>(
      `select last_error from deletion where id = $1`,
      [row.id],
    );
    expect(del[0]!.last_error).toBe(ORG_BLOCKED_MESSAGE);

    // Settle the job, then drain the queue to purged.
    await db.query(`update job set status = 'completed' where id = $1`, ["job-block"]);
    let out: "purged" | "retry" = result;
    do {
      out = await purgeOrg(db, "acme", { id: row.id, requestedBy: row.requestedBy });
      if (out === "retry") await finishCampaignPurges(db, "acme");
    } while (out === "retry");
    expect(out).toBe("purged");

    expect(await snapshot(db, "beta")).toEqual(beforeBeta);
    expect(await objectSnapshot(store, "beta")).toEqual(beforeBetaObj);
  });
});
