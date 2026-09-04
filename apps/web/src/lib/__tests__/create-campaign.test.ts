import { describe, test, expect, vi, afterEach } from "vitest";
import { CREATE_SEED_KEY, createCampaign, subscribeToSeed, takeSeed } from "../create-campaign";
import { BriefsApiError } from "../briefs-api";
import { API } from "@/lib/run-context";
import { EMPTY_REPORT, json, mockPipelineApi } from "@/__tests__/helpers";

const seed = { name: "Summer Spark", targetRegion: "EU", targetAudience: "trail runners", mode: "brief" as const };

afterEach(() => {
  localStorage.clear();
});

describe("createCampaign (D65 — the seam)", () => {
  test("resolves with the wave-1 result: no id, the blank route", async () => {
    await expect(createCampaign(seed)).resolves.toEqual({ id: "", route: "/brief/new" });
  });

  test("publishes the seed under cf:create-seed and notifies subscribers", async () => {
    const listener = vi.fn();
    const stop = subscribeToSeed(listener);
    await createCampaign(seed);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(CREATE_SEED_KEY) as string)).toEqual(seed);
    stop();
  });

  test("a dropped subscription is not notified", async () => {
    const listener = vi.fn();
    subscribeToSeed(listener)();
    await createCampaign(seed);
    expect(listener).not.toHaveBeenCalled();
  });

  test("a blocked store still resolves, does not notify, and reports the failed write", async () => {
    const listener = vi.fn();
    const stop = subscribeToSeed(listener);
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      await expect(createCampaign(seed)).resolves.toBeNull();
      expect(listener).not.toHaveBeenCalled();
      expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    } finally {
      setItem.mockRestore();
      stop();
    }
  });
});

describe("createCampaign with a source (W2 / D71 — the duplicate path)", () => {
  const fromSource = { ...seed, source: "winter-wild" };

  test("duplicates the source with the dialog's overrides and returns the copy's route", async () => {
    mockPipelineApi({
      result: () => json(EMPTY_REPORT),
      post: (url, init) => {
        expect(url).toBe(`${API}/campaigns/briefs/winter-wild/duplicate`);
        // The copy's id is derived here from the name; the dialog's region and
        // audience ride as the route's overrides.
        expect(JSON.parse(String(init.body))).toEqual({
          newId: "summer-spark",
          overrides: { targetRegion: "EU", targetAudience: "trail runners" },
        });
        return json({ file: "summer-spark.yaml", brief: { id: "summer-spark", products: [] } }, 201);
      },
    });
    await expect(createCampaign(fromSource)).resolves.toEqual({
      id: "summer-spark",
      route: "/brief/summer-spark",
    });
  });

  test("publishes no seed on the source path — the seed is the blank route's alone", async () => {
    mockPipelineApi({ post: () => json({ file: "x.yaml", brief: { id: "x", products: [] } }, 201) });
    const listener = vi.fn();
    const stop = subscribeToSeed(listener);
    await createCampaign(fromSource);
    // A source create lands on /brief/<newId>, where no editor spends the seed —
    // a key left alive would let the next /brief/new visit load blank over and
    // purge the draft there (the bug W3 / #186 closed).
    expect(listener).not.toHaveBeenCalled();
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    stop();
  });

  test("a refused duplicate rejects with the API's error — never the null contract", async () => {
    mockPipelineApi({ post: () => json({ error: 'Brief "summer-spark" already exists.' }, 409) });
    const err: unknown = await createCampaign(fromSource).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(BriefsApiError);
    expect((err as BriefsApiError).status).toBe(409);
  });
});

describe("takeSeed — the baton is spent by a read", () => {
  test("returns the payload and clears the key, once", async () => {
    await createCampaign(seed);
    expect(takeSeed()).toEqual(seed);
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    expect(takeSeed()).toBeNull();
  });

  test("answers null when no seed was published", () => {
    expect(takeSeed()).toBeNull();
  });

  test("answers null on a key a hand-edited store corrupted", () => {
    localStorage.setItem(CREATE_SEED_KEY, "{not json");
    expect(takeSeed()).toBeNull();
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
  });

  // A parse is not a check: syntactically valid JSON that is not a seed must
  // still spend the key, so a bad baton cannot poison the next mount.
  test.each([
    ["a non-string field", { name: 42, targetRegion: "EU", targetAudience: "trail runners", mode: "brief" }],
    ["a missing field", { name: "Summer Spark", targetRegion: "EU", mode: "brief" }],
    ["an unknown mode", { name: "Summer Spark", targetRegion: "EU", targetAudience: "trail runners", mode: "classic" }],
    ["a JSON array", ["Summer Spark", "EU"]],
    ["a bare string", "Summer Spark"],
  ] as const)("answers null on %s and still spends the key", (_label, value) => {
    localStorage.setItem(CREATE_SEED_KEY, JSON.stringify(value));
    expect(takeSeed()).toBeNull();
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
  });
});
