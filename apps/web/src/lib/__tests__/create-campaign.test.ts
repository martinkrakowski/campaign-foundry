import { describe, test, expect } from "vitest";
import { createCampaign } from "../create-campaign";
import { BriefsApiError } from "../briefs-api";
import { API } from "@/lib/run-context";
import { json, mockPipelineApi } from "@/__tests__/helpers";

const seed = { name: "Summer Spark", type: "social-post" as const };

describe("createCampaign — POST /campaigns (D177, D178)", () => {
  test("mints a blank campaign and answers its server-minted id", async () => {
    mockPipelineApi({
      post: (url, init) => {
        expect(url).toBe(`${API}/campaigns`);
        expect(JSON.parse(String(init.body))).toEqual(seed);
        return json({ campaignId: "c1", slug: "summer-spark" }, 201);
      },
    });
    await expect(createCampaign(seed)).resolves.toEqual({ campaignId: "c1" });
  });

  test("a refused create rejects with the API's error — never a null contract", async () => {
    mockPipelineApi({
      post: () => json({ error: '"name" must contain at least one letter or digit.' }, 400),
    });
    const err: unknown = await createCampaign(seed).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(BriefsApiError);
    expect((err as BriefsApiError).status).toBe(400);
  });
});

describe("createCampaign with a source (W2 / D71)", () => {
  const fromSource = { ...seed, source: "winter-wild" };

  test("sends the source and answers the copy's id", async () => {
    mockPipelineApi({
      post: (url, init) => {
        expect(url).toBe(`${API}/campaigns`);
        expect(JSON.parse(String(init.body))).toEqual(fromSource);
        return json({ campaignId: "c2", slug: "summer-spark", revision: "rev-1" }, 201);
      },
    });
    await expect(createCampaign(fromSource)).resolves.toEqual({ campaignId: "c2" });
  });

  test("a refused sourced create rejects with the API's error", async () => {
    mockPipelineApi({ post: () => json({ error: 'Brief "winter-wild" not found.' }, 404) });
    const err: unknown = await createCampaign(fromSource).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(BriefsApiError);
    expect((err as BriefsApiError).status).toBe(404);
  });
});
