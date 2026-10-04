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

  // Fix round (bots) — Qodo: a FK from `draft.user_id` to `"user"(id)` (no
  // `on delete cascade`, unlike Better Auth's own tables) blocked deleting a
  // user who had a saved draft. `user_id` is plain `text` now (matching
  // `brief_version.actor`), so deleting the user succeeds and simply leaves
  // the draft row pointing at an id nothing names any more — the same shape
  // `brief_version.actor` already tolerates.
  test("a user row can be deleted while they have a saved draft", async () => {
    const campaignId = await mintCampaign(db, "local", "camp");
    const store = new PgDraftStore(db, "local");
    await store.writeDraft(campaignId, "u1", { name: "Mine" }, null);
    await expect(db.query('delete from "user" where id = $1', ["u1"])).resolves.toBeDefined();
    // The draft itself survives the user's own deletion (no cascade either
    // way) — reading it back still works.
    await expect(store.readDraft(campaignId, "u1")).resolves.toMatchObject({
      state: { name: "Mine" },
    });
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

    // Fix round (bots) — CodeRabbit, real: this test's OWN prior name and
    // comment claimed to verify the `for update` lock's necessity, but its
    // three steps run strictly sequentially (`getRevision`, then
    // `createBrief`, which fully commits, THEN `writeDraftIfCurrent`) —
    // nothing here is concurrent, so any implementation that simply reads
    // `brief_version` fresh (lock or no lock) passes it. It genuinely
    // exercises one thing: a caller's stale belief (read before a version
    // existed) is never trusted — the write re-derives its own answer
    // rather than accepting a caller-supplied one. That is worth having
    // (it is a DIFFERENT starting state than the test above: "no version
    // yet" versus "an existing version, now superseded"), but it is not,
    // and was never really, a lock test — PGlite's single connection
    // cannot express one (see `withBriefLock`'s own doc comment on the
    // same limitation). The prior comment's claim that a 5th argument
    // "would not even typecheck" was also simply wrong: TypeScript does
    // not check call-site arity against a narrower implementation
    // signature, only assignability to the wider interface type.
    test("refuses when the campaign had no version at all when the caller last checked, and has one now", async () => {
      const campaignId = await mintCampaign(db, "local", "camp");
      const briefs = new PgBriefStore(db, "local", "local");
      const store = new PgDraftStore(db, "local");

      const noVersionYet = (await briefs.getRevision("camp")) ?? null;
      expect(noVersionYet).toBeNull();

      const saved = await briefs.createBrief(sampleBrief("camp"));

      const outcome = await store.writeDraftIfCurrent(campaignId, "u1", { v: 2 }, noVersionYet);
      expect(outcome).toEqual({ ok: false, currentRevision: saved.revision });
      await expect(store.readDraft(campaignId, "u1")).resolves.toBeUndefined();
    });

    // PT-9a1, D231. Called DIRECTLY, bypassing every route gate, because that is
    // the only way to reach the race this check closes: `draft.put.ts` reads
    // `campaignMeta` (itself filtered) and only then calls this, so in production
    // a tombstone has to commit in the gap between those two statements. Here it
    // has already committed, and the id is already in hand — the worst case.
    test("a campaign tombstoned after the id was in hand refuses the write, and writes no draft", async () => {
      const campaignId = await mintCampaign(db, "local", "camp");
      const briefs = new PgBriefStore(db, "local", "local");
      const saved = await briefs.createBrief(sampleBrief("camp"));
      const store = new PgDraftStore(db, "local");
      // The caller's own check would have passed a moment ago — this is a stale
      // `baseRevision`, not an invalid one, so the `ok: false` path below is not
      // what makes this test go red.
      expect(await briefs.getRevision("camp")).toBe(saved.revision);
      await db.query(`update campaign set deleted_at = now() where org_id = $1 and id = $2`, [
        "local",
        campaignId,
      ]);

      await expect(
        store.writeDraftIfCurrent(campaignId, "u1", { edited: true }, saved.revision),
      ).rejects.toThrow();
      // Not merely refused: the insert below the lock never ran, so a silent
      // no-op and a throw would not look the same from the next reader.
      await expect(store.readDraft(campaignId, "u1")).resolves.toBeUndefined();
    });

    // The other half of the same claim, pinned because `readDraft` is
    // deliberately NOT filtered (it is not in this lane's list): every route that
    // reaches the store gates on `campaignMeta` first, so a draft already written
    // stays readable, and D232 step 3 is what removes it.
    test("readDraft on a tombstoned campaign is unaffected — the gate is the route's, not this store's", async () => {
      const campaignId = await mintCampaign(db, "local", "camp");
      const store = new PgDraftStore(db, "local");
      await store.writeDraft(campaignId, "u1", { name: "Mine" }, null);
      await db.query(`update campaign set deleted_at = now() where org_id = $1 and id = $2`, [
        "local",
        campaignId,
      ]);
      await expect(store.readDraft(campaignId, "u1")).resolves.toMatchObject({
        state: { name: "Mine" },
      });
    });
  });
});
