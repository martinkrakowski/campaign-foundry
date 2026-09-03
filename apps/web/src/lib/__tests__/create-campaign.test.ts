import { describe, test, expect, vi, afterEach } from "vitest";
import { CREATE_SEED_KEY, createCampaign, subscribeToSeed, takeSeed } from "../create-campaign";

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

  test("a blocked store still resolves and still notifies", async () => {
    const listener = vi.fn();
    const stop = subscribeToSeed(listener);
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await expect(createCampaign(seed)).resolves.toEqual({ id: "", route: "/brief/new" });
    expect(listener).toHaveBeenCalledTimes(1);
    setItem.mockRestore();
    stop();
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
});
