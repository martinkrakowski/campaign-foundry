import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createApp, createRouter, defineEventHandler, toWebHandler, type EventHandler } from "h3";
import { afterAll } from "vitest";
import { resetProjectRoot } from "@campaignfoundry/shared";
import { isErrno } from "../../lib/brief-files.js";
import { resetDatabase, setDatabase } from "../../lib/db/database.js";
import { migratedDatabase } from "../../lib/db/__tests__/pglite-client.js";
import type { SqlClient } from "../../lib/db/sql-client.js";
import {
  resetAssetStore,
  resetBriefStore,
  resetDecisionStore,
  resetDraftStore,
  resetJobStore,
  resetLastOpenedStore,
  resetOutputStore,
  resetPoolStore,
  resetProviderKeyStore,
  resetReportStore,
  resetTemplateStore,
  resetUsageStore,
} from "../../lib/ports/index.js";
import type { TenantContext } from "../../lib/tenant.js";

const createdTenantDirs = new Set<string>();

/**
 * Harnesses set up in this worker and not yet cleaned up, oldest first.
 *
 * A test that runs past its budget is not cancelled: vitest fails it and starts
 * the next one, while the abandoned body keeps going and calls `cleanup()` when
 * it finishes — often seconds later, mid-flight in whatever test is running by
 * then. "Restore what I found" is the wrong verb for that call. The first test
 * in a worker found `PROJECT_ROOT` unset, so the late cleanup hands the live
 * test an unset root, `projectRoot()` walks up from cwd to the checkout, and
 * the live test's next write lands in the repo — `briefs/<slug>/` (gitignored,
 * so invisible) and `state/last-opened/local.json` (not ignored at all), which
 * is a dirty tree for a run that edited nothing. It is the same crossing
 * `pools.test.ts` had, and it cost #631 a `sync:check` failure.
 *
 * So a cleanup is only allowed to restore the environment when it is the
 * innermost live harness — the one whose own `setup` was the last thing to run.
 * Any other is STALE, and a stale cleanup removes its own temp dir (and closes
 * its own database) and nothing else: no env restore, no `resetProjectRoot()`,
 * no `resetAllStores()`. Dropping the store resets is the load-bearing half —
 * `resetAllStores()` clears the memoized project root and empties every
 * registry cache, so the live test's next request would resolve its store
 * against the environment this stale cleanup had just rewritten.
 */
const liveHarnesses: object[] = [];

/** True when `harness` is the innermost live harness — the only one allowed to
 *  restore the environment. Anything else (or one already dropped from the list
 *  by a later `cleanup`) is stale. */
function isInnermost(harness: object): boolean {
  return liveHarnesses.at(-1) === harness;
}

/** Take a harness out of the live list. A harness no longer in it was already
 *  cleaned up, and its `cleanup` has run twice — still stale, still minimal. */
function retire(harness: object): void {
  const at = liveHarnesses.indexOf(harness);
  if (at !== -1) liveHarnesses.splice(at, 1);
}

/** Stand a harness in for the placeholder a setup registered before its first
 *  `await`, keeping that position — the order is what `isInnermost` reads. */
function promote(placeholder: object, harness: object): void {
  const at = liveHarnesses.indexOf(placeholder);
  if (at !== -1) liveHarnesses[at] = harness;
}

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

/** Files that mark the monorepo root, as `projectRoot()` marks it. */
const ROOT_MARKERS = ["yarn.lock", "turbo.json"];

/**
 * The checkout this worker runs in: the nearest ancestor of cwd holding a root
 * marker, the same walk `projectRoot()` does. Deliberately not `process.cwd()`,
 * which is a workspace directory when vitest runs from one — and a check derived
 * from the wrong directory is not a check at all, it is a green test.
 */
export function checkoutRoot(): string {
  let dir = resolve(process.cwd());
  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(process.cwd());
    dir = parent;
  }
}

