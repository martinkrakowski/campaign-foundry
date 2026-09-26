import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { resetProjectRoot } from "@campaignfoundry/shared";
import type { SqlClient } from "../db/sql-client.js";
import { migratedDatabase } from "../db/__tests__/pglite-client.js";
import { resetDatabase, setDatabase } from "../db/database.js";
import { LOCAL_TENANT, type TenantContext } from "../tenant.js";
import {
  getAssetStore,
  getBriefStore,
  getReportStore,
  resetAssetStore,
  resetBriefStore,
  resetReportStore,
} from "../ports/index.js";
import { PgBriefStore } from "../ports/pg-brief-store.js";
import {
  assertOwnedCampaign,
  campaignKnown,
  canAssignTeam,
  CampaignNotFoundError,
} from "../ownership.js";

const sampleBrief: CampaignBrief = {
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "camp",
  mode: "brief",
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: "logo.png" }],
  treatments: [{ id: "bold", layout: "headline-bottom", tone: "bold" }],
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("assertOwnedCampaign and CampaignNotFoundError (PT-2b item 1)", () => {
  let dir: string;
  const origRoot = process.env.PROJECT_ROOT;

  beforeEach(() => {
    resetProjectRoot();
    dir = mkdtempSync(join(tmpdir(), "cf-ownership-test-"));
    process.env.PROJECT_ROOT = dir;
    resetBriefStore();
  });

  afterEach(() => {
    resetBriefStore();
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    resetProjectRoot();
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws CampaignNotFoundError with statusCode 404 when campaign is missing", async () => {
    const error = await assertOwnedCampaign(LOCAL_TENANT, "missing").catch((err) => err);
    expect(error).toBeInstanceOf(CampaignNotFoundError);
    expect(error.statusCode).toBe(404);
    expect(error.status).toBe(404);
    expect(error.campaignId).toBe("missing");
    expect(error.message).toBe('Campaign "missing" not found');
  });

  test("returns the stored brief when campaign exists for scope", async () => {
    await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
    const found = await assertOwnedCampaign(LOCAL_TENANT, "camp");
    expect(found.brief.id).toBe("camp");
    expect(found.file).toBe("camp.yaml");
  });
});

