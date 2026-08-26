import { describe, test, expect, vi } from "vitest";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { API } from "@/lib/run-context";
import {
  BriefsApiError,
  createBrief,
  duplicateBrief,
  isBriefsApiError,
  listBriefs,
  listPackages,
  packageCampaign,
  planCampaign,
  unknownErrorMessage,
  uploadAsset,
} from "../briefs-api";

const brief: CampaignBrief = {
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [
    { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" },
    { id: "beta", name: "B", primaryColor: "#E0218A", logoPath: "b.png" },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const mockFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response> | never) => {
  vi.mocked(globalThis.fetch).mockImplementation((url, init) =>
    Promise.resolve(handler(String(url), (init ?? {}) as RequestInit)),
  );
};

describe("unknownErrorMessage / isBriefsApiError", () => {
  test("returns the Error message or the fallback", () => {
    expect(unknownErrorMessage(new Error("boom"), "fallback")).toBe("boom");
    expect(unknownErrorMessage("nope", "fallback")).toBe("fallback");
  });

  test("narrows BriefsApiError", () => {
    expect(isBriefsApiError(new BriefsApiError("x", 409))).toBe(true);
    expect(isBriefsApiError(new Error("x"))).toBe(false);
  });
});

describe("listBriefs", () => {
  test("returns the briefs array", async () => {
    mockFetch(() => json({ briefs: [{ file: "camp.yaml", brief }] }));
    await expect(listBriefs()).resolves.toEqual([{ file: "camp.yaml", brief }]);
  });

  test("returns an empty list when the payload is missing or not an object", async () => {
    mockFetch(() => json({}));
    await expect(listBriefs()).resolves.toEqual([]);
    mockFetch(() => new Response("null", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(listBriefs()).resolves.toEqual([]);
  });

  test("throws the API error message", async () => {
    mockFetch(() => json({ error: "nope" }, 500));
    await expect(listBriefs()).rejects.toMatchObject({ message: "nope", status: 500 });
  });
});

describe("createBrief / duplicateBrief / uploadAsset", () => {
  const write = { file: "camp.yaml", brief };

  test("POSTs a create and replace", async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return json(write, 201);
    });
    await expect(createBrief(brief)).resolves.toEqual(write);
    await expect(createBrief(brief, { replace: true })).resolves.toEqual(write);
    expect(urls[0]).toBe(`${API}/campaigns/briefs`);
    expect(urls[1]).toBe(`${API}/campaigns/briefs?replace=1`);
  });

  test("POSTs a duplicate with { newId }", async () => {
    mockFetch((url, init) => {
      expect(url).toBe(`${API}/campaigns/briefs/camp/duplicate`);
      expect(JSON.parse(String(init.body))).toEqual({ newId: "copy" });
      return json({ file: "copy.yaml", brief: { ...brief, id: "copy" } }, 201);
    });
    const result = await duplicateBrief("camp", "copy");
    expect(result.file).toBe("copy.yaml");
    expect(result.brief.id).toBe("copy");
  });

  test("uploads an asset", async () => {
    mockFetch((url, init) => {
      expect(url).toBe(`${API}/campaigns/assets`);
      expect(JSON.parse(String(init.body))).toEqual({
        briefId: "camp",
        name: "logo.png",
        contentBase64: "abc",
      });
      return json({ path: "assets/inputs/camp/logo.png" }, 201);
    });
    await expect(
      uploadAsset({ briefId: "camp", name: "logo.png", contentBase64: "abc" }),
    ).resolves.toEqual({ path: "assets/inputs/camp/logo.png" });
  });

  test("surfaces a 409 { error } and a non-JSON fallback", async () => {
    mockFetch(() => json({ error: 'Brief "camp" already exists.' }, 409));
    await expect(createBrief(brief)).rejects.toMatchObject({
      message: 'Brief "camp" already exists.',
      status: 409,
    });
    mockFetch(() => new Response("<html>", { status: 502 }));
    await expect(createBrief(brief)).rejects.toMatchObject({
      message: "Request failed (HTTP 502)",
      status: 502,
    });
  });

  test("rejects a malformed write or upload body", async () => {
    mockFetch(() => json({ file: 1, brief: null }));
    await expect(createBrief(brief)).rejects.toMatchObject({ message: "Invalid response" });
    mockFetch(() => json({ file: "ok" }));
    await expect(createBrief(brief)).rejects.toMatchObject({ message: "Invalid response" });
    mockFetch(() => json({ file: "ok", brief: null }));
    await expect(createBrief(brief)).rejects.toMatchObject({ message: "Invalid response" });
    mockFetch(() => json(null));
    await expect(createBrief(brief)).rejects.toMatchObject({ message: "Invalid response" });
    mockFetch(() => json({ path: 1 }));
    await expect(uploadAsset({ briefId: "c", name: "a.png", contentBase64: "x" })).rejects.toMatchObject({
      message: "Invalid response",
    });
    mockFetch(() => json(null));
    await expect(uploadAsset({ briefId: "c", name: "a.png", contentBase64: "x" })).rejects.toMatchObject({
      message: "Invalid response",
    });
  });

  test("wraps a network failure", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("offline"));
    await expect(listBriefs()).rejects.toMatchObject({ message: "Network error", status: 0 });
  });

  test("uses a fallback when { error } is empty", async () => {
    mockFetch(() => json({ error: "" }, 400));
    await expect(createBrief(brief)).rejects.toMatchObject({ message: "Request failed (HTTP 400)" });
  });
});

