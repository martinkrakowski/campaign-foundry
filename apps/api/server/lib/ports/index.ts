import { join } from "node:path";
import { storeBackend } from "../config.js";
import { database } from "../db/database.js";
import { scopeRoots, scopeTenant, type StorageScope } from "../run-environment.js";
import { FsBriefStore } from "./fs-brief-store.js";
import { PgBriefStore } from "./pg-brief-store.js";
import { FsAssetStore } from "./fs-asset-store.js";
import { FsPoolStore } from "./fs-pool-store.js";
import { PgPoolStore } from "./pg-pool-store.js";
import { FsTemplateStore } from "./fs-template-store.js";
import { FsJobStore } from "./fs-job-store.js";
import { PgJobStore } from "./pg-job-store.js";
import { FsReportStore } from "./fs-report-store.js";
import { PgReportStore } from "./pg-report-store.js";
import { FsOutputStore } from "./fs-output-store.js";
import { FsDecisionStore } from "./fs-decision-store.js";
import { PgDecisionStore } from "./pg-decision-store.js";
import { FsUsageStore } from "./fs-usage-store.js";
import { PgUsageStore } from "./pg-usage-store.js";
import type { BriefStorePort } from "./brief-store.port.js";
import type { AssetStorePort } from "./asset-store.port.js";
import type { PoolStorePort } from "./pool-store.port.js";
import type { TemplateStorePort } from "./template-store.port.js";
import type { JobStorePort } from "./job-store.port.js";
import type { ReportStorePort } from "./report-store.port.js";
import type { OutputStorePort } from "./output-store.port.js";
import type { DecisionStorePort } from "./decision-store.port.js";
import type { UsageStorePort } from "./usage-store.port.js";

export * from "./brief-store.port.js";
export * from "./asset-store.port.js";
export * from "./pool-store.port.js";
export * from "./template-store.port.js";
export * from "./job-store.port.js";
export * from "./report-store.port.js";
export * from "./output-store.port.js";
export * from "./decision-store.port.js";
export * from "./usage-store.port.js";
export * from "./run-delivery.port.js";
export * from "./fs-brief-store.js";
export * from "./pg-brief-store.js";
export * from "./fs-asset-store.js";
export * from "./fs-pool-store.js";
export * from "./pg-pool-store.js";
export * from "./fs-template-store.js";
export * from "./fs-job-store.js";
export * from "./pg-job-store.js";
export * from "./fs-report-store.js";
export * from "./pg-report-store.js";
export * from "./fs-output-store.js";
export * from "./fs-decision-store.js";
export * from "./pg-decision-store.js";
export * from "./fs-usage-store.js";
export * from "./pg-usage-store.js";
// `in-process-run-delivery.js` is deliberately NOT re-exported here — it, and
// the run-delivery registry that wires it up, live in
// `run-delivery-registry.ts` instead (see that file's docstring for why:
// folding it into this barrel closes a cycle back on itself).

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

// With STORE_BACKEND=postgres (PT-3d), one store per (org, user): the store's
// actor is the user, so the registry key must carry both — unlike decisions,
// where the store never needs to know who is writing. The trade-off this
// leaves: two users' saves on one brief serialise only through the
// compare-and-swap in the write's own transaction (the loser gets 409, D82),
// never through the in-process lock chain — that chain only ever sees its own
// process's callers, one per (org, user) store.
const briefs = new Registry<BriefStorePort>(
  (t) =>
    storeBackend() === "postgres"
      ? JSON.stringify(["postgres", scopeTenant(t).orgId, scopeTenant(t).userId])
      : join(scopeRoots(t).projectRoot, "briefs"),
  (key) => {
    // A filesystem root is always an absolute path and never starts with "[".
    // The postgres key is JSON, not string concatenation, so no character an
    // org or user id contains (":" included) can make one pair alias another.
    if (!key.startsWith("[")) return new FsBriefStore(key);
    const [, orgId, userId] = JSON.parse(key) as [string, string, string];
    return new PgBriefStore(database(), orgId, userId);
  },
);
const assets = new Registry<AssetStorePort>(
  (t) => join(scopeRoots(t).projectRoot, "assets", "inputs"),
  (dir) => new FsAssetStore(dir),
);
// With STORE_BACKEND=postgres (PT-3e), one store per org over the process's
// database; otherwise one per project root's briefs directory, on files.
const pools = new Registry<PoolStorePort>(
  (t) =>
    storeBackend() === "postgres"
      ? `postgres:${scopeTenant(t).orgId}`
      : join(scopeRoots(t).projectRoot, "briefs"),
  (key) =>
    key.startsWith("postgres:")
      ? new PgPoolStore(database(), key.slice("postgres:".length))
      : new FsPoolStore(key),
);
// The canonical templates are platform-owned and in memory (M3): one store for
// every tenant until org templates exist.
const templates = new Registry<TemplateStorePort>(
  () => "canonical",
  () => new FsTemplateStore(),
);
// With STORE_BACKEND=postgres (PT-6a), one lease-backed store per org over the
// process's database; otherwise one per output root, on files (unchanged).
const jobs = new Registry<JobStorePort>(
  (t) =>
    storeBackend() === "postgres"
      ? PG + scopeTenant(t).orgId
      : join(scopeRoots(t).outputRoot, "jobs"),
  (key) =>
    key.startsWith(PG) ? new PgJobStore(database(), key.slice(PG.length)) : new FsJobStore(key),
);
// With STORE_BACKEND=postgres (PT-3c), one store per org over the process's
// database; otherwise one per output root, on files.
const reports = new Registry<ReportStorePort>(
  (t) => (storeBackend() === "postgres" ? PG + scopeTenant(t).orgId : scopeRoots(t).outputRoot),
  (key) =>
    key.startsWith(PG)
      ? new PgReportStore(database(), key.slice(PG.length))
      : new FsReportStore(key),
);
const outputs = new Registry<OutputStorePort>(
  (t) => scopeRoots(t).outputRoot,
  (root) => new FsOutputStore(root),
);

// With STORE_BACKEND=postgres (PT-3), one store per org over the process's
// database; otherwise one per output root, on files.
const PG = "postgres:";
const decisions = new Registry<DecisionStorePort>(
  (t) => (storeBackend() === "postgres" ? PG + scopeTenant(t).orgId : scopeRoots(t).outputRoot),
  (key) =>
    key.startsWith(PG)
      ? new PgDecisionStore(database(), key.slice(PG.length))
      : new FsDecisionStore(key),
);

// Usage rows every org shares (PT-7a): unlike decisions, the adapter is not
// scoped to one org (its methods take `orgId` per call), so the whole
// registry is one store per backend, not per tenant root.
const usage = new Registry<UsageStorePort>(
  () => storeBackend(),
  (backend) => (backend === "postgres" ? new PgUsageStore(database()) : new FsUsageStore()),
);

// `getRunDelivery`/`setRunDelivery`/`resetRunDelivery` live in
// `run-delivery-registry.ts`, not here — see that file's docstring.

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

export const getDecisionStore = (scope: StorageScope): DecisionStorePort => decisions.get(scope);
export const setDecisionStore = (store: DecisionStorePort): void => decisions.set(store);
export const resetDecisionStore = (): void => decisions.reset();

export const getUsageStore = (scope: StorageScope): UsageStorePort => usage.get(scope);
export const setUsageStore = (store: UsageStorePort): void => usage.set(store);
export const resetUsageStore = (): void => usage.reset();
