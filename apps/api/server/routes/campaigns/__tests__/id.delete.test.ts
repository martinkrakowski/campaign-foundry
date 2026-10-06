import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { SqlClient } from "../../../lib/db/sql-client.js";
import deleteHandler from "../[id].delete.js";
import {
  mountTenantRoute,
  setupFsHarness,
  setupPgHarness,
  type TenantContext,
  type WebCaller,
} from "../../__tests__/tenant-harness.js";

// Coverage: a hoisted spy that defaults to the REAL requestCampaignDeletion
// (installed by the factory below), so every test uses the real transaction
// unless it overrides the spy. The "gone" race (manifest mutation 6) is the
// only test that calls mockResolvedValueOnce — see generate-campaign-gone.test.ts
// for the idiom.
const requestSpy = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/deletion/request.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/deletion/request.js")>();
  requestSpy.mockImplementation(actual.requestCampaignDeletion);
  return { ...actual, requestCampaignDeletion: requestSpy };
});

const owner: TenantContext = {
  orgId: "local",
  userId: "owner",
  roles: ["owner"],
  teamIds: [],
};
const admin: TenantContext = {
  orgId: "local",
  userId: "admin",
  roles: ["admin"],
  teamIds: [],
};
const t1Member: TenantContext = {
  orgId: "local",
  userId: "m1",
  roles: ["member"],
  teamIds: ["t1"],
};

const origGrace = process.env.PURGE_GRACE_HOURS;
const origAuth = process.env.AUTH_MODE;

function mount(tenant?: TenantContext): WebCaller {
  return mountTenantRoute(deleteHandler, {
    method: "delete",
    path: "/campaigns/:id",
    tenant,
  });
}

function del(call: WebCaller, id: string): Promise<Response> {
  return call(new Request(`http://x/campaigns/${id}`, { method: "DELETE" }));
}

async function seedTeam(db: SqlClient, id: string, name: string): Promise<void> {
  await db.query(
    `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
    [id, name, "local"],
  );
}

async function seedCampaign(
  db: SqlClient,
  slug: string,
  teamId: string | null = null,
): Promise<{ id: string; slug: string }> {
  const { rows } = await db.query<{ id: string; slug: string }>(
    `insert into campaign (org_id, slug, team_id) values ($1, $2, $3) returning id, slug`,
    ["local", slug, teamId],
  );
  return { id: rows[0]!.id, slug: rows[0]!.slug };
}

async function deletionCount(db: SqlClient): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from deletion`);
  return rows[0]!.n;
}

async function deletedAt(db: SqlClient, campaignId: string): Promise<Date | null> {
  const { rows } = await db.query<{ deleted_at: Date | null }>(
    `select deleted_at from campaign where id = $1`,
    [campaignId],
  );
  return rows[0]!.deleted_at;
}

beforeEach(() => {
  requestSpy.mockClear();
});

