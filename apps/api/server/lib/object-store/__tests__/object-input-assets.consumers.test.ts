import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import {
  AspectRatio,
  type AspectRatio as AspectRatioValue,
  type CompositeRequest,
  type CopyTimeline,
  type InputAssetPort,
  type VideoCompositeRequest,
} from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import {
  AssetReusingImageGenerator,
  CanvasFfmpegVideoCompositor,
  FileSystemAudioAssetResolver,
  FileSystemInputAssets,
  FileSystemSceneAssetResolver,
  NodeCanvasCompositor,
  ProceduralBackgroundGenerator,
  type FfmpegSpawn,
} from "@campaignfoundry/CreativeGeneration";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../index.js";
import { ObjectInputAssets } from "../object-input-assets.js";
import { S3RequestError } from "../S3ObjectStore.js";
import { resetAssetStore } from "../../ports/index.js";
import { ObjectAssetStore } from "../../ports/object-asset-store.js";
import type { RunEnvironment } from "../../run-environment.js";

/**
 * The five consumers' THREE outcomes, on both backends, side by side (PT-4d).
 *
 * Each consumer's failure policy is written against exactly three answers —
 * `undefined`, ENOENT, and any other failure — and none of them knows which
 * backend produced it. So every case here runs the SAME consumer on the SAME ref
 * string through fs and through the object port and asserts the answers are
 * identical: the same warning or silence, the same rejection message, the same
 * fall-through. A consumer that could tell the two apart would show up here as a
 * diff, not as a broken render.
 */

const ORG = "local";
const SLUG = "winter-sale";
/** No campaign, no row, no object: fs ENOENT, and the same from the object port. */
const MISSING = "assets/inputs/absent/logo.png";
/** A campaign and a row that DO exist, so a store that refuses is reached. */
const PRESENT = `assets/inputs/${SLUG}/logo.png`;
/** The ref `resolveAssetPath` refuses on both backends. */
const UNSAFE = "../escape.png";
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type Outcome = "undefined" | "enoent" | "refusal";
const OUTCOMES: readonly Outcome[] = ["undefined", "enoent", "refusal"];

/** A ref and the reader that answers `outcome` for it. */
interface Case {
  readonly port: InputAssetPort;
  readonly ref: string;
}

/** A store whose every `get` throws: the `EACCES` fs's refusal stands in for. */
class RefusingStore extends InMemoryObjectStore {
  constructor(private readonly error: Error) {
    super();
  }
  override async get(): Promise<never> {
    throw this.error;
  }
}

const ratio = (value = "1:1"): AspectRatioValue => {
  const made = AspectRatio.create(value);
  if (!made.success) throw made.error;
  return made.value;
};

const timeline: CopyTimeline = {
  beats: [{ text: "Hi", weight: 1 }],
  transition: "fade",
  // 1-based: `resolveBeatLayouts` indexes `beats[keyBeat - 1]`, so 0 is out of
  // range and the compositor refuses the request before it reads a logo.
  keyBeat: 1,
};

/** Both composite shapes, so a logo ref reaches the same catch in either adapter. */
const request = (logoPath: string): CompositeRequest => ({
  background: createCanvas(64, 64).toBuffer("image/png"),
  message: "Hi",
  brandColor: "#1473E6",
  logoPath,
  canvas: { ratio: "1:1" },
  layout: "headline-bottom",
  tone: "bold",
});

const videoRequest = (logoPath: string): VideoCompositeRequest => ({
  background: createCanvas(64, 64).toBuffer("image/png"),
  message: "Hi",
  brandColor: "#1473E6",
  logoPath,
  canvas: { ratio: "1:1" },
  pixelSize: { width: 64, height: 64 },
  layout: "headline-bottom",
  tone: "bold",
  durationSec: 2,
  fps: 12,
  motion: "ken-burns-in",
  sampleAt: [],
  timeline,
});

/** The rejection a consumer produced, reduced to what it says about the failure. */
async function refusal(work: () => Promise<unknown>): Promise<{
  message: string;
  code: string | undefined;
  causeCode: string | undefined;
}> {
  const codeOf = (value: unknown): string | undefined => {
    const code = (value as { code?: unknown } | undefined)?.code;
    return typeof code === "string" ? code : undefined;
  };
  try {
    await work();
  } catch (error) {
    return {
      message: (error as Error).message,
      code: codeOf(error),
      // The scene and audio resolvers wrap the port's failure and hang the
      // original on `cause` (PT-4c) — that is where the `code` a run's log is
      // read for actually is, so it is read from there.
      causeCode: codeOf((error as Error).cause),
    };
  }
  return { message: "", code: undefined, causeCode: undefined };
}

/**
 * Only the LOGO's warnings, out of everything on `console.warn`.
 *
 * `loadEnv()` prints one "no GenAI keys detected" notice the first time anything
 * reads the environment, which under `s3` is whichever draw first reaches the
 * object store — a different draw on every backend, and unrelated to a logo. What
 * the compositor's policy decides is whether IT reports, so that is what is
 * counted.
 */
