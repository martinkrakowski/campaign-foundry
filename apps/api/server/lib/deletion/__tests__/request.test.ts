import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import {
  InMemoryObjectStore,
  PublicAdMediaStore,
} from "@campaignfoundry/CampaignOrchestration/infrastructure";
import {
  PublicMediaNotConfiguredError,
  type PublicAdMediaPort,
} from "@campaignfoundry/CampaignOrchestration";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { QUEUED_TTL_MS } from "../../ports/job-store.port.js";
import { setPublicAdMediaClient, resetPublicAdMediaClient } from "../../object-store/index.js";
import { PgPublishedClipStore } from "../../ports/pg-published-clip-store.js";
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

/** The bytes a seeded public object holds — content is irrelevant to these tests. */
const CLIP_BYTES = new Uint8Array([9, 8, 7]);

/** The `PUBLIC_MEDIA_*` variables that gate `publicAdMediaClient()`. */
const PUBLIC_MEDIA_VARS = [
  "PUBLIC_MEDIA_BUCKET",
  "PUBLIC_MEDIA_BASE_URL",
  "PUBLIC_MEDIA_ACCESS_KEY_ID",
  "PUBLIC_MEDIA_SECRET_ACCESS_KEY",
  "PUBLIC_MEDIA_ENDPOINT",
  "PUBLIC_MEDIA_REGION",
] as const;

/** Delete every `PUBLIC_MEDIA_*` variable so `publicAdMediaClient()` is `undefined`. */
function clearPublicMediaEnv(): void {
  for (const name of PUBLIC_MEDIA_VARS) {
    delete process.env[name];
  }
}

