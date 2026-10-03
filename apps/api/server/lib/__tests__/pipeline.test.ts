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
  type ImageGeneratorPort,
  type InputAssetPort,
} from "@campaignfoundry/CampaignOrchestration";
import {
  ALLOWED_IMAGE_MODELS,
  buildPipeline,
  copyGenerator,
  imageGenerator,
  imageProviderChain,
  messageFont,
  platformZones,
  primaryImageProvider,
  runCampaign,
} from "../pipeline.js";

import { runEnvironment, type RunEnvironment } from "../run-environment.js";
import { ObjectInputAssets } from "../object-store/object-input-assets.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../object-store/index.js";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetDatabase, setDatabase } from "../db/database.js";
import type { SqlClient } from "../db/sql-client.js";
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
  /** Every `InputAssetPort` instance built for a pipeline (PT-4c). */
  ports: [] as unknown[],
  /** The port each consumer was constructed with, by adapter name (PT-4c). */
  consumers: [] as Array<{ name: string; inputs: unknown }>,
  /** PT-4e: the exporters and the background caches the composition root built. */
  exporters: [] as Array<{ kind: string; store: unknown; prefix?: string; segment?: string }>,
  caches: [] as Array<{ kind: string; store: unknown; prefix?: string }>,
}));
vi.mock("@campaignfoundry/CreativeGeneration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@campaignfoundry/CreativeGeneration")>();
  const record = (name: string, inputs: unknown): void => {
    constructed.consumers.push({ name, inputs });
  };
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
      constructed.caches.push({ kind: "fs", store: undefined });
    }
  }
  // PT-4e: the s3 half of the same switch, recorded the same way. The two are
  // told apart by CLASS rather than by a flag, because the switch is
  // `objectStore()` and a flag would only prove the flag moved.
  class ObjectCache extends actual.ObjectBackgroundCache {
    constructor(
      store: ConstructorParameters<typeof actual.ObjectBackgroundCache>[0],
      prefix: string,
    ) {
      super(store, prefix);
      constructed.caches.push({ kind: "object", store, prefix });
    }
  }
  // PT-4c: the one InputAssetPort a build creates, and the five consumers' copies
  // of it. Both are recorded so a test can prove they are the SAME object — the
  // reader carries no state today, so identity is the whole contract.
  class Inputs extends actual.FileSystemInputAssets {
    constructor(root: string) {
      super(root);
      constructed.ports.push(this);
    }
  }
  class Compositor extends actual.NodeCanvasCompositor {
    constructor(fontFamily: string, inputs: InputAssetPort) {
      super(fontFamily, inputs);
      record("compositor", inputs);
    }
  }
  class VideoCompositor extends actual.CanvasFfmpegVideoCompositor {
    constructor(options: ConstructorParameters<typeof actual.CanvasFfmpegVideoCompositor>[0]) {
      super(options);
      record("videoCompositor", options.inputs);
    }
  }
  class SceneAssets extends actual.FileSystemSceneAssetResolver {
    constructor(inputs: InputAssetPort) {
      super(inputs);
      record("sceneAssets", inputs);
    }
  }
  class AudioAssets extends actual.FileSystemAudioAssetResolver {
    constructor(inputs: InputAssetPort) {
      super(inputs);
      record("audioAssets", inputs);
    }
  }
  class ReusingGenerator extends actual.AssetReusingImageGenerator {
    constructor(generator: ImageGeneratorPort, inputs: InputAssetPort) {
      super(generator, inputs);
      record("imageGenerator", inputs);
    }
  }
  return {
    ...actual,
    FileSystemBackgroundCache: Cache,
    ObjectBackgroundCache: ObjectCache,
    OpenRouterImageGenerator: OpenRouter,
    GeminiImageGenerator: Gemini,
    FireflyImageGenerator: Firefly,
    FileSystemInputAssets: Inputs,
    NodeCanvasCompositor: Compositor,
    CanvasFfmpegVideoCompositor: VideoCompositor,
    FileSystemSceneAssetResolver: SceneAssets,
    FileSystemAudioAssetResolver: AudioAssets,
    AssetReusingImageGenerator: ReusingGenerator,
  };
});

