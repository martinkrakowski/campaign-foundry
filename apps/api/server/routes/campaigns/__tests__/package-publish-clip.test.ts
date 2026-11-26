import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import {
  PUBLISH_PLACEHOLDER_URL_PREFIX,
  type ObjectKey,
  type PublicAdMediaPort,
} from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { renderPrefix } from "../../../lib/object-store/object-keys.js";
import {
  resetObjectStoreClient,
  resetPublicAdMediaClient,
  setObjectStoreClient,
  setPublicAdMediaClient,
} from "../../../lib/object-store/index.js";
import type { SqlClient } from "../../../lib/db/sql-client.js";
import type { TenantContext } from "../../../lib/tenant.js";
import packageHandler from "../package.post.js";
import generateHandler from "../generate.post.js";
import planHandler from "../plan.post.js";
import previewFrameHandler from "../preview-frame.post.js";
import {
  mountTenantRoute,
  resetAllStores,
  setupPgHarness,
  type PgHarness,
} from "../../__tests__/tenant-harness.js";

/**
 * `publishClip` on `POST /campaigns/package` (CFAR6C3): one publish per distinct
 * video placeholder per export, substituted into the packaged `index.html`.
 *
 * Modelled on `package.s3.test.ts` — pg harness, in-memory private bucket, static
 * handler imports — because publishing is an s3-only feature (`fs` refuses) and
 * the pg harness is what can resolve a campaign uuid at all.
 */

const LOCAL: TenantContext = { orgId: "local", userId: "u", roles: ["owner"], teamIds: [] };
const SLUG = "winter-sale";
const CAMPAIGN = "3f1b7a52-0c4d-4a6e-9b21-5d8e7c6a5b4c";
const PLATFORM = "google-display-html";
const SIZE = "300x250";
const SELECTOR = "alpha/1x1/v0.mp4";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const BUNDLE_HTML = `<!DOCTYPE html><html><body><video src="${PUBLISH_PLACEHOLDER_URL_PREFIX}${SELECTOR}"></video></body></html>`;
const PLAIN_HTML = "<!DOCTYPE html><html><body>still</body></html>";

/** One 4-byte big-endian uint32. */
const u32 = (n: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, n, false);
  return bytes;
};

/** ASCII bytes of a short string (FourCCs, brands). */
const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

/** Concatenate byte arrays into one. */
const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** One ISO BMFF box: 8-byte header (size, type) over the payload parts. */
const box = (type: string, ...payload: readonly Uint8Array[]): Uint8Array => {
  const body = concat(payload);
  return concat([u32(8 + body.length), ascii(type), body]);
};

/** A minimal clip `validateAdClip` accepts (the same shape PublishAdClipUseCase's own tests publish). */
const validAdClipBytes = (): Uint8Array => {
  const ftyp = box("ftyp", ascii("isom"), u32(0), ascii("isom"));
  const mvhd = box("mvhd", concat([new Uint8Array(12), u32(1000), u32(1000)]));
  const hdlr = box("hdlr", new Uint8Array(8), ascii("vide"));
  const avcC = box("avcC", new Uint8Array(4));
  const entry = concat([u32(8 + 78 + avcC.length), ascii("avc1"), new Uint8Array(78), avcC]);
  const stsd = box("stsd", new Uint8Array(4), u32(1), entry);
  const moov = box("moov", mvhd, box("trak", box("mdia", hdlr, box("minf", box("stbl", stsd)))));
  return concat([ftyp, moov]);
};

/** A recording double for the public bucket — the publisher's observable edge. */
const fakeMedia = (): PublicAdMediaPort & { publish: Mock } => ({
  publish: vi.fn(async (orgId: string, _bytes: Uint8Array, contentHash: string) => ({
    key: `${orgId}/${"b".repeat(32)}/${contentHash}.mp4` as ObjectKey,
    url: `https://media.test/${orgId}/${contentHash}.mp4`,
  })),
  remove: vi.fn(async () => {}),
  removeOrg: vi.fn(async () => {}),
  urlFor: (key: ObjectKey) => `https://media.test/${key}`,
});

/** Every `PUBLIC_MEDIA_*` variable, the set `publicAdMediaClient()` builds from. */
const PUBLIC_MEDIA_VARS = [
  "PUBLIC_MEDIA_BUCKET",
  "PUBLIC_MEDIA_BASE_URL",
  "PUBLIC_MEDIA_ACCESS_KEY_ID",
  "PUBLIC_MEDIA_SECRET_ACCESS_KEY",
  "PUBLIC_MEDIA_ENDPOINT",
  "PUBLIC_MEDIA_REGION",
] as const;

/**
 * Delete every `PUBLIC_MEDIA_*` variable for the duration of `run`, so
 * `publicAdMediaClient()` re-reading the environment after
 * `resetPublicAdMediaClient()` answers `undefined` even where an operator's local
 * `.env.local` carries real settings. The prior values are restored afterwards.
 */
