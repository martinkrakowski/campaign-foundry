import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import {
  publicAdMediaClient,
  resetObjectStoreClient,
  resetPublicAdMediaClient,
  setObjectStoreClient,
  setPublicAdMediaClient,
} from "../index.js";
import { S3ObjectStore } from "../S3ObjectStore.js";

/**
 * The public ad-media client's composition point (PT-4k). Everything here is
 * offline: `S3ObjectStore` is mocked, so the assertions are on WHICH settings
 * the client is built from — the `PUBLIC_MEDIA_*` ones, never the private
 * store's — and on the isolation from a store installed for the private bucket.
 */

vi.mock("../S3ObjectStore.js", () => {
  const constructed: unknown[] = [];
  const MockedStore = class {
    readonly settings: unknown;
    constructor(options: { readonly settings: unknown }) {
      this.settings = options.settings;
      constructed.push(this);
    }
    /** Publish goes through this mocked store; it must accept and hold nothing. */
    async put(): Promise<void> {}
  };
  return {
    S3ObjectStore: MockedStore,
    constructed,
    __esModule: true,
  };
});

// The mock factory above cannot close over imports cleanly in every hoisting
// order, so the constructed list is read back through the module record.
import * as s3Module from "../S3ObjectStore.js";
const constructed = (s3Module as unknown as { constructed: unknown[] }).constructed;

const PUBLIC_VARS = [
  "OBJECT_STORE",
  "PUBLIC_MEDIA_BUCKET",
  "PUBLIC_MEDIA_BASE_URL",
  "PUBLIC_MEDIA_ACCESS_KEY_ID",
  "PUBLIC_MEDIA_SECRET_ACCESS_KEY",
  "PUBLIC_MEDIA_ENDPOINT",
  "PUBLIC_MEDIA_REGION",
] as const;

const SAVED = Object.fromEntries(PUBLIC_VARS.map((name) => [name, process.env[name]]));

function withPublicEnv(over: { readonly objectStore?: string } = {}): void {
  process.env.OBJECT_STORE = over.objectStore ?? "fs";
  process.env.PUBLIC_MEDIA_BUCKET = "public-bucket";
  process.env.PUBLIC_MEDIA_BASE_URL = "https://media.example";
  process.env.PUBLIC_MEDIA_ACCESS_KEY_ID = "public-key";
  process.env.PUBLIC_MEDIA_SECRET_ACCESS_KEY = "public-secret";
  process.env.PUBLIC_MEDIA_ENDPOINT = "http://media-s3.invalid:8333";
  process.env.PUBLIC_MEDIA_REGION = "us-east-1";
}

afterEach(() => {
  resetPublicAdMediaClient();
  resetObjectStoreClient();
  for (const name of PUBLIC_VARS) {
    if (SAVED[name] === undefined) delete process.env[name];
    else process.env[name] = SAVED[name];
  }
});

describe("publicAdMediaClient (the composition point)", () => {
  test("under OBJECT_STORE=fs it builds an S3ObjectStore from the PUBLIC_MEDIA_* settings", () => {
    withPublicEnv();
    constructed.length = 0;
    const client = publicAdMediaClient();
    expect(client).toBeDefined();
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toBeInstanceOf(S3ObjectStore);
    const settings = (constructed[0] as { settings: Record<string, string> }).settings;
    expect(settings.bucket).toBe("public-bucket");
    expect(settings.publicEndpoint).toBe("https://media.example");
    expect(settings.endpoint).toBe("http://media-s3.invalid:8333");
    expect(settings.accessKeyId).toBe("public-key");
    expect(settings.secretAccessKey).toBe("public-secret");
  });

  test("it is memoised, and resetPublicAdMediaClient forgets it", () => {
    withPublicEnv();
    constructed.length = 0;
    const first = publicAdMediaClient();
    expect(publicAdMediaClient()).toBe(first);
    expect(constructed).toHaveLength(1);
    resetPublicAdMediaClient();
    expect(publicAdMediaClient()).not.toBe(first);
    expect(constructed).toHaveLength(2);
  });

  test("unconfigured it returns undefined, never a not-configured error", () => {
    for (const name of PUBLIC_VARS) delete process.env[name];
    expect(publicAdMediaClient()).toBeUndefined();
  });

  test("the private store installed via setObjectStoreClient receives zero calls", async () => {
    withPublicEnv({ objectStore: "fs" });
    constructed.length = 0;
    const memory = new InMemoryObjectStore();
    const put = vi.spyOn(memory, "put");
    const get = vi.spyOn(memory, "get");
    const list = vi.spyOn(memory, "list");
    setObjectStoreClient(memory);
    const client = publicAdMediaClient();
    expect(client).toBeDefined();
    await client!.publish("org-a", new Uint8Array([1, 2, 3]), "a".repeat(64));
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(constructed).toHaveLength(1);
  });

  test("setPublicAdMediaClient installs a double that a caller gets back", () => {
    const double = { publish: vi.fn(), remove: vi.fn(), removeOrg: vi.fn(), urlFor: vi.fn() };
    setPublicAdMediaClient(double as never);
    expect(publicAdMediaClient()).toBe(double);
  });
});
