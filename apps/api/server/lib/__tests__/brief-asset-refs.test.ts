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
import { CampaignNotFoundError } from "../ownership.js";
import type { TenantContext } from "../tenant.js";
import {
  assertRefsCopied,
  BriefRefNotFoundError,
  copyBriefRefs,
  resolveBriefAssetRefs,
} from "../brief-asset-refs.js";

/**
 * `resolveBriefAssetRefs` in `render` mode (PT-4k2a) and `save` mode (PT-4k2b; D208 B/D,
 * D210 a/c/d).
 *
 * The one rule under test, in both modes: **under s3, a ref that NAMES a campaign the
 * caller cannot see is the same 404 as a brief whose own campaign is hidden, and under
 * pg + fs only the team half of that is checked** (D210 d) while fs is untouched (D210 d,
 * item 4). `save` adds what a WRITE needs on top of that check — every ref as the id of
 * a row the caller can see, the copy-source list, and the post-copy check — while off s3
 * it stays the path-derived answer the four write routes have always given.
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

/**
 * A DIFFERENT byte string, uploaded under a second name in the friend campaign.
 *
 * `copyAssets` decides a collision on `sha256` and REUSES a name the target already
 * holds by these exact bytes, so a copy of the same PNG under the same name is a no-op
 * with no new row and no new id. Testing the copy against that would assert a target-owned
 * id without a copy ever having happened.
 */
const PNG_ALT = Buffer.concat([PNG, Buffer.from([0x00])]);

/** The brief's OWN campaign — the `target`, and the owner its own refs have. */
const RUN = "run-me";
/** A second visible campaign in the same org: foreign, and legal. */
const FRIEND = "friend";
/** Same org, but on team `t2` — invisible to the caller. */
const THEIRS = "theirs";
/** Another org's campaign, with a real asset in that org and none in this one. */
const OTHER_ORG_CAMP = "theirs-other";
const OTHER_ORG = "other";

