import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { open as openFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/** An `open` for the reader that first does `before`: a change made after the reader's check. */
const openAfter = (before: (file: string) => void) =>
  vi.fn(async (file: string, flags: number) => {
    before(file);
    return openFile(file, flags);
  });
/** An `open` whose file answers the stat taken at open; `after` then changes the file under it. */
const openThen = (after: (file: string) => void) =>
  vi.fn(async (file: string, flags: number) => {
    const fh = await openFile(file, flags);
    const st = await fh.stat();
    after(file);
    return Object.assign(fh, { stat: async () => st });
  });

describe("readReviewedRender: the reviewed stamp", () => {
  test("a render whose size and time are the reviewed stamp is read whole", async () => {
    const reviewed = stamps({ [ONE]: render(ONE) });
    const got = await readReviewedRender(output, ONE, reviewed);
    expect(got).toEqual({ state: "ok", bytes: BYTES });
    expect(await statReviewedRender(output, ONE, reviewed)).toMatchObject({
      state: "ok",
      rel: ONE,
      file: join(output, ONE),
      size: BYTES.length,
    });
  });

  test("a render whose time or size differs from the reviewed stamp is refused and never read", async () => {
    const open = openAfter(() => undefined);
    const file = join(output, ONE);
    const reviewed = stamps({ [ONE]: render(ONE) });
    // The same size, another time.
    utimesSync(file, OLD, OLD);
    expect(await readReviewedRender(output, ONE, reviewed, { open })).toEqual(CHANGED);
    // The same time, another size.
    const sameTime = stamps({ [ONE]: fingerprint(lstatSync(file)) });
    writeFileSync(file, Buffer.concat([BYTES, BYTES]));
    utimesSync(file, OLD, OLD);
    expect(await readReviewedRender(output, ONE, sameTime, { open })).toEqual(CHANGED);
    expect(open).not.toHaveBeenCalled();
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
    const open = openAfter(() => undefined);
    const reviewed = stamps({
      "camp/p1/five.mp4": render("camp/p1/five.mp4", "12345"),
      "camp/p1/four.mp4": render("camp/p1/four.mp4", "1234"),
    });
    const over = await readReviewedRender(output, "camp/p1/five.mp4", reviewed, {
      maxBytes: 4,
      open,
    });
    expect(over).toEqual({
      state: "refused",
      reason: "camp/p1/five.mp4 is 5 bytes; the render cap is 4 bytes.",
    });
    expect(open).not.toHaveBeenCalled();
    const atCap = await readReviewedRender(output, "camp/p1/four.mp4", reviewed, { maxBytes: 4 });
    expect(atCap).toEqual({ state: "ok", bytes: Buffer.from("1234") });
  });

  test("with no cap given the cap is 512 MiB", async () => {
    expect(MAX_RENDER_BYTES).toBe(536_870_912);
    const big = "camp/p1/big.mp4";
    const file = writeAt(output, big, "");
    // A sparse file: it has the size, and no byte of it is written or read.
    truncateSync(file, MAX_RENDER_BYTES + 1);
    const open = openAfter(() => undefined);
    const reviewed = stamps({ [big]: fingerprint(lstatSync(file)) });
    expect(await readReviewedRender(output, big, reviewed, { open })).toEqual({
      state: "refused",
      reason: `${big} is 536870913 bytes; the render cap is 536870912 bytes.`,
    });
    expect(open).not.toHaveBeenCalled();
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

describe("readReviewedRender: the checked file is opened once and never followed", () => {
  test("a file swapped for a symlink after the check is refused and the link is never followed", async () => {
    const file = join(output, ONE);
    render(ONE);
    utimesSync(file, OLD, OLD);
    const reviewed = stamps({ [ONE]: fingerprint(lstatSync(file)) });
    // Another file with the same size and the same time: only the link gives it away.
    const target = writeAt(output, "elsewhere/other.png", Buffer.alloc(BYTES.length, "x"));
    utimesSync(target, OLD, OLD);
    const open = openAfter((name) => {
      rmSync(name);
      linkAt(output, ONE, target);
    });
    expect(await readReviewedRender(output, ONE, reviewed, { open })).toEqual({
      state: "refused",
      reason: `${ONE} changed while it was read`,
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  test("a file rewritten with the same size after the check is refused", async () => {
    const reviewed = stamps({ [ONE]: render(ONE) });
    const open = openAfter((name) => utimesSync(name, OLD, OLD));
    expect(await readReviewedRender(output, ONE, reviewed, { open })).toEqual({
      state: "refused",
      reason: `${ONE} changed while it was read`,
    });
  });

  test("a file swapped for a directory after the check is refused", async () => {
    const reviewed = stamps({ [ONE]: render(ONE) });
    const open = openAfter((name) => {
      rmSync(name);
      mkdirSync(name);
    });
    expect(await readReviewedRender(output, ONE, reviewed, { open })).toEqual({
      state: "refused",
      reason: `${ONE} changed while it was read`,
    });
  });
});

describe("readReviewedRender: no more than the reviewed size is read", () => {
  test("a file that grows after it was opened is refused", async () => {
    const reviewed = stamps({ [ONE]: render(ONE) });
    const open = openThen((name) => appendFileSync(name, "grown after the check"));
    expect(await readReviewedRender(output, ONE, reviewed, { open })).toEqual({
      state: "refused",
      reason: `${ONE} changed while it was read`,
    });
  });

  test("a file that shrinks after it was opened is refused", async () => {
    const reviewed = stamps({ [ONE]: render(ONE) });
    const open = openThen((name) => truncateSync(name, 4));
    expect(await readReviewedRender(output, ONE, reviewed, { open })).toEqual({
      state: "refused",
      reason: `${ONE} changed while it was read`,
    });
  });
});

describe("readReviewedRender: an open or a close that fails", () => {
  test("an open that fails is refused and never thrown", async () => {
    const reviewed = stamps({ [ONE]: render(ONE) });
    const open = openAfter(() => {
      throw new Error("the disk went away");
    });
    expect(await readReviewedRender(output, ONE, reviewed, { open })).toEqual({
      state: "refused",
      reason: "the disk went away",
    });
  });

  test("the file is closed once and a close that fails is not thrown", async () => {
    const reviewed = stamps({ [ONE]: render(ONE) });
    let closed = 0;
    const open = vi.fn(async (file: string, flags: number) => {
      const fh = await openFile(file, flags);
      const close = fh.close.bind(fh);
      return Object.assign(fh, {
        close: async () => {
          closed += 1;
          await close();
          throw new Error("the close failed");
        },
      });
    });
    const got = await readReviewedRender(output, ONE, reviewed, { open });
    expect(got).toEqual({ state: "ok", bytes: BYTES });
    expect(closed).toBe(1);
  });
});

describe("readReviewedRender: pinned answers", () => {
  test("a file that is not there under a symlinked directory is absent, or changed when the digest named it", async () => {
    mkdirSync(join(output, "elsewhere/empty"), { recursive: true });
    linkAt(output, "camp/linked", join(output, "elsewhere/empty"));
    const missing = "camp/linked/x.png";
    expect(await readReviewedRender(output, missing, stamps({}))).toEqual({ state: "absent" });
    const named = stamps({ [missing]: "size:4:mtime:1000" });
    expect(await readReviewedRender(output, missing, named)).toEqual({
      state: "refused",
      reason: `${missing} changed since the digest`,
    });
  });

  test("a changed render over the cap is reported as changed, not as too large", async () => {
    const five = "camp/p1/five.mp4";
    const reviewed = stamps({ [five]: render(five, "12345") });
    utimesSync(join(output, five), OLD, OLD);
    expect(await readReviewedRender(output, five, reviewed, { maxBytes: 4 })).toEqual({
      state: "refused",
      reason: `${five} changed since the digest`,
    });
  });
});

describe("readReviewedRender: review of #811", () => {
  test("a directory above the file swapped for a link to a same-stamp file is refused", async () => {
    const file = join(output, ONE);
    render(ONE);
    utimesSync(file, OLD, OLD);
    const reviewed = stamps({ [ONE]: fingerprint(lstatSync(file)) });
    // Another file of the same length and the same time, under the swapped directory.
    const decoy = writeAt(output, "elsewhere/p1/1x1.png", Buffer.alloc(BYTES.length, "x"));
    utimesSync(decoy, OLD, OLD);
    const open = openAfter((name) => {
      const parent = dirname(name);
      renameSync(parent, join(output, "camp/p1-old"));
      symlinkSync(join(output, "elsewhere/p1"), parent);
    });
    expect(await readReviewedRender(output, ONE, reviewed, { open })).toEqual({
      state: "refused",
      reason: `${ONE} changed while it was read`,
    });
  });

  test("a file rewritten in place while it is read is refused", async () => {
    const reviewed = stamps({ [ONE]: render(ONE) });
    let rewritten = false;
    const open = vi.fn(async (file: string, flags: number) => {
      const fh = await openFile(file, flags);
      const read = fh.read.bind(fh);
      return Object.assign(fh, {
        read: async (...args: Parameters<typeof read>) => {
          if (!rewritten) {
            rewritten = true;
            writeFileSync(file, Buffer.alloc(BYTES.length, "y"));
          }
          return read(...args);
        },
      });
    });
    expect(await readReviewedRender(output, ONE, reviewed, { open })).toEqual({
      state: "refused",
      reason: `${ONE} changed while it was read`,
    });
  });

  test.skipIf(process.platform === "win32")(
    "a named pipe swapped in after the check is refused and the open does not wait",
    { timeout: 5000 },
    async () => {
      const reviewed = stamps({ [ONE]: render(ONE) });
      const open = openAfter((name) => {
        rmSync(name);
        execFileSync("mkfifo", [name]);
      });
      expect(await readReviewedRender(output, ONE, reviewed, { open })).toEqual({
        state: "refused",
        reason: `${ONE} changed while it was read`,
      });
    },
  );

  test("no read asks for bytes beyond the reviewed size plus one", async () => {
    const reviewed = stamps({ [ONE]: render(ONE) });
    const asked: number[] = [];
    const open = vi.fn(async (file: string, flags: number) => {
      const fh = await openFile(file, flags);
      const read = fh.read.bind(fh);
      return Object.assign(fh, {
        read: async (buf: Buffer, offset: number, length: number, position: number) => {
          asked.push(offset + length);
          return read(buf, offset, length, position);
        },
      });
    });
    const got = await readReviewedRender(output, ONE, reviewed, { open });
    expect(got).toEqual({ state: "ok", bytes: BYTES });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((end) => end <= BYTES.length + 1)).toBe(true);
  });

  test("a read that fails is refused, never thrown, and the file is closed", async () => {
    const reviewed = stamps({ [ONE]: render(ONE) });
    let closed = 0;
    const open = vi.fn(async (file: string, flags: number) => {
      const fh = await openFile(file, flags);
      const close = fh.close.bind(fh);
      return Object.assign(fh, {
        read: async () => {
          throw new Error("the read failed");
        },
        close: async () => {
          closed += 1;
          await close();
        },
      });
    });
    expect(await readReviewedRender(output, ONE, reviewed, { open })).toEqual({
      state: "refused",
      reason: "the read failed",
    });
    expect(closed).toBe(1);
  });

  test("a stat of the open file that fails is refused, never thrown, and the file is closed", async () => {
    const reviewed = stamps({ [ONE]: render(ONE) });
    let closed = 0;
    const open = vi.fn(async (file: string, flags: number) => {
      const fh = await openFile(file, flags);
      const close = fh.close.bind(fh);
      return Object.assign(fh, {
        stat: async () => {
          throw new Error("the stat failed");
        },
        close: async () => {
          closed += 1;
          await close();
        },
      });
    });
    expect(await readReviewedRender(output, ONE, reviewed, { open })).toEqual({
      state: "refused",
      reason: "the stat failed",
    });
    expect(closed).toBe(1);
  });
});