describe("campaignKnown (Rule A and L1)", () => {
  let dir: string;
  const origRoot = process.env.PROJECT_ROOT;

  beforeEach(() => {
    resetProjectRoot();
    dir = mkdtempSync(join(tmpdir(), "cf-campaign-known-test-"));
    process.env.PROJECT_ROOT = dir;
    resetBriefStore();
    resetReportStore();
    resetAssetStore();
  });

  afterEach(() => {
    resetBriefStore();
    resetReportStore();
    resetAssetStore();
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    resetProjectRoot();
    rmSync(dir, { recursive: true, force: true });
  });

  test("succeeds for an unsaved draft that has a report on disk without brief (H1, kind=report)", async () => {
    await getReportStore(LOCAL_TENANT).writeReport("unsaved", JSON.stringify({ assets: [] }));
    const briefStore = getBriefStore(LOCAL_TENANT);
    const findSpy = vi.spyOn(briefStore, "findBriefById");

    await expect(campaignKnown(LOCAL_TENANT, "unsaved", "report")).resolves.toBeUndefined();
    // L1: cheap read succeeded, brief store scan was NOT called
    expect(findSpy).not.toHaveBeenCalled();
  });

  test("falls back to findBriefById when report is missing, succeeds if brief exists (kind=report)", async () => {
    await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
    const briefStore = getBriefStore(LOCAL_TENANT);
    const findSpy = vi.spyOn(briefStore, "findBriefById");

    await expect(campaignKnown(LOCAL_TENANT, "camp", "report")).resolves.toBeUndefined();
    expect(findSpy).toHaveBeenCalledWith("camp");
  });

  test("throws CampaignNotFoundError when neither report nor brief exists (kind=report)", async () => {
    await expect(campaignKnown(LOCAL_TENANT, "missing", "report")).rejects.toThrow(
      CampaignNotFoundError,
    );
  });

  test("succeeds for an unsaved draft that has an asset without brief (H5, kind=asset)", async () => {
    await getAssetStore(LOCAL_TENANT).writeAsset("unsaved-asset", "logo.png", PNG);
    const briefStore = getBriefStore(LOCAL_TENANT);
    const findSpy = vi.spyOn(briefStore, "findBriefById");

    await expect(campaignKnown(LOCAL_TENANT, "unsaved-asset", "asset")).resolves.toBeUndefined();
    // L1: cheap read succeeded, brief store scan was NOT called
    expect(findSpy).not.toHaveBeenCalled();
  });

  test("falls back to findBriefById when asset is missing, succeeds if brief exists (kind=asset)", async () => {
    await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
    const briefStore = getBriefStore(LOCAL_TENANT);
    const findSpy = vi.spyOn(briefStore, "findBriefById");

    await expect(campaignKnown(LOCAL_TENANT, "camp", "asset")).resolves.toBeUndefined();
    expect(findSpy).toHaveBeenCalledWith("camp");
  });

  test("throws CampaignNotFoundError when neither asset nor brief exists (kind=asset)", async () => {
    await expect(campaignKnown(LOCAL_TENANT, "missing", "asset")).rejects.toThrow(
      CampaignNotFoundError,
    );
  });

  test("succeeds when kind is omitted and report exists", async () => {
    await getReportStore(LOCAL_TENANT).writeReport("draft-report", JSON.stringify({ assets: [] }));
    await expect(campaignKnown(LOCAL_TENANT, "draft-report")).resolves.toBeUndefined();
  });

  test("succeeds when kind is omitted and asset exists (no report)", async () => {
    await getAssetStore(LOCAL_TENANT).writeAsset("draft-asset", "logo.png", PNG);
    await expect(campaignKnown(LOCAL_TENANT, "draft-asset")).resolves.toBeUndefined();
  });

  test("succeeds when kind is omitted and stored brief exists (no report, no asset)", async () => {
    await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
    await expect(campaignKnown(LOCAL_TENANT, "camp")).resolves.toBeUndefined();
  });

  test("throws CampaignNotFoundError when kind is omitted and nothing exists", async () => {
    await expect(campaignKnown(LOCAL_TENANT, "missing")).rejects.toThrow(CampaignNotFoundError);
  });

  test("falls back to findBriefById when report revision throws (kind=report)", async () => {
    await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
    const reportStore = getReportStore(LOCAL_TENANT);
    vi.spyOn(reportStore, "getRevision").mockRejectedValueOnce(new Error("read failed"));

    await expect(campaignKnown(LOCAL_TENANT, "camp", "report")).resolves.toBeUndefined();
  });

  test("falls back to findBriefById when listAssets throws (kind=asset)", async () => {
    await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
    const assetStore = getAssetStore(LOCAL_TENANT);
    vi.spyOn(assetStore, "listAssets").mockRejectedValueOnce(new Error("read failed"));

    await expect(campaignKnown(LOCAL_TENANT, "camp", "asset")).resolves.toBeUndefined();
  });

  test("falls back when kind is omitted and scoped reads throw", async () => {
    await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
    const reportStore = getReportStore(LOCAL_TENANT);
    vi.spyOn(reportStore, "getRevision").mockRejectedValueOnce(new Error("read failed"));
    const assetStore = getAssetStore(LOCAL_TENANT);
    vi.spyOn(assetStore, "listAssets").mockRejectedValueOnce(new Error("read failed"));

    await expect(campaignKnown(LOCAL_TENANT, "camp")).resolves.toBeUndefined();
  });

  // A storage failure must surface, not be masked as "campaign not found" (greptile,
  // PR #601 thread on ownership.ts:73): an unsaved draft has no stored brief by
  // design, so if the scoped read that would have proven it exists rejects instead
  // of cleanly answering "not stored", falling through to the brief check and then
  // to CampaignNotFoundError would turn a real 500 into a false 404 — and the web
  // client already treats that 404 as "no run" / "no decisions".
  test("surfaces the original error when report read fails and no brief exists (kind=report)", async () => {
    const reportStore = getReportStore(LOCAL_TENANT);
    const readError = new Error("connection reset");
    vi.spyOn(reportStore, "getRevision").mockRejectedValueOnce(readError);

    await expect(campaignKnown(LOCAL_TENANT, "unsaved", "report")).rejects.toBe(readError);
  });

  test("surfaces the original error when listAssets fails and no brief exists (kind=asset)", async () => {
    const assetStore = getAssetStore(LOCAL_TENANT);
    const readError = new Error("connection reset");
    vi.spyOn(assetStore, "listAssets").mockRejectedValueOnce(readError);

    await expect(campaignKnown(LOCAL_TENANT, "unsaved", "asset")).rejects.toBe(readError);
  });

  test("surfaces the first error when kind is omitted, both scoped reads fail, and no brief exists", async () => {
    const reportStore = getReportStore(LOCAL_TENANT);
    const assetStore = getAssetStore(LOCAL_TENANT);
    const reportError = new Error("report read failed");
    vi.spyOn(reportStore, "getRevision").mockRejectedValueOnce(reportError);
    vi.spyOn(assetStore, "listAssets").mockRejectedValueOnce(new Error("asset read failed"));

    await expect(campaignKnown(LOCAL_TENANT, "unsaved")).rejects.toBe(reportError);
  });
});

