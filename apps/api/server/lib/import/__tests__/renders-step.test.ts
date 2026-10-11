import { describe, expect, test, vi } from "vitest";
import { ObjectExistsError } from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { renderObjectKey } from "@campaignfoundry/Distribution";
import { renderPrefix } from "../../object-store/object-keys.js";
import { CountingObjects } from "./fixtures/apply-harness.js";
import type { Reviewed } from "../rows-step.js";
import type { MintedObject } from "../steps.js";
import {
  importCampaignRenders,
  importRender,
  importRenders,
  mintedRenders,
  notWrittenRenders,
  reportPaths,
  type RenderObjects,
} from "../renders-step.js";

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

describe("importRenders: the record of each created object", () => {
  const PROOF = "camp/proofs/p1.pdf";
  const PROOF_KEY = `${PREFIX}proofs/p1.pdf`;
  const VIDEO = "camp/p1/9x16.mp4";
  const VIDEO_KEY = `${PREFIX}p1/9x16.mp4`;
  const GONE = "camp/p1/4x5.png";
  const fromPath = async (path: string): Promise<Reviewed> =>
    path === GONE ? { state: "absent" } : { state: "ok", bytes: Buffer.from(path) };

  test("each created object is recorded before the next render is written", async () => {
    const objects = store();
    const seen: string[] = [];
    // A record that takes time: the import must wait for it before its next put.
    const record = async (object: MintedObject): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(`${object.path} ${object.key} after ${objects.putCount} put(s)`);
    };
    const got = await importRenders(objects, CAMPAIGN, [ONE, GONE, PROOF, VIDEO], fromPath, record);
    expect(seen).toEqual([
      `${ONE} ${ONE_KEY} after 1 put(s)`,
      `${PROOF} ${PROOF_KEY} after 2 put(s)`,
      `${VIDEO} ${VIDEO_KEY} after 3 put(s)`,
    ]);
    expect(got.map((result) => `${result.path}:${result.status}`)).toEqual([
      `${ONE}:written`,
      `${GONE}:missing`,
      `${PROOF}:written`,
      `${VIDEO}:written`,
    ]);
  });

  test("only a created object is recorded: skipped, present, refused and failed renders are not", async () => {
    const objects = store();
    // ONE is already stored with the same bytes; GONE has no file and an object.
    await objects.put(ONE_KEY, Buffer.from(ONE), { contentType: "image/png" });
    await objects.put(`${PREFIX}p1/4x5.png`, BYTES, { contentType: "image/png" });
    // Puts so far: 2. ONE is put 3 (refused by the store), PROOF is put 4, VIDEO is put 5.
    objects.failOnNthPut = 5;
    const recorded: MintedObject[] = [];
    const record = async (object: MintedObject): Promise<void> => {
      recorded.push(object);
    };
    const paths = [ONE, GONE, "camp/notes.txt", PROOF, VIDEO];
    const got = await importRenders(objects, CAMPAIGN, paths, fromPath, record);
    expect(got.map((result) => `${result.path}:${result.status}`)).toEqual([
      `${ONE}:skipped`,
      `${GONE}:present`,
      "camp/notes.txt:refused",
      `${PROOF}:written`,
      `${VIDEO}:failed`,
    ]);
    expect(recorded).toEqual([{ key: PROOF_KEY, path: PROOF }]);
  });

  test("a record that cannot be kept stops the import before the next write, and is thrown", async () => {
    const objects = store();
    const record = vi.fn(async (): Promise<void> => {
      throw new Error("the result file is full");
    });
    await expect(
      importRenders(objects, CAMPAIGN, [ONE, PROOF, VIDEO], fromPath, record),
    ).rejects.toThrow("the result file is full");
    expect(record).toHaveBeenCalledTimes(1);
    expect(objects.putCount).toBe(1);
    expect((await objects.list(PREFIX)).map((object) => object.key)).toEqual([ONE_KEY]);
  });
});

