import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { resetProjectRoot } from "@campaignfoundry/shared";

import { LOCAL_TENANT } from "../../../lib/tenant.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../../../lib/object-store/index.js";
import { getAssetStore, getBriefStore, resetAssetStore } from "../../../lib/ports/index.js";
// The STATIC handler, for the describe at the bottom — see its note on why it
// cannot go through `web()`.
import staticAssetsGet from "../assets.get.js";
import {
  mountTenantRoute,
  setupPgHarness,
  type PgHarness,
} from "../../__tests__/tenant-harness.js";
const web = async (root: string) => {
  vi.resetModules();
  process.env.PROJECT_ROOT = root;
  const handler = (await import("../assets.get.js")).default as EventHandler;
  const app = createApp();
  const router = createRouter();
  router.get("/campaigns/assets", handler);
  app.use(router);
  return toWebHandler(app);
};

const get = (handler: (req: Request) => Promise<Response>, query = "") =>
  handler(new Request(`http://x/campaigns/assets${query}`));

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]);
const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x22]);
const m4a = Buffer.from([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x02, 0x00,
]);

describe("GET /campaigns/assets", () => {
  let dir: string;
  const origRoot = process.env.PROJECT_ROOT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-assets-get-"));
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(
      join(dir, "briefs", "camp.yaml"),
      "id: camp\nstatus: draft\nmode: brief\ntargetRegion: US\ntargetAudience: dev\ncampaignMessage: msg\nproducts:\n  - id: p1\n    name: P1\naspectRatios:\n  - 1:1\ntreatments:\n  - id: bold\n    name: Bold\n    layout: headline-bottom\n    tone: bold\n",
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    vi.restoreAllMocks();
  });

  test("returns 400 when briefId is missing or invalid", async () => {
    const handler = await web(dir);
    const missing = await get(handler);
    expect(missing.status).toBe(400);

    const traversing = await get(handler, "?briefId=../escape");
    expect(traversing.status).toBe(400);
  });

  test("accepts repeated briefId query params, using the first value", async () => {
    const briefDir = join(dir, "assets", "inputs", "camp");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(briefDir, "logo.png"), png);

    const handler = await web(dir);
    const res = await get(handler, "?briefId=camp&briefId=other");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assets: unknown[] };
    expect(body.assets).toHaveLength(1);
  });

  test("returns empty list when brief has no assets directory", async () => {
    const handler = await web(dir);
    const res = await get(handler, "?briefId=camp");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assets: [] });
  });

  test("lists assets for an unsaved brief with assets and no stored brief (H5)", async () => {
    const briefDir = join(dir, "assets", "inputs", "unsaved-brief");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(briefDir, "logo.png"), png);

    const handler = await web(dir);
    const res = await get(handler, "?briefId=unsaved-brief");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assets: Array<{ name: string }> };
    expect(body.assets).toHaveLength(1);
    expect(body.assets[0].name).toBe("logo.png");
  });

  test("returns 404 for an unknown brief with no assets and no stored brief (Rule A)", async () => {
    const handler = await web(dir);
    const res = await get(handler, "?briefId=nonexistent");
    expect(res.status).toBe(404);
  });

  test("returns listed assets sorted by name with type, size, and fetchable thumbnail URL", async () => {
    const briefDir = join(dir, "assets", "inputs", "camp");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(briefDir, "logo-b.png"), png);
    writeFileSync(join(briefDir, "photo-a.jpg"), jpeg);
    writeFileSync(join(briefDir, "ignore.txt"), "text");

    const handler = await web(dir);
    const res = await get(handler, "?briefId=camp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      assets: Array<{ name: string; type: string; size: number; thumbnailUrl: string }>;
    };

    expect(body.assets).toHaveLength(2);
    expect(body.assets[0].name).toBe("logo-b.png");
    expect(body.assets[0].type).toBe("image/png");
    expect(body.assets[0].size).toBe(png.length);
    expect(body.assets[0].thumbnailUrl).toBe(
      "/api/pipeline/campaigns/assets?briefId=camp&name=logo-b.png",
    );

    expect(body.assets[1].name).toBe("photo-a.jpg");
    expect(body.assets[1].type).toBe("image/jpeg");
    expect(body.assets[1].size).toBe(jpeg.length);
    expect(body.assets[1].thumbnailUrl).toBe(
      "/api/pipeline/campaigns/assets?briefId=camp&name=photo-a.jpg",
    );
  });

  test("serves raw asset content with content-type when name query parameter is supplied", async () => {
    const briefDir = join(dir, "assets", "inputs", "camp");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(briefDir, "logo.png"), png);
    writeFileSync(join(briefDir, "photo.jpg"), jpeg);

    const handler = await web(dir);

    // PNG asset (including repeated name query parameter)
    const resPng = await get(handler, "?briefId=camp&name=logo.png&name=other.png");
    expect(resPng.status).toBe(200);
    expect(resPng.headers.get("content-type")).toBe("image/png");
    const receivedPng = Buffer.from(await resPng.arrayBuffer());
    expect(receivedPng).toEqual(png);

    // JPEG asset
    const resJpeg = await get(handler, "?briefId=camp&name=photo.jpg");
    expect(resJpeg.status).toBe(200);
    expect(resJpeg.headers.get("content-type")).toBe("image/jpeg");
    const receivedJpeg = Buffer.from(await resJpeg.arrayBuffer());
    expect(receivedJpeg).toEqual(jpeg);

    // Missing asset -> 404
    const resMissing = await get(handler, "?briefId=camp&name=missing.png");
    expect(resMissing.status).toBe(404);

    // Invalid asset name -> 400
    const resInvalid = await get(handler, "?briefId=camp&name=../invalid.png");
    expect(resInvalid.status).toBe(400);
  });

  test("serves audio content types for mp3 and m4a (VE3b2)", async () => {
    const briefDir = join(dir, "assets", "inputs", "camp");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(briefDir, "bed.mp3"), mp3);
    writeFileSync(join(briefDir, "bed.m4a"), m4a);

    const handler = await web(dir);

    const resMp3 = await get(handler, "?briefId=camp&name=bed.mp3");
    expect(resMp3.status).toBe(200);
    expect(resMp3.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await resMp3.arrayBuffer())).toEqual(mp3);

    const resM4a = await get(handler, "?briefId=camp&name=bed.m4a");
    expect(resM4a.status).toBe(200);
    expect(resM4a.headers.get("content-type")).toBe("audio/mp4");
    expect(Buffer.from(await resM4a.arrayBuffer())).toEqual(m4a);
  });

  test("lists an audio asset with its content type (VE3b2)", async () => {
    const briefDir = join(dir, "assets", "inputs", "camp");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(briefDir, "bed.mp3"), mp3);

    const handler = await web(dir);
    const res = await get(handler, "?briefId=camp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assets: Array<{ name: string; type: string }> };
    expect(body.assets).toEqual([expect.objectContaining({ name: "bed.mp3", type: "audio/mpeg" })]);
  });

  // The named fetch reads the one file it names; a failure listing the other
  // assets (an unrelated file vanishing mid-listing) must not turn it into a 500.
  test("named-asset fetch does not depend on listing the campaign's assets", async () => {
    const briefDir = join(dir, "assets", "inputs", "camp");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(briefDir, "logo.png"), png);
    const handler = await web(dir);
    const { getAssetStore } = await import("../../../lib/ports/index.js");
    const spy = vi
      .spyOn(getAssetStore(LOCAL_TENANT), "listAssets")
      .mockRejectedValue(new Error("Disk error"));

    const res = await get(handler, "?briefId=camp&name=logo.png");
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("returns empty list on store list failure", async () => {
    const handler = await web(dir);
    const { getAssetStore } = await import("../../../lib/ports/index.js");
    const spy = vi
      .spyOn(getAssetStore(LOCAL_TENANT), "listAssets")
      .mockRejectedValue(new Error("Disk error"));

    const res = await get(handler, "?briefId=camp");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assets: [] });
    spy.mockRestore();
  });
});

