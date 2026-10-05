import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsAssetStore } from "../fs-asset-store.js";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const mp3Bytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x22]);
const m4aBytes = Buffer.from([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x02, 0x00,
]);

/**
 * One-shot ENOENT hook for `readFile` — only the first read of `failPath`
 * throws; all other reads delegate to the real implementation.
 */
const fsRace = vi.hoisted(() => ({
  failNextRead: false,
  failPath: "",
  failed: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (...args: unknown[]) => {
      const path = args[0];
      if (
        fsRace.failNextRead &&
        typeof path === "string" &&
        path === fsRace.failPath &&
        !fsRace.failed
      ) {
        fsRace.failed = true;
        const err = new Error("ENOENT: no such file or directory") as Error & { code: string };
        err.code = "ENOENT";
        throw err;
      }
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(...args);
    }),
  };
});

describe("FsAssetStore", () => {
  let dir: string;
  let store: FsAssetStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-fs-asset-store-"));
    store = new FsAssetStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    fsRace.failNextRead = false;
    fsRace.failPath = "";
    fsRace.failed = false;
  });

  test("getBaseDir returns base directory", () => {
    expect(store.getBaseDir()).toBe(dir);
  });

  test("assetRelPath formats repo-relative path", () => {
    expect(store.assetRelPath("camp-1", "logo.png")).toBe("assets/inputs/camp-1/logo.png");
  });

  test("writeAsset writes asset file exclusively and returns relative path", async () => {
    const res = await store.writeAsset("camp-1", "brand-logo.png", pngBytes);
    expect(res.path).toBe("assets/inputs/camp-1/brand-logo.png");

    const saved = readFileSync(join(dir, "camp-1", "brand-logo.png"));
    expect(saved).toEqual(pngBytes);

    // Duplicate write fails with EEXIST
    await expect(store.writeAsset("camp-1", "brand-logo.png", pngBytes)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  test("readAsset reads asset bytes or returns undefined on missing", async () => {
    await store.writeAsset("camp-1", "logo.png", pngBytes);
    expect(await store.readAsset("camp-1", "logo.png")).toEqual(pngBytes);
    expect(await store.readAsset("camp-1", "missing.png")).toBeUndefined();
    expect(await store.readAsset("../invalid-id", "logo.png")).toBeUndefined();
  });

  // The fs half of PT-4k1: the id-addressed methods exist and answer `undefined`,
  // which is a DELIBERATE answer rather than a missing method — `FileSystemInputAssets`
  // maps this to ENOENT, so the two backends agree on a ref neither can read.
  describe("the id-addressed methods (PT-4k1, D208c)", () => {
    const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    test("readAssetById answers undefined for every ref, with a file present", async () => {
      await store.writeAsset("camp-1", "logo.png", pngBytes);
      expect(await store.readAssetById(ID)).toBeUndefined();
      // Even an id that would resolve a directory if it were a slug: fs has no id
      // concept, and a lookup that guessed would read a path `resolveConfined`
      // refuses anyway.
      expect(await store.readAssetById("camp-1")).toBeUndefined();
      expect(await store.readAssetById("")).toBeUndefined();
      // The file is untouched and still readable by the path it really has.
      expect(await store.readAsset("camp-1", "logo.png")).toEqual(pngBytes);
    });

    test("assetOwner answers undefined for every ref", async () => {
      await store.writeAsset("camp-1", "logo.png", pngBytes);
      expect(await store.assetOwner(ID)).toBeUndefined();
      expect(await store.assetOwner("camp-1")).toBeUndefined();
      expect(await store.assetOwner("")).toBeUndefined();
    });

    test("writeAsset answers `{ path }` and NO id key at all", async () => {
      // `Object.keys`, not `toEqual`: `toEqual` ignores an `undefined` property,
      // so it cannot tell an absent key from one set to `undefined`. The route
      // branches on `result.id === undefined` and returns `{ path }` only — and an
      // fs caller holding this object must find exactly what it found before PT-4k1.
      const res = await store.writeAsset("camp-1", "logo.png", pngBytes);
      expect(Object.keys(res)).toEqual(["path"]);
    });

    test("listAssets entries carry no id key", async () => {
      await store.writeAsset("camp-1", "logo.png", pngBytes);
      const [entry] = await store.listAssets("camp-1");
      expect(Object.keys(entry!)).toEqual(["name", "type", "size", "thumbnailUrl"]);
    });

    // PT-4f, D209b. `undefined` is the WHOLE answer, for the same reason
    // `readAssetById` is: an asset here is named by its path, and there is no
    // bucket for a presigned URL to point into. `?name=` on fs streams its bytes,
    // so the redirect branch is never reached here — and it is reached on
    // `objectStore() === "s3"` alone, never on this answer, precisely because fs
    // answers `undefined` for every asset it has.
    test("assetObjectKey answers undefined for every ref, with a file present", async () => {
      await store.writeAsset("camp-1", "logo.png", pngBytes);
      expect(await store.assetObjectKey("camp-1", "logo.png")).toBeUndefined();
      expect(await store.assetObjectKey("camp-1", "missing.png")).toBeUndefined();
      expect(await store.assetObjectKey("no-such-brief", "logo.png")).toBeUndefined();
      // Even a traversal, which `resolveConfined` would refuse anyway: there is
      // nothing to confine TO.
      expect(await store.assetObjectKey("../escape", "logo.png")).toBeUndefined();
      // The file is untouched and still readable by the path it really has.
      expect(await store.readAsset("camp-1", "logo.png")).toEqual(pngBytes);
    });
  });

  test("listAssets returns empty array for non-existent brief directory or invalid briefId", async () => {
    expect(await store.listAssets("non-existent-brief")).toEqual([]);
    expect(await store.listAssets("../invalid-escape")).toEqual([]);
  });

  test("listAssets lists, formats MIME type, size, and fetchable thumbnail URL for valid assets", async () => {
    await store.writeAsset("camp-1", "logo-b.png", pngBytes);
    await store.writeAsset("camp-1", "hero-a.jpg", jpegBytes);
    // Non-matching file should be ignored
    writeFileSync(join(dir, "camp-1", "notes.txt"), "hello");

    const list = await store.listAssets("camp-1");
    expect(list).toHaveLength(2);
    // Sorted by name: hero-a.jpg first, then logo-b.png
    expect(list[0].name).toBe("hero-a.jpg");
    expect(list[0].type).toBe("image/jpeg");
    expect(list[0].size).toBe(jpegBytes.length);
    expect(list[0].thumbnailUrl).toBe(
      "/api/pipeline/campaigns/assets?briefId=camp-1&name=hero-a.jpg",
    );

    expect(list[1].name).toBe("logo-b.png");
    expect(list[1].type).toBe("image/png");
    expect(list[1].size).toBe(pngBytes.length);
    expect(list[1].thumbnailUrl).toBe(
      "/api/pipeline/campaigns/assets?briefId=camp-1&name=logo-b.png",
    );
  });

  test("listAssets formats audio content types (VE3b2)", async () => {
    await store.writeAsset("camp-1", "bed.mp3", mp3Bytes);
    await store.writeAsset("camp-1", "bed.m4a", m4aBytes);

    const list = await store.listAssets("camp-1");
    expect(list).toHaveLength(2);
    const byName = Object.fromEntries(list.map((a) => [a.name, a.type]));
    expect(byName["bed.m4a"]).toBe("audio/mp4");
    expect(byName["bed.mp3"]).toBe("audio/mpeg");
  });

  test("copyAssets copies all brief assets from source to destination including nested files", async () => {
    await store.writeAsset("camp-src", "logo.png", pngBytes);
    await store.writeAsset("camp-src", "bg.jpg", jpegBytes);

    // Create a nested file in camp-src
    mkdirSync(join(dir, "camp-src", "sub", "dir"), { recursive: true });
    writeFileSync(join(dir, "camp-src", "sub", "dir", "nested.png"), pngBytes);

    const { paths: map, created } = await store.copyAssets("camp-src", "camp-dst");

    expect(existsSync(join(dir, "camp-dst", "logo.png"))).toBe(true);
    expect(existsSync(join(dir, "camp-dst", "bg.jpg"))).toBe(true);
    expect(existsSync(join(dir, "camp-dst", "sub", "dir", "nested.png"))).toBe(true);
    expect(readFileSync(join(dir, "camp-dst", "logo.png"))).toEqual(pngBytes);
    expect(readFileSync(join(dir, "camp-dst", "bg.jpg"))).toEqual(jpegBytes);
    expect(readFileSync(join(dir, "camp-dst", "sub", "dir", "nested.png"))).toEqual(pngBytes);

    expect(map["logo.png"]).toBe("logo.png");
    expect(map["sub/dir/nested.png"]).toBe("sub/dir/nested.png");
    expect(map["assets/inputs/camp-src/sub/dir/nested.png"]).toBe(
      "assets/inputs/camp-dst/sub/dir/nested.png",
    );
    // Every source file was fresh-copied: `created` has exactly as many entries
    // as sources, and each relPath is in it.
    expect(created.size).toBe(3);
    expect(created.has("logo.png")).toBe(true);
    expect(created.has("bg.jpg")).toBe(true);
    expect(created.has("sub/dir/nested.png")).toBe(true);
  });

  test("copyAssets disambiguates same-name assets with differing content from multiple sources", async () => {
    const diffPngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x99, 0x88, 0x77]);
    await store.writeAsset("src-a", "logo.png", pngBytes);
    await store.writeAsset("src-b", "logo.png", diffPngBytes);

    const { paths: mapA, created: createdA } = await store.copyAssets("src-a", "target");
    const { paths: mapB, created: createdB } = await store.copyAssets("src-b", "target");

    expect(mapA["logo.png"]).toBe("logo.png");
    expect(mapB["logo.png"]).toBe("logo-src-b.png");
    // Both copied fresh: `created` holds each copy's target relPath.
    expect(createdA.size).toBe(1);
    expect(createdA.has("logo.png")).toBe(true);
    expect(createdB.size).toBe(1);
    expect(createdB.has("logo-src-b.png")).toBe(true);

    expect(readFileSync(join(dir, "target", "logo.png"))).toEqual(pngBytes);
    expect(readFileSync(join(dir, "target", "logo-src-b.png"))).toEqual(diffPngBytes);

    // If copying same bytes again, does not create duplicate
    const { paths: mapC, created: createdC } = await store.copyAssets("src-a", "target");
    expect(mapC["logo.png"]).toBe("logo.png");
    // `logo.png` already held these exact bytes — a sha-deduped reuse, so `created` is empty.
    expect(createdC.size).toBe(0);
    expect(createdC.has("logo.png")).toBe(false);

    // Pre-populate target to exercise candidate collision loop and candidate reuse
    const diffPngBytes2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x11, 0x22, 0x33]);
    await store.writeAsset("src-c", "logo.png", diffPngBytes2);
    await store.writeAsset(
      "target",
      "logo-src-c.png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xaa, 0xbb, 0xcc]),
    );
    const { paths: mapD, created: createdD } = await store.copyAssets("src-c", "target");
    expect(mapD["logo.png"]).toBe("logo-src-c-2.png");
    expect(readFileSync(join(dir, "target", "logo-src-c-2.png"))).toEqual(diffPngBytes2);
    // `logo-src-c-2.png` is a fresh name: `created` holds it.
    expect(createdD.size).toBe(1);
    expect(createdD.has("logo-src-c-2.png")).toBe(true);

    // If copying src-c again with identical bytes, it matches existing candidate bytes and reuses logo-src-c-2.png
    const { paths: mapE, created: createdE } = await store.copyAssets("src-c", "target");
    expect(mapE["logo.png"]).toBe("logo-src-c-2.png");
    // Same bytes under the suffixed candidate — a sha-deduped reuse, so `created` is empty.
    expect(createdE.size).toBe(0);
    expect(createdE.has("logo-src-c-2.png")).toBe(false);

    // Nested directory collision disambiguation
    mkdirSync(join(dir, "src-nested-a", "sub", "dir"), { recursive: true });
    mkdirSync(join(dir, "src-nested-b", "sub", "dir"), { recursive: true });
    mkdirSync(join(dir, "target", "sub", "dir"), { recursive: true });
    writeFileSync(join(dir, "src-nested-a", "sub", "dir", "icon.png"), pngBytes);
    writeFileSync(join(dir, "src-nested-b", "sub", "dir", "icon.png"), diffPngBytes);
    writeFileSync(
      join(dir, "target", "sub", "dir", "icon-src-nested-b.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x99]),
    );

    const { paths: mapNestA, created: createdNestA } = await store.copyAssets(
      "src-nested-a",
      "target",
    );
    const { paths: mapNestB, created: createdNestB } = await store.copyAssets(
      "src-nested-b",
      "target",
    );
    expect(mapNestA["sub/dir/icon.png"]).toBe("sub/dir/icon.png");
    expect(mapNestB["sub/dir/icon.png"]).toBe("sub/dir/icon-src-nested-b-2.png");
    expect(readFileSync(join(dir, "target", "sub", "dir", "icon-src-nested-b-2.png"))).toEqual(
      diffPngBytes,
    );
    // Both nested copies are fresh names: `created` holds each.
    expect(createdNestA.size).toBe(1);
    expect(createdNestA.has("sub/dir/icon.png")).toBe(true);
    expect(createdNestB.size).toBe(1);
    expect(createdNestB.has("sub/dir/icon-src-nested-b-2.png")).toBe(true);
  });

  test("copyAssets handles same source and destination, missing source, or empty source gracefully", async () => {
    expect(await store.copyAssets("same-id", "same-id")).toEqual({ paths: {}, created: new Set() }); // No-op
    expect(await store.copyAssets("missing-src", "dst")).toEqual({ paths: {}, created: new Set() }); // No-op
    expect(await store.copyAssets("../invalid-src", "dst")).toEqual({
      paths: {},
      created: new Set(),
    }); // No-op

    mkdirSync(join(dir, "empty-src"), { recursive: true });
    expect(await store.copyAssets("empty-src", "dst")).toEqual({ paths: {}, created: new Set() });
    expect(existsSync(join(dir, "dst"))).toBe(false);
  });

  test("copyAssets marks a fresh copy as created", async () => {
    // Every source file is fresh: `created` has exactly as many entries as
    // sources, and each target relPath is in it.
    await store.writeAsset("src-fresh", "logo.png", pngBytes);
    await store.writeAsset("src-fresh", "bg.jpg", jpegBytes);

    const { paths, created } = await store.copyAssets("src-fresh", "dst-fresh");
    expect(created.size).toBe(2);
    expect(created.has("logo.png")).toBe(true);
    expect(created.has("bg.jpg")).toBe(true);
    expect(paths["logo.png"]).toBe("logo.png");
    expect(paths["bg.jpg"]).toBe("bg.jpg");
  });

  test("copyAssets never marks a sha-deduped reuse as created", async () => {
    // The target already holds the same bytes under the same name: a sha-deduped
    // reuse, so nothing is minted and `created` is empty.
    await store.writeAsset("src-reuse", "logo.png", pngBytes);
    await store.writeAsset("target-reuse", "logo.png", pngBytes);

    const { paths, created } = await store.copyAssets("src-reuse", "target-reuse");
    expect(created.size).toBe(0);
    expect(created.has("logo.png")).toBe(false);
    expect(paths["logo.png"]).toBe("logo.png");
  });

  test("copyAssets never overwrites or claims a file an upload created mid-copy", async () => {
    // The "upload": different bytes at the plain destination that appear
    // between the copy's read (ENOENT) and its wx write (EEXIST).
    const uploadBytes = Buffer.from([0xff, 0x00, 0xff, 0x00]);
    const uploadPath = join(dir, "target", "logo.png");
    mkdirSync(join(dir, "target"), { recursive: true });
    writeFileSync(uploadPath, uploadBytes);

    // Source carries different bytes.
    await store.writeAsset("src-race", "logo.png", pngBytes);

    // The copy's first read of the target answers ENOENT (the upload appeared
    // between the copy's read and its wx write); all later reads see the real file.
    fsRace.failNextRead = true;
    fsRace.failPath = uploadPath;

    const { paths, created } = await store.copyAssets("src-race", "target");

    // (a) the upload's bytes are unchanged — the copy never overwrote them
    expect(readFileSync(uploadPath)).toEqual(uploadBytes);
    // (b) the upload's path is NOT in created
    expect(created.has("logo.png")).toBe(false);
    // (c) the source landed at a disambiguated path, which IS in created, and
    //     paths maps the original name to it
    expect(created.has("logo-src-race.png")).toBe(true);
    expect(paths["logo.png"]).toBe("logo-src-race.png");
  });

  test("copyAssets does not rewrite a sha-deduped reuse", async () => {
    await store.writeAsset("src-reuse", "logo.png", pngBytes);
    await store.writeAsset("target-reuse", "logo.png", pngBytes);

    const reusedPath = join(dir, "target-reuse", "logo.png");
    const beforeMtime = statSync(reusedPath).mtimeMs;

    const { paths, created } = await store.copyAssets("src-reuse", "target-reuse");

    // No write happened to the reused path — the copy's read found matching
    // bytes and skipped the write entirely.
    expect(statSync(reusedPath).mtimeMs).toBe(beforeMtime);
    // The reused path is NOT in created.
    expect(created.has("logo.png")).toBe(false);
    // paths still maps correctly (the name maps to itself).
    expect(paths["logo.png"]).toBe("logo.png");
  });

  describe("deleteAssets (PT-5b2 fix-round item 2)", () => {
    test("removes every asset stored under a brief", async () => {
      await store.writeAsset("camp-1", "logo.png", pngBytes);
      await store.writeAsset("camp-1", "banner.jpg", jpegBytes);
      await store.deleteAssets("camp-1");
      expect(existsSync(join(dir, "camp-1"))).toBe(false);
    });

    test("is a no-op when the brief has no assets", async () => {
      await expect(store.deleteAssets("never-had-assets")).resolves.toBeUndefined();
    });

    test("is a no-op for an unsafe id (never escapes the confined root)", async () => {
      await expect(store.deleteAssets("../escape")).resolves.toBeUndefined();
    });
  });
});