afterEach(() => {
  if (origGrace === undefined) delete process.env.PURGE_GRACE_HOURS;
  else process.env.PURGE_GRACE_HOURS = origGrace;
  if (origAuth === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = origAuth;
});

describe("DELETE /campaigns/:id — postgres store", () => {
  test("DELETE /campaigns/:id answers 202 and tombstones the campaign for an admin", async () => {
    const harness = await setupPgHarness();
    try {
      const campaign = await seedCampaign(harness.db, "camp");
      const res = await del(mount(admin), "camp");
      expect(res.status).toBe(202);
      const body = (await res.json()) as { deletionId: string };

      const delRows = await harness.db.query<{
        id: string;
        org_id: string;
        requested_by: string;
        subject: string;
        kind: string;
      }>(`select id, org_id, requested_by, subject, kind from deletion where subject = $1`, [
        campaign.id,
      ]);
      expect(delRows.rows[0]!.id).toBe(body.deletionId);
      expect(delRows.rows[0]!.kind).toBe("campaign");
      expect(delRows.rows[0]!.subject).toBe(campaign.id);
      expect(delRows.rows[0]!.org_id).toBe("local");
      expect(delRows.rows[0]!.requested_by).toBe("admin");

      const campRows = await harness.db.query<{
        deleted_at: Date | null;
        deleted_by: string | null;
      }>(`select deleted_at, deleted_by from campaign where id = $1`, [campaign.id]);
      expect(campRows.rows[0]!.deleted_at).not.toBeNull();
      expect(campRows.rows[0]!.deleted_by).toBe("admin");

      expect(await deletionCount(harness.db)).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id accepts the campaign uuid as well as its slug", async () => {
    const harness = await setupPgHarness();
    try {
      const byUuid = await seedCampaign(harness.db, "uuid-ref");
      const res1 = await del(mount(owner), byUuid.id);
      expect(res1.status).toBe(202);

      const bySlug = await seedCampaign(harness.db, "slug-ref");
      const res2 = await del(mount(owner), bySlug.slug);
      expect(res2.status).toBe(202);
    } finally {
      await harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 202 for a member on a campaign of their own team", async () => {
    const harness = await setupPgHarness();
    try {
      await seedTeam(harness.db, "t1", "Team One");
      const campaign = await seedCampaign(harness.db, "own-team", "t1");
      const res = await del(mount(t1Member), "own-team");
      expect(res.status).toBe(202);

      expect(await deletedAt(harness.db, campaign.id)).not.toBeNull();
      expect(await deletionCount(harness.db)).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 403 for a member on an org-wide campaign and writes nothing", async () => {
    const harness = await setupPgHarness();
    try {
      await seedTeam(harness.db, "t1", "Team One");
      const campaign = await seedCampaign(harness.db, "org-wide", null);
      const res = await del(mount(t1Member), "org-wide");
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body).toEqual({ error: 'You may not delete campaign "org-wide".' });

      expect(await deletedAt(harness.db, campaign.id)).toBeNull();
      expect(await deletionCount(harness.db)).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 404 for a campaign hidden from a member by team and writes nothing", async () => {
    const harness = await setupPgHarness();
    try {
      await seedTeam(harness.db, "t1", "Team One");
      await seedTeam(harness.db, "t2", "Team Two");
      const campaign = await seedCampaign(harness.db, "hidden", "t2");
      const res = await del(mount(t1Member), "hidden");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body).toEqual({ error: 'Campaign "hidden" not found.' });

      expect(await deletedAt(harness.db, campaign.id)).toBeNull();
      expect(await deletionCount(harness.db)).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 404 for another orgs campaign and writes nothing", async () => {
    const harness = await setupPgHarness();
    try {
      const { rows } = await harness.db.query<{ id: string; slug: string }>(
        `insert into campaign (org_id, slug, team_id) values ($1, $2, $3) returning id, slug`,
        ["acme", "theirs", null],
      );
      const campaign = { id: rows[0]!.id, slug: rows[0]!.slug };
      const call = mount(owner);

      const res1 = await del(call, campaign.slug);
      expect(res1.status).toBe(404);
      const res2 = await del(call, campaign.id);
      expect(res2.status).toBe(404);

      const campRows = await harness.db.query<{ deleted_at: Date | null }>(
        `select deleted_at from campaign where id = $1`,
        [campaign.id],
      );
      expect(campRows.rows[0]!.deleted_at).toBeNull();
      expect(await deletionCount(harness.db)).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 404 for an unknown campaign", async () => {
    const harness = await setupPgHarness();
    try {
      const res = await del(mount(owner), "never-created");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body).toEqual({ error: 'Campaign "never-created" not found.' });
    } finally {
      await harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 404 the second time and inserts no second deletion row", async () => {
    const harness = await setupPgHarness();
    try {
      await seedCampaign(harness.db, "repeat");
      const call = mount(owner);

      const first = await del(call, "repeat");
      expect(first.status).toBe(202);

      const second = await del(call, "repeat");
      expect(second.status).toBe(404);

      expect(await deletionCount(harness.db)).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 409 with the running jobId and writes nothing", async () => {
    const harness = await setupPgHarness();
    try {
      const campaign = await seedCampaign(harness.db, "running", null);
      await harness.db.query(
        `insert into job (id, org_id, campaign_id, status, lease_expires_at)
           values ($1, 'local', $2, 'running', now() + interval '1 minute')`,
        ["job-running", campaign.slug],
      );
      const res = await del(mount(owner), "running");
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; jobId: string };
      expect(body).toEqual({
        error: 'Campaign "running" has a run in progress.',
        jobId: "job-running",
      });
      expect(await deletedAt(harness.db, campaign.id)).toBeNull();
      expect(await deletionCount(harness.db)).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 409 for a job keyed by the campaign uuid", async () => {
    const harness = await setupPgHarness();
    try {
      const campaign = await seedCampaign(harness.db, "uuid-keyed", null);
      await harness.db.query(
        `insert into job (id, org_id, campaign_id, status, lease_expires_at)
           values ($1, 'local', $2, 'running', now() + interval '1 minute')`,
        ["job-uuid", campaign.id],
      );
      const res = await del(mount(owner), campaign.id);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; jobId: string };
      expect(body).toEqual({
        error: `Campaign "${campaign.id}" has a run in progress.`,
        jobId: "job-uuid",
      });
      expect(await deletedAt(harness.db, campaign.id)).toBeNull();
      expect(await deletionCount(harness.db)).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id sets not_before from PURGE_GRACE_HOURS", async () => {
    const harness = await setupPgHarness();
    try {
      process.env.PURGE_GRACE_HOURS = "24";
      const c1 = await seedCampaign(harness.db, "grace");
      const res1 = await del(mount(owner), "grace");
      expect(res1.status).toBe(202);
      const diff1 = await harness.db.query<{ diff: number }>(
        `select extract(epoch from (not_before - requested_at))::int as diff from deletion where subject = $1`,
        [c1.id],
      );
      expect(diff1.rows[0]!.diff).toBe(86400);

      delete process.env.PURGE_GRACE_HOURS;
      const c2 = await seedCampaign(harness.db, "grace2");
      const res2 = await del(mount(owner), "grace2");
      expect(res2.status).toBe(202);
      const diff2 = await harness.db.query<{ diff: number }>(
        `select extract(epoch from (not_before - requested_at))::int as diff from deletion where subject = $1`,
        [c2.id],
      );
      expect(diff2.rows[0]!.diff).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 400 for a path-unsafe id", async () => {
    const harness = await setupPgHarness();
    try {
      const res = await mount(owner)(
        new Request("http://x/campaigns/..%2Fetc", { method: "DELETE" }),
      );
      expect(res.status).toBe(400);
    } finally {
      await harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id under AUTH_MODE=local acts as the owner", async () => {
    const harness = await setupPgHarness();
    try {
      delete process.env.AUTH_MODE;
      const campaign = await seedCampaign(harness.db, "local-mode", null);
      const res = await mount(undefined)(
        new Request("http://x/campaigns/local-mode", { method: "DELETE" }),
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as { deletionId: string };
      expect(body.deletionId).toBeDefined();
      const campRows = await harness.db.query<{ deleted_by: string | null }>(
        `select deleted_by from campaign where id = $1`,
        [campaign.id],
      );
      expect(campRows.rows[0]!.deleted_by).toBe("local");
    } finally {
      await harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 404 when the transaction finds the campaign already gone", async () => {
    const harness = await setupPgHarness();
    try {
      const campaign = await seedCampaign(harness.db, "race-lost");
      requestSpy.mockResolvedValueOnce({ outcome: "gone" });
      const res = await del(mount(owner), "race-lost");
      // The 404 must come from the transaction's answer, not from an earlier miss.
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body).toEqual({ error: 'Campaign "race-lost" not found.' });
      expect(await deletedAt(harness.db, campaign.id)).toBeNull();
      expect(await deletionCount(harness.db)).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("DELETE /campaigns/:id — file store", () => {
  test("DELETE /campaigns/:id answers 501 under the file store and touches nothing", async () => {
    const harness = setupFsHarness();
    try {
      const res = await del(
        mountTenantRoute(deleteHandler, {
          method: "delete",
          path: "/campaigns/:id",
        }),
        "untouched",
      );
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: string };
      expect(body).toEqual({ error: "Deleting a campaign needs STORE_BACKEND=postgres." });
    } finally {
      harness.cleanup();
    }
  });
});
