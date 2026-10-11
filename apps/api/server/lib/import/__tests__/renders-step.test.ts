import { describe, expect, test, vi } from "vitest";
import { ObjectExistsError } from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { renderObjectKey } from "@campaignfoundry/Distribution";
import { renderPrefix } from "../../object-store/object-keys.js";
import { CountingObjects } from "./fixtures/apply-harness.js";
import type { Reviewed } from "../rows-step.js";
import { importRender, importRenders, mintedRenders, type RenderObjects } from "../renders-step.js";

const CAMPAIGN = {
  orgId: "local",
  campaignId: "11111111-2222-4333-8444-555555555555",
  slug: "camp",
};
const PREFIX = "org/local/campaign/11111111-2222-4333-8444-555555555555/renders/";
const ONE = "camp/p1/1x1.png";
const ONE_KEY = `${PREFIX}p1/1x1.png`;
const BYTES = Buffer.from("the bytes of the first render");
const OTHER_BYTES = Buffer.from("other bytes under the same path");

const ok = (bytes: Buffer) => async (): Promise<Reviewed> => ({ state: "ok", bytes });
const absent = async (): Promise<Reviewed> => ({ state: "absent" });
const store = (): CountingObjects => new CountingObjects(new InMemoryObjectStore());

describe("importRender: the write", () => {
  test("a render is written under the key derived from its report path, with its content type", async () => {
    const objects = store();
    const cases = [
      ["camp/p1/1x1.png", "image/png"],
      ["camp/p1/9x16.mp4", "video/mp4"],
      ["camp/proofs/p1.pdf", "application/pdf"],
    ] as const;
    for (const [path, contentType] of cases) {
      const bytes = Buffer.from(`bytes of ${path}`);
      const got = await importRender(objects, CAMPAIGN, path, ok(bytes));
      const key = renderObjectKey(renderPrefix("local", CAMPAIGN.campaignId), "camp", path);
      expect(got).toEqual({ path, status: "written", key });
      const stored = await objects.get(key);
      expect(Buffer.from(stored!.bytes).equals(bytes)).toBe(true);
      expect(stored!.contentType).toBe(contentType);
    }
    expect((await objects.list(PREFIX)).map((object) => object.key).sort()).toEqual([
      `${PREFIX}p1/1x1.png`,
      `${PREFIX}p1/9x16.mp4`,
      `${PREFIX}proofs/p1.pdf`,
    ]);
  });
});

describe("importRender: an object already at the key", () => {
  test("the same bytes already stored are skipped and the object is left as it was", async () => {
    const objects = store();
    await importRender(objects, CAMPAIGN, ONE, ok(BYTES));
    const before = await objects.list(PREFIX);
    const got = await importRender(objects, CAMPAIGN, ONE, ok(Buffer.from(BYTES)));
    expect(got).toEqual({ path: ONE, status: "skipped", key: ONE_KEY });
    expect(await objects.list(PREFIX)).toEqual(before);
  });

  test("a different render already stored is refused and the stored bytes stay", async () => {
    const objects = store();
    await importRender(objects, CAMPAIGN, ONE, ok(BYTES));
    const got = await importRender(objects, CAMPAIGN, ONE, ok(OTHER_BYTES));
    expect(got).toEqual({
      path: ONE,
      status: "refused",
      key: ONE_KEY,
      reason: "a different render is already stored for this path",
    });
    const stored = await objects.get(ONE_KEY);
    expect(Buffer.from(stored!.bytes).equals(BYTES)).toBe(true);
  });

  test("an object that was there for the write and is gone for the read is refused", async () => {
    const objects: RenderObjects = {
      put: async (key) => {
        throw new ObjectExistsError(key);
      },
      get: async () => undefined,
      head: async () => undefined,
    };
    expect(await importRender(objects, CAMPAIGN, ONE, ok(BYTES))).toEqual({
      path: ONE,
      status: "refused",
      key: ONE_KEY,
      reason: "an object was at this key for the write and is gone for the read",
    });
  });

  test("with no source file an object already there is present and no object is missing; neither writes", async () => {
    const objects = store();
    await objects.put(ONE_KEY, BYTES, { contentType: "image/png" });
    const puts = objects.putCount;
    expect(await importRender(objects, CAMPAIGN, ONE, absent)).toEqual({
      path: ONE,
      status: "present",
      key: ONE_KEY,
    });
    expect(await importRender(objects, CAMPAIGN, "camp/p1/4x5.png", absent)).toEqual({
      path: "camp/p1/4x5.png",
      status: "missing",
      key: `${PREFIX}p1/4x5.png`,
    });
    expect(objects.putCount).toBe(puts);
  });
});

