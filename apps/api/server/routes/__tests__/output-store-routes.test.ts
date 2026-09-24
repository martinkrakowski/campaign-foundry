import { describe, test, expect, afterEach } from "vitest";
import { Readable } from "node:stream";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import { resetOutputStore, setOutputStore, type OutputStorePort } from "../../lib/ports/index.js";
import outputHandler from "../output/[...path].get.js";
import listHandler from "../campaigns/packages/[campaignId].get.js";
import zipHandler from "../campaigns/packages/[campaignId]/[platformZip].get.js";

const web = (path: string, handler: EventHandler) => {
  const app = createApp();
  const router = createRouter();
  router.get(path, handler);
  app.use(router);
  return toWebHandler(app);
};

/**
 * PT-0a: the output and package routes read only through the output store. An
 * in-memory store stands in for the output tree; nothing exists on disk, so any
 * route still walking the tree itself would answer 404.
 */
describe("output and package routes read through the output store (PT-0a)", () => {
  const bytes = Buffer.from("0123456789");
  const closed: string[] = [];
  const store: OutputStorePort = {
    async openOutput(path) {
      if (path === "bad") return { found: false, reason: "invalid" };
      if (path !== "camp/alpha/1x1.png") return { found: false, reason: "missing" };
      return {
        found: true,
        file: {
          name: "1x1.png",
          size: bytes.length,
          stream: (range) =>
            Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]),
          close: async () => {
            closed.push(path);
          },
        },
      };
    },
    async listPackageManifests(campaignId) {
      return campaignId === "camp" ? [{ platformId: "instagram-feed", items: [] }] : [];
    },
    async listPackageFiles(campaignId, platformId) {
      if (campaignId !== "camp" || platformId !== "instagram-feed") return undefined;
      return [{ name: "manifest.json", open: () => Readable.from([Buffer.from("{}")]) }];
    },
  };

  afterEach(() => {
    resetOutputStore();
    closed.length = 0;
  });

  test("a file is served from the store, whole and by range, and a refused range releases it", async () => {
    setOutputStore(store);
    const get = web("/output/**:path", outputHandler);
    const whole = await get(new Request("http://x/output/camp/alpha/1x1.png"));
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await whole.arrayBuffer()).toString()).toBe("0123456789");

    const part = await get(
      new Request("http://x/output/camp/alpha/1x1.png", { headers: { range: "bytes=2-4" } }),
    );
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe("234");

    const refused = await get(
      new Request("http://x/output/camp/alpha/1x1.png", { headers: { range: "bytes=99-" } }),
    );
    expect(refused.status).toBe(416);
    expect(closed).toEqual(["camp/alpha/1x1.png"]);

    expect((await get(new Request("http://x/output/bad"))).status).toBe(400);
    expect((await get(new Request("http://x/output/nope.png"))).status).toBe(404);
  });

  test("the package listing and zip come from the store", async () => {
    setOutputStore(store);
    const list = await web(
      "/campaigns/packages/:campaignId",
      listHandler,
    )(new Request("http://x/campaigns/packages/camp"));
    expect(await list.json()).toEqual({ platforms: [{ platformId: "instagram-feed", items: [] }] });

    const zip = await web(
      "/campaigns/packages/:campaignId/:platformZip",
      zipHandler,
    )(new Request("http://x/campaigns/packages/camp/instagram-feed.zip"));
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    const body = Buffer.from(await zip.arrayBuffer());
    expect(body.includes(Buffer.from("manifest.json"))).toBe(true);

    const none = await web(
      "/campaigns/packages/:campaignId/:platformZip",
      zipHandler,
    )(new Request("http://x/campaigns/packages/camp/linkedin.zip"));
    expect(none.status).toBe(404);
  });
});
