import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  candidateNames,
  countUnreferencedInputs,
  type RefTarget,
  resolveRefTargets,
  writeOrReuse,
} from "../asset-step.js";
import { classifyRefs } from "../classify.js";
import { importTenant } from "../import-tenant.js";
import type { ScannedCampaign } from "../scan.js";
import type { StepContext } from "../steps.js";
import { getAssetStore, getBriefStore } from "../../ports/index.js";
import {
  ON_A_REAL_TEST_SERVER,
  restoreApplyEnvironment,
  useApplyEnvironment,
} from "./fixtures/apply-harness.js";
import {
  PNG,
  briefBody,
  dropRoot,
  linkAt,
  makeRoot,
  writeAt,
  writeBrief,
} from "./fixtures/tree.js";

function ctxWith(root: string): StepContext {
  return {
    orgId: "local",
    switchedAt: new Date("2026-10-01T00:00:00Z"),
    projectRoot: root,
    outputRoot: join(root, "output"),
    includeSamples: false,
    fsOnly: false,
  };
}

function take(gen: Generator<string>, n: number): string[] {
  const out: string[] = [];
  for (const value of gen) {
    if (out.length >= n) break;
    out.push(value);
  }
  return out;
}

describe("asset-step: candidate names", () => {
  test("suffix order is plain, then -<from>, -<from>-2, …", () => {
    const names = take(candidateNames("logo.png", "camp"), 4);
    expect(names).toEqual(["logo.png", "logo-camp.png", "logo-camp-2.png", "logo-camp-3.png"]);
  });

  test("root from yields the literal root suffix", () => {
    const names = take(candidateNames("logo.png", "root"), 3);
    expect(names).toEqual(["logo.png", "logo-root.png", "logo-root-2.png"]);
  });
});

describe("asset-step: unreferenced inputs", () => {
  test("a symlinked input is skipped, not counted", () => {
    const root = makeRoot();
    try {
      writeAt(root, join("assets/inputs/camp/image.png"), PNG);
      linkAt(root, join("assets/inputs/camp/link.png"), "image.png");
      const ctx = ctxWith(root);
      const result = countUnreferencedInputs(ctx, "camp", []);
      expect(result.names).toEqual(["image.png"]);
      expect(result.count).toBe(1);
    } finally {
      dropRoot(root);
    }
  });

  test("a referenced file is not counted as unreferenced", () => {
    const root = makeRoot();
    try {
      writeAt(root, join("assets/inputs/camp/logo.png"), PNG);
      writeAt(root, join("assets/inputs/camp/extra.png"), PNG);
      const ctx = ctxWith(root);
      const targets: RefTarget[] = [
        {
          ref: "assets/inputs/camp/logo.png",
          name: "logo.png",
          path: join(root, "assets/inputs/camp/logo.png"),
          from: "camp",
        },
      ];
      const result = countUnreferencedInputs(ctx, "camp", targets);
      expect(result.names).toEqual(["extra.png"]);
      expect(result.count).toBe(1);
    } finally {
      dropRoot(root);
    }
  });

  test("a slug with no input directory counts as zero unreferenced inputs", () => {
    const root = makeRoot();
    try {
      const ctx = ctxWith(root);
      expect(countUnreferencedInputs(ctx, "nope", []).names).toEqual([]);
      expect(countUnreferencedInputs(ctx, "nope", []).count).toBe(0);
    } finally {
      dropRoot(root);
    }
  });

  test("a non-directory input path rethrows the read error", () => {
    const root = makeRoot();
    try {
      writeAt(root, "assets/inputs/camp", "not a directory");
      const ctx = ctxWith(root);
      expect(() => countUnreferencedInputs(ctx, "camp", [])).toThrow();
    } finally {
      dropRoot(root);
    }
  });
});

