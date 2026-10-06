import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetProjectRoot } from "@campaignfoundry/shared";
import { resetDatabase, setDatabase } from "../db/database.js";
import { migratedDatabase } from "../db/__tests__/pglite-client.js";
import type { SqlClient } from "../db/sql-client.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../object-store/index.js";
import { FsAssetStore } from "../ports/fs-asset-store.js";
import { FsBriefStore } from "../ports/fs-brief-store.js";
import { PgBriefStore } from "../ports/pg-brief-store.js";
import { getAssetStore, getBriefStore, resetAssetStore, resetBriefStore } from "../ports/index.js";
import { ObjectAssetStore } from "../ports/object-asset-store.js";
import { inputKey, inputPrefix } from "../object-store/object-keys.js";
import { BriefRefNotFoundError, copyBriefRefs } from "../brief-asset-refs.js";
import { CampaignNotFoundError } from "../ownership.js";
import type { TenantContext } from "../tenant.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A DIFFERENT byte string; `copyAssets` reuses a name the target already holds by these exact bytes (D237), so testing the copy against the same PNG would assert a target-owned id without a copy happening. */
const PNG_ALT = Buffer.concat([PNG, Buffer.from([0x00])]);
/** Distinct from `PNG_ALT` so nothing dedupes across two sources in one request. */
const PNG_ALT2 = Buffer.concat([PNG, Buffer.from([0x00, 0x00])]);

/** The brief's OWN campaign — the `target`, and the owner its own refs have. */
const RUN = "run-me";
/** A visible source campaign in team `t1`. */
const SRC = "src";
const S1 = "s1";
const S2 = "s2";

const CALLER: TenantContext = { orgId: "local", userId: "u1", roles: [], teamIds: ["t1"] };
/** Minting campaigns/briefs as `owner` bypasses team membership on `createCampaign`. */
const OWNER: TenantContext = { orgId: "local", userId: "owner", roles: ["owner"], teamIds: [] };

/** The root-level demo ref the editor's own default brief carries (`run-context.tsx:553`). */
const DEMO_REF = "assets/inputs/hydra-logo.png";

const storedBrief = (id: string): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id,
  mode: "brief",
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E3", logoPath: DEMO_REF }],
});

const SAVED_BACKEND = process.env.STORE_BACKEND;
const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

/** Restore both switches, whatever a test did to them. */
const restoreSwitches = (): void => {
  if (SAVED_BACKEND === undefined) delete process.env.STORE_BACKEND;
  else process.env.STORE_BACKEND = SAVED_BACKEND;
  if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
  else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
};

interface Row {
  readonly id: string;
  readonly name: string;
}

/** One `asset` row as read back, so a test can assert what a free left behind. */
async function rowsOf(db: SqlClient, campaignId: string): Promise<readonly Row[]> {
  const { rows } = await db.query<Row>(
    `select id, name from asset where org_id = 'local' and campaign_id = $1 order by name`,
    [campaignId],
  );
  return rows;
}

async function keysOf(store: InMemoryObjectStore, campaignId: string): Promise<string[]> {
  return (await store.list(inputPrefix("local", campaignId))).map((o) => o.key).sort();
}

