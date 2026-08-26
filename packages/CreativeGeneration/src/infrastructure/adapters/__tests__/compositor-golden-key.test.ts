import { describe, test, expect } from "vitest";
import {
  compositorGoldenKey,
  missingGoldenMapMessage,
  resolveGoldenMap,
} from "./compositor-golden-key.js";

describe("compositorGoldenKey", () => {
  test("joins platform and arch", () => {
    expect(compositorGoldenKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(compositorGoldenKey("linux", "x64")).toBe("linux-x64");
  });

  test("defaults to process.platform and process.arch", () => {
    expect(compositorGoldenKey()).toBe(`${process.platform}-${process.arch}`);
  });
});

describe("resolveGoldenMap", () => {
  const map = { "headline-bottom/bold/1:1": "abc" };

  test("returns the map when the key is present and non-empty", () => {
    expect(resolveGoldenMap({ "darwin-arm64": map }, "darwin-arm64")).toEqual(map);
  });

  test("returns undefined when the key is missing", () => {
    expect(resolveGoldenMap({ "darwin-arm64": map }, "linux-x64")).toBeUndefined();
  });

  test("returns undefined when the map is empty (do not hard-fail)", () => {
    expect(resolveGoldenMap({ "win32-x64": {} }, "win32-x64")).toBeUndefined();
  });
});

describe("missingGoldenMapMessage", () => {
  test("names the missing key and how to record it", () => {
    const message = missingGoldenMapMessage("win32-x64", ["darwin-arm64", "linux-x64"]);
    expect(message).toContain('"win32-x64"');
    expect(message).toContain("darwin-arm64, linux-x64");
    expect(message).toContain('fixtures/compositor-goldens.json["win32-x64"]');
  });

  test("says none when no maps are recorded", () => {
    expect(missingGoldenMapMessage("linux-arm64", [])).toContain("recorded: none");
  });
});
