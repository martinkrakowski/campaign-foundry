import { copyFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import type {
  ListedObject,
  ObjectContent,
  ObjectKey,
  ObjectMetadata,
  ObjectStorePort,
  PresignGetOptions,
  PutObjectOptions,
} from "@campaignfoundry/CampaignOrchestration";
import type { SqlClient, SqlQuery } from "../../../db/sql-client.js";
import { migratedDatabase } from "../../../db/__tests__/pglite-client.js";
import { resetDatabase, setDatabase } from "../../../db/database.js";
import { resetObjectStoreClient, setObjectStoreClient } from "../../../object-store/index.js";
import { resetAssetStore, resetBriefStore } from "../../../ports/index.js";
import type { AssetStorePort } from "../../../ports/asset-store.port.js";
import type { BriefStorePort } from "../../../ports/brief-store.port.js";
import { makeRoot, writeAt } from "./tree.js";

/**
 * A wrapper over `InMemoryObjectStore` that the harness installs as the process
 * object store: it counts `put` and `delete` calls so a test can assert nothing
 * was written on the second import, and can throw on the Nth `put` to simulate a
 * store failure mid-write (D222's "after the Nth write" injection, N3).
 */
export class CountingObjects implements ObjectStorePort {
  putCount = 0;
  deleteCount = 0;
  /** When set, the Nth `put` call throws `new Error("injected")`. */
  failOnNthPut: number | undefined;
  #puts = 0;

  constructor(private readonly inner: InMemoryObjectStore) {}

  async put(key: ObjectKey, bytes: Uint8Array, options?: PutObjectOptions): Promise<void> {
    this.#puts++;
    this.putCount++;
    if (this.failOnNthPut !== undefined && this.#puts === this.failOnNthPut) {
      throw new Error("injected");
    }
    await this.inner.put(key, bytes, options);
  }

  async get(key: ObjectKey): Promise<ObjectContent | undefined> {
    return this.inner.get(key);
  }

  async head(key: ObjectKey): Promise<ObjectMetadata | undefined> {
    return this.inner.head(key);
  }

  async delete(key: ObjectKey): Promise<void> {
    this.deleteCount++;
    await this.inner.delete(key);
  }

  async list(prefix: ObjectKey): Promise<readonly ListedObject[]> {
    return this.inner.list(prefix);
  }

  listPages(prefix: ObjectKey): AsyncIterable<readonly ListedObject[]> {
    return this.inner.listPages(prefix);
  }

  async deletePrefix(prefix: ObjectKey): Promise<void> {
    await this.inner.deletePrefix(prefix);
  }

  async copy(srcKey: ObjectKey, dstKey: ObjectKey): Promise<void> {
    await this.inner.copy(srcKey, dstKey);
  }

  async presignGet(key: ObjectKey, options: PresignGetOptions): Promise<string> {
    return this.inner.presignGet(key, options);
  }
}

type AnyStore = BriefStorePort | AssetStorePort;

/**
 * Wrap a brief or asset store so the Nth call to `method` throws `new Error("injected")`.
 *
 * Every other call delegates unchanged to the wrapped store, so a test can fail
 * exactly one write and then rerun the import to prove it is resumable (N2/N3):
 * `failOnNth(assets, "writeAsset", 1)` breaks the first asset write, and the
 * next call completes the campaign without duplicating rows.
 */
export function failOnNth<T extends AnyStore>(store: T, method: keyof T, n: number): T {
  let calls = 0;
  return new Proxy(store, {
    get(target, prop, _receiver): unknown {
      const value = (target as unknown as Record<string, unknown>)[prop as string];
      if (prop === method && typeof value === "function") {
        return (...args: unknown[]): unknown => {
          calls++;
          if (calls === n) throw new Error("injected");
          return (value as (...args: unknown[]) => unknown)(...args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const SAVED_ENV = ["STORE_BACKEND", "OBJECT_STORE", "DATABASE_URL"] as const;
const saved: Record<string, string | undefined> = {};
let realDb: SqlClient | undefined;

function saveEnv(): void {
  for (const key of SAVED_ENV) saved[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of SAVED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
}

/** A `SqlClient` that delegates to `real` but records every SQL text and never closes it. */
function wrappedClient(real: SqlClient, queries: string[]): SqlClient {
  const record = (text: string): void => {
    queries.push(text);
  };
  return {
    query: async (text, params) => {
      record(text);
      return real.query(text, params);
    },
    exec: async (text) => {
      record(text);
      return real.exec(text);
    },
    transaction: async (work) =>
      real.transaction(async (tx) => {
        const traced: SqlQuery = {
          query: async (text, params) => {
            record(text);
            return tx.query(text, params);
          },
          exec: async (text) => {
            record(text);
            return tx.exec(text);
          },
        };
        return work(traced);
      }),
    end: async () => {},
  };
}

/**
 * Stand up the import test world: a migrated PGlite database wired in as the
 * process database, an in-memory object store wired in as the process store, and
 * the env set so the port registries build the *postgres/s3* backends.
 *
 * Called in `beforeEach`. Throws at once when `TEST_PG_URL` is set: this harness
 * runs only on PGlite by design (N9), and a real server would reach past it.
 */
export async function useApplyEnvironment(): Promise<{
  db: SqlClient;
  queries: string[];
  objects: CountingObjects;
  reinstall: () => void;
}> {
  if (process.env.TEST_PG_URL !== undefined) {
    throw new Error("useApplyEnvironment refuses TEST_PG_URL; this harness runs only on PGlite.");
  }
  saveEnv();
  process.env.STORE_BACKEND = "postgres";
  process.env.OBJECT_STORE = "s3";
  process.env.DATABASE_URL = "postgres://nobody@unused.invalid:5432/none";

  realDb = await migratedDatabase();
  const queries: string[] = [];
  const db = wrappedClient(realDb, queries);
  const objects = new CountingObjects(new InMemoryObjectStore());

  setDatabase(db);
  setObjectStoreClient(objects);
  resetBriefStore();
  resetAssetStore();

  return {
    db,
    queries,
    objects,
    reinstall: () => {
      setDatabase(db);
      resetBriefStore();
      resetAssetStore();
    },
  };
}

/**
 * Undo `useApplyEnvironment`: restore the env, drop the process database and
 * object store doubles, and close the real PGlite instance the wrapped client
 * kept alive behind its no-op `end()`.
 */
export async function restoreApplyEnvironment(): Promise<void> {
  restoreEnv();
  resetDatabase();
  resetObjectStoreClient();
  resetBriefStore();
  resetAssetStore();
  if (realDb !== undefined) {
    await realDb.end();
    realDb = undefined;
  }
}

/** Recursively copy the regular files of `srcDir` under `relBase` in the temp root. */
function copyTree(srcDir: string, root: string, relBase: string): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const rel = join(relBase, entry.name);
    if (entry.isFile()) {
      writeAt(root, rel, readFileSync(join(srcDir, entry.name)));
    } else if (entry.isDirectory()) {
      copyTree(join(srcDir, entry.name), root, rel);
    }
  }
}

/**
 * A temp project root built from the TRACKED sample briefs and their input
 * assets, mirroring the operator's own demo tree so an import step runs against
 * real (shipped) bytes, not fixtures invented in-test.
 *
 * Only `briefs/sample-*` entries are copied (the whole tracked `briefs/` is
 * demo briefs), plus every `assets/inputs/*.png` the samples may name.
 */
export function trackedSampleTree(): { root: string } {
  const root = makeRoot();
  const src = projectRoot();
  const briefsDir = join(src, "briefs");
  for (const entry of readdirSync(briefsDir, { withFileTypes: true })) {
    if (!entry.name.startsWith("sample")) continue;
    if (entry.isFile()) {
      writeAt(root, join("briefs", entry.name), readFileSync(join(briefsDir, entry.name)));
    } else {
      copyTree(join(briefsDir, entry.name), root, join("briefs", entry.name));
    }
  }
  copyTree(join(src, "assets", "inputs"), root, join("assets", "inputs"));
  return { root };
}
