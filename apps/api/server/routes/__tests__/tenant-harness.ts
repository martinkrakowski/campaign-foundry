import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, defineEventHandler, toWebHandler, type EventHandler } from "h3";
import { afterAll } from "vitest";
import { resetProjectRoot } from "@campaignfoundry/shared";
import { resetDatabase, setDatabase } from "../../lib/db/database.js";
import { migratedDatabase } from "../../lib/db/__tests__/pglite-client.js";
import type { SqlClient } from "../../lib/db/sql-client.js";
import {
  resetAssetStore,
  resetBriefStore,
  resetDecisionStore,
  resetJobStore,
  resetOutputStore,
  resetPoolStore,
  resetReportStore,
  resetTemplateStore,
  resetUsageStore,
} from "../../lib/ports/index.js";
import type { TenantContext } from "../../lib/tenant.js";

const createdTenantDirs = new Set<string>();

/**
 * Assert that all temporary directories created by the harness have been removed
 * and not recreated by late writes.
 */
export function assertNoLeakedTenantDirs(): void {
  const leaked = [...createdTenantDirs].filter((dir) => existsSync(dir));
  if (leaked.length > 0) {
    throw new Error(
      `Leaked ${leaked.length} tenant temp director${leaked.length === 1 ? "y" : "ies"}:\n${leaked.join("\n")}`,
    );
  }
}

afterAll(() => {
  assertNoLeakedTenantDirs();
});

export { LOCAL_TENANT, type TenantContext } from "../../lib/tenant.js";

export const ACME_TENANT: TenantContext = {
  orgId: "acme",
  userId: "u1",
  roles: ["owner"],
  teamIds: ["t1"],
};

export type WebCaller = (req: Request) => Promise<Response>;

export interface MountOptions {
  method?: string;
  path?: string;
  tenant?: TenantContext | (() => TenantContext | undefined);
}

export interface RouteRegistration {
  method?: string;
  path: string;
  handler: EventHandler;
}

/** Reset in-memory registries for all stores and monorepo project root. */
export function resetAllStores(): void {
  resetProjectRoot();
  resetBriefStore();
  resetAssetStore();
  resetPoolStore();
  resetTemplateStore();
  resetJobStore();
  resetReportStore();
  resetOutputStore();
  resetDecisionStore();
  resetUsageStore();
}

/**
 * Mount one or more routes behind a middleware setting `event.context.tenant`
 * (following the pattern in lib/__tests__/tenant.test.ts:8-21).
 */
export function mountTenantApp(
  routes: RouteRegistration[] | EventHandler,
  setTenant?: TenantContext | (() => TenantContext | undefined),
): WebCaller {
  const app = createApp();
  if (setTenant) {
    app.use(
      defineEventHandler((event) => {
        event.context.tenant = typeof setTenant === "function" ? setTenant() : setTenant;
      }),
    );
  }
  const router = createRouter();
  if (typeof routes === "function") {
    router.get("/", routes);
  } else {
    for (const r of routes) {
      const method = (r.method ?? "get").toLowerCase();
      if (method === "get") router.get(r.path, r.handler);
      else if (method === "post") router.post(r.path, r.handler);
      else if (method === "put") router.put(r.path, r.handler);
      else if (method === "patch") router.patch(r.path, r.handler);
      else if (method === "delete") router.delete(r.path, r.handler);
      else router.use(r.path, r.handler);
    }
  }
  app.use(router);
  return toWebHandler(app);
}

/**
 * Mount a single route handler behind a middleware setting `event.context.tenant`.
 */
export function mountTenantRoute(
  handler: EventHandler,
  options?: MountOptions | TenantContext,
): WebCaller {
  const opts = options && "orgId" in options ? { tenant: options } : (options ?? {});
  return mountTenantApp(
    [{ method: opts.method ?? "get", path: opts.path ?? "/", handler }],
    opts.tenant,
  );
}

export interface FsHarness {
  readonly backend: "fs";
  readonly tmpDir: string;
  readonly projectRoot: string;
  readonly outputRoot: string;
  readonly localRoots: { projectRoot: string; outputRoot: string };
  readonly acmeRoots: { projectRoot: string; outputRoot: string };
  cleanup(): void;
}

/**
 * Set up the filesystem backend with temporary PROJECT_ROOT and OUTPUT_DIR,
 * org 'local' at the root, and org 'acme' under 'orgs/acme'.
 */
