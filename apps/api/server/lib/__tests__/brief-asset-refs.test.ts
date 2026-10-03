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
import { CampaignNotFoundError } from "../ownership.js";
import type { TenantContext } from "../tenant.js";
import { BriefRefNotFoundError, resolveBriefAssetRefs } from "../brief-asset-refs.js";

/**
 * `resolveBriefAssetRefs` in `render` mode (PT-4k2a, D208 B/D, D210 a/c/d).
 *
 * The one rule under test: **under s3, a ref that NAMES a campaign the caller cannot
 * see is the same 404 as a brief whose own campaign is hidden, and under pg + fs only
 * the team half of that is checked** (D210 d) while fs is untouched (D210 d, item 4).
 *
 * Everything is offline and in-process: a real Postgres (or PGlite) database, an
 * `InMemoryObjectStore`, and the same `PgBriefStore`/`ObjectAssetStore` the routes go
 * through — so an id under test is one `writeAsset` really minted, and another org's id
 * is one another org REALLY holds, which is what makes a missing `org_id` in a query
 * fail here rather than pass.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** The brief's OWN campaign — the `target`, and the owner its own refs have. */
const RUN = "run-me";
/** A second visible campaign in the same org: foreign, and legal. */
const FRIEND = "friend";
/** Same org, but on team `t2` — invisible to the caller. */
const THEIRS = "theirs";
/** Another org's campaign, with a real asset in that org and none in this one. */
const OTHER_ORG_CAMP = "theirs-other";
const OTHER_ORG = "other";

const CALLER: TenantContext = { orgId: "local", userId: "u1", roles: [], teamIds: ["t1"] };

/** The root-level demo ref the editor's own default brief carries (`run-context.tsx:553`). */
const DEMO_REF = "assets/inputs/hydra-logo.png";
/** Not a uuid, so `isAssetId` refuses it and it is read as a path — which names no campaign. */
const MALFORMED_ID = "not-a-uuid";

const storedBrief = (id: string): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id,
  mode: "brief",
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: DEMO_REF }],
});

/** A brief of the caller's own, carrying `ref` in the one field under test. */
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
      return {
        ...base,
        audio: { path: ref, rights: { licenceId: "lic-1", source: "library" } },
      };
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

/** The four ref fields, in `rewriteAssetPaths`' order — and there are no others. */
type Field =
  | "products[].logoPath"
  | "products[].inputAsset"
  | "audio.path"
  | "copy.timeline.beats[].background";

const FIELDS: readonly Field[] = [
  "products[].logoPath",
  "products[].inputAsset",
  "audio.path",
  "copy.timeline.beats[].background",
];

const SAVED_BACKEND = process.env.STORE_BACKEND;
const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

/** One `asset` row as read back, so a test that deletes one can have it restored. */
interface AssetRow {
  readonly id: string;
  readonly org_id: string;
  readonly campaign_id: string;
  readonly kind: string;
  readonly name: string;
  readonly size: number | string;
  readonly sha256: string;
  readonly content_type: string;
}

/** Restore both switches, whatever a test did to them. */
const restoreSwitches = (): void => {
  if (SAVED_BACKEND === undefined) delete process.env.STORE_BACKEND;
  else process.env.STORE_BACKEND = SAVED_BACKEND;
  if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
  else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
};