describe("importRender: refused and failed", () => {
  test("a path with no known content type, or outside the campaign, is refused before the file is read", async () => {
    const objects = store();
    const read = vi.fn(ok(BYTES));
    expect(await importRender(objects, CAMPAIGN, "camp/notes.txt", read)).toEqual({
      path: "camp/notes.txt",
      status: "refused",
      reason: "Refusing to export .txt: no content type is defined for it.",
    });
    expect(await importRender(objects, CAMPAIGN, "other/p1/1x1.png", read)).toEqual({
      path: "other/p1/1x1.png",
      status: "refused",
      reason:
        "Refusing an object key: a render path must start with the campaign segment its prefix was built for.",
    });
    const climbing = await importRender(objects, CAMPAIGN, "camp/../other/1x1.png", read);
    expect(climbing.status).toBe("refused");
    expect(read).not.toHaveBeenCalled();
    expect(objects.putCount).toBe(0);
  });

  test("a source file the reader refuses is refused with the reader's reason and nothing is written", async () => {
    const objects = store();
    const read = async (): Promise<Reviewed> => ({
      state: "refused",
      reason: "camp/p1/1x1.png changed since the digest",
    });
    expect(await importRender(objects, CAMPAIGN, ONE, read)).toEqual({
      path: ONE,
      status: "refused",
      key: ONE_KEY,
      reason: "camp/p1/1x1.png changed since the digest",
    });
    expect(objects.putCount).toBe(0);
  });

  test("a store or a reader that throws is the render failed, with its key, and is never thrown", async () => {
    const objects = store();
    objects.failOnNthPut = 1;
    expect(await importRender(objects, CAMPAIGN, ONE, ok(BYTES))).toEqual({
      path: ONE,
      status: "failed",
      key: ONE_KEY,
      reason: "injected",
    });
    expect(await objects.get(ONE_KEY)).toBeUndefined();
    const broken = async (): Promise<Reviewed> => {
      throw new Error("the disk went away");
    };
    expect(await importRender(objects, CAMPAIGN, ONE, broken)).toEqual({
      path: ONE,
      status: "failed",
      key: ONE_KEY,
      reason: "the disk went away",
    });
  });
});

describe("importRenders", () => {
  const PROOF = "camp/proofs/p1.pdf";
  const VIDEO = "camp/p1/9x16.mp4";
  const GONE = "camp/p1/4x5.png";
  const NEVER = "camp/p1/16x9.png";
  const fromPath = async (path: string): Promise<Reviewed> =>
    path === GONE ? { state: "absent" } : { state: "ok", bytes: Buffer.from(path) };

  test("each distinct path is imported once, in first-seen order, and the written ones are the minted ones", async () => {
    const objects = store();
    const read = vi.fn(fromPath);
    const got = await importRenders(objects, CAMPAIGN, [ONE, PROOF, VIDEO, PROOF, ONE], read);
    expect(got.map((result) => `${result.path}:${result.status}`)).toEqual([
      `${ONE}:written`,
      `${PROOF}:written`,
      `${VIDEO}:written`,
    ]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(objects.putCount).toBe(3);
    expect(mintedRenders(got)).toEqual([
      { key: ONE_KEY, path: ONE },
      { key: `${PREFIX}proofs/p1.pdf`, path: PROOF },
      { key: `${PREFIX}p1/9x16.mp4`, path: VIDEO },
    ]);
  });

  test("a failed render stops the campaign's renders, and a failed or missing render is never listed as minted", async () => {
    const objects = store();
    objects.failOnNthPut = 2;
    const read = vi.fn(fromPath);
    const got = await importRenders(objects, CAMPAIGN, [ONE, GONE, VIDEO, NEVER], read);
    expect(got.map((result) => `${result.path}:${result.status}`)).toEqual([
      `${ONE}:written`,
      `${GONE}:missing`,
      `${VIDEO}:failed`,
    ]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(mintedRenders(got)).toEqual([{ key: ONE_KEY, path: ONE }]);
    expect(await objects.get(`${PREFIX}p1/16x9.png`)).toBeUndefined();
  });
});