const logoWarnings = (calls: unknown[][]): string[] =>
  calls.map((call) => String(call[0])).filter((line) => line.includes("could not be applied"));

const product = (inputAsset: string) => ({
  id: "p1",
  name: "P1",
  primaryColor: "#1473E6",
  logoPath: UNSAFE,
  inputAsset,
});

describe("the five consumers under s3 answer exactly as under fs (PT-4d)", () => {
  let db: SqlClient;
  let dir: string;
  let broken: string;
  let fsCases: Record<Outcome, Case>;
  let s3Cases: Record<Outcome, Case>;
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;

  const env: RunEnvironment = {
    tenant: { orgId: ORG, userId: "u", roles: [], teamIds: [] },
    // `assetRoot` is not read under s3 — it is on the type, and a fixed value is
    // honest about that rather than silently depending on a mkdtemp that has not
    // happened yet.
    outputRoot: "/tmp/pt-4d-consumers-output",
    assetRoot: "/tmp/pt-4d-consumers-assets",
    messageFont: "Inter",
    providers: {},
  };

  beforeEach(async () => {
    process.env.OBJECT_STORE = "s3";
    dir = mkdtempSync(join(tmpdir(), "pt-4d-consumers-"));
    broken = mkdtempSync(join(tmpdir(), "pt-4d-broken-"));
    // fs's three answers, all offline: `assets/` empty so the ref is simply
    // absent, and `assets` a FILE so the read fails `ENOTDIR` instead.
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(broken, "assets"), "not a directory");
    fsCases = {
      undefined: { port: new FileSystemInputAssets(dir), ref: UNSAFE },
      enoent: { port: new FileSystemInputAssets(dir), ref: MISSING },
      refusal: { port: new FileSystemInputAssets(broken), ref: PRESENT },
    };
    db = await migratedDatabase();
    setDatabase(db);
    const store = new InMemoryObjectStore();
    setObjectStoreClient(store);
    resetAssetStore();
    await db.query(`insert into campaign (org_id, slug) values ($1, $2)`, [ORG, SLUG]);
    await new ObjectAssetStore(db, store, ORG).writeAsset(SLUG, "logo.png", ONE_PX_PNG);
    s3Cases = {
      undefined: { port: new ObjectInputAssets(env), ref: UNSAFE },
      enoent: { port: new ObjectInputAssets(env), ref: MISSING },
      refusal: { port: new ObjectInputAssets(env), ref: PRESENT },
    };
  });

  afterEach(async () => {
    resetAssetStore();
    resetObjectStoreClient();
    resetDatabase();
    vi.restoreAllMocks();
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
    await db.end();
    rmSync(dir, { recursive: true, force: true });
    rmSync(broken, { recursive: true, force: true });
  });

  /** A run with `s3Cases.refusal`'s store refusing, so the object port propagates it. */
  const refusingCase = async (): Promise<Case> => {
    resetAssetStore();
    setObjectStoreClient(new RefusingStore(new S3RequestError("get", 500)));
    return { port: new ObjectInputAssets(env), ref: PRESENT };
  };

  describe("NodeCanvasCompositor — the logo warns on a refusal and skips a missing one", () => {
    const draw = async ({ port, ref }: Case) => {
      vi.restoreAllMocks();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await new NodeCanvasCompositor("Inter", port).compositeAsset(request(ref));
      return { applied: result.logoApplied, warnings: logoWarnings(warn.mock.calls) };
    };

    test("all three outcomes agree with fs, including the warning", async () => {
      for (const outcome of OUTCOMES) {
        const fs = await draw(fsCases[outcome]);
        const s3 =
          outcome === "refusal" ? await draw(await refusingCase()) : await draw(s3Cases[outcome]);
        expect(s3.applied, outcome).toBe(fs.applied);
        expect(s3.warnings.length, outcome).toBe(fs.warnings.length);
        // Only a REFUSAL is reported, on both backends: a missing logo is a
        // template that simply omits one, not an error worth a warning per cell.
        expect(s3.warnings.length, outcome).toBe(outcome === "refusal" ? 1 : 0);
      }
    });

    test("the object store's refusal is named in the warning the operator sees", async () => {
      const { warnings } = await draw(await refusingCase());
      expect(warnings[0]).toContain("could not be applied");
      expect(warnings[0]).toContain("object store");
    });
  });

  describe("CanvasFfmpegVideoCompositor — the same logo policy, through prepare", () => {
    const draw = async ({ port, ref }: Case) => {
      vi.restoreAllMocks();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const compositor = new CanvasFfmpegVideoCompositor({
        // `compositeFrame` draws one frame and never encodes, so no ffmpeg here:
        // spawning one would test the host, not the read.
        spawn: (() => {
          throw new Error("compositeFrame must not spawn ffmpeg");
        }) as FfmpegSpawn,
        ffmpegPath: null,
        inputs: port,
      });
      const frame = await compositor.compositeFrame(videoRequest(ref), 1);
      return { applied: frame.logoApplied, warnings: logoWarnings(warn.mock.calls).length };
    };

    test("all three outcomes agree with fs", async () => {
      for (const outcome of OUTCOMES) {
        const fs = await draw(fsCases[outcome]);
        const s3 =
          outcome === "refusal" ? await draw(await refusingCase()) : await draw(s3Cases[outcome]);
        expect(s3.applied, outcome).toBe(fs.applied);
        expect(s3.warnings, outcome).toBe(fs.warnings);
      }
    });
  });

  describe("FileSystemSceneAssetResolver — the message and its cause", () => {
    const resolve = (c: Case) => () =>
      new FileSystemSceneAssetResolver(c.port).resolveScene(c.ref, ratio());

    test("all three outcomes agree with fs, cause included", async () => {
      for (const outcome of OUTCOMES) {
        const fs = await refusal(resolve(fsCases[outcome]));
        const s3 = await refusal(
          resolve(outcome === "refusal" ? await refusingCase() : s3Cases[outcome]),
        );
        expect(s3.message, outcome).toBe(fs.message);
        if (outcome === "refusal") {
          // The codes are NOT the same and must not be: fs's `ENOTDIR` and the
          // store's `S3RequestError` are different failures. What has to agree is
          // that neither claims the asset was never uploaded — that is what makes
          // the logo warn instead of skipping, and it is what tells a run's log to
          // blame the deployment rather than the brief.
          expect(fs.causeCode, outcome).not.toBe("ENOENT");
          expect(s3.causeCode, outcome).not.toBe("ENOENT");
        } else {
          expect(s3.causeCode, outcome).toBe(fs.causeCode);
        }
      }
    });

    test("the two safe outcomes are told apart by message and by cause", async () => {
      // The message an operator reads is the difference between "your brief named
      // a path that is not an asset" and "that asset is not there".
      const unsafe = await refusal(resolve(s3Cases.undefined));
      expect(unsafe.message).toBe(`Scene "${UNSAFE}" is not a valid asset path.`);
      expect(unsafe.causeCode).toBeUndefined();
      const enoent = await refusal(resolve(s3Cases.enoent));
      expect(enoent.message).toBe(`Scene "${MISSING}" could not be read.`);
      expect(enoent.causeCode).toBe("ENOENT");
      const refused = await refusal(resolve(await refusingCase()));
      expect(refused.message).toBe(`Scene "${PRESENT}" could not be read.`);
      expect(refused.causeCode).not.toBe("ENOENT");
    });
  });

  describe("FileSystemAudioAssetResolver — the message and its cause", () => {
    const resolve = (c: Case) => () => new FileSystemAudioAssetResolver(c.port).resolveAudio(c.ref);

    test("all three outcomes agree with fs", async () => {
      for (const outcome of OUTCOMES) {
        const fs = await refusal(resolve(fsCases[outcome]));
        const s3 = await refusal(
          resolve(outcome === "refusal" ? await refusingCase() : s3Cases[outcome]),
        );
        expect(s3.message, outcome).toBe(fs.message);
      }
    });

    test("a safe ref with no object says ENOENT, not 'not a valid asset path'", async () => {
      const enoent = await refusal(resolve(s3Cases.enoent));
      expect(enoent.message).toBe(`Audio "${MISSING}" could not be read.`);
      expect(enoent.causeCode).toBe("ENOENT");
      const unsafe = await refusal(resolve(s3Cases.undefined));
      expect(unsafe.message).toBe(`Audio "${UNSAFE}" is not a valid asset path.`);
    });
  });

  describe("AssetReusingImageGenerator — every outcome falls through to generation", () => {
    const resolve = async ({ port, ref }: Case) => {
      const generator = new AssetReusingImageGenerator(
        new ProceduralBackgroundGenerator(),
        port,
      ).resolveBackground(product(ref), ratio(), {
        campaignMessage: "Hi",
        targetAudience: "a",
        targetRegion: "DE",
      });
      const result = await generator;
      return result.source;
    };

    test("all three outcomes agree with fs: never 'reused', never a throw", async () => {
      for (const outcome of OUTCOMES) {
        const fs = await resolve(fsCases[outcome]);
        const s3 =
          outcome === "refusal"
            ? await resolve(await refusingCase())
            : await resolve(s3Cases[outcome]);
        expect(s3, outcome).toBe(fs);
        expect(s3, outcome).toBe("procedural");
      }
    });

    test("a logo that DOES exist is reused — the fall-through above is not a silent skip", async () => {
      // Without this the three cases above would pass against a port that never
      // returns bytes at all.
      const result = await new AssetReusingImageGenerator(
        new ProceduralBackgroundGenerator(),
        new ObjectInputAssets(env),
      ).resolveBackground(product(PRESENT), ratio(), {
        campaignMessage: "Hi",
        targetAudience: "a",
        targetRegion: "DE",
      });
      expect(result.source).toBe("reused");
    });
  });
});