describe("asset-step: resolveRefTargets", () => {
  test("a ref classify marks missing is not returned as a write target", () => {
    const root = makeRoot();
    try {
      const ctx = ctxWith(root);
      const sourcePath = writeBrief(root, "camp.yaml", {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/missing.png",
          },
          {
            id: "p2",
            name: "P2",
            primaryColor: "#222222",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      writeAt(root, join("assets/inputs/camp/logo.png"), PNG);
      const brief = briefBody({
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/missing.png",
          },
          {
            id: "p2",
            name: "P2",
            primaryColor: "#222222",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const draft: ScannedCampaign = {
        slug: "camp",
        sourcePath,
        name: null,
        type: null,
        brief,
        refs: [],
        sample: false,
      };
      const scanned: ScannedCampaign = { ...draft, refs: classifyRefs(ctx, draft) };
      const targets = resolveRefTargets(ctx, scanned);
      expect(targets).toHaveLength(1);
      expect(targets[0].ref).toBe("assets/inputs/camp/logo.png");
    } finally {
      dropRoot(root);
    }
  });

  test("an other-safe-assets ref resolves from the literal root", () => {
    const root = makeRoot();
    try {
      const ctx = ctxWith(root);
      writeAt(root, "assets/promo.png", PNG);
      const sourcePath = writeBrief(root, "camp.yaml", {
        id: "camp",
        products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/promo.png" }],
      });
      const brief = briefBody({
        id: "camp",
        products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/promo.png" }],
      });
      const draft: ScannedCampaign = {
        slug: "camp",
        sourcePath,
        name: null,
        type: null,
        brief,
        refs: [],
        sample: false,
      };
      const scanned: ScannedCampaign = { ...draft, refs: classifyRefs(ctx, draft) };
      const targets = resolveRefTargets(ctx, scanned);
      expect(targets).toHaveLength(1);
      expect(targets[0].from).toBe("root");
    } finally {
      dropRoot(root);
    }
  });
});

describe.skipIf(ON_A_REAL_TEST_SERVER)("asset-step: writeOrReuse", () => {
  beforeEach(async () => {
    await useApplyEnvironment();
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("EEXIST with equal bytes reuses the id listAssets returned", async () => {
    const briefs = getBriefStore(importTenant("local"));
    const assets = getAssetStore(importTenant("local"));
    await briefs.createCampaign("camp");

    const first = await writeOrReuse(assets, "camp", "logo.png", PNG, "root");
    expect(first.reused).toBe(false);
    expect(first.name).toBe("logo.png");

    const second = await writeOrReuse(assets, "camp", "logo.png", PNG, "root");
    expect(second.reused).toBe(true);
    expect(second.name).toBe("logo.png");
    expect(second.id).toBe(first.id);
  });

  test("EEXIST with different bytes takes the next candidate", async () => {
    const briefs = getBriefStore(importTenant("local"));
    const assets = getAssetStore(importTenant("local"));
    await briefs.createCampaign("camp");
    const other = Buffer.from("not-the-logo-bytes");

    const first = await writeOrReuse(assets, "camp", "logo.png", PNG, "own");
    expect(first.name).toBe("logo.png");

    const second = await writeOrReuse(assets, "camp", "logo.png", other, "root");
    expect(second.name).toBe("logo-root.png");
    expect(second.reused).toBe(false);
    expect(second.id).not.toBe(first.id);
  });

  test("a reuse at the second candidate", async () => {
    const briefs = getBriefStore(importTenant("local"));
    const assets = getAssetStore(importTenant("local"));
    await briefs.createCampaign("camp");
    const other = Buffer.from("not-the-logo-bytes");

    const first = await writeOrReuse(assets, "camp", "logo.png", PNG, "root");
    const second = await writeOrReuse(assets, "camp", "logo.png", other, "root");
    const third = await writeOrReuse(assets, "camp", "logo.png", other, "root");

    expect(first.name).toBe("logo.png");
    expect(second.name).toBe("logo-root.png");
    expect(second.reused).toBe(false);
    expect(third.name).toBe("logo-root.png");
    expect(third.reused).toBe(true);
    expect(third.id).toBe(second.id);
  });
});
