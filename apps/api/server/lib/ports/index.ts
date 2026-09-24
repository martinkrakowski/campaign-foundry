import { join } from "node:path";
import { scopeRoots, type StorageScope } from "../run-environment.js";
import { FsBriefStore } from "./fs-brief-store.js";
import { FsAssetStore } from "./fs-asset-store.js";
import { FsPoolStore } from "./fs-pool-store.js";
import { FsTemplateStore } from "./fs-template-store.js";
import { FsJobStore } from "./fs-job-store.js";
import { FsReportStore } from "./fs-report-store.js";
import { FsOutputStore } from "./fs-output-store.js";
import type { BriefStorePort } from "./brief-store.port.js";
import type { AssetStorePort } from "./asset-store.port.js";
import type { PoolStorePort } from "./pool-store.port.js";
import type { TemplateStorePort } from "./template-store.port.js";
import type { JobStorePort } from "./job-store.port.js";
import type { ReportStorePort } from "./report-store.port.js";
import type { OutputStorePort } from "./output-store.port.js";

export * from "./brief-store.port.js";
export * from "./asset-store.port.js";
export * from "./pool-store.port.js";
export * from "./template-store.port.js";
export * from "./job-store.port.js";
export * from "./report-store.port.js";
export * from "./output-store.port.js";
export * from "./fs-brief-store.js";
export * from "./fs-asset-store.js";
export * from "./fs-pool-store.js";
export * from "./fs-template-store.js";
export * from "./fs-job-store.js";
export * from "./fs-report-store.js";
export * from "./fs-output-store.js";

/**
 * The store registry (PT-0b2, D167 stamped). Every getter takes the scope a
 * request or run acts for (a tenant, or a run's captured environment) and builds
 * the store from that scope's storage roots (`scopeRoots`, the composition root),
 * never from the process environment. A store is cached per resolved root, so one tenant's requests
 * share its in-memory lock chains, and two tenants never share a store.
 *
 * `set*` installs a test double for every tenant; `reset*` drops the double
 * and the cache.
 */
class Registry<T> {
  private override: T | undefined;
  private readonly byRoot = new Map<string, T>();

  constructor(
    private readonly locate: (scope: StorageScope) => string,
    private readonly build: (root: string) => T,
  ) {}

  get(scope: StorageScope): T {
    if (this.override) return this.override;
    const root = this.locate(scope);
    let store = this.byRoot.get(root);
    if (!store) {
      store = this.build(root);
      this.byRoot.set(root, store);
    }
    return store;
  }

  set(store: T): void {
    this.override = store;
  }

  reset(): void {
    this.override = undefined;
    this.byRoot.clear();
  }
}

const briefs = new Registry<BriefStorePort>(
  (t) => join(scopeRoots(t).projectRoot, "briefs"),
  (dir) => new FsBriefStore(dir),
);
const assets = new Registry<AssetStorePort>(
  (t) => join(scopeRoots(t).projectRoot, "assets", "inputs"),
  (dir) => new FsAssetStore(dir),
);
const pools = new Registry<PoolStorePort>(
  (t) => join(scopeRoots(t).projectRoot, "briefs"),
  (dir) => new FsPoolStore(dir),
);
// The canonical templates are platform-owned and in memory (M3): one store for
// every tenant until org templates exist.
const templates = new Registry<TemplateStorePort>(
  () => "canonical",
  () => new FsTemplateStore(),
);
const jobs = new Registry<JobStorePort>(
  (t) => join(scopeRoots(t).outputRoot, "jobs"),
  (dir) => new FsJobStore(dir),
);
const reports = new Registry<ReportStorePort>(
  (t) => scopeRoots(t).outputRoot,
  (root) => new FsReportStore(root),
);
const outputs = new Registry<OutputStorePort>(
  (t) => scopeRoots(t).outputRoot,
  (root) => new FsOutputStore(root),
);

export const getBriefStore = (scope: StorageScope): BriefStorePort => briefs.get(scope);
export const setBriefStore = (store: BriefStorePort): void => briefs.set(store);
export const resetBriefStore = (): void => briefs.reset();

export const getAssetStore = (scope: StorageScope): AssetStorePort => assets.get(scope);
export const setAssetStore = (store: AssetStorePort): void => assets.set(store);
export const resetAssetStore = (): void => assets.reset();

export const getPoolStore = (scope: StorageScope): PoolStorePort => pools.get(scope);
export const setPoolStore = (store: PoolStorePort): void => pools.set(store);
export const resetPoolStore = (): void => pools.reset();

export const getTemplateStore = (scope: StorageScope): TemplateStorePort => templates.get(scope);
export const setTemplateStore = (store: TemplateStorePort): void => templates.set(store);
export const resetTemplateStore = (): void => templates.reset();

export const getJobStore = (scope: StorageScope): JobStorePort => jobs.get(scope);
export const setJobStore = (store: JobStorePort): void => jobs.set(store);
export const resetJobStore = (): void => jobs.reset();

export const getJobRegistry = getJobStore;
export const setJobRegistry = setJobStore;
export const resetJobRegistry = resetJobStore;

export const getReportStore = (scope: StorageScope): ReportStorePort => reports.get(scope);
export const setReportStore = (store: ReportStorePort): void => reports.set(store);
export const resetReportStore = (): void => reports.reset();

export const getOutputStore = (scope: StorageScope): OutputStorePort => outputs.get(scope);
export const setOutputStore = (store: OutputStorePort): void => outputs.set(store);
export const resetOutputStore = (): void => outputs.reset();
