import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
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
import { resetAssetStore, resetBriefStore } from "../ports/index.js";
import { ObjectAssetStore } from "../ports/object-asset-store.js";
import { extractSourceAssetBriefIds } from "../asset-files.js";
import type { TenantContext } from "../tenant.js";
import { copyBriefRefs, resolveBriefAssetRefs } from "../brief-asset-refs.js";

/**
 * `resolveBriefAssetRefs`'s new `copyOnly` map (PT-9k, D238): the asset NAMES a brief
 * references per foreign source, which `copyBriefRefs` hands to `copyAssets` as `only`.
 *
 * The s3 harness is `brief-asset-refs.test.ts`'s save-mode fixture; the pg+fs and fs
 * describes are its staging and fs fixtures; the `copyBriefRefs` unit harness is
 * `brief-asset-refs.copy-recheck.test.ts`'s.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** A DIFFERENT byte string, uploaded under a second name in the friend campaign. */
const PNG_ALT = Buffer.concat([PNG, Buffer.from([0x00])]);
/** Distinct from `PNG_ALT` so nothing dedupes across two sources in one request. */
const PNG_ALT2 = Buffer.concat([PNG, Buffer.from([0x00, 0x00])]);

const RUN = "run-me";
const FRIEND = "friend";
const FRIEND2 = "friend-two";
const THEIRS = "theirs";

/** The friend campaign's SECOND, differently-bitted asset — the one a copy really moves. */
const FRIEND_ALT = "friend-alt";

const CALLER: TenantContext = { orgId: "local", userId: "u1", roles: [], teamIds: ["t1"] };

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

/** A brief carrying `ref` in the one field under test, the target's OWN ref elsewhere. */
const withRef = (field: Field, ref: string): CampaignBrief => {
  const base = storedBrief(RUN);
  switch (field) {
    case "products[].logoPath":
      return {
        ...base,
        products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: ref }],
      };
    case "products[].inputAsset":
      return {
        ...base,
        products: [
          { id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: DEMO_REF, inputAsset: ref },
        ],
      };
    case "audio.path":
      return { ...base, audio: { path: ref, rights: { licenceId: "lic-1", source: "library" } } };
    case "copy.timeline.beats[].background":
      return {
        ...base,
        copy: {
          timeline: {
            beats: [{ text: "Go", weight: 1, background: ref }],
            transition: "cut",
            keyBeat: 1,
          },
        },
      };
  }
};

type Field =
  | "products[].logoPath"
  | "products[].inputAsset"
  | "audio.path"
  | "copy.timeline.beats[].background";

const SAVED_BACKEND = process.env.STORE_BACKEND;
const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

const restoreSwitches = (): void => {
  if (SAVED_BACKEND === undefined) delete process.env.STORE_BACKEND;
  else process.env.STORE_BACKEND = SAVED_BACKEND;
  if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
  else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
};

