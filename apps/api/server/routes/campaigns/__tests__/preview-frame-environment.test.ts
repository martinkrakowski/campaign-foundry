import { describe, test, expect, vi } from "vitest";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import route from "../preview-frame.post.js";

vi.mock("../../../lib/run-environment.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/run-environment.js")>();
  return {
    ...actual,
    runEnvironment: () => {
      throw new Error("EACCES: .env.local is unreadable");
    },
  };
});

/** Review on #576 (Qodo): an unreadable environment is a controlled 500, as in generate. */
describe("POST /campaigns/preview-frame — an unreadable run environment", () => {
  test("answers a controlled 500 rather than a framework error", async () => {
    const app = createApp();
    const router = createRouter();
    router.post("/campaigns/preview-frame", route as EventHandler);
    app.use(router);
    const res = await toWebHandler(app)(
      new Request("http://x/campaigns/preview-frame", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brief: {
            id: "camp",
            targetRegion: "DE",
            targetAudience: "a",
            campaignMessage: "Hi",
            products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "x.png" }],
          },
          cell: {
            productId: "alpha",
            canvas: { ratio: "1:1" },
            layout: "headline-top",
            tone: "bold",
          },
        }),
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not read the run environment." });
  });
});
