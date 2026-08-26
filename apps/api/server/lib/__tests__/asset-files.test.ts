import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSET_NAME_PATTERN,
  decodeBase64,
  hasAllowedImageMagic,
  assetRelPath,
} from "../asset-files.js";

const origRoot = process.env.PROJECT_ROOT;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

describe("ASSET_NAME_PATTERN", () => {
  test("accepts a SAFE_ID_PATTERN stem with a png/jpg/jpeg extension", () => {
    for (const name of ["a.png", "logo.jpg", "hydra-logo.jpeg", `${"a".repeat(64)}.png`]) {
      expect(ASSET_NAME_PATTERN.test(name), name).toBe(true);
    }
  });

  test("rejects names that would escape or are not a basename image", () => {
    for (const name of [
      "../hydra-logo.png",
      "foo/bar.png",
      "/tmp/x.png",
      "hydra-logo.PNG",
      "a.gif",
      "",
      "a".repeat(65) + ".png",
    ]) {
      expect(ASSET_NAME_PATTERN.test(name), name).toBe(false);
    }
  });
});

describe("decodeBase64", () => {
  test("decodes standard base64", () => {
    expect(decodeBase64(png.toString("base64"))).toEqual(png);
  });

  test.each([
    ["a non-string", 1],
    ["an empty string", ""],
    ["a length not divisible by 4", "abc"],
    ["an invalid alphabet", "@@@@"],
    ["a url-safe alphabet", "aa-a"],
  ])("rejects %s", (_label, value) => {
    expect(decodeBase64(value)).toBeUndefined();
  });
});

describe("hasAllowedImageMagic", () => {
  test("accepts PNG and JPEG magic", () => {
    expect(hasAllowedImageMagic(png)).toBe(true);
    expect(hasAllowedImageMagic(jpeg)).toBe(true);
  });

  test("rejects too-short or non-image buffers", () => {
    expect(hasAllowedImageMagic(Buffer.from([0xff, 0xd8]))).toBe(false);
    expect(hasAllowedImageMagic(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toBe(false);
    expect(hasAllowedImageMagic(Buffer.from([0x89, 0x50, 0x4e]))).toBe(false);
  });
});

describe("asset paths", () => {
  let dir: string;

  const filesFor = async (root: string) => {
    vi.resetModules();
    process.env.PROJECT_ROOT = root;
    return import("../asset-files.js");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-asset-files-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
  });

  test("assetRelPath is the repo-relative logoPath a brief can store", () => {
    expect(assetRelPath("camp", "logo.png")).toBe("assets/inputs/camp/logo.png");
  });

  test("assetAbsPath writes under assets/inputs/<briefId>/ and rejects escape", async () => {
    const { assetAbsPath, writeAssetFile } = await filesFor(dir);
    const dest = assetAbsPath("camp", "logo.png");
    expect(dest).toBe(join(dir, "assets", "inputs", "camp", "logo.png"));
    await writeAssetFile(dest, png);
    expect(readFileSync(dest)).toEqual(png);
    expect(() => assetAbsPath("camp", "../hydra-logo.png")).toThrow(
      /Path escapes the allowed directory/,
    );
  });
});
