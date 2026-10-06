import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { QUEUED_TTL_MS } from "../../ports/job-store.port.js";
import { listDue } from "../deletion-store.js";
import { requestCampaignDeletion, type CampaignDeletionOutcome } from "../request.js";

/** Plant a team row that `campaign.team_id` can reference (composite FK to team). */
async function seedTeam(
  db: SqlClient,
  orgId: string,
  teamId: string,
  name = "Team One",
): Promise<void> {
  await db.query(
    `insert into team (id, name, "memberCount", org_id, created_at)
       values ($1, $2, 0, $3, now())`,
    [teamId, name, orgId],
  );
}

/** Plant a campaign row, optionally tombstoned and/or team-scoped. */
async function seedCampaign(
  db: SqlClient,
  orgId: string,
  slug: string,
  opts: { id?: string; tombstoned?: boolean; teamId?: string | null } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into campaign (id, org_id, slug, deleted_at, team_id)
       values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5)
     returning id`,
    [opts.id ?? null, orgId, slug, opts.tombstoned ? new Date() : null, opts.teamId ?? null],
  );
  return rows[0]!.id;
}

/** Plant a `job` row directly, in whatever state a test needs. */
async function seedJob(
  db: SqlClient,
  job: {
    id: string;
    orgId: string;
    campaignId: string;
    status: "queued" | "running" | "completed" | "failed";
    leaseOffsetMs?: number;
    createdAtOffsetMs?: number;
  },
): Promise<void> {
  await db.query(
    `insert into job (id, org_id, campaign_id, status, lease_expires_at, created_at)
       values ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval, now() + ($6 || ' milliseconds')::interval)`,
    [
      job.id,
      job.orgId,
      job.campaignId,
      job.status,
      job.leaseOffsetMs ?? 0,
      job.createdAtOffsetMs ?? 0,
    ],
  );
}

/** Read back the whole `deletion` row this lane would have written. */
async function readDeletion(
  db: SqlClient,
  deletionId: string,
): Promise<{
  id: string;
  org_id: string;
  kind: string;
  subject: string;
  requested_by: string;
  not_before: Date;
  requested_at: Date;
  purged_at: Date | null;
  attempts: number;
}> {
  const { rows } = await db.query<{
    id: string;
    org_id: string;
    kind: string;
    subject: string;
    requested_by: string;
    not_before: Date;
    requested_at: Date;
    purged_at: Date | null;
    attempts: number;
  }>(
    `select id, org_id, kind, subject, requested_by, not_before, requested_at, purged_at, attempts from deletion where id = $1`,
    [deletionId],
  );
  return rows[0]!;
}

describe("request-campaign-deletion (D235, D234's tombstone half)", () => {
  let db: SqlClient;

  beforeEach(async () => {
    db = await migratedDatabase();
  });
  afterEach(async () => {
    await db.end();
  });

  test("requestCampaignDeletion tombstones the campaign and queues one deletion row", async () => {
    const slug = `camp-${randomUUID().slice(0, 8)}`;
    const campaignId = await seedCampaign(db, "local", slug);

    const outcome: CampaignDeletionOutcome = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId,
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(outcome).toEqual({ outcome: "requested", deletionId: expect.any(String) });

    const { rows: campaign } = await db.query<{
      deleted_at: Date | null;
      deleted_by: string | null;
    }>(`select deleted_at, deleted_by from campaign where id = $1`, [campaignId]);
    expect(campaign[0]!.deleted_at).not.toBeNull();
    expect(campaign[0]!.deleted_by).toBe("actor-1");

    const deletion = await readDeletion(db, (outcome as { deletionId: string }).deletionId);
    expect(deletion.kind).toBe("campaign");
    expect(deletion.subject).toBe(campaignId.toLowerCase());
    expect(deletion.org_id).toBe("local");
    expect(deletion.requested_by).toBe("actor-1");
    expect(deletion.purged_at).toBeNull();
    expect(deletion.attempts).toBe(0);
    expect(deletion.id).toBe((outcome as { deletionId: string }).deletionId);

    const { rows: count } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion`,
    );
    expect(count[0]!.n).toBe(1);
  });

  test("requestCampaignDeletion sets not_before from the grace hours", async () => {
    const slug = `camp-${randomUUID().slice(0, 8)}`;
    const campaignId = await seedCampaign(db, "local", slug);

    const outcome48 = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId,
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 48,
    });
    const deletion48 = await readDeletion(db, (outcome48 as { deletionId: string }).deletionId);
    const { rows: delta48 } = await db.query<{ s: number }>(
      `select extract(epoch from (not_before - requested_at))::int as s from deletion where id = $1`,
      [(outcome48 as { deletionId: string }).deletionId],
    );
    expect(delta48[0]!.s).toBe(172800); // 48 hours

    const slug2 = `camp-${randomUUID().slice(0, 8)}`;
    const campaignId2 = await seedCampaign(db, "local", slug2);
    const outcome0 = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId: campaignId2,
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 0,
    });
    const { rows: delta0 } = await db.query<{ s: number }>(
      `select extract(epoch from (not_before - requested_at))::int as s from deletion where id = $1`,
      [(outcome0 as { deletionId: string }).deletionId],
    );
    expect(delta0[0]!.s).toBe(0);

    // The 48h row is NOT due yet; the 0h row IS due.
    const due = await listDue(db);
    const dueIds = due.map((d) => d.id);
    expect(dueIds).not.toContain(deletion48.id);
    expect(dueIds).toContain((outcome0 as { deletionId: string }).deletionId);
  });

  test("requestCampaignDeletion refuses an active job and writes nothing", async () => {
    const slug = `camp-${randomUUID().slice(0, 8)}`;
    const campaignId = await seedCampaign(db, "local", slug);
    await seedJob(db, {
      id: "j-running",
      orgId: "local",
      campaignId: slug,
      status: "running",
      leaseOffsetMs: 60_000,
    });

    const outcome = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId,
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(outcome).toEqual({ outcome: "active-job", jobId: "j-running" });

    const { rows: campaign } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from campaign where id = $1`,
      [campaignId],
    );
    expect(campaign[0]!.deleted_at).toBeNull();

    const { rows: count } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion`,
    );
    expect(count[0]!.n).toBe(0);
  });

  test("requestCampaignDeletion sees a job keyed by the campaign uuid", async () => {
    const slug = `camp-${randomUUID().slice(0, 8)}`;
    const campaignId = await seedCampaign(db, "local", slug);
    await seedJob(db, {
      id: "j-uuid-running",
      orgId: "local",
      campaignId,
      status: "running",
      leaseOffsetMs: 60_000,
    });

    const outcome = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId,
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(outcome).toEqual({ outcome: "active-job", jobId: "j-uuid-running" });

    const { rows: campaign } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from campaign where id = $1`,
      [campaignId],
    );
    expect(campaign[0]!.deleted_at).toBeNull();
  });

  test("requestCampaignDeletion ignores a settled or expired job", async () => {
    const slug = `camp-${randomUUID().slice(0, 8)}`;
    const campaignId = await seedCampaign(db, "local", slug);
    // A COMPLETED job keyed by slug — not active.
    await seedJob(db, {
      id: "j-completed",
      orgId: "local",
      campaignId: slug,
      status: "completed",
    });
    // A QUEUED job older than QUEUED_TTL_MS — no longer active (reaper-eligible).
    await seedJob(db, {
      id: "j-stale-queued",
      orgId: "local",
      campaignId,
      status: "queued",
      createdAtOffsetMs: -(QUEUED_TTL_MS + 60_000),
    });

    const outcome = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId,
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(outcome).toEqual({ outcome: "requested", deletionId: expect.any(String) });

    const { rows: campaign } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from campaign where id = $1`,
      [campaignId],
    );
    expect(campaign[0]!.deleted_at).not.toBeNull();
  });

  test("requestCampaignDeletion on a tombstoned campaign answers gone and inserts nothing", async () => {
    const slug = `camp-${randomUUID().slice(0, 8)}`;
    const campaignId = await seedCampaign(db, "local", slug);

    const first = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId,
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(first).toEqual({ outcome: "requested", deletionId: expect.any(String) });

    // Second call: the campaign is now tombstoned.
    const second = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId,
      requestedBy: "actor-2",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(second).toEqual({ outcome: "gone" });

    const { rows: count } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion`,
    );
    expect(count[0]!.n).toBe(1);
  });

  test("requestCampaignDeletion answers gone for another org's campaign and a missing campaign", async () => {
    await db.query("insert into org (id, name) values ($1, $2)", ["other", "Other"]);
    const slug = `camp-${randomUUID().slice(0, 8)}`;
    const otherId = await seedCampaign(db, "other", slug);

    // Another org's campaign: `for update` on `(org_id, id)` finds nothing.
    const otherOutcome = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId: otherId,
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(otherOutcome).toEqual({ outcome: "gone" });

    const { rows: otherCampaign } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from campaign where id = $1`,
      [otherId],
    );
    expect(otherCampaign[0]!.deleted_at).toBeNull();

    // A missing uuid: no row matches at all.
    const missing = randomUUID();
    const missingOutcome = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId: missing,
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(missingOutcome).toEqual({ outcome: "gone" });

    const { rows: count } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion`,
    );
    expect(count[0]!.n).toBe(0);
  });

  test("requestCampaignDeletion answers gone for a ref that is not a uuid", async () => {
    const outcome = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId: "not-a-uuid",
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(outcome).toEqual({ outcome: "gone" });

    const { rows: count } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion`,
    );
    expect(count[0]!.n).toBe(0);
  });

  test("requestCampaignDeletion answers forbidden when mayDelete refuses the locked rows team and writes nothing", async () => {
    // Org-wide campaign (team_id null): a member may never delete.
    const orgWideId = await seedCampaign(db, "local", `camp-${randomUUID().slice(0, 8)}`, {
      teamId: null,
    });

    const mayDelete = vi.fn((teamId: string | null) => teamId !== null);

    const orgOutcome = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId: orgWideId,
      requestedBy: "member-1",
      mayDelete,
      graceHours: 0,
    });
    expect(orgOutcome).toEqual({ outcome: "forbidden" });
    expect(mayDelete).toHaveBeenLastCalledWith(null);

    const { rows: orgCampaign } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from campaign where id = $1`,
      [orgWideId],
    );
    expect(orgCampaign[0]!.deleted_at).toBeNull();

    const { rows: countBefore } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion`,
    );
    expect(countBefore[0]!.n).toBe(0);

    // Now a team-scoped campaign: a member of that team MAY delete.
    const teamId = "t1";
    await seedTeam(db, "local", teamId);
    const teamCampaignId = await seedCampaign(db, "local", `camp-${randomUUID().slice(0, 8)}`, {
      teamId,
    });

    const teamOutcome = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId: teamCampaignId,
      requestedBy: "member-1",
      mayDelete,
      graceHours: 0,
    });
    expect(teamOutcome).toEqual({ outcome: "requested", deletionId: expect.any(String) });
    expect(mayDelete).toHaveBeenLastCalledWith(teamId);
  });

  test("requestCampaignDeletion rolls both writes back when the deletion insert fails", async () => {
    const slug = `camp-${randomUUID().slice(0, 8)}`;
    const campaignId = await seedCampaign(db, "local", slug);

    // PGlite is one connection: intercept inside the transaction to force a failure
    // on the `insert into deletion` so both the tombstone and the insert roll back.
    const wrapped: SqlClient = {
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            ...tx,
            query: async (text, params) => {
              if (text.includes("insert into deletion")) throw new Error("boom");
              return tx.query(text, params);
            },
          }),
        ),
    };

    await expect(
      requestCampaignDeletion(wrapped, {
        orgId: "local",
        campaignId,
        requestedBy: "actor-1",
        mayDelete: () => true,
        graceHours: 0,
      }),
    ).rejects.toThrow("boom");

    // The tombstone must NOT have committed: rolled back by the transaction.
    const { rows: campaign } = await db.query<{
      deleted_at: Date | null;
      deleted_by: string | null;
    }>(`select deleted_at, deleted_by from campaign where id = $1`, [campaignId]);
    expect(campaign[0]!.deleted_at).toBeNull();

    const { rows: count } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion`,
    );
    expect(count[0]!.n).toBe(0);
  });
});
