import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { PgBriefStore } from "../pg-brief-store.js";
import { PgDraftStore } from "../pg-draft-store.js";

async function insertUser(db: SqlClient, id: string, email: string): Promise<void> {
  await db.query(
    'insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $1, $2, true, now(), now())',
    [id, email],
  );
}

/** Mint a campaign row through the real port, the same way every caller does. */
async function mintCampaign(db: SqlClient, orgId: string, slug: string): Promise<string> {
  const { campaignId } = await new PgBriefStore(db, orgId, "local").createCampaign(slug);
  return campaignId;
}

describe("PgDraftStore (PT-5d, D173, D177)", () => {
  let db: SqlClient;
  beforeEach(async () => {
    db = await migratedDatabase();
    await insertUser(db, "u1", "u1@example.com");
    await insertUser(db, "u2", "u2@example.com");
  });
  afterEach(async () => {
    await db.end();
  });

  test("a campaign with no draft for this user reads as undefined", async () => {
    const campaignId = await mintCampaign(db, "local", "camp");
    const store = new PgDraftStore(db, "local");
    await expect(store.readDraft(campaignId, "u1")).resolves.toBeUndefined();
  });

  test("a draft round-trips its state and base revision", async () => {
    const campaignId = await mintCampaign(db, "local", "camp");
    const store = new PgDraftStore(db, "local");
    const written = await store.writeDraft(campaignId, "u1", { name: "Draft" }, "rev-1");
    expect(written.state).toEqual({ name: "Draft" });
    expect(written.baseRevision).toBe("rev-1");
    expect(typeof written.updatedAt).toBe("string");
    // The store's own clock, rendered the same ISO shape every port answers
    // (`PgDecisionStore`'s `to_char`) — never a JS `Date` object leaking out.
    expect(written.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const read = await store.readDraft(campaignId, "u1");
    expect(read).toEqual(written);
  });

  test("a versionless campaign's draft carries a null base revision", async () => {
    const campaignId = await mintCampaign(db, "local", "camp");
    const store = new PgDraftStore(db, "local");
    const written = await store.writeDraft(campaignId, "u1", { name: "Blank" }, null);
    expect(written.baseRevision).toBeNull();
    expect((await store.readDraft(campaignId, "u1"))?.baseRevision).toBeNull();
  });

  test("a second write replaces the draft in place, not a new row", async () => {
    const campaignId = await mintCampaign(db, "local", "camp");
    const store = new PgDraftStore(db, "local");
    await store.writeDraft(campaignId, "u1", { name: "First" }, "rev-1");
    const second = await store.writeDraft(campaignId, "u1", { name: "Second" }, "rev-1");
    const read = await store.readDraft(campaignId, "u1");
    expect(read).toEqual(second);
    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from draft where campaign_id = $1 and user_id = $2",
      [campaignId, "u1"],
    );
    expect(rows[0]!.count).toBe("1");
  });

  test("two users' drafts on the same campaign are independent", async () => {
    const campaignId = await mintCampaign(db, "local", "camp");
    const store = new PgDraftStore(db, "local");
    await store.writeDraft(campaignId, "u1", { name: "Mine" }, null);
    await store.writeDraft(campaignId, "u2", { name: "Theirs" }, null);
    expect((await store.readDraft(campaignId, "u1"))?.state).toEqual({ name: "Mine" });
    expect((await store.readDraft(campaignId, "u2"))?.state).toEqual({ name: "Theirs" });
    await store.deleteDraft(campaignId, "u1");
    expect(await store.readDraft(campaignId, "u1")).toBeUndefined();
    expect((await store.readDraft(campaignId, "u2"))?.state).toEqual({ name: "Theirs" });
  });

  test("deleting an absent draft is a no-op", async () => {
    const campaignId = await mintCampaign(db, "local", "camp");
    const store = new PgDraftStore(db, "local");
    await expect(store.deleteDraft(campaignId, "u1")).resolves.toBeUndefined();
  });

  test("another org's drafts are invisible", async () => {
    await db.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
    await db.query(
      "insert into member (id, org_id, user_id, role, created_at) values ($1, 'acme', $2, 'owner', now())",
      ["m1", "u1"],
    );
    const campaignId = await mintCampaign(db, "local", "camp");
    const acmeStore = new PgDraftStore(db, "acme");
    const localStore = new PgDraftStore(db, "local");
    await localStore.writeDraft(campaignId, "u1", { name: "Local" }, null);
    // acme's own store never sees local's campaign row at all (no campaign of
    // that id exists for acme), so a read for the same campaignId is still
    // undefined — org scoping, not a coincidence of a missing campaign.
    await expect(acmeStore.readDraft(campaignId, "u1")).resolves.toBeUndefined();
  });

  test("latestDraft answers undefined for a user with no drafts", async () => {
    const store = new PgDraftStore(db, "local");
    await expect(store.latestDraft("u1")).resolves.toBeUndefined();
  });

  test("latestDraft answers the most recently written draft across campaigns", async () => {
    const older = await mintCampaign(db, "local", "older");
    const newer = await mintCampaign(db, "local", "newer");
    const store = new PgDraftStore(db, "local");
    await store.writeDraft(older, "u1", { name: "Older" }, null);
    // Force a distinct, later timestamp rather than relying on wall-clock
    // drift between two `now()` calls in the same test.
    await db.query(
      "update draft set updated_at = now() - interval '1 hour' where campaign_id = $1",
      [older],
    );
    await store.writeDraft(newer, "u1", { name: "Newer" }, null);
    const latest = await store.latestDraft("u1");
    expect(latest?.campaignId).toBe(newer);
  });

  test("latestDraft never mixes in another user's drafts", async () => {
    const campaignId = await mintCampaign(db, "local", "camp");
    const store = new PgDraftStore(db, "local");
    await store.writeDraft(campaignId, "u2", { name: "Theirs" }, null);
    await expect(store.latestDraft("u1")).resolves.toBeUndefined();
  });
});
