import { describe, test, expect, afterEach } from "vitest";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import { setCapabilities } from "../../../lib/capabilities.js";

const mount = (handler: EventHandler) => {
  const app = createApp();
  const router = createRouter();
  router.get("/campaigns/capabilities", handler);
  app.use(router);
  return toWebHandler(app);
};

const handlerFor = async () => {
  return (await import("../capabilities.get.js")).default;
};

describe("GET /campaigns/capabilities", () => {
  afterEach(() => {
    setCapabilities({ motion: false, reason: "not probed" });
  });

  test("returns motion: true when capability is on", async () => {
    setCapabilities({ motion: true });
    const handler = await handlerFor();
    const res = await mount(handler)(new Request("http://localhost/campaigns/capabilities"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ motion: true });
  });

  test("returns motion: false with reason when capability is off", async () => {
    setCapabilities({ motion: false, reason: "ffmpeg-static binary is not available" });
    const handler = await handlerFor();
    const res = await mount(handler)(new Request("http://localhost/campaigns/capabilities"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ motion: false, reason: "ffmpeg-static binary is not available" });
  });
});
