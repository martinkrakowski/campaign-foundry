import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { migratedDatabase } from "../../server/lib/db/__tests__/pglite-client.js";
import type { SqlClient } from "../../server/lib/db/sql-client.js";
import {
  cacheStore,
  parseCacheArgs,
  parseReconcileArgs,
  runCache,
  runReconcile,
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
const A1 = "a1a1a1a1-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const A2 = "a2a2a2a2-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const ORG = "local";
const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const DAY = 24 * HOUR;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

function restoreEnv(): void {
  if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
  else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
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
