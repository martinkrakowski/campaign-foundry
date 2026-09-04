import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { FsBriefStore } from "../fs-brief-store.js";
import { hashBytes } from "../../brief-files.js";

const minimalBrief: CampaignBrief = {
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

  test("listBriefs rethrows when readdir fails with a non-ENOENT errno", async () => {
    chmodSync(dir, 0o000);
    try {
      await expect(store.listBriefs()).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test("listBriefs lists, sorts, and parses valid briefs while skipping invalid files", async () => {
    const yamlA = "id: camp-a\ntargetRegion: US\ntargetAudience: dev\ncampaignMessage: A\nproducts:\n  - id: p1\n";
    const yamlB = "id: camp-b\ntargetRegion: US\ntargetAudience: dev\ncampaignMessage: B\nproducts:\n  - id: p2\n";
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
    await expect(store.readBrief("/etc/hosts")).rejects.toThrow(/Path escapes the allowed directory/);
    await expect(store.readBrief("../../etc/passwd")).rejects.toThrow(/Path escapes the allowed directory/);
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
    await expect(
      store.rewriteBrief({ ...minimalBrief, id: "unparseable" }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rewriteBrief refuses symlinks", async () => {
    const outside = join(dir, "outside.yaml");
    writeFileSync(outside, "id: linked\n");
    const link = join(dir, "linked.yaml");
    symlinkSync(outside, link);

    await expect(
      store.rewriteBrief({ ...minimalBrief, id: "linked" }),
    ).rejects.toThrow(/Refusing to write through a symlink/);

    // Symlink on replaceBrief
    await expect(
      store.replaceBrief({ ...minimalBrief, id: "linked" }),
    ).rejects.toThrow(/Refusing to write through a symlink/);
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

    await expect(
      store.createBrief({ ...minimalBrief, id: "linked-create" }),
    ).rejects.toThrow(/Refusing to write through a symlink/);
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
