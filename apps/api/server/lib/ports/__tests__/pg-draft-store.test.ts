import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
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

function sampleBrief(id: string): CampaignBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id,
    targetRegion: "US",
    targetAudience: "developers",
    campaignMessage: "Build faster",
    products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: "logo.png" }],
  };
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

  test("listDraftsByRecency answers an empty list for a user with no drafts", async () => {
    const store = new PgDraftStore(db, "local");
    await expect(store.listDraftsByRecency("u1")).resolves.toEqual([]);
  });

  test("listDraftsByRecency answers every draft, newest first, across campaigns", async () => {
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
    const list = await store.listDraftsByRecency("u1");
    expect(list.map((d) => d.campaignId)).toEqual([newer, older]);
  });

  test("listDraftsByRecency never mixes in another user's drafts", async () => {
    const campaignId = await mintCampaign(db, "local", "camp");
    const store = new PgDraftStore(db, "local");
    await store.writeDraft(campaignId, "u2", { name: "Theirs" }, null);
    await expect(store.listDraftsByRecency("u1")).resolves.toEqual([]);
  });

  describe("writeDraftIfCurrent (fix round item 2, grok-4.7)", () => {
    test("writes and answers ok:true when baseRevision matches the campaign's current revision", async () => {
      const campaignId = await mintCampaign(db, "local", "camp");
      const briefs = new PgBriefStore(db, "local", "local");
      const saved = await briefs.createBrief(sampleBrief("camp"));
      const store = new PgDraftStore(db, "local");

      const outcome = await store.writeDraftIfCurrent(
        campaignId,
        "u1",
        { edited: true },
        saved.revision,
      );
      expect(outcome).toEqual({
        ok: true,
        draft: expect.objectContaining({ state: { edited: true }, baseRevision: saved.revision }),
      });
      await expect(store.readDraft(campaignId, "u1")).resolves.toMatchObject({
        state: { edited: true },
      });
    });

    test("a versionless campaign's null baseRevision matches its null current revision", async () => {
      const campaignId = await mintCampaign(db, "local", "camp");
      const store = new PgDraftStore(db, "local");
      const outcome = await store.writeDraftIfCurrent(campaignId, "u1", { x: 1 }, null);
      expect(outcome.ok).toBe(true);
    });

    test("refuses without writing when baseRevision no longer matches, and reports the current one", async () => {
      const campaignId = await mintCampaign(db, "local", "camp");
      const briefs = new PgBriefStore(db, "local", "local");
      const saved = await briefs.createBrief(sampleBrief("camp"));
      const store = new PgDraftStore(db, "local");

      const outcome = await store.writeDraftIfCurrent(
        campaignId,
        "u1",
        { edited: true },
        "not-the-real-revision",
      );
      expect(outcome).toEqual({ ok: false, currentRevision: saved.revision });
      await expect(store.readDraft(campaignId, "u1")).resolves.toBeUndefined();
    });

    test("refuses when the caller's own pre-check was already stale by the time this runs — the predicate is IN the write, not trusted from a caller-supplied currentRevision", async () => {
      const campaignId = await mintCampaign(db, "local", "camp");
      const briefs = new PgBriefStore(db, "local", "local");
      const store = new PgDraftStore(db, "local");

      // The caller's own belief: no version exists yet (what a PUT /draft
      // route's pre-check would have read a moment before this call).
      const staleBelief = (await briefs.getRevision("camp")) ?? null;
      expect(staleBelief).toBeNull();

      // A save commits a real version — the race window the old
      // check-then-upsert PUT route left open, simulated here by landing it
      // between the caller's belief and the store call that acts on it.
      const saved = await briefs.createBrief(sampleBrief("camp"));

      // The write must see the FRESH revision, not the stale null the
      // caller observed earlier — it never even receives that stale value
      // (this method's own signature drops the interface's
      // `currentRevision` parameter and re-derives it inside its own
      // locked transaction), so passing `staleBelief` here would not even
      // typecheck as an argument this call reads.
      const outcome = await store.writeDraftIfCurrent(campaignId, "u1", { v: 2 }, staleBelief);
      expect(outcome).toEqual({ ok: false, currentRevision: saved.revision });
      await expect(store.readDraft(campaignId, "u1")).resolves.toBeUndefined();
    });
  });
});
