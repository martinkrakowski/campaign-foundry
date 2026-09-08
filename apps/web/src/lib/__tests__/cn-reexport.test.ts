import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "../cn.ts"), "utf-8");

describe("apps/web/src/lib/cn.ts is a re-export only", () => {
  test("does not contain twMerge or clsx(", () => {
    expect(source).not.toMatch(/twMerge/);
    expect(source).not.toMatch(/clsx\(/);
  });

  test("re-exports cn from the package that owns it", () => {
    expect(source).toMatch(/export\s*\{\s*cn\s*\}\s*from\s*["']@campaignfoundry\/ui["']/);
  });
});
