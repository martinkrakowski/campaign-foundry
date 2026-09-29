import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { FsBriefStore } from "../fs-brief-store.js";
import { FsDraftStore } from "../fs-draft-store.js";
import { dumpBrief, hashBytes } from "../../brief-files.js";

// Hookable `writeFile`/`lstat`, each used by exactly one test below (the
// createCampaign write-failure test, and the isCampaignDirUnsafe non-ENOENT
// lstat test): every other test leaves both hooks undefined, which falls
// straight through to the real implementation, so this mock changes nothing
// for them.
const fsHook = vi.hoisted(() => ({
  writeFile: undefined as
    | ((path: string, data: unknown, options?: unknown) => Promise<void>)
    | undefined,
  lstat: undefined as ((path: string) => Promise<unknown>) | undefined,
  rmdir: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: (path: string, data: unknown, options?: unknown) =>
      fsHook.writeFile
        ? fsHook.writeFile(path, data, options)
        : (actual.writeFile as unknown as (p: string, d: unknown, o?: unknown) => Promise<void>)(
            path,
            data,
            options,
          ),
    lstat: (path: string, options?: unknown) =>
      fsHook.lstat
        ? fsHook.lstat(path)
        : (actual.lstat as unknown as (p: string, o?: unknown) => Promise<unknown>)(path, options),
    rmdir: (path: string, options?: unknown) =>
      fsHook.rmdir
        ? fsHook.rmdir(path)
        : (actual.rmdir as unknown as (p: string, o?: unknown) => Promise<void>)(path, options),
  };
});

const minimalBrief: CampaignBrief = {
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "test-camp",
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build great things",
  products: [{ id: "prod-1", name: "Product 1", primaryColor: "#1473E6", logoPath: "logo.png" }],
};

