import { describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import {
  predictRender,
  predictRenders,
  rendersNotWritten,
  type RenderHead,
  type RenderStat,
} from "../renders-plan.js";

const ID = "11111111-2222-4333-8444-555555555555";
const CAMP = { orgId: "local", slug: "camp" };
const HERE = { ...CAMP, campaignId: ID };
const NOT_YET = { ...CAMP, campaignId: undefined };
const PREFIX = `org/local/campaign/${ID}/renders/`;
const ONE = "camp/p1/1x1.png";
const ONE_KEY = `${PREFIX}p1/1x1.png`;
const PROOF = "camp/proofs/p1.pdf";
const VIDEO = "camp/p1/9x16.mp4";
const SYMLINK = "camp/p1/1x1.png is a symlink; the importer never follows one";

/** A file check that answers a reviewed file of `size` bytes, whatever the path. */
const file =
  (size: number): RenderStat =>
  async () => ({ state: "ok", rel: ONE, file: "/unused", size, dev: 1, ino: 1 });
const absent: RenderStat = async () => ({ state: "absent" });
const refusedFile: RenderStat = async () => ({ state: "refused", reason: SYMLINK });
/** A store that must not be asked. */
const NO_HEAD: RenderHead = {
  head: async () => {
    throw new Error("head was called");
  },
};

/** A store holding one object of `size` bytes at ONE_KEY. */
async function holding(size: number): Promise<InMemoryObjectStore> {
  const objects = new InMemoryObjectStore();
  await objects.put(ONE_KEY, Buffer.alloc(size, 1), { contentType: "image/png" });
  return objects;
}

describe("predictRender: a campaign the target holds", () => {
  test("a reviewed file is a write with no object at its key, already there with one of its size, refused with one of another size", async () => {
    expect(await predictRender(new InMemoryObjectStore(), HERE, ONE, file(7))).toEqual({
      path: ONE,
      predicted: "write",
      key: ONE_KEY,
    });
    expect(await predictRender(await holding(7), HERE, ONE, file(7))).toEqual({
      path: ONE,
      predicted: "already-there",
      key: ONE_KEY,
    });
    expect(await predictRender(await holding(9), HERE, ONE, file(7))).toEqual({
      path: ONE,
      predicted: "refuse",
      key: ONE_KEY,
      reason:
        "a render of another size is already stored for this path (stored 9 bytes, the file 7 bytes)",
    });
  });

  test("with no source file an object at the key is present and no object is missing", async () => {
    expect(await predictRender(await holding(7), HERE, ONE, absent)).toEqual({
      path: ONE,
      predicted: "present",
      key: ONE_KEY,
    });
    expect(await predictRender(new InMemoryObjectStore(), HERE, ONE, absent)).toEqual({
      path: ONE,
      predicted: "missing",
      key: ONE_KEY,
    });
  });

  test("the store is asked for the head of the key, once, and for nothing else", async () => {
    const head = vi.fn(async () => ({ size: 7 }));
    const objects: RenderHead = { head };
    const got = await predictRender(objects, HERE, ONE, file(7));
    expect(got.predicted).toBe("already-there");
    expect(head.mock.calls).toEqual([[ONE_KEY]]);
  });
});

describe("predictRender: no campaign yet, refused paths and files, failures", () => {
  test("for a campaign the target does not hold yet the store is not asked and no key is shown", async () => {
    expect(await predictRender(NO_HEAD, NOT_YET, ONE, file(7))).toEqual({
      path: ONE,
      predicted: "write",
    });
    expect(await predictRender(NO_HEAD, NOT_YET, ONE, absent)).toEqual({
      path: ONE,
      predicted: "missing",
    });
  });

  test("a path with no known content type, or outside the campaign, is path-refused before the file is looked at", async () => {
    const stat = vi.fn(file(7));
    for (const campaign of [HERE, NOT_YET]) {
      expect(await predictRender(NO_HEAD, campaign, "camp/notes.txt", stat)).toEqual({
        path: "camp/notes.txt",
        predicted: "path-refused",
        reason: "Refusing to export .txt: no content type is defined for it.",
      });
      expect(await predictRender(NO_HEAD, campaign, "other/p1/1x1.png", stat)).toEqual({
        path: "other/p1/1x1.png",
        predicted: "path-refused",
        reason:
          "Refusing an object key: a render path must start with the campaign segment its prefix was built for.",
      });
    }
    expect(stat).not.toHaveBeenCalled();
  });

  test("a source file the import would refuse is predicted refuse with that reason, and the store is not asked", async () => {
    expect(await predictRender(NO_HEAD, HERE, ONE, refusedFile)).toEqual({
      path: ONE,
      predicted: "refuse",
      key: ONE_KEY,
      reason: SYMLINK,
    });
  });

  test("a store or a file check that throws is the render failed, with its reason, and never thrown", async () => {
    expect(await predictRender(NO_HEAD, HERE, ONE, file(7))).toEqual({
      path: ONE,
      predicted: "failed",
      key: ONE_KEY,
      reason: "head was called",
    });
    const broken: RenderStat = async () => {
      throw new Error("the disk went away");
    };
    expect(await predictRender(NO_HEAD, NOT_YET, ONE, broken)).toEqual({
      path: ONE,
      predicted: "failed",
      reason: "the disk went away",
    });
  });
});

describe("predictRenders and rendersNotWritten", () => {
  test("each distinct path is predicted once, in first-seen order, and the campaign is looked up once", async () => {
    const lookup = vi.fn(async () => ID);
    const got = await predictRenders(
      new InMemoryObjectStore(),
      CAMP,
      lookup,
      [ONE, PROOF, VIDEO, PROOF, ONE],
      file(7),
    );
    expect(got.map((render) => `${render.path}:${render.predicted}`)).toEqual([
      `${ONE}:write`,
      `${PROOF}:write`,
      `${VIDEO}:write`,
    ]);
    expect(got[0]).toEqual({ path: ONE, predicted: "write", key: ONE_KEY });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test("a failed prediction stops the campaign's renders, and a refused one does not", async () => {
    let heads = 0;
    const objects: RenderHead = {
      head: async () => {
        heads++;
        if (heads === 2) throw new Error("injected");
        return undefined;
      },
    };
    const paths = ["camp/notes.txt", ONE, PROOF, VIDEO];
    const got = await predictRenders(objects, CAMP, async () => ID, paths, file(7));
    expect(got.map((render) => `${render.path}:${render.predicted}`)).toEqual([
      "camp/notes.txt:path-refused",
      `${ONE}:write`,
      `${PROOF}:failed`,
    ]);
  });

  test("a campaign lookup that throws is the first render failed; with no path nothing is asked", async () => {
    const broken = async (): Promise<string | undefined> => {
      throw new Error("no database");
    };
    expect(await predictRenders(NO_HEAD, CAMP, broken, [ONE, PROOF], file(7))).toEqual([
      { path: ONE, predicted: "failed", reason: "no database" },
    ]);
    const lookup = vi.fn(async () => ID);
    expect(await predictRenders(NO_HEAD, CAMP, lookup, [], file(7))).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  test("rendersNotWritten lists each distinct path as refuse, with the reason", () => {
    const reason = "not written: this run would neither write nor skip the report for camp";
    expect(rendersNotWritten("camp", [ONE, PROOF, ONE])).toEqual([
      { path: ONE, predicted: "refuse", reason },
      { path: PROOF, predicted: "refuse", reason },
    ]);
  });
});
