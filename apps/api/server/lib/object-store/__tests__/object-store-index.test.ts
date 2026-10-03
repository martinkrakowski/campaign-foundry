import { afterEach, describe, expect, test } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { S3ObjectStore } from "../S3ObjectStore.js";
import { objectStoreClient, resetObjectStoreClient, setObjectStoreClient } from "../index.js";

/**
 * The process's object store (PT-4b). Every assertion here is offline: the
 * `S3ObjectStore` constructor signs nothing and opens no socket, so a build from
 * dummy `S3_*` values exercises the real lazy path without a store existing.
 */

const OBJECT_STORE_VARS = [
  "OBJECT_STORE",
  "STORE_BACKEND",
  "S3_ENDPOINT",
  "S3_PUBLIC_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

const SAVED = Object.fromEntries(OBJECT_STORE_VARS.map((name) => [name, process.env[name]]));

/** Set every `S3_*` variable to a dummy, plus the two switches, for one test. */
function withS3Env(over: { readonly objectStore?: string; readonly storeBackend?: string }): void {
  process.env.OBJECT_STORE = over.objectStore ?? "s3";
  process.env.STORE_BACKEND = over.storeBackend ?? "postgres";
  process.env.S3_ENDPOINT = "http://s3.invalid:8333";
  process.env.S3_PUBLIC_ENDPOINT = "https://s3.invalid";
  process.env.S3_REGION = "us-east-1";
  process.env.S3_BUCKET = "campaign-foundry-test";
  process.env.S3_ACCESS_KEY_ID = "dummy-access-key";
  process.env.S3_SECRET_ACCESS_KEY = "dummy-secret-key";
}

afterEach(() => {
  resetObjectStoreClient();
  for (const name of OBJECT_STORE_VARS) {
    if (SAVED[name] === undefined) delete process.env[name];
    else process.env[name] = SAVED[name];
  }
});

describe("objectStoreClient (the composition point)", () => {
  test("under OBJECT_STORE=s3 it builds one S3ObjectStore and keeps it", () => {
    withS3Env({});
    const first = objectStoreClient();
    expect(first).toBeInstanceOf(S3ObjectStore);
    // Memoised for the process, exactly as `lib/db/database.ts` memoises its
    // client: two callers must not each build a store.
    expect(objectStoreClient()).toBe(first);
  });

  test("resetObjectStoreClient forgets it, and setObjectStoreClient installs a double", () => {
    withS3Env({});
    const built = objectStoreClient();
    resetObjectStoreClient();
    const memory = new InMemoryObjectStore();
    setObjectStoreClient(memory);
    expect(objectStoreClient()).toBe(memory);
    // And the double is what a later reset drops, so the environment is read
    // again rather than the fake being pinned for the process.
    resetObjectStoreClient();
    expect(objectStoreClient()).not.toBe(memory);
    expect(objectStoreClient()).not.toBe(built);
  });

  test("under OBJECT_STORE=fs it refuses by NAME rather than building an S3 store from undefined", () => {
    // The `!` this replaces would reach aws4fetch's signing and fail there
    // complaining about a credential, on a deployment that simply has no
    // bucket — naming the wrong thing entirely.
    withS3Env({ objectStore: "fs" });
    let thrown: unknown;
    try {
      objectStoreClient();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('OBJECT_STORE must be "s3"');
    expect(message).toContain("objectStoreSettings()");
    expect(message).not.toContain("dummy");
  });
});
