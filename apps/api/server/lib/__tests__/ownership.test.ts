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
import { LOCAL_TENANT } from "../tenant.js";
import {
  getAssetStore,
  getBriefStore,
  getReportStore,
  resetAssetStore,
  resetBriefStore,
  resetReportStore,
} from "../ports/index.js";
import { assertOwnedCampaign, campaignKnown, CampaignNotFoundError } from "../ownership.js";

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
});
