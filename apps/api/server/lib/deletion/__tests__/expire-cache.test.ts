import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import type { ObjectStorePort } from "@campaignfoundry/CampaignOrchestration";
import { ObjectBackgroundCache } from "@campaignfoundry/CreativeGeneration";
import {
  CACHE_TTL_MS,
  cacheObjectKey,
  describeCachePlan,
  expireCache,
  planCacheExpiry,
} from "../expire-cache.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const D3 = "c".repeat(64);
const C1 = "c1c1c1c1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const A1 = "a1a1a1a1-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("cache expiry (D242)", () => {
  let clock = NOW;
  let store: InMemoryObjectStore;

  beforeEach(() => {
    clock = NOW;
    store = new InMemoryObjectStore({ now: () => clock });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function putAt(key: string, at: number): Promise<void> {
    clock = at;
    await store.put(key, PNG);
    clock = NOW;
  }
  const entry = (org: string, digest: string) => `org/${org}/cache/${digest}.png`;
  const keys = async () => (await store.list("org/")).map((o) => o.key).sort();

  test("cache expiry deletes a cache object older than thirty days", async () => {
    await putAt(entry("local", D1), NOW - 31 * DAY);

    expect(await planCacheExpiry(store, "local", NOW)).toEqual({
      orgId: "local",
      expired: [D1],
      kept: 0,
      unrecognised: 0,
    });

    const result = await expireCache(store, ["local"], { apply: true, now: () => NOW });
    expect(result.deleted).toBe(1);
    expect(result.plans[0].expired).toEqual([D1]);

    expect(await keys()).toEqual([]);
  });

  test("cache expiry keeps a cache object younger than thirty days", async () => {
    await putAt(entry("local", D1), NOW - 29 * DAY);
    await putAt(entry("local", D2), NOW - DAY / 24);

    const plan = await planCacheExpiry(store, "local", NOW);
    expect(plan.expired).toEqual([]);
    expect(plan.kept).toBe(2);

    const result = await expireCache(store, ["local"], { apply: true, now: () => NOW });
    expect(result.deleted).toBe(0);
    expect(await keys()).toEqual([entry("local", D1), entry("local", D2)]);
  });

  test("cache expiry treats exactly thirty days as young and thirty days plus one millisecond as old", async () => {
    await putAt(entry("local", D1), NOW - 30 * DAY);
    await putAt(entry("local", D2), NOW - 30 * DAY - 1);
    await putAt(entry("local", D3), NOW + DAY);

    expect(CACHE_TTL_MS).toBe(2_592_000_000);

    const plan = await planCacheExpiry(store, "local", NOW);
    expect(plan.expired).toEqual([D2]);
    expect(plan.kept).toBe(2);

    await expireCache(store, ["local"], { apply: true, now: () => NOW });
    expect(await keys()).toEqual([entry("local", D1), entry("local", D3)]);
  });

  test("cache expiry never deletes a key it does not recognise", async () => {
    await putAt("org/local/cache/notes.txt", NOW - 60 * DAY);
    await putAt(`org/local/cache/nested/${D1}.png`, NOW - 60 * DAY);
    await putAt(`org/local/cache/${D1.toUpperCase()}.png`, NOW - 60 * DAY);
    await putAt(`org/local/cache/${D1}.jpg`, NOW - 60 * DAY);
    await putAt(`org/local/cache/${"a".repeat(63)}.png`, NOW - 60 * DAY);
    await putAt("org/local/cache/", NOW - 60 * DAY);

    const plan = await planCacheExpiry(store, "local", NOW);
    expect(plan).toEqual({
      orgId: "local",
      expired: [],
      kept: 0,
      unrecognised: 6,
    });

    const result = await expireCache(store, ["local"], { apply: true, now: () => NOW });
    expect(result.deleted).toBe(0);
    expect((await keys()).length).toBe(6);
  });

  test("cache expiry never touches anything outside the cache prefix", async () => {
    await putAt(`org/local/campaign/${C1}/renders/${D1}.png`, NOW - 60 * DAY);
    await putAt(`org/local/campaign/${C1}/inputs/${A1}`, NOW - 60 * DAY);
    await putAt(`org/local/cache-old/${D1}.png`, NOW - 60 * DAY);
    await putAt(`org/local/${D1}.png`, NOW - 60 * DAY);
    await putAt(entry("local", D2), NOW - 60 * DAY);

    const result = await expireCache(store, ["local"], { apply: true, now: () => NOW });
    expect(result.deleted).toBe(1);

    const expected = [
      `org/local/campaign/${C1}/renders/${D1}.png`,
      `org/local/campaign/${C1}/inputs/${A1}`,
      `org/local/cache-old/${D1}.png`,
      `org/local/${D1}.png`,
    ].sort();
    expect(await keys()).toEqual(expected);
  });

  test("cache expiry never touches another orgs cache", async () => {
    await putAt(entry("acme", D1), NOW - 60 * DAY);
    await putAt(entry("local", D2), NOW - 60 * DAY);

    const result = await expireCache(store, ["local"], { apply: true, now: () => NOW });
    expect(result.deleted).toBe(1);
    expect(await keys()).toEqual([entry("acme", D1)]);
  });

  test("cache expiry deletes each entry under its own org", async () => {
    await putAt(entry("local", D1), NOW - DAY);
    await putAt(entry("acme", D1), NOW - 40 * DAY);

    const result = await expireCache(store, ["local", "acme"], {
      apply: true,
      now: () => NOW,
    });
    expect(result.deleted).toBe(1);
    expect(await keys()).toEqual([entry("local", D1)]);
  });

  test("cache expiry dry run deletes nothing", async () => {
    await putAt(entry("local", D1), NOW - 60 * DAY);
    await putAt(entry("acme", D2), NOW - 60 * DAY);

    const before = await keys();
    const result = await expireCache(store, ["local", "acme"], {
      apply: false,
      now: () => NOW,
    });
    expect(result.deleted).toBe(0);
    expect(result.plans.map((p) => p.expired.length)).toEqual([1, 1]);
    expect(await keys()).toEqual(before);
  });

  test("cache expiry stops at a failing delete and leaves the rest in place", async () => {
    await putAt(entry("local", D1), NOW - 60 * DAY);
    await putAt(entry("local", D2), NOW - 60 * DAY);
    await putAt(entry("local", D3), NOW - 60 * DAY);

    const real = store.delete.bind(store);
    let calls = 0;
    vi.spyOn(store, "delete").mockImplementation(async (key) => {
      if (++calls === 2) throw new Error("delete refused");
      await real(key);
    });

    await expect(expireCache(store, ["local"], { apply: true, now: () => NOW })).rejects.toThrow(
      "delete refused",
    );
    expect(await keys()).toEqual([entry("local", D2), entry("local", D3)]);
    expect(calls).toBe(2);
  });

  test("cache expiry plans every org before it deletes anything", async () => {
    await putAt(entry("local", D1), NOW - 60 * DAY);
    const failing = {
      listPages: (prefix: string) => {
        if (prefix === "org/acme/cache/") throw new Error("acme store down");
        return store.listPages(prefix);
      },
      delete: vi.fn(),
    } as unknown as ObjectStorePort;

    await expect(
      expireCache(failing, ["local", "acme"], { apply: true, now: () => NOW }),
    ).rejects.toThrow("acme store down");
    expect(failing.delete).not.toHaveBeenCalled();
    expect(await keys()).toEqual([entry("local", D1)]);
  });

  test("cache expiry reports each plan once every org is planned and before the first delete", async () => {
    await putAt(entry("local", D1), NOW - 60 * DAY);
    await putAt(entry("acme", D1), NOW - 60 * DAY);

    const events: string[] = [];
    const real = store.delete.bind(store);
    vi.spyOn(store, "delete").mockImplementation(async (key) => {
      events.push(`delete ${key}`);
      await real(key);
    });

    await expireCache(store, ["local", "acme"], {
      apply: true,
      now: () => NOW,
      onPlan: (plan) => events.push(`plan ${plan.orgId}`),
    });

    expect(events).toEqual([
      "plan local",
      "plan acme",
      `delete ${entry("local", D1)}`,
      `delete ${entry("acme", D1)}`,
    ]);
  });

  test("cache expiry treats a listed key outside the prefix as unrecognised and never deletes it", async () => {
    const stub = {
      listPages: async function* () {
        yield [{ key: entry("other", D1), size: 1, lastModified: new Date(NOW - 60 * DAY) }];
      },
      delete: vi.fn(),
    } as unknown as ObjectStorePort;

    expect(await planCacheExpiry(stub, "local", NOW)).toEqual({
      orgId: "local",
      expired: [],
      kept: 0,
      unrecognised: 1,
    });

    await expireCache(stub, ["local"], { apply: true, now: () => NOW });
    expect(stub.delete).not.toHaveBeenCalled();
  });

  test("cache expiry expires an entry the real cache writer stored once it is older than thirty days", async () => {
    const cache = new ObjectBackgroundCache(store, "org/local/cache/");
    clock = NOW - 31 * DAY;
    await cache.set(D1, PNG);
    clock = NOW - 40 * DAY;
    await cache.set(D2, PNG);
    clock = NOW - 20 * DAY;
    await cache.set(D2, PNG);
    clock = NOW;

    // (a) At now = NOW - 2 * DAY, D1 is 29 days old (young).
    const earlier = await expireCache(store, ["local"], {
      apply: true,
      now: () => NOW - 2 * DAY,
    });
    expect(earlier.deleted).toBe(0);
    const gotD1 = await cache.get(D1);
    expect(gotD1).toBeDefined();
    expect(gotD1).toHaveLength(11);

    // (b) At now = NOW, D1 is 31 days old (expired); D2 was last written 20 days ago.
    const later = await expireCache(store, ["local"], {
      apply: true,
      now: () => NOW,
    });
    expect(later.deleted).toBe(1);
    expect(await cache.get(D1)).toBeUndefined();
    const gotD2 = await cache.get(D2);
    expect(gotD2).toBeDefined();
    expect(gotD2).toHaveLength(11);
    expect(await keys()).toEqual([entry("local", D2)]);
  });

  test("cache expiry describes a plan as the lines the CLI logs", () => {
    expect(
      describeCachePlan({ orgId: "local", expired: [D1, D2], kept: 3, unrecognised: 1 }),
    ).toEqual([
      "  cache org local: 2 expired, 3 kept, 1 unrecognised",
      `    expired ${entry("local", D1)}`,
      `    expired ${entry("local", D2)}`,
    ]);
    expect(cacheObjectKey("acme", D3)).toEqual(entry("acme", D3));
  });

  test("cache expiry reads an org with no cache as nothing to do", async () => {
    const result = await expireCache(store, ["local"], { apply: true, now: () => NOW });
    expect(result).toEqual({
      plans: [{ orgId: "local", expired: [], kept: 0, unrecognised: 0 }],
      deleted: 0,
    });
  });

  test("cache expiry counts entries on every page", async () => {
    const paged = new InMemoryObjectStore({ now: () => clock, listPageSize: 1 });
    async function putAtPaged(key: string, at: number): Promise<void> {
      clock = at;
      await paged.put(key, PNG);
      clock = NOW;
    }
    await putAtPaged(entry("local", D1), NOW - 61 * DAY);
    await putAtPaged(entry("local", D2), NOW - DAY);
    await putAtPaged("org/local/cache/not-a-digest.png", NOW - 61 * DAY);
    expect(await planCacheExpiry(paged, "local", NOW)).toEqual({
      orgId: "local",
      expired: [D1],
      kept: 1,
      unrecognised: 1,
    });
  });
});
