import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GenerateCampaignUseCase,
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import {
  ALLOWED_IMAGE_MODELS,
  buildPipeline,
  copyGenerator,
  messageFont,
  platformZones,
  runCampaign,
} from "../pipeline.js";

import { runEnvironment, type RunEnvironment } from "../run-environment.js";
import { LOCAL_TENANT } from "../tenant.js";

/**
 * Review on #573 (CodeRabbit): record what each GenAI adapter is constructed
 * with, so a test can see which provider a selection built and with whose
 * credentials. Thin subclasses: behaviour is the real adapter's.
 */
const constructed = vi.hoisted(() => ({
  openRouter: [] as Array<{ apiKey: string; model?: string }>,
  gemini: [] as Array<{ apiKey: string; model?: string }>,
  firefly: [] as Array<{ clientId: string; clientSecret: string }>,
  cacheDirs: [] as string[],
}));
vi.mock("@campaignfoundry/CreativeGeneration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@campaignfoundry/CreativeGeneration")>();
  class OpenRouter extends actual.OpenRouterImageGenerator {
    constructor(options: ConstructorParameters<typeof actual.OpenRouterImageGenerator>[0]) {
      super(options);
      constructed.openRouter.push({ apiKey: options.apiKey, model: options.model });
    }
  }
  class Gemini extends actual.GeminiImageGenerator {
    constructor(options: ConstructorParameters<typeof actual.GeminiImageGenerator>[0]) {
      super(options);
      constructed.gemini.push({ apiKey: options.apiKey, model: options.model });
    }
  }
  class Firefly extends actual.FireflyImageGenerator {
    constructor(options: ConstructorParameters<typeof actual.FireflyImageGenerator>[0]) {
      super(options);
      constructed.firefly.push({ clientId: options.clientId, clientSecret: options.clientSecret });
    }
  }
  class Cache extends actual.FileSystemBackgroundCache {
    constructor(dir: string) {
      super(dir);
      constructed.cacheDirs.push(dir);
    }
  }
  return {
    ...actual,
    FileSystemBackgroundCache: Cache,
    OpenRouterImageGenerator: OpenRouter,
    GeminiImageGenerator: Gemini,
    FireflyImageGenerator: Firefly,
  };
});
/** The local operator's environment, resolved when called so each test's env setup applies. */
const localEnv = () => runEnvironment(LOCAL_TENANT);
const brief: CampaignBrief = {
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [
    { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
    { id: "beta", name: "B", primaryColor: "#E0218A", logoPath: "assets/inputs/trail-logo.png" },
  ],
};

const KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_COPY_MODEL",
  "FIREFLY_CLIENT_ID",
  "FIREFLY_CLIENT_SECRET",
];