describe("canAssignTeam (D166, PT-2c item 3)", () => {
  test("owner and admin may assign any team, including one the caller has no membership in", () => {
    expect(
      canAssignTeam({ orgId: "local", userId: "u", roles: ["owner"], teamIds: [] }, "t9"),
    ).toBe(true);
    expect(
      canAssignTeam({ orgId: "local", userId: "u", roles: ["admin"], teamIds: [] }, "t9"),
    ).toBe(true);
  });

  test("a plain member may assign only a team they belong to", () => {
    const tenant: TenantContext = { orgId: "local", userId: "u", roles: [], teamIds: ["t1"] };
    expect(canAssignTeam(tenant, "t1")).toBe(true);
    expect(canAssignTeam(tenant, "t2")).toBe(false);
  });
});

describe("campaignKnown hides a team-restricted campaign even when a report exists (D166, PT-2c item 4)", () => {
  const savedBackend = process.env.STORE_BACKEND;
  let db: SqlClient;

  beforeEach(async () => {
    db = await migratedDatabase();
    setDatabase(db);
    process.env.STORE_BACKEND = "postgres";
    resetBriefStore();
    resetReportStore();
    await db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values ($1, $2, 0, $3, now())`,
      ["t2", "Team Two", "local"],
    );
  });

  afterEach(async () => {
    resetBriefStore();
    resetReportStore();
    resetDatabase();
    if (savedBackend === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = savedBackend;
    await db.end();
  });

  test('GET result\'s campaignKnown(..., "report") answers 404 for a campaign hidden by team', async () => {
    const owner: TenantContext = { orgId: "local", userId: "owner", roles: ["owner"], teamIds: [] };
    const ownerStore = getBriefStore(owner);
    expect(ownerStore).toBeInstanceOf(PgBriefStore);
    await (ownerStore as PgBriefStore).createBriefWithTeam({ ...sampleBrief, id: "t2-camp" }, "t2");
    await getReportStore(owner).writeReport("t2-camp", JSON.stringify({ assets: [] }));

    // Sanity: the owner (sees every team) reads it as known.
    await expect(campaignKnown(owner, "t2-camp", "report")).resolves.toBeUndefined();

    // A caller in a different team cannot see the campaign, even though the
    // report is right there in the org's scope.
    const outsider: TenantContext = {
      orgId: "local",
      userId: "u2",
      roles: [],
      teamIds: ["t1"],
    };
    await expect(campaignKnown(outsider, "t2-camp", "report")).rejects.toThrow(
      CampaignNotFoundError,
    );
  });

  test("an unsaved draft with only a report (no campaign row at all) still reads as known", async () => {
    await getReportStore(LOCAL_TENANT).writeReport("draft-only", JSON.stringify({ assets: [] }));
    await expect(campaignKnown(LOCAL_TENANT, "draft-only", "report")).resolves.toBeUndefined();
  });

  // A failure inside hiddenFromCaller (a dropped connection, say) must fold into
  // the same readFailure the report/asset checks use, not become a false 404 —
  // and must not stop the report/asset fast path from still answering "known".
  test("a hiddenFromCaller failure does not turn a known campaign into a false 404", async () => {
    const owner: TenantContext = { orgId: "local", userId: "owner", roles: ["owner"], teamIds: [] };
    await (getBriefStore(owner) as PgBriefStore).createBrief({ ...sampleBrief, id: "flaky" });
    await getReportStore(owner).writeReport("flaky", JSON.stringify({ assets: [] }));
    vi.spyOn(PgBriefStore.prototype, "hiddenFromCaller").mockRejectedValueOnce(
      new Error("connection reset"),
    );

    await expect(campaignKnown(owner, "flaky", "report")).resolves.toBeUndefined();
  });
});
