import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import type { TenantContext } from "../../../lib/tenant.js";
import {
  getAssetStore,
  getBriefStore,
  getDraftStore,
  resetAssetStore,
} from "../../../lib/ports/index.js";
import {
  mountTenantRoute,
  setupFsHarness,
  ACME_TENANT,
  type FsHarness,
} from "../../__tests__/tenant-harness.js";
import assetsDeleteHandler from "../assets.delete.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** A second, byte-distinct payload so two assets are never equal. */
const PNG_ALT = Buffer.concat([PNG, Buffer.from([0x00])]);

const brief = (id: string, logoPath = "logo.png"): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id,
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath }],
  treatments: [{ id: "bold", layout: "headline-bottom", tone: "bold" }],
});

const local: TenantContext = { orgId: "local", userId: "u", roles: [], teamIds: [] };

/** One valid lower-case uuid, for the `id=` validation cases. */
const VALID_UUID = "0189dc2a-00a4-7f5c-9b2a-000000000001";

type Pair = readonly [TenantContext, string];
const BASE: readonly Pair[] = [
  [local, "camp"],
  [local, "camp2"],
  [ACME_TENANT, "camp"],
];

/**
 * Read back the on-disk asset state of every (tenant, slug) pair as comparable
 * hex, so a refusal can be asserted against a snapshot taken before the request.
 */
async function state(pairs: readonly Pair[] = BASE): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [tenant, slug] of pairs) {
    const store = getAssetStore(tenant);
    const entries = await store.listAssets(slug);
    const bytes: Record<string, string> = {};
    for (const e of entries) {
      const buf = await store.readAsset(slug, e.name);
      bytes[e.name] = buf ? buf.toString("hex") : "ABSENT";
    }
    out[`${tenant.orgId}:${slug}`] = { names: entries.map((e) => e.name), bytes };
  }
  return out;
}

const del = (tenant: TenantContext, query: string): Promise<Response> =>
  mountTenantRoute(assetsDeleteHandler, {
    method: "DELETE",
    path: "/campaigns/assets",
    tenant,
  })(new Request(`http://x/campaigns/assets?${query}`, { method: "DELETE" }));

