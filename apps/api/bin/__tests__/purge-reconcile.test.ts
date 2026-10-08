import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { ObjectBackgroundCache } from "@campaignfoundry/CreativeGeneration";
import { migratedDatabase } from "../../server/lib/db/__tests__/pglite-client.js";
import type { SqlClient } from "../../server/lib/db/sql-client.js";
import {
  cacheStore,
  housekeeping,
  main,
  parseCacheArgs,
  parseReconcileArgs,
  reconcileSwitch,
  runCache,
  runReconcile,
  SWEEP_RECONCILE_MAX_CANDIDATES,
  USAGE_CACHE,
  USAGE_RECONCILE,
} from "../purge.js";
import {
  resetObjectStoreClient,
  setObjectStoreClient,
} from "../../server/lib/object-store/index.js";
import { campaignPrefix, inputKey } from "../../server/lib/object-store/object-keys.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const C1 = "c1c1c1c1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const C2 = "c2c2c2c2-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const A1 = "a1a1a1a1-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const A2 = "a2a2a2a2-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const ORG = "local";
const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const DAY = 24 * HOUR;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const uuidN = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
const SAVED_PURGE_RECONCILE = process.env.PURGE_RECONCILE;

function restoreEnv(): void {
  if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
  else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
  if (SAVED_PURGE_RECONCILE === undefined) delete process.env.PURGE_RECONCILE;
  else process.env.PURGE_RECONCILE = SAVED_PURGE_RECONCILE;
}