export function setupFsHarness(): FsHarness {
  const origProjectRoot = process.env.PROJECT_ROOT;
  const origOutputDir = process.env.OUTPUT_DIR;
  const origStoreBackend = process.env.STORE_BACKEND;

  const tmpDir = mkdtempSync(join(tmpdir(), "cf-tenant-fs-"));
  createdTenantDirs.add(tmpDir);
  const projectRoot = join(tmpDir, "project");
  const outputRoot = join(tmpDir, "output");

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(outputRoot, { recursive: true });

  const acmeProj = join(projectRoot, "orgs", "acme");
  const acmeOut = join(outputRoot, "orgs", "acme");
  mkdirSync(acmeProj, { recursive: true });
  mkdirSync(acmeOut, { recursive: true });

  process.env.PROJECT_ROOT = projectRoot;
  process.env.OUTPUT_DIR = outputRoot;
  delete process.env.STORE_BACKEND;

  resetProjectRoot();
  resetAllStores();

  return {
    backend: "fs",
    tmpDir,
    projectRoot,
    outputRoot,
    localRoots: { projectRoot, outputRoot },
    acmeRoots: { projectRoot: acmeProj, outputRoot: acmeOut },
    cleanup() {
      resetAllStores();
      if (origProjectRoot === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = origProjectRoot;

      if (origOutputDir === undefined) delete process.env.OUTPUT_DIR;
      else process.env.OUTPUT_DIR = origOutputDir;

      if (origStoreBackend === undefined) delete process.env.STORE_BACKEND;
      else process.env.STORE_BACKEND = origStoreBackend;

      resetProjectRoot();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

export interface PgHarness {
  readonly backend: "postgres";
  readonly db: SqlClient;
  readonly tmpDir: string;
  readonly projectRoot: string;
  readonly outputRoot: string;
  cleanup(): Promise<void>;
}

/**
 * Set up the PostgreSQL backend using migratedDatabase(), STORE_BACKEND=postgres,
 * and mocking database() via setDatabase().
 */
export async function setupPgHarness(
  makeDb: () => ReturnType<typeof migratedDatabase> = migratedDatabase,
): Promise<PgHarness> {
  const origProjectRoot = process.env.PROJECT_ROOT;
  const origOutputDir = process.env.OUTPUT_DIR;
  const origStoreBackend = process.env.STORE_BACKEND;

  const tmpDir = mkdtempSync(join(tmpdir(), "cf-tenant-pg-"));
  createdTenantDirs.add(tmpDir);
  const projectRoot = join(tmpDir, "project");
  const outputRoot = join(tmpDir, "output");

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(outputRoot, { recursive: true });
  mkdirSync(join(projectRoot, "orgs", "acme"), { recursive: true });
  mkdirSync(join(outputRoot, "orgs", "acme"), { recursive: true });

  process.env.PROJECT_ROOT = projectRoot;
  process.env.OUTPUT_DIR = outputRoot;
  process.env.STORE_BACKEND = "postgres";

  const restore = () => {
    if (origProjectRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origProjectRoot;

    if (origOutputDir === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOutputDir;

    if (origStoreBackend === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = origStoreBackend;

    resetProjectRoot();
    rmSync(tmpDir, { recursive: true, force: true });
  };

  // A setup step that throws must not leave Postgres mode, the changed roots
  // or the temp dir behind for the next test in this worker.
  let db: Awaited<ReturnType<typeof migratedDatabase>> | undefined;
  try {
    db = await makeDb();
    setDatabase(db);
    await db.query("insert into org (id, name) values ($1, $2) on conflict do nothing", [
      "acme",
      "Acme",
    ]);
  } catch (error) {
    resetDatabase();
    await db?.end();
    restore();
    throw error;
  }
  const ready = db;

  resetProjectRoot();
  resetAllStores();

  return {
    backend: "postgres",
    db: ready,
    tmpDir,
    projectRoot,
    outputRoot,
    async cleanup() {
      resetAllStores();
      resetDatabase();
      await ready.end();
      restore();
    },
  };
}

export async function setupTenantHarness(backend: "fs"): Promise<FsHarness>;
export async function setupTenantHarness(backend: "postgres"): Promise<PgHarness>;
export async function setupTenantHarness(
  backend: "fs" | "postgres",
): Promise<FsHarness | PgHarness> {
  if (backend === "fs") return setupFsHarness();
  return setupPgHarness();
}
