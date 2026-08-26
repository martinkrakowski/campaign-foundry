import { describe, test, expect } from "vitest";
import { resolve } from "node:path";
import { resolveSafe } from "../safe-path.js";

const root = resolve("/tmp/cf-output");

describe("resolveSafe", () => {
  test("resolves a nested path inside the root", () => {
    expect(resolveSafe(root, "alpha/1x1.png", "write")).toBe(resolve(root, "alpha/1x1.png"));
  });

  test("allows a path that resolves to the root itself", () => {
    expect(resolveSafe(root, ".", "read")).toBe(root);
    expect(resolveSafe(root, "", "write")).toBe(root);
  });

  test("refuses a path that escapes the root, naming the action", () => {
    expect(() => resolveSafe(root, "../escape.png", "read")).toThrow(
      /Refusing to read outside the output root: \.\.\/escape\.png/,
    );
    expect(() => resolveSafe(root, "../../escape.png", "write")).toThrow(
      /Refusing to write outside the output root/,
    );
  });
});
