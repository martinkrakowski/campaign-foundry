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
import { sharesCampaignKey } from "../../deletion/purge-campaign.js";

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

const A_SLUG = "a-slug";
const campaignCount = (db: SqlClient, orgId: string) =>
  db.query<{ n: number }>(`select count(*)::int as n from campaign where org_id = $1`, [orgId]).then(
    (r) => r.rows[0]!.n,
  );

const UUID_U = "11111111-1111-4111-8111-111111111111";

describe("PgBriefStore slug-equals-campaign-uuid guard (FU-slug-uuid-409)", () => {
  let db: SqlClient;
  let store: PgBriefStore;

  beforeEach(async () => {
    db = await migratedDatabase();
    store = new PgBriefStore(db, "local", "local");
  });
  afterEach(async () => {
    await db.end();
  });

  test("createBrief refuses a slug equal to a same-org campaign's uuid", async () => {
    const created = await store.createBrief(brief(A_SLUG));

    await expect(store.createBrief(brief(created.campaignId))).rejects.toMatchObject({
      code: "EEXIST",
      message: `Brief "${created.campaignId}" already exists.`,
    });
    expect(await campaignCount(db, "local")).toBe(1);
  });

  test("createCampaign refuses a slug equal to a same-org campaign's uuid", async () => {
    const created = await store.createCampaign(A_SLUG);

    await expect(store.createCampaign(created.campaignId)).rejects.toMatchObject({
      code: "EEXIST",
      message: `Brief "${created.campaignId}" already exists.`,
    });
    expect(await campaignCount(db, "local")).toBe(1);
  });

  test("the refusal also holds against a campaign that already has a saved version", async () => {
    const created = await store.createBrief(brief("slug-a"));

    await expect(store.createBrief(brief(created.campaignId))).rejects.toMatchObject({
      code: "EEXIST",
      message: `Brief "${created.campaignId}" already exists.`,
    });
    expect(await campaignCount(db, "local")).toBe(1);
  });

  test("the refusal also holds against a tombstoned campaign's uuid", async () => {
    const created = await store.createCampaign(A_SLUG);
    await db.query(`update campaign set deleted_at = now() where org_id = $1 and id = $2::uuid`, [
      "local",
      created.campaignId,
    ]);

    await expect(store.createBrief(brief(created.campaignId))).rejects.toMatchObject({
      code: "EEXIST",
      message: `Brief "${created.campaignId}" already exists.`,
    });
    expect(await campaignCount(db, "local")).toBe(1);
  });

  test("the refusal also holds against a campaign the caller's team cannot see", async () => {
    await db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
      ["t1", "Team 1", "local"],
    );
    const { rows } = await db.query<{ id: string }>(
      `insert into campaign (org_id, slug, team_id) values ($1, $2, $3) returning id`,
      ["local", A_SLUG, "t1"],
    );
    const campaignAId = rows[0]!.id;
    const stranger = new PgBriefStore(db, "local", "u3", [], []);

    await expect(stranger.createBrief(brief(campaignAId))).rejects.toMatchObject({
      code: "EEXIST",
      message: `Brief "${campaignAId}" already exists.`,
    });
    expect(await campaignCount(db, "local")).toBe(1);
  });

  test("another organisation's campaign uuid is not a collision", async () => {
    const created = await store.createCampaign(A_SLUG);
    await db.query(`insert into org (id, name) values ($1, $2)`, ["other", "Other"]);
    const otherStore = new PgBriefStore(db, "other", "local");

    const result = await otherStore.createBrief(brief(created.campaignId));
    expect(result.campaignId).toEqual(expect.any(String));
  });

  test("a uuid-shaped slug that matches no campaign is still accepted", async () => {
    const created = await store.createCampaign(UUID_U);

    expect(created).toEqual({ campaignId: expect.any(String), slug: UUID_U });
  });

  test("a first Save onto an existing row whose slug is uuid-shaped still works", async () => {
    // `createCampaign(U)` is accepted: no campaign has id == U yet, so the new
    // check refuses nothing. It mints a row whose slug is the uuid text U and
    // whose `id` is some other random uuid.
    const created = await store.createCampaign(UUID_U);
    expect(created.slug).toBe(UUID_U);

    // The first Save lands on the existing-row branch (on conflict on slug),
    // not the new check: no campaign row has `id == U`, so the check finds no
    // collision and falls through to the grandfathered first-Save path.
    const saved = await store.createBrief(brief(UUID_U));
    expect(saved.brief.id).toBe(UUID_U);

    const { rows } = await db.query<{ version: number }>(
      `select version from brief_version where campaign_id = $1 order by version`,
      [created.campaignId],
    );
    expect(rows.map((r) => r.version)).toEqual([1]);
  });

  test("after a refused create the purge guard has nothing to refuse", async () => {
    const created = await store.createCampaign(A_SLUG);

    // The refused creates in tests 1-4 are what keep a sibling from landing
    // with `slug == this campaign's uuid`; absent that sibling, the purge guard
    // (sharesCampaignKey) finds no key-sharing row for A.
    expect(await sharesCampaignKey(db, "local", created.campaignId, created.slug)).toBe(false);
  });
});