// PT-4e. `GenerateCampaignUseCase`'s dependencies are private, so the exporter's
// class cannot be read off the built use case — the second mock is the only way
// to see WHICH adapter the composition root chose, and the class is the whole
// point: a store that merely recorded a write would also answer under fs.
vi.mock("@campaignfoundry/Distribution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@campaignfoundry/Distribution")>();
  class FsExporter extends actual.FileSystemExporter {
    constructor(root: string) {
      super(root);
      constructed.exporters.push({ kind: "fs", store: undefined });
    }
  }
  class ObjectExp extends actual.ObjectExporter {
    constructor(
      store: ConstructorParameters<typeof actual.ObjectExporter>[0],
      options: ConstructorParameters<typeof actual.ObjectExporter>[1],
    ) {
      super(store, options);
      constructed.exporters.push({
        kind: "object",
        store,
        prefix: options.prefix,
        segment: options.campaignSegment,
      });
    }
  }
  return { ...actual, FileSystemExporter: FsExporter, ObjectExporter: ObjectExp };
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
  /** Any uuid, and the slug the use case's own paths start with. */
  const RENDERS = { campaignId: "3f1b7a52-0c4d-4a6e-9b21-5d8e7c6a5b4c", slug: "camp" };
  const OTHER_RENDERS = { campaignId: "00000000-0000-4000-8000-000000000001", slug: "camp" };

  beforeEach(() => {
    for (const k of KEYS) {
      snap[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "cf-pipeline-"));
    process.env.OUTPUT_DIR = dir;
    // PT-4e: under s3 the root builds an ObjectBackgroundCache and an
    // ObjectExporter, and both need a client. The fake keeps these tests about
    // WHICH adapter, not about whether a bucket answers.
    setObjectStoreClient(new InMemoryObjectStore());
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetObjectStoreClient();
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

  test("buildPipeline builds ONE input port and hands that same instance to all five consumers (PT-4c)", () => {
    // The recorder is file-wide, so start this test from a known count: the port
    // is the only thing this asserts, and earlier tests build pipelines too.
    constructed.ports.length = 0;
    constructed.consumers.length = 0;

    buildPipeline(localEnv(), "procedural");

    // One build, one reader. `imageGenerator` used to call `inputAssets` itself,
    // so a run carried two identical ports over one tree — one per consumer group.
    expect(constructed.ports).toHaveLength(1);
    const [port] = constructed.ports;

    // ...and all five consumers got THAT one, not a look-alike each.
    expect(constructed.consumers.map((c) => c.name).sort()).toEqual([
      "audioAssets",
      "compositor",
      "imageGenerator",
      "sceneAssets",
      "videoCompositor",
    ]);
    for (const consumer of constructed.consumers) {
      expect(consumer.inputs).toBe(port);
    }
  });

  // PT-4d. The switch is `objectStore()` inside `inputAssets`, so the only thing
  // that can move is WHICH port that one function builds — the identity contract
  // above is the same contract on both backends, and it is asserted through the
  // consumers rather than through `constructed.ports`: that recorder is a
  // subclass of the PACKAGE's `FileSystemInputAssets`, so under s3, where nothing
  // fs is built, it has nothing to record.
  test("under OBJECT_STORE=s3 the one port is an ObjectInputAssets, and all five consumers share it (PT-4d)", () => {
    const saved = process.env.OBJECT_STORE;
    process.env.OBJECT_STORE = "s3";
    constructed.ports.length = 0;
    constructed.consumers.length = 0;
    try {
      // The render target is PT-4e's requirement and is separate from the reader:
      // this test is about inputs, and without a target under s3 the composition
      // root refuses before it can say anything about them.
      buildPipeline(localEnv(), "procedural", {}, RENDERS);
    } finally {
      if (saved === undefined) delete process.env.OBJECT_STORE;
      else process.env.OBJECT_STORE = saved;
    }

    // No `FileSystemInputAssets` at all: under s3 a run must not reach for a
    // project root, because there are no files behind these refs any more.
    expect(constructed.ports).toHaveLength(0);
    expect(constructed.consumers.map((c) => c.name).sort()).toEqual([
      "audioAssets",
      "compositor",
      "imageGenerator",
      "sceneAssets",
      "videoCompositor",
    ]);
    // One instance, five consumers — the memo lives in THAT object, so a second
    // reader anywhere would mean a second cache and a second copy of every logo.
    for (const consumer of constructed.consumers) {
      expect(consumer.inputs).toBeInstanceOf(ObjectInputAssets);
      expect(consumer.inputs).toBe(constructed.consumers[0]!.inputs);
    }
  });

  // PT-4e. The renders switch, on the same terms as the inputs switch above:
  // the class is the whole assertion, because a switch that built the right
  // adapter with the wrong prefix would satisfy anything weaker.
  test("under OBJECT_STORE=s3 the exporter is an ObjectExporter and the cache an ObjectBackgroundCache (PT-4e)", () => {
    const saved = process.env.OBJECT_STORE;
    process.env.OBJECT_STORE = "s3";
    constructed.exporters.length = 0;
    constructed.caches.length = 0;
    try {
      buildPipeline(localEnv(), "procedural", {}, RENDERS);
    } finally {
      if (saved === undefined) delete process.env.OBJECT_STORE;
      else process.env.OBJECT_STORE = saved;
    }
    expect(constructed.exporters.map((e) => e.kind)).toEqual(["object"]);
    expect(constructed.caches.map((c) => c.kind)).toEqual(["object"]);
    // Both were handed the ONE store the process shares with its input assets,
    // so a run writes its inputs and its renders through the same client.
    expect(constructed.exporters[0]!.store).toBe(constructed.caches[0]!.store);

    // The PREFIXES, not just the class: a switch that built the right adapter
    // over the wrong prefix would satisfy everything above and put every render
    // in another org's bucket or another campaign's namespace — which is the
    // whole tenancy claim of the lane, and the part a class cannot show.
    expect(constructed.caches[0]!.prefix).toBe(`org/${LOCAL_TENANT.orgId}/cache/`);
    expect(constructed.exporters[0]!.prefix).toBe(
      `org/${LOCAL_TENANT.orgId}/campaign/${RENDERS.campaignId}/renders/`,
    );
    // And the segment is the ref the use case builds its paths from, so every
    // path it writes still maps through `renderObjectKey`.
    expect(constructed.exporters[0]!.segment).toBe(RENDERS.slug);
  });

  test("the s3 prefixes carry THIS org: another tenant's build differs in both (PT-4e)", () => {
    // The negative that makes the assertion above mean something. `LOCAL_TENANT`
    // is one org; a second run under another one must not reuse its namespace,
    // and a build for another campaign must not reuse its renders prefix either.
    const acme = runEnvironment({ ...LOCAL_TENANT, orgId: "acme", userId: "u1" });
    const globex = runEnvironment({ ...LOCAL_TENANT, orgId: "globex", userId: "u2" });
    const saved = process.env.OBJECT_STORE;
    process.env.OBJECT_STORE = "s3";
    constructed.exporters.length = 0;
    constructed.caches.length = 0;
    try {
      buildPipeline(acme, "procedural", {}, RENDERS);
      buildPipeline(globex, "procedural", {}, RENDERS);
      buildPipeline(
        acme,
        "procedural",
        {},
        { campaignId: OTHER_RENDERS.campaignId, slug: RENDERS.slug },
      );
    } finally {
      if (saved === undefined) delete process.env.OBJECT_STORE;
      else process.env.OBJECT_STORE = saved;
    }
    expect(constructed.caches.map((c) => c.prefix)).toEqual([
      "org/acme/cache/",
      "org/globex/cache/",
      "org/acme/cache/",
    ]);
    expect(constructed.exporters.map((e) => e.prefix)).toEqual([
      `org/acme/campaign/${RENDERS.campaignId}/renders/`,
      `org/globex/campaign/${RENDERS.campaignId}/renders/`,
      `org/acme/campaign/${OTHER_RENDERS.campaignId}/renders/`,
    ]);
    // No two of them collide, which is the point of asserting them separately:
    // the org and the campaign are independent axes of the same key.
    expect(new Set(constructed.exporters.map((e) => e.prefix)).size).toBe(3);
  });

  test("under fs the exporter and the cache are today's adapters, unchanged (PT-4e)", () => {
    constructed.exporters.length = 0;
    constructed.caches.length = 0;
    buildPipeline(localEnv(), "procedural");
    expect(constructed.exporters.map((e) => e.kind)).toEqual(["fs"]);
    expect(constructed.caches.map((c) => c.kind)).toEqual(["fs"]);
  });

  test("under OBJECT_STORE=s3 buildPipeline REFUSES to build without a render target (PT-4e)", () => {
    // The fallback this replaces is the worst outcome available: a run under s3
    // would appear to succeed and its output would live on disk, where nothing
    // under s3 can serve it — a report whose every link 404s, found by an
    // operator rather than by a test. So there is no fs fallback at all.
    const saved = process.env.OBJECT_STORE;
    process.env.OBJECT_STORE = "s3";
    constructed.exporters.length = 0;
    try {
      expect(() => buildPipeline(localEnv(), "procedural")).toThrow(
        /Refusing to build a pipeline with no render target.*campaign's uuid/,
      );
    } finally {
      if (saved === undefined) delete process.env.OBJECT_STORE;
      else process.env.OBJECT_STORE = saved;
    }
    // It refused BEFORE choosing an exporter, so nothing was written to disk.
    expect(constructed.exporters).toEqual([]);
  });

  test("under fs the same call with no target is today's build (PT-4e)", () => {
    // No target is not a failure on fs: there is no uuid to key anything by, and
    // the exporter there needs none. Byte-identical to the pre-PT-4e call shape.
    expect(buildPipeline(localEnv(), "procedural")).toBeInstanceOf(GenerateCampaignUseCase);
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

  // PT-4e. `runCampaign` is where the campaign uuid is resolved, ONCE, and where
  // the absence of one is explained. The reachable absence is the CLI: campaign
  // rows are created through the API, so a hand-written YAML brief run under
  // OBJECT_STORE=s3 has never had one — and `bin/generate.ts` reports
  // `error.message` and exits 1, which is why this is a `Result` and not a throw.
  describe("runCampaign under OBJECT_STORE=s3 (PT-4e)", () => {
    /** Rows the stub resolves: one campaign, or none. */
    const withCampaigns = (rows: ReadonlyArray<{ id: string }>): void => {
      setDatabase({
        query: async () => ({ rows: rows as never }),
        exec: async () => undefined,
        transaction: async () => undefined as never,
        end: async () => undefined,
      } as unknown as SqlClient);
    };

    afterEach(() => {
      resetDatabase();
      if (savedStore === undefined) delete process.env.OBJECT_STORE;
      else process.env.OBJECT_STORE = savedStore;
    });

    const savedStore = process.env.OBJECT_STORE;

    test("a run with no campaign row answers a message that leaks no config (fix 2)", async () => {
      process.env.OBJECT_STORE = "s3";
      withCampaigns([]);
      constructed.exporters.length = 0;
      const result = await runCampaign(localEnv(), brief, "procedural");
      expect(result.success).toBe(false);
      if (!result.success) {
        // This string reaches the web through the failed job, so it names the
        // campaign and the org and NOTHING else: not `OBJECT_STORE`, not "the
        // API", not the shape of the host's storage. An app user reading their
        // job list should learn that the campaign is not theirs, not how the
        // server is deployed or which route was supposed to have created it.
        expect(result.error.message).toBe('Campaign "camp" was not found in this organisation.');
        expect(result.error.message).not.toMatch(/OBJECT_STORE|s3|API|bucket|save the brief/i);
      }
      // Refused BEFORE `buildPipeline`, so no exporter was chosen and nothing
      // was written anywhere — a run that cannot be keyed must not half-run.
      expect(constructed.exporters).toEqual([]);
    });

    test("a run WITH a campaign row builds the object exporter and writes nothing to disk", async () => {
      process.env.OBJECT_STORE = "s3";
      withCampaigns([{ id: RENDERS.campaignId }]);
      constructed.exporters.length = 0;
      const result = await runCampaign(localEnv(), brief, "procedural");
      // The report JSON is unchanged by PT-4e, so a successful run still names
      // its renders by the slug-bearing relative path it always did.
      expect(result.success).toBe(true);
      if (result.success) expect(result.value.assets).toHaveLength(6);
      expect(constructed.exporters.map((e) => e.kind)).toEqual(["object"]);
      expect(existsSync(join(dir, "camp"))).toBe(false);
    });

    test("a UUID-ADDRESSED run resolves its target and writes under the campaign's prefix (fix 1)", async () => {
      // `generate.post.ts` gates on `campaignMeta(brief.id)`, which tries a
      // canonical uuid FIRST — so a body brief whose `id` is the uuid is queued
      // and this run happens. It is the end-to-end half of the finding: without
      // the uuid branch `renderTarget` answers `undefined`, and the run is failed
      // with "campaign not found" for a campaign the gate itself named.
      process.env.OBJECT_STORE = "s3";
      withCampaigns([{ id: RENDERS.campaignId }]);
      const memory = new InMemoryObjectStore();
      setObjectStoreClient(memory);
      constructed.exporters.length = 0;
      // The brief's own `id` IS the uuid, so `campaignScoped` builds `<uuid>/…`
      // paths — and those are exactly what the exporter's segment must expect.
      const uuidBrief: CampaignBrief = { ...brief, id: RENDERS.campaignId };
      const result = await runCampaign(localEnv(), uuidBrief, "procedural");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.assets[0]!.outputPath).toBe(`${RENDERS.campaignId}/alpha/1x1.png`);
      }
      // The bytes went to the store, under the uuid prefix, and the exporter was
      // told the uuid is the segment its paths carry.
      expect(constructed.exporters[0]!.prefix).toBe(
        `org/${LOCAL_TENANT.orgId}/campaign/${RENDERS.campaignId}/renders/`,
      );
      expect(constructed.exporters[0]!.segment).toBe(RENDERS.campaignId);
      const keys = (await memory.list("org/")).map((entry) => entry.key);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).not.toContain("/camp/");
        expect(
          key.startsWith(`org/${LOCAL_TENANT.orgId}/campaign/${RENDERS.campaignId}/renders/`),
        ).toBe(true);
      }
      expect(keys).toContain(
        `org/${LOCAL_TENANT.orgId}/campaign/${RENDERS.campaignId}/renders/alpha/1x1.png`,
      );
      // And nothing landed on disk, under EITHER name.
      expect(existsSync(join(dir, "camp"))).toBe(false);
      expect(existsSync(join(dir, RENDERS.campaignId))).toBe(false);
    });

    test("a refused re-roll never touches the database (C5)", async () => {
      // The pins come FIRST: a re-roll refused for a changed plan has already
      // answered the caller, and a tenancy query for a run that is not happening
      // is a decision taken on nothing.
      process.env.OBJECT_STORE = "s3";
      let asked = 0;
      setDatabase({
        query: async () => {
          asked += 1;
          return { rows: [] as never };
        },
        exec: async () => undefined,
        transaction: async () => undefined as never,
        end: async () => undefined,
      } as unknown as SqlClient);
      const refused = await runCampaign(
        localEnv(),
        { ...brief, mode: "variation", variation: { count: 2, seed: 42 } },
        "procedural",
        undefined,
        "a-hash-that-was-never-planned",
      );
      expect(refused.success).toBe(false);
      expect(asked).toBe(0);
    });

    test("under fs a run with no campaign row runs exactly as it always did", async () => {
      // No target is not a failure on fs, and the CLI's `LOCAL_TENANT` has no
      // campaign row of its own — a filesystem deployment must keep working.
      process.env.OBJECT_STORE = "fs";
      setDatabase({
        query: async () => {
          throw new Error("the database must not be asked under OBJECT_STORE=fs");
        },
        exec: async () => undefined,
        transaction: async () => undefined as never,
        end: async () => undefined,
      } as unknown as SqlClient);
      const result = await runCampaign(localEnv(), brief, "procedural");
      expect(result.success).toBe(true);
      if (result.success) expect(existsSync(join(dir, "camp", "alpha", "1x1.png"))).toBe(true);
    });
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
  // environment is returned beside the run so a test passes it explicitly.
  const freshRunCampaign = async (): Promise<{ run: typeof runCampaign; env: RunEnvironment }> => {
    vi.resetModules();
    process.env.PROJECT_ROOT = dir;
    const { runCampaign: fresh } = await import("../pipeline.js");
    const { runEnvironment: freshEnvironment } = await import("../run-environment.js");
    const { LOCAL_TENANT: freshTenant } = await import("../tenant.js");
    return { run: fresh, env: freshEnvironment(freshTenant) };
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
      const { run, env } = await freshRunCampaign();
      const r = await run(env, pooled, "procedural");
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
      const { run, env } = await freshRunCampaign();
      const r = await run(env, pooled, "procedural");
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

  test("runCampaign reads pools from its environment's own root, not the process's (review on #575)", async () => {
    const origRoot = process.env.PROJECT_ROOT;
    const own = mkdtempSync(join(tmpdir(), "cf-pipeline-own-root-"));
    try {
      mkdirSync(join(own, "briefs", "camp"), { recursive: true });
      writeFileSync(
        join(own, "briefs", "camp", "pools.json"),
        JSON.stringify({
          briefId: "camp",
          generatedAt: "2026-01-01T00:00:00.000Z",
          model: "m",
          entries: [{ id: "h1", text: "From my root", status: "approved" }],
        }),
      );
      const pooled: CampaignBrief = {
        ...brief,
        mode: "variation",
        variation: { count: 1, seed: 42, axes: { headline: "pool://copy" } },
      };
      const { run, env } = await freshRunCampaign(); // PROJECT_ROOT is `dir`, which has no pool
      const r = await run({ ...env, assetRoot: own }, pooled, "procedural");
      expect(r.success).toBe(true);
      if (r.success) expect(r.value.assets[0]!.descriptor?.headline).toBe("From my root");
    } finally {
      if (origRoot === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = origRoot;
      rmSync(own, { recursive: true, force: true });
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
      const { run, env } = await freshRunCampaign();
      const compositeAsset = await spyCompositor();
      const r = await run(env, pooled, "procedural");
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
      const { run, env } = await freshRunCampaign();
      const r = await run(env, pooled, "procedural");
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

  test("copyGenerator and buildPipeline respect provider keyOwners (PT-7b3a)", () => {
    const env: RunEnvironment = {
      ...localEnv(),
      providers: {
        geminiKey: "gemini-k",
        openRouterKey: "openrouter-k",
        fireflyClientId: "ff-id",
        fireflyClientSecret: "ff-secret",
        keyOwners: { gemini: "org", openrouter: "org", firefly: "org" },
      },
    };
    const copy = copyGenerator(env);
    expect(copy).toBeDefined();
    expect(copy).toMatchObject({ keyOwner: "org" });

    const pipeline = buildPipeline(env, "imagen");
    expect(pipeline).toBeDefined();
    const fireflyPipeline = buildPipeline(env, "firefly");
    expect(fireflyPipeline).toBeDefined();
    const openRouterPipeline = buildPipeline(env, "x-ai/grok-imagine-image-quality");
    expect(openRouterPipeline).toBeDefined();

    const envWithoutOwners: RunEnvironment = {
      ...localEnv(),
      providers: {
        openRouterKey: "openrouter-k",
        keyOwners: undefined,
      },
    };
    const copyDefault = copyGenerator(envWithoutOwners);
    expect(copyDefault).toBeDefined();
    expect(copyDefault).toMatchObject({ keyOwner: "platform" });
  });

  describe("imageProviderChain and primaryImageProvider (PT-7b3a)", () => {
    const fullProviders = {
      geminiKey: "gem-k",
      openRouterKey: "open-k",
      fireflyClientId: "ff-id",
      fireflyClientSecret: "ff-sec",
    };

    // Walks the constructed generator's metered fallback chain through its private
    // fields, so it reads them as `unknown` and narrows at each step.
    function field(value: unknown, key: string): unknown {
      return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined;
    }

    function meteredProviders(gen: unknown): string[] {
      const result: string[] = [];
      let current = field(gen, "generator") ?? gen;
      let provider = field(current, "provider");
      while (typeof provider === "string") {
        result.push(provider === "imagen" ? "gemini" : provider);
        current = field(field(current, "inner"), "fallback");
        provider = field(current, "provider");
      }
      return result;
    }

    test("imageProviderChain returns correct fallback chain for each selection", () => {
      expect(imageProviderChain("procedural")).toEqual([]);
      expect(imageProviderChain("firefly")).toEqual(["firefly", "gemini", "openrouter"]);
      expect(imageProviderChain("x-ai/grok-imagine-image-quality")).toEqual(["openrouter"]);
      expect(imageProviderChain("foo/bar")).toEqual(["openrouter"]);
      expect(imageProviderChain("imagen")).toEqual(["gemini", "openrouter"]);
      expect(imageProviderChain("auto")).toEqual(["gemini", "openrouter"]);
      expect(imageProviderChain(undefined)).toEqual(["gemini", "openrouter"]);
      expect(imageProviderChain("")).toEqual(["gemini", "openrouter"]);
    });

    test("for each selection, the providers the constructed generator can meter equal the chain, in order", () => {
      const fullEnv: RunEnvironment = {
        ...localEnv(),
        providers: fullProviders,
      };
      const selections = [
        "procedural",
        "firefly",
        "x-ai/grok-imagine-image-quality",
        "imagen",
        "auto",
        undefined,
        "arbitrary-model",
      ];
      for (const selected of selections) {
        const gen = imageGenerator(fullEnv, selected);
        expect(meteredProviders(gen)).toEqual(imageProviderChain(selected));
      }
    });

    test("primaryImageProvider derives the first provider with credentials present", () => {
      const chain = ["firefly", "gemini", "openrouter"] as const;
      expect(primaryImageProvider(chain, fullProviders)).toBe("firefly");
      expect(primaryImageProvider(chain, { geminiKey: "gem-k", openRouterKey: "open-k" })).toBe(
        "gemini",
      );
      expect(primaryImageProvider(chain, { openRouterKey: "open-k" })).toBe("openrouter");
      expect(primaryImageProvider(chain, {})).toBeUndefined();
    });

    test("primaryImageProvider accounts for active org keys alongside platform credentials", () => {
      const emptyPlatform = {};
      expect(primaryImageProvider(imageProviderChain("firefly"), emptyPlatform, ["firefly"])).toBe(
        "firefly",
      );
      expect(
        primaryImageProvider(imageProviderChain("imagen"), emptyPlatform, new Set(["gemini"])),
      ).toBe("gemini");
      expect(
        primaryImageProvider(imageProviderChain("x-ai/grok-imagine-image-quality"), emptyPlatform, [
          "openrouter",
        ]),
      ).toBe("openrouter");
      expect(
        primaryImageProvider(imageProviderChain("x-ai/grok-imagine-image-quality"), emptyPlatform, [
          "gemini",
        ]),
      ).toBeUndefined();
      expect(
        primaryImageProvider(imageProviderChain("procedural"), fullProviders, [
          "firefly",
          "gemini",
        ]),
      ).toBeUndefined();
    });
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