describe("resolveBriefAssetRefs — render mode under s3 (PT-4k2a, D208 D, D210 a/c)", () => {
  let db: SqlClient;
  let store: InMemoryObjectStore;
  /** Real ids, minted by `writeAsset`, per campaign. */
  const ids: Record<string, string> = {};
  /** The uploaded rows, read back so a test that deletes one can have it restored. */
  let assets: AssetRow[] = [];

  const pathRef = (slug: string): string => `assets/inputs/${slug}/logo.png`;

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
    await db.query(`insert into org (id, name) values ($1, $1)`, [OTHER_ORG]);

    const ownerStore = new PgBriefStore(db, "local", "owner", ["owner"], []);
    await ownerStore.createBrief(storedBrief(RUN));
    await ownerStore.createBrief(storedBrief(FRIEND));
    await ownerStore.createBrief(storedBrief(THEIRS), { teamId: "t2" });
    await new PgBriefStore(db, OTHER_ORG, "o", [], []).createBrief(storedBrief(OTHER_ORG_CAMP));

    const localAssets = new ObjectAssetStore(db, store, "local");
    for (const slug of [RUN, FRIEND, THEIRS]) {
      ids[slug] = (await localAssets.writeAsset(slug, "logo.png", PNG)).id!;
    }
    // The other org's asset really exists — under ITS org's key, with a row of its own.
    // A query that forgot `org_id` would find it, so this is where such a leak surfaces.
    ids[OTHER_ORG_CAMP] = (
      await new ObjectAssetStore(db, store, OTHER_ORG).writeAsset(OTHER_ORG_CAMP, "logo.png", PNG)
    ).id!;

    // The fixture is ONCE per suite, not per test: this file clones a migrated
    // database for every `beforeEach`, and a clone is a create-and-drop round trip
    // against a shared server. Two tests delete an `asset` row (the "row is gone"
    // cases), so the rows are read back here and restored in `beforeEach` — each test
    // still starts from exactly the same fixture.
    const { rows } = await db.query<AssetRow>(
      `select id, org_id, campaign_id, kind, name, size, sha256, content_type from asset`,
    );
    assets = rows;
  });

  beforeEach(async () => {
    // Put back whatever a previous test deleted, by its OWN id: a re-minted id would
    // change what `ids[...]` names and quietly stop testing the same ref.
    for (const row of assets) {
      await db.query(
        `insert into asset (id, org_id, campaign_id, kind, name, size, sha256, content_type)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (id) do nothing`,
        [
          row.id,
          row.org_id,
          row.campaign_id,
          row.kind,
          row.name,
          row.size,
          row.sha256,
          row.content_type,
        ],
      );
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetBriefStore();
    resetAssetStore();
  });

  afterAll(async () => {
    // The injected client belongs to the suite, so it is unmounted HERE rather than
    // after every test: resetting it per test leaves the second test building a real
    // S3 adapter out of `S3_ENDPOINT`, which no test set.
    resetObjectStoreClient();
    resetDatabase();
    restoreSwitches();
    await db.end();
  });

  const render = (brief: CampaignBrief) =>
    resolveBriefAssetRefs(CALLER, brief, { target: brief.id, mode: "render" });

  describe.each(FIELDS)("the %s field", (field) => {
    test("an id ref in a VISIBLE campaign passes and the brief comes back UNCHANGED", async () => {
      const brief = withRef(field, ids[RUN]!);
      const resolved = await render(brief);
      // The same object, not a copy with equal fields: `render` is a check, and the
      // `RunRequest` contract is the body brief byte for byte (D210 a).
      expect(resolved.brief).toBe(brief);
      // The owner's own ref is not a copy source, and there is nothing to copy.
      expect(resolved.copyFrom).toEqual([]);
      expect(resolved.foreignIds).toEqual(new Set());
    });

    test("a path ref in a VISIBLE campaign passes and the brief comes back UNCHANGED", async () => {
      const brief = withRef(field, pathRef(RUN));
      const resolved = await render(brief);
      expect(resolved.brief).toBe(brief);
      expect(resolved.copyFrom).toEqual([]);
    });

    test("the team check runs even for a ref the caller OWNS", async () => {
      // `assetOwner`/`listAssets` are org-scoped only, by design — "in my org" is not
      // "mine to see", and a target-owned ref is exactly where inferring the team from
      // the asset store would skip the one query that matters.
      const spy = vi.spyOn(PgBriefStore.prototype, "campaignVisibility");
      await render(withRef(field, ids[RUN]!));
      expect(spy).toHaveBeenCalledWith(RUN);
      spy.mockClear();
      await render(withRef(field, pathRef(RUN)));
      expect(spy).toHaveBeenCalledWith(RUN);
    });

    test("an id ref in a team-HIDDEN campaign answers 404", async () => {
      await expect(render(withRef(field, ids[THEIRS]!))).rejects.toBeInstanceOf(
        BriefRefNotFoundError,
      );
    });

    test("a path ref naming a team-HIDDEN campaign answers 404", async () => {
      await expect(render(withRef(field, pathRef(THEIRS)))).rejects.toBeInstanceOf(
        BriefRefNotFoundError,
      );
    });

    test("another org's id answers 404 — org-scoped, so it is absent and never forbidden", async () => {
      // The row exists, in another org. `assetOwner` is org-scoped, so it answers
      // `undefined` and the refusal is byte-identical to a ref that names nothing.
      await expect(render(withRef(field, ids[OTHER_ORG_CAMP]!))).rejects.toBeInstanceOf(
        BriefRefNotFoundError,
      );
    });

    test("a path ref naming ANOTHER ORG's campaign answers 404", async () => {
      await expect(render(withRef(field, pathRef(OTHER_ORG_CAMP)))).rejects.toBeInstanceOf(
        BriefRefNotFoundError,
      );
    });

    test("an id whose ROW is gone, in a visible campaign, answers 404", async () => {
      await db.query(`delete from asset where id = $1`, [ids[RUN]!]);
      await expect(render(withRef(field, ids[RUN]!))).rejects.toBeInstanceOf(BriefRefNotFoundError);
    });

    test("a path whose ROW is gone, in a visible campaign, answers 404", async () => {
      // A missing upload is NOT a reason to render without the logo (D210 c): a
      // skip here is how a hidden campaign and a deleted row become two answers.
      await db.query(`delete from asset where id = $1`, [ids[RUN]!]);
      await expect(render(withRef(field, pathRef(RUN)))).rejects.toBeInstanceOf(
        BriefRefNotFoundError,
      );
    });

    test("a malformed id passes through unchanged (it names no campaign)", async () => {
      const brief = withRef(field, MALFORMED_ID);
      const resolved = await render(brief);
      expect(resolved.brief).toBe(brief);
      expect(resolved.copyFrom).toEqual([]);
    });

    test("a root-level demo ref passes through in render", async () => {
      // The editor's own default brief (`run-context.tsx:553`) is built from these, and
      // `ObjectInputAssets` already answers them as ENOENT: nothing to check, so no
      // new 404 for a brief the web sends today.
      const brief = withRef(field, DEMO_REF);
      const resolved = await render(brief);
      expect(resolved.brief).toBe(brief);
    });
  });

  test("copyFrom is the distinct foreign owners in first-seen order and never the target", async () => {
    const brief = {
      ...storedBrief(RUN),
      products: [
        // friend, friend again (distinct), then run-me (the target, never a source).
        { id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: pathRef(FRIEND) },
        { id: "p2", name: "P2", primaryColor: "#1473E6", logoPath: pathRef(FRIEND) },
        { id: "p3", name: "P3", primaryColor: "#1473E6", logoPath: pathRef(RUN) },
      ],
      audio: {
        path: ids[FRIEND]!,
        rights: { licenceId: "lic-1", source: "library" },
      },
    };
    const resolved = await render(brief);
    expect(resolved.copyFrom).toEqual([FRIEND]);
    // Only the ids IN the brief: the path ref above is still a path in a render brief.
    expect(resolved.foreignIds).toEqual(new Set([ids[FRIEND]!]));
  });

  test("the 404 carries the CALLER'S brief id and never the owner slug or the ref", async () => {
    const error = await render(withRef("products[].logoPath", pathRef(THEIRS))).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CampaignNotFoundError);
    expect((error as CampaignNotFoundError).campaignId).toBe(RUN);
    // The message is what a route body is built from, so this is the assertion that
    // keeps a guessable slug from being echoed back as an oracle.
    expect((error as Error).message).toBe(`Campaign "${RUN}" not found`);
    expect((error as Error).message).not.toContain(THEIRS);
    expect((error as Error).message).not.toContain("logo.png");
  });

  test("a campaignVisibility rejection propagates unchanged — a storage failure is a 500", async () => {
    const readError = new Error("connection reset");
    vi.spyOn(PgBriefStore.prototype, "campaignVisibility").mockRejectedValueOnce(readError);
    // Folding this into the 404 would tell the caller its campaign does not exist when
    // the truth is that this scope could not be checked.
    await expect(render(withRef("products[].logoPath", pathRef(RUN)))).rejects.toBe(readError);
  });

  test("a refs-free brief makes NO store call at all", async () => {
    const visibility = vi.spyOn(PgBriefStore.prototype, "campaignVisibility");
    const assetOwner = vi.spyOn(ObjectAssetStore.prototype, "assetOwner");
    const listAssets = vi.spyOn(ObjectAssetStore.prototype, "listAssets");
    // No products, no audio, no timeline: nothing to check, so the loop never reaches
    // a store — the visibility query per ref is not paid for a campaign that names none.
    const brief: CampaignBrief = { ...storedBrief(RUN), products: [] };
    const resolved = await render(brief);
    expect(resolved.brief).toBe(brief);
    expect(resolved.copyFrom).toEqual([]);
    expect(visibility).not.toHaveBeenCalled();
    expect(assetOwner).not.toHaveBeenCalled();
    expect(listAssets).not.toHaveBeenCalled();
  });

  test("absent audio and absent beat background gain NO key", async () => {
    // `rewriteAssetPaths`' discipline (VE-D3 / VE5b2): a key that was not there must
    // not appear, or a byte-identity comparison a caller makes against the brief it
    // sent sees a difference nothing rendered.
    const brief: CampaignBrief = {
      ...storedBrief(RUN),
      copy: { timeline: { beats: [{ text: "Go", weight: 1 }], transition: "cut", keyBeat: 1 } },
    };
    const resolved = await render(brief);
    expect("audio" in resolved.brief).toBe(false);
    expect("background" in (resolved.brief.copy!.timeline!.beats[0] as object)).toBe(false);
    expect(resolved.brief).toBe(brief);
  });

  test("save mode is PT-4k2b's, and refuses rather than doing today's path-derived check", async () => {
    await expect(
      resolveBriefAssetRefs(CALLER, storedBrief(RUN), { target: RUN, mode: "save" }),
    ).rejects.toThrow("save mode lands in PT-4k2b");
  });
});