describe("planCampaign", () => {
  const estimate = { creatives: 12, axisProductSize: 36, feasible: true, genaiCalls: 0 };
  const okBody = { policyHash: "abc", seed: 42, estimate, variants: [{ index: 0 }] };

  test("returns the 200 plan", async () => {
    mockFetch(() => json(okBody));
    await expect(planCampaign(brief)).resolves.toEqual({ kind: "ok", ...okBody });
  });

  test("defaults variants to [] and treats a malformed 200 as unavailable", async () => {
    mockFetch(() => json({ policyHash: "abc", seed: 1, estimate }));
    await expect(planCampaign(brief)).resolves.toMatchObject({ kind: "ok", variants: [] });
    mockFetch(() => json({ policyHash: "abc", seed: 1, estimate: { creatives: 1 } }));
    await expect(planCampaign(brief)).resolves.toEqual({ kind: "unavailable" });
    mockFetch(() => json({ policyHash: "abc", seed: 1, estimate: null }));
    await expect(planCampaign(brief)).resolves.toEqual({ kind: "unavailable" });
    mockFetch(() => json({ policyHash: "abc", seed: 1, estimate: 5 }));
    await expect(planCampaign(brief)).resolves.toEqual({ kind: "unavailable" });
    mockFetch(() => new Response("not-json", { status: 200 }));
    await expect(planCampaign(brief)).resolves.toEqual({ kind: "unavailable" });
  });

  test("maps 404 and network failure to unavailable", async () => {
    mockFetch(() => json({ error: "missing" }, 404));
    await expect(planCampaign(brief)).resolves.toEqual({ kind: "unavailable" });
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("offline"));
    await expect(planCampaign(brief)).resolves.toEqual({ kind: "unavailable" });
  });

  test("maps 422 to infeasible, 5xx to unavailable, and other 4xx to the error", async () => {
    mockFetch(() => json({ error: "shortfall: accepted 4 of 100" }, 422));
    await expect(planCampaign(brief)).resolves.toEqual({
      kind: "infeasible",
      error: "shortfall: accepted 4 of 100",
    });
    mockFetch(() => new Response("", { status: 422 }));
    await expect(planCampaign(brief)).resolves.toEqual({
      kind: "infeasible",
      error: "Variation plan is not feasible.",
    });
    mockFetch(() => json({ error: "boom" }, 500));
    await expect(planCampaign(brief)).resolves.toEqual({ kind: "unavailable" });
    mockFetch(() => json({ error: "bad brief" }, 400));
    await expect(planCampaign(brief)).resolves.toEqual({ kind: "infeasible", error: "bad brief" });
    mockFetch(() => new Response("x", { status: 400 }));
    await expect(planCampaign(brief)).resolves.toEqual({
      kind: "infeasible",
      error: "Plan failed (HTTP 400)",
    });
  });
});