/** Restore the `PUBLIC_MEDIA_*` variables a test deleted via `clearPublicMediaEnv`. */
function restorePublicMediaEnv(saved: ReadonlyArray<[string, string | undefined]>): void {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** An in-memory public media double plus the store its bytes land in. */
function configuredMedia(): { media: PublicAdMediaPort; store: InMemoryObjectStore } {
  const store = new InMemoryObjectStore();
  return { media: new PublicAdMediaStore({ store, baseUrl: "https://media.test" }), store };
}

/** A public media double whose every removal throws. */
function failingMedia(): PublicAdMediaPort {
  return {
    publish: async () => {
      throw new Error("not used here");
    },
    remove: async () => {
      throw new Error("boom");
    },
    removeOrg: async () => {
      throw new Error("boom");
    },
    urlFor: (key) => `https://media.test/${key}`,
  };
}

/** Seed one published clip: the public object on `media` plus its ledger row. */
async function seedClip(
  db: SqlClient,
  media: PublicAdMediaPort,
  orgId: string,
  campaignId: string,
  hash: string,
): Promise<void> {
  const published = await media.publish(orgId, CLIP_BYTES, hash);
  await new PgPublishedClipStore(db).record(orgId, campaignId, published.key, published.url, hash);
}

/** Seed a `published_clip` row without touching a real public bucket. */
async function seedClipRow(
  db: SqlClient,
  orgId: string,
  campaignId: string,
  hash: string,
): Promise<void> {
  await db.query(
    `insert into published_clip (org_id, campaign_id, content_hash, key, url)
       values ($1, $2::uuid, $3, $4, $5)`,
    [
      orgId,
      campaignId,
      hash,
      `${orgId}/${"a".repeat(32)}/${hash}.mp4`,
      `https://media.test/${hash}.mp4`,
    ],
  );
}

/** Count a campaign's `published_clip` rows in one org. */
async function clipCount(db: SqlClient, orgId: string, campaignId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from published_clip where org_id = $1 and campaign_id = $2::uuid`,
    [orgId, campaignId],
  );
  return rows[0]!.n;
}

describe("request-campaign-deletion (D235, D234's tombstone half)", () => {
  let db: SqlClient;
  let savedPublicMediaEnv: Array<[string, string | undefined]> = [];

  beforeEach(async () => {
    db = await migratedDatabase();
    savedPublicMediaEnv = PUBLIC_MEDIA_VARS.map((name) => [name, process.env[name]]);
  });
  afterEach(async () => {
    restorePublicMediaEnv(savedPublicMediaEnv);
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

  // PT-4k: the delete request itself unpublishes the campaign's public clips —
  // outside any transaction (D231), once before the tombstone and once after
  // it commits — while a refused request never touches them.
  afterEach(() => {
    resetPublicAdMediaClient();
  });

  test("a forbidden caller or an active-job refusal does not unpublish clips", async () => {
    const { media, store } = configuredMedia();
    setPublicAdMediaClient(media);
    const slug = `camp-${randomUUID().slice(0, 8)}`;
    const campaignId = await seedCampaign(db, "local", slug);
    await seedClip(db, media, "local", campaignId, "a".repeat(64));

    const forbiddenOutcome = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId,
      requestedBy: "member-1",
      mayDelete: () => false,
      graceHours: 0,
    });
    expect(forbiddenOutcome).toEqual({ outcome: "forbidden" });
    expect(await clipCount(db, "local", campaignId)).toBe(1);
    expect(await store.list("local/")).toHaveLength(1);

    await seedJob(db, {
      id: "j-clip",
      orgId: "local",
      campaignId,
      status: "running",
      leaseOffsetMs: 60_000,
    });
    const activeOutcome = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId,
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(activeOutcome).toEqual({ outcome: "active-job", jobId: "j-clip" });
    expect(await clipCount(db, "local", campaignId)).toBe(1);
    expect(await store.list("local/")).toHaveLength(1);
  });

  test("a delete request removes the campaign's public objects and clip rows before any purge", async () => {
    const { media, store } = configuredMedia();
    setPublicAdMediaClient(media);
    const campaignId = await seedCampaign(db, "local", `camp-${randomUUID().slice(0, 8)}`);
    const otherCampaignId = await seedCampaign(db, "local", `camp-${randomUUID().slice(0, 8)}`);
    await db.query("insert into org (id, name) values ($1, $2)", ["other", "Other"]);
    const foreignId = await seedCampaign(db, "other", `camp-${randomUUID().slice(0, 8)}`);

    await seedClip(db, media, "local", campaignId, "a".repeat(64));
    await seedClip(db, media, "local", campaignId, "b".repeat(64));
    await seedClip(db, media, "local", otherCampaignId, "c".repeat(64));
    await seedClip(db, media, "other", foreignId, "d".repeat(64));

    const outcome = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId,
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(outcome).toEqual({ outcome: "requested", deletionId: expect.any(String) });

    // This campaign's clips are gone — both objects and rows.
    expect(await clipCount(db, "local", campaignId)).toBe(0);
    // Another campaign's and another org's clips are intact.
    expect(await clipCount(db, "local", otherCampaignId)).toBe(1);
    expect(await clipCount(db, "other", foreignId)).toBe(1);
    expect(await store.list("local/")).toHaveLength(1);
    expect(await store.list("other/")).toHaveLength(1);

    // The tombstone itself still happened.
    const { rows: campaign } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from campaign where id = $1`,
      [campaignId],
    );
    expect(campaign[0]!.deleted_at).not.toBeNull();
  });

  test("a second pass after the commit removes a clip published between the two passes", async () => {
    const { media, store } = configuredMedia();
    setPublicAdMediaClient(media);
    const campaignId = await seedCampaign(db, "local", `camp-${randomUUID().slice(0, 8)}`);
    await seedClip(db, media, "local", campaignId, "a".repeat(64));

    // Intercept the `listForCampaign` select: before answering its SECOND
    // invocation (pass 2), a concurrent export publishes one more clip. The
    // export's record() ran while the campaign was still live (CFAR6-record:
    // a tombstoned campaign refuses a record), so the seed publishes the
    // public object and inserts the ledger row directly — the row an export
    // that raced the tombstone would have committed just after pass 1 read.
    const LIST_SQL = "from published_clip where org_id = $1 and campaign_id = $2::uuid";
    let listCalls = 0;
    const wrapped: SqlClient = {
      ...db,
      query: async (text, params) => {
        if (text.includes(LIST_SQL)) {
          listCalls += 1;
          if (listCalls === 2) {
            // The export's record() ran while the campaign was still live
            // (CFAR6-record: a tombstoned campaign refuses a record), so the
            // seed publishes the public object and inserts the ledger row the
            // record would have committed — with the object's own key, so the
            // removal below unpublishes the object the row names.
            const published = await media.publish("local", CLIP_BYTES, "e".repeat(64));
            await db.query(
              `insert into published_clip (org_id, campaign_id, content_hash, key, url)
                 values ($1, $2::uuid, $3, $4, $5)`,
              ["local", campaignId, "e".repeat(64), published.key, published.url],
            );
          }
        }
        return db.query(text, params);
      },
    };

    const outcome = await requestCampaignDeletion(wrapped, {
      orgId: "local",
      campaignId,
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(outcome).toEqual({ outcome: "requested", deletionId: expect.any(String) });
    expect(listCalls).toBe(2);

    // BOTH clips — including the one published mid-request — are gone.
    expect(await clipCount(db, "local", campaignId)).toBe(0);
    expect(await store.list("local/")).toHaveLength(0);
  });

  test("an active-job refusal at the precheck leaves every published clip in place", async () => {
    const { media, store } = configuredMedia();
    setPublicAdMediaClient(media);
    const campaignId = await seedCampaign(db, "local", `camp-${randomUUID().slice(0, 8)}`);
    // The job is already active BEFORE the request, so the read-only precheck
    // itself refuses — pass 1 must never run, let alone unpublish anything.
    await seedJob(db, {
      id: "j-live",
      orgId: "local",
      campaignId,
      status: "running",
      leaseOffsetMs: 60_000,
    });
    await seedClip(db, media, "local", campaignId, "a".repeat(64));

    const outcome = await requestCampaignDeletion(db, {
      orgId: "local",
      campaignId,
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 0,
    });
    expect(outcome).toEqual({ outcome: "active-job", jobId: "j-live" });

    // Nothing was tombstoned and no deletion row was written.
    const { rows: campaign } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from campaign where id = $1`,
      [campaignId],
    );
    expect(campaign[0]!.deleted_at).toBeNull();
    const { rows: count } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion`,
    );
    expect(count[0]!.n).toBe(0);

    // Every clip row and every public object is still in place.
    expect(await clipCount(db, "local", campaignId)).toBe(1);
    expect(await store.list("local/")).toHaveLength(1);
  });

  test("a job that becomes active between the two steps is refused at the tombstone; clips pass 1 already removed stay removed", async () => {
    const { media, store } = configuredMedia();
    setPublicAdMediaClient(media);
    const campaignId = await seedCampaign(db, "local", `camp-${randomUUID().slice(0, 8)}`);
    await seedClip(db, media, "local", campaignId, "a".repeat(64));

    // The check transaction (the first) passes, then — its lock released — a
    // job claims the campaign in the gap. The tombstone transaction (the
    // second) must re-run the refusal against that claim. The job row is
    // planted inside the intercepted transaction the same way a claim writes
    // it: under the campaign row's own lock.
    let txCount = 0;
    const wrapped: SqlClient = {
      ...db,
      transaction: (work) =>
        db.transaction(async (tx) => {
          txCount += 1;
          if (txCount === 2) {
            await tx.query(
              `insert into job (id, org_id, campaign_id, status, lease_expires_at, created_at)
                 values ('j-race', 'local', $1::uuid, 'running', now() + interval '60 seconds', now())`,
              [campaignId],
            );
          }
          return work(tx);
        }),
    };

    const outcome = await requestCampaignDeletion(wrapped, {
      orgId: "local",
      campaignId,
      requestedBy: "actor-1",
      mayDelete: () => true,
      graceHours: 0,
    });
    // The race's loser answers `active-job`, never `requested`.
    expect(outcome).toEqual({ outcome: "active-job", jobId: "j-race" });

    // Nothing was tombstoned and no deletion row was written.
    const { rows: campaign } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from campaign where id = $1`,
      [campaignId],
    );
    expect(campaign[0]!.deleted_at).toBeNull();
    const { rows: count } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion`,
    );
    expect(count[0]!.n).toBe(0);

    // Pass 1 already removed the clip before the refusal — that is accepted:
    // the removed object and ledger row stay removed and are re-created on
    // the next explicit export.
    expect(await clipCount(db, "local", campaignId)).toBe(0);
    expect(await store.list("local/")).toHaveLength(0);
  });

  test.each([
    ["tombstoned", `update campaign set deleted_at = now() where id = $1::uuid`],
    ["removed outright", `delete from campaign where id = $1::uuid`],
  ])(
    "a campaign %s between the two steps answers gone and writes no deletion row",
    async (_label, gapStatement) => {
      const { media, store } = configuredMedia();
      setPublicAdMediaClient(media);
      const campaignId = await seedCampaign(db, "local", `camp-${randomUUID().slice(0, 8)}`);
      await seedClip(db, media, "local", campaignId, "b".repeat(64));

      // The first transaction (the check) passes; before the second one takes
      // its lock, another actor removes the campaign.
      let txCount = 0;
      const wrapped: SqlClient = {
        ...db,
        transaction: (work) =>
          db.transaction(async (tx) => {
            txCount += 1;
            if (txCount === 2) await tx.query(gapStatement, [campaignId]);
            return work(tx);
          }),
      };

      const outcome = await requestCampaignDeletion(wrapped, {
        orgId: "local",
        campaignId,
        requestedBy: "actor-1",
        mayDelete: () => true,
        graceHours: 0,
      });
      expect(outcome).toEqual({ outcome: "gone" });

      const { rows: count } = await db.query<{ n: number }>(
        `select count(*)::int as n from deletion`,
      );
      expect(count[0]!.n).toBe(0);
      // Pass 1 ran before the gap, so the clip is gone; pass 2 never ran.
      expect(await clipCount(db, "local", campaignId)).toBe(0);
      expect(await store.list("local/")).toHaveLength(0);
    },
  );

  test("refuses delete request with PublicMediaNotConfiguredError when clips exist and public media is unconfigured", async () => {
    clearPublicMediaEnv();
    resetPublicAdMediaClient();
    const campaignId = await seedCampaign(db, "local", `camp-${randomUUID().slice(0, 8)}`);
    await seedClipRow(db, "local", campaignId, "a".repeat(64));

    await expect(
      requestCampaignDeletion(db, {
        orgId: "local",
        campaignId,
        requestedBy: "actor-1",
        mayDelete: () => true,
        graceHours: 0,
      }),
    ).rejects.toBeInstanceOf(PublicMediaNotConfiguredError);

    // Nothing was written: the campaign, the ledger row, no deletion row.
    const { rows: campaign } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from campaign where id = $1`,
      [campaignId],
    );
    expect(campaign[0]!.deleted_at).toBeNull();
    expect(await clipCount(db, "local", campaignId)).toBe(1);
    const { rows: count } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion`,
    );
    expect(count[0]!.n).toBe(0);
  });

  test("keeps clip record and rolls back delete request when public object removal fails", async () => {
    setPublicAdMediaClient(failingMedia());
    const campaignId = await seedCampaign(db, "local", `camp-${randomUUID().slice(0, 8)}`);
    await seedClipRow(db, "local", campaignId, "a".repeat(64));

    await expect(
      requestCampaignDeletion(db, {
        orgId: "local",
        campaignId,
        requestedBy: "actor-1",
        mayDelete: () => true,
        graceHours: 0,
      }),
    ).rejects.toThrow("boom");

    // The ledger row stays, and neither the tombstone nor the deletion row
    // was written — the whole request is retryable.
    expect(await clipCount(db, "local", campaignId)).toBe(1);
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
});