describe("FsBriefStore", () => {
  let dir: string;
  let store: FsBriefStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-fs-brief-store-"));
    store = new FsBriefStore(dir);
  });

  afterEach(() => {
    fsHook.writeFile = undefined;
    fsHook.lstat = undefined;
    fsHook.rmdir = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  test("getBriefsDir returns configured directory", () => {
    expect(store.getBriefsDir()).toBe(dir);
  });

  test("listBriefs returns empty array when directory does not exist", async () => {
    const nonExistentStore = new FsBriefStore(join(dir, "non-existent"));
    expect(await nonExistentStore.listBriefs()).toEqual([]);
  });

  // `chmod 000` does not block reads for root, and does nothing at all on Windows,
  // so the EACCES this test induces is unavailable in those environments. Skip rather
  // than fail: the branch it covers is exercised by the route-level test, which mocks
  // the store instead of relying on filesystem permissions.
  const canDenyRead = process.platform !== "win32" && process.getuid?.() !== 0;
  test.skipIf(!canDenyRead)(
    "listBriefs rethrows when readdir fails with a non-ENOENT errno",
    async () => {
      chmodSync(dir, 0o000);
      try {
        await expect(store.listBriefs()).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );

  test("listBriefs lists, sorts, and parses valid briefs while skipping invalid files", async () => {
    const yamlA =
      "id: camp-a\ntargetRegion: US\ntargetAudience: dev\ncampaignMessage: A\nproducts:\n  - id: p1\n";
    const yamlB =
      "id: camp-b\ntargetRegion: US\ntargetAudience: dev\ncampaignMessage: B\nproducts:\n  - id: p2\n";
    writeFileSync(join(dir, "camp-b.yaml"), yamlB);
    writeFileSync(join(dir, "camp-a.yaml"), yamlA);
    writeFileSync(join(dir, "bad.yaml"), "invalid: yaml: content: [");
    writeFileSync(join(dir, "not-a-brief.txt"), "hello");

    const list = await store.listBriefs();
    expect(list).toHaveLength(2);
    expect(list[0].file).toBe("camp-a.yaml");
    expect(list[0].brief.id).toBe("camp-a");
    expect(list[0].revision).toBe(hashBytes(Buffer.from(yamlA, "utf8")));
    expect(list[1].file).toBe("camp-b.yaml");
    expect(list[1].brief.id).toBe("camp-b");
    expect(list[1].revision).toBe(hashBytes(Buffer.from(yamlB, "utf8")));
  });

  /**
   * SL-D6, the reason the loader clamps instead of refusing. The `catch` above
   * (`listBriefs` warns and skips) is what makes a refusal invisible: a stored
   * `minDistance: 0` would drop the operator's campaign out of the picker
   * entirely, and they could not open it to fix the field. So the assertion is
   * that the brief is STILL LISTED, carrying 1 — and that the next Save migrates
   * the document, so the clamp is a one-time read-repair rather than a warning
   * the operator gets forever. `patchBriefYaml` diffs the on-disk 0 against the
   * parsed 1 and writes the path, which is what makes that true; asserting the
   * FILE TEXT is what makes it measured rather than reasoned.
   */
  test("a stored minDistance of 0 still lists, carrying 1, and Save migrates it (SL-D6)", async () => {
    const yaml =
      "id: camp-zero\ntargetRegion: US\ntargetAudience: dev\ncampaignMessage: Z\n" +
      "mode: variation\nproducts:\n  - id: p1\nvariation:\n  count: 2\n  minDistance: 0\n";
    writeFileSync(join(dir, "camp-zero.yaml"), yaml);

    const list = await store.listBriefs();
    expect(list.map((entry) => entry.brief.id)).toEqual(["camp-zero"]);
    expect(list[0].brief.variation?.minDistance).toBe(1);

    await store.rewriteBrief(list[0].brief);
    const migrated = readFileSync(join(dir, "camp-zero.yaml"), "utf8");
    expect(migrated).toMatch(/minDistance: 1/);
    expect(migrated).not.toMatch(/minDistance: 0/);
  });

  test("findBriefById finds brief by domain id and findBriefFileById returns file key", async () => {
    await store.createBrief(minimalBrief);
    const found = await store.findBriefById("test-camp");
    expect(found).toBeDefined();
    expect(found?.brief.id).toBe("test-camp");
    expect(found?.file).toBe("test-camp.yaml");

    const fileKey = await store.findBriefFileById("test-camp");
    expect(fileKey).toBe("test-camp.yaml");

    expect(await store.findBriefById("missing")).toBeUndefined();
    expect(await store.findBriefFileById("missing")).toBeUndefined();
  });

  // Ported from brief-files.test.ts when its path-returning wrappers were deleted
  // (PT-0a): the behaviour lives in the store, so it is asserted on the store's
  // file keys, never on disk paths.
  const campYaml =
    "id: camp\ntargetRegion: DE\ntargetAudience: a\ncampaignMessage: Hi\nproducts:\n  - id: alpha\n  - id: beta\n";

  test("findBriefFileById matches brief.id, not filename, skipping junk, unparseable files and symlinks", async () => {
    writeFileSync(join(dir, "sample-campaign.yaml"), campYaml);
    writeFileSync(join(dir, "bad.yaml"), "id: 1\nproducts: not-an-array\n");
    writeFileSync(join(dir, "ignore.txt"), "not a brief");
    writeFileSync(join(dir, "winter.json"), JSON.stringify({ ...minimalBrief, id: "winter" }));
    const outside = join(dir, "..", `${basename(dir)}-outside.yaml`);
    writeFileSync(outside, campYaml.replace("id: camp", "id: linked"));
    symlinkSync(outside, join(dir, "linked.yaml"));
    try {
      expect(await store.findBriefFileById("camp")).toBe("sample-campaign.yaml");
      expect(await store.findBriefFileById("winter")).toBe("winter.json");
      expect(await store.findBriefFileById("linked")).toBeUndefined(); // symlink, not a regular file
      expect(await store.findBriefById("camp")).toMatchObject({
        file: "sample-campaign.yaml",
        brief: { id: "camp" },
      });
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("findBriefFileById and findBriefFile answer undefined when the briefs directory is missing", async () => {
    const missing = new FsBriefStore(join(dir, "nope"));
    expect(await missing.findBriefFileById("camp")).toBeUndefined();
    expect(await missing.findBriefFile("camp")).toBeUndefined();
  });

  test("findBriefFile skips a directory with a brief name and falls back to json", async () => {
    mkdirSync(join(dir, "only-dir.yaml"), { recursive: true }); // not a file → skipped
    writeFileSync(join(dir, "only-dir.yml"), "id: only-dir\n");
    expect(await store.findBriefFile("only-dir", [".yaml", ".yml"])).toBe("only-dir.yml");
    writeFileSync(join(dir, "json-only.json"), "{}");
    expect(await store.findBriefFile("json-only")).toBe("json-only.json");
  });

  test("findBriefFile checks extensions in order and returns relative file key", async () => {
    writeFileSync(join(dir, "both.yml"), "id: both\n");
    writeFileSync(join(dir, "both.yaml"), "id: both\n");
    expect(await store.findBriefFile("both")).toBe("both.yaml");
    expect(await store.findBriefFile("missing")).toBeUndefined();
    expect(await store.findBriefFile("../traversal")).toBeUndefined();
  });

  test("readBrief parses brief by key or domain id and rejects unconfined paths", async () => {
    await store.createBrief(minimalBrief);
    const fromKey = await store.readBrief("test-camp.yaml");
    expect(fromKey.id).toBe("test-camp");

    const fromId = await store.readBrief("test-camp");
    expect(fromId.id).toBe("test-camp");

    const fromConfinedPath = await store.readBrief(join(dir, "test-camp.yaml"));
    expect(fromConfinedPath.id).toBe("test-camp");

    // Security: rejects absolute paths outside this.dir and traversal
    await expect(store.readBrief("/etc/hosts")).rejects.toThrow(
      /Path escapes the allowed directory/,
    );
    await expect(store.readBrief("../../etc/passwd")).rejects.toThrow(
      /Path escapes the allowed directory/,
    );
  });

  test("createBrief creates file exclusively and fails with EEXIST if duplicate", async () => {
    const created = await store.createBrief(minimalBrief);
    expect(created.file).toBe("test-camp.yaml");
    expect(created.brief.id).toBe("test-camp");
    expect(created.revision).toBeTruthy();

    await expect(store.createBrief(minimalBrief)).rejects.toMatchObject({ code: "EEXIST" });
  });

  describe("campaignTeam (PT-5b2 fix-round item 1)", () => {
    test("answers null for an existing brief (no team column), undefined for absent", async () => {
      await store.createBrief(minimalBrief);
      expect(await store.campaignTeam("test-camp")).toBeNull();
      expect(await store.campaignTeam("nope")).toBeUndefined();
    });
  });

  describe("createCampaign (D177/D179, PT-5b2)", () => {
    test("mints a reserved directory, never a file", async () => {
      const created = await store.createCampaign("fresh-slug");
      expect(created).toEqual({ campaignId: "fresh-slug", slug: "fresh-slug" });
      expect(existsSync(join(dir, "fresh-slug"))).toBe(true);
      expect(existsSync(join(dir, "fresh-slug.yaml"))).toBe(false);
      expect(await store.campaignVisibility("fresh-slug")).toBe("absent");
      expect(await store.findBriefById("fresh-slug")).toBeUndefined();
    });

    test("writes the display name and type into campaign.json (PT-5b3, D168, D177)", async () => {
      await store.createCampaign("named-slug", { name: "My Campaign", type: "paid-social" });
      const raw = readFileSync(join(dir, "named-slug", "campaign.json"), "utf8");
      expect(JSON.parse(raw)).toEqual({ name: "My Campaign", type: "paid-social" });
    });

    test("records null name and type when options omit them (PT-5b3)", async () => {
      await store.createCampaign("blank-meta");
      const raw = readFileSync(join(dir, "blank-meta", "campaign.json"), "utf8");
      expect(JSON.parse(raw)).toEqual({ name: null, type: null });
    });

    // coderabbit PRRT_kwDOSzP1zc6miLda / qodo PRRT_kwDOSzP1zc6miLvn: a failed
    // campaign.json write (ENOSPC, EACCES) must not leave the `mkdir`
    // reservation behind — the caller never gets a `ResolvedCampaign` to
    // `releaseCampaign`, so nothing else would ever free the slug.
    test("a failed campaign.json write releases the reservation, freeing the slug", async () => {
      fsHook.writeFile = async () => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      };
      await expect(store.createCampaign("doomed", { name: "Doomed" })).rejects.toMatchObject({
        code: "ENOSPC",
      });
      expect(existsSync(join(dir, "doomed"))).toBe(false);

      fsHook.writeFile = undefined;
      const created = await store.createCampaign("doomed", { name: "Retry" });
      expect(created).toEqual({ campaignId: "doomed", slug: "doomed" });
    });

    test("a cleanup rmdir that also fails never masks the write's own error", async () => {
      fsHook.writeFile = async () => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      };
      fsHook.rmdir = async () => {
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      };
      await expect(store.createCampaign("stuck", { name: "Stuck" })).rejects.toMatchObject({
        code: "ENOSPC",
      });
    });

    test("a taken slug (an existing directory) is EEXIST", async () => {
      await store.createCampaign("taken-dir");
      await expect(store.createCampaign("taken-dir")).rejects.toMatchObject({ code: "EEXIST" });
    });

    test("a taken slug (an existing brief file) is EEXIST", async () => {
      await store.createBrief({ ...minimalBrief, id: "taken-file" });
      await expect(store.createCampaign("taken-file")).rejects.toMatchObject({ code: "EEXIST" });
    });

    // coderabbit PRRT_kwDOSzP1zc6mgBu7 / qodo PRRT_kwDOSzP1zc6mgEyH: a brief's
    // id can live in a differently named file — findBriefFile(slug) alone
    // (a filename check) misses it; findBriefFileById (an id-parsed lookup,
    // same one campaignVisibility already relies on) must be checked too.
    test("a taken slug (an id living in a differently-named file) is EEXIST", async () => {
      writeFileSync(
        join(dir, "sample-campaign.yaml"),
        "id: my-copy\ntargetRegion: DE\ntargetAudience: a\ncampaignMessage: Hi\nproducts:\n  - id: alpha\n",
      );
      await expect(store.createCampaign("my-copy")).rejects.toMatchObject({ code: "EEXIST" });
    });

    test.each(["cache", "jobs", "orgs", "packages"] as const)(
      "refuses a reserved campaign id %s",
      async (id) => {
        await expect(store.createCampaign(id)).rejects.toThrow(
          `"${id}" is reserved; choose another campaign id.`,
        );
      },
    );

    test("throws TeamsNotSupportedError for a non-undefined teamId", async () => {
      await expect(store.createCampaign("teamed", { teamId: "t1" })).rejects.toMatchObject({
        name: "TeamsNotSupportedError",
      });
      await expect(store.createCampaign("teamed", { teamId: null })).rejects.toMatchObject({
        name: "TeamsNotSupportedError",
      });
    });

    test("the reserved directory never blocks the first Save's <slug>.yaml write", async () => {
      await store.createCampaign("first-save");
      const created = await store.createBrief({ ...minimalBrief, id: "first-save" });
      expect(created.file).toBe("first-save.yaml");
      expect(existsSync(join(dir, "first-save"))).toBe(true);
      expect(existsSync(join(dir, "first-save.yaml"))).toBe(true);
      expect((await store.findBriefById("first-save"))?.brief.id).toBe("first-save");
    });

    test("two concurrent creates of the same slug: exactly one wins, the other is EEXIST", async () => {
      const results = await Promise.allSettled([
        store.createCampaign("race-slug"),
        store.createCampaign("race-slug"),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "EEXIST" });
    });

    const canDenyWrite = process.platform !== "win32" && process.getuid?.() !== 0;
    test.skipIf(!canDenyWrite)(
      "rethrows a non-EEXIST mkdir failure (e.g. EACCES) unchanged",
      async () => {
        // 0o555 (read+execute, no write): the findBriefFile/findBriefFileById
        // "taken" checks (readdir/lstat, read-only) still succeed — chmod
        // 0o000 made THOSE throw EACCES first, so the mkdir catch this test
        // means to exercise was never reached. Only mkdir's own need to
        // write a new entry into this.dir fails.
        chmodSync(dir, 0o555);
        try {
          await expect(store.createCampaign("denied")).rejects.toMatchObject({ code: "EACCES" });
        } finally {
          chmodSync(dir, 0o755);
        }
      },
    );
  });

  describe("releaseCampaign (PT-5b2 fix-round item 2)", () => {
    test("removes a reserved directory (with its campaign.json) and answers true", async () => {
      await store.createCampaign("mint-only", { name: "Mint Only", type: "social-post" });
      expect(existsSync(join(dir, "mint-only", "campaign.json"))).toBe(true);
      expect(await store.releaseCampaign("mint-only")).toBe(true);
      expect(existsSync(join(dir, "mint-only"))).toBe(false);
    });

    // PT-5d item 3: a caller that abandons a blank create (the create itself
    // fails, or the user backs out before the first Save) must not orphan a
    // draft that was autosaved against it in the meantime.
    test("PT-5d: a failed blank create with a draft is released along with it", async () => {
      const { campaignId } = await store.createCampaign("mint-only", { name: "Mint Only" });
      await new FsDraftStore(dir).writeDraft(campaignId, "u1", { name: "Draft" }, null);
      expect(existsSync(join(dir, "mint-only", "drafts", "u1.json"))).toBe(true);
      expect(await store.releaseCampaign("mint-only")).toBe(true);
      expect(existsSync(join(dir, "mint-only"))).toBe(false);
    });

    test("PT-5d: removes every user's draft, not just one", async () => {
      const { campaignId } = await store.createCampaign("mint-only");
      const drafts = new FsDraftStore(dir);
      await drafts.writeDraft(campaignId, "u1", { name: "Mine" }, null);
      await drafts.writeDraft(campaignId, "u2", { name: "Theirs" }, null);
      expect(await store.releaseCampaign("mint-only")).toBe(true);
      expect(existsSync(join(dir, "mint-only"))).toBe(false);
    });

    // A symlinked drafts/ must refuse the whole release, the same stance a
    // symlinked <slug> itself already takes — never enumerate or delete
    // through it.
    test("PT-5d: refuses release through a symlinked drafts/ directory", async () => {
      const outside = mkdtempSync(join(tmpdir(), "cf-outside-"));
      try {
        const outsideFile = join(outside, "u1.json");
        writeFileSync(outsideFile, "not yours");
        await store.createCampaign("mint-only");
        symlinkSync(outside, join(dir, "mint-only", "drafts"));

        expect(await store.releaseCampaign("mint-only")).toBe(false);
        expect(existsSync(outsideFile)).toBe(true);
        expect(existsSync(join(dir, "mint-only"))).toBe(true);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    // Backward compatibility (PT-5b3): a directory reserved before this lane
    // shipped never got a campaign.json — `entries` is `[]`, not
    // `["campaign.json"]`, so the "nothing else is there" check must still
    // pass and the unlink must be skipped rather than attempted.
    test("removes a pre-lane reservation with no campaign.json", async () => {
      mkdirSync(join(dir, "old-reservation"));
      expect(await store.releaseCampaign("old-reservation")).toBe(true);
      expect(existsSync(join(dir, "old-reservation"))).toBe(false);
    });

    test("leaves a real brief untouched and answers false", async () => {
      await store.createBrief(minimalBrief);
      expect(await store.releaseCampaign("test-camp")).toBe(false);
      expect(existsSync(join(dir, "test-camp.yaml"))).toBe(true);
    });

    test("answers false, not a crash, for a non-empty directory (a leftover pool file)", async () => {
      await store.createCampaign("mint-only");
      writeFileSync(join(dir, "mint-only", "pools.json"), "{}");
      expect(await store.releaseCampaign("mint-only")).toBe(false);
      expect(existsSync(join(dir, "mint-only"))).toBe(true);
    });

    test("answers false for a slug that was never reserved", async () => {
      expect(await store.releaseCampaign("nope")).toBe(false);
    });

    // A plain file where the reservation directory should be: findBriefFileById
    // skips it (no recognized brief extension), so this reaches
    // `isCampaignDirUnsafe`, which now refuses it — `!isDirectory()` is true
    // for a plain file exactly as it is for a symlink — before readdir ever runs.
    test("answers false (not a crash) when <slug> is a plain file, not a directory", async () => {
      writeFileSync(join(dir, "not-a-dir"), "x");
      expect(await store.releaseCampaign("not-a-dir")).toBe(false);
      expect(existsSync(join(dir, "not-a-dir"))).toBe(true);
    });

    const canDenyWriteRelease = process.platform !== "win32" && process.getuid?.() !== 0;
    test.skipIf(!canDenyWriteRelease)(
      "rethrows a rmdir failure (e.g. EACCES) unchanged",
      async () => {
        await store.createCampaign("mint-only");
        // 0o555 (read+execute, no write): findBriefFileById's own readdir and
        // this method's own readdir/unlink (mint-only's own permissions are
        // untouched) still succeed — only rmdir's need to remove the "mint-only"
        // entry from its parent fails, so this exercises rmdir's own rejection,
        // propagated with no catch around it.
        chmodSync(dir, 0o555);
        try {
          await expect(store.releaseCampaign("mint-only")).rejects.toMatchObject({
            code: "EACCES",
          });
        } finally {
          chmodSync(dir, 0o755);
        }
      },
    );

    const canDenyReadRelease = process.platform !== "win32" && process.getuid?.() !== 0;
    test.skipIf(!canDenyReadRelease)(
      "rethrows a non-ENOENT readdir failure (e.g. EACCES) unchanged",
      async () => {
        await store.createCampaign("unreadable-release");
        // 0o000 on the reservation directory ITSELF (not its parent):
        // `isCampaignDirUnsafe`'s `lstat` only needs to traverse `dir`
        // (untouched) to see this entry and its type, which still succeeds —
        // only this method's own `readdir` of the directory's own contents
        // fails, the rethrow branch this test exists for.
        chmodSync(join(dir, "unreadable-release"), 0o000);
        try {
          await expect(store.releaseCampaign("unreadable-release")).rejects.toMatchObject({
            code: "EACCES",
          });
        } finally {
          chmodSync(join(dir, "unreadable-release"), 0o755);
        }
      },
    );

    // qodo PRRT_kwDOSzP1zc6miLvm (security): a symlinked `<slug>` directory
    // must be refused BEFORE any readdir/unlink — enumerating or deleting
    // through it could touch a file outside the briefs root.
    test("refuses a symlinked <slug> directory, leaving the outside file in place", async () => {
      const outside = mkdtempSync(join(tmpdir(), "cf-outside-"));
      try {
        const outsideMeta = join(outside, "campaign.json");
        writeFileSync(outsideMeta, JSON.stringify({ name: "Not Yours", type: "display-ad" }));
        symlinkSync(outside, join(dir, "linked-slug"));

        expect(await store.releaseCampaign("linked-slug")).toBe(false);
        expect(existsSync(outsideMeta)).toBe(true);
        expect(readFileSync(outsideMeta, "utf8")).toContain("Not Yours");
        // The symlink itself is untouched too — never removed on the way to refusing.
        expect(existsSync(join(dir, "linked-slug"))).toBe(true);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("campaignMeta (PT-5b3, D168, D177)", () => {
    test("answers undefined for an unknown ref", async () => {
      expect(await store.campaignMeta("nope")).toBeUndefined();
    });

    // qodo PRRT_kwDOSzP1zc6miLvl (security): a symlinked `<slug>` directory
    // pointing outside the briefs root must never be read through — GET
    // /campaigns/:id must not return that outside file's content.
    test("never reads through a symlinked <slug> directory", async () => {
      const outside = mkdtempSync(join(tmpdir(), "cf-outside-"));
      try {
        writeFileSync(
          join(outside, "campaign.json"),
          JSON.stringify({ name: "Not Yours", type: "display-ad" }),
        );
        symlinkSync(outside, join(dir, "linked-slug"));

        expect(await store.campaignMeta("linked-slug")).toBeUndefined();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    // isCampaignDirUnsafe's own rethrow: a non-ENOENT lstat failure (e.g. EIO)
    // propagates unchanged rather than being read as "safe" or "absent".
    test("rethrows a non-ENOENT lstat failure from isCampaignDirUnsafe unchanged", async () => {
      await store.createCampaign("lstat-fails", { name: "X" });
      fsHook.lstat = async (path: string) => {
        if (path.endsWith("lstat-fails")) {
          throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
        }
        throw new Error(`unexpected lstat(${path}) in this test`);
      };
      await expect(store.campaignMeta("lstat-fails")).rejects.toMatchObject({ code: "EIO" });
    });

    // campaignDirExists's own rethrow (PT-5c2 fix round, qodo PRRT_kwDOSzP1zc6m7irI):
    // it runs only once isCampaignDirUnsafe and readCampaignMeta have both answered
    // cleanly (a genuinely unreserved ref), so its own non-ENOENT lstat failure needs
    // a second, distinct lstat call on the same never-created slug — the first (inside
    // isCampaignDirUnsafe) must still answer ENOENT so the walk reaches this method.
    test("rethrows a non-ENOENT lstat failure from campaignDirExists unchanged", async () => {
      let calls = 0;
      fsHook.lstat = async (path: string) => {
        if (!path.endsWith("dir-exists-lstat-fails")) {
          throw new Error(`unexpected lstat(${path}) in this test`);
        }
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      };
      await expect(store.campaignMeta("dir-exists-lstat-fails")).rejects.toMatchObject({
        code: "EIO",
      });
    });

    test("a versionless create answers its recorded name/type and hasVersion: false", async () => {
      await store.createCampaign("versionless", { name: "Versionless", type: "short-video" });
      expect(await store.campaignMeta("versionless")).toEqual({
        campaignId: "versionless",
        slug: "versionless",
        name: "Versionless",
        type: "short-video",
        hasVersion: false,
      });
    });

    test("a versionless create with no name/type given answers null for both", async () => {
      await store.createCampaign("no-meta-given");
      expect(await store.campaignMeta("no-meta-given")).toEqual({
        campaignId: "no-meta-given",
        slug: "no-meta-given",
        name: null,
        type: null,
        hasVersion: false,
      });
    });

    test("a pre-lane campaign (a brief file, no reserved directory) answers null name/type and hasVersion: true", async () => {
      await store.createBrief(minimalBrief);
      expect(await store.campaignMeta("test-camp")).toEqual({
        campaignId: "test-camp",
        slug: "test-camp",
        name: null,
        type: null,
        hasVersion: true,
      });
    });

    test("saving a version never clears the name/type recorded at create (item 4)", async () => {
      await store.createCampaign("first-save-meta", { name: "First Save", type: "display-ad" });
      await store.createBrief({ ...minimalBrief, id: "first-save-meta" });
      expect(await store.campaignMeta("first-save-meta")).toEqual({
        campaignId: "first-save-meta",
        slug: "first-save-meta",
        name: "First Save",
        type: "display-ad",
        hasVersion: true,
      });
    });

    test("rethrows a non-ENOENT campaign.json read failure unchanged", async () => {
      await store.createCampaign("unreadable-meta");
      // A directory in place of a file makes readFile fail with EISDIR, not
      // ENOENT — this exercises the fail-closed rethrow, not the "no meta"
      // branch. Overwriting campaign.json itself lets the store's own
      // resolveConfined + readFile run unmolested up to that point.
      const metaPath = join(dir, "unreadable-meta", "campaign.json");
      rmSync(metaPath);
      mkdirSync(metaPath);
      await expect(store.campaignMeta("unreadable-meta")).rejects.toMatchObject({
        code: "EISDIR",
      });
    });

    // PT-5c2 fix round (qodo PRRT_kwDOSzP1zc6m7iq6): a saved version already
    // proves the campaign known on its own, so a corrupt campaign.json must
    // not block generate/plan/preview/save for it — unlike the versionless
    // case above, where campaign.json is the ONLY signal and stays fail-closed.
    test("a saved version tolerates an unreadable campaign.json, answering null name/type", async () => {
      await store.createCampaign("tolerant-meta", { name: "Will Be Lost", type: "display-ad" });
      await store.createBrief({ ...minimalBrief, id: "tolerant-meta" });
      const metaPath = join(dir, "tolerant-meta", "campaign.json");
      rmSync(metaPath);
      mkdirSync(metaPath); // same EISDIR-inducing trick as the rethrow test above
      expect(await store.campaignMeta("tolerant-meta")).toEqual({
        campaignId: "tolerant-meta",
        slug: "tolerant-meta",
        name: null,
        type: null,
        hasVersion: true,
      });
    });

    // PT-5c2 fix round (qodo PRRT_kwDOSzP1zc6m7irI): a bare `briefs/<slug>/`
    // reservation made before campaign.json existed (pre-PT-5b3) must still
    // answer known — neither `createCampaign` nor `createBrief` ever runs
    // here, only a plain `mkdirSync`, the shape a build from before PT-5b3
    // would have left behind.
    test("a bare pre-campaign.json reservation directory still answers known", async () => {
      mkdirSync(join(dir, "bare-reservation"));
      expect(await store.campaignMeta("bare-reservation")).toEqual({
        campaignId: "bare-reservation",
        slug: "bare-reservation",
        name: null,
        type: null,
        hasVersion: false,
      });
    });
  });

  test("rewriteBrief updates existing brief and checks revision when provided", async () => {
    const created = await store.createBrief(minimalBrief);
    const updated = await store.rewriteBrief(
      { ...minimalBrief, campaignMessage: "Updated message" },
      { expectedRevision: created.revision },
    );
    expect(updated.brief.campaignMessage).toBe("Updated message");
    expect(updated.revision).not.toBe(created.revision);

    // Conflict error when expectedRevision does not match
    await expect(
      store.rewriteBrief(
        { ...minimalBrief, campaignMessage: "Conflicting update" },
        { expectedRevision: created.revision },
      ),
    ).rejects.toMatchObject({ code: "ECONFLICT" });

    // Fails when brief does not exist
    await expect(
      store.rewriteBrief({ ...minimalBrief, id: "does-not-exist" }),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Fails when regular file exists but does not parse as a brief
    writeFileSync(join(dir, "unparseable.yaml"), "invalid: [");
    await expect(store.rewriteBrief({ ...minimalBrief, id: "unparseable" })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rewriteBrief refuses symlinks", async () => {
    const outside = join(dir, "outside.yaml");
    writeFileSync(outside, "id: linked\n");
    const link = join(dir, "linked.yaml");
    symlinkSync(outside, link);

    await expect(store.rewriteBrief({ ...minimalBrief, id: "linked" })).rejects.toThrow(
      /Refusing to write through a symlink/,
    );

    // Symlink on replaceBrief
    await expect(store.replaceBrief({ ...minimalBrief, id: "linked" })).rejects.toThrow(
      /Refusing to write through a symlink/,
    );
  });

  // `rewriteBrief` stages its bytes in a sibling temp file and renames it over the
  // brief. A *fixed* temp name means two overlapping writers share that one path:
  // the first rename consumes it and the second writer's rename fails with ENOENT,
  // though the brief is there and both writes were well-formed — and the writer
  // that does resolve returns a revision for bytes the shared temp file no longer
  // held. Both were observed in 100/100 paired runs before the fix. The pair is
  // repeated because one interleaving — a writer finishing before the other reaches
  // its write — hides the shared name entirely, and libuv picks it; twenty pairs
  // do not leave the result to which one it picked.
  test("two overlapping rewrites never fail each other", async () => {
    await store.createBrief(minimalBrief);
    const byA = { ...minimalBrief, campaignMessage: "written by A" };
    const byB = { ...minimalBrief, campaignMessage: "written by B" };

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const settled = await Promise.allSettled([store.rewriteBrief(byA), store.rewriteBrief(byB)]);
      const failures = settled.flatMap((s) => (s.status === "rejected" ? [String(s.reason)] : []));
      expect(failures, `overlapping rewrites shared one temp file (attempt ${attempt})`).toEqual(
        [],
      );

      const text = readFileSync(join(dir, "test-camp.yaml"), "utf8");
      expect(text.includes("written by A") || text.includes("written by B")).toBe(true);
    }
  });

  test("replaceBrief propagates non-ENOENT errors such as ECONFLICT", async () => {
    await store.createBrief(minimalBrief);
    await expect(
      store.replaceBrief(minimalBrief, { expectedRevision: "wrong-rev" }),
    ).rejects.toMatchObject({ code: "ECONFLICT" });
  });

  test("replaceBrief creates if missing and rewrites if existing", async () => {
    const created = await store.replaceBrief(minimalBrief);
    expect(created.file).toBe("test-camp.yaml");

    const replaced = await store.replaceBrief({ ...minimalBrief, campaignMessage: "Replaced" });
    expect(replaced.brief.campaignMessage).toBe("Replaced");
  });

  test("getRevision computes sha256 hash or returns undefined on missing/unconfined", async () => {
    const created = await store.createBrief(minimalBrief);
    expect(await store.getRevision("test-camp")).toBe(created.revision);
    expect(await store.getRevision(join(dir, "test-camp.yaml"))).toBe(created.revision);
    expect(await store.getRevision("non-existent")).toBeUndefined();
    expect(await store.getRevision("/etc/hosts")).toBeUndefined();
    expect(await store.getRevision("../../escape.yaml")).toBeUndefined();
  });

  test("exists returns true when file exists and false when missing/unconfined", async () => {
    expect(await store.exists("test-camp")).toBe(false);
    await store.createBrief(minimalBrief);
    expect(await store.exists("test-camp")).toBe(true);
    expect(await store.exists(join(dir, "test-camp.yaml"))).toBe(true);
    expect(await store.exists("missing-camp")).toBe(false);
    expect(await store.exists("/etc/hosts")).toBe(false);
    expect(await store.exists("../../escape.yaml")).toBe(false);
  });

  // D166 item 4/5: the filesystem backend has no team column, so
  // campaignVisibility only ever answers "absent" or "visible" — never
  // "hidden" — and any non-undefined teamId is refused outright.
  test("campaignVisibility answers 'visible' or 'absent', never 'hidden'", async () => {
    expect(await store.campaignVisibility("test-camp")).toBe("absent");
    await store.createBrief(minimalBrief);
    expect(await store.campaignVisibility("test-camp")).toBe("visible");
  });

  test("createBrief, rewriteBrief and replaceBrief all throw TeamsNotSupportedError for a non-undefined teamId", async () => {
    await expect(store.createBrief(minimalBrief, { teamId: "t1" })).rejects.toMatchObject({
      name: "TeamsNotSupportedError",
      statusCode: 400,
    });
    await expect(store.createBrief(minimalBrief, { teamId: null })).rejects.toMatchObject({
      name: "TeamsNotSupportedError",
    });

    await store.createBrief(minimalBrief);
    await expect(store.rewriteBrief(minimalBrief, { teamId: "t1" })).rejects.toMatchObject({
      name: "TeamsNotSupportedError",
    });
    await expect(store.replaceBrief(minimalBrief, { teamId: "t1" })).rejects.toMatchObject({
      name: "TeamsNotSupportedError",
    });

    // A plain write (teamId omitted entirely) is unaffected.
    const rewritten = await store.rewriteBrief({
      ...minimalBrief,
      campaignMessage: "Still fine",
    });
    expect(rewritten.brief.campaignMessage).toBe("Still fine");
  });

  test("createBrief refuses to write through a symlink", async () => {
    const outside = join(dir, "outside-create.yaml");
    writeFileSync(outside, "id: linked-create\n");
    const link = join(dir, "linked-create.yaml");
    symlinkSync(outside, link);

    await expect(store.createBrief({ ...minimalBrief, id: "linked-create" })).rejects.toThrow(
      /Refusing to write through a symlink/,
    );
  });

  test("withBriefLock serialises critical sections per brief ID", async () => {
    const order: string[] = [];
    let unlock: () => void = () => {};
    const lock = new Promise<void>((r) => (unlock = r));

    const p1 = store.withBriefLock("camp", async () => {
      await lock;
      order.push("p1");
    });
    const p2 = store.withBriefLock("camp", async () => {
      order.push("p2");
    });
    const pOther = store.withBriefLock("other", async () => {
      order.push("pOther");
    });

    await pOther;
    expect(order).toEqual(["pOther"]);
    unlock();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["pOther", "p1", "p2"]);
  });

  test.each(["cache", "jobs", "orgs", "packages"] as const)(
    "createBrief refuses reserved campaign id %s",
    async (id) => {
      await expect(store.createBrief({ ...minimalBrief, id })).rejects.toThrow(
        `"${id}" is reserved; choose another campaign id.`,
      );
    },
  );

  // D181 fix round 2 (Fable, Bug 2): a bare `briefs/<id>/` directory with no
  // campaign.json and no saved version — exactly what `FsPoolStore.writePool`
  // creates for ANY id, including a reserved one, via the inline-brief path
  // of POST /campaigns/pools/copy — must NOT grandfather a reserved mint.
  // `hasGenuineReservation` (unlike the plain `campaignMeta` this replaced)
  // requires real evidence: a saved version or a readable campaign.json.
  test("createBrief still refuses a reserved id behind only a bare directory (no campaign.json, no version)", async () => {
    const bareDir = join(dir, "templates");
    mkdirSync(bareDir, { recursive: true });
    writeFileSync(join(bareDir, "pools.json"), "{}");
    await expect(store.createBrief({ ...minimalBrief, id: "templates" })).rejects.toThrow(
      `"templates" is reserved; choose another campaign id.`,
    );
  });

  test.each(["cache", "jobs", "orgs", "packages"] as const)(
    "replaceBrief on a non-existent brief refuses reserved campaign id %s",
    async (id) => {
      await expect(store.replaceBrief({ ...minimalBrief, id })).rejects.toThrow(
        `"${id}" is reserved; choose another campaign id.`,
      );
    },
  );

  test("stored brief with reserved id lists, reads, rewrites and replaces", async () => {
    const cacheFile = join(dir, "cache.yaml");
    writeFileSync(cacheFile, dumpBrief({ ...minimalBrief, id: "cache" }), "utf8");

    const listed = await store.listBriefs();
    expect(listed.some((b) => b.brief.id === "cache")).toBe(true);

    const read = await store.readBrief("cache");
    expect(read.id).toBe("cache");

    const rewritten = await store.rewriteBrief({
      ...minimalBrief,
      id: "cache",
      campaignMessage: "Updated cache",
    });
    expect(rewritten.brief.campaignMessage).toBe("Updated cache");

    const replaced = await store.replaceBrief({
      ...minimalBrief,
      id: "cache",
      campaignMessage: "Replaced cache",
    });
    expect(replaced.brief.campaignMessage).toBe("Replaced cache");
  });

  describe("campaignId and resolveCampaign (PT-5a, D178, D179)", () => {
    test("StoredBrief carries campaignId equal to slug on fs backend (D179)", async () => {
      const created = await store.createBrief(minimalBrief);
      expect(created.campaignId).toBe("test-camp");

      const found = await store.findBriefById("test-camp");
      expect(found?.campaignId).toBe("test-camp");

      const listed = await store.listBriefs();
      expect(listed[0]?.campaignId).toBe("test-camp");

      const rewritten = await store.rewriteBrief({
        ...minimalBrief,
        campaignMessage: "Rewritten",
      });
      expect(rewritten.campaignId).toBe("test-camp");

      const replaced = await store.replaceBrief({
        ...minimalBrief,
        campaignMessage: "Replaced",
      });
      expect(replaced.campaignId).toBe("test-camp");
    });

    test("resolveCampaign answers { campaignId, slug } for existing campaign and undefined for missing", async () => {
      await store.createBrief(minimalBrief);

      const resolved = await store.resolveCampaign("test-camp");
      expect(resolved).toEqual({ campaignId: "test-camp", slug: "test-camp" });

      const missing = await store.resolveCampaign("non-existent");
      expect(missing).toBeUndefined();
    });
  });
});