describe("resolveBriefAssetRefs copyOnly under s3 (PT-9k, D238)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  /** Real ids, minted by `writeAsset`, per campaign. */
  const ids: Record<string, string> = {};

  const save = (brief: CampaignBrief) =>
    resolveBriefAssetRefs(CALLER, brief, { target: brief.id, mode: "save" });

  beforeAll(async () => {
    process.env.STORE_BACKEND = "postgres";
    process.env.OBJECT_STORE = "s3";
    db = await migratedDatabase();
    setDatabase(db);
    resetBriefStore();
    store = new InMemoryObjectStore();
    setObjectStoreClient(store);
    resetAssetStore();

    await db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values
         ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
      ["t1", "Team One", "local", "t2", "Team Two"],
    );
    await db.query(`insert into org (id, name) values ($1, $1)`, ["other"]);

    const ownerStore = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await ownerStore.createBrief(storedBrief(RUN));
    await ownerStore.createBrief(storedBrief(FRIEND));
    await ownerStore.createBrief(storedBrief(FRIEND2));
    await ownerStore.createBrief(storedBrief(THEIRS), { teamId: "t2" });
    await new PgBriefStore(db, "other", "o", [], []).createBrief(storedBrief("theirs-other"));

    const localAssets = new ObjectAssetStore(db, store, "local");
    for (const slug of [RUN, FRIEND, FRIEND2]) {
      ids[slug] = (await localAssets.writeAsset(slug, "logo.png", PNG)).id!;
    }
    ids[FRIEND_ALT] = (await localAssets.writeAsset(FRIEND, "alt.png", PNG_ALT)).id!;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetBriefStore();
    resetAssetStore();
  });

  afterAll(async () => {
    resetObjectStoreClient();
    resetDatabase();
    restoreSwitches();
    await db.end();
  });

  test("resolveBriefAssetRefs records the referenced names per foreign source under s3 (M4, M5)", async () => {
    // A brief whose logo is the FRIEND alt id AND whose input asset is a FRIEND path
    // ref — the id ref and the path ref of the SAME campaign, walking into both the
    // id branch and the path branch of the record.
    const brief: CampaignBrief = {
      ...storedBrief(RUN),
      products: [
        {
          id: "p1",
          name: "P1",
          primaryColor: "#1473E3",
          logoPath: ids[FRIEND_ALT],
          inputAsset: `assets/inputs/${FRIEND}/logo.png`,
        },
      ],
    };

    const resolved = await save(brief);

    expect(resolved.copyFrom).toEqual([FRIEND]);
    // logo first (the id ref), then inputAsset (the path ref): two kinds, one source.
    expect([...resolved.copyOnly.entries()]).toEqual([[FRIEND, ["alt.png", "logo.png"]]]);
  });

  test("resolveBriefAssetRefs gives each foreign source its own names and none for the target under s3 (M6)", async () => {
    // logoPath names FRIEND's alt id; inputAsset names FRIEND2 by PATH; audio names
    // the target's OWN path (refused by the helper); the beat backgrounds FRIEND's
    // alt PATH — the same row the logo id ref already names, so it is deduped.
    const brief: CampaignBrief = {
      ...storedBrief(RUN),
      products: [
        {
          id: "p1",
          name: "P1",
          primaryColor: "#1473E3",
          logoPath: ids[FRIEND_ALT],
          inputAsset: `assets/inputs/${FRIEND2}/logo.png`,
        },
      ],
      audio: {
        path: `assets/inputs/${RUN}/logo.png`,
        rights: { licenceId: "lic-1", source: "library" },
      },
      copy: {
        timeline: {
          beats: [{ text: "Go", weight: 1, background: `assets/inputs/${FRIEND}/alt.png` }],
          transition: "cut",
          keyBeat: 1,
        },
      },
    };

    const resolved = await save(brief);

    // Two foreign slugs, each with its own names; the target's own path never enters.
    expect([...resolved.copyOnly.entries()]).toEqual([
      [FRIEND, ["alt.png"]],
      [FRIEND2, ["logo.png"]],
    ]);
  });
});