describe("reconcile CLI (bin/purge.ts)", () => {
  let db: SqlClient;
  let endSpy: ReturnType<typeof vi.spyOn>;
  let memory: InMemoryObjectStore;
  let clock: number;

  beforeEach(async () => {
    clock = NOW;
    db = await migratedDatabase();
    endSpy = vi.spyOn(db, "end").mockResolvedValue(undefined);
    await db.query(`insert into org (id, name) values ('acme', 'Acme')`);
  }, 30_000);

  afterEach(async () => {
    endSpy.mockRestore();
    await db.end();
    restoreEnv();
    resetObjectStoreClient();
    vi.restoreAllMocks();
  });

  test("reconcile CLI refuses unknown flags and a missing org value before opening anything", async () => {
    const open = vi.fn();
    const store = vi.fn();
    const log: string[] = [];

    await expect(runReconcile(["--bogus"], open, (l) => log.push(l), store)).rejects.toThrow(
      USAGE_RECONCILE,
    );
    await expect(runReconcile(["--org"], open, (l) => log.push(l), store)).rejects.toThrow(
      USAGE_RECONCILE,
    );
    await expect(
      runReconcile(["--apply", "--dry-run"], open, (l) => log.push(l), store),
    ).rejects.toThrow(USAGE_RECONCILE);
    await expect(runReconcile(["--apply"], open, (l) => log.push(l), store)).rejects.toThrow(
      USAGE_RECONCILE,
    );

    expect(open).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();

    expect(parseReconcileArgs([])).toEqual({ apply: false, org: undefined });
    expect(parseReconcileArgs(["--org", "acme", "--apply"])).toEqual({ apply: true, org: "acme" });
    expect(parseReconcileArgs(["--dry-run"])).toEqual({ apply: false, org: undefined });
  });

  test("reconcile CLI uses all defaults when called with args only", async () => {
    // Exercises the default-parameter branches (open=connect, log=console.log,
    // store=reconcileStore, now=Date.now): parseReconcileArgs throws before any
    // default is invoked, but the default branches are still marked taken.
    await expect(runReconcile(["--bogus"])).rejects.toThrow(USAGE_RECONCILE);
  });

  test("reconcile CLI uses default log and now in a successful dry run", async () => {
    process.env.OBJECT_STORE = "s3";
    memory = new InMemoryObjectStore({ now: () => clock });
    setObjectStoreClient(memory);
    const prefix = campaignPrefix(ORG, C1);
    const real = Date.now();
    clock = real - 5 * HOUR;
    await memory.put(`${prefix}inputs/${A1}`, new Uint8Array([1]));
    await memory.put(`${prefix}renders/alpha/1x1/v1.png`, new Uint8Array([1]));
    clock = real;

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const open = vi.fn(() => db);

    // Omit store, log, and now to exercise their defaults. The default store
    // (reconcileStore) succeeds because OBJECT_STORE=s3 and a client was injected.
    await runReconcile([], open);

    expect(open).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls.map((c) => c[0])).toEqual([
      `  org acme: 0 orphan prefix(es), 0 orphan input(s)`,
      `  org local: 1 orphan prefix(es), 0 orphan input(s)`,
      `    prefix ${prefix} (2 object(s))`,
      "  Dry run: nothing deleted. Re-run with --apply to delete.",
    ]);
    const remaining = (await memory.list("org/")).map((o) => o.key).sort();
    expect(remaining).toEqual([`${prefix}inputs/${A1}`, `${prefix}renders/alpha/1x1/v1.png`]);
    consoleSpy.mockRestore();
  });

  test("reconcile CLI refuses the file object store before opening the database", async () => {
    process.env.OBJECT_STORE = "fs";
    const open = vi.fn();

    await expect(runReconcile([], open)).rejects.toThrow("OBJECT_STORE=s3");
    expect(open).not.toHaveBeenCalled();
  });

  test("reconcile CLI dry run lists orphans and deletes nothing", async () => {
    process.env.OBJECT_STORE = "s3";
    memory = new InMemoryObjectStore({ now: () => clock });

    // An orphan prefix for local
    const prefix = campaignPrefix(ORG, C1);
    clock = NOW - 5 * HOUR;
    await memory.put(`${prefix}inputs/${A1}`, new Uint8Array([1]));
    await memory.put(`${prefix}renders/alpha/1x1/v1.png`, new Uint8Array([1]));
    await memory.put(`${prefix}packages/instagram-feed/1/p.zip`, new Uint8Array([1]));
    clock = NOW;

    // A live campaign with an orphan input
    const { rows } = await db.query<{ id: string }>(
      `insert into campaign (org_id, slug) values ($1, $2) returning id`,
      [ORG, "live"],
    );
    const liveId = rows[0]!.id;
    clock = NOW - 5 * HOUR;
    await memory.put(inputKey(ORG, liveId, A2), new Uint8Array([1]));
    clock = NOW;

    const open = vi.fn(() => db);
    const log: string[] = [];
    const beforeKeys = (await memory.list("org/")).map((o) => o.key).sort();

    await runReconcile(
      [],
      open,
      (l) => log.push(l),
      () => memory,
      () => NOW,
    );

    expect(open).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      `  org acme: 0 orphan prefix(es), 0 orphan input(s)`,
      `  org local: 1 orphan prefix(es), 1 orphan input(s)`,
      `    prefix ${prefix} (3 object(s))`,
      `    input ${inputKey(ORG, liveId, A2)}`,
      `  Dry run: nothing deleted. Re-run with --apply to delete.`,
    ]);
    const afterKeys = (await memory.list("org/")).map((o) => o.key).sort();
    expect(afterKeys).toEqual(beforeKeys);
  });

  test("reconcile CLI apply deletes the listed orphans and logs the counts", async () => {
    process.env.OBJECT_STORE = "s3";
    memory = new InMemoryObjectStore({ now: () => clock });

    // Same fixture as the dry run: an orphan prefix + a live campaign with an orphan input
    const prefix = campaignPrefix(ORG, C1);
    clock = NOW - 5 * HOUR;
    await memory.put(`${prefix}inputs/${A1}`, new Uint8Array([1]));
    await memory.put(`${prefix}renders/alpha/1x1/v1.png`, new Uint8Array([1]));
    await memory.put(`${prefix}packages/instagram-feed/1/p.zip`, new Uint8Array([1]));
    clock = NOW;

    const { rows } = await db.query<{ id: string }>(
      `insert into campaign (org_id, slug) values ($1, $2) returning id`,
      [ORG, "live"],
    );
    const liveId = rows[0]!.id;
    clock = NOW - 5 * HOUR;
    await memory.put(inputKey(ORG, liveId, A2), new Uint8Array([1]));
    clock = NOW;

    const open = vi.fn(() => db);
    const log: string[] = [];

    await runReconcile(
      ["--org", "local", "--apply"],
      open,
      (l) => log.push(l),
      () => memory,
      () => NOW,
    );

    expect(open).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
    expect(log.some((l) => l.includes("org acme"))).toBe(false);
    expect(log[log.length - 1]).toBe(`  Deleted 1 prefix(es) and 1 input(s); skipped 0.`);

    const remaining = (await memory.list("org/")).map((o) => o.key).sort();
    // The acme org is untouched (not in scope), and nothing else in local survives
    expect(remaining).toEqual([]);
  });

  test("reconcile CLI limits itself to the org it is given", async () => {
    process.env.OBJECT_STORE = "s3";
    memory = new InMemoryObjectStore({ now: () => clock });

    clock = NOW - 5 * HOUR;
    await memory.put(`${campaignPrefix(ORG, C1)}inputs/${A1}`, new Uint8Array([1]));
    await memory.put(`${campaignPrefix("acme", C1)}inputs/${A1}`, new Uint8Array([1]));
    clock = NOW;

    const open = vi.fn(() => db);
    const log: string[] = [];

    await runReconcile(
      ["--org", "local", "--apply"],
      open,
      (l) => log.push(l),
      () => memory,
      () => NOW,
    );

    const remaining = (await memory.list("org/")).map((o) => o.key).sort();
    expect(remaining).toEqual([`org/acme/campaign/${C1}/inputs/${A1}`]);
    expect(log.some((l) => l.includes("org acme"))).toBe(false);
  });

  test("reconcile CLI refuses an unknown org and deletes nothing", async () => {
    process.env.OBJECT_STORE = "s3";
    memory = new InMemoryObjectStore({ now: () => clock });

    clock = NOW - 5 * HOUR;
    await memory.put(`${campaignPrefix("acme", C1)}inputs/${A1}`, new Uint8Array([1]));
    clock = NOW;

    const open = vi.fn(() => db);

    await expect(
      runReconcile(
        ["--org", "ghost", "--apply"],
        open,
        () => {},
        () => memory,
        () => NOW,
      ),
    ).rejects.toThrow('reconcile: unknown org "ghost"');

    expect(open).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
    const remaining = (await memory.list("org/")).map((o) => o.key);
    expect(remaining).toEqual([`org/acme/campaign/${C1}/inputs/${A1}`]);
  });

  test("reconcile CLI logs the plan before the first delete and each delete as it completes", async () => {
    process.env.OBJECT_STORE = "s3";
    memory = new InMemoryObjectStore({ now: () => clock });

    const prefix = campaignPrefix(ORG, C1);
    clock = NOW - 5 * HOUR;
    await memory.put(`${prefix}inputs/${A1}`, new Uint8Array([1]));
    await memory.put(`${prefix}renders/alpha/1x1/v1.png`, new Uint8Array([1]));
    await memory.put(`${prefix}packages/instagram-feed/1/p.zip`, new Uint8Array([1]));
    clock = NOW;

    const { rows } = await db.query<{ id: string }>(
      `insert into campaign (org_id, slug) values ($1, $2) returning id`,
      [ORG, "live"],
    );
    const liveId = rows[0]!.id;
    clock = NOW - 5 * HOUR;
    await memory.put(inputKey(ORG, liveId, A2), new Uint8Array([1]));
    clock = NOW;

    const events: string[] = [];
    const realDeletePrefix = memory.deletePrefix.bind(memory);
    const realDelete = memory.delete.bind(memory);
    vi.spyOn(memory, "deletePrefix").mockImplementation(async (p) => {
      events.push("store deletePrefix");
      await realDeletePrefix(p);
    });
    vi.spyOn(memory, "delete").mockImplementation(async (k) => {
      events.push("store delete");
      await realDelete(k);
    });

    const open = vi.fn(() => db);
    await runReconcile(
      ["--org", "local", "--apply"],
      open,
      (l) => events.push(`log${l}`),
      () => memory,
      () => NOW,
    );

    expect(events).toEqual([
      `log  org local: 1 orphan prefix(es), 1 orphan input(s)`,
      `log    prefix ${prefix} (3 object(s))`,
      `log    input ${inputKey(ORG, liveId, A2)}`,
      "store deletePrefix",
      `log  deleted prefix ${prefix}`,
      "store delete",
      `log  deleted input ${inputKey(ORG, liveId, A2)}`,
      "log  Deleted 1 prefix(es) and 1 input(s); skipped 0.",
    ]);
  });

  test("reconcile CLI leaves a record of the deletes done before a failure", async () => {
    process.env.OBJECT_STORE = "s3";
    memory = new InMemoryObjectStore({ now: () => clock });

    clock = NOW - 5 * HOUR;
    await memory.put(`${campaignPrefix(ORG, C1)}inputs/${A1}`, new Uint8Array([1]));
    await memory.put(`${campaignPrefix(ORG, C2)}inputs/${A1}`, new Uint8Array([1]));
    clock = NOW;

    const open = vi.fn(() => db);
    const log: string[] = [];
    let calls = 0;
    const realDeletePrefix = memory.deletePrefix.bind(memory);
    vi.spyOn(memory, "deletePrefix").mockImplementation(async (p) => {
      if (calls++ === 0) return realDeletePrefix(p);
      throw new Error("store down");
    });

    await expect(
      runReconcile(
        ["--org", "local", "--apply"],
        open,
        (l) => log.push(l),
        () => memory,
        () => NOW,
      ),
    ).rejects.toThrow("store down");

    expect(log).toEqual([
      `  org local: 2 orphan prefix(es), 0 orphan input(s)`,
      `    prefix ${campaignPrefix(ORG, C1)} (1 object(s))`,
      `    prefix ${campaignPrefix(ORG, C2)} (1 object(s))`,
      `  deleted prefix ${campaignPrefix(ORG, C1)}`,
    ]);
    expect((await memory.list("org/local/campaign/")).map((o) => o.key)).toEqual([
      `${campaignPrefix(ORG, C2)}inputs/${A1}`,
    ]);
    expect(await memory.list("org/acme/campaign/")).toHaveLength(0);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });
});

