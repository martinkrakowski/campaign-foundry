import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { LOCAL_TENANT } from "../tenant.js";
import { getBriefStore, resetBriefStore } from "../ports/index.js";
import { assertOwnedCampaign, CampaignNotFoundError } from "../ownership.js";

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

describe("assertOwnedCampaign and CampaignNotFoundError (PT-2b item 1)", () => {
  let dir: string;
  const origRoot = process.env.PROJECT_ROOT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-ownership-test-"));
    process.env.PROJECT_ROOT = dir;
    resetBriefStore();
  });

  afterEach(() => {
    resetBriefStore();
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
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
