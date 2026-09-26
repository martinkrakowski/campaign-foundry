import { describe, test, expect, afterEach, beforeEach } from "vitest";
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

const ENV_KEYS = ["AUTH_MODE", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;

describe("GET /campaigns/capabilities", () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    setCapabilities({ motion: false, reason: "not probed" });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("returns motion: true when capability is on, with default local auth", async () => {
    setCapabilities({ motion: true });
    const handler = await handlerFor();
    const res = await mount(handler)(new Request("http://localhost/campaigns/capabilities"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      motion: true,
      auth: { mode: "local", google: false },
    });
  });

  test("returns motion: false with reason when capability is off", async () => {
    setCapabilities({ motion: false, reason: "ffmpeg-static binary is not available" });
    const handler = await handlerFor();
    const res = await mount(handler)(new Request("http://localhost/campaigns/capabilities"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      motion: false,
      reason: "ffmpeg-static binary is not available",
      auth: { mode: "local", google: false },
    });
  });

  describe("auth capabilities under each mode and with Google on and off", () => {
    test("mode local with Google off", async () => {
      process.env.AUTH_MODE = "local";
      const handler = await handlerFor();
      const res = await mount(handler)(new Request("http://localhost/campaigns/capabilities"));
      expect(res.status).toBe(200);
      expect((await res.json()).auth).toEqual({ mode: "local", google: false });
    });

    test("mode local with Google on when both settings are present", async () => {
      process.env.AUTH_MODE = "local";
      process.env.GOOGLE_CLIENT_ID = "google-id";
      process.env.GOOGLE_CLIENT_SECRET = "google-secret";
      const handler = await handlerFor();
      const res = await mount(handler)(new Request("http://localhost/campaigns/capabilities"));
      expect(res.status).toBe(200);
      expect((await res.json()).auth).toEqual({ mode: "local", google: true });
    });

    test("mode better-auth with Google off", async () => {
      process.env.AUTH_MODE = "better-auth";
      const handler = await handlerFor();
      const res = await mount(handler)(new Request("http://localhost/campaigns/capabilities"));
      expect(res.status).toBe(200);
      expect((await res.json()).auth).toEqual({ mode: "better-auth", google: false });
    });

    test("mode better-auth with Google on when both settings are present", async () => {
      process.env.AUTH_MODE = "better-auth";
      process.env.GOOGLE_CLIENT_ID = "google-id";
      process.env.GOOGLE_CLIENT_SECRET = "google-secret";
      const handler = await handlerFor();
      const res = await mount(handler)(new Request("http://localhost/campaigns/capabilities"));
      expect(res.status).toBe(200);
      expect((await res.json()).auth).toEqual({ mode: "better-auth", google: true });
    });

    test("google is false when only GOOGLE_CLIENT_ID is set", async () => {
      process.env.GOOGLE_CLIENT_ID = "google-id";
      const handler = await handlerFor();
      const res = await mount(handler)(new Request("http://localhost/campaigns/capabilities"));
      expect(res.status).toBe(200);
      expect((await res.json()).auth).toEqual({ mode: "local", google: false });
    });

    test("google is false when only GOOGLE_CLIENT_SECRET is set", async () => {
      process.env.GOOGLE_CLIENT_SECRET = "google-secret";
      const handler = await handlerFor();
      const res = await mount(handler)(new Request("http://localhost/campaigns/capabilities"));
      expect(res.status).toBe(200);
      expect((await res.json()).auth).toEqual({ mode: "local", google: false });
    });
  });
});