/** The friend campaign's SECOND, differently-bitted asset — the one a copy really moves. */
const FRIEND_ALT = "friend-alt";

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
    // A second, DIFFERENT asset in the friend campaign: this is the one the copy tests
    // move, so the copy is a real new row (see `PNG_ALT`).
    ids[FRIEND_ALT] = (await localAssets.writeAsset(FRIEND, "alt.png", PNG_ALT)).id!;
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

  test("a repeated ref, and refs sharing a campaign, cost ONE visibility check and ONE listing per campaign", async () => {
    const visibility = vi.spyOn(PgBriefStore.prototype, "campaignVisibility");
    const listAssets = vi.spyOn(ObjectAssetStore.prototype, "listAssets");
    const brief = {
      ...storedBrief(RUN),
      products: [
        // Three products share the friend campaign's logo by path; the last also names
        // its asset by id, so one campaign is reached three ways.
        { id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: pathRef(FRIEND) },
        // A DIFFERENT string naming the same file: it survives the dedupe, and the
        // listing memo is what answers it.
        {
          id: "p2",
          name: "P2",
          primaryColor: "#1473E6",
          logoPath: `assets/inputs/${FRIEND}/./logo.png`,
        },
        {
          id: "p3",
          name: "P3",
          primaryColor: "#1473E6",
          logoPath: pathRef(FRIEND),
          inputAsset: ids[FRIEND]!,
        },
      ],
    };
    await render(brief);
    expect(visibility.mock.calls.filter(([slug]) => slug === FRIEND)).toHaveLength(1);
    expect(listAssets.mock.calls.filter(([slug]) => slug === FRIEND)).toHaveLength(1);
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

  /**
   * `save` mode under s3 (PT-4k2b, D208 D, D210 a/b): the write side, where a check
   * becomes a rewrite and a copy-source list.
   *
   * **The fixture's neutral ref is the TARGET'S OWN asset, not `DEMO_REF`** — this is
   * the trap the render fixture above walks straight into. Under `save` a ref naming no
   * campaign is refused BY DESIGN (D208 D: "a root-level demo ref cannot be saved under
   * s3"), so a brief carrying the editor's `assets/inputs/hydra-logo.png` in any field
   * the test is not about would 404 on that field instead of the one under test, and
   * every case below would pass for the wrong reason.
   */
  describe("save mode (PT-4k2b, D208 D, D210 a/b)", () => {
    /** The target's own path ref. Under `save` this becomes `ids[RUN]`. */
    const ownPath = pathRef(RUN);

    const save = (brief: CampaignBrief) =>
      resolveBriefAssetRefs(CALLER, brief, { target: brief.id, mode: "save" });

    /** Whatever is in the one field under test after the resolve. */
    const readRef = (brief: CampaignBrief, field: Field): string => {
      switch (field) {
        case "products[].logoPath":
          return brief.products[0]!.logoPath;
        case "products[].inputAsset":
          return brief.products[0]!.inputAsset!;
        case "audio.path":
          return brief.audio!.path;
        case "copy.timeline.beats[].background":
          return brief.copy!.timeline!.beats[0]!.background!;
      }
    };

    /** `ref` in the one field under test, and the target's OWN ref everywhere else. */
    const withSaveRef = (field: Field, ref: string): CampaignBrief => {
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
              { id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: ownPath, inputAsset: ref },
            ],
          };
        case "audio.path":
          return {
            ...base,
            // The neutral ref is the TARGET'S OWN, never `DEMO_REF`: under `save` a
            // campaign-less ref is refused by design, so a leftover one would make every
            // audio case below 404 on the logo instead of on the field under test.
            products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: ownPath }],
            audio: { path: ref, rights: { licenceId: "lic-1", source: "library" } },
          };
        case "copy.timeline.beats[].background":
          return {
            ...base,
            products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: ownPath }],
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

    describe.each(FIELDS)("the %s field", (field) => {
      test("a visible FOREIGN id is kept as it is, recorded foreign, and names a copy source", async () => {
        const resolved = await save(withSaveRef(field, ids[FRIEND]!));
        expect(readRef(resolved.brief, field)).toBe(ids[FRIEND]!);
        expect(resolved.foreignIds).toEqual(new Set([ids[FRIEND]!]));
        expect(resolved.copyFrom).toEqual([FRIEND]);
      });

      test("a visible FOREIGN path is rewritten to the row's id and recorded foreign", async () => {
        const resolved = await save(withSaveRef(field, pathRef(FRIEND)));
        // No path is ever STORED under s3 (D208 D), so the brief handed back for writing
        // already carries the id — the same row `listAssets` found by name.
        expect(readRef(resolved.brief, field)).toBe(ids[FRIEND]!);
        expect(resolved.foreignIds).toEqual(new Set([ids[FRIEND]!]));
        expect(resolved.copyFrom).toEqual([FRIEND]);
      });

      test("the target's OWN path becomes its id, counts as own, and copies nothing", async () => {
        const resolved = await save(withSaveRef(field, ownPath));
        expect(readRef(resolved.brief, field)).toBe(ids[RUN]!);
        expect(resolved.ownIds).toEqual(new Set([ids[RUN]!]));
        expect(resolved.foreignIds).toEqual(new Set());
        expect(resolved.copyFrom).toEqual([]);
      });

      test("a team-HIDDEN id is refused, naming the caller's own brief", async () => {
        const error = await save(withSaveRef(field, ids[THEIRS]!)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BriefRefNotFoundError);
        expect((error as CampaignNotFoundError).campaignId).toBe(RUN);
        expect((error as Error).message).not.toContain(THEIRS);
      });

      test("a path naming a team-HIDDEN campaign is refused the same way", async () => {
        const error = await save(withSaveRef(field, pathRef(THEIRS))).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BriefRefNotFoundError);
        expect((error as CampaignNotFoundError).campaignId).toBe(RUN);
        expect((error as Error).message).not.toContain(THEIRS);
      });

      test("another org's id is refused — org-scoped, so absent and never forbidden", async () => {
        await expect(save(withSaveRef(field, ids[OTHER_ORG_CAMP]!))).rejects.toBeInstanceOf(
          BriefRefNotFoundError,
        );
      });

      test("an id whose ROW is gone is refused, naming the caller's own brief", async () => {
        await db.query(`delete from asset where id = $1`, [ids[FRIEND]!]);
        await expect(save(withSaveRef(field, ids[FRIEND]!))).rejects.toBeInstanceOf(
          BriefRefNotFoundError,
        );
      });

      test("a path whose ROW is gone is refused the same way", async () => {
        // A missing upload is not a reason to save a brief whose logo is not there
        // (D210 c): it answers the same 404 a hidden campaign does.
        await db.query(`delete from asset where id = $1`, [ids[FRIEND]!]);
        await expect(save(withSaveRef(field, pathRef(FRIEND)))).rejects.toBeInstanceOf(
          BriefRefNotFoundError,
        );
      });

      test("a MALFORMED id is refused on save, though render lets it through", async () => {
        // Shape alone names no campaign, and under s3 there is no row to store behind it:
        // D208 D's "a ref that names no campaign is refused on save".
        await expect(save(withSaveRef(field, MALFORMED_ID))).rejects.toBeInstanceOf(
          BriefRefNotFoundError,
        );
      });

      test("a root-level demo ref cannot be saved under s3", async () => {
        // This is the editor's own default brief, and the reason D210(e) sequences the
        // web writing ids (PT-4l) BEFORE staging moves to s3.
        const error = await save(withSaveRef(field, DEMO_REF)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BriefRefNotFoundError);
        expect((error as Error).message).not.toContain("hydra-logo");
      });
    });

    test("absent audio and absent beat background gain NO key, while the logo does become its id", async () => {
      // `rewriteAssetPaths`' discipline (VE-D3 / VE5b2) survives the rewrite: a key that
      // was not there must not appear, or a byte-identity comparison sees a difference
      // nothing rendered.
      const brief: CampaignBrief = {
        ...withSaveRef("products[].logoPath", ownPath),
        copy: { timeline: { beats: [{ text: "Go", weight: 1 }], transition: "cut", keyBeat: 1 } },
      };
      const resolved = await save(brief);
      expect("audio" in resolved.brief).toBe(false);
      expect("background" in (resolved.brief.copy!.timeline!.beats[0] as object)).toBe(false);
      expect(readRef(resolved.brief, "products[].logoPath")).toBe(ids[RUN]!);
    });

    test("copyBriefRefs brings a foreign id over, and the copy's ref is TARGET-owned", async () => {
      const resolved = await save(withSaveRef("products[].logoPath", ids[FRIEND_ALT]!));
      expect(resolved.copyFrom).toEqual([FRIEND]);
      const { brief: copied } = await copyBriefRefs(CALLER, resolved.brief, resolved.copyFrom, RUN);
      const copiedRef = readRef(copied, "products[].logoPath");
      expect(copiedRef).not.toBe(ids[FRIEND_ALT]!);
      // The copy's `<source id> → <target id>` map entry (`object-asset-store.ts`'s
      // `record`) is the only thing that can remap an id: the asset belongs to the
      // campaign being written, so its `deleteAssets` is this caller's to lean on.
      const owner = await new ObjectAssetStore(db, store, "local").assetOwner(copiedRef);
      expect(owner?.slug).toBe(RUN);
      // ...and with every foreign id remapped, the post-copy check has nothing to refuse.
      expect(() => assertRefsCopied(copied, resolved.foreignIds, RUN)).not.toThrow();
    });

    test("assertRefsCopied refuses a copy that mapped nothing", async () => {
      const resolved = await save(withSaveRef("products[].logoPath", ids[FRIEND_ALT]!));
      // The race the check exists for: `copyAssets` copies the rows that exist WHEN it
      // runs, so a row deleted between the resolve and the copy is simply missing from
      // the map — the id survives the rewrite untouched and no other check can see it.
      vi.spyOn(ObjectAssetStore.prototype, "copyAssets").mockResolvedValue({
        paths: {},
        created: new Set<string>(),
      });
      const { brief: copied } = await copyBriefRefs(CALLER, resolved.brief, resolved.copyFrom, RUN);
      expect(readRef(copied, "products[].logoPath")).toBe(ids[FRIEND_ALT]!);
      expect(() => assertRefsCopied(copied, resolved.foreignIds, RUN)).toThrow(
        BriefRefNotFoundError,
      );
    });

    test("assertRefsCopied is a no-op when the resolve found nothing foreign", async () => {
      // Off s3 `stale` is always empty, which is what keeps D208(D)'s "fs and pg+fs are
      // unchanged" true for a route that calls it unconditionally.
      const resolved = await save(withSaveRef("products[].logoPath", ownPath));
      expect(() => assertRefsCopied(resolved.brief, resolved.foreignIds, RUN)).not.toThrow();
    });
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
    // A second VISIBLE campaign: `save` off s3 has to name it as a copy source, which is
    // what `assertSourceVisible` lets through when it answers "visible".
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

  describe("save mode — the route code, behaviour for behaviour (PT-4k2b, D208 D)", () => {
    const save = (brief: CampaignBrief, target = RUN) =>
      resolveBriefAssetRefs(CALLER, brief, { target, mode: "save" });

    test("copyFrom is what extractSourceAssetBriefIds reads, and the brief is the INPUT object", async () => {
      // Off s3 there are no asset rows to own an id, so the write side is exactly the
      // path-derived answer the four write routes have always given — no rewrite, no ids.
      const brief = withRef("products[].logoPath", `assets/inputs/${FRIEND}/logo.png`);
      const resolved = await save(brief);
      expect(resolved.copyFrom).toEqual([FRIEND]);
      expect(resolved.copyFrom).toEqual(extractSourceAssetBriefIds(brief, RUN));
      expect(resolved.brief).toBe(brief);
      expect(resolved.foreignIds).toEqual(new Set());
      expect(resolved.ownIds).toEqual(new Set());
    });

    test("a team-HIDDEN slug rejects with the PLAIN CampaignNotFoundError, not the s3 refusal", async () => {
      const error = await save(
        withRef("products[].logoPath", `assets/inputs/${THEIRS}/logo.png`),
      ).catch((e: unknown) => e);
      // NOT `BriefRefNotFoundError`: that class is the s3 refusal, and this branch has to
      // keep the exact error `duplicate.post`/`index.post` still catch themselves —
      // `Brief "<error.campaignId>" not found.`, naming the slug the caller named.
      expect(error).toBeInstanceOf(CampaignNotFoundError);
      expect(error).not.toBeInstanceOf(BriefRefNotFoundError);
      expect((error as CampaignNotFoundError).campaignId).toBe(THEIRS);
    });

    test("an ABSENT slug passes, exactly as assertSourceVisible has always let it", async () => {
      // On fs a directory name need never have been a saved campaign at all (a demo
      // asset dropped into it), and `campaignVisibility` answers "absent" for that case
      // just as it does for a typo. Inventing a 404 here would be a new answer on the
      // backend D208(D) leaves unchanged.
      const brief = withRef("products[].logoPath", `assets/inputs/${RUN}-demo/logo.png`);
      const resolved = await save(brief);
      expect(resolved.copyFrom).toEqual([`${RUN}-demo`]);
      expect(resolved.brief).toBe(brief);
    });

    test("an id ref is left alone off s3 — there is no row behind it to own", async () => {
      const assetOwner = vi.spyOn(ObjectAssetStore.prototype, "assetOwner");
      const brief = withRef("products[].logoPath", "00000000-0000-4000-8000-000000000000");
      const resolved = await save(brief);
      expect(resolved.brief).toBe(brief);
      expect(resolved.copyFrom).toEqual([]);
      expect(assetOwner).not.toHaveBeenCalled();
    });
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

  test("save mode passes through the same way, and still makes NO store call", async () => {
    // fs has no teams at all, so `assertSourceVisible` cannot answer "hidden" and skips
    // its call — the write side here is the same pass-through `render` is.
    const visibility = vi.spyOn(FsBriefStore.prototype, "campaignVisibility");
    const brief = withRef("products[].logoPath", `assets/inputs/${FRIEND}/logo.png`);
    const resolved = await resolveBriefAssetRefs(CALLER, brief, { target: RUN, mode: "save" });
    expect(resolved.copyFrom).toEqual([FRIEND]);
    expect(resolved.copyFrom).toEqual(extractSourceAssetBriefIds(brief, RUN));
    expect(resolved.brief).toBe(brief);
    expect(resolved.foreignIds).toEqual(new Set());
    expect(resolved.ownIds).toEqual(new Set());
    expect(visibility).not.toHaveBeenCalled();
  });
});
