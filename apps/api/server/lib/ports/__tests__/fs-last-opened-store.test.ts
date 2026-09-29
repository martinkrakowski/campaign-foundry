import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYMLINK_WRITE_ERROR } from "../../brief-files.js";
import { FsLastOpenedStore } from "../fs-last-opened-store.js";

// Hookable `lstat`/`writeFile`/`rename`, used by the rethrow and atomic-write
// tests below; every other test leaves the hooks undefined, which falls through
// to the real implementation.
const fsHook = vi.hoisted(() => ({
  lstat: undefined as ((path: string) => Promise<unknown>) | undefined,
  realLstat: undefined as ((path: string, options?: unknown) => Promise<unknown>) | undefined,
  rename: undefined as ((from: string, to: string) => Promise<unknown>) | undefined,
  realRename: undefined as ((from: string, to: string) => Promise<unknown>) | undefined,
  unlink: undefined as ((path: string) => Promise<unknown>) | undefined,
  realUnlink: undefined as ((path: string) => Promise<unknown>) | undefined,
  writeFile: undefined as
    | ((path: string, data: unknown, enc: unknown) => Promise<unknown>)
    | undefined,
  realWriteFile: undefined as
    | ((path: string, data: unknown, enc: unknown) => Promise<unknown>)
    | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsHook.realLstat = actual.lstat as unknown as (
    path: string,
    options?: unknown,
  ) => Promise<unknown>;
  fsHook.realRename = actual.rename as unknown as (from: string, to: string) => Promise<unknown>;
  fsHook.realUnlink = actual.unlink as unknown as (path: string) => Promise<unknown>;
  fsHook.realWriteFile = actual.writeFile as unknown as (
    path: string,
    data: unknown,
    enc: unknown,
  ) => Promise<unknown>;
  return {
    ...actual,
    lstat: (path: string, options?: unknown) =>
      fsHook.lstat ? fsHook.lstat(path) : fsHook.realLstat!(path, options),
    rename: (from: string, to: string) =>
      fsHook.rename ? fsHook.rename(from, to) : fsHook.realRename!(from, to),
    unlink: (path: string) => (fsHook.unlink ? fsHook.unlink(path) : fsHook.realUnlink!(path)),
    writeFile: (path: string, data: unknown, enc: unknown) =>
      fsHook.writeFile ? fsHook.writeFile(path, data, enc) : fsHook.realWriteFile!(path, data, enc),
  };
});

describe("FsLastOpenedStore (PT-5e, D173, D180)", () => {
  let root: string;
  let dir: string;
  let store: FsLastOpenedStore;

  beforeEach(() => {
    // The registry hands the store `<projectRoot>/state/last-opened`, which
    // nothing pre-creates — the store makes it on its first write. The test
    // mirrors that shape exactly (rather than a pre-made temp dir), so
    // "the directory does not exist yet" is the real opening state here.
    root = mkdtempSync(join(tmpdir(), "cf-fs-last-opened-"));
    dir = join(root, "state", "last-opened");
    store = new FsLastOpenedStore(dir);
  });

  afterEach(() => {
    fsHook.lstat = undefined;
    fsHook.rename = undefined;
    fsHook.unlink = undefined;
    fsHook.writeFile = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  test("a user with no pointer file reads as undefined", async () => {
    await expect(store.read("u1")).resolves.toBeUndefined();
  });

  test("a pointer round-trips, on disk as <userId>.json outside briefs/", async () => {
    const written = await store.write("camp", "u1");
    expect(written.campaignId).toBe("camp");
    expect(written.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const filePath = join(dir, "u1.json");
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      campaignId: "camp",
      updatedAt: written.updatedAt,
    });
    await expect(store.read("u1")).resolves.toEqual(written);
  });

  test("a second write replaces the pointer file in place", async () => {
    await store.write("first", "u1");
    const moved = await store.write("second", "u1");
    expect(moved.campaignId).toBe("second");
    await expect(store.read("u1")).resolves.toEqual(moved);
  });

  test("two users keep independent pointer files", async () => {
    await store.write("mine", "u1");
    await store.write("theirs", "u2");
    expect((await store.read("u1"))?.campaignId).toBe("mine");
    expect((await store.read("u2"))?.campaignId).toBe("theirs");
  });

  // The mutation this lane records is the pg adapter's, but the per-user
  // property is the same one: a read is always for ONE user.
  test("a user with no pointer of their own never reads another's", async () => {
    await store.write("theirs", "u2");
    await expect(store.read("u1")).resolves.toBeUndefined();
  });

  describe("atomic write", () => {
    test("a write goes through a temp file, then a rename — never a direct writeFile to the target", async () => {
      const seenWriteFileTargets: string[] = [];
      const seenRenameTargets: string[] = [];
      fsHook.writeFile = async (path, data, enc) => {
        seenWriteFileTargets.push(path);
        return fsHook.realWriteFile!(path, data, enc);
      };
      fsHook.rename = async (from, to) => {
        seenRenameTargets.push(to);
        return fsHook.realRename!(from, to);
      };
      await store.write("camp", "u1");
      const target = join(dir, "u1.json");
      expect(seenWriteFileTargets).toHaveLength(1);
      expect(seenWriteFileTargets[0]).not.toBe(target);
      expect(seenWriteFileTargets[0]).toMatch(/\.tmp$/);
      expect(seenRenameTargets).toEqual([target]);
    });

    test("a failed rename whose cleanup also fails still reports the rename", async () => {
      // The temp file is swept best-effort: if the sweep fails too (the rename
      // already moved or removed it, a full disk, a permission change), the
      // write's OWN failure is what the caller must hear — not the clean-up's.
      await store.write("original", "u1");
      fsHook.rename = async () => {
        throw new Error("disk full");
      };
      fsHook.unlink = async () => {
        throw new Error("EACCES");
      };
      await expect(store.write("new", "u1")).rejects.toThrow("disk full");
    });

    test("a failed rename leaves the previous pointer untouched and cleans up the temp file", async () => {
      const first = await store.write("original", "u1");
      let tmpPathSeen: string | undefined;
      fsHook.rename = async (from) => {
        tmpPathSeen = from;
        throw new Error("disk full");
      };
      await expect(store.write("new", "u1")).rejects.toThrow("disk full");
      await expect(store.read("u1")).resolves.toEqual(first);
      expect(tmpPathSeen).toBeDefined();
      expect(existsSync(tmpPathSeen!)).toBe(false);
    });
  });

  test("a userId that is not path-safe is refused, not followed", async () => {
    await expect(store.read("../campaign")).rejects.toThrow('Invalid user id: "../campaign"');
    await expect(store.write("camp", "../campaign")).rejects.toThrow(
      'Invalid user id: "../campaign"',
    );
    // Nothing was created outside the store's own directory.
    expect(existsSync(join(dir, "..", "campaign.json"))).toBe(false);
  });

  // Written as an escape: a raw NUL is a control byte, and `yarn lint:bytes`
  // reads one in source as a defect (four ASCII characters are not what it looks for).
  test("a NUL byte in userId is refused", async () => {
    await expect(store.read("u1\u0000")).rejects.toThrow("Invalid user id");
  });

  describe("a symlinked pointer directory", () => {
    let outside: string;
    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), "cf-fs-last-opened-outside-"));
      mkdirSync(join(root, "state"), { recursive: true });
      symlinkSync(outside, dir);
    });
    afterEach(() => {
      rmSync(outside, { recursive: true, force: true });
    });

    test("a read answers no pointer rather than following it", async () => {
      await expect(store.read("u1")).resolves.toBeUndefined();
    });

    test("a write refuses with the symlink error and writes nothing outside", async () => {
      await expect(store.write("camp", "u1")).rejects.toThrow(SYMLINK_WRITE_ERROR);
      expect(existsSync(join(outside, "u1.json"))).toBe(false);
    });
  });

  test("a symlinked <userId>.json file is refused on write and never read through", async () => {
    await store.write("seed", "seed"); // creates the directory the fixtures file into
    const target = join(dir, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ campaignId: "elsewhere", updatedAt: "t" }));
    symlinkSync(target, join(dir, "u1.json"));
    await expect(store.read("u1")).resolves.toBeUndefined();
    await expect(store.write("camp", "u1")).rejects.toThrow(SYMLINK_WRITE_ERROR);
    // The link's own target is untouched.
    expect(JSON.parse(readFileSync(target, "utf8")).campaignId).toBe("elsewhere");
  });

  test("a pointer path that exists but is not a regular file reads as no pointer", async () => {
    await store.write("seed", "seed");
    mkdirSync(join(dir, "u1.json"));
    await expect(store.read("u1")).resolves.toBeUndefined();
  });

  test("dirUnsafe rethrows a non-ENOENT lstat failure unchanged", async () => {
    fsHook.lstat = async () => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    };
    await expect(store.read("u1")).rejects.toThrow("EACCES");
    await expect(store.write("camp", "u1")).rejects.toThrow("EACCES");
  });

  test("read's own file-level lstat rethrows a non-ENOENT failure unchanged", async () => {
    await store.write("camp", "u1");
    fsHook.lstat = async (path: string) => {
      if (path !== dir) {
        const err = new Error("EIO") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return fsHook.realLstat!(path);
    };
    await expect(store.read("u1")).rejects.toThrow("EIO");
  });

  test("write's own file-level lstat rethrows a non-ENOENT failure unchanged", async () => {
    await store.write("camp", "u1");
    fsHook.lstat = async (path: string) => {
      if (path !== dir) {
        const err = new Error("EIO") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return fsHook.realLstat!(path);
    };
    await expect(store.write("camp", "u1")).rejects.toThrow("EIO");
  });
});