/**
 * PT-4f, D209b: the LISTING is unchanged on both backends, so it signs nothing.
 *
 * **Static imports here, unlike every test above.** `web()` calls
 * `vi.resetModules()`, so the handler it mounts runs against a FRESH module graph
 * — and an object store installed through this file's imports would be an instance
 * that handler never asks. A `presignGet` spy on it would be watching a store
 * nobody calls, which is a green test proving nothing. Both the handler and the
 * store below come from the same graph, so a call would be counted.
 */
describe("GET /campaigns/assets mints no signed URL on fs (PT-4f, D209b)", () => {
  let dir: string;
  let store: InMemoryObjectStore;
  const origRoot = process.env.PROJECT_ROOT;
  const SAVED = process.env.OBJECT_STORE;

  beforeEach(() => {
    // fs, explicitly: this is the assertion that the listing is not s3-shaped.
    delete process.env.OBJECT_STORE;
    dir = mkdtempSync(join(tmpdir(), "cf-assets-get-nosign-"));
    mkdirSync(join(dir, "briefs"), { recursive: true });
    process.env.PROJECT_ROOT = dir;
    const briefDir = join(dir, "assets", "inputs", "camp");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(briefDir, "logo.png"), png);
    writeFileSync(join(briefDir, "photo.jpg"), jpeg);
    resetProjectRoot();
    resetAssetStore();
    store = new InMemoryObjectStore();
    setObjectStoreClient(store);
  });

  afterEach(() => {
    resetAssetStore();
    resetObjectStoreClient();
    resetProjectRoot();
    rmSync(dir, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    if (SAVED === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED;
    vi.restoreAllMocks();
  });

  test("the listing body is fs's exact strings and the store is never asked to sign", async () => {
    const presign = vi.spyOn(store, "presignGet");
    const call = mountTenantRoute(staticAssetsGet, {
      path: "/campaigns/assets",
      tenant: LOCAL_TENANT,
    });
    const res = await call(new Request("http://x/campaigns/assets?briefId=camp"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      assets: [
        {
          name: "logo.png",
          type: "image/png",
          size: png.length,
          thumbnailUrl: "/api/pipeline/campaigns/assets?briefId=camp&name=logo.png",
        },
        {
          name: "photo.jpg",
          type: "image/jpeg",
          size: jpeg.length,
          thumbnailUrl: "/api/pipeline/campaigns/assets?briefId=camp&name=photo.jpg",
        },
      ],
    });
    // `thumbnailUrl` never expires and costs no signing: a campaign with forty
    // inputs would pay forty signings on every poll tick otherwise.
    expect(presign).not.toHaveBeenCalled();
  });

  test("?name= streams the bytes and never asks the store for a key", async () => {
    const presign = vi.spyOn(store, "presignGet");
    const key = vi.spyOn(getAssetStore(LOCAL_TENANT), "assetObjectKey");
    const call = mountTenantRoute(staticAssetsGet, {
      path: "/campaigns/assets",
      tenant: LOCAL_TENANT,
    });
    const res = await call(new Request("http://x/campaigns/assets?briefId=camp&name=logo.png"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
    // The redirect branch is taken on `objectStore() === "s3"` alone, never on
    // "the store answered undefined for the key" — which is what fs answers for
    // every asset it has, because it has no keys at all.
    expect(key).not.toHaveBeenCalled();
    expect(presign).not.toHaveBeenCalled();
  });
});

/**
 * PT-9a2, D233 r2 — the tombstone filter PT-9a1 shipped, through the LISTING
 * branch of `assets.get.ts`.
 *
 * **Postgres only**: `fs` has no `campaign` row to carry `deleted_at`, so there
 * is no tombstone to plant there and nothing to pair this with. This is the
 * LISTING branch (`campaignKnown`, one branch of it) and not the `?name=` one
 * beside it — both ask the same `campaignVisibility` for "hidden", and the
 * packages listing below pins that answer on its own.
 *
 * Static handler import (`staticAssetsGet`), as the describe above explains:
 * `web()` re-imports through a fresh module registry, and `setupPgHarness`
 * patches the database on the registry this file's own imports came from.
 */
describe("GET /campaigns/assets and a tombstone (PT-9a2, D233 r2)", () => {
  const listCall = (briefId: string) =>
    mountTenantRoute(staticAssetsGet, { path: "/campaigns/assets", tenant: LOCAL_TENANT })(
      new Request(`http://x/campaigns/assets?briefId=${briefId}`),
    );

  const sampleBrief = (id: string): CampaignBrief => ({
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id,
    targetRegion: "US",
    targetAudience: "developers",
    campaignMessage: "Build faster",
    products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: "logo.png" }],
  });

  test("a tombstoned campaign's asset listing answers 404", async () => {
    const harness: PgHarness = await setupPgHarness();
    try {
      const store = getBriefStore(LOCAL_TENANT);
      await store.createCampaign("gone-camp");
      await store.createBrief(sampleBrief("gone-camp"));
      const assets = join(harness.projectRoot, "assets", "inputs", "gone-camp");
      mkdirSync(assets, { recursive: true });
      writeFileSync(join(assets, "logo.png"), png);

      // Served before the tombstone, so the 404 below cannot be an id that names
      // no assets and no campaign at all.
      const before = await listCall("gone-camp");
      expect(before.status).toBe(200);
      const listed = (await before.json()) as { assets: { name: string }[] };
      expect(listed.assets.map((asset) => asset.name)).toEqual(["logo.png"]);

      await harness.db.query(
        `update campaign set deleted_at = now() where org_id = $1 and slug = $2`,
        [LOCAL_TENANT.orgId, "gone-camp"],
      );
      const res = await listCall("gone-camp");
      expect(res.status).toBe(404);
      // `campaignKnown`'s `CampaignNotFoundError` is not caught by this route, so
      // h3's own error body answers — never the `{ assets: [] }` listing shape a
      // known-but-empty campaign gets.
      expect(await res.json()).not.toHaveProperty("assets");

      // The asset is still on disk and the row still carries the tombstone: this
      // is a filter over a campaign that exists, not a missing file or a missing row.
      expect(existsSync(join(assets, "logo.png"))).toBe(true);
      const { rows } = await harness.db.query<{ deleted_at: string | null }>(
        "select deleted_at from campaign where org_id = $1 and slug = $2",
        [LOCAL_TENANT.orgId, "gone-camp"],
      );
      expect(rows[0]!.deleted_at).not.toBeNull();
    } finally {
      await harness.cleanup();
    }
  }, 15000);
});