describe("resolveBriefAssetRefs copyOnly on pg plus fs (staging: D210 d, r2)", () => {
  let db: SqlClient;
  const save = (brief: CampaignBrief, target = RUN) =>
    resolveBriefAssetRefs(CALLER, brief, { target, mode: "save" });

  beforeAll(async () => {
    process.env.STORE_BACKEND = "postgres";
    // `OBJECT_STORE` unset: staging today, and the team check is the whole of D210(d)
    // here.
    delete process.env.OBJECT_STORE;
    db = await migratedDatabase();
    setDatabase(db);
    resetBriefStore();
    resetAssetStore();
    await db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values
         ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
      ["t1", "Team One", "local", "t2", "Team Two"],
    );
    const ownerStore = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await ownerStore.createBrief(storedBrief(RUN));
    await ownerStore.createBrief(storedBrief(FRIEND));
    await ownerStore.createBrief(storedBrief(THEIRS), { teamId: "t2" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetBriefStore();
    resetAssetStore();
  });

  afterAll(async () => {
    resetDatabase();
    restoreSwitches();
    await db.end();
  });

  test("resolveBriefAssetRefs derives the names off s3 from the path refs and normalises them (M7)", async () => {
    // `./` and `../` segments: the regex captures the raw name, and `posix.normalize`
    // is what turns `./logo.png` into `logo.png` while `logo.png` itself is unchanged.
    const brief: CampaignBrief = {
      ...storedBrief(RUN),
      products: [
        {
          id: "p1",
          name: "P1",
          primaryColor: "#1473E3",
          logoPath: `assets/inputs/${FRIEND}/./logo.png`,
        },
        // A root-level demo ref names NO campaign (no slash after the segment), so the
        // regex's `match === null` arm is the only thing that reaches it.
        { id: "p2", name: "P2", primaryColor: "#1473E3", logoPath: DEMO_REF },
      ],
      audio: {
        path: `assets/inputs/${FRIEND}/sub/../bed.mp3`,
        rights: { licenceId: "lic-1", source: "library" },
      },
    };

    const resolved = await save(brief);

    // `copyFrom` is exactly what `extractSourceAssetBriefIds` reads — the two FRIEND
    // path refs, not the demo ref.
    expect(resolved.copyFrom).toEqual(extractSourceAssetBriefIds(brief, RUN));
    // `copyOnly` normalises `./logo.png` -> "logo.png" and `sub/../bed.mp3` -> "bed.mp3",
    // and the demo ref contributes nothing.
    expect(resolved.copyOnly).toEqual(new Map([[FRIEND, ["logo.png", "bed.mp3"]]]));
    // Off s3 the brief is the input object, unrewritten.
    expect(resolved.brief).toBe(brief);
  });
});

describe("resolveBriefAssetRefs copyOnly on fs (no teams: D210 d)", () => {
  let dir: string;
  const origRoot = process.env.PROJECT_ROOT;

  beforeEach(() => {
    resetProjectRoot();
    dir = mkdtempSync(join(tmpdir(), "cf-brief-refs-copy-only-"));
    process.env.PROJECT_ROOT = dir;
    process.env.STORE_BACKEND = "fs";
    delete process.env.OBJECT_STORE;
    resetBriefStore();
    resetAssetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetBriefStore();
    resetAssetStore();
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    resetProjectRoot();
    restoreSwitches();
    rmSync(dir, { recursive: true, force: true });
  });

  test("save mode on fs answers copyOnly for a path ref and still makes NO store call (M7)", async () => {
    const visibility = vi.spyOn(FsBriefStore.prototype, "campaignVisibility");
    const assetStore = vi.spyOn(FsAssetStore.prototype, "listAssets");
    const brief = withRef("products[].logoPath", `assets/inputs/${FRIEND}/logo.png`);
    const resolved = await resolveBriefAssetRefs(CALLER, brief, { target: RUN, mode: "save" });
    expect(resolved.copyFrom).toEqual([FRIEND]);
    expect(resolved.copyFrom).toEqual(extractSourceAssetBriefIds(brief, RUN));
    expect(resolved.copyOnly).toEqual(new Map([[FRIEND, ["logo.png"]]]));
    expect(resolved.brief).toBe(brief);
    expect(resolved.foreignIds).toEqual(new Set());
    expect(resolved.ownIds).toEqual(new Set());
    expect(visibility).not.toHaveBeenCalled();
    expect(assetStore).not.toHaveBeenCalled();
  });

  test("render on fs (!supportsTeams) answers an empty copyOnly map", async () => {
    // The `!briefs.supportsTeams` return covers `render` off s3: there are no copy
    // sources and no names, so the map is empty — the route passes nothing as `only`.
    const brief = withRef("products[].logoPath", `assets/inputs/${FRIEND}/logo.png`);
    const resolved = await resolveBriefAssetRefs(CALLER, brief, { target: RUN, mode: "render" });
    expect(resolved.copyFrom).toEqual([]);
    expect(resolved.copyOnly).toEqual(new Map());
    expect(resolved.brief).toBe(brief);
  });
});

describe("copyBriefRefs only (PT-9k, D238)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  let ownerStore: PgBriefStore;

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

  const seedTarget = async (): Promise<{ runId: string; logoId: string }> => {
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

  const rowsOf = async (campaignId: string): Promise<string[]> =>
    (
      await db.query<{ name: string }>(
        `select name from asset where org_id = 'local' and campaign_id = $1 order by name`,
        [campaignId],
      )
    ).rows.map((r) => r.name);

  test("copyBriefRefs passes only to the sources that have an entry and copies the rest whole under s3 (M3, M8)", async () => {
    const { runId } = await seedTarget();

    const friendId = await seedSource(FRIEND, [
      { name: "alt.png", bytes: PNG_ALT },
      { name: "bg.png", bytes: PNG_ALT2 },
    ]);
    const otherId = await seedSource("other-src", [
      { name: "x.png", bytes: PNG_ALT },
      { name: "y.png", bytes: PNG_ALT2 },
    ]);

    const copyAssets = vi.spyOn(ObjectAssetStore.prototype, "copyAssets");

    // First call: FRIEND is narrowed to its named asset, OTHER is copied whole.
    const result = await copyBriefRefs(
      CALLER,
      storedBrief(RUN),
      [FRIEND, "other-src"],
      RUN,
      new Map([[FRIEND, ["alt.png"]]]),
    );

    expect(copyAssets).toHaveBeenNthCalledWith(1, FRIEND, RUN, { only: ["alt.png"] });
    expect(copyAssets).toHaveBeenCalledWith("other-src", RUN);
    // The whole-library call must stay two-argument.
    expect(copyAssets.mock.calls[1]).toHaveLength(2);
    // The target holds the narrowed FRIEND asset plus EVERY row of OTHER.
    expect(await rowsOf(runId)).toEqual(["alt.png", "logo.png", "x.png", "y.png"]);
    // Neither source is touched by a successful copy.
    expect(await rowsOf(friendId)).toEqual(["alt.png", "bg.png"]);
    expect(await rowsOf(otherId)).toEqual(["x.png", "y.png"]);

    // Second call with NO fifth argument: every source is two-argument again.
    copyAssets.mockClear();
    await copyBriefRefs(CALLER, storedBrief(RUN), [FRIEND, "other-src"], RUN);
    expect(copyAssets).toHaveBeenNthCalledWith(1, FRIEND, RUN);
    expect(copyAssets).toHaveBeenNthCalledWith(2, "other-src", RUN);
    expect(result.createdIds.length).toBeGreaterThan(0);
  });
});