describe("pipeline composition root", () => {
  let dir: string;
  const snap: Record<string, string | undefined> = {};
  const origOut = process.env.OUTPUT_DIR;

  beforeEach(() => {
    for (const k of KEYS) {
      snap[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "cf-pipeline-"));
    process.env.OUTPUT_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of KEYS) {
      if (snap[k] === undefined) delete process.env[k];
      else process.env[k] = snap[k];
    }
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
  });

  test("ALLOWED_IMAGE_MODELS lists the curated ids", () => {
    expect(ALLOWED_IMAGE_MODELS).toContain("procedural");
    expect(ALLOWED_IMAGE_MODELS).toContain("imagen");
    expect(ALLOWED_IMAGE_MODELS).toContain("firefly");
    expect(ALLOWED_IMAGE_MODELS).toContain("x-ai/grok-imagine-image-quality");
  });

  test("buildPipeline wires a use case for every generator-selection branch", () => {
    // Construction is lazy (no network), so this exercises each branch of imageGenerator().
    expect(buildPipeline(localEnv(), "procedural")).toBeInstanceOf(GenerateCampaignUseCase);
    expect(buildPipeline(localEnv())).toBeInstanceOf(GenerateCampaignUseCase); // default, no keys → procedural floor
    expect(buildPipeline(localEnv(), "firefly")).toBeInstanceOf(GenerateCampaignUseCase); // no Firefly creds → default chain

    process.env.OPENROUTER_API_KEY = "o";
    expect(buildPipeline(localEnv(), "x-ai/grok-imagine-image-quality")).toBeInstanceOf(
      GenerateCampaignUseCase,
    ); // explicit OpenRouter model
    expect(buildPipeline(localEnv(), "imagen")).toBeInstanceOf(GenerateCampaignUseCase); // no gemini → OpenRouter

    process.env.GEMINI_API_KEY = "g";
    expect(buildPipeline(localEnv(), "imagen")).toBeInstanceOf(GenerateCampaignUseCase); // Imagen + OpenRouter fallback

    process.env.FIREFLY_CLIENT_ID = "cid";
    process.env.FIREFLY_CLIENT_SECRET = "secret";
    expect(buildPipeline(localEnv(), "firefly")).toBeInstanceOf(GenerateCampaignUseCase); // Firefly + chain fallback
  });

  test("a run writes where its captured environment says, even after OUTPUT_DIR moves (D167, #567)", async () => {
    const env = localEnv(); // captured at enqueue
    const elsewhere = mkdtempSync(join(tmpdir(), "cf-pipeline-elsewhere-"));
    process.env.OUTPUT_DIR = elsewhere; // what the next test, or the next request, would do
    try {
      const r = await runCampaign(env, brief, "procedural");
      expect(r.success).toBe(true);
      if (r.success) {
        const written = r.value.assets[0]!.outputPath;
        expect(existsSync(join(dir, written))).toBe(true);
        expect(existsSync(join(elsewhere, written))).toBe(false);
      }
    } finally {
      process.env.OUTPUT_DIR = dir;
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("provider selection builds from env.providers alone, never from process.env (D167)", () => {
    // Every key below exists only on the environment object; process.env has none.
    const withProviders = (providers: RunEnvironment["providers"]): RunEnvironment => ({
      ...localEnv(),
      providers,
    });
    const reset = () => {
      constructed.openRouter.length = 0;
      constructed.gemini.length = 0;
      constructed.firefly.length = 0;
    };

    reset();
    buildPipeline(
      withProviders({ openRouterKey: "or-key", openRouterImageModel: "or/model" }),
      "imagen",
    );
    expect(constructed.gemini).toEqual([]);
    expect(constructed.openRouter).toEqual([{ apiKey: "or-key", model: "or/model" }]);

    reset();
    buildPipeline(withProviders({ geminiKey: "g-key", imagenModel: "imagen-x" }), "imagen");
    expect(constructed.gemini).toEqual([{ apiKey: "g-key", model: "imagen-x" }]);

    reset();
    buildPipeline(
      withProviders({ fireflyClientId: "ff-id", fireflyClientSecret: "ff-secret" }),
      "firefly",
    );
    expect(constructed.firefly).toEqual([{ clientId: "ff-id", clientSecret: "ff-secret" }]);

    reset();
    buildPipeline(withProviders({}), "firefly"); // no credentials anywhere: nothing GenAI is built
    expect([constructed.openRouter, constructed.gemini, constructed.firefly]).toEqual([[], [], []]);
  });

  test("each tenant's generation cache lives under its own root, so two orgs never share an entry (PT-0c)", () => {
    const acme = runEnvironment({ ...LOCAL_TENANT, orgId: "acme", userId: "u1" });
    const globex = runEnvironment({ ...LOCAL_TENANT, orgId: "globex", userId: "u2" });
    constructed.cacheDirs.length = 0;
    buildPipeline(acme, "imagen");
    buildPipeline(globex, "imagen");
    buildPipeline(localEnv(), "imagen");
    expect(constructed.cacheDirs).toEqual([
      join(dir, "orgs", "acme", "cache"),
      join(dir, "orgs", "globex", "cache"),
      join(dir, "cache"),
    ]);
  });

  test("runCampaign executes fully offline with the procedural model", async () => {
    const r = await runCampaign(localEnv(), brief, "procedural");
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.value.assets).toHaveLength(6); // 2 products × 3 ratios × 1 default treatment
      expect(r.value.assets.every((a) => a.backgroundSource === "procedural")).toBe(true);
    }
  });

  test("runCampaign generates a variation brief from the planner", async () => {
    const r = await runCampaign(
      localEnv(),
      { ...brief, mode: "variation", variation: { count: 4, seed: 42 } },
      "procedural",
    );
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.value.assets).toHaveLength(4);
      expect(
        r.value.assets.every(
          (a) => a.outputPath.includes("/v") && a.format === "static" && a.attempt === 0,
        ),
      ).toBe(true);
      expect(r.value.policyHash).toEqual(expect.any(String));
      expect(r.value.seed).toBe(42);
    }
  });

  // projectRoot() memoizes per process: re-import the pipeline so PROJECT_ROOT points at `dir`.
  // The run environment is resolved from the same fresh registry, because a run
  // uses the roots its environment captured (PT-0b2): an environment resolved from
  // the stale registry would carry the stale project root. The caller's own
  // environment argument is replaced for exactly that reason.
  const freshRunCampaign = async (): Promise<typeof runCampaign> => {
    vi.resetModules();
    process.env.PROJECT_ROOT = dir;
    const { runCampaign: fresh } = await import("../pipeline.js");
    const { runEnvironment: freshEnvironment } = await import("../run-environment.js");
    const { LOCAL_TENANT: freshTenant } = await import("../tenant.js");
    return (_env, ...rest) => fresh(freshEnvironment(freshTenant), ...rest);
  };

  /** Spy on the compositor the freshly imported pipeline will construct (same module registry). */
  const spyCompositor = async () => {
    const { NodeCanvasCompositor } = await import("@campaignfoundry/CreativeGeneration");
    return vi.spyOn(NodeCanvasCompositor.prototype, "compositeAsset");
  };

  test("runCampaign fails loud when headline: pool://copy has no approved pool", async () => {
    const origRoot = process.env.PROJECT_ROOT;
    try {
      const pooled: CampaignBrief = {
        ...brief,
        mode: "variation",
        variation: { count: 2, seed: 42, axes: { headline: "pool://copy" } },
      };
      const r = await (await freshRunCampaign())(localEnv(), pooled, "procedural");
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.message).toMatch(/briefs\/camp\/pools\.json/);
    } finally {
      if (origRoot === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = origRoot;
    }
  });

  test("runCampaign fails loud naming the pool file when pools.json is hand-edited into an invalid shape", async () => {
    const origRoot = process.env.PROJECT_ROOT;
    try {
      mkdirSync(join(dir, "briefs", "camp"), { recursive: true });
      writeFileSync(
        join(dir, "briefs", "camp", "pools.json"),
        JSON.stringify({
          briefId: "camp",
          generatedAt: "t",
          model: "m",
          entries: [{ id: "h1", text: 42, status: "approved" }],
        }),
      );
      const pooled: CampaignBrief = {
        ...brief,
        mode: "variation",
        variation: { count: 2, seed: 42, axes: { headline: "pool://copy" } },
      };
      const r = await (await freshRunCampaign())(localEnv(), pooled, "procedural");
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.message).toBe(
          "Copy pool briefs/camp/pools.json is invalid: entries[0].text must be a string.",
        );
      }
    } finally {
      if (origRoot === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = origRoot;
    }
  });

  test("runCampaign composites pooled headlines from briefs/<id>/pools.json", async () => {
    const origRoot = process.env.PROJECT_ROOT;
    try {
      mkdirSync(join(dir, "briefs", "camp"), { recursive: true });
      writeFileSync(
        join(dir, "briefs", "camp", "pools.json"),
        JSON.stringify({
          briefId: "camp",
          generatedAt: "2026-01-01T00:00:00.000Z",
          model: "m",
          entries: [{ id: "h1", text: "Stay wild", status: "approved" }],
        }),
      );
      const pooled: CampaignBrief = {
        ...brief,
        mode: "variation",
        variation: { count: 2, seed: 42, axes: { headline: "pool://copy" } },
      };
      const run = await freshRunCampaign();
      const compositeAsset = await spyCompositor();
      const r = await run(localEnv(), pooled, "procedural");
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.value.assets).toHaveLength(2);
        expect(r.value.assets.map((a) => a.descriptor?.headline)).toEqual([
          "Stay wild",
          "Stay wild",
        ]);
      }
      // The compositor rendered the pool text, not the campaign message.
      expect(compositeAsset).toHaveBeenCalledTimes(2);
      expect(compositeAsset.mock.calls.map((call) => call[0].message)).toEqual([
        "Stay wild",
        "Stay wild",
      ]);
    } finally {
      vi.restoreAllMocks();
      if (origRoot === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = origRoot;
    }
  });

  test("runCampaign halts when an approved pool headline fails the legal gate", async () => {
    const origRoot = process.env.PROJECT_ROOT;
    try {
      mkdirSync(join(dir, "briefs", "camp"), { recursive: true });
      writeFileSync(
        join(dir, "briefs", "camp", "pools.json"),
        JSON.stringify({
          briefId: "camp",
          generatedAt: "2026-01-01T00:00:00.000Z",
          model: "m",
          entries: [
            { id: "h1", text: "Stay wild", status: "approved" },
            { id: "h2", text: "A miracle cure", status: "approved" },
          ],
        }),
      );
      const pooled: CampaignBrief = {
        ...brief,
        mode: "variation",
        variation: { count: 4, seed: 42, axes: { headline: "pool://copy" } },
      };
      const r = await (await freshRunCampaign())(localEnv(), pooled, "procedural");
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.value.halted).toBe(true);
        expect(r.value.assets).toEqual([]);
        expect(r.value.log.entries.at(-1)).toMatchObject({
          stage: "ExecuteLegalGateCheck",
          level: "error",
          message: "Pipeline halted — Prohibited terminology: miracle, cure",
        });
      }
    } finally {
      if (origRoot === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = origRoot;
    }
  });

  test("runCampaign pins a re-roll to expectedPolicyHash", async () => {
    const vbrief: CampaignBrief = {
      ...brief,
      mode: "variation",
      variation: { count: 4, seed: 42 },
    };
    const first = await runCampaign(localEnv(), vbrief, "procedural");
    expect(first.success).toBe(true);
    if (!first.success) return;
    const hash = first.value.policyHash as string;
    const target = [{ productId: first.value.assets[0].productId, variantIndex: 0 }];

    const same = await runCampaign(localEnv(), vbrief, "procedural", target, hash);
    expect(same.success).toBe(true);
    if (same.success) expect(same.value.assets).toHaveLength(1);

    const changed = await runCampaign(
      localEnv(),
      { ...vbrief, variation: { count: 4, seed: 43 } },
      "procedural",
      target,
      hash,
    );
    expect(changed.success).toBe(false);
    if (!changed.success) {
      expect(changed.error.message).toMatch(
        /^Plan changed since the last run \(policyHash [0-9a-f]{64} ≠ [0-9a-f]{64}\); run the full campaign\.$/,
      );
      expect(changed.error.message).toContain(hash);
    }

    const unplannable = await runCampaign(
      localEnv(),
      { ...vbrief, variation: { count: 999, seed: 42 } },
      "procedural",
      target,
      hash,
    );
    expect(unplannable.success).toBe(false);
    if (!unplannable.success) expect(unplannable.error.message).toMatch(/exceeds axisProductSize/);
  });

  test("runCampaign pins a re-roll to expectedCopyHash, independent of expectedPolicyHash (X33, §35)", async () => {
    const vbrief: CampaignBrief = {
      ...brief,
      mode: "variation",
      variation: { count: 4, seed: 42 },
    };
    const first = await runCampaign(localEnv(), vbrief, "procedural");
    expect(first.success).toBe(true);
    if (!first.success) return;
    const policyHash = first.value.policyHash as string;
    const copyHash = first.value.copyHash as string;
    expect(copyHash).toEqual(expect.any(String));
    const target = [{ productId: first.value.assets[0].productId, variantIndex: 0 }];

    // Copy unchanged, axes unchanged: proceeds pinned on both.
    const same = await runCampaign(localEnv(), vbrief, "procedural", target, policyHash, copyHash);
    expect(same.success).toBe(true);
    if (same.success) expect(same.value.assets).toHaveLength(1);

    // Only the brief's copy moved (the axes — and so policyHash — are untouched):
    // a naive policyHash-only pin would let this pass and merge new copy into a
    // report whose other cells still show the old campaignMessage. Refused.
    const copyMoved = { ...vbrief, campaignMessage: "A totally different message" };
    const refused = await runCampaign(
      localEnv(),
      copyMoved,
      "procedural",
      target,
      policyHash,
      copyHash,
    );
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.message).toMatch(
        /^The brief's copy changed since the last run \(copyHash [0-9a-f]{64} ≠ [0-9a-f]{64}\); run the full campaign\.$/,
      );
      expect(refused.error.message).toContain(copyHash);
    }

    // No expectedCopyHash (a report persisted before this field existed): not pinned,
    // even though the copy actually moved — the documented decision (§35): the first
    // re-roll of a pre-existing report stays unguarded on copy.
    const noPin = await runCampaign(
      localEnv(),
      copyMoved,
      "procedural",
      target,
      policyHash,
      undefined,
    );
    expect(noPin.success).toBe(true);
  });

  test("runCampaign forwards regenerateOnly targets", async () => {
    const r = await runCampaign(localEnv(), brief, "procedural", [
      { productId: "alpha", aspectRatio: "1:1", treatment: "default" },
    ]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.value.assets.map((a) => a.outputPath)).toEqual(["camp/alpha/1x1.png"]);
  });

  test("variation + platforms resolves safe zones from the profile table (unknown ids ignored)", async () => {
    const r = await runCampaign(
      localEnv(),
      {
        ...brief,
        mode: "variation",
        variation: { count: 2, seed: 1, axes: { layout: ["headline-bottom"], tone: ["bold"] } },
        output: { formats: ["static"], platforms: ["instagram-feed", "myspace"] },
      },
      "procedural",
    );
    expect(r.success).toBe(true);
    if (r.success) expect(r.value.assets).toHaveLength(2);
  });

  test("platformZones exposes ratio, insets and formats from the profile table", () => {
    expect(platformZones("instagram-reel")).toEqual({
      ratio: "9:16",
      safeInsets: { top: 250, right: 0, bottom: 340, left: 0 },
      formats: ["motion"],
    });
    expect(platformZones("myspace")).toBeUndefined();
    // A display profile carries a `sizes` list instead of a ratio (D116): the run
    // path renders its units with the per-size insets (F5), so it now resolves.
    expect(platformZones("google-display")).toEqual({
      safeInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      formats: ["static"],
      sizes: expect.arrayContaining([
        { size: "728x90", insets: { top: 0, right: 0, bottom: 0, left: 0 } },
        { size: "300x250", insets: { top: 8, right: 8, bottom: 8, left: 8 } },
      ]),
    });
  });

  test("copyGenerator is undefined without OPENROUTER_API_KEY and constructed with it", () => {
    expect(copyGenerator(localEnv())).toBeUndefined();
    process.env.OPENROUTER_API_KEY = "k";
    const generator = copyGenerator(localEnv());
    expect(generator).toBeDefined();
    expect(generator?.model).toBe("openai/gpt-4o-mini");
    expect(typeof generator?.suggestHeadlines).toBe("function");
    process.env.OPENROUTER_COPY_MODEL = "anthropic/claude-3.5-haiku";
    expect(copyGenerator(localEnv())?.model).toBe("anthropic/claude-3.5-haiku");
  });

  describe("MESSAGE_FONT is validated against the bundled allowlist (D59)", () => {
    const orig = process.env.MESSAGE_FONT;
    afterEach(() => {
      if (orig === undefined) delete process.env.MESSAGE_FONT;
      else process.env.MESSAGE_FONT = orig;
    });

    test("an unset or empty MESSAGE_FONT resolves to Inter", () => {
      delete process.env.MESSAGE_FONT;
      expect(messageFont()).toBe("Inter");
      process.env.MESSAGE_FONT = "";
      expect(messageFont()).toBe("Inter");
    });

    test("a bundled family passes through", () => {
      for (const family of ["Inter", "Lora"]) {
        process.env.MESSAGE_FONT = family;
        expect(messageFont()).toBe(family);
      }
    });

    test("an arbitrary system family falls back to Inter with a logged warning", () => {
      // The renderer can see 312 system families (Helvetica and Georgia both
      // resolve); an unvalidated MESSAGE_FONT was a determinism hole at
      // deployment scope. Never passed through.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.MESSAGE_FONT = "Comic Sans";
      expect(messageFont()).toBe("Inter");
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain("Comic Sans");
      expect(warn.mock.calls[0]?.[0]).toContain("Inter");
    });
  });
});
