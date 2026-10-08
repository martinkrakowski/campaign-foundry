import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { setCapabilities } from "../../../lib/capabilities.js";
import { resetJobs } from "../../../lib/jobs.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../../../lib/object-store/index.js";
import { campaignPrefix } from "../../../lib/object-store/object-keys.js";
import {
  ACME_TENANT,
  mountTenantApp,
  resetAllStores,
  setupPgHarness,
  type PgHarness,
  type RouteRegistration,
  type WebCaller,
} from "../../__tests__/tenant-harness.js";
import type { TenantContext } from "../../../lib/tenant.js";
import createHandler from "../index.post.js";
import briefsPostHandler from "../briefs.post.js";
import assetsPostHandler from "../assets.post.js";
import generateHandler from "../generate.post.js";
import jobHandler from "../jobs/[id].get.js";
import packageHandler from "../package.post.js";
import decisionsPutHandler from "../decisions.put.js";
import draftPutHandler from "../[id]/draft.put.js";
import resultHandler from "../result.get.js";
import decisionsGetHandler from "../decisions.get.js";
import poolsGetHandler from "../pools/[briefId].get.js";
import { deleteCampaignObjects, deleteCampaignRows } from "../../../lib/deletion/purge-campaign.js";
/**
 * The one place this file imports a `bin/` module — deliberately crossing the
 * `server/` → `bin/` boundary to prove the CLI's own claim loop reaches the
 * shipped engines as an integration, not a unit test's stubs. A crossing that
 * `lint:arch` objects to must be reported, NOT worked around by editing
 * `lib/deletion/`.
 */
import { sweep } from "../../../../bin/purge.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The one brief shape `?model=procedural` accepts; `id` is the campaign ref. */
function sampleBrief(id: string): CampaignBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id,
    targetRegion: "US",
    targetAudience: "developers",
    campaignMessage: "Build faster",
    products: [
      {
        id: "alpha",
        name: "Alpha",
        primaryColor: "#1473E6",
        logoPath: `assets/inputs/${id}/logo.png`,
      },
    ],
  };
}

type JobBody = {
  status: "running" | "completed" | "failed";
  error?: string;
  result?: { assets: unknown[] };
};

const ROUTES: RouteRegistration[] = [
  { method: "post", path: "/campaigns", handler: createHandler },
  { method: "post", path: "/campaigns/briefs", handler: briefsPostHandler },
  { method: "post", path: "/campaigns/assets", handler: assetsPostHandler },
  { method: "post", path: "/campaigns/generate", handler: generateHandler },
  { method: "get", path: "/campaigns/jobs/:id", handler: jobHandler },
  { method: "post", path: "/campaigns/package", handler: packageHandler },
  { method: "put", path: "/campaigns/decisions", handler: decisionsPutHandler },
  { method: "put", path: "/campaigns/:id/draft", handler: draftPutHandler },
  { method: "get", path: "/campaigns/result", handler: resultHandler },
  { method: "get", path: "/campaigns/decisions", handler: decisionsGetHandler },
  { method: "get", path: "/campaigns/pools/:briefId", handler: poolsGetHandler },
];

interface Api {
  create: (body: unknown) => Promise<Response>;
  uploadAsset: (body: unknown) => Promise<Response>;
  saveBrief: (body: unknown) => Promise<Response>;
  generate: (body: unknown) => Promise<Response>;
  jobsGet: (id: string) => Promise<Response>;
  pkg: (body: unknown) => Promise<Response>;
  putDecisions: (body: unknown) => Promise<Response>;
  putDraft: (id: string, body: unknown) => Promise<Response>;
  result: (id: string) => Promise<Response>;
  decisions: (id: string) => Promise<Response>;
  pools: (id: string) => Promise<Response>;
  pollJob: (jobId: string) => Promise<JobBody>;
}

