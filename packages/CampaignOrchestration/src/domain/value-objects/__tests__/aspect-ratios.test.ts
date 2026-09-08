import { describe, test, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { AspectRatio } from "../AspectRatio.vo.js";
import { RATIO_VALUES, resolveCanvas } from "../aspect-ratios.js";

describe("resolveCanvas (D113)", () => {
  test("a social ratio resolves to the 1080/1920 canvas", () => {
    expect(resolveCanvas({ ratio: "16:9" })).toEqual({ width: 1920, height: 1080 });
    expect(resolveCanvas({ ratio: "1:1" })).toEqual({ width: 1080, height: 1080 });
    expect(resolveCanvas({ ratio: "9:16" })).toEqual({ width: 1080, height: 1920 });
  });

  test("a display size resolves to its exact pixels, never scaled", () => {
    expect(resolveCanvas({ size: "728x90" })).toEqual({ width: 728, height: 90 });
  });

  test("AspectRatio.create reads width/height through resolveCanvas", () => {
    const created = AspectRatio.create("1:1");
    expect(created.success).toBe(true);
    if (created.success) {
      expect(created.value.width).toBe(resolveCanvas({ ratio: "1:1" }).width);
      expect(created.value.height).toBe(resolveCanvas({ ratio: "1:1" }).height);
    }
    for (const ratio of RATIO_VALUES) {
      const r = AspectRatio.create(ratio);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.value.width).toBe(resolveCanvas({ ratio }).width);
        expect(r.value.height).toBe(resolveCanvas({ ratio }).height);
      }
    }
  });
});

// The readers under apps/web (ReviewStep, CreativePreview, PolicySection,
// LayoutSection) still index RATIO_DIMENSIONS directly. They are out of scope
// until A4; this scan is packages/*/src only so those files cannot fail it.
// Tests and aspect-ratios.ts (the resolver itself) are the only exclusions —
// widening the exclusion to all files would make the assertion unable to fail.
const DIRECT_DIMENSION_READ = /RATIO_DIMENSIONS\[|DISPLAY_SIZES\[/;

const packagesRoot = resolve(import.meta.dirname, "../../../../../../packages");

function listPackageSources(dir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      names.push(...listPackageSources(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      names.push(full);
    }
  }
  return names;
}

describe("the resolver is the only reader of pixel dimensions", () => {
  test("no package source indexes RATIO_DIMENSIONS[ or DISPLAY_SIZES[ outside the resolver", () => {
    const hits: string[] = [];
    for (const pkg of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = join(packagesRoot, pkg.name, "src");
      if (!existsSync(src)) continue;
      for (const file of listPackageSources(src)) {
        if (file.endsWith("aspect-ratios.ts")) continue;
        const source = readFileSync(file, "utf8");
        if (DIRECT_DIMENSION_READ.test(source)) hits.push(relative(packagesRoot, file));
      }
    }
    expect(hits, hits.length ? `direct dimension reads in ${hits.join(", ")}` : "").toEqual([]);
  });
});
