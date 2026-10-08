import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  PreviewCreativeFrameUseCase,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { setCapabilities } from "../../../lib/capabilities.js";
import { resetJobs } from "../../../lib/jobs.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../../../lib/object-store/index.js";
import {
  getAssetStore,
  getBriefStore,
  resetAssetStore,
  resetUsageStore,
  setUsageStore,
} from "../../../lib/ports/index.js";
import { PgBriefStore } from "../../../lib/ports/pg-brief-store.js";
import type { RunDeliveryPort } from "../../../lib/ports/run-delivery.port.js";
import { resetRunDelivery, setRunDelivery } from "../../../lib/ports/run-delivery-registry.js";
import type { UsageStorePort } from "../../../lib/ports/usage-store.port.js";
import type { RunRequest } from "../../../lib/run-request.js";
import type { TenantContext } from "../../../lib/tenant.js";
import assetsPostHandler from "../assets.post.js";
import generateHandler from "../generate.post.js";
import previewHandler, { resetPreviewAdapters } from "../preview-frame.post.js";
import {
  mountTenantRoute,
  setupFsHarness,
  setupPgHarness,
  type PgHarness,
} from "../../__tests__/tenant-harness.js";
import type { SqlClient } from "../../../lib/db/sql-client.js";

/**
 * PT-4k2a (D208 B, D210 a/d): the two RENDER routes refuse a body brief whose refs
 * name an asset the caller may not use.
 *
 * - `generate.post` checks right after its `campaignMeta` gate and before the reroll
 *   revision read, the quota read and `enqueueJob`, so a refusal leaves no job, no
 *   usage read and no delivery.
 * - `preview-frame.post` checks before `useCase.execute`, which is the frame-cache
 *   lookup. The bundle and its cache are keyed per ORG, not per team, so a check after
 *   the lookup hands one team the other team's cached PNG with that team's logo
 *   composited into it.
 *
 * **One 404, and the comparison that pins it.** Every refusal below is compared
 * against what the SAME route answers when the brief's OWN campaign is hidden — the
 * same request, sent by a caller who cannot see that campaign, so the two bodies carry
 * the same id and must be byte-identical (D210 c). `OWN` is on team `t1`, which is what
 * makes that comparison possible: `ONLY_T1` can see it and `ONLY_T2` cannot, while
 * `BOTH` sees `OWN` and `THEIRS` alike, which is the pair the cache-leak case needs.
 *
 * Backends are switched per describe, because D210(d) is the point of the pg+fs block:
 * the team check runs on every backend that has teams, while the id and row checks are
 * s3-only and fs is untouched.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** The brief's OWN campaign: team `t1`, so `ONLY_T1` and `BOTH` see it and `ONLY_T2` cannot. */
const OWN = "friend";
/** A second of the brief's own campaigns, team `t1`: so a loop can admit two runs. */
const OWN_B = "friend-b";
/** Same org, team `t2`: invisible to `ONLY_T1`, and where every hidden ref below points. */
const THEIRS = "theirs";
/** Another org, with a real asset there and none in ours. */
const OTHER_ORG_CAMP = "theirs-other";
const OTHER_ORG = "other";

const OWNER: TenantContext = { orgId: "local", userId: "owner", roles: ["owner"], teamIds: [] };
/** Team A: sees `OWN` and `THEIRS`, so it may preview the brief below. */
const BOTH: TenantContext = { orgId: "local", userId: "ua", roles: [], teamIds: ["t1", "t2"] };
/** Team B: sees its own campaign, cannot see `THEIRS` — every refusal below is this caller. */
const ONLY_T1: TenantContext = { orgId: "local", userId: "u1", roles: [], teamIds: ["t1"] };
/** The comparison caller: cannot see `OWN`, so the route's OWN gate answers for it. */
const ONLY_T2: TenantContext = { orgId: "local", userId: "u2", roles: [], teamIds: ["t2"] };

/** The root-level demo ref the editor's own default brief carries (`run-context.tsx:553`). */
const DEMO_REF = "assets/inputs/hydra-logo.png";

const baseBrief = (): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: OWN,
  mode: "brief",
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  // A ref that names no campaign, so it is never what a test below is refusing.
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: DEMO_REF }],
  treatments: [{ id: "bold", layout: "headline-bottom", tone: "bold" }],
});

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

