import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import { MAX_ASSET_BYTES } from "../../../lib/asset-files.js";

const web = async (root: string) => {
  vi.resetModules();
  process.env.PROJECT_ROOT = root;
  const handler = (await import("../assets.post.js")).default as EventHandler;
  const app = createApp();
  const router = createRouter();
  router.post("/campaigns/assets", handler);
  app.use(router);
  return toWebHandler(app);
};

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]);

const post = (handler: (req: Request) => Promise<Response>, body: unknown) =>
  handler(
    new Request("http://x/campaigns/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const upload = (over: Record<string, unknown> = {}) => ({
  briefId: "camp",
  name: "logo.png",
  contentBase64: png.toString("base64"),
  ...over,
});

describe("POST /campaigns/assets", () => {
  let dir: string;
  const origRoot = process.env.PROJECT_ROOT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-assets-"));
    mkdirSync(join(dir, "assets", "inputs"), { recursive: true });
    writeFileSync(join(dir, "assets", "inputs", "hydra-logo.png"), "DEMO-LOGO");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    vi.restoreAllMocks();
  });

  test("stores a PNG under assets/inputs/<briefId>/ and returns the repo-relative path", async () => {
    const res = await post(await web(dir), upload());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ path: "assets/inputs/camp/logo.png" });
    expect(readFileSync(join(dir, "assets", "inputs", "camp", "logo.png"))).toEqual(png);
    expect(readFileSync(join(dir, "assets", "inputs", "hydra-logo.png"), "utf8")).toBe("DEMO-LOGO");
  });

  test("stores a JPEG named .jpg", async () => {
    const res = await post(
      await web(dir),
      upload({ name: "photo.jpg", contentBase64: jpeg.toString("base64") }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ path: "assets/inputs/camp/photo.jpg" });
  });

  test("returns 409 when the asset already exists", async () => {
    const handler = await web(dir);
    expect((await post(handler, upload())).status).toBe(201);
    const dest = join(dir, "assets", "inputs", "camp", "logo.png");
    const original = readFileSync(dest);
    const again = await post(handler, upload());
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: 'Asset "assets/inputs/camp/logo.png" already exists.',
    });
    expect(readFileSync(dest)).toEqual(original);
  });

  test("returns 400 for invalid image magic", async () => {
    const res = await post(
      await web(dir),
      upload({ contentBase64: Buffer.from("hello").toString("base64") }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Asset must be a PNG or JPEG image." });
    expect(existsSync(join(dir, "assets", "inputs", "camp", "logo.png"))).toBe(false);
  });

  test("returns 400 for bad base64", async () => {
    const res = await post(await web(dir), upload({ contentBase64: "not-base64!!" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "contentBase64 must be standard base64." });
    expect(existsSync(join(dir, "assets", "inputs", "camp", "logo.png"))).toBe(false);
  });

  test("returns 413 before decode when the base64 string is over the encoded cap", async () => {
    const tooLong = "!".repeat(Math.ceil(MAX_ASSET_BYTES / 3) * 4 + 1);
    const res = await post(await web(dir), upload({ contentBase64: tooLong }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Asset exceeds the 2 MiB size limit." });
    expect(existsSync(join(dir, "assets", "inputs", "camp", "logo.png"))).toBe(false);
  });

  test("returns 413 when the decoded payload exceeds 2 MiB", async () => {
    const oversized = Buffer.alloc(MAX_ASSET_BYTES + 1, 0xff);
    oversized[0] = 0xff;
    oversized[1] = 0xd8;
    oversized[2] = 0xff;
    const res = await post(await web(dir), upload({ contentBase64: oversized.toString("base64") }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Asset exceeds the 2 MiB size limit." });
    expect(existsSync(join(dir, "assets", "inputs", "camp", "logo.png"))).toBe(false);
  });

  test("accepts an asset at the 2 MiB cap", async () => {
    const maxed = Buffer.alloc(MAX_ASSET_BYTES, 0);
    maxed[0] = 0xff;
    maxed[1] = 0xd8;
    maxed[2] = 0xff;
    const res = await post(
      await web(dir),
      upload({ name: "big.jpg", contentBase64: maxed.toString("base64") }),
    );
    expect(res.status).toBe(201);
  });

  test.each([
    ["a traversing name", { name: "../hydra-logo.png" }],
    ["a nested name", { name: "foo/bar.png" }],
    ["an absolute name", { name: "/tmp/x.png" }],
    ["an uppercase extension", { name: "logo.PNG" }],
    ["an unsafe briefId", { briefId: "../inputs" }],
    ["a non-string briefId", { briefId: 1 }],
    ["a non-string name", { name: 1 }],
    ["a non-string contentBase64", { contentBase64: 1 }],
    ["a non-object body", 42],
    ["null", null],
  ])("rejects %s with 400 and does not touch demo logos", async (_label, over) => {
    const body = typeof over === "object" && over !== null ? upload(over) : over;
    const res = await post(await web(dir), body);
    expect(res.status).toBe(400);
    expect(readFileSync(join(dir, "assets", "inputs", "hydra-logo.png"), "utf8")).toBe("DEMO-LOGO");
    expect(existsSync(join(dir, "assets", "inputs", "hydra-logo.png"))).toBe(true);
    expect(existsSync(join(dir, "assets", "inputs", "camp", "logo.png"))).toBe(false);
  });

  test("a valid hydra-logo.png name writes beside the demo logo, not over it", async () => {
    const res = await post(await web(dir), upload({ name: "hydra-logo.png" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ path: "assets/inputs/camp/hydra-logo.png" });
    expect(readFileSync(join(dir, "assets", "inputs", "hydra-logo.png"), "utf8")).toBe("DEMO-LOGO");
    expect(readFileSync(join(dir, "assets", "inputs", "camp", "hydra-logo.png"))).toEqual(png);
  });

  test("surfaces an unexpected write error", async () => {
    const handler = await web(dir);
    const { getAssetStore } = await import("../../../lib/ports/index.js");
    const spy = vi
      .spyOn(getAssetStore(), "writeAsset")
      .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
    const res = await post(handler, upload());
    expect(res.status).toBe(500);
    expect(existsSync(join(dir, "assets", "inputs", "camp", "logo.png"))).toBe(false);
    spy.mockRestore();
  });

  test("returns 400 with a default message when body parsing throws a non-Error", async () => {
    const handler = await web(dir);
    const g = globalThis as Record<string, unknown>;
    const original = g.readBody;
    g.readBody = async () => {
      throw "non-error parse failure";
    };
    try {
      const res = await post(handler, upload());
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "non-error parse failure" });
      expect(existsSync(join(dir, "assets", "inputs", "camp", "logo.png"))).toBe(false);
    } finally {
      g.readBody = original;
    }
  });
});
