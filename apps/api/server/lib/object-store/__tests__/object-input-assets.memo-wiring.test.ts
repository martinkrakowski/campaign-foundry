import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { InputAssetPort } from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";

/**
 * Who asks for the memo, and who must not (PT-4d).
 *
 * `ObjectInputAssets`' own suite proves what the flag does. This file proves the
 * thing that would otherwise go unnoticed: WHICH call sites pass it. A memo that
 * nothing opts into is not a slow run, it is the 150-round-trip run with extra
 * code — and a memo passed by the preview route would be worse than none, since
 * that bundle is kept for the life of the process and would serve the bytes a
 * campaign had before its next upload.
 *
 * The class is MOCKED rather than observed, because "is this reader caching?" has
 * no public answer: the memo is a private Map. Asserting it from outside would mean
 * counting store round trips through a database this file does not have.
 */
const built = vi.hoisted(() => [] as Array<{ env: unknown; options: { memo?: boolean } }>);

vi.mock("../object-input-assets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../object-input-assets.js")>();
  return {
    ...actual,
    ObjectInputAssets: class RecordingObjectInputAssets implements InputAssetPort {
      constructor(env: unknown, options: { memo?: boolean } = {}) {
        built.push({ env, options });
      }
      async read(): Promise<undefined> {
        return undefined;
      }
    },
  };
});

const { ObjectInputAssets } = await import("../object-input-assets.js");
const { buildPipeline, imageGenerator, inputAssets } = await import("../../pipeline.js");
const { resetObjectStoreClient, setObjectStoreClient } = await import("../index.js");
const { previewAdapters, resetPreviewAdapters } =
  await import("../../../routes/campaigns/preview-frame.post.js");
const { runEnvironment } = await import("../../run-environment.js");
const { LOCAL_TENANT } = await import("../../tenant.js");

describe("who opts into the per-run memo (PT-4d)", () => {
  const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
  /** Any uuid: the exporters' key builder never sees it from here. */
  const RENDERS = { campaignId: "3f1b7a52-0c4d-4a6e-9b21-5d8e7c6a5b4c", slug: "camp" };

  beforeEach(() => {
    process.env.OBJECT_STORE = "s3";
    // Under s3 the composition root builds an object-store cache and an object
    // exporter, both of which need a client. Installing the fake is what lets
    // this file keep asking about the MEMO without also asking a bucket anything.
    setObjectStoreClient(new InMemoryObjectStore());
    built.length = 0;
    resetPreviewAdapters();
  });

  afterEach(() => {
    resetPreviewAdapters();
    resetObjectStoreClient();
    if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
  });

  const env = () => runEnvironment(LOCAL_TENANT);

  test("buildPipeline — the one caller that asks: its reader dies with the run", () => {
    // The render target is required under s3 (PT-4e): without it there is no
    // campaign uuid to key renders by, and the refusal is at the composition root.
    buildPipeline(env(), "procedural", {}, RENDERS);
    expect(built).toHaveLength(1);
    expect(built[0]!.options.memo).toBe(true);
  });

  test("inputAssets on its own does not: the caller owns the reader's lifetime", () => {
    inputAssets(env());
    expect(built).toHaveLength(1);
    expect(built[0]!.options.memo).toBeUndefined();
  });

  test("imageGenerator's default reader does not", () => {
    imageGenerator(env(), "procedural");
    expect(built).toHaveLength(1);
    expect(built[0]!.options.memo).toBeUndefined();
  });

  test("the preview bundle does NOT: it is kept for the life of the process", () => {
    // The frame cache is keyed on the logoPath string, so an unchanged ref costs
    // nothing there anyway — but a ref that CHANGES (a re-upload under the same
    // name) would be answered from a process-lifetime memo for the rest of the
    // session, and the editor would show the old logo with no error anywhere.
    previewAdapters(env());
    previewAdapters(env());
    expect(built).toHaveLength(1);
    expect(built[0]!.options.memo).toBeUndefined();
    // Same env, same bundle: the port is built once and reused, which is exactly
    // why the flag had to stay off it.
    expect(ObjectInputAssets).toBeDefined();
  });

  test("under fs nothing is built at all — the flag is ignored, not honoured", () => {
    process.env.OBJECT_STORE = "fs";
    buildPipeline(env(), "procedural");
    expect(built).toHaveLength(0);
  });
});