describe("copyBriefRefs — re-checks each copy source after copying (PT-9i, D237)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  let ownerStore: PgBriefStore;

  const copy = (from: string[]) => copyBriefRefs(CALLER, storedBrief(RUN), from, RUN);

  beforeEach(async () => {
    process.env.STORE_BACKEND = "postgres";
    process.env.OBJECT_STORE = "s3";
    db = await migratedDatabase();
    setDatabase(db);
    store = new InMemoryObjectStore();
    setObjectStoreClient(store);
    resetBriefStore();
    resetAssetStore();
    ownerStore = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values
         ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
      ["t1", "Team One", "local", "t2", "Team Two"],
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetObjectStoreClient();
    resetDatabase();
    resetBriefStore();
    resetAssetStore();
    restoreSwitches();
    await db.end();
  });

  const seedTarget = async () => {
    const { campaignId: runId } = await ownerStore.createCampaign(RUN);
    const { id: logoId } = await new ObjectAssetStore(db, store, "local").writeAsset(
      RUN,
      "logo.png",
      PNG,
    );
    return { runId, logoId };
  };

  const seedSource = async (
    slug: string,
    files: readonly { name: string; bytes: Buffer }[],
  ): Promise<string> => {
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    const assets = new ObjectAssetStore(db, store, "local");
    for (const file of files) {
      await assets.writeAsset(slug, file.name, file.bytes);
    }
    return campaignId;
  };

  /** Wrap the real `copyAssets` so that, after a source's copy returns, its campaign is reassigned to t2. No `campaignVisibility` is mocked: the production adapter reads the real row afterwards. */
  const reassignAfter = (hiddenSlug: string): void => {
    const real = ObjectAssetStore.prototype.copyAssets;
    vi.spyOn(ObjectAssetStore.prototype, "copyAssets").mockImplementation(async function (
      this: ObjectAssetStore,
      from: string,
      to: string,
    ) {
      const result = await real.call(this, from, to);
      if (from === hiddenSlug) {
        await db.query(`update campaign set team_id = 't2' where org_id = 'local' and slug = $1`, [
          hiddenSlug,
        ]);
      }
      return result;
    });
  };

  test("copyBriefRefs returns the rewritten brief and only the ids it created under s3", async () => {
    const { runId, logoId } = await seedTarget();
    await seedSource(SRC, [
      { name: "logo.png", bytes: PNG },
      { name: "alt.png", bytes: PNG_ALT },
      { name: "bg.png", bytes: PNG_ALT2 },
    ]);
    const free = vi.spyOn(ObjectAssetStore.prototype, "freeUnreferencedAssets");

    const result = await copy([SRC]);

    // The copies minted into the target: alt.png and bg.png only. logo.png is reused
    // (same bytes, same name as the target's own), so it is never in `created` (D237).
    const targetRows = await rowsOf(db, runId);
    const createdIds = targetRows.filter((r) => r.name !== "logo.png").map((r) => r.id);
    expect([...result.createdIds].sort()).toEqual([...createdIds].sort());
    expect(result.createdIds).not.toContain(logoId);
    // The brief is returned unchanged in identity: no ref of its remaps to a source.
    expect(result.brief.id).toBe(RUN);
    expect(result.brief.products[0]!.logoPath).toBe(DEMO_REF);
    // The target holds alt, bg and its own logo — three rows, three objects.
    expect((await rowsOf(db, runId)).map((r) => r.name).sort()).toEqual([
      "alt.png",
      "bg.png",
      "logo.png",
    ]);
    expect((await keysOf(store, runId)).length).toBe(3);
    // This call was clean: no refusal, so nothing is freed.
    expect(free).not.toHaveBeenCalled();
  });

  test("copyBriefRefs frees every created id and refuses when the source is reassigned mid-copy under s3", async () => {
    const { runId, logoId } = await seedTarget();
    const srcId = await seedSource(SRC, [
      { name: "logo.png", bytes: PNG },
      { name: "alt.png", bytes: PNG_ALT },
      { name: "bg.png", bytes: PNG_ALT2 },
    ]);
    reassignAfter(SRC);

    await expect(copy([SRC])).rejects.toBeInstanceOf(BriefRefNotFoundError);

    // The target holds ONLY its own logo: alt and bg were freed, and the source's
    // three rows/objects are untouched (the copy ran, then the free cleaned only the target).
    expect((await rowsOf(db, runId)).map((r) => r.name)).toEqual(["logo.png"]);
    expect(await keysOf(store, runId)).toEqual([inputKey("local", runId, logoId)]);
    expect((await rowsOf(db, srcId)).map((r) => r.name).sort()).toEqual([
      "alt.png",
      "bg.png",
      "logo.png",
    ]);
    expect((await keysOf(store, srcId)).length).toBe(3);
    // The reassignment is REAL state: the production campaignVisibility sees it.
    const vis = await getBriefStore(CALLER).campaignVisibility(SRC);
    expect(vis).toBe("hidden");
  });

  test("copyBriefRefs frees the first source created assets too when only the second source is hidden under s3", async () => {
    const { runId, logoId } = await seedTarget();
    await seedSource(S1, [{ name: "s1.png", bytes: PNG_ALT }]);
    await seedSource(S2, [{ name: "s2.png", bytes: PNG_ALT2 }]);
    reassignAfter(S2);

    await expect(copy([S1, S2])).rejects.toBeInstanceOf(BriefRefNotFoundError);

    // BOTH sources' created copies are freed, not only the hidden one's — the request's
    // copies are one unit and the write is refused (decision 3). The target's own logo
    // was never copied and is never in `createdIds`, so it survives the free.
    expect((await rowsOf(db, runId)).map((r) => r.name)).toEqual(["logo.png"]);
    expect(await keysOf(store, runId)).toEqual([inputKey("local", runId, logoId)]);
  });

  test("a copyAssets failure on the second source frees the first source created ids and rethrows the original error under s3", async () => {
    const { runId } = await seedTarget();
    await seedSource(S1, [{ name: "s1.png", bytes: PNG_ALT }]);
    await seedSource(S2, [{ name: "s2.png", bytes: PNG_ALT2 }]);
    const copyError = new Error("copy failed");
    const real = ObjectAssetStore.prototype.copyAssets;
    vi.spyOn(ObjectAssetStore.prototype, "copyAssets").mockImplementation(async function (
      this: ObjectAssetStore,
      from: string,
      to: string,
    ) {
      if (from === S2) throw copyError;
      return real.call(this, from, to);
    });

    await expect(copy([S1, S2])).rejects.toBe(copyError);

    // The loop sits inside the one try: a later source's copy throwing frees the
    // earlier source's created ids (residual D) and rethrows the original error.
    expect((await rowsOf(db, runId)).map((r) => r.name)).toEqual(["logo.png"]);
  });

  test("copyBriefRefs frees nothing when every source is still visible under s3", async () => {
    const { runId } = await seedTarget();
    await seedSource(S1, [{ name: "s1.png", bytes: PNG_ALT }]);
    await seedSource(S2, [{ name: "s2.png", bytes: PNG_ALT2 }]);
    const free = vi.spyOn(ObjectAssetStore.prototype, "freeUnreferencedAssets");

    const result = await copy([S1, S2]);

    // Two visible sources: two created ids, and the clean path frees nothing.
    expect(result.createdIds).toHaveLength(2);
    expect((await rowsOf(db, runId)).map((r) => r.name).sort()).toEqual([
      "logo.png",
      "s1.png",
      "s2.png",
    ]);
    expect(free).not.toHaveBeenCalled();
  });

  test("copyBriefRefs keeps the target own asset, a reused asset and a version-named asset when the re-check fails under s3", async () => {
    const { runId, logoId } = await seedTarget();
    await seedSource(SRC, [
      { name: "logo.png", bytes: PNG },
      { name: "alt.png", bytes: PNG_ALT },
      { name: "bg.png", bytes: PNG_ALT2 },
    ]);
    const real = ObjectAssetStore.prototype.copyAssets;
    vi.spyOn(ObjectAssetStore.prototype, "copyAssets").mockImplementation(async function (
      this: ObjectAssetStore,
      from: string,
      to: string,
    ) {
      const result = await real.call(this, from, to);
      if (from === SRC) {
        // Read the target row the copy just minted for alt.png back BY NAME, not by index.
        const { rows } = await db.query<{ id: string }>(
          `select id from asset where org_id = 'local' and campaign_id = $1 and name = 'alt.png'`,
          [runId],
        );
        const altId = rows[0]!.id;
        // Commit a version into the target that NAMES the created alt id, before the re-check.
        const versionStore = new PgBriefStore(db, "local", "owner", ["owner"], [], true);
        await versionStore.createBrief({
          ...storedBrief(RUN),
          products: [
            { id: "p1", name: "P1", primaryColor: "#1473E3", logoPath: altId, inputAsset: altId },
          ],
        });
        // Now make the source hidden so the re-check refuses.
        await db.query(`update campaign set team_id = 't2' where org_id = 'local' and slug = $1`, [
          SRC,
        ]);
      }
      return result;
    });

    await expect(copy([SRC])).rejects.toBeInstanceOf(BriefRefNotFoundError);

    // logo is the target's own (and the reused one); alt is version-named (kept); bg is freed.
    const runRows = await rowsOf(db, runId);
    expect(runRows.map((r) => r.name).sort()).toEqual(["alt.png", "logo.png"]);
    const altRow = runRows.find((r) => r.name === "alt.png")!;
    expect(await keysOf(store, runId)).toEqual(
      [inputKey("local", runId, logoId), inputKey("local", runId, altRow.id)].sort(),
    );
  });

  test("the re-check refusal is a BriefRefNotFoundError naming the callers brief id and never the source slug", async () => {
    const { runId } = await seedTarget();
    await seedSource(SRC, [
      { name: "logo.png", bytes: PNG },
      { name: "alt.png", bytes: PNG_ALT },
      { name: "bg.png", bytes: PNG_ALT2 },
    ]);
    reassignAfter(SRC);

    let error: unknown;
    try {
      await copy([SRC]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BriefRefNotFoundError);
    expect((error as BriefRefNotFoundError).campaignId).toBe(RUN);
    expect((error as Error).message).toBe(`Campaign "${RUN}" not found`);
    expect((error as Error).message).not.toContain(SRC);
    expect((error as CampaignNotFoundError).statusCode).toBe(404);
  });

  test("copyBriefRefs refuses an absent source under s3 like a hidden one", async () => {
    const { runId, logoId } = await seedTarget();
    await seedSource(SRC, [
      { name: "logo.png", bytes: PNG },
      { name: "alt.png", bytes: PNG_ALT },
      { name: "bg.png", bytes: PNG_ALT2 },
    ]);
    // The FIRST campaignVisibility call is the re-check (copyBriefRefs calls it once per
    // source, after the copy): mocking it ONCE to "absent" makes the re-check refuse
    // exactly as the hidden case does, with the same 404 body (decision 5).
    vi.spyOn(PgBriefStore.prototype, "campaignVisibility").mockResolvedValueOnce("absent");

    let error: unknown;
    try {
      await copy([SRC]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BriefRefNotFoundError);
    expect((error as Error).message).toBe(`Campaign "${RUN}" not found`);
    // Same outcome as the hidden case: the created copies are freed, the target's own logo stays.
    expect((await rowsOf(db, runId)).map((r) => r.name)).toEqual(["logo.png"]);
    expect(await keysOf(store, runId)).toEqual([inputKey("local", runId, logoId)]);
  });

  test("a failing free does not mask the BriefRefNotFoundError", async () => {
    const { runId } = await seedTarget();
    await seedSource(SRC, [
      { name: "logo.png", bytes: PNG },
      { name: "alt.png", bytes: PNG_ALT },
      { name: "bg.png", bytes: PNG_ALT2 },
    ]);
    reassignAfter(SRC);
    // A rejected free must not replace the already-decided 404 (residual C).
    vi.spyOn(ObjectAssetStore.prototype, "freeUnreferencedAssets").mockRejectedValueOnce(
      new Error("free failed"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    let error: unknown;
    try {
      await copy([SRC]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BriefRefNotFoundError);
    expect((error as Error).message).toBe(`Campaign "${RUN}" not found`);
    expect((error as Error).message).not.toContain("free failed");
    // The free failed, so the created alt/bg stay (the documented residual C).
    expect((await rowsOf(db, runId)).map((r) => r.name).sort()).toEqual([
      "alt.png",
      "bg.png",
      "logo.png",
    ]);
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  test("a campaignVisibility failure frees the created ids and rethrows the original error under s3", async () => {
    const { runId } = await seedTarget();
    await seedSource(SRC, [
      { name: "logo.png", bytes: PNG },
      { name: "alt.png", bytes: PNG_ALT },
      { name: "bg.png", bytes: PNG_ALT2 },
    ]);
    const readError = new Error("connection reset");
    vi.spyOn(PgBriefStore.prototype, "campaignVisibility").mockRejectedValueOnce(readError);

    await expect(copy([SRC])).rejects.toBe(readError);
    // The catch still ran the free before rethrowing (fail closed), so the target holds only
    // its own logo.
    expect((await rowsOf(db, runId)).map((r) => r.name)).toEqual(["logo.png"]);
  });

  test("copyBriefRefs with no sources makes no visibility call and frees nothing", async () => {
    const { runId } = await seedTarget();
    const visibility = vi.spyOn(PgBriefStore.prototype, "campaignVisibility");
    const copyAssets = vi.spyOn(ObjectAssetStore.prototype, "copyAssets");
    const free = vi.spyOn(ObjectAssetStore.prototype, "freeUnreferencedAssets");

    const result = await copy([]);

    expect(result.createdIds).toEqual([]);
    expect(result.brief.id).toBe(RUN);
    expect(visibility).not.toHaveBeenCalled();
    expect(copyAssets).not.toHaveBeenCalled();
    expect(free).not.toHaveBeenCalled();
  });
});

describe("copyBriefRefs on pg plus fs re-checks by team and frees by path (PT-9i, D237)", () => {
  const SAVED_BACKEND = process.env.STORE_BACKEND;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  const ORIG_ROOT = process.env.PROJECT_ROOT;
  let db: SqlClient;
  let dir: string;
  let ownerStore: PgBriefStore;

  const copy = (from: string[]) => copyBriefRefs(CALLER, storedBrief(RUN), from, RUN);

  beforeEach(async () => {
    process.env.STORE_BACKEND = "postgres";
    delete process.env.OBJECT_STORE;
    db = await migratedDatabase();
    setDatabase(db);
    resetProjectRoot();
    dir = mkdtempSync(join(tmpdir(), "cf-copy-recheck-pgfs-"));
    process.env.PROJECT_ROOT = dir;
    resetBriefStore();
    resetAssetStore();
    resetObjectStoreClient();
    ownerStore = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values
         ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
      ["t1", "Team One", "local", "t2", "Team Two"],
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetObjectStoreClient();
    resetDatabase();
    resetBriefStore();
    resetAssetStore();
    if (ORIG_ROOT === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = ORIG_ROOT;
    resetProjectRoot();
    if (SAVED_BACKEND === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = SAVED_BACKEND;
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    rmSync(dir, { recursive: true, force: true });
    await db.end();
  });

  const seedTarget = async () => {
    const { campaignId: runId } = await ownerStore.createCampaign(RUN);
    await getAssetStore(CALLER).writeAsset(RUN, "logo.png", PNG);
    return { runId };
  };

  const seedSource = async (
    slug: string,
    files: readonly { name: string; bytes: Buffer }[],
  ): Promise<string> => {
    const { campaignId } = await ownerStore.createCampaign(slug, { teamId: "t1" });
    const assets = getAssetStore(CALLER);
    for (const file of files) {
      await assets.writeAsset(slug, file.name, file.bytes);
    }
    return campaignId;
  };

  /** Wrap the real `FsAssetStore.copyAssets` so the reassignment is REAL state the pg campaignVisibility reads afterwards. */
  const reassignAfter = (hiddenSlug: string): void => {
    const real = FsAssetStore.prototype.copyAssets;
    vi.spyOn(FsAssetStore.prototype, "copyAssets").mockImplementation(async function (
      this: FsAssetStore,
      from: string,
      to: string,
    ) {
      const result = await real.call(this, from, to);
      if (from === hiddenSlug) {
        await db.query(`update campaign set team_id = 't2' where org_id = 'local' and slug = $1`, [
          hiddenSlug,
        ]);
      }
      return result;
    });
  };

  test("copyBriefRefs on pg plus fs frees the created files and refuses when the source is reassigned mid-copy", async () => {
    const { runId } = await seedTarget();
    await seedSource(SRC, [
      { name: "alt.png", bytes: PNG_ALT },
      { name: "bg.png", bytes: PNG_ALT2 },
    ]);
    reassignAfter(SRC);
    const free = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");

    await expect(copy([SRC])).rejects.toBeInstanceOf(BriefRefNotFoundError);

    const assets = getAssetStore(CALLER);
    expect((await assets.listAssets(RUN)).map((a) => a.name)).toEqual(["logo.png"]);
    expect(await assets.readAsset(RUN, "alt.png")).toBeUndefined();
    expect(await assets.readAsset(RUN, "bg.png")).toBeUndefined();
    expect((await assets.listAssets(SRC)).map((a) => a.name).sort()).toEqual(["alt.png", "bg.png"]);
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0]![0]).toBe(RUN);
    // fs `createdIds` are the TARGET-relative paths, in filesystem order, so sort observed.
    expect([...free.mock.calls[0]![1]].sort()).toEqual(["alt.png", "bg.png"]);
  });

  test("copyBriefRefs on pg plus fs keeps a reused file when the re-check fails", async () => {
    const { runId } = await seedTarget();
    // SRC's logo.png carries the SAME bytes as the target's own — it is reused, never created.
    await seedSource(SRC, [
      { name: "logo.png", bytes: PNG },
      { name: "alt.png", bytes: PNG_ALT },
    ]);
    reassignAfter(SRC);
    const free = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");

    await expect(copy([SRC])).rejects.toBeInstanceOf(BriefRefNotFoundError);

    const assets = getAssetStore(CALLER);
    expect((await assets.listAssets(RUN)).map((a) => a.name)).toEqual(["logo.png"]);
    expect(free).toHaveBeenCalledTimes(1);
    expect(free.mock.calls[0]![0]).toBe(RUN);
    // The reused path is not passed to the free — only what THIS call minted.
    expect([...free.mock.calls[0]![1]].sort()).toEqual(["alt.png"]);
  });

  test("copyBriefRefs on pg plus fs lets an absent source through and keeps its copies", async () => {
    const { runId } = await seedTarget();
    // A slug with files but NO campaign row: pg answers "absent", and off s3 only
    // "hidden" refuses (decision 1), so the re-check lets it through.
    await getAssetStore(CALLER).writeAsset(SRC, "alt.png", PNG_ALT);
    await getAssetStore(CALLER).writeAsset(SRC, "bg.png", PNG_ALT2);
    const free = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");

    const result = await copy([SRC]);

    expect([...result.createdIds].sort()).toEqual(["alt.png", "bg.png"]);
    expect((await getAssetStore(CALLER).listAssets(RUN)).map((a) => a.name).sort()).toEqual([
      "alt.png",
      "bg.png",
      "logo.png",
    ]);
    expect(free).not.toHaveBeenCalled();
  });
});

describe("copyBriefRefs on fs (no teams) makes no visibility call and keeps its copies", () => {
  const SAVED_BACKEND = process.env.STORE_BACKEND;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  const ORIG_ROOT = process.env.PROJECT_ROOT;
  let dir: string;

  const copy = (from: string[]) => copyBriefRefs(CALLER, storedBrief(RUN), from, RUN);

  beforeEach(() => {
    delete process.env.STORE_BACKEND;
    delete process.env.OBJECT_STORE;
    resetProjectRoot();
    dir = mkdtempSync(join(tmpdir(), "cf-copy-recheck-fs-"));
    process.env.PROJECT_ROOT = dir;
    resetBriefStore();
    resetAssetStore();
    resetObjectStoreClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetBriefStore();
    resetAssetStore();
    resetObjectStoreClient();
    if (ORIG_ROOT === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = ORIG_ROOT;
    resetProjectRoot();
    if (SAVED_BACKEND === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = SAVED_BACKEND;
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    rmSync(dir, { recursive: true, force: true });
  });

  test("copyBriefRefs on fs makes no visibility call and returns the created paths", async () => {
    await getBriefStore(CALLER).createCampaign(RUN);
    await getAssetStore(CALLER).writeAsset(RUN, "logo.png", PNG);
    await getBriefStore(CALLER).createCampaign(SRC);
    const assets = getAssetStore(CALLER);
    await assets.writeAsset(SRC, "alt.png", PNG_ALT);
    await assets.writeAsset(SRC, "bg.png", PNG_ALT2);
    const visibility = vi.spyOn(FsBriefStore.prototype, "campaignVisibility");
    const free = vi.spyOn(FsAssetStore.prototype, "freeUnreferencedAssets");

    const result = await copy([SRC]);

    expect(visibility).not.toHaveBeenCalled();
    expect(free).not.toHaveBeenCalled();
    expect([...result.createdIds].sort()).toEqual(["alt.png", "bg.png"]);
    expect((await assets.listAssets(RUN)).map((a) => a.name).sort()).toEqual([
      "alt.png",
      "bg.png",
      "logo.png",
    ]);
  });
});
