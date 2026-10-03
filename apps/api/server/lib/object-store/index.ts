import { objectStoreSettings } from "../config.js";
import { S3ObjectStore } from "./S3ObjectStore.js";
import type { ObjectStorePort } from "@campaignfoundry/CampaignOrchestration";

let shared: ObjectStorePort | undefined;

/**
 * The process's object store (PT-4a/#656, PT-4b): built on first use, never at
 * import, and kept for the process exactly as `lib/db/database.ts` keeps its
 * client. Built from the environment at the composition root, not from a
 * request's scope, because a store is not a tenant's — `ObjectAssetStore` is
 * built per org around THIS one, and every method it needs from it is the same
 * store with a different key prefix.
 *
 * **This file must not import the ports barrel.** `lib/ports/index.ts` imports
 * this file's `objectStoreClient()` to build `ObjectAssetStore`, so an import
 * of the barrel back here is a cycle that would be invisible until a lazy
 * `require` resolved it halfway. It imports `S3ObjectStore` and `config.js`
 * directly, which is why neither of those may reach for the barrel either.
 */
export function objectStoreClient(): ObjectStorePort {
  if (shared !== undefined) return shared;
  const settings = objectStoreSettings();
  // Never `!`. `objectStoreSettings()` returns `undefined` under `fs`, and a
  // non-null assertion there would build an `S3ObjectStore` out of `undefined`
  // and fail inside aws4fetch's own signing with a message about a credential
  // — while the real problem is that something asked for an S3 client on a
  // deployment that has no bucket. This names the variable, never a value.
  if (settings === undefined) {
    throw new Error(
      'OBJECT_STORE must be "s3" before an object-store client can be built: objectStoreSettings() has no S3 settings.',
    );
  }
  // The constructor signs nothing and opens no socket (a test builds one from
  // dummy `S3_*` values to prove exactly that), so laziness here is enough:
  // the first request that needs a key is the first thing that touches the
  // network, and a misconfigured endpoint fails there rather than at boot.
  shared = new S3ObjectStore({ settings });
  return shared;
}

/** Install an object store for every caller (a test's `InMemoryObjectStore`). */
export function setObjectStoreClient(client: ObjectStorePort): void {
  shared = client;
}

/** Forget the object store (the next `objectStoreClient()` builds one from the environment). */
export function resetObjectStoreClient(): void {
  shared = undefined;
}
