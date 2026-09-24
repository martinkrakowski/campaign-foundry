import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBriefStore,
  getJobStore,
  getReportStore,
  resetBriefStore,
  resetJobStore,
  resetReportStore,
  setReportStore,
  type ReportStorePort,
} from "../index.js";
import { LOCAL_TENANT, type TenantContext } from "../../tenant.js";
import { runEnvironment } from "../../run-environment.js";

const acme: TenantContext = { ...LOCAL_TENANT, orgId: "acme", userId: "u1" };

/**
 * PT-0b2 (D167): every store is built from the tenant it is asked for, cached
 * per root. One tenant\'s requests share a store (and its lock chains); two
 * tenants never do.
 */
describe("the store registry is per tenant", () => {
  let dir: string;
  const origOut = process.env.OUTPUT_DIR;
  const origRoot = process.env.PROJECT_ROOT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-registry-"));
    process.env.OUTPUT_DIR = join(dir, "output");
    process.env.PROJECT_ROOT = dir;
    resetBriefStore();
    resetJobStore();
    resetReportStore();
  });
  afterEach(() => {
    resetBriefStore();
    resetJobStore();
    resetReportStore();
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    rmSync(dir, { recursive: true, force: true });
  });

  test("the same tenant gets the same store, so its lock chains are shared", () => {
    expect(getBriefStore(LOCAL_TENANT)).toBe(getBriefStore(LOCAL_TENANT));
    expect(getJobStore(acme)).toBe(getJobStore(acme));
  });

  test("two tenants get different stores, and one org's report is invisible to another", async () => {
    expect(getReportStore(acme)).not.toBe(getReportStore(LOCAL_TENANT));
    await getReportStore(acme).writeReport("camp", '{"assets":[]}');
    await expect(getReportStore(acme).readReport("camp")).resolves.toEqual({ assets: [] });
    await expect(getReportStore(LOCAL_TENANT).readReport("camp")).resolves.toBeUndefined();
  });

  test("a test double set for the registry answers for every tenant until reset", () => {
    const fake = {} as ReportStorePort;
    setReportStore(fake);
    expect(getReportStore(LOCAL_TENANT)).toBe(fake);
    expect(getReportStore(acme)).toBe(fake);
    resetReportStore();
    expect(getReportStore(LOCAL_TENANT)).not.toBe(fake);
  });

  test("a run's captured environment keeps its roots after OUTPUT_DIR moves (review on #575)", async () => {
    const env = runEnvironment(LOCAL_TENANT); // captured at enqueue
    const before = process.env.OUTPUT_DIR!;
    process.env.OUTPUT_DIR = join(dir, "moved");
    try {
      await getReportStore(env).writeReport("camp", '{"assets":[]}');
      // The run's report is where the run was admitted, not where the process moved to.
      expect(getReportStore(env)).not.toBe(getReportStore(LOCAL_TENANT));
      await expect(getReportStore(LOCAL_TENANT).readReport("camp")).resolves.toBeUndefined();
      process.env.OUTPUT_DIR = before;
      await expect(getReportStore(LOCAL_TENANT).readReport("camp")).resolves.toEqual({
        assets: [],
      });
    } finally {
      process.env.OUTPUT_DIR = before;
    }
  });
});