/** All 11 routes behind a single ACME_TENANT middleware, as the real server mounts them. */
function mountAll(tenant: TenantContext): Api {
  const call: WebCaller = mountTenantApp(ROUTES, tenant);
  const jsonReq = (path: string, method: "POST" | "PUT", body: unknown) =>
    call(
      new Request(`http://x${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const get = (path: string) => call(new Request(`http://x${path}`));
  return {
    create: (body) => jsonReq("/campaigns", "POST", body),
    uploadAsset: (body) => jsonReq("/campaigns/assets", "POST", body),
    saveBrief: (body) => jsonReq("/campaigns/briefs", "POST", body),
    generate: (body) => jsonReq("/campaigns/generate?model=procedural", "POST", body),
    jobsGet: (id) => get(`/campaigns/jobs/${id}`),
    pkg: (body) => jsonReq("/campaigns/package", "POST", body),
    putDecisions: (body) => jsonReq("/campaigns/decisions", "PUT", body),
    putDraft: (id, body) => jsonReq(`/campaigns/${id}/draft`, "PUT", body),
    result: (id) => get(`/campaigns/result?campaignId=${id}`),
    decisions: (id) => get(`/campaigns/decisions?campaignId=${id}`),
    pools: (id) => get(`/campaigns/pools/${id}`),
    pollJob: pollJob.bind(null, (id) => get(`/campaigns/jobs/${id}`)),
  };
}

async function pollJob(
  jobsGet: (id: string) => Promise<Response>,
  jobId: string,
): Promise<JobBody> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = await jobsGet(jobId);
    const body = (await res.json()) as JobBody;
    if (body.status === "completed" || body.status === "failed") return body;
    if (Date.now() > deadline) throw new Error(`timed out waiting for job ${jobId}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * The real producer chain: mint a campaign, upload one input asset, save its
 * brief, render it with the procedural generator, package it, decide and draft.
 *
 * The asset is uploaded BEFORE the brief is saved — under `s3` a brief ref is
 * resolved at save time (PT-4k2b), so a path that names no asset yet is refused
 * with the hidden-campaign 404. Under `fs` the order is harmless. `uuidAddressed`
 * names the brief (and so the run) by the campaign's own uuid (D246).
 */
async function produceCampaign(
  api: Api,
  { uuidAddressed = false }: { uuidAddressed?: boolean } = {},
): Promise<{ campaignId: string; slug: string; revision: string }> {
  const created = await api.create({ name: "Acme Campaign", type: "social-post" });
  expect(created.status).toBe(201);
  const { campaignId, slug } = (await created.json()) as { campaignId: string; slug: string };

  const asset = await api.uploadAsset({
    briefId: slug,
    name: "logo.png",
    contentBase64: PNG_B64,
  });
  expect(asset.status).toBe(201);

  // The brief is always saved with the SLUG as its id — `createBriefInternal`
  // still stamps a `campaign` row keyed by `brief.id`, so saving a brief whose
  // id is a uuid would mint a spurious campaign under that uuid as its slug.
  // (PT-5c2's "briefs.post no longer creates a campaign" is a store-level guard;
  // the auto-mint fallback in `createBriefInternal` predates it and only ever sees
  // the slug — the one id a brief is ever saved under in practice.) The
  // uuid-addressed run names the uuid ONLY in `generate`'s request body below.
  const brief = sampleBrief(slug);
  const saved = await api.saveBrief(brief);
  expect(saved.status).toBe(201);
  const revision = ((await saved.json()) as { revision: string }).revision;

  const runBrief = uuidAddressed ? { ...brief, id: campaignId } : brief;
  const gen = await api.generate(runBrief);
  expect(gen.status).toBe(202);
  const { jobId } = (await gen.json()) as { jobId: string };
  const done = await api.pollJob(jobId);
  expect(done.status).toBe("completed");
  expect(done.result).toBeDefined();

  // The slug-addressed run exercises the full write chain; a uuid-addressed run
  // keys its report/job by the uuid, so the routes that read them back by slug
  // cannot name them — those steps are intentionally omitted here.
  if (!uuidAddressed) {
    const pkg = await api.pkg({ campaignId: slug, platforms: ["instagram-feed"] });
    expect(pkg.status).toBe(200);
    const dec = await api.putDecisions({
      campaignId: slug,
      revision: null,
      decisions: { "alpha/1:1/default": "approved" },
    });
    expect(dec.status).toBe(200);
    const dr = await api.putDraft(slug, {
      state: { source: { kind: "new" }, mode: "single" },
      baseRevision: revision,
    });
    expect(dr.status).toBe(200);
  }
  return { campaignId, slug, revision };
}

/** Plant the two writes PT-9f's tombstone transaction will make, by raw SQL. */
async function plantDeletion(harness: PgHarness, campaignId: string): Promise<void> {
  await harness.db.query(`update campaign set deleted_at = now(), deleted_by = $2 where id = $1`, [
    campaignId,
    ACME_TENANT.userId,
  ]);
  await harness.db.query(
    `insert into deletion (org_id, kind, subject, requested_by, not_before)
       values ($1, 'campaign', $2, $3, now())`,
    [ACME_TENANT.orgId, campaignId, ACME_TENANT.userId],
  );
}

const CAMPAIGN_TABLES = [
  "asset",
  "draft",
  "last_opened",
  "decision",
  "decision_set",
  "report",
  "pool",
  "job",
] as const;

/** The three fs tenant trees the purge frees, keyed by the campaign's slug. */
function fsTrees(harness: PgHarness, slug: string): string[] {
  const a = ACME_TENANT.orgId;
  return [
    join(harness.projectRoot, "orgs", a, "assets", "inputs", slug),
    join(harness.outputRoot, "orgs", a, slug),
    join(harness.outputRoot, "orgs", a, "packages", slug),
  ];
}

/** The s3 prefix the purge empties, keyed by the campaign's uuid. */
function s3Prefix(campaignId: string): string {
  return campaignPrefix(ACME_TENANT.orgId, campaignId.toLowerCase());
}

/** Row count for one campaign across the slug/uuid dual-key (D246). */
async function countRows(
  harness: PgHarness,
  table: string,
  campaignId: string,
  slug: string,
): Promise<number> {
  const { rows } = await harness.db.query<{ n: number }>(
    `select count(*)::int as n from ${table} where org_id = $1 and campaign_id::text in ($2, $3)`,
    [ACME_TENANT.orgId, campaignId, slug],
  );
  return rows[0]!.n;
}

/**
 * The DoD, pinned per table and per key (slug and uuid text) — one `select
 * count(*)` per pair so a surviving row names its table and key exactly.
 *
 * `campaign` is keyed by `id`/`slug` (not `campaign_id`), and `brief_version`
 * has no `org_id` (it is a FK straight to `campaign.id`, `0004`); every other
 * table carries both, so those two are special-cased and the eight slug/uuid-keyed
 * tables share one branch.
 */
async function assertGone(
  harness: PgHarness,
  campaignId: string,
  slug: string,
  memStore?: InMemoryObjectStore,
): Promise<void> {
  const org = ACME_TENANT.orgId;
  for (const [col, key] of [
    ["id", campaignId],
    ["slug", slug],
  ] as const) {
    const { rows } = await harness.db.query<{ n: number }>(
      `select count(*)::int as n from campaign where org_id = $1 and ${col} = $2`,
      [org, key],
    );
    expect(rows[0]!.n, `campaign by ${col}`).toBe(0);
  }

  for (const [label, key] of [
    ["uuid", campaignId],
    ["slug", slug],
  ] as const) {
    const { rows } = await harness.db.query<{ n: number }>(
      `select count(*)::int as n from brief_version where campaign_id::text = $1`,
      [key],
    );
    expect(rows[0]!.n, `brief_version by ${label}`).toBe(0);
  }

  for (const table of CAMPAIGN_TABLES) {
    for (const [label, key] of [
      ["uuid", campaignId],
      ["slug", slug],
    ] as const) {
      const { rows } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from ${table} where org_id = $1 and campaign_id::text = $2`,
        [org, key],
      );
      expect(rows[0]!.n, `${table} by ${label}`).toBe(0);
    }
  }

  if (memStore) {
    // `s3`: the whole campaign prefix is empty.
    expect(await memStore.list(s3Prefix(campaignId))).toEqual([]);
  } else {
    // `fs`: all three slug-keyed tenant trees are gone.
    for (const dir of fsTrees(harness, slug)) {
      expect(existsSync(dir)).toBe(false);
    }
  }
}

