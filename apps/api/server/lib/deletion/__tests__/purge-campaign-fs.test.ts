import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  renameSync,
  readlinkSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { serializeBrief } from "../../brief-files.js";
import {
  ACME_TENANT,
  LOCAL_TENANT,
  assertNoLeakedTenantDirs,
  setupFsHarness,
  type FsHarness,
} from "../../../routes/__tests__/tenant-harness.js";
import {
  getAssetStore,
  getBriefStore,
  getDecisionStore,
  getDraftStore,
  getJobStore,
  getLastOpenedStore,
  getPoolStore,
  getReportStore,
} from "../../ports/index.js";
import {
  plantCampaign,
  pointedAt,
  pathsNaming,
  sampleBrief,
  skipPermissionTests,
  snapshotTree,
} from "./fs-delete-fixtures.js";
import { deleteCampaignOnFileStore, UnsafeCampaignPathError } from "../purge-campaign-fs.js";

/**
 * Hoisted spy for `node:fs/promises`'s `rm`: passes through by default, and
 * throws `EACCES` once for the FIRST call whose path is the campaign's output
 * tree (`<output>/sale`), so a removal can fail after the earlier data targets
 * have been removed — without chmod, so it runs as non-root and on CI.
 */
const rmSpy = vi.hoisted(() => {
  const real = {
    value: null as unknown as (
      path: string,
      options?: { recursive?: boolean; force?: boolean },
    ) => Promise<void>,
  };
  let shouldFail = false;
  const spy = (path: string, options?: { recursive?: boolean; force?: boolean }) => {
    if (shouldFail && path.endsWith("/output/sale")) {
      shouldFail = false;
      const err: NodeJS.ErrnoException = new Error("EACCES");
      err.code = "EACCES";
      throw err;
    }
    return real.value(path, options);
  };
  return {
    spy,
    setReal: (rm: typeof spy) => {
      real.value = rm;
    },
    fire: () => {
      shouldFail = true;
    },
    reset: () => {
      shouldFail = false;
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  rmSpy.setReal(actual.rm);
  return { ...actual, rm: rmSpy.spy };
});

const lastOpenedDir = (harness: FsHarness) => join(harness.projectRoot, "state", "last-opened");

const hasJobNamed = async (slug: string): Promise<boolean> =>
  (await getJobStore(LOCAL_TENANT).listJobs()).some((j) => j.campaignId === slug);

function filterSnapshot(map: Map<string, string>, ...needles: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of map) {
    if (needles.some((n) => k.includes(n))) out.set(k, v);
  }
  return out;
}

function moveTo(harness: FsHarness, realRel: string, targetRel: string): string {
  const real = join(harness.tmpDir, realRel);
  const target = join(harness.tmpDir, targetRel);
  renameSync(real, target);
  symlinkSync(target, real);
  return target;
}

function expectExists(path: string): void {
  expect(existsSync(path)).toBe(true);
}

describe("purge-campaign-fs", () => {
  afterAll(() => assertNoLeakedTenantDirs());

  test("deleteCampaignOnFileStore removes every location of one campaign and leaves its neighbour untouched", async () => {
    const harness = setupFsHarness();
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale-2", "u-sale2");
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "unrelated", "u-unrelated");

      const before = snapshotTree(harness.tmpDir);
      expect(pathsNaming(harness.tmpDir, "sale")).toEqual(
        expect.arrayContaining([
          "project/briefs/sale.yaml",
          "project/briefs/sale/campaign.json",
          "project/briefs/sale/pools.json",
          "project/briefs/sale/drafts/u-sale.json",
          "project/assets/inputs/sale/logo.png",
          "output/sale/alpha/1x1/default.png",
          "output/packages/sale/p1/x.zip",
          "output/reports/sale.json",
          "output/decisions/sale.json",
        ]),
      );
      expect(await hasJobNamed("sale")).toBe(true);
      expect(await hasJobNamed("sale-2")).toBe(true);
      expect(await hasJobNamed("unrelated")).toBe(true);
      expect(pointedAt(lastOpenedDir(harness), "sale")).toEqual(["u-sale.json"]);

      const sale2AndUnrelated = filterSnapshot(before, "sale-2", "unrelated");

      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "deleted",
      });

      expect(pathsNaming(harness.tmpDir, "sale")).toEqual([]);
      expect(await hasJobNamed("sale")).toBe(false);
      expect(await hasJobNamed("sale-2")).toBe(true);
      expect(await hasJobNamed("unrelated")).toBe(true);
      expect(pointedAt(lastOpenedDir(harness), "sale")).toEqual([]);

      const after = snapshotTree(harness.tmpDir);
      expect(filterSnapshot(after, "sale-2", "unrelated")).toEqual(sale2AndUnrelated);
      expect(await getBriefStore(LOCAL_TENANT).campaignMeta("sale")).toBeUndefined();
      expect(await getBriefStore(LOCAL_TENANT).campaignMeta("sale-2")).toBeDefined();
      const listed = await getBriefStore(LOCAL_TENANT).listBriefs();
      expect(listed.map((b) => b.campaignId).sort()).toEqual(["sale-2", "unrelated"]);
    } finally {
      harness.cleanup();
    }
  });

  test("deleteCampaignOnFileStore removes a campaign that has no saved version", async () => {
    const harness = setupFsHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createCampaign("sale", {
        name: "sale",
        type: "social-post",
      });
      await getAssetStore(LOCAL_TENANT).writeAsset("sale", "logo.png", Buffer.from("x"));
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "deleted",
      });
      expect(pathsNaming(harness.tmpDir, "sale")).toEqual([]);
      expect(await getBriefStore(LOCAL_TENANT).campaignMeta("sale")).toBeUndefined();
    } finally {
      harness.cleanup();
    }
  });

  test("deleteCampaignOnFileStore refuses with the running jobId and removes nothing", async () => {
    const harness = setupFsHarness();
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");

      const running = await getJobStore(LOCAL_TENANT).acquireJob("sale");
      expect(running.acquired).toBe(true);
      const runningJobId = running.acquired ? running.jobId : "";
      const before = snapshotTree(harness.tmpDir);
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "active-job",
        jobId: runningJobId,
      });
      expect(snapshotTree(harness.tmpDir)).toEqual(before);

      await getJobStore(LOCAL_TENANT).failJob(runningJobId, "x");
      const queued = await getJobStore(LOCAL_TENANT).enqueueJob("sale");
      expect(queued.acquired).toBe(true);
      const queuedJobId = queued.acquired ? queued.jobId : "";
      const afterQueued = snapshotTree(harness.tmpDir);
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "active-job",
        jobId: queuedJobId,
      });
      expect(snapshotTree(harness.tmpDir)).toEqual(afterQueued);

      await getJobStore(LOCAL_TENANT).startQueuedJob(queuedJobId);
      await getJobStore(LOCAL_TENANT).completeJob(queuedJobId, {
        halted: false,
        assets: [],
        log: null,
      });
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "deleted",
      });
      expect(pathsNaming(harness.tmpDir, "sale")).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  test("deleteCampaignOnFileStore answers active-job when an enqueue reaches the job lock first", async () => {
    const harness = setupFsHarness();
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      const before = snapshotTree(harness.tmpDir);

      const [a, b] = await Promise.all([
        deleteCampaignOnFileStore(LOCAL_TENANT, "sale"),
        getJobStore(LOCAL_TENANT).enqueueJob("sale"),
      ]);
      expect(b.acquired).toBe(true);
      const bJobId = b.acquired ? b.jobId : "";
      expect(a).toEqual({ outcome: "active-job", jobId: bJobId });

      const after = snapshotTree(harness.tmpDir);
      for (const [k, v] of before) expect(after.get(k)).toBe(v);
      const extra = [...after.entries()].filter(([k]) => !before.has(k));
      expect(extra.every(([k]) => k.startsWith("output/jobs/"))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  test("deleteCampaignOnFileStore answers not-found for an absent campaign and for a second delete", async () => {
    const harness = setupFsHarness();
    try {
      const before = snapshotTree(harness.tmpDir);
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "absent")).toEqual({
        outcome: "not-found",
      });
      expect(snapshotTree(harness.tmpDir)).toEqual(before);

      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "deleted",
      });
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "not-found",
      });
    } finally {
      harness.cleanup();
    }
  });

  test("deleteCampaignOnFileStore answers not-found for the second of two concurrent deletes", async () => {
    const harness = setupFsHarness();
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      const [a, b] = await Promise.all([
        deleteCampaignOnFileStore(LOCAL_TENANT, "sale"),
        deleteCampaignOnFileStore(LOCAL_TENANT, "sale"),
      ]);
      const outcomes = [a, b] as const;
      expect(outcomes).toContainEqual({ outcome: "deleted" });
      expect(outcomes).toContainEqual({ outcome: "not-found" });
    } finally {
      harness.cleanup();
    }
  });

  test("deleteCampaignOnFileStore rejects an unsafe slug before touching anything", async () => {
    const harness = setupFsHarness();
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      const before = snapshotTree(harness.tmpDir);
      for (const slug of ["../escape", "Sale", "a/b"]) {
        await expect(deleteCampaignOnFileStore(LOCAL_TENANT, slug)).rejects.toThrow(
          /not a safe id/,
        );
      }
      expect(snapshotTree(harness.tmpDir)).toEqual(before);
    } finally {
      harness.cleanup();
    }
  });

  const jobFileFor = async (harness: FsHarness, slug: string): Promise<string | undefined> => {
    const listed = await getJobStore(LOCAL_TENANT).listJobs();
    const found = listed.find((j) => j.campaignId === slug);
    return found ? join(harness.outputRoot, "jobs", `${found.id}.json`) : undefined;
  };

  test("deleteCampaignOnFileStore completes a delete that stopped after the data and before the markers", async () => {
    const harness = setupFsHarness();
    try {
      // State A: data gone, markers (brief file + directory) still present.
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      rmSync(join(harness.projectRoot, "assets", "inputs", "sale"), {
        recursive: true,
        force: true,
      });
      rmSync(join(harness.outputRoot, "sale"), { recursive: true, force: true });
      rmSync(join(harness.outputRoot, "decisions", "sale.json"));
      const jobA = await jobFileFor(harness, "sale");
      if (jobA) rmSync(jobA, { force: true });
      expect(await getBriefStore(LOCAL_TENANT).campaignMeta("sale")).toBeDefined();
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "deleted",
      });
      expect(pathsNaming(harness.tmpDir, "sale")).toEqual([]);

      // State B: brief file removed by hand, directory marker still present.
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      rmSync(join(harness.projectRoot, "assets", "inputs", "sale"), {
        recursive: true,
        force: true,
      });
      rmSync(join(harness.outputRoot, "sale"), { recursive: true, force: true });
      rmSync(join(harness.outputRoot, "decisions", "sale.json"));
      rmSync(join(harness.outputRoot, "reports", "sale.json"));
      rmSync(join(harness.outputRoot, "packages", "sale"), { recursive: true, force: true });
      const jobB = await jobFileFor(harness, "sale");
      if (jobB) rmSync(jobB, { force: true });
      rmSync(join(harness.projectRoot, "briefs", "sale.yaml"));
      expect(await getBriefStore(LOCAL_TENANT).campaignMeta("sale")).toBeDefined();
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "deleted",
      });
      expect(pathsNaming(harness.tmpDir, "sale")).toEqual([]);
      expect(existsSync(join(harness.projectRoot, "briefs", "sale"))).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  test.skipIf(skipPermissionTests)(
    "deleteCampaignOnFileStore leaves the markers in place when a removal fails and a retry completes",
    async () => {
      const harness = setupFsHarness();
      const locked = join(harness.outputRoot, "sale", "alpha");
      try {
        await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
        chmodSync(locked, 0o500);
        let chmodErr: unknown;
        try {
          await deleteCampaignOnFileStore(LOCAL_TENANT, "sale");
        } catch (e) {
          chmodErr = e;
        }
        expect(chmodErr).toBeInstanceOf(Error);
        expect((chmodErr as { code?: string }).code).toMatch(/^(EACCES|EPERM)$/);
        expect(existsSync(join(harness.projectRoot, "briefs", "sale.yaml"))).toBe(true);
        expect(existsSync(join(harness.projectRoot, "briefs", "sale", "campaign.json"))).toBe(true);
        expect(await getBriefStore(LOCAL_TENANT).campaignMeta("sale")).toBeDefined();
        expect(existsSync(join(harness.projectRoot, "assets", "inputs", "sale"))).toBe(false);
        expect(existsSync(join(harness.outputRoot, "decisions", "sale.json"))).toBe(false);
        chmodSync(locked, 0o700);
        expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
          outcome: "deleted",
        });
        expect(pathsNaming(harness.tmpDir, "sale")).toEqual([]);
      } finally {
        try {
          chmodSync(locked, 0o700);
        } catch {
          /* already restored */
        }
        harness.cleanup();
      }
    },
  );

  test("deleteCampaignOnFileStore leaves the campaign resolvable when a removal fails before the markers", async () => {
    const harness = setupFsHarness();
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");

      let firstErr: unknown;
      rmSpy.fire();
      try {
        await deleteCampaignOnFileStore(LOCAL_TENANT, "sale");
      } catch (e) {
        firstErr = e;
      }
      expect(firstErr).toBeInstanceOf(Error);
      expect((firstErr as { code?: string }).code).toBe("EACCES");
      // Markers intact: the campaign is still resolvable.
      expect(existsSync(join(harness.projectRoot, "briefs", "sale.yaml"))).toBe(true);
      expect(existsSync(join(harness.projectRoot, "briefs", "sale", "campaign.json"))).toBe(true);
      expect(await getBriefStore(LOCAL_TENANT).campaignMeta("sale")).toBeDefined();
      // Data targets ordered BEFORE the output tree are already gone.
      expect(existsSync(join(harness.outputRoot, "decisions", "sale.json"))).toBe(false);
      expect(existsSync(join(harness.outputRoot, "reports", "sale.json"))).toBe(false);
      expect(existsSync(join(harness.outputRoot, "packages", "sale"))).toBe(false);
      expect(existsSync(join(harness.projectRoot, "assets", "inputs", "sale"))).toBe(false);
      // The output tree that failed to remove is still there.
      expect(existsSync(join(harness.outputRoot, "sale"))).toBe(true);

      // A second call (rm now passes through) completes the delete.
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "deleted",
      });
      expect(pathsNaming(harness.tmpDir, "sale")).toEqual([]);
    } finally {
      rmSpy.reset();
      harness.cleanup();
    }
  });

  test("deleteCampaignOnFileStore refuses a symlinked non-local org root and removes nothing", async () => {
    const harness = setupFsHarness();
    try {
      await plantCampaign(ACME_TENANT, harness.acmeRoots, "sale", "u-acme");
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-local");
      // Replace the OUTPUT-side org root with a link back to the output root: an
      // unguarded delete of acme would follow it and erase the local sale's tree.
      const acmeOut = join(harness.outputRoot, "orgs", "acme");
      rmSync(acmeOut, { recursive: true, force: true });
      symlinkSync(harness.outputRoot, acmeOut);

      const before = snapshotTree(harness.tmpDir);
      await expect(deleteCampaignOnFileStore(ACME_TENANT, "sale")).rejects.toBeInstanceOf(
        UnsafeCampaignPathError,
      );
      expect(snapshotTree(harness.tmpDir)).toEqual(before);
      // The local sale is untouched even though the acme tree redirects to it.
      expect(await getBriefStore(LOCAL_TENANT).campaignMeta("sale")).toBeDefined();
      expect(existsSync(join(harness.outputRoot, "decisions", "sale.json"))).toBe(true);
      expect(existsSync(join(harness.outputRoot, "sale"))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  test.each([
    "project/briefs/sale",
    "project/assets/inputs/sale",
    "output/sale",
    "output/packages (the directory)",
    "output/reports (the directory)",
    "output/jobs (the directory)",
    "project/state/last-opened (the directory)",
    "briefs (the whole directory)",
    "project/briefs/sale -> project/briefs/sale-2 (neighbour)",
  ])("deleteCampaignOnFileStore refuses a symlink at %s and removes nothing", async (label) => {
    const harness = setupFsHarness();
    const outside = join(harness.tmpDir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "keep");
    writeFileSync(join(outside, "sale.json"), JSON.stringify({ campaignId: "sale" }));
    let outsideBriefs: string | undefined;
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale-2", "u-sale2");

      switch (label) {
        case "project/briefs/sale":
          moveTo(harness, "project/briefs/sale", "outside/sale");
          break;
        case "project/assets/inputs/sale":
          moveTo(harness, "project/assets/inputs/sale", "outside/sale-inputs");
          break;
        case "output/sale":
          moveTo(harness, "output/sale", "outside/sale-output");
          break;
        case "output/packages (the directory)":
          moveTo(harness, "output/packages", "outside/packages");
          break;
        case "output/reports (the directory)":
          moveTo(harness, "output/reports", "outside/reports");
          break;
        case "output/jobs (the directory)":
          moveTo(harness, "output/jobs", "outside/jobs");
          break;
        case "project/state/last-opened (the directory)":
          moveTo(harness, "project/state/last-opened", "outside/last-opened");
          break;
        case "briefs (the whole directory)":
          outsideBriefs = join(harness.tmpDir, "outside-briefs");
          renameSync(join(harness.projectRoot, "briefs"), outsideBriefs);
          symlinkSync(outsideBriefs, join(harness.projectRoot, "briefs"));
          break;
        case "project/briefs/sale -> project/briefs/sale-2 (neighbour)":
          renameSync(join(harness.projectRoot, "briefs", "sale"), join(outside, "sale"));
          symlinkSync(
            join(harness.projectRoot, "briefs", "sale-2"),
            join(harness.projectRoot, "briefs", "sale"),
          );
          break;
        default:
          throw new Error(`unknown case ${label}`);
      }

      const before = snapshotTree(harness.tmpDir);
      const outsideBriefsBefore = outsideBriefs ? snapshotTree(outsideBriefs) : undefined;

      await expect(deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).rejects.toBeInstanceOf(
        UnsafeCampaignPathError,
      );

      expect(snapshotTree(harness.tmpDir)).toEqual(before);
      if (outsideBriefs) expect(snapshotTree(outsideBriefs)).toEqual(outsideBriefsBefore);
      expectExists(join(outside, "keep.txt"));
      expectExists(join(outside, "sale.json"));
    } finally {
      harness.cleanup();
    }
  });

  test("deleteCampaignOnFileStore frees a symlink inside a tree without following it", async () => {
    const harness = setupFsHarness();
    const outside = join(harness.tmpDir, "outside");
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "keep.txt"), "keep");
      symlinkSync(outside, join(harness.projectRoot, "assets", "inputs", "sale", "link"));

      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "deleted",
      });
      expect(existsSync(join(harness.projectRoot, "assets", "inputs", "sale"))).toBe(false);
      expectExists(join(outside, "keep.txt"));
    } finally {
      harness.cleanup();
    }
  });

  test("deleteCampaignOnFileStore never removes a shared output area named like the slug", async () => {
    const harness = setupFsHarness();
    try {
      // (a) "reports" is a shared output name: output/reports/<slug>/ survives but
      // the report file output/reports/reports.json does not.
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "reports", "u-reports");
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "other", "u-other");
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "reports")).toEqual({
        outcome: "deleted",
      });
      expect(existsSync(join(harness.outputRoot, "reports"))).toBe(true);
      expect(readFileSync(join(harness.outputRoot, "reports", "other.json"), "utf8")).toBe("{}");
      expect(existsSync(join(harness.outputRoot, "reports", "reports.json"))).toBe(false);
      expect(existsSync(join(harness.projectRoot, "briefs", "reports"))).toBe(false);
      expect(existsSync(join(harness.projectRoot, "briefs", "reports.yaml"))).toBe(false);

      // (b) "cache" is reserved: the meta is hand-written so createCampaign is never
      // called (it would refuse the reserved id); output/cache survives byte-for-byte.
      mkdirSync(join(harness.projectRoot, "briefs", "cache"), { recursive: true });
      writeFileSync(
        join(harness.projectRoot, "briefs", "cache", "campaign.json"),
        JSON.stringify({ name: "x", type: "social-post" }),
        { flag: "wx" },
      );
      mkdirSync(join(harness.outputRoot, "cache"), { recursive: true });
      writeFileSync(join(harness.outputRoot, "cache", "keep.png"), "png");
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "cache")).toEqual({
        outcome: "deleted",
      });
      expect(readFileSync(join(harness.outputRoot, "cache", "keep.png"), "utf8")).toBe("png");
      expect(existsSync(join(harness.projectRoot, "briefs", "cache"))).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  test("deleteCampaignOnFileStore reads a pointer by exact content and skips what it cannot read", async () => {
    const harness = setupFsHarness();
    const outside = join(harness.tmpDir, "outside");
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale-2", "u-sale2");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "pointer.json"), JSON.stringify({ campaignId: "sale" }));
      const dir = lastOpenedDir(harness);
      writeFileSync(join(dir, "bad.json"), "{");
      writeFileSync(join(dir, "null.json"), "null");
      writeFileSync(join(dir, "notes.txt"), "hi");
      mkdirSync(join(dir, "dir.json"));
      symlinkSync(join(outside, "pointer.json"), join(dir, "link.json"));

      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "deleted",
      });
      expect(pointedAt(dir, "sale")).toEqual([]);
      expect(pointedAt(dir, "sale-2")).toEqual(["u-sale2.json"]);
      expectExists(join(dir, "bad.json"));
      expectExists(join(dir, "null.json"));
      expectExists(join(dir, "notes.txt"));
      expectExists(join(dir, "dir.json"));
      expectExists(join(dir, "u-sale2.json"));
      expect(readlinkSync(join(dir, "link.json"))).toBeDefined();
      expectExists(join(outside, "pointer.json"));
    } finally {
      harness.cleanup();
    }
  });

  test("deleteCampaignOnFileStore keeps a canonical-named brief that declares another campaign", async () => {
    // (a) sale.yaml is a valid brief declaring `other`: only the `sale` directory
    // (what campaignMeta resolves by) is removed; sale.yaml is byte-identical.
    const harness = setupFsHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createCampaign("sale", {
        name: "sale",
        type: "social-post",
      });
      writeFileSync(
        join(harness.projectRoot, "briefs", "sale.yaml"),
        serializeBrief(join(harness.projectRoot, "briefs", "sale.yaml"), sampleBrief("other")),
      );
      const beforeYaml = readFileSync(join(harness.projectRoot, "briefs", "sale.yaml"), "utf8");
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "deleted",
      });
      expect(readFileSync(join(harness.projectRoot, "briefs", "sale.yaml"), "utf8")).toBe(
        beforeYaml,
      );
      expect(existsSync(join(harness.projectRoot, "briefs", "sale"))).toBe(false);
    } finally {
      harness.cleanup();
    }

    // (b) sale.json is the canonical name but holds unparseable bytes: it is released
    // along with the directory, so the slug is freed.
    const harness2 = setupFsHarness();
    try {
      await getBriefStore(LOCAL_TENANT).createCampaign("sale", {
        name: "sale",
        type: "social-post",
      });
      writeFileSync(join(harness2.projectRoot, "briefs", "sale.json"), "{");
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "deleted",
      });
      expect(existsSync(join(harness2.projectRoot, "briefs", "sale.json"))).toBe(false);
      expect(existsSync(join(harness2.projectRoot, "briefs", "sale"))).toBe(false);
    } finally {
      harness2.cleanup();
    }
  });

  test.each(["output/reports", "project/state/last-opened"] as const)(
    "deleteCampaignOnFileStore fails closed when %s is a regular file and removes nothing",
    async (label) => {
      const harness = setupFsHarness();
      try {
        await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
        const rel =
          label === "output/reports"
            ? join(harness.outputRoot, "reports")
            : join(harness.projectRoot, "state", "last-opened");
        rmSync(rel, { recursive: true, force: true });
        writeFileSync(rel, "x");
        const before = snapshotTree(harness.tmpDir);

        let err: unknown;
        try {
          await deleteCampaignOnFileStore(LOCAL_TENANT, "sale");
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(UnsafeCampaignPathError);
        expect((err as { code?: string }).code).toBe("ENOTDIR");
        expect(snapshotTree(harness.tmpDir)).toEqual(before);
      } finally {
        harness.cleanup();
      }
    },
  );

  test("deleteCampaignOnFileStore confines a non-local org to its own tree", async () => {
    const harness = setupFsHarness();
    try {
      await plantCampaign(ACME_TENANT, harness.acmeRoots, "sale", "u-acme");
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-local");
      const before = snapshotTree(harness.tmpDir);

      expect(await deleteCampaignOnFileStore(ACME_TENANT, "sale")).toEqual({
        outcome: "deleted",
      });
      const after = snapshotTree(harness.tmpDir);
      for (const [k, v] of before) {
        if (!k.includes("orgs/acme")) expect(after.get(k)).toBe(v);
      }
      expect(pathsNaming(harness.acmeRoots.projectRoot, "sale")).toEqual([]);
      expect(pathsNaming(harness.acmeRoots.outputRoot, "sale")).toEqual([]);
      expect(await getBriefStore(LOCAL_TENANT).campaignMeta("sale")).toBeDefined();
    } finally {
      harness.cleanup();
    }
  });

  test("deleteCampaignOnFileStore agrees with the stores on every path it removes", async () => {
    const harness = setupFsHarness();
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      expect(await deleteCampaignOnFileStore(LOCAL_TENANT, "sale")).toEqual({
        outcome: "deleted",
      });
      expect(await getReportStore(LOCAL_TENANT).readReport("sale")).toBeUndefined();
      expect((await getDecisionStore(LOCAL_TENANT).readDecisions("sale")).revision).toBeNull();
      expect(await getAssetStore(LOCAL_TENANT).listAssets("sale")).toEqual([]);
      expect(
        (await getJobStore(LOCAL_TENANT).listJobs()).some((j) => j.campaignId === "sale"),
      ).toBe(false);
      expect(await getLastOpenedStore(LOCAL_TENANT).read("u-sale")).toBeUndefined();
      expect(await getDraftStore(LOCAL_TENANT).readDraft("sale", "u-sale")).toBeUndefined();
      expect(await getPoolStore(LOCAL_TENANT).readPool("sale")).toBeUndefined();
    } finally {
      harness.cleanup();
    }
  });
});