describe("DELETE /campaigns/assets", () => {
  let harness: FsHarness;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  beforeEach(async () => {
    delete process.env.OBJECT_STORE;
    harness = setupFsHarness();
    const briefs = getBriefStore(local);
    const assets = getAssetStore(local);
    const acmeBriefs = getBriefStore(ACME_TENANT);
    const acmeAssets = getAssetStore(ACME_TENANT);
    // camp: brief names logo.png (by path), two assets.
    await briefs.createBrief(brief("camp", "assets/inputs/camp/logo.png"));
    await assets.writeAsset("camp", "logo.png", PNG);
    await assets.writeAsset("camp", "other.png", PNG_ALT);
    // camp2: its own logo.png with different bytes.
    await briefs.createBrief(brief("camp2", "assets/inputs/camp2/logo.png"));
    await assets.writeAsset("camp2", "logo.png", PNG_ALT);
    // acme (other org) holds camp/logo.png with PNG bytes.
    await acmeBriefs.createBrief(brief("camp", "assets/inputs/camp/logo.png"));
    await acmeAssets.writeAsset("camp", "logo.png", PNG);
  });

  afterEach(async () => {
    resetAssetStore();
    vi.restoreAllMocks();
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    await harness.cleanup();
  });

  // --- Batch 1: validation (every one asserts the snapshot is unchanged) ---

  test("DELETE /campaigns/assets answers 400 for an unsafe briefId and removes nothing", async () => {
    const before = await state();
    const traverse = await del(local, "briefId=..%2Fx&name=logo.png");
    expect(traverse.status).toBe(400);
    const missing = await del(local, "name=logo.png");
    expect(missing.status).toBe(400);
    expect(await state()).toEqual(before);
  });

  test("DELETE /campaigns/assets answers 400 when neither id nor name is given and removes nothing", async () => {
    const before = await state();
    const res = await del(local, "briefId=camp");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Give exactly one of id or name." });
    expect(await state()).toEqual(before);
  });

  test("DELETE /campaigns/assets answers 400 when both id and name are given and removes nothing", async () => {
    const before = await state();
    const res = await del(local, `briefId=camp&id=${VALID_UUID}&name=logo.png`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Give exactly one of id or name." });
    expect(await state()).toEqual(before);
  });

  test("DELETE /campaigns/assets answers 400 for a name that is not a safe asset name and removes nothing", async () => {
    const before = await state();
    const urls = [
      "briefId=camp&name=..%2Flogo.png",
      "briefId=camp&name=Logo.PNG",
      "briefId=camp&name=logo.gif",
      "briefId=camp&name=a.png&name=b.png",
    ];
    for (const u of urls) {
      const res = await del(local, u);
      expect(res.status).toBe(400);
    }
    expect(await state()).toEqual(before);
  });

  test("DELETE /campaigns/assets answers 400 for an id that is not an asset id and removes nothing", async () => {
    const before = await state();
    const notUuid = await del(local, "briefId=camp&id=not-a-uuid");
    expect(notUuid.status).toBe(400);
    expect(await notUuid.json()).toEqual({ error: "Invalid asset id." });
    const upper = await del(local, "briefId=camp&id=0189DC2A-00A4-7F5C-9B2A-000000000001");
    expect(upper.status).toBe(400);
    expect(await upper.json()).toEqual({ error: "Invalid asset id." });
    expect(await state()).toEqual(before);
  });

  // --- Batch 2: the file store happy path and the 404s ---

  test("DELETE /campaigns/assets on the file store removes the named file and nothing else", async () => {
    const res = await del(local, "briefId=camp&name=other.png");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    const store = getAssetStore(local);
    expect((await store.listAssets("camp")).map((e) => e.name)).toEqual(["logo.png"]);
    expect(await store.readAsset("camp", "logo.png")).toEqual(PNG);
    expect(await getAssetStore(local).readAsset("camp2", "logo.png")).toEqual(PNG_ALT);
    expect(await getAssetStore(ACME_TENANT).readAsset("camp", "logo.png")).toEqual(PNG);
  });

  test("DELETE /campaigns/assets on the file store frees an asset of an unsaved campaign", async () => {
    await getAssetStore(local).writeAsset("draft-only", "logo.png", PNG);
    const res = await del(local, "briefId=draft-only&name=logo.png");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await getAssetStore(local).readAsset("draft-only", "logo.png")).toBeUndefined();
  });

  test("DELETE /campaigns/assets on the file store answers 404 for an unknown name and removes nothing", async () => {
    const before = await state();
    const res = await del(local, "briefId=camp&name=nope.png");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Asset "nope.png" not found.' });
    expect(await state()).toEqual(before);
  });

  test("DELETE /campaigns/assets on the file store answers 404 for an id because the file store has none", async () => {
    const before = await state();
    const res = await del(local, `briefId=camp&id=${VALID_UUID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Asset "${VALID_UUID}" not found.` });
    expect(await state()).toEqual(before);
  });

  // --- Batch 3: the refusals (each: 409 body exactly, snapshot unchanged) ---

  test("DELETE /campaigns/assets on the file store answers 409 when the saved brief names the asset by path", async () => {
    const before = await state();
    const res = await del(local, "briefId=camp&name=logo.png");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Asset "logo.png" is in use.' });
    expect(await state()).toEqual(before);
  });

  test("DELETE /campaigns/assets on the file store answers 409 when the saved brief names the asset by bare name", async () => {
    await getBriefStore(local).rewriteBrief(brief("camp", "logo.png"));
    const before = await state();
    const res = await del(local, "briefId=camp&name=logo.png");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Asset "logo.png" is in use.' });
    expect(await state()).toEqual(before);
  });

  test("DELETE /campaigns/assets on the file store answers 409 when the callers own draft names the asset", async () => {
    // Brief names only other.png now, so the saved version does NOT block logo.png.
    await getBriefStore(local).rewriteBrief(brief("camp", "assets/inputs/camp/other.png"));
    const drafts = getDraftStore(local);

    // (a) draft names logo.png by path -> 409
    const beforeA = await state();
    await drafts.writeDraft(
      "camp",
      local.userId,
      { products: [{ logoPath: "assets/inputs/camp/logo.png" }] },
      null,
    );
    const a = await del(local, "briefId=camp&name=logo.png");
    expect(a.status).toBe(409);
    expect(await a.json()).toEqual({ error: 'Asset "logo.png" is in use.' });
    expect(await state()).toEqual(beforeA);

    // (b) draft names it only as an object KEY -> 409
    await drafts.writeDraft("camp", local.userId, { refs: { "logo.png": 1 } }, null);
    const b = await del(local, "briefId=camp&name=logo.png");
    expect(b.status).toBe(409);
    expect(await b.json()).toEqual({ error: 'Asset "logo.png" is in use.' });
    expect(await state()).toEqual(beforeA);

    // (c) draft names my-logo.png (path form) and carries number/null fields, never
    //     logo.png -> exact match, not substring -> 200, logo.png gone, other.png intact.
    await drafts.writeDraft(
      "camp",
      local.userId,
      {
        products: [{ logoPath: "assets/inputs/camp/my-logo.png" }],
        count: 0,
        note: null,
      },
      null,
    );
    const c = await del(local, "briefId=camp&name=logo.png");
    expect(c.status).toBe(200);
    expect(await c.json()).toEqual({ deleted: true });
    const store = getAssetStore(local);
    expect((await store.listAssets("camp")).map((e) => e.name)).toEqual(["other.png"]);
    expect(await store.readAsset("camp", "other.png")).toEqual(PNG_ALT);
  });

  test("DELETE /campaigns/assets on the file store answers 409 when the saved brief names the asset by a non-canonical path", async () => {
    const pairs = [
      [local, "camp"],
      [local, "camp2"],
      [ACME_TENANT, "camp"],
    ] as const;

    // (a) ./ prefix -> normalised to camp -> 409
    await getBriefStore(local).rewriteBrief(brief("camp", "./assets/inputs/camp/logo.png"));
    const beforeA = await state(pairs);
    const a = await del(local, "briefId=camp&name=logo.png");
    expect(a.status).toBe(409);
    expect(await a.json()).toEqual({ error: 'Asset "logo.png" is in use.' });
    expect(await state(pairs)).toEqual(beforeA);

    // (b) camp2/../camp -> normalised to camp -> 409
    await getBriefStore(local).rewriteBrief(brief("camp", "assets/inputs/camp2/../camp/logo.png"));
    const beforeB = await state(pairs);
    const b = await del(local, "briefId=camp&name=logo.png");
    expect(b.status).toBe(409);
    expect(await b.json()).toEqual({ error: 'Asset "logo.png" is in use.' });
    expect(await state(pairs)).toEqual(beforeB);

    // (c) camp2/logo.png -> resolves to ANOTHER campaign -> not this one -> 200
    await getBriefStore(local).rewriteBrief(brief("camp", "assets/inputs/camp2/logo.png"));
    const c = await del(local, "briefId=camp&name=logo.png");
    expect(c.status).toBe(200);
    expect(await c.json()).toEqual({ deleted: true });
    const store = getAssetStore(local);
    expect((await store.listAssets("camp")).map((e) => e.name)).toEqual(["other.png"]);
    // camp2/logo.png bytes are still PNG_ALT: parsing the slug is what kept them safe.
    expect(await store.readAsset("camp2", "logo.png")).toEqual(PNG_ALT);
  });

  test("DELETE /campaigns/assets on the file store answers 500 and frees nothing when the saved brief no longer parses", async () => {
    const pairs = [
      [local, "camp"],
      [local, "camp2"],
      [ACME_TENANT, "camp"],
      [local, "camp-broken"],
    ] as const;
    writeFileSync(join(harness.projectRoot, "briefs", "camp-broken.yaml"), "products: [");
    await getAssetStore(local).writeAsset("camp-broken", "logo.png", PNG);
    const before = await state(pairs);
    const res = await del(local, "briefId=camp-broken&name=logo.png");
    expect(res.status).toBe(500);
    expect(await state(pairs)).toEqual(before);
    expect(await getAssetStore(local).readAsset("camp-broken", "logo.png")).toEqual(PNG);
  });

  // --- Batch 4: isolation and the lock ---

  test("DELETE /campaigns/assets on the file store removes only the named campaigns file and leaves a same named file of another campaign", async () => {
    // Brief names only other.png, so logo.png is free to delete.
    await getBriefStore(local).rewriteBrief(brief("camp", "assets/inputs/camp/other.png"));
    const res = await del(local, "briefId=camp&name=logo.png");
    expect(res.status).toBe(200);

    const store = getAssetStore(local);
    expect((await store.listAssets("camp")).map((e) => e.name)).toEqual(["other.png"]);
    // camp2's same-named file is a different campaign and is untouched.
    expect(await store.readAsset("camp2", "logo.png")).toEqual(PNG_ALT);
  });

  test("DELETE /campaigns/assets on the file store never reaches another orgs campaign", async () => {
    await getBriefStore(local).rewriteBrief(brief("camp", "assets/inputs/camp/other.png"));
    const res = await del(local, "briefId=camp&name=logo.png");
    expect(res.status).toBe(200);

    const store = getAssetStore(local);
    expect(await store.readAsset("camp", "logo.png")).toBeUndefined();
    // acme's camp/logo.png is a different org's bytes: still full PNG.
    expect(await getAssetStore(ACME_TENANT).readAsset("camp", "logo.png")).toEqual(PNG);
  });

  test("DELETE /campaigns/assets takes the brief lock for the campaign slug", async () => {
    const briefs = getBriefStore(local);
    const spy = vi.spyOn(briefs, "withBriefLock");
    const res = await del(local, "briefId=camp&name=other.png");
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith("camp", expect.any(Function));
  });
});