describe("cache CLI (bin/purge.ts)", () => {
  let db: SqlClient;
  let endSpy: ReturnType<typeof vi.spyOn>;
  let memory: InMemoryObjectStore;
  let clock: number;

  beforeEach(async () => {
    clock = NOW;
    db = await migratedDatabase();
    endSpy = vi.spyOn(db, "end").mockResolvedValue(undefined);
    await db.query(`insert into org (id, name) values ('acme', 'Acme')`);
    memory = new InMemoryObjectStore({ now: () => clock });
  }, 30_000);

  afterEach(async () => {
    endSpy.mockRestore();
    await db.end();
    restoreEnv();
    resetObjectStoreClient();
    vi.restoreAllMocks();
  });

  test("cache CLI refuses unknown flags and apply without an org before opening anything", async () => {
    const open = vi.fn();
    const store = vi.fn();
    const log: string[] = [];

    await expect(runCache(["--bogus"], open, (l) => log.push(l), store)).rejects.toThrow(
      USAGE_CACHE,
    );
    await expect(runCache(["--org"], open, (l) => log.push(l), store)).rejects.toThrow(USAGE_CACHE);
    await expect(
      runCache(["--apply", "--dry-run"], open, (l) => log.push(l), store),
    ).rejects.toThrow(USAGE_CACHE);
    await expect(runCache(["--apply"], open, (l) => log.push(l), store)).rejects.toThrow(
      USAGE_CACHE,
    );

    expect(open).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();

    expect(parseCacheArgs([])).toEqual({ apply: false, org: undefined });
    expect(parseCacheArgs(["--org", "acme", "--apply"])).toEqual({ apply: true, org: "acme" });
    expect(parseCacheArgs(["--dry-run"])).toEqual({ apply: false, org: undefined });
    expect(() => parseCacheArgs(["--apply"])).toThrow(USAGE_CACHE);
    // Two orgs are ambiguous, and with --apply the last one would be deleted in: refused.
    expect(() => parseCacheArgs(["--org", "acme", "--org", "local", "--apply"])).toThrow(
      USAGE_CACHE,
    );
    expect(() => parseReconcileArgs(["--org", "acme", "--org", "local"])).toThrow(USAGE_RECONCILE);

    await expect(runCache(["--bogus"])).rejects.toThrow(USAGE_CACHE);
  });

  test("cache CLI refuses the file object store before opening the database", async () => {
    process.env.OBJECT_STORE = "fs";
    const open = vi.fn();

    await expect(runCache([], open)).rejects.toThrow("OBJECT_STORE=s3");
    expect(open).not.toHaveBeenCalled();

    process.env.OBJECT_STORE = "s3";
    setObjectStoreClient(memory);
    expect(cacheStore()).toBe(memory);
  });

  test("cache CLI dry run lists expired objects and deletes nothing", async () => {
    process.env.OBJECT_STORE = "s3";
    memory = new InMemoryObjectStore({ now: () => clock });
    setObjectStoreClient(memory);
    clock = NOW - 31 * DAY;
    await memory.put(`org/local/cache/${D1}.png`, PNG);
    clock = NOW - DAY;
    await memory.put(`org/local/cache/${D2}.png`, PNG);
    clock = NOW;

    const open = vi.fn(() => db);
    const log: string[] = [];

    await runCache(
      [],
      open,
      (l) => log.push(l),
      () => memory,
      () => NOW,
    );

    expect(log).toEqual([
      "  cache org acme: 0 expired, 0 kept, 0 unrecognised",
      "  cache org local: 1 expired, 1 kept, 0 unrecognised",
      `    expired org/local/cache/${D1}.png`,
      "  Dry run: nothing deleted. Re-run with --org <id> --apply to delete.",
    ]);
    expect((await memory.list("org/")).map((o) => o.key).sort()).toEqual([
      `org/local/cache/${D1}.png`,
      `org/local/cache/${D2}.png`,
    ]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  test("cache CLI apply expires only the org it is given", async () => {
    process.env.OBJECT_STORE = "s3";
    memory = new InMemoryObjectStore({ now: () => clock });
    setObjectStoreClient(memory);
    clock = NOW - 31 * DAY;
    await memory.put(`org/local/cache/${D1}.png`, PNG);
    await memory.put(`org/acme/cache/${D1}.png`, PNG);
    clock = NOW;

    const open = vi.fn(() => db);
    const log: string[] = [];

    await runCache(
      ["--org", "local", "--apply"],
      open,
      (l) => log.push(l),
      () => memory,
      () => NOW,
    );

    expect((await memory.list("org/")).map((o) => o.key)).toEqual([`org/acme/cache/${D1}.png`]);
    expect(log[log.length - 1]).toBe("  Cache expiry: deleted 1 object(s).");
    expect(log.some((l) => l.includes("cache org acme"))).toBe(false);
  });

  test("cache CLI refuses an unknown org and deletes nothing", async () => {
    process.env.OBJECT_STORE = "s3";
    memory = new InMemoryObjectStore({ now: () => clock });
    setObjectStoreClient(memory);
    clock = NOW - 31 * DAY;
    await memory.put(`org/local/cache/${D1}.png`, PNG);
    clock = NOW;

    const open = vi.fn(() => db);

    await expect(
      runCache(
        ["--org", "ghost", "--apply"],
        open,
        () => {},
        () => memory,
        () => NOW,
      ),
    ).rejects.toThrow('cache: unknown org "ghost"');

    expect(open).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
    expect((await memory.list("org/")).map((o) => o.key)).toEqual([`org/local/cache/${D1}.png`]);
  });

  test("cache CLI uses default log and now in a dry run", async () => {
    process.env.OBJECT_STORE = "s3";
    memory = new InMemoryObjectStore({ now: () => clock });
    setObjectStoreClient(memory);
    const real = Date.now();
    clock = real - 31 * DAY;
    await memory.put(`org/local/cache/${D1}.png`, PNG);
    clock = real;

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const open = vi.fn(() => db);

    await runCache([], open);

    expect(consoleSpy.mock.calls.map((c) => c[0])).toEqual([
      "  cache org acme: 0 expired, 0 kept, 0 unrecognised",
      "  cache org local: 1 expired, 0 kept, 0 unrecognised",
      `    expired org/local/cache/${D1}.png`,
      "  Dry run: nothing deleted. Re-run with --org <id> --apply to delete.",
    ]);
  });
});

describe("sweep housekeeping (bin/purge.ts)", () => {
  let db: SqlClient;
  let endSpy: ReturnType<typeof vi.spyOn>;
  let memory: InMemoryObjectStore;
  let clock: number;

  beforeEach(async () => {
    clock = NOW;
    db = await migratedDatabase();
    endSpy = vi.spyOn(db, "end").mockResolvedValue(undefined);
    await db.query(`insert into org (id, name) values ('acme', 'Acme')`);
    memory = new InMemoryObjectStore({ now: () => clock });
  }, 30_000);

  afterEach(async () => {
    endSpy.mockRestore();
    await db.end();
    restoreEnv();
    resetObjectStoreClient();
    vi.restoreAllMocks();
  });

  const oldOrphanPrefix = async (org: string, id: string) => {
    clock = NOW - 5 * HOUR;
    await memory.put(`${campaignPrefix(org, id)}inputs/${A1}`, PNG);
    clock = NOW;
  };

  test("sweep housekeeping skips both steps without an s3 object store", async () => {
    process.env.OBJECT_STORE = "fs";
    await oldOrphanPrefix(ORG, C1);
    clock = NOW - 40 * DAY;
    await memory.put(`org/${ORG}/cache/${D1}.png`, PNG);
    clock = NOW;

    const log: string[] = [];
    await expect(
      housekeeping(
        db,
        (l) => log.push(l),
        () => NOW,
      ),
    ).resolves.toBe(0);
    expect(log).toEqual(["  Reconcile and cache expiry skipped: OBJECT_STORE is not s3."]);
  });

  test("sweep housekeeping reconciles all orgs and expires old cache objects in one pass", async () => {
    process.env.OBJECT_STORE = "s3";
    setObjectStoreClient(memory);
    delete process.env.PURGE_RECONCILE;

    const prefix = campaignPrefix(ORG, C1);
    clock = NOW - 5 * HOUR;
    await memory.put(`${prefix}inputs/${A1}`, new Uint8Array([1]));
    await memory.put(`${prefix}renders/alpha/1x1/v1.png`, new Uint8Array([1]));
    await memory.put(`${prefix}packages/instagram-feed/1/p.zip`, new Uint8Array([1]));
    clock = NOW;

    const { rows } = await db.query<{ id: string }>(
      `insert into campaign (org_id, slug) values ($1, $2) returning id`,
      [ORG, "live"],
    );
    const liveId = rows[0]!.id;
    clock = NOW - 5 * HOUR;
    await memory.put(inputKey(ORG, liveId, A2), new Uint8Array([1]));
    await memory.put(`${campaignPrefix(ORG, liveId)}renders/alpha/1x1/v1.png`, new Uint8Array([1]));
    clock = NOW;

    const cache = new ObjectBackgroundCache(memory, `org/${ORG}/cache/`);
    clock = NOW - 31 * DAY;
    await cache.set(D1, PNG);
    clock = NOW - DAY;
    await cache.set(D2, PNG);
    clock = NOW;

    clock = NOW - 5 * HOUR;
    await memory.put(`${campaignPrefix("acme", C1)}inputs/${A1}`, new Uint8Array([1]));
    clock = NOW - 40 * DAY;
    await memory.put(`org/acme/cache/${D1}.png`, PNG);
    clock = NOW;

    const log: string[] = [];
    await expect(
      housekeeping(
        db,
        (l) => log.push(l),
        () => NOW,
      ),
    ).resolves.toBe(0);
    expect(log).toEqual([
      `  org acme: 1 orphan prefix(es), 0 orphan input(s)`,
      `    prefix ${campaignPrefix("acme", C1)} (1 object(s))`,
      `  org local: 1 orphan prefix(es), 1 orphan input(s)`,
      `    prefix ${prefix} (3 object(s))`,
      `    input ${inputKey(ORG, liveId, A2)}`,
      `  deleted prefix ${campaignPrefix("acme", C1)}`,
      `  deleted prefix ${prefix}`,
      `  deleted input ${inputKey(ORG, liveId, A2)}`,
      `  Reconcile: deleted 2 prefix(es) and 1 input(s); skipped 0.`,
      `  cache org acme: 1 expired, 0 kept, 0 unrecognised`,
      `    expired org/acme/cache/${D1}.png`,
      `  cache org local: 1 expired, 1 kept, 0 unrecognised`,
      `    expired org/local/cache/${D1}.png`,
      `  Cache expiry: deleted 2 object(s).`,
    ]);
    expect((await memory.list("org/")).map((o) => o.key).sort()).toEqual(
      [
        `org/local/cache/${D2}.png`,
        `${campaignPrefix(ORG, liveId)}renders/alpha/1x1/v1.png`,
      ].sort(),
    );
  });

  test("sweep housekeeping skips the reconciler when PURGE_RECONCILE is off but still expires the cache", async () => {
    process.env.OBJECT_STORE = "s3";
    setObjectStoreClient(memory);
    process.env.PURGE_RECONCILE = "off";
    await oldOrphanPrefix(ORG, C1);
    clock = NOW - 40 * DAY;
    await memory.put(`org/${ORG}/cache/${D1}.png`, PNG);
    clock = NOW;

    const log: string[] = [];
    await expect(
      housekeeping(
        db,
        (l) => log.push(l),
        () => NOW,
      ),
    ).resolves.toBe(0);
    expect(log).toContain("  Reconcile skipped: PURGE_RECONCILE=off.");
    expect(log).toContain("  Cache expiry: deleted 1 object(s).");
    expect((await memory.list("org/local/campaign/")).map((o) => o.key)).toEqual([
      `${campaignPrefix(ORG, C1)}inputs/${A1}`,
    ]);
    expect(await memory.list("org/local/cache/")).toHaveLength(0);
  });

  test("sweep housekeeping reads PURGE_RECONCILE as on or off and refuses anything else", () => {
    delete process.env.PURGE_RECONCILE;
    expect(reconcileSwitch()).toBe(true);
    process.env.PURGE_RECONCILE = "";
    expect(reconcileSwitch()).toBe(true);
    process.env.PURGE_RECONCILE = "on";
    expect(reconcileSwitch()).toBe(true);
    process.env.PURGE_RECONCILE = "off";
    expect(reconcileSwitch()).toBe(false);
    process.env.PURGE_RECONCILE = "maybe";
    expect(() => reconcileSwitch()).toThrow('PURGE_RECONCILE must be "on" or "off".');
  });

  test("sweep housekeeping reports a bad PURGE_RECONCILE as a failed step and still expires the cache", async () => {
    process.env.OBJECT_STORE = "s3";
    setObjectStoreClient(memory);
    process.env.PURGE_RECONCILE = "maybe";
    await oldOrphanPrefix(ORG, C1);
    clock = NOW - 40 * DAY;
    await memory.put(`org/${ORG}/cache/${D1}.png`, PNG);
    clock = NOW;

    const log: string[] = [];
    await expect(
      housekeeping(
        db,
        (l) => log.push(l),
        () => NOW,
      ),
    ).resolves.toBe(1);
    expect(log).toContain(`  reconcile failed (PURGE_RECONCILE must be "on" or "off".)`);
    expect(log).toContain("  Cache expiry: deleted 1 object(s).");
    expect((await memory.list("org/local/campaign/")).map((o) => o.key)).toEqual([
      `${campaignPrefix(ORG, C1)}inputs/${A1}`,
    ]);
  });

  test("sweep housekeeping refuses to reconcile past the candidate cap and still expires the cache", async () => {
    expect(SWEEP_RECONCILE_MAX_CANDIDATES).toBe(100);
    process.env.OBJECT_STORE = "s3";
    setObjectStoreClient(memory);
    delete process.env.PURGE_RECONCILE;
    for (let i = 1; i <= 101; i++) {
      await oldOrphanPrefix(ORG, uuidN(i));
    }
    clock = NOW - 40 * DAY;
    await memory.put(`org/${ORG}/cache/${D1}.png`, PNG);
    clock = NOW;

    const log: string[] = [];
    await expect(
      housekeeping(
        db,
        (l) => log.push(l),
        () => NOW,
      ),
    ).resolves.toBe(1);
    expect(log).toContain(
      "  reconcile failed (reconcile refused, nothing deleted: 101 candidates exceed the cap of 100.)",
    );
    expect(log).toContain("  Cache expiry: deleted 1 object(s).");
    expect(log.filter((l) => l.startsWith("    prefix ")).length).toBe(101);
    expect(log.some((l) => l.startsWith("  deleted "))).toBe(false);
    expect((await memory.list("org/local/campaign/")).map((o) => o.key).sort()).toHaveLength(101);
  });

  test("sweep housekeeping reports a cache failure and still reconciles", async () => {
    process.env.OBJECT_STORE = "s3";
    setObjectStoreClient(memory);
    delete process.env.PURGE_RECONCILE;
    await oldOrphanPrefix(ORG, C1);

    const log: string[] = [];
    const real = memory.list.bind(memory);
    const list = vi.spyOn(memory, "list");
    list.mockImplementationOnce(real);
    list.mockImplementationOnce(real);
    list.mockRejectedValueOnce("boom");

    await expect(
      housekeeping(
        db,
        (l) => log.push(l),
        () => NOW,
      ),
    ).resolves.toBe(1);
    expect(log).toContain("  cache expiry failed (boom)");
    expect(log).toContain("  Reconcile: deleted 1 prefix(es) and 0 input(s); skipped 0.");
    expect((await memory.list("org/local/campaign/")).map((o) => o.key)).toHaveLength(0);
  });

  test("main sweep drains the queue then reconciles and expires the cache in one command", async () => {
    process.env.OBJECT_STORE = "s3";
    setObjectStoreClient(memory);
    const real = Date.now();
    clock = real - 5 * HOUR;
    await memory.put(inputKey(ORG, C1, A1), PNG);
    clock = real;
    const cache = new ObjectBackgroundCache(memory, `org/${ORG}/cache/`);
    clock = real - 31 * DAY;
    await cache.set(D1, PNG);
    clock = real;

    const log: string[] = [];
    const open = vi.fn(() => db);
    await main("sweep", false, open, (l) => log.push(l));

    expect(log).toEqual([
      "  Purged 0 deletion row(s), 0 failed.",
      "  org acme: 0 orphan prefix(es), 0 orphan input(s)",
      "  org local: 1 orphan prefix(es), 0 orphan input(s)",
      `    prefix ${campaignPrefix(ORG, C1)} (1 object(s))`,
      `  deleted prefix ${campaignPrefix(ORG, C1)}`,
      "  Reconcile: deleted 1 prefix(es) and 0 input(s); skipped 0.",
      "  cache org acme: 0 expired, 0 kept, 0 unrecognised",
      "  cache org local: 1 expired, 0 kept, 0 unrecognised",
      `    expired org/local/cache/${D1}.png`,
      "  Cache expiry: deleted 1 object(s).",
    ]);
    expect((await memory.list("org/")).map((o) => o.key)).toEqual([]);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  // A1: a failed org lookup is a counted housekeeping failure. Because
  // expireCache needs the org list too, the cache step cannot run and is
  // counted as failed alongside the reconcile step.
  test("housekeeping counts a failed org lookup as a failed step and counts the cache step too", async () => {
    process.env.OBJECT_STORE = "s3";
    setObjectStoreClient(memory);
    const log: string[] = [];

    // Make the org lookup (select id from org) throw.
    const realQuery = db.query.bind(db);
    vi.spyOn(db, "query").mockImplementation(async (text, params) => {
      if (typeof text === "string" && text.startsWith("select id from org")) {
        throw new Error("org lookup boom");
      }
      return realQuery(text, params);
    });

    const failed = await housekeeping(
      db,
      (l) => log.push(l),
      () => NOW,
    );
    expect(failed).toBe(2);

    expect(log).toContain(`  reconcile failed (org lookup boom)`);
    expect(log).toContain(
      "  cache expiry failed (setup failed: store client or org list unavailable)",
    );

    // Also drive through main: the org-lookup failure must reject with the
    // housekeeping-failed message and the database connection must be closed.
    const log2: string[] = [];
    await expect(
      main(
        "sweep",
        false,
        () => db,
        (l) => log2.push(l),
      ),
    ).rejects.toThrow("2 housekeeping step(s) failed; see the lines above.");
    expect(db.end).toHaveBeenCalled();
  });

  test("housekeeping counts a failed store client as a failed step and closes the database", async () => {
    process.env.OBJECT_STORE = "s3";
    resetObjectStoreClient(); // no cached store, no S3 settings -> objectStoreClient() throws

    const log: string[] = [];
    await expect(
      main(
        "sweep",
        false,
        () => db,
        (l) => log.push(l),
      ),
    ).rejects.toThrow("2 housekeeping step(s) failed; see the lines above.");
    expect(log.some((l) => l.startsWith("  reconcile failed ("))).toBe(true);
    expect(log).toContain(
      "  cache expiry failed (setup failed: store client or org list unavailable)",
    );
    expect(db.end).toHaveBeenCalled();
  });
  test("sweep housekeeping reconciles exactly SWEEP_RECONCILE_MAX_CANDIDATES orphans across two orgs without failing", async () => {
    expect(SWEEP_RECONCILE_MAX_CANDIDATES).toBe(100);
    process.env.OBJECT_STORE = "s3";
    setObjectStoreClient(memory);
    delete process.env.PURGE_RECONCILE;

    // Plant 50 orphans in local and 50 in acme (100 total).
    for (let i = 0; i < 50; i++) {
      clock = NOW - 5 * HOUR;
      await memory.put(`${campaignPrefix(ORG, uuidN(i + 1))}inputs/${A1}`, PNG);
      await memory.put(`${campaignPrefix("acme", uuidN(i + 51))}inputs/${A1}`, PNG);
      clock = NOW;
    }

    const log: string[] = [];
    await expect(
      housekeeping(
        db,
        (l) => log.push(l),
        () => NOW,
      ),
    ).resolves.toBe(0);
    expect(log).toContain(`  Reconcile: deleted 100 prefix(es) and 0 input(s); skipped 0.`);
    expect((await memory.list("org/local/campaign/")).map((o) => o.key)).toEqual([]);
    expect((await memory.list("org/acme/campaign/")).map((o) => o.key)).toEqual([]);
  });

  // A3: a young object (younger than one hour) survives the unattended sweep.
  test("sweep housekeeping leaves young orphan objects alone but deletes old ones", async () => {
    process.env.OBJECT_STORE = "s3";
    setObjectStoreClient(memory);
    delete process.env.PURGE_RECONCILE;

    // Old orphan prefix (5h before now) -> deleted.
    clock = NOW - 5 * HOUR;
    await memory.put(`${campaignPrefix(ORG, C1)}inputs/${A1}`, PNG);
    // Young orphan prefix (30 min before now) -> survives.
    clock = NOW - 30 * 60_000;
    await memory.put(`${campaignPrefix(ORG, C2)}inputs/${A2}`, PNG);

    // Old orphan input (5h before now, live campaign, no asset row) -> deleted.
    const { rows } = await db.query<{ id: string }>(
      `insert into campaign (org_id, slug) values ($1, $2) returning id`,
      [ORG, "live-old"],
    );
    const oldLiveId = rows[0]!.id;
    clock = NOW - 5 * HOUR;
    await memory.put(inputKey(ORG, oldLiveId, A2), PNG);

    // Young orphan input (30 min before now, live campaign, no asset row) -> survives.
    const { rows: rows2 } = await db.query<{ id: string }>(
      `insert into campaign (org_id, slug) values ($1, $2) returning id`,
      [ORG, "live-young"],
    );
    const youngLiveId = rows2[0]!.id;
    clock = NOW - 30 * 60_000;
    await memory.put(inputKey(ORG, youngLiveId, A2), PNG);

    clock = NOW;

    const log: string[] = [];
    await expect(
      housekeeping(
        db,
        (l) => log.push(l),
        () => NOW,
      ),
    ).resolves.toBe(0);
    expect(log).toContain(`  deleted prefix ${campaignPrefix(ORG, C1)}`);
    expect(log).toContain(`  deleted input ${inputKey(ORG, oldLiveId, A2)}`);
    // Young prefix and young input survive.
    const remaining = (await memory.list("org/local/campaign/")).map((o) => o.key).sort();
    expect(remaining).toEqual(
      [`${inputKey(ORG, youngLiveId, A2)}`, `${campaignPrefix(ORG, C2)}inputs/${A2}`].sort(),
    );
  });
});
