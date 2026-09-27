import { describe, test, expect } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { getBriefStore } from "../../lib/ports/index.js";
import resultGetHandler from "../campaigns/result.get.js";
import { LOCAL_TENANT, mountTenantRoute, setupPgHarness } from "./tenant-harness.js";

const sampleBrief: CampaignBrief = {
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "camp-gap-test",
  mode: "brief",
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: "logo.png" }],
  treatments: [{ id: "bold", layout: "headline-bottom", tone: "bold" }],
};

describe("PT-5b1: routes take campaign refs", () => {
  test("GET /campaigns/result succeeds by slug but fails by uuid today (demonstrating gap)", async () => {
    const harness = await setupPgHarness();
    try {
      const stored = await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
      expect(stored.campaignId).toBeDefined();
      expect(stored.brief.id).toBe("camp-gap-test");

      const call = mountTenantRoute(resultGetHandler, {
        path: "/campaigns/result",
        tenant: LOCAL_TENANT,
      });

      // By slug: succeeds with 200 and empty report
      const resBySlug = await call(new Request("http://x/campaigns/result?campaignId=camp-gap-test"));
      expect(resBySlug.status).toBe(200);

      // By uuid: today this fails with 404 because GET /campaigns/result does not resolve uuid to slug!
      const resByUuid = await call(new Request(`http://x/campaigns/result?campaignId=${stored.campaignId}`));
      // Demonstrating the gap: route fails to resolve uuid ref to slug
      expect(resByUuid.status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });
});
