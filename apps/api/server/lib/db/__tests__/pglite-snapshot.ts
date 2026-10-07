import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { checksum, migrate, type Migration } from "../migrate.js";
import type { SqlClient, SqlQuery, SqlRows } from "../sql-client.js";

const require = createRequire(import.meta.url);

/** The installed PGlite engine version; a data dir written by a different engine must never be loaded. */
export function pgliteEngineVersion(): string {
  try {
    return require("@electric-sql/pglite/package.json").version;
  } catch {
    const mainPath = require.resolve("@electric-sql/pglite");
    const pkgPath = join(dirname(mainPath), "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
  }
}

export interface SnapshotPaths {
  readonly empty: string;
  readonly migrated: string;
}

/** The identity of a migration set: each id AND its SQL's checksum, as `schema_migrations` records them. */
export function snapshotKey(migrations: readonly Migration[], engineVersion: string): string {
  const shape = migrations.map((m) => ({ id: m.id, checksum: checksum(m.sql) }));
  return createHash("sha256")
    .update(JSON.stringify({ engine: engineVersion, shape }))
    .digest("hex")
    .slice(0, 12);
}

export function snapshotDir(): string {
  return join(tmpdir(), "cf-pglite-snapshots");
}

export function snapshotPaths(
  migrations: readonly Migration[],
  dir = snapshotDir(),
  engineVersion = pgliteEngineVersion(),
): SnapshotPaths {
  const key = snapshotKey(migrations, engineVersion);
  return { empty: join(dir, `${key}.empty.tar`), migrated: join(dir, `${key}.migrated.tar`) };
}

/** The `over(...)`/`transaction` wrapper that turns a raw PGlite into a `SqlClient`. */
export function sqlClientOver(db: PGlite): SqlClient {
  const over = (run: Pick<PGlite, "query" | "exec">): SqlQuery => ({
    query: async <R>(text: string, params?: readonly unknown[]) =>
      (await run.query<R>(text, params === undefined ? undefined : [...params])) as SqlRows<R>,
    exec: async (text: string) => {
      await run.exec(text);
    },
  });
  return {
    ...over(db),
    transaction: (work) => db.transaction((tx) => work(over(tx))),
    end: () => db.close(),
  };
}

async function writeAtomic(path: string, blob: Blob): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, Buffer.from(await blob.arrayBuffer()));
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const blobs = new Map<string, Blob>();

/** One Blob per file process (each test file is its own module registry). */
export function snapshotBlob(path: string): Blob {
  const held = blobs.get(path);
  if (held) return held;
  const blob = new Blob([readFileSync(path)]);
  blobs.set(path, blob);
  return blob;
}

declare module "vitest" {
  export interface ProvidedContext {
    pgliteSnapshots?: { empty: string; migrated: string };
  }
}

/** Build both snapshots from one initdb; a key whose files exist is not rebuilt. */
export async function buildSnapshots(
  migrations: readonly Migration[],
  dir = snapshotDir(),
  engineVersion = pgliteEngineVersion(),
): Promise<SnapshotPaths> {
  const paths = snapshotPaths(migrations, dir, engineVersion);
  mkdirSync(dir, { recursive: true });
  if (existsSync(paths.empty) && existsSync(paths.migrated)) return paths;
  const base = new PGlite();
  await base.waitReady;
  const emptyDump = await base.dumpDataDir("none");
  await base.close();
  await writeAtomic(paths.empty, emptyDump);
  const db = new PGlite({ loadDataDir: emptyDump });
  await db.waitReady;
  await migrate(sqlClientOver(db), migrations);
  const migratedDump = await db.dumpDataDir("none");
  await db.close();
  await writeAtomic(paths.migrated, migratedDump);
  return paths;
}