/** `purged_at` is set on the deletion row AND the campaign is fully gone. */
async function assertConverged(
  harness: PgHarness,
  campaignId: string,
  slug: string,
  memStore?: InMemoryObjectStore,
): Promise<void> {
  const { rows } = await harness.db.query<{ purged_at: Date | null }>(
    `select purged_at from deletion where org_id = $1 and subject = $2`,
    [ACME_TENANT.orgId, campaignId],
  );
  expect(rows[0]!.purged_at).not.toBeNull();
  await assertGone(harness, campaignId, slug, memStore);
}

interface E2eContext {
  harness: PgHarness;
  api: Api;
  memStore?: InMemoryObjectStore;
}

/**
 * Stand a harness under the ambient OBJECT_STORE (`fs` by default, `s3` when the
 * verification forces it), run `fn`, and always tear down — the real-producer
 * chain leaves an in-process job worker and a temp database behind.
 */
async function withE2e<T>(fn: (ctx: E2eContext) => Promise<T>): Promise<T> {
  const savedMode = process.env.OBJECT_STORE;
  let memStore: InMemoryObjectStore | undefined;
  let harness: PgHarness | undefined;
  try {
    if (process.env.OBJECT_STORE === "s3") {
      memStore = new InMemoryObjectStore();
      setObjectStoreClient(memStore);
    } else {
      // Normalise: undefined and "" are both "fs".
      delete process.env.OBJECT_STORE;
    }
    harness = await setupPgHarness();
    resetAllStores();
    if (memStore) {
      setObjectStoreClient(memStore);
      resetAllStores();
    }
    setCapabilities({ motion: true });
    const api = mountAll(ACME_TENANT);
    return await fn({ harness, api, memStore });
  } finally {
    setCapabilities({ motion: false, reason: "not probed" });
    vi.restoreAllMocks();
    resetObjectStoreClient();
    resetAllStores();
    if (savedMode === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = savedMode;
    if (harness) {
      await resetJobs();
      await harness.cleanup();
    }
  }
}

// Hoisted to the whole file (FIX 4): the real-producer chain reads provider
// keys through `overlayOrgKeys`, so a host whose `.env.local` holds them would
// otherwise let a unit test's run pick up a key the integration did not set,
// making the file order-dependent. Saved and restored around every test —
// including the top-level ones that do not own their own beforeEach.
const PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "FIREFLY_CLIENT_ID",
  "FIREFLY_CLIENT_SECRET",
] as const;
const savedProviderKeys: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of PROVIDER_KEYS) {
    savedProviderKeys[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of PROVIDER_KEYS) {
    if (savedProviderKeys[key] === undefined) delete process.env[key];
    else process.env[key] = savedProviderKeys[key];
  }
});

