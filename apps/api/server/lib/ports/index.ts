import { join } from "node:path";
import { storageRoots } from "../run-environment.js";
import type { TenantContext } from "../tenant.js";
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
 * The store registry (PT-0b2, D167 stamped). Every getter takes the tenant a
 * request or run acts for, and builds the store from that tenant's storage
 * roots (`storageRoots`, the composition root), never from the process
 * environment. A store is cached per resolved root, so one tenant's requests
 * share its in-memory lock chains, and two tenants never share a store.
 *
 * `set*` installs a test double for every tenant; `reset*` drops the double
 * and the cache.
 */
class Registry<T> {
  private override: T | undefined;
  private readonly byRoot = new Map<string, T>();

  constructor(
    private readonly locate: (tenant: TenantContext) => string,
    private readonly build: (root: string) => T,
  ) {}

  get(tenant: TenantContext): T {
    if (this.override) return this.override;
    const root = this.locate(tenant);
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
  (t) => join(storageRoots(t).projectRoot, "briefs"),
  (dir) => new FsBriefStore(dir),
);
const assets = new Registry<AssetStorePort>(
  (t) => join(storageRoots(t).projectRoot, "assets", "inputs"),
  (dir) => new FsAssetStore(dir),
);
const pools = new Registry<PoolStorePort>(
  (t) => join(storageRoots(t).projectRoot, "briefs"),
  (dir) => new FsPoolStore(dir),
);
// The canonical templates are platform-owned and in memory (M3): one store for
// every tenant until org templates exist.
const templates = new Registry<TemplateStorePort>(
  () => "canonical",
  () => new FsTemplateStore(),
);
const jobs = new Registry<JobStorePort>(
  (t) => join(storageRoots(t).outputRoot, "jobs"),
  (dir) => new FsJobStore(dir),
);
const reports = new Registry<ReportStorePort>(
  (t) => storageRoots(t).outputRoot,
  (root) => new FsReportStore(root),
);
const outputs = new Registry<OutputStorePort>(
  (t) => storageRoots(t).outputRoot,
  (root) => new FsOutputStore(root),
);

export const getBriefStore = (tenant: TenantContext): BriefStorePort => briefs.get(tenant);
export const setBriefStore = (store: BriefStorePort): void => briefs.set(store);
export const resetBriefStore = (): void => briefs.reset();

export const getAssetStore = (tenant: TenantContext): AssetStorePort => assets.get(tenant);
export const setAssetStore = (store: AssetStorePort): void => assets.set(store);
export const resetAssetStore = (): void => assets.reset();

export const getPoolStore = (tenant: TenantContext): PoolStorePort => pools.get(tenant);
export const setPoolStore = (store: PoolStorePort): void => pools.set(store);
export const resetPoolStore = (): void => pools.reset();

export const getTemplateStore = (tenant: TenantContext): TemplateStorePort => templates.get(tenant);
export const setTemplateStore = (store: TemplateStorePort): void => templates.set(store);
export const resetTemplateStore = (): void => templates.reset();

export const getJobStore = (tenant: TenantContext): JobStorePort => jobs.get(tenant);
export const setJobStore = (store: JobStorePort): void => jobs.set(store);
export const resetJobStore = (): void => jobs.reset();

export const getJobRegistry = getJobStore;
export const setJobRegistry = setJobStore;
export const resetJobRegistry = resetJobStore;

export const getReportStore = (tenant: TenantContext): ReportStorePort => reports.get(tenant);
export const setReportStore = (store: ReportStorePort): void => reports.set(store);
export const resetReportStore = (): void => reports.reset();

export const getOutputStore = (tenant: TenantContext): OutputStorePort => outputs.get(tenant);
export const setOutputStore = (store: OutputStorePort): void => outputs.set(store);
export const resetOutputStore = (): void => outputs.reset();
