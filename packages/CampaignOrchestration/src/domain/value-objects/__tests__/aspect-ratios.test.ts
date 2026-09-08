import { describe, test, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { AspectRatio } from "../AspectRatio.vo.js";
import {
  RATIO_VALUES,
  nearestSocialRatio,
  resolveCanvas,
  scaleBasis,
  scaleBasisPx,
  widthTermBasis,
  type CanvasSpec,
} from "../aspect-ratios.js";
import { DISPLAY_SIZE_VALUES } from "../display-sizes.js";

describe("resolveCanvas (D113)", () => {
  test("a social ratio resolves to the 1080/1920 canvas", () => {
    expect(resolveCanvas({ ratio: "16:9" })).toEqual({ width: 1920, height: 1080 });
    expect(resolveCanvas({ ratio: "1:1" })).toEqual({ width: 1080, height: 1080 });
    expect(resolveCanvas({ ratio: "9:16" })).toEqual({ width: 1080, height: 1920 });
  });

  test("a display size resolves to its exact pixels, never scaled", () => {
    expect(resolveCanvas({ size: "728x90" })).toEqual({ width: 728, height: 90 });
  });

  test("resolveCanvas throws when both keys are present", () => {
    expect(() => resolveCanvas({ ratio: "1:1", size: "300x250" } as unknown as CanvasSpec)).toThrow(
      "CanvasSpec must carry exactly one of ratio/size",
    );
  });

  test("CanvasSpec is exclusive at the type level", () => {
    // @ts-expect-error a spec cannot carry both ratio and size
    const both: CanvasSpec = { ratio: "1:1", size: "300x250" };
    expect(both).toEqual({ ratio: "1:1", size: "300x250" });
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

describe("scaleBasis (D114)", () => {
  test("the ratio family is width, so 16:9 stays D55", () => {
    expect(scaleBasis({ ratio: "16:9" }, 1920, 1080)).toBe(1920);
    expect(scaleBasis({ ratio: "1:1" }, 1080, 1080)).toBe(1080);
    expect(scaleBasis({ ratio: "9:16" }, 1080, 1920)).toBe(1080);
  });

  test("the size family is the short side", () => {
    expect(scaleBasis({ size: "728x90" }, 728, 90)).toBe(90);
    expect(scaleBasis({ size: "160x600" }, 160, 600)).toBe(160);
  });
});

describe("scaleBasisPx — the editor readout", () => {
  test("a social layout is sizeScale × width", () => {
    expect(scaleBasisPx({ ratio: "16:9" }, 0.08)).toBe(154);
    expect(scaleBasisPx({ ratio: "1:1" }, 0.08)).toBe(86);
  });

  test("a 728x90 layout is sizeScale × 90 — the same number the compositor uses", () => {
    expect(scaleBasisPx({ size: "728x90" }, 0.08)).toBe(7);
    expect(widthTermBasis({ size: "728x90" }, 728, 90)).toBe(728);
  });
});

// Tests and aspect-ratios.ts (the resolver itself) are the only exclusions —
// widening the exclusion to all files would make the assertion unable to fail.
const DIRECT_DIMENSION_READ = /RATIO_DIMENSIONS\[|DISPLAY_SIZES\[/;

const packagesRoot = resolve(import.meta.dirname, "../../../../../../packages");
const webSrc = resolve(import.meta.dirname, "../../../../../../apps/web/src");
const repoRoot = resolve(import.meta.dirname, "../../../../../../");

function listSources(dir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      names.push(...listSources(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      names.push(full);
    }
  }
  return names;
}

describe("the resolver is the only reader of pixel dimensions", () => {
  test("no package or apps/web/src source indexes RATIO_DIMENSIONS[ or DISPLAY_SIZES[ outside the resolver", () => {
    const hits: string[] = [];
    for (const pkg of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = join(packagesRoot, pkg.name, "src");
      if (!existsSync(src)) continue;
      for (const file of listSources(src)) {
        if (file.endsWith("/aspect-ratios.ts")) continue;
        const source = readFileSync(file, "utf8");
        if (DIRECT_DIMENSION_READ.test(source)) hits.push(relative(repoRoot, file));
      }
    }
    for (const file of listSources(webSrc)) {
      const source = readFileSync(file, "utf8");
      if (DIRECT_DIMENSION_READ.test(source)) hits.push(relative(repoRoot, file));
    }
    expect(hits, hits.length ? `direct dimension reads in ${hits.join(", ")}` : "").toEqual([]);
  });
});

describe("nearestSocialRatio — the background port's vocabulary", () => {
  test("a ratio-family spec is itself", () => {
    for (const ratio of RATIO_VALUES) {
      expect(nearestSocialRatio({ ratio })).toBe(ratio);
    }
  });

  test("each display size resolves to the social orientation it actually looks like", () => {
    expect(nearestSocialRatio({ size: "300x250" })).toBe("1:1");
    expect(nearestSocialRatio({ size: "728x90" })).toBe("16:9");
    expect(nearestSocialRatio({ size: "320x50" })).toBe("16:9");
    expect(nearestSocialRatio({ size: "160x600" })).toBe("9:16");
    expect(nearestSocialRatio({ size: "300x600" })).toBe("9:16");
  });

  test("every member of the union is answered — a sixth size cannot fall through", () => {
    for (const size of DISPLAY_SIZE_VALUES) {
      expect(RATIO_VALUES).toContain(nearestSocialRatio({ size }));
    }
  });
});
