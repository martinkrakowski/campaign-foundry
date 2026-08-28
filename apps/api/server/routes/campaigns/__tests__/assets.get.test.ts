import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";

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

describe("GET /campaigns/assets", () => {
  let dir: string;
  const origRoot = process.env.PROJECT_ROOT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-assets-get-"));
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

  test("returns listed assets sorted by name with type, size, and fetchable thumbnail URL", async () => {
    const briefDir = join(dir, "assets", "inputs", "camp");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(briefDir, "logo-b.png"), png);
    writeFileSync(join(briefDir, "photo-a.jpg"), jpeg);
    writeFileSync(join(briefDir, "ignore.txt"), "text");

    const handler = await web(dir);
    const res = await get(handler, "?briefId=camp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assets: Array<{ name: string; type: string; size: number; thumbnailUrl: string }> };

    expect(body.assets).toHaveLength(2);
    expect(body.assets[0].name).toBe("logo-b.png");
    expect(body.assets[0].type).toBe("image/png");
    expect(body.assets[0].size).toBe(png.length);
    expect(body.assets[0].thumbnailUrl).toBe("/api/pipeline/campaigns/assets?briefId=camp&name=logo-b.png");

    expect(body.assets[1].name).toBe("photo-a.jpg");
    expect(body.assets[1].type).toBe("image/jpeg");
    expect(body.assets[1].size).toBe(jpeg.length);
    expect(body.assets[1].thumbnailUrl).toBe("/api/pipeline/campaigns/assets?briefId=camp&name=photo-a.jpg");
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

  test("returns empty list on store list failure", async () => {
    const handler = await web(dir);
    const { getAssetStore } = await import("../../../lib/ports/index.js");
    const spy = vi.spyOn(getAssetStore(), "listAssets").mockRejectedValueOnce(new Error("Disk error"));

    const res = await get(handler, "?briefId=camp");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assets: [] });
    spy.mockRestore();
  });
});
