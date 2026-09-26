import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  getAuthCapabilities,
  getCapabilities,
  resolveFfmpegBinary,
  setCapabilities,
  waitForCapabilities,
} from "../capabilities.js";

describe("capabilities", () => {
  beforeEach(() => {
    setCapabilities({ motion: false, reason: "not probed" });
  });

  test("defaults to motion off until a probe records an outcome", () => {
    expect(getCapabilities()).toEqual({ motion: false, reason: "not probed" });
  });

  test("setCapabilities replaces the stored snapshot", () => {
    setCapabilities({ motion: true });
    expect(getCapabilities()).toEqual({ motion: true });
    setCapabilities({ motion: false, reason: "missing binary" });
    expect(getCapabilities()).toEqual({ motion: false, reason: "missing binary" });
  });
});

describe("waitForCapabilities", () => {
  beforeEach(() => {
    setCapabilities({ motion: false, reason: "not probed" });
  });

  test("returns the settled snapshot without waiting", async () => {
    setCapabilities({ motion: true });
    await expect(waitForCapabilities()).resolves.toEqual({ motion: true });
  });

  test("waits out a pending probe and returns the landed result", async () => {
    const pending = waitForCapabilities();
    setCapabilities({ motion: true });
    await expect(pending).resolves.toEqual({ motion: true });
  });

  test("returns the still-pending snapshot when the deadline expires first", async () => {
    await expect(waitForCapabilities({ timeoutMs: 0 })).resolves.toEqual({
      motion: false,
      reason: "not probed",
    });
  });

  test("a reset to 'not probed' re-arms the wait for a fresh boot window", async () => {
    setCapabilities({ motion: true });
    setCapabilities({ motion: false, reason: "not probed" });
    const pending = waitForCapabilities();
    setCapabilities({ motion: false, reason: "ffmpeg-static binary is not available" });
    await expect(pending).resolves.toEqual({
      motion: false,
      reason: "ffmpeg-static binary is not available",
    });
  });
});

describe("resolveFfmpegBinary", () => {
  test("returns the ffmpeg-static path when the binary is executable", () => {
    const seen: string[] = [];
    expect(resolveFfmpegBinary("/opt/ffmpeg", (p) => seen.push(p))).toEqual({
      path: "/opt/ffmpeg",
    });
    expect(seen).toEqual(["/opt/ffmpeg"]);
  });

  test.each([null, ""])("degrades to a reason when ffmpeg-static exports %j", (candidate) => {
    expect(resolveFfmpegBinary(candidate)).toEqual({
      path: null,
      reason: "ffmpeg-static binary is not available",
    });
  });

  test("degrades to a redacted reason when the binary cannot be accessed", () => {
    const out = resolveFfmpegBinary("/opt/ffmpeg", () => {
      throw new Error("EACCES: permission denied, access '/opt/ffmpeg'");
    });
    expect(out.path).toBeNull();
    expect(out.reason).toMatch(/^ffmpeg-static binary is not available: EACCES/);
    expect(out.reason).not.toContain("/opt/ffmpeg");
  });

  test("stringifies a non-Error thrown by the check", () => {
    expect(
      resolveFfmpegBinary("/opt/ffmpeg", () => {
        throw "boom";
      }),
    ).toEqual({ path: null, reason: "ffmpeg-static binary is not available: boom" });
  });

  test("defaults to the real ffmpeg-static export and the executable check", () => {
    const out = resolveFfmpegBinary();
    if (out.path === null) expect(out.reason).toMatch(/^ffmpeg-static binary is not available/);
    else expect(out.path).toMatch(/ffmpeg/);
  });
});

describe("getAuthCapabilities", () => {
  const ENV_KEYS = ["AUTH_MODE", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("defaults to local mode with Google off", () => {
    expect(getAuthCapabilities()).toEqual({ mode: "local", google: false });
  });

  test("reflects better-auth mode", () => {
    process.env.AUTH_MODE = "better-auth";
    expect(getAuthCapabilities()).toEqual({ mode: "better-auth", google: false });
  });

  test("google is true only when both google client id and secret are set", () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    expect(getAuthCapabilities()).toEqual({ mode: "local", google: true });
  });

  test("google is false when only client id is set", () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    expect(getAuthCapabilities()).toEqual({ mode: "local", google: false });
  });

  test("google is false when only client secret is set", () => {
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    expect(getAuthCapabilities()).toEqual({ mode: "local", google: false });
  });
});