async function withoutPublicMediaEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const name of PUBLIC_MEDIA_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("POST /campaigns/package — publishClip (CFAR6C3)", () => {
  let harness: PgHarness;
  let store: InMemoryObjectStore;
  let media: ReturnType<typeof fakeMedia>;
  const SAVED = process.env.OBJECT_STORE;

  beforeEach(async () => {
    process.env.OBJECT_STORE = "s3";
    harness = await setupPgHarness();
    store = new InMemoryObjectStore();
    setObjectStoreClient(store);
    resetAllStores();
    media = fakeMedia();
    setPublicAdMediaClient(media);
  });

  afterEach(async () => {
    resetAllStores();
    resetObjectStoreClient();
    resetPublicAdMediaClient();
    vi.restoreAllMocks();
    if (SAVED === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED;
    await harness.cleanup();
  });

  const call = (body: Record<string, unknown>, tenant: TenantContext = LOCAL): Promise<Response> =>
    mountTenantRoute(packageHandler, { method: "POST", path: "/campaigns/package", tenant })(
      new Request("http://x/campaigns/package", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  async function seedCampaign(db: SqlClient): Promise<void> {
    await db.query(`insert into campaign (id, org_id, slug) values ($1, $2, $3)`, [
      CAMPAIGN,
      "local",
      SLUG,
    ]);
  }

  async function seedReport(
    db: SqlClient,
    assets: unknown[] = [
      {
        productId: "alpha",
        size: SIZE,
        outputPath: `${SLUG}/alpha/1x1/fallback.png`,
        treatment: "image-html",
        format: "html",
        htmlBundlePath: `${SLUG}/alpha/1x1/index.html`,
        htmlFallbackPath: `${SLUG}/alpha/1x1/fallback.png`,
      },
    ],
  ): Promise<void> {
    await db.query(
      `insert into report (org_id, campaign_id, body, revision)
       values ($1, $2, $3, 'rev-1')
       on conflict (org_id, campaign_id) do update set body = excluded.body`,
      ["local", SLUG, JSON.stringify({ halted: false, assets, log: { campaignId: SLUG } })],
    );
  }

  /** Seed the renders the report names, plus the clip the placeholder names. */
  async function seedRenders(): Promise<void> {
    const prefix = renderPrefix("local", CAMPAIGN);
    await store.put(`${prefix}alpha/1x1/index.html`, new TextEncoder().encode(BUNDLE_HTML), {
      contentType: "text/html",
    });
    await store.put(`${prefix}alpha/1x1/fallback.png`, PNG, { contentType: "image/png" });
    await store.put(`${prefix}${SELECTOR}`, validAdClipBytes(), { contentType: "video/mp4" });
  }

  /** The packaged `index.html` the s3 path wrote, decoded. */
  async function packagedIndexHtml(): Promise<string> {
    const keys = (await store.list(`org/local/campaign/${CAMPAIGN}/packages/`)).map((e) => e.key);
    const key = keys.find((k) => k.endsWith("/files/alpha/1x1/index.html"));
    expect(key).toBeDefined();
    const stored = await store.get(key as ObjectKey);
    return new TextDecoder().decode(stored!.bytes);
  }

  test("refuses non-boolean publishClip values with HTTP 400", async () => {
    for (const bad of ["true", 1, null, {}]) {
      const res = await call({ campaignId: SLUG, platforms: [PLATFORM], publishClip: bad });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "publishClip must be a boolean" });
    }
    expect(media.publish).not.toHaveBeenCalled();
  });

  test("refuses publishClip under OBJECT_STORE=fs with HTTP 422, writing nothing", async () => {
    process.env.OBJECT_STORE = "fs";
    resetAllStores();
    const res = await call({ campaignId: SLUG, platforms: [PLATFORM], publishClip: true });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("OBJECT_STORE");
    // The refusal happened before any store touch: no package object exists.
    expect(await store.list("org/")).toEqual([]);
    expect(media.publish).not.toHaveBeenCalled();
  });

  test("refuses publishClip when public ad media is unconfigured with HTTP 422", async () => {
    await withoutPublicMediaEnv(async () => {
      resetPublicAdMediaClient();
      const res = await call({ campaignId: SLUG, platforms: [PLATFORM], publishClip: true });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Public ad media is not configured");
      expect(await store.list("org/")).toEqual([]);
    });
  });

  test("refuses publishClip with HTTP 404 when there is no render target, publishing nothing", async () => {
    // A report with no campaign row: under s3 nothing can have rendered without
    // a target, so there is no clip to publish and nothing to package.
    await seedReport(harness.db);
    const res = await call({ campaignId: SLUG, platforms: [PLATFORM], publishClip: true });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Campaign report not found" });
    expect(media.publish).not.toHaveBeenCalled();
    expect(await store.list("org/")).toEqual([]);
  });

  test("publishes each distinct placeholder once and substitutes its URL into the packaged index.html", async () => {
    await seedCampaign(harness.db);
    await seedReport(harness.db);
    await seedRenders();

    const res = await call({ campaignId: SLUG, platforms: [PLATFORM], publishClip: true });
    expect(res.status).toBe(200);
    // One distinct selector, one publish.
    expect(media.publish).toHaveBeenCalledTimes(1);
    expect(media.publish).toHaveBeenCalledWith("local", expect.any(Uint8Array), expect.any(String));

    const html = await packagedIndexHtml();
    expect(html).toContain("https://media.test/local/");
    expect(html).not.toContain("publish.invalid");
  });

  test("keys the publish by the authenticated tenant's orgId, never the body's", async () => {
    await seedCampaign(harness.db);
    await seedReport(harness.db);
    await seedRenders();

    // A forged orgId in the body must not move the publish into another tenant's
    // namespace: the org comes from `requestTenant(event)`.
    const res = await call({
      campaignId: SLUG,
      platforms: [PLATFORM],
      publishClip: true,
      orgId: "globex",
    });
    expect(res.status).toBe(200);
    expect(media.publish).toHaveBeenCalledWith("local", expect.any(Uint8Array), expect.any(String));
    expect(media.publish).not.toHaveBeenCalledWith("globex", expect.anything(), expect.anything());
  });

  test("refuses with 422 and writes nothing when publishClip is false but the bundle still has placeholders", async () => {
    await seedCampaign(harness.db);
    await seedReport(harness.db);
    await seedRenders();

    const res = await call({ campaignId: SLUG, platforms: [PLATFORM] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(`Platform "${PLATFORM}":`);
    expect(body.error).toContain("publishClip");
    expect(media.publish).not.toHaveBeenCalled();
    expect(await store.list(`org/local/campaign/${CAMPAIGN}/packages/`)).toEqual([]);
  });

  test("refuses with 422 and writes nothing when the publisher fails, answering the platform-wrapped message", async () => {
    await seedCampaign(harness.db);
    await seedReport(harness.db);
    // The bundle and fallback exist but the clip the placeholder names does not:
    // the publisher's use case throws, packaging refuses, nothing is written.
    const prefix = renderPrefix("local", CAMPAIGN);
    await store.put(`${prefix}alpha/1x1/index.html`, new TextEncoder().encode(BUNDLE_HTML), {
      contentType: "text/html",
    });
    await store.put(`${prefix}alpha/1x1/fallback.png`, PNG, { contentType: "image/png" });

    const res = await call({ campaignId: SLUG, platforms: [PLATFORM], publishClip: true });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(`Platform "${PLATFORM}":`);
    expect(await store.list(`org/local/campaign/${CAMPAIGN}/packages/`)).toEqual([]);
  });

  test("packages a placeholder-free bundle with publishClip true, publishing nothing", async () => {
    await seedCampaign(harness.db);
    await seedReport(harness.db, [
      {
        productId: "alpha",
        size: SIZE,
        outputPath: `${SLUG}/alpha/1x1/fallback.png`,
        treatment: "image-html",
        format: "html",
        htmlBundlePath: `${SLUG}/alpha/1x1/index.html`,
        htmlFallbackPath: `${SLUG}/alpha/1x1/fallback.png`,
      },
    ]);
    const prefix = renderPrefix("local", CAMPAIGN);
    await store.put(`${prefix}alpha/1x1/index.html`, new TextEncoder().encode(PLAIN_HTML), {
      contentType: "text/html",
    });
    await store.put(`${prefix}alpha/1x1/fallback.png`, PNG, { contentType: "image/png" });

    const res = await call({ campaignId: SLUG, platforms: [PLATFORM], publishClip: true });
    expect(res.status).toBe(200);
    expect(media.publish).not.toHaveBeenCalled();
    expect(await packagedIndexHtml()).toBe(PLAIN_HTML);
  });

  test("generate, plan and preview-frame never publish a clip", async () => {
    // Every body here is refused at parse time — the point is that no export
    // route reaches the publisher, whatever the answer code ends up being. The
    // second generate call carries `regenerateOnly` (the re-roll path).
    const requests: Array<[Promise<Response>]> = [];
    const post = (caller: ReturnType<typeof mountTenantRoute>, body: unknown): Promise<Response> =>
      caller(
        new Request("http://x/campaigns/x", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    requests.push([post(mountTenantRoute(generateHandler, { method: "POST", tenant: LOCAL }), {})]);
    requests.push([
      post(mountTenantRoute(generateHandler, { method: "POST", tenant: LOCAL }), {
        regenerateOnly: true,
      }),
    ]);
    requests.push([post(mountTenantRoute(planHandler, { method: "POST", tenant: LOCAL }), {})]);
    requests.push([
      post(mountTenantRoute(previewFrameHandler, { method: "POST", tenant: LOCAL }), {}),
    ]);
    for (const [pending] of requests) {
      const res = await pending;
      expect([400, 404, 422, 503]).toContain(res.status);
    }
    expect(media.publish).not.toHaveBeenCalled();
  });
});