describe.each([{ store: "fs" }, { store: "s3" }])(
  "the purge engine end to end under $store:",
  ({ store }) => {
    let harness: PgHarness;
    let memStore: InMemoryObjectStore | undefined;
    let api: Api;
    const savedMode = process.env.OBJECT_STORE;

    beforeEach(async () => {
      process.env.OBJECT_STORE = store;
      harness = await setupPgHarness();
      resetAllStores();
      if (store === "s3") {
        memStore = new InMemoryObjectStore();
        setObjectStoreClient(memStore);
        resetAllStores();
      } else {
        memStore = undefined;
        resetObjectStoreClient();
      }
      setCapabilities({ motion: true });
      api = mountAll(ACME_TENANT);
    });

    afterEach(async () => {
      setCapabilities({ motion: false, reason: "not probed" });
      vi.restoreAllMocks();
      resetObjectStoreClient();
      resetAllStores();
      if (savedMode === undefined) delete process.env.OBJECT_STORE;
      else process.env.OBJECT_STORE = savedMode;
      await resetJobs();
      await harness.cleanup();
    });

    test("upload render package decide draft then delete and sweep", async () => {
      const { campaignId, slug } = await produceCampaign(api);
      // Pre-purge: prove the data actually EXISTS so the post-purge zeros are
      // not vacuous. The campaign row itself.
      const { rows } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from campaign where org_id = $1 and id = $2`,
        [ACME_TENANT.orgId, campaignId],
      );
      expect(rows[0]!.n).toBe(1);

      // The objects the purge is responsible for freeing.
      if (memStore) {
        expect((await memStore.list(s3Prefix(campaignId))).length).toBeGreaterThan(0);
      } else {
        for (const dir of fsTrees(harness, slug)) {
          expect(existsSync(dir)).toBe(true);
        }
      }

      // The rows D232 step 3 deletes. `draft`/`decision`/`report`/`job` are rows
      // under every STORE_BACKEND=postgres run, so they are checked on both
      // backends; `asset` is rows only under `s3` (FsAssetStore writes files,
      // not rows, under `fs` — covered by the tree-exists check above) and
      // `pool`/`last_opened` are deliberately not pre-asserted: no pool is
      // written without OPENROUTER_API_KEY (pipeline.ts:485).
      for (const table of ["draft", "decision", "report", "job"] as const) {
        expect(
          await countRows(harness, table, campaignId, slug),
          `${table} pre-purge`,
        ).toBeGreaterThan(0);
      }
      if (memStore) {
        expect(
          await countRows(harness, "asset", campaignId, slug),
          `asset pre-purge`,
        ).toBeGreaterThan(0);
      }

      await plantDeletion(harness, campaignId);

      const { purged, failed } = await sweep(harness.db, () => {});
      expect(purged).toBe(1);
      expect(failed).toBe(0);

      await assertConverged(harness, campaignId, slug, memStore);
      await assertGone(harness, campaignId, slug, memStore);
    }, 120_000);
  },
);

test("re-creating a deleted campaign's slug never surfaces the old report decisions or pool", async () => {
  await withE2e(async ({ harness, api, memStore }) => {
    const { campaignId, slug } = await produceCampaign(api);
    await plantDeletion(harness, campaignId);

    const { purged } = await sweep(harness.db, () => {});
    expect(purged).toBe(1);
    await assertConverged(harness, campaignId, slug, memStore);

    // Reuse the slug: the fresh campaign must read empty everywhere, never the
    // old deleted one's report, decisions or pool (C1). The re-create is blank,
    // so upload the logo the brief names before saving it — under `s3` a brief
    // ref is resolved at save time and a path with no asset is refused.
    const recreated = await api.create({ name: "Acme Campaign", type: "social-post" });
    expect(recreated.status).toBe(201);
    const { slug: recycled } = (await recreated.json()) as { slug: string };
    expect(recycled).toBe(slug);
    const reAsset = await api.uploadAsset({
      briefId: slug,
      name: "logo.png",
      contentBase64: PNG_B64,
    });
    expect(reAsset.status).toBe(201);
    const briefed = await api.saveBrief(sampleBrief(slug));
    expect(briefed.status).toBe(201);

    expect(await (await api.result(slug)).json()).toEqual({
      halted: false,
      assets: [],
      log: null,
    });
    expect(await (await api.decisions(slug)).json()).toEqual({
      decisions: {},
      revision: null,
    });
    expect((await api.pools(slug)).status).toBe(404);
  });
}, 120_000);

test("a uuid-addressed run is purged identically to its slug-addressed twin", async () => {
  await withE2e(async ({ harness, api, memStore }) => {
    const { campaignId, slug } = await produceCampaign(api, { uuidAddressed: true });

    // Pre-purge: the run keyed its job/report by the uuid — prove they exist under
    // that key, so "gone" afterwards cannot pass vacuously.
    const preJob = await harness.db.query<{ n: number }>(
      `select count(*)::int as n from job where org_id = $1 and campaign_id = $2`,
      [ACME_TENANT.orgId, campaignId],
    );
    expect(preJob.rows[0]!.n).toBeGreaterThan(0);
    const preReport = await harness.db.query<{ n: number }>(
      `select count(*)::int as n from report where org_id = $1 and campaign_id = $2`,
      [ACME_TENANT.orgId, campaignId],
    );
    expect(preReport.rows[0]!.n).toBeGreaterThan(0);

    await plantDeletion(harness, campaignId);

    const { purged, failed } = await sweep(harness.db, () => {});
    expect(purged).toBe(1);
    expect(failed).toBe(0);

    // The job/report were keyed by the uuid text — assert they are gone by
    // that key, with no orphan left under it (D246/PT-9-1).
    const jobByUuid = await harness.db.query<{ n: number }>(
      `select count(*)::int as n from job where org_id = $1 and campaign_id = $2`,
      [ACME_TENANT.orgId, campaignId],
    );
    expect(jobByUuid.rows[0]!.n).toBe(0);
    const reportByUuid = await harness.db.query<{ n: number }>(
      `select count(*)::int as n from report where org_id = $1 and campaign_id = $2`,
      [ACME_TENANT.orgId, campaignId],
    );
    expect(reportByUuid.rows[0]!.n).toBe(0);

    await assertGone(harness, campaignId, slug, memStore);
  });
}, 120_000);

test("a purge interrupted after freeing objects but before the row transaction commits converges on the next sweep", async () => {
  await withE2e(async ({ harness, api, memStore }) => {
    const { campaignId, slug } = await produceCampaign(api);
    await plantDeletion(harness, campaignId);

    // Simulate the crash: free the bytes (idempotent) and stop before any row
    // is deleted — exactly the state `deleteCampaignObjects` alone leaves.
    await deleteCampaignObjects(ACME_TENANT.orgId, campaignId, slug);

    const { purged, failed } = await sweep(harness.db, () => {});
    expect(purged).toBe(1);
    expect(failed).toBe(0);
    await assertConverged(harness, campaignId, slug, memStore);

    // A second sweep finds nothing due: the interrupted attempt left no
    // duplicate effect.
    const again = await sweep(harness.db, () => {});
    expect(again).toEqual({ purged: 0, failed: 0, orgFailed: 0 });
  });
}, 120_000);

test("a purge interrupted after the row transaction but before markPurged converges on the next sweep", async () => {
  await withE2e(async ({ harness, api, memStore }) => {
    const { campaignId, slug } = await produceCampaign(api);
    await plantDeletion(harness, campaignId);

    // Simulate the crash: free the bytes AND delete the rows (the campaign
    // row goes with them), leaving the deletion claim un-purged.
    await deleteCampaignObjects(ACME_TENANT.orgId, campaignId, slug);
    await deleteCampaignRows(harness.db, ACME_TENANT.orgId, campaignId);

    const { purged, failed } = await sweep(harness.db, () => {});
    expect(purged).toBe(1);
    expect(failed).toBe(0);
    await assertConverged(harness, campaignId, slug, memStore);

    const again = await sweep(harness.db, () => {});
    expect(again).toEqual({ purged: 0, failed: 0, orgFailed: 0 });
  });
}, 120_000);
