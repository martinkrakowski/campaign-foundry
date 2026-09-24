import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { FsBriefStore } from "../fs-brief-store.js";
import { hashBytes } from "../../brief-files.js";

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
    const outside = join(dir, "..", `${dir.split("/").pop()}-outside.yaml`);
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
});