describe("reportPaths and notWrittenRenders", () => {
  const PROOF = "camp/proofs/p1.pdf";

  test("the paths are the ones on the rows of the report's assets, each once, in first-seen order", () => {
    const report = {
      outputPath: "camp/on-the-report-itself.png",
      assets: [
        { outputPath: ONE, proofPath: PROOF },
        { outputPath: "camp/p1/4x5.png", proofPath: PROOF, videoPath: "" },
        "not a row",
        { htmlBundlePath: ONE },
      ],
    };
    expect(reportPaths(Buffer.from(JSON.stringify(report)))).toEqual([
      ONE,
      PROOF,
      "camp/p1/4x5.png",
    ]);
  });

  test("bytes that are not JSON, or not a report with rows, name no render", () => {
    expect(reportPaths(Buffer.from("{ not json"))).toEqual([]);
    expect(reportPaths(Buffer.from('["a list"]'))).toEqual([]);
    expect(reportPaths(Buffer.from('{"assets":"none"}'))).toEqual([]);
  });

  test("notWrittenRenders lists each distinct path as refused, with the reason", () => {
    const reason = "not written: this run neither wrote nor skipped the report for camp";
    expect(notWrittenRenders("camp", [ONE, PROOF, ONE])).toEqual([
      { path: ONE, status: "refused", reason },
      { path: PROOF, status: "refused", reason },
    ]);
    expect(notWrittenRenders("camp", [])).toEqual([]);
  });
});

