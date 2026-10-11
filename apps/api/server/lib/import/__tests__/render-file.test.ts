import { lstatSync, mkdirSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fingerprint } from "../digest.js";
import {
  MAX_RENDER_BYTES,
  readReviewedRender,
  renderFingerprints,
  statReviewedRender,
} from "../render-file.js";
import { dropRoot, linkAt, makeRoot, writeAt } from "./fixtures/tree.js";

const ONE = "camp/p1/1x1.png";
const BYTES = Buffer.from("the bytes of the first render");
const OLD = new Date("2001-09-09T01:46:40.000Z");
const CHANGED = { state: "refused", reason: `${ONE} changed since the digest` };

let output: string;
beforeEach(() => {
  output = makeRoot();
});
afterEach(() => {
  dropRoot(output);
});

/** Write a render under the output root; answers its stamp, as the reviewed digest would hold it. */
function render(rel: string, bytes: Buffer | string = BYTES): string {
  return fingerprint(lstatSync(writeAt(output, rel, bytes)));
}
const stamps = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries));

describe("readReviewedRender: the reviewed stamp", () => {
  test("a render whose size and time are the reviewed stamp is read whole", async () => {
    const reviewed = stamps({ [ONE]: render(ONE) });
    const got = await readReviewedRender(output, ONE, reviewed);
    expect(got).toEqual({ state: "ok", bytes: BYTES });
    expect(await statReviewedRender(output, ONE, reviewed)).toEqual({
      state: "ok",
      rel: ONE,
      file: join(output, ONE),
      size: BYTES.length,
    });
  });

  test("a render whose time or size differs from the reviewed stamp is refused and never read", async () => {
    const read = vi.fn(async () => BYTES);
    const file = join(output, ONE);
    const reviewed = stamps({ [ONE]: render(ONE) });
    // The same size, another time.
    utimesSync(file, OLD, OLD);
    expect(await readReviewedRender(output, ONE, reviewed, { read })).toEqual(CHANGED);
    // The same time, another size.
    const sameTime = stamps({ [ONE]: fingerprint(lstatSync(file)) });
    writeFileSync(file, Buffer.concat([BYTES, BYTES]));
    utimesSync(file, OLD, OLD);
    expect(await readReviewedRender(output, ONE, sameTime, { read })).toEqual(CHANGED);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("readReviewedRender: a file that is not there, or that the digest does not name", () => {
  test("a file that is not there is absent, unless the digest named it: then it changed", async () => {
    expect(await readReviewedRender(output, ONE, stamps({}))).toEqual({ state: "absent" });
    const named = stamps({ [ONE]: "size:4:mtime:1000" });
    expect(await readReviewedRender(output, ONE, named)).toEqual(CHANGED);
  });

  test("a file the digest does not name is refused", async () => {
    render(ONE);
    expect(await readReviewedRender(output, ONE, stamps({}))).toEqual({
      state: "refused",
      reason: `${ONE} is not in the reviewed digest`,
    });
  });
});

describe("readReviewedRender: confined to the output root", () => {
  test("a path that leaves the output root is refused", async () => {
    for (const path of ["../outside.png", "/etc/passwd", "camp/../../outside.png", ""]) {
      expect(await readReviewedRender(output, path, stamps({}))).toEqual({
        state: "refused",
        reason: "Path escapes the allowed directory.",
      });
    }
  });

  test("a directory, and a path that goes through a file, are refused", async () => {
    render(ONE);
    mkdirSync(join(output, "camp/p1/dir.png"));
    expect(await readReviewedRender(output, "camp/p1/dir.png", stamps({}))).toEqual({
      state: "refused",
      reason: "camp/p1/dir.png is not a regular file.",
    });
    const through = await readReviewedRender(output, `${ONE}/x.png`, stamps({}));
    expect(through.state).toBe("refused");
    expect(through.state === "refused" && through.reason).toMatch(/ENOTDIR/);
  });
});

describe("readReviewedRender: never through a symlink", () => {
  test("a symlinked file is refused as a link, although its own stamp is the reviewed one", async () => {
    const target = writeAt(output, "elsewhere/real.png", BYTES);
    const link = linkAt(output, "camp/p1/link.png", target);
    const reviewed = stamps({ "camp/p1/link.png": fingerprint(lstatSync(link)) });
    expect(await readReviewedRender(output, "camp/p1/link.png", reviewed)).toEqual({
      state: "refused",
      reason: "camp/p1/link.png is a symlink; the importer never follows one",
    });
  });

  test("a file under a symlinked directory is refused, although its stamp is the reviewed one", async () => {
    writeAt(output, "elsewhere/p9/1x1.png", BYTES);
    linkAt(output, "camp/linked", join(output, "elsewhere/p9"));
    const viaLink = "camp/linked/1x1.png";
    const reviewed = stamps({ [viaLink]: fingerprint(lstatSync(join(output, viaLink))) });
    expect(await readReviewedRender(output, viaLink, reviewed)).toEqual({
      state: "refused",
      reason: "camp/linked is a symlinked directory; the importer never follows one",
    });
  });
});

describe("readReviewedRender: the size cap and the read", () => {
  test("a render over the cap is refused with its size and never read; one at the cap is read", async () => {
    const read = vi.fn(async () => BYTES);
    const reviewed = stamps({
      "camp/p1/five.mp4": render("camp/p1/five.mp4", "12345"),
      "camp/p1/four.mp4": render("camp/p1/four.mp4", "1234"),
    });
    const over = await readReviewedRender(output, "camp/p1/five.mp4", reviewed, {
      maxBytes: 4,
      read,
    });
    expect(over).toEqual({
      state: "refused",
      reason: "camp/p1/five.mp4 is 5 bytes; the render cap is 4 bytes.",
    });
    expect(read).not.toHaveBeenCalled();
    const atCap = await readReviewedRender(output, "camp/p1/four.mp4", reviewed, { maxBytes: 4 });
    expect(atCap).toEqual({ state: "ok", bytes: Buffer.from("1234") });
  });

  test("with no cap given the cap is 512 MiB", async () => {
    expect(MAX_RENDER_BYTES).toBe(536_870_912);
    const big = "camp/p1/big.mp4";
    const file = writeAt(output, big, "");
    // A sparse file: it has the size, and no byte of it is written or read.
    truncateSync(file, MAX_RENDER_BYTES + 1);
    const read = vi.fn(async () => BYTES);
    const reviewed = stamps({ [big]: fingerprint(lstatSync(file)) });
    expect(await readReviewedRender(output, big, reviewed, { read })).toEqual({
      state: "refused",
      reason: `${big} is 536870913 bytes; the render cap is 536870912 bytes.`,
    });
    expect(read).not.toHaveBeenCalled();
  });

  test("bytes that are not the reviewed size, and a read that fails, are refused and never thrown", async () => {
    const reviewed = stamps({ [ONE]: render(ONE) });
    const short = async (): Promise<Buffer> => Buffer.from("short");
    expect(await readReviewedRender(output, ONE, reviewed, { read: short })).toEqual({
      state: "refused",
      reason: `${ONE} changed while it was read`,
    });
    const broken = async (): Promise<Buffer> => {
      throw new Error("the disk went away");
    };
    expect(await readReviewedRender(output, ONE, reviewed, { read: broken })).toEqual({
      state: "refused",
      reason: "the disk went away",
    });
  });
});

describe("renderFingerprints", () => {
  test("keeps the stamped entries of a digest's files, keyed by where each sits under its root", () => {
    const files = [
      { rel: "briefs/camp.yaml", sha256: "ab" },
      { rel: ONE, fingerprint: "size:4:mtime:1000" },
    ];
    expect([...renderFingerprints(files)]).toEqual([[ONE, "size:4:mtime:1000"]]);
  });
});
