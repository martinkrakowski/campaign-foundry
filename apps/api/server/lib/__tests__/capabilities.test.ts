import { describe, test, expect, beforeEach } from "vitest";
import { getCapabilities, resolveFfmpegBinary, setCapabilities } from "../capabilities.js";

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

describe("resolveFfmpegBinary", () => {
  test("returns the ffmpeg-static path when the binary is executable", () => {
    const seen: string[] = [];
    expect(resolveFfmpegBinary("/opt/ffmpeg", (p) => seen.push(p))).toEqual({ path: "/opt/ffmpeg" });
    expect(seen).toEqual(["/opt/ffmpeg"]);
  });

  test.each([null, ""])("degrades to a reason when ffmpeg-static exports %j", (candidate) => {
    expect(resolveFfmpegBinary(candidate)).toEqual({ path: null, reason: "ffmpeg-static binary is not available" });
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
    expect(resolveFfmpegBinary("/opt/ffmpeg", () => {
      throw "boom";
    })).toEqual({ path: null, reason: "ffmpeg-static binary is not available: boom" });
  });

  test("defaults to the real ffmpeg-static export and the executable check", () => {
    const out = resolveFfmpegBinary();
    if (out.path === null) expect(out.reason).toMatch(/^ffmpeg-static binary is not available/);
    else expect(out.path).toMatch(/ffmpeg/);
  });
});
