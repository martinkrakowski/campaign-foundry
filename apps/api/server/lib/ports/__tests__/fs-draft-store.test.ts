import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYMLINK_WRITE_ERROR } from "../../brief-files.js";
import { FsDraftStore } from "../fs-draft-store.js";

// Hookable `lstat`, used by exactly the two rethrow tests below (a non-ENOENT
// failure from `draftsDirUnsafe`'s own lstat, and from the file-level check in
// `writeDraft`): every other test leaves the hook undefined, which falls
// straight through to the real implementation.
const fsHook = vi.hoisted(() => ({
  lstat: undefined as ((path: string) => Promise<unknown>) | undefined,
  realLstat: undefined as ((path: string, options?: unknown) => Promise<unknown>) | undefined,
  readdir: undefined as ((path: string) => Promise<unknown>) | undefined,
  realReaddir: undefined as ((path: string, options?: unknown) => Promise<unknown>) | undefined,
  unlink: undefined as ((path: string) => Promise<unknown>) | undefined,
  realUnlink: undefined as ((path: string) => Promise<unknown>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsHook.realLstat = actual.lstat as unknown as (
    path: string,
    options?: unknown,
  ) => Promise<unknown>;
  fsHook.realReaddir = actual.readdir as unknown as (
    path: string,
    options?: unknown,
  ) => Promise<unknown>;
  fsHook.realUnlink = actual.unlink as unknown as (path: string) => Promise<unknown>;
  return {
    ...actual,
    lstat: (path: string, options?: unknown) =>
      fsHook.lstat ? fsHook.lstat(path) : fsHook.realLstat!(path, options),
    readdir: (path: string, options?: unknown) =>
      fsHook.readdir ? fsHook.readdir(path) : fsHook.realReaddir!(path, options),
    unlink: (path: string) => (fsHook.unlink ? fsHook.unlink(path) : fsHook.realUnlink!(path)),
  };
});

describe("FsDraftStore (PT-5d, D173)", () => {
  let dir: string;
  let store: FsDraftStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-fs-draft-store-"));
    store = new FsDraftStore(dir);
  });

  afterEach(() => {
    fsHook.lstat = undefined;
    fsHook.readdir = undefined;
    fsHook.unlink = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a campaign with no reserved directory at all reads as no draft", async () => {
    await expect(store.readDraft("camp", "u1")).resolves.toBeUndefined();
  });

  test("a campaign directory that exists but has no drafts/ reads as no draft", async () => {
    mkdirSync(join(dir, "camp"));
    await expect(store.readDraft("camp", "u1")).resolves.toBeUndefined();
  });

  test("a draft round-trips its state and base revision, on disk under drafts/<userId>.json", async () => {
    const written = await store.writeDraft("camp", "u1", { name: "Draft" }, "rev-1");
    expect(written.state).toEqual({ name: "Draft" });
    expect(written.baseRevision).toBe("rev-1");
    expect(typeof written.updatedAt).toBe("string");
    const filePath = join(dir, "camp", "drafts", "u1.json");
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      state: { name: "Draft" },
      baseRevision: "rev-1",
      updatedAt: written.updatedAt,
    });
    await expect(store.readDraft("camp", "u1")).resolves.toEqual(written);
  });

  test("a versionless campaign's draft carries a null base revision", async () => {
    const written = await store.writeDraft("camp", "u1", { name: "Blank" }, null);
    expect(written.baseRevision).toBeNull();
    expect((await store.readDraft("camp", "u1"))?.baseRevision).toBeNull();
  });

  test("a second write replaces the draft file in place", async () => {
    await store.writeDraft("camp", "u1", { name: "First" }, "rev-1");
    const second = await store.writeDraft("camp", "u1", { name: "Second" }, "rev-1");
    await expect(store.readDraft("camp", "u1")).resolves.toEqual(second);
  });

  test("two users' drafts on the same campaign are independent files", async () => {
    await store.writeDraft("camp", "u1", { name: "Mine" }, null);
    await store.writeDraft("camp", "u2", { name: "Theirs" }, null);
    expect((await store.readDraft("camp", "u1"))?.state).toEqual({ name: "Mine" });
    expect((await store.readDraft("camp", "u2"))?.state).toEqual({ name: "Theirs" });
    await store.deleteDraft("camp", "u1");
    expect(await store.readDraft("camp", "u1")).toBeUndefined();
    expect((await store.readDraft("camp", "u2"))?.state).toEqual({ name: "Theirs" });
  });

  test("deleting an absent draft is a no-op", async () => {
    await expect(store.deleteDraft("camp", "u1")).resolves.toBeUndefined();
  });

  test("deleteDraft rethrows a non-ENOENT unlink failure unchanged", async () => {
    await store.writeDraft("camp", "u1", { name: "Mine" }, null);
    const err = new Error("boom") as NodeJS.ErrnoException;
    err.code = "EACCES";
    fsHook.unlink = async () => {
      throw err;
    };
    await expect(store.deleteDraft("camp", "u1")).rejects.toThrow("boom");
  });

  test("a userId escaping the drafts directory is refused, not followed", async () => {
    await expect(store.writeDraft("camp", "../../../etc/passwd", {}, null)).rejects.toThrow();
    await expect(store.readDraft("camp", "../../../etc/passwd")).rejects.toThrow();
  });

  test("a NUL byte in userId is refused", async () => {
    await expect(store.writeDraft("camp", "a\0b", {}, null)).rejects.toThrow();
  });

  // Fix round item 4 (grok-4.7): `../campaign` never leaves `briefs/` at
  // all — `resolveConfined` alone would have let it through to
  // `briefs/camp/campaign.json`, a sibling of `drafts/`, not outside it.
  // `SAFE_ID_PATTERN` is what actually refuses this shape.
  test("a userId of ../campaign neither creates nor modifies the campaign's own campaign.json", async () => {
    mkdirSync(join(dir, "camp"), { recursive: true });
    writeFileSync(join(dir, "camp", "campaign.json"), '{"name":"real"}');
    await expect(store.writeDraft("camp", "../campaign", {}, null)).rejects.toThrow();
    expect(readFileSync(join(dir, "camp", "campaign.json"), "utf8")).toBe('{"name":"real"}');
    expect(existsSync(join(dir, "camp", "drafts"))).toBe(false);
  });

  describe("a symlinked drafts/ directory", () => {
    test("is refused on write, leaving the outside file untouched", async () => {
      const outside = mkdtempSync(join(tmpdir(), "cf-outside-"));
      try {
        const outsideFile = join(outside, "u1.json");
        writeFileSync(outsideFile, "not yours");
        mkdirSync(join(dir, "camp"));
        symlinkSync(outside, join(dir, "camp", "drafts"));

        await expect(store.writeDraft("camp", "u1", { name: "Mine" }, null)).rejects.toThrow(
          SYMLINK_WRITE_ERROR,
        );
        expect(readFileSync(outsideFile, "utf8")).toBe("not yours");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    test("reads as no draft, never through the link", async () => {
      const outside = mkdtempSync(join(tmpdir(), "cf-outside-"));
      try {
        writeFileSync(join(outside, "u1.json"), JSON.stringify({ state: "not yours" }));
        mkdirSync(join(dir, "camp"));
        symlinkSync(outside, join(dir, "camp", "drafts"));

        await expect(store.readDraft("camp", "u1")).resolves.toBeUndefined();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    test("deleting through it is a no-op, not a follow", async () => {
      const outside = mkdtempSync(join(tmpdir(), "cf-outside-"));
      try {
        const outsideFile = join(outside, "u1.json");
        writeFileSync(outsideFile, "not yours");
        mkdirSync(join(dir, "camp"));
        symlinkSync(outside, join(dir, "camp", "drafts"));

        await expect(store.deleteDraft("camp", "u1")).resolves.toBeUndefined();
        expect(existsSync(outsideFile)).toBe(true);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  test("a symlinked <campaignId> directory itself is refused, not just drafts/ inside it", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cf-outside-"));
    try {
      mkdirSync(join(outside, "drafts"));
      writeFileSync(join(outside, "drafts", "u1.json"), JSON.stringify({ state: "not yours" }));
      symlinkSync(outside, join(dir, "camp"));

      await expect(store.writeDraft("camp", "u1", { name: "Mine" }, null)).rejects.toThrow(
        SYMLINK_WRITE_ERROR,
      );
      await expect(store.readDraft("camp", "u1")).resolves.toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a symlinked <userId>.json file is refused on write and never read through", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cf-outside-"));
    try {
      const outsideFile = join(outside, "secret.json");
      writeFileSync(outsideFile, "not yours");
      mkdirSync(join(dir, "camp", "drafts"), { recursive: true });
      symlinkSync(outsideFile, join(dir, "camp", "drafts", "u1.json"));

      await expect(store.writeDraft("camp", "u1", { name: "Mine" }, null)).rejects.toThrow(
        SYMLINK_WRITE_ERROR,
      );
      expect(readFileSync(outsideFile, "utf8")).toBe("not yours");
      await expect(store.readDraft("camp", "u1")).resolves.toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("draftsDirUnsafe rethrows a non-ENOENT lstat failure unchanged", async () => {
    const err = new Error("boom") as NodeJS.ErrnoException;
    err.code = "EIO";
    fsHook.lstat = async (path: string) => {
      if (path.endsWith(join("camp"))) throw err;
      return fsHook.realLstat!(path);
    };
    await expect(store.readDraft("camp", "u1")).rejects.toThrow("boom");
  });

  test("writeDraft's own file-level lstat rethrows a non-ENOENT failure unchanged", async () => {
    const err = new Error("boom") as NodeJS.ErrnoException;
    err.code = "EIO";
    fsHook.lstat = async (path: string) => {
      if (path.endsWith("u1.json")) throw err;
      return fsHook.realLstat!(path);
    };
    await expect(store.writeDraft("camp", "u1", {}, null)).rejects.toThrow("boom");
  });

  test("readDraft's own file-level lstat rethrows a non-ENOENT failure unchanged", async () => {
    // Real directories first (draftsDirUnsafe must pass through untouched),
    // then inject the failure only for the file-level lstat readDraft makes
    // once it knows the directory itself is safe.
    await store.writeDraft("camp", "u1", { name: "Mine" }, null);
    const err = new Error("boom") as NodeJS.ErrnoException;
    err.code = "EIO";
    fsHook.lstat = async (path: string) => {
      if (path.endsWith("u1.json")) throw err;
      return fsHook.realLstat!(path);
    };
    await expect(store.readDraft("camp", "u1")).rejects.toThrow("boom");
  });

  describe("listDraftsByRecency", () => {
    test("rethrows a non-ENOENT readdir failure unchanged", async () => {
      const err = new Error("boom") as NodeJS.ErrnoException;
      err.code = "EIO";
      fsHook.readdir = async () => {
        throw err;
      };
      await expect(store.listDraftsByRecency("u1")).rejects.toThrow("boom");
    });

    test("rethrows a non-ENOENT per-entry lstat failure unchanged", async () => {
      await store.writeDraft("camp", "u1", { name: "Mine" }, null);
      const err = new Error("boom") as NodeJS.ErrnoException;
      err.code = "EIO";
      fsHook.lstat = async (path: string) => {
        if (path.endsWith("u1.json")) throw err;
        return fsHook.realLstat!(path);
      };
      await expect(store.listDraftsByRecency("u1")).rejects.toThrow("boom");
    });

    test("answers an empty list when the briefs directory does not exist at all", async () => {
      const emptyStore = new FsDraftStore(join(dir, "does-not-exist"));
      await expect(emptyStore.listDraftsByRecency("u1")).resolves.toEqual([]);
    });

    test("answers an empty list for a user with no drafts anywhere", async () => {
      await store.writeDraft("camp", "u2", { name: "Theirs" }, null);
      await expect(store.listDraftsByRecency("u1")).resolves.toEqual([]);
    });

    test("skips a non-directory entry sitting beside campaign directories", async () => {
      writeFileSync(join(dir, "stray.yaml"), "id: stray\n");
      await store.writeDraft("camp", "u1", { name: "Mine" }, null);
      const list = await store.listDraftsByRecency("u1");
      expect(list.map((d) => d.campaignId)).toEqual(["camp"]);
    });

    test("skips an entry that is not a regular file even though drafts/ itself is real", async () => {
      mkdirSync(join(dir, "camp", "drafts", "u1.json"), { recursive: true });
      await store.writeDraft("other", "u1", { name: "Real" }, null);
      const list = await store.listDraftsByRecency("u1");
      expect(list.map((d) => d.campaignId)).toEqual(["other"]);
    });

    test("skips a campaign whose drafts/ directory is symlinked", async () => {
      const outside = mkdtempSync(join(tmpdir(), "cf-outside-"));
      try {
        mkdirSync(join(dir, "linked"));
        symlinkSync(outside, join(dir, "linked", "drafts"));
        await store.writeDraft("camp", "u1", { name: "Mine" }, null);

        const list = await store.listDraftsByRecency("u1");
        expect(list.map((d) => d.campaignId)).toEqual(["camp"]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    test("answers every draft, newest first, across campaigns", async () => {
      await store.writeDraft("older", "u1", { name: "Older" }, null);
      await store.writeDraft("newer", "u1", { name: "Newer" }, null);
      // Force a deterministic ordering rather than trusting two writes in the
      // same test to land in different milliseconds.
      const now = new Date();
      utimesSync(join(dir, "older", "drafts", "u1.json"), now, new Date(now.getTime() - 60_000));
      utimesSync(join(dir, "newer", "drafts", "u1.json"), now, now);

      const list = await store.listDraftsByRecency("u1");
      expect(list.map((d) => d.campaignId)).toEqual(["newer", "older"]);
    });

    test("sorts newest-first regardless of the order readdir happens to return", async () => {
      // "aaa-newer"/"zzz-older" sort BEFORE their timestamps do alphabetically
      // — readdir traversal order must never leak into the answer.
      await store.writeDraft("aaa-newer", "u1", { name: "Newer" }, null);
      await store.writeDraft("zzz-older", "u1", { name: "Older" }, null);
      const now = new Date();
      utimesSync(join(dir, "aaa-newer", "drafts", "u1.json"), now, now);
      utimesSync(
        join(dir, "zzz-older", "drafts", "u1.json"),
        now,
        new Date(now.getTime() - 60_000),
      );

      const list = await store.listDraftsByRecency("u1");
      expect(list.map((d) => d.campaignId)).toEqual(["aaa-newer", "zzz-older"]);
    });
  });

  describe("writeDraftIfCurrent", () => {
    test("writes and answers ok:true when baseRevision matches the given currentRevision", async () => {
      const outcome = await store.writeDraftIfCurrent("camp", "u1", { name: "Mine" }, "r1", "r1");
      expect(outcome).toEqual({
        ok: true,
        draft: expect.objectContaining({ state: { name: "Mine" }, baseRevision: "r1" }),
      });
      await expect(store.readDraft("camp", "u1")).resolves.toMatchObject({
        state: { name: "Mine" },
      });
    });

    test("a null baseRevision matches a null currentRevision (versionless campaign)", async () => {
      const outcome = await store.writeDraftIfCurrent("camp", "u1", { name: "Blank" }, null, null);
      expect(outcome.ok).toBe(true);
    });

    test("refuses without writing when baseRevision does not match currentRevision", async () => {
      const outcome = await store.writeDraftIfCurrent("camp", "u1", { name: "Stale" }, "r1", "r2");
      expect(outcome).toEqual({ ok: false, currentRevision: "r2" });
      await expect(store.readDraft("camp", "u1")).resolves.toBeUndefined();
    });

    test("a userId that fails SAFE_ID_PATTERN neither creates nor modifies the campaign's own file", async () => {
      mkdirSync(join(dir, "camp"), { recursive: true });
      writeFileSync(join(dir, "camp", "campaign.json"), '{"name":"real"}');
      await expect(
        store.writeDraftIfCurrent("camp", "../campaign", { x: 1 }, null, null),
      ).rejects.toThrow();
      expect(existsSync(join(dir, "camp", "drafts"))).toBe(false);
      expect(readFileSync(join(dir, "camp", "campaign.json"), "utf8")).toBe('{"name":"real"}');
    });
  });
});