describe("resolveBriefAssetRefs — render mode on pg + fs (staging: D210 d, r2)", () => {
  let db: SqlClient;

  beforeAll(async () => {
    process.env.STORE_BACKEND = "postgres";
    // `OBJECT_STORE` unset: this is staging today, and the team check is the whole of
    // what D210(d) adds here.
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

  const render = (brief: CampaignBrief) =>
    resolveBriefAssetRefs(CALLER, brief, { target: brief.id, mode: "render" });

  test.each(FIELDS)("a path ref to a team-HIDDEN campaign answers 404 (%s)", async (field) => {
    // This is the pre-existing cross-team read D210(d) closes on staging: there are no
    // asset rows under fs, so the slug in the ref is the only thing there is to check.
    await expect(render(withRef(field, `assets/inputs/${THEIRS}/logo.png`))).rejects.toBeInstanceOf(
      BriefRefNotFoundError,
    );
  });

  test.each(FIELDS)("a path ref to a VISIBLE campaign passes (%s)", async (field) => {
    const brief = withRef(field, `assets/inputs/${RUN}/logo.png`);
    await expect(render(brief)).resolves.toMatchObject({ brief });
  });

  test("an id-shaped ref and a campaign-less ref pass through, and NO asset store is built", async () => {
    // fs has no ids to own and no rows to find, so an id is a path fs cannot read
    // (`FileSystemInputAssets` answers `undefined`) — inventing a 404 for it would be
    // a new answer staging has never given.
    const assetStore = await vi.spyOn(await import("../ports/index.js"), "getAssetStore");
    for (const ref of ["00000000-0000-4000-8000-000000000000", DEMO_REF, MALFORMED_ID]) {
      const brief = withRef("products[].logoPath", ref);
      await expect(render(brief)).resolves.toMatchObject({ brief });
    }
    expect(assetStore).not.toHaveBeenCalled();
  });

  test("the pg+fs branch never reaches `assetOwner` or `listAssets`", async () => {
    const assetOwner = vi.spyOn(ObjectAssetStore.prototype, "assetOwner");
    const listAssets = vi.spyOn(ObjectAssetStore.prototype, "listAssets");
    await render(withRef("products[].logoPath", `assets/inputs/${RUN}/logo.png`));
    expect(assetOwner).not.toHaveBeenCalled();
    expect(listAssets).not.toHaveBeenCalled();
  });
});

describe("resolveBriefAssetRefs — render mode on fs (no teams: D210 d)", () => {
  let dir: string;
  const origRoot = process.env.PROJECT_ROOT;

  beforeEach(() => {
    resetProjectRoot();
    dir = mkdtempSync(join(tmpdir(), "cf-brief-refs-fs-"));
    process.env.PROJECT_ROOT = dir;
    // fs has no teams at all (`BriefStorePort.supportsTeams` is false), so the team
    // check cannot answer "hidden" and there is nothing to refuse.
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

  test("every ref form passes through with NO store call at all", async () => {
    const visibility = vi.spyOn(FsBriefStore.prototype, "campaignVisibility");
    const assetStore = vi.spyOn(FsAssetStore.prototype, "listAssets");
    for (const ref of [
      "00000000-0000-4000-8000-000000000000",
      `assets/inputs/${THEIRS}/logo.png`,
      DEMO_REF,
      MALFORMED_ID,
    ]) {
      const brief = withRef("products[].logoPath", ref);
      const resolved = await resolveBriefAssetRefs(CALLER, brief, {
        target: brief.id,
        mode: "render",
      });
      expect(resolved.brief).toBe(brief);
      expect(resolved.copyFrom).toEqual([]);
      expect(resolved.foreignIds).toEqual(new Set());
    }
    expect(visibility).not.toHaveBeenCalled();
    expect(assetStore).not.toHaveBeenCalled();
  });
});