/** What a `state/` file looked like when the baseline was taken. */
export interface StateFingerprint {
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Every path under `<root>/state`, relative to `root`, with what each file
 * looked like; empty when there is no such directory. The per-user pointer lands
 * here on the fs backend (`lib/ports/index.ts`), so a `state/` that appears — or
 * CHANGES — where a test wrote is the crossing this harness is hardened against.
 *
 * A fingerprint rather than a path set, because the crossing is not necessarily
 * a new file: `FsLastOpenedStore.write` writes through a sibling temp file and
 * renames it over the target, so a second write to the same user's pointer
 * leaves the same path on disk with different bytes. A path set cannot see that,
 * and the file it would hide is exactly the one whose content the fs tests read.
 */
export function snapshotState(root: string): Map<string, StateFingerprint> {
  const found = new Map<string, StateFingerprint>();
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // Absent is the ordinary case: a checkout that never ran the fs backend
      // has no `state/` at all. Anything else is this check's own problem, and
      // failing to LOOK must never read as "nothing there".
      if (!isErrno(error, "ENOENT")) throw error;
      return;
    }
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else {
        const { size, mtimeMs } = statSync(join(dir, entry.name));
        found.set(path, { size, mtimeMs });
      }
    }
  };
  walk(join(root, "state"), "");
  return found;
}

/**
 * Fail on any path under `<root>/state` that the `baseline` did not have, and on
 * any path whose size or mtime changed since.
 *
 * A baseline, not an existence check, because the checkout's `state/` is not the
 * harness's to judge: `yarn dev` on the fs backend writes
 * `state/last-opened/local.json` under the checkout — PROJECT_ROOT unset is
 * exactly how a dev server runs — and an existence check would blame every
 * harness-importing file for the developer's own run. What is the harness's to
 * judge is a `state/` that GREW or CHANGED while a test ran.
 *
 * The limit that remains: a rewrite to the same byte length within one mtime
 * tick, which nothing here produces — the rename that makes it is a distinct
 * file until the rename. Hashing the contents would close even that, at the
 * cost of reading every file on every assertion to catch a case no assertion
 * observes.
 */
export function assertNoNewState(
  root: string,
  baseline: ReadonlyMap<string, StateFingerprint>,
): void {
  const changed: string[] = [];
  for (const [path, fingerprint] of snapshotState(root)) {
    const before = baseline.get(path);
    if (before === undefined) changed.push(`${path} (new)`);
    else if (before.size !== fingerprint.size || before.mtimeMs !== fingerprint.mtimeMs) {
      changed.push(`${path} (rewritten)`);
    }
  }
  if (changed.length > 0) {
    throw new Error(
      `A test wrote outside its temp dir: ${changed.length} changed path(s) under ${join(root, "state")}:\n${changed.join("\n")}`,
    );
  }
}

/** What the checkout looked like before this file ran a single test. Taken at
 *  module load, because that is the only moment the harness can honestly say
 *  "before": a baseline taken in an `afterAll` would already contain the write
 *  it is meant to catch. */
const checkoutAtLoad = snapshotState(checkoutRoot());