describe("importCampaignRenders", () => {
  const PROOF = "camp/proofs/p1.pdf";
  const PROOF_KEY = `${PREFIX}proofs/p1.pdf`;
  // A path of the old shape: its first segment is a product id, not the campaign's slug.
  const OLD_SHAPE = "city-backpack/1x1/hero.png";
  // The same campaign, written in a way the key builder does not accept.
  const DOTTED = "./camp/p1/4x5.png";
  const NOT_THIS_CAMPAIGN =
    "Refusing an object key: a render path must start with the campaign segment its prefix was built for.";
  const NOT_WRITTEN = "not written: this run neither wrote nor skipped the report for camp";
  const REPORT = Buffer.from(
    JSON.stringify({
      assets: [
        { outputPath: ONE, proofPath: PROOF },
        { outputPath: OLD_SHAPE },
        { outputPath: DOTTED },
      ],
    }),
  );
  const ALL = [ONE, PROOF, OLD_SHAPE, DOTTED];
  type Status = "written" | "skipped" | "refused" | "failed";
  const fromPath = async (path: string): Promise<Reviewed> => ({
    state: "ok",
    bytes: Buffer.from(path),
  });
  const lookup = async (): Promise<string | undefined> => CAMPAIGN.campaignId;
  const input = (reportStatus: Status, reportFile: Reviewed = { state: "ok", bytes: REPORT }) => ({
    orgId: "local",
    slug: "camp",
    reportStatus,
    reportFile,
    campaignId: lookup,
  });
  const recorder = () => {
    const recorded: MintedObject[] = [];
    const record = async (object: MintedObject): Promise<void> => {
      recorded.push(object);
    };
    return { recorded, record };
  };

  test("with a written or a skipped report row the reviewed file's renders are written and each created object is recorded", async () => {
    for (const status of ["written", "skipped"] as const) {
      const objects = store();
      const { recorded, record } = recorder();
      const got = await importCampaignRenders(objects, input(status), fromPath, record);
      expect(got).toEqual([
        { path: ONE, status: "written", key: ONE_KEY },
        { path: PROOF, status: "written", key: PROOF_KEY },
        { path: OLD_SHAPE, status: "refused", reason: NOT_THIS_CAMPAIGN },
        { path: DOTTED, status: "refused", reason: NOT_THIS_CAMPAIGN },
      ]);
      expect(recorded).toEqual([
        { key: ONE_KEY, path: ONE },
        { key: PROOF_KEY, path: PROOF },
      ]);
      expect((await objects.list(PREFIX)).map((object) => object.key).sort()).toEqual(
        [ONE_KEY, PROOF_KEY].sort(),
      );
    }
  });
  test("with a refused or a failed report row every path is listed as not written, and nothing is read, looked up, written or recorded", async () => {
    for (const status of ["refused", "failed"] as const) {
      const objects = store();
      const read = vi.fn(fromPath);
      const campaignId = vi.fn(lookup);
      const record = vi.fn(async (): Promise<void> => {});
      const got = await importCampaignRenders(
        objects,
        { ...input(status), campaignId },
        read,
        record,
      );
      expect(got).toEqual(ALL.map((path) => ({ path, status: "refused", reason: NOT_WRITTEN })));
      expect(read).not.toHaveBeenCalled();
      expect(campaignId).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(objects.putCount).toBe(0);
    }
  });

  test("a report file that is no longer the reviewed one: nothing to list with a refused row, an error before any write with a kept row", async () => {
    const objects = store();
    const record = vi.fn(async (): Promise<void> => {});
    const changed: Reviewed = {
      state: "refused",
      reason: "reports/camp.json changed since the digest",
    };
    const gone: Reviewed = { state: "absent" };
    expect(
      await importCampaignRenders(objects, input("refused", changed), fromPath, record),
    ).toEqual([]);
    await expect(
      importCampaignRenders(objects, input("written", changed), fromPath, record),
    ).rejects.toThrow(
      "reports/camp.json is no longer the reviewed file; none of its renders was written",
    );
    await expect(
      importCampaignRenders(objects, input("skipped", gone), fromPath, record),
    ).rejects.toThrow("reports/camp.json is no longer the reviewed file");
    expect(objects.putCount).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });

  test("a report that names no render asks for no campaign; a campaign the target does not hold is an error before any write", async () => {
    const objects = store();
    const record = vi.fn(async (): Promise<void> => {});
    const empty: Reviewed = { state: "ok", bytes: Buffer.from('{"assets":[]}') };
    const campaignId = vi.fn(lookup);
    expect(
      await importCampaignRenders(
        objects,
        { ...input("written", empty), campaignId },
        fromPath,
        record,
      ),
    ).toEqual([]);
    expect(campaignId).not.toHaveBeenCalled();
    const none = async (): Promise<string | undefined> => undefined;
    await expect(
      importCampaignRenders(objects, { ...input("written"), campaignId: none }, fromPath, record),
    ).rejects.toThrow("the target holds no campaign camp; none of its renders was written");
    expect(objects.putCount).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });
  test("once it has written it never throws: a later failure is a failed render, and what was created before it is recorded", async () => {
    // (a) the store fails on the second put.
    const failing = store();
    failing.failOnNthPut = 2;
    const first = recorder();
    const a = await importCampaignRenders(failing, input("written"), fromPath, first.record);
    expect(a.map((result) => `${result.path}:${result.status}`)).toEqual([
      `${ONE}:written`,
      `${PROOF}:failed`,
    ]);
    expect(first.recorded).toEqual([{ key: ONE_KEY, path: ONE }]);

    // (b) the file reader throws on the second render.
    const second = recorder();
    const breaking = async (path: string): Promise<Reviewed> => {
      if (path === PROOF) throw new Error("the disk went away");
      return { state: "ok", bytes: Buffer.from(path) };
    };
    const b = await importCampaignRenders(store(), input("written"), breaking, second.record);
    expect(b[1]).toEqual({
      path: PROOF,
      status: "failed",
      key: PROOF_KEY,
      reason: "the disk went away",
    });
    expect(second.recorded).toEqual([{ key: ONE_KEY, path: ONE }]);

    // (c) the second key is taken and the read that compares the bytes throws.
    const inner = store();
    await inner.put(PROOF_KEY, OTHER_BYTES, { contentType: "application/pdf" });
    const broken: RenderObjects = {
      put: (key, bytes, options) => inner.put(key, bytes, options),
      head: (key) => inner.head(key),
      get: async () => {
        throw new Error("the store went away");
      },
    };
    const third = recorder();
    const c = await importCampaignRenders(broken, input("skipped"), fromPath, third.record);
    expect(c.map((result) => `${result.path}:${result.status}`)).toEqual([
      `${ONE}:written`,
      `${PROOF}:failed`,
    ]);
    expect(third.recorded).toEqual([{ key: ONE_KEY, path: ONE }]);
  });
});