const withRef = (field: Field, ref: string, id: string = OWN): CampaignBrief => {
  const base = { ...baseBrief(), id };
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
        // A `copy.timeline` only parses on a motion brief (`load-brief.ts`), so the
        // beats field's cases carry the motion envelope the parser demands.
        mode: "variation",
        output: { formats: ["motion"] },
        variation: { count: 1 },
        copy: {
          timeline: {
            beats: [{ text: "Go", weight: 2, background: ref }],
            transition: "cut",
            keyBeat: 1,
          },
        },
      };
  }
};

const generate = (tenant: TenantContext, brief: CampaignBrief) =>
  mountTenantRoute(generateHandler, { method: "POST", path: "/campaigns/generate", tenant })(
    new Request("http://x/campaigns/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief }),
    }),
  );

const preview = (tenant: TenantContext, brief: CampaignBrief) =>
  mountTenantRoute(previewHandler, {
    method: "POST",
    path: "/campaigns/preview-frame",
    tenant,
  })(
    new Request("http://x/campaigns/preview-frame", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brief,
        cell: {
          productId: "p1",
          canvas: { ratio: "1:1" },
          layout: "headline-bottom",
          tone: "bold",
        },
      }),
    }),
  );

/** Upload through the real route, so every id under test is one `writeAsset` minted. */
const upload = async (
  tenant: TenantContext,
  briefId: string,
  name = "logo.png",
): Promise<{ path: string; id?: string }> => {
  const res = await mountTenantRoute(assetsPostHandler, {
    method: "POST",
    path: "/campaigns/assets",
    tenant,
  })(
    new Request("http://x/campaigns/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ briefId, name, contentBase64: PNG.toString("base64") }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { path: string; id?: string };
};

/** A usage store that records every call, so "the quota read never happened" is assertable. */
function usageSpy(): UsageStorePort & { readonly quotaCalls: () => number } {
  let calls = 0;
  return {
    quotaCalls: () => calls,
    quota: async () => {
      calls += 1;
      return null;
    },
    countThisMonth: async () => 0,
    record: async () => {},
    reserve: async () => "res-1",
    settle: async () => {},
    release: async () => {},
  };
}

/** A delivery that records what it was handed and starts nothing. */
function deliverySpy(): RunDeliveryPort & { readonly delivered: RunRequest[] } {
  const delivered: RunRequest[] = [];
  return {
    delivered,
    deliver: async (request) => {
      delivered.push(request);
    },
  };
}

const pngHeader = async (res: Response): Promise<string> =>
  Buffer.from(await res.arrayBuffer())
    .subarray(0, 8)
    .toString("hex");

const PNG_MAGIC = "89504e470d0a1a0a";

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

/**
 * Teams and campaigns shared by both Postgres blocks below, minted once.
 *
 * `createCampaign` rather than `createBrief`: the render routes gate on
 * `campaignMeta` (PT-5c2), which is defined only for a minted campaign.
 */
async function seed(harness: PgHarness): Promise<void> {
  await harness.db.query(
    `insert into team (id, name, "memberCount", org_id, created_at) values
       ($1, $2, 0, $3, now()), ($4, $5, 0, $3, now())`,
    ["t1", "Team One", "local", "t2", "Team Two"],
  );
  await harness.db.query(`insert into org (id, name) values ($1, $1)`, [OTHER_ORG]);
  const ownerStore = new PgBriefStore(harness.db, "local", "owner", ["owner"], []);
  await ownerStore.createCampaign(OWN, { teamId: "t1" });
  await ownerStore.createCampaign(OWN_B, { teamId: "t1" });
  await ownerStore.createCampaign(THEIRS, { teamId: "t2" });
  await new PgBriefStore(harness.db, OTHER_ORG, "o", [], []).createCampaign(OTHER_ORG_CAMP);
}

/**
 * Put back every uploaded row a previous test deleted, by its OWN id — a re-minted id
 * would change what `ids[...]` names and quietly stop testing the same ref.
 */
async function restoreRows(db: SqlClient, rows: readonly AssetRow[]): Promise<void> {
  for (const row of rows) {
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
}

/** Read the uploaded rows back, so they can be restored between tests. */
async function readRows(db: SqlClient): Promise<AssetRow[]> {
  const { rows } = await db.query<AssetRow>(
    `select id, org_id, campaign_id, kind, name, size, sha256, content_type from asset`,
  );
  return rows;
}

describe("generate and preview-frame refuse refs the caller cannot use — under s3 (PT-4k2a, D210 c)", () => {
  let harness: PgHarness;
  let usage: ReturnType<typeof usageSpy>;
  let delivery: ReturnType<typeof deliverySpy>;
  let assets: AssetRow[] = [];
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  /** Real ids, from `POST /campaigns/assets`. */
  const ids: Record<string, string> = {};

  const pathRef = (slug: string): string => `assets/inputs/${slug}/logo.png`;

  beforeAll(async () => {
    setCapabilities({ motion: true });
    process.env.OBJECT_STORE = "s3";
    harness = await setupPgHarness();
    setObjectStoreClient(new InMemoryObjectStore());
    resetAssetStore();
    await seed(harness);
    for (const slug of [OWN, THEIRS]) {
      ids[slug] = (await upload(OWNER, slug)).id!;
    }
    ids[OTHER_ORG_CAMP] = (await upload({ ...OWNER, orgId: OTHER_ORG }, OTHER_ORG_CAMP)).id!;
    assets = await readRows(harness.db);
  });

  beforeEach(async () => {
    // One database per suite, not per test: a clone is a create-and-drop round trip
    // against a server other lanes share. Each test still starts from the same fixture
    // — the uploaded rows are restored, and `resetJobs` releases any run a previous
    // test admitted (which would otherwise answer the next one 409).
    await restoreRows(harness.db, assets);
    await resetJobs();
    usage = usageSpy();
    setUsageStore(usage);
    delivery = deliverySpy();
    setRunDelivery(delivery);
    resetPreviewAdapters();
  });

  afterEach(() => {
    resetPreviewAdapters();
    resetRunDelivery();
    resetUsageStore();
    resetAssetStore();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    resetObjectStoreClient();
    resetAssetStore();
    await resetJobs();
    setCapabilities({ motion: false, reason: "not probed" });
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    await harness.cleanup();
  });

  /**
   * The body this route already gives for a brief whose OWN campaign is hidden, for the
   * very same brief id: `ONLY_T2` cannot see `OWN` (team `t1`), so its own gate answers.
   */
  const ownCampaignHidden = async (
    brief: CampaignBrief,
  ): Promise<{ gen: unknown; pre: unknown }> => {
    const gen = await generate(ONLY_T2, brief);
    const pre = await preview(ONLY_T2, brief);
    expect(gen.status).toBe(404);
    expect(pre.status).toBe(404);
    return { gen: await gen.json(), pre: await pre.json() };
  };

  /** No job, no usage read, no delivery: the shape every refusal must have. */
  const expectNoSideEffects = async (enqueue: { mock: { calls: unknown[] } }): Promise<void> => {
    expect(enqueue.mock.calls).toEqual([]);
    expect(usage.quotaCalls()).toBe(0);
    expect(delivery.delivered).toEqual([]);
    const { rows } = await harness.db.query<{ n: number }>(`select count(*)::int as n from job`);
    expect(Number(rows[0]!.n)).toBe(0);
  };

  describe.each(FIELDS)("generate — the %s field", (field) => {
    test("a team-HIDDEN ref 404s with the hidden-campaign body and ZERO side effects", async () => {
      const jobs = await import("../../../lib/jobs.js");
      const enqueue = vi.spyOn(jobs, "enqueueJob");
      const before = await ownCampaignHidden(baseBrief());
      enqueue.mockClear();

      const res = await generate(ONLY_T1, withRef(field, ids[THEIRS]!));
      expect(res.status).toBe(404);
      // Byte-identical to this route's own hidden-campaign 404, same id and all.
      expect(await res.json()).toEqual(before.gen);
      await expectNoSideEffects(enqueue);
    });

    test("a path ref naming a team-HIDDEN campaign answers the IDENTICAL body", async () => {
      const jobs = await import("../../../lib/jobs.js");
      const enqueue = vi.spyOn(jobs, "enqueueJob");
      const before = await ownCampaignHidden(baseBrief());
      enqueue.mockClear();

      const res = await generate(ONLY_T1, withRef(field, pathRef(THEIRS)));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(before.gen);
      await expectNoSideEffects(enqueue);
    });

    test("another org's id answers the IDENTICAL body", async () => {
      const jobs = await import("../../../lib/jobs.js");
      const enqueue = vi.spyOn(jobs, "enqueueJob");
      const before = await ownCampaignHidden(baseBrief());
      enqueue.mockClear();

      const res = await generate(ONLY_T1, withRef(field, ids[OTHER_ORG_CAMP]!));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(before.gen);
      await expectNoSideEffects(enqueue);
    });

    test("an id whose row is gone answers the IDENTICAL body", async () => {
      const jobs = await import("../../../lib/jobs.js");
      const enqueue = vi.spyOn(jobs, "enqueueJob");
      const before = await ownCampaignHidden(baseBrief());
      await harness.db.query(`delete from asset where id = $1`, [ids[OWN]!]);
      enqueue.mockClear();

      const res = await generate(ONLY_T1, withRef(field, ids[OWN]!));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(before.gen);
      await expectNoSideEffects(enqueue);
    });

    test("a ref the caller CAN see is admitted, and the delivered brief is the body's byte for byte", async () => {
      const brief = withRef(field, pathRef(THEIRS));
      const res = await generate(BOTH, brief);
      expect(res.status).toBe(202);
      expect(delivery.delivered).toHaveLength(1);
      // `render` is a CHECK: the RunRequest carries the body's own brief, so the report
      // contract and every ref the pipeline reads stay exactly where they were.
      expect(delivery.delivered[0]!.brief).toEqual(JSON.parse(JSON.stringify(brief)));
      expect(usage.quotaCalls()).toBe(1);
    });
  });

  describe.each(FIELDS)("preview — the %s field", (field) => {
    test("a team-HIDDEN ref 404s with the hidden-campaign body BEFORE the cache lookup", async () => {
      const execute = vi.spyOn(PreviewCreativeFrameUseCase.prototype, "execute");
      const before = await ownCampaignHidden(baseBrief());
      execute.mockClear();

      const res = await preview(ONLY_T1, withRef(field, ids[THEIRS]!));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(before.pre);
      // The cache lookup IS `execute`, so this is the leak's own seam.
      expect(execute).not.toHaveBeenCalled();
    });

    test("a path ref naming a team-HIDDEN campaign answers the IDENTICAL body", async () => {
      const execute = vi.spyOn(PreviewCreativeFrameUseCase.prototype, "execute");
      const before = await ownCampaignHidden(baseBrief());
      execute.mockClear();

      const res = await preview(ONLY_T1, withRef(field, pathRef(THEIRS)));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(before.pre);
      expect(execute).not.toHaveBeenCalled();
    });

    test("another org's id answers the IDENTICAL body", async () => {
      const execute = vi.spyOn(PreviewCreativeFrameUseCase.prototype, "execute");
      const before = await ownCampaignHidden(baseBrief());
      execute.mockClear();

      const res = await preview(ONLY_T1, withRef(field, ids[OTHER_ORG_CAMP]!));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(before.pre);
      expect(execute).not.toHaveBeenCalled();
    });

    test("a ref the caller CAN see renders, and the cache key is the UNCHANGED brief's", async () => {
      const first = await preview(BOTH, withRef(field, pathRef(THEIRS)));
      expect(first.status).toBe(200);
      expect(await pngHeader(first)).toBe(PNG_MAGIC);
      const key = first.headers.get("x-preview-frame-cache-key");
      expect(key).toBeTruthy();
      // The same brief again comes back from the cache under the SAME key: a rewritten
      // ref would hash to something else and silently re-render forever.
      const second = await preview(BOTH, withRef(field, pathRef(THEIRS)));
      expect(second.headers.get("x-preview-frame-cache-key")).toBe(key);
    });

    test("CACHE LEAK: team B posting team A's IDENTICAL body gets 404, not A's cached frame", async () => {
      const brief = withRef("products[].logoPath", pathRef(THEIRS));
      const mine = await preview(BOTH, brief);
      expect(mine.status).toBe(200);
      expect(await pngHeader(mine)).toBe(PNG_MAGIC);
      const theirKey = mine.headers.get("x-preview-frame-cache-key");

      // The bundle is keyed per ORG, so this caller shares the bundle — and the cache —
      // the frame above was just written to. Without the check before `execute` this is
      // a 200 carrying team A's PNG, team A's logo composited into it.
      const execute = vi.spyOn(PreviewCreativeFrameUseCase.prototype, "execute");
      execute.mockClear();
      const theirs = await preview(ONLY_T1, brief);
      expect(theirs.status).toBe(404);
      expect(theirs.headers.get("x-preview-frame-cache-key")).toBeNull();
      // **The refusal never reached the cache.** A check placed after the lookup still
      // answers 404 — the status is the one thing a late check gets right — but by then
      // A's frame has already been read out of the bundle B is sharing, which is the
      // leak itself: the bytes cross the team boundary whether or not the response
      // carries them. So the assertion is about the lookup, not the answer.
      expect(execute).not.toHaveBeenCalled();
      // ...and A's frame is still A's, because nothing was evicted or rewritten.
      const again = await preview(BOTH, brief);
      expect(again.status).toBe(200);
      expect(again.headers.get("x-preview-frame-cache-key")).toBe(theirKey);
      expect(await pngHeader(again)).toBe(PNG_MAGIC);
    });
  });

  test("a store failure is NOT folded into the 404 — it stays a 500", async () => {
    const readError = new Error("bucket unreachable");
    const store = await import("../../../lib/ports/index.js");
    const owner = vi.spyOn(store, "getAssetStore").mockImplementation(() => {
      throw readError;
    });
    const execute = vi.spyOn(PreviewCreativeFrameUseCase.prototype, "execute");
    try {
      const gen = await generate(ONLY_T1, withRef("products[].logoPath", ids[OWN]!));
      expect(gen.status).toBe(500);
      const pre = await preview(ONLY_T1, withRef("products[].logoPath", ids[OWN]!));
      expect(pre.status).toBe(500);
      // Nothing rendered either: a failed check must not fall through to the compositor.
      expect(execute).not.toHaveBeenCalled();
    } finally {
      owner.mockRestore();
    }
    expect(delivery.delivered).toEqual([]);
    expect(usage.quotaCalls()).toBe(0);
  });
});

describe("the same two routes on pg + fs (staging) — the team check only (PT-4k2a, D210 d r2)", () => {
  let harness: PgHarness;
  let usage: ReturnType<typeof usageSpy>;
  let delivery: ReturnType<typeof deliverySpy>;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  beforeAll(async () => {
    setCapabilities({ motion: true });
    // Staging today: `STORE_BACKEND=postgres` with `OBJECT_STORE` unset. There are no
    // asset rows under fs to own an id, so only the slug in a path ref is checkable.
    delete process.env.OBJECT_STORE;
    harness = await setupPgHarness();
    resetAssetStore();
    await seed(harness);
  });

  beforeEach(async () => {
    await resetJobs();
    usage = usageSpy();
    setUsageStore(usage);
    delivery = deliverySpy();
    setRunDelivery(delivery);
    resetPreviewAdapters();
  });

  afterEach(() => {
    resetPreviewAdapters();
    resetRunDelivery();
    resetUsageStore();
    resetAssetStore();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await resetJobs();
    setCapabilities({ motion: false, reason: "not probed" });
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    await harness.cleanup();
  });

  test.each(FIELDS)("a path ref to a team-HIDDEN campaign 404s on generate (%s)", async (field) => {
    const jobs = await import("../../../lib/jobs.js");
    const enqueue = vi.spyOn(jobs, "enqueueJob");
    const res = await generate(ONLY_T1, withRef(field, `assets/inputs/${THEIRS}/logo.png`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Campaign "${OWN}" not found.` });
    expect(enqueue).not.toHaveBeenCalled();
    expect(usage.quotaCalls()).toBe(0);
    expect(delivery.delivered).toEqual([]);
    const { rows } = await harness.db.query<{ n: number }>(`select count(*)::int as n from job`);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  test.each(FIELDS)("a path ref to a team-HIDDEN campaign 404s on preview (%s)", async (field) => {
    const execute = vi.spyOn(PreviewCreativeFrameUseCase.prototype, "execute");
    const res = await preview(ONLY_T1, withRef(field, `assets/inputs/${THEIRS}/logo.png`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Campaign "${OWN}" not found.` });
    expect(execute).not.toHaveBeenCalled();
  });

  test("CACHE LEAK on pg + fs too: team B gets 404 where team A got the frame", async () => {
    // This is the leak D210(d) closes on staging: no ids and no rows, yet the slug in a
    // path ref names a campaign, and the org-keyed cache would serve A's frame to B.
    const brief = withRef("products[].logoPath", `assets/inputs/${THEIRS}/logo.png`);
    expect((await preview(BOTH, brief)).status).toBe(200);
    const execute = vi.spyOn(PreviewCreativeFrameUseCase.prototype, "execute");
    execute.mockClear();
    expect((await preview(ONLY_T1, brief)).status).toBe(404);
    // The same seam as under s3: a late check still answers 404, and still answers it
    // after reading the frame it was supposed to stop.
    expect(execute).not.toHaveBeenCalled();
  });

  test("a path ref to a VISIBLE campaign is unchanged: 202 on generate, 200 on preview", async () => {
    const brief = withRef("products[].logoPath", `assets/inputs/${OWN}/logo.png`);
    expect((await generate(ONLY_T1, brief)).status).toBe(202);
    expect(delivery.delivered).toHaveLength(1);
    const frame = await preview(ONLY_T1, brief);
    expect(frame.status).toBe(200);
    expect(await pngHeader(frame)).toBe(PNG_MAGIC);
  });

  test("a uuid ref and a root-level demo ref are unchanged — no new 404 on staging", async () => {
    // fs has no ids to own and no rows to find, so this backend must keep answering
    // these the way it always has rather than growing a refusal it never gave.
    for (const [index, ref] of ["00000000-0000-4000-8000-000000000000", DEMO_REF].entries()) {
      const brief = withRef("products[].logoPath", ref, index === 0 ? OWN : OWN_B);
      expect((await generate(ONLY_T1, brief)).status).toBe(202);
      expect((await preview(ONLY_T1, brief)).status).toBe(200);
    }
  });
});

describe("the same two routes on fs (no teams) — untouched (PT-4k2a, D210 d)", () => {
  let delivery: ReturnType<typeof deliverySpy>;

  beforeEach(() => {
    setCapabilities({ motion: true });
    delivery = deliverySpy();
    setRunDelivery(delivery);
  });

  afterEach(async () => {
    resetPreviewAdapters();
    resetRunDelivery();
    resetUsageStore();
    resetAssetStore();
    vi.restoreAllMocks();
    await resetJobs();
    setCapabilities({ motion: false, reason: "not probed" });
  });

  test("a uuid ref and a path to ANY slug are answered exactly as before, with no store call", async () => {
    const harness = setupFsHarness();
    try {
      await getBriefStore(ONLY_T1).createCampaign(OWN);
      await getBriefStore(ONLY_T1).createCampaign(OWN_B);
      await getAssetStore(ONLY_T1).writeAsset(OWN, "logo.png", PNG);
      const store = await import("../../../lib/ports/index.js");
      const assetStore = vi.spyOn(store, "getAssetStore");
      const jobs = await import("../../../lib/jobs.js");
      const enqueue = vi.spyOn(jobs, "enqueueJob");
      const execute = vi.spyOn(PreviewCreativeFrameUseCase.prototype, "execute");

      for (const [index, ref] of [
        "00000000-0000-4000-8000-000000000000",
        "assets/inputs/whatever/x.png",
      ].entries()) {
        const brief = withRef("products[].logoPath", ref, index === 0 ? OWN : OWN_B);
        // No teams on fs, so there is nothing to refuse and no new 404 to hand out.
        expect((await generate(ONLY_T1, brief)).status).toBe(202);
        expect((await preview(ONLY_T1, brief)).status).toBe(200);
      }
      expect(assetStore).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalled();
      expect(execute).toHaveBeenCalled();
    } finally {
      harness.cleanup();
    }
    // Four fs route calls, two of which composite a real frame: over the 5 s default
    // on a cold canvas (`briefs.test.ts:198` raises it for the same reason).
  }, 30000);
});