afterAll(() => {
  assertNoLeakedTenantDirs();
  assertNoNewState(checkoutRoot(), checkoutAtLoad);
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
  resetDraftStore();
  resetLastOpenedStore();
  resetUsageStore();
  resetProviderKeyStore();
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
 *
 * `cleanup()` restores only what this harness found, and only while this
 * harness is the innermost live one — see `liveHarnesses` for why a late
 * cleanup from a test that ran out its budget must not. The consequence is
 * worth stating plainly: with harness A stale and harness B live, B's own
 * cleanup still restores B's original, which is A's temp root — a directory A
 * already removed. A write arriving after that recreates that temp path (never
 * the checkout, which is the whole point), and `assertNoLeakedTenantDirs` names
 * it instead of letting it pass as tidiness.
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

  const harness: FsHarness = {
    backend: "fs",
    tmpDir,
    projectRoot,
    outputRoot,
    localRoots: { projectRoot, outputRoot },
    acmeRoots: { projectRoot: acmeProj, outputRoot: acmeOut },
    cleanup() {
      const stale = !isInnermost(harness);
      retire(harness);
      rmSync(tmpDir, { recursive: true, force: true });
      if (stale) return;

      resetAllStores();
      if (origProjectRoot === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = origProjectRoot;

      if (origOutputDir === undefined) delete process.env.OUTPUT_DIR;
      else process.env.OUTPUT_DIR = origOutputDir;

      if (origStoreBackend === undefined) delete process.env.STORE_BACKEND;
      else process.env.STORE_BACKEND = origStoreBackend;

      resetProjectRoot();
    },
  };
  liveHarnesses.push(harness);
  return harness;
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
 *
 * `cleanup()` is the fs harness's cleanup with the database added, and the same
 * staleness rule applies: a stale one closes its own database and removes its
 * own temp dir, and leaves the environment, the store registries and the live
 * harness's `setDatabase()` mock exactly as it found them.
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

  // Live from HERE, not from the `return` below. `makeDb()` migrates a whole
  // database, so this setup spans seconds of `await` with the environment
  // already pointing at its temp root — and a cleanup landing inside that
  // window found no live harness at all (this one had not registered, and the
  // previous one had already retired), so it restored as if it were the last,
  // handing the test that was about to run the root this setup had just
  // installed. Measured on the default 5 s timeout, where every pg setup
  // overruns it: `briefs/pointed-at/` and `state/last-opened/local.json` in
  // the checkout, from a harness that never even timed out. The placeholder is
  // this setup's claim on the environment; `promote` hands it to the harness.
  const pending: object = {};
  liveHarnesses.push(pending);

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
  // or the temp dir behind for the next test in this worker — but a setup that
  // failed LATE, from a body that overran its budget before the failure, has a
  // live harness on top of it. Restoring over that one hands the test now
  // running an unset root, and `resetDatabase()` unmounts its mock. So the same
  // staleness rule as `cleanup()`: a stale failure closes its own database and
  // removes its own temp dir, and touches nothing else.
  let db: Awaited<ReturnType<typeof migratedDatabase>> | undefined;
  try {
    db = await makeDb();
    // An ABANDONED setup: this one's body overran its budget, and a newer
    // harness registered on top of it while the migrations ran. Its roots were
    // installed at entry and are nobody's now, so adopting the database here
    // would mount it over the live harness's mock, and the two resets below
    // would empty the live harness's caches. Reject instead: the body that gets
    // this has already lost, and the process belongs to whoever is running. The
    // catch below is the stale path, so it ends this database and removes this
    // temp dir and restores nothing — which is exactly right for a setup that
    // never became a harness.
    //
    // Which is why the guard comes TWICE, and the second one sits after the LAST
    // await: the org seed is an await too, and a harness that registers during
    // it is just as live as one that registered during the migrations. Checking
    // once, before the seed, adopted the database and then emptied the live
    // caches on the way out — a guard that ran and did not help.
    if (!isInnermost(pending)) {
      throw new Error("setupPgHarness was abandoned: a newer harness is live");
    }
    // On `db` itself, not through `database()`: nothing is adopted until every
    // await this setup does is done, so the seed cannot reach through a mount
    // that a later guard would take back.
    await db.query("insert into org (id, name) values ($1, $2) on conflict do nothing", [
      "acme",
      "Acme",
    ]);
    if (!isInnermost(pending)) {
      throw new Error("setupPgHarness was abandoned: a newer harness is live");
    }
    setDatabase(db);
  } catch (error) {
    const stale = !isInnermost(pending);
    retire(pending);
    if (!stale) resetDatabase();
    try {
      await db?.end();
    } finally {
      if (!stale) restore();
      else rmSync(tmpDir, { recursive: true, force: true });
    }
    throw error;
  }
  const ready = db;

  resetProjectRoot();
  resetAllStores();

  const harness: PgHarness = {
    backend: "postgres",
    db: ready,
    tmpDir,
    projectRoot,
    outputRoot,
    async cleanup() {
      const stale = !isInnermost(harness);
      retire(harness);
      try {
        // A stale cleanup closes its OWN database and nothing else: the env
        // restore, the store resets and `resetDatabase()` all belong to the
        // harness that is still live, and `resetDatabase()` in particular would
        // unmount the live harness's mock out from under it.
        if (!stale) {
          resetAllStores();
          resetDatabase();
        }
        await ready.end();
      } finally {
        // The temp dir goes either way, and the environment is restored only by
        // the harness that is still live — so a failure `end()` reports is the
        // one this cleanup throws, and it throws it AFTER the restore rather
        // than swallowing it.
        rmSync(tmpDir, { recursive: true, force: true });
        if (!stale) restore();
      }
    },
  };
  promote(pending, harness);
  return harness;
}

export async function setupTenantHarness(backend: "fs"): Promise<FsHarness>;
export async function setupTenantHarness(backend: "postgres"): Promise<PgHarness>;
export async function setupTenantHarness(
  backend: "fs" | "postgres",
): Promise<FsHarness | PgHarness> {
  if (backend === "fs") return setupFsHarness();
  return setupPgHarness();
}