describe("packageCampaign / listPackages", () => {
  const item = {
    productId: "alpha",
    aspectRatio: "1:1",
    treatment: "default",
    source: "alpha/1x1.png",
    packagedPath: "packages/camp/instagram-feed/alpha/1x1.png",
    bytes: 12,
    checks: { size: "pass" as const },
  };

  test("POSTs { campaignId, platforms } and returns packaged platforms", async () => {
    mockFetch((url, init) => {
      expect(url).toBe(`${API}/campaigns/package`);
      expect(JSON.parse(String(init.body))).toEqual({ campaignId: "camp", platforms: ["instagram-feed"] });
      return json({
        platforms: [{ platformId: "instagram-feed", items: [item], skipped: 0, manifestPath: "packages/camp/instagram-feed/manifest.json" }],
      });
    });
    await expect(packageCampaign("camp", ["instagram-feed"])).resolves.toEqual({
      platforms: [
        {
          platformId: "instagram-feed",
          items: [item],
          skipped: 0,
          manifestPath: "packages/camp/instagram-feed/manifest.json",
        },
      ],
    });
  });

  test("drops malformed platforms and items", async () => {
    mockFetch(() =>
      json({
        platforms: [
          null,
          1,
          { platformId: 1, items: [] },
          { platformId: "x" },
          {
            platformId: "ok",
            items: [
              item,
              { ...item, checks: { size: "fail" }, packagedPath: "fail.png" },
              { productId: "nope" },
              { ...item, checks: null },
              { ...item, checks: { size: "maybe" } },
              { ...item, bytes: "12" },
              { ...item, productId: 1 },
              null,
            ],
          },
        ],
      }),
    );
    await expect(packageCampaign("camp", ["x"])).resolves.toEqual({
      platforms: [
        {
          platformId: "ok",
          items: [item, { ...item, checks: { size: "fail" }, packagedPath: "fail.png" }],
        },
      ],
    });
    mockFetch(() => json(null));
    await expect(packageCampaign("camp", ["x"])).resolves.toEqual({ platforms: [] });
    mockFetch(() => json({ platforms: "nope" }));
    await expect(packageCampaign("camp", ["x"])).resolves.toEqual({ platforms: [] });
  });

  test("listPackages returns the manifests and treats 404 as empty", async () => {
    mockFetch((url) => {
      expect(url).toBe(`${API}/campaigns/packages/camp`);
      return json({ platforms: [{ platformId: "instagram-feed", items: [item] }] });
    });
    await expect(listPackages("camp")).resolves.toEqual({
      platforms: [{ platformId: "instagram-feed", items: [item] }],
    });
    mockFetch(() => json({ error: "No packages found" }, 404));
    await expect(listPackages("camp")).resolves.toEqual({ platforms: [] });
  });

  test("listPackages throws on network failure and non-404 errors", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("offline"));
    await expect(listPackages("camp")).rejects.toMatchObject({ message: "Network error", status: 0 });
    mockFetch(() => json({ error: "boom" }, 500));
    await expect(listPackages("camp")).rejects.toMatchObject({ message: "boom", status: 500 });
    mockFetch(() => new Response("", { status: 500 }));
    await expect(listPackages("camp")).rejects.toMatchObject({ message: "Request failed (HTTP 500)", status: 500 });
  });

  test("packageCampaign throws on a failed POST", async () => {
    mockFetch(() => json({ error: "Campaign report not found" }, 404));
    await expect(packageCampaign("camp", ["instagram-feed"])).rejects.toMatchObject({
      message: "Campaign report not found",
      status: 404,
    });
  });
});
