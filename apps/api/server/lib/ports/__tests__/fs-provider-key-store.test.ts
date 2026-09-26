import { describe, test, expect, afterEach } from "vitest";
import { getProviderKeyStore, resetProviderKeyStore } from "../index.js";
import { LOCAL_TENANT } from "../../tenant.js";
import { ProviderKeyUnavailableError } from "../provider-key.port.js";
import { FsProviderKeyStore } from "../fs-provider-key-store.js";

describe("FsProviderKeyStore (PT-7b2): BYOK is Postgres-only", () => {
  const store = new FsProviderKeyStore();

  test("put refuses, naming that provider keys need Postgres", async () => {
    await expect(store.put("gemini", "sk-fake-key-0000", "user-1")).rejects.toBeInstanceOf(
      ProviderKeyUnavailableError,
    );
    await expect(store.put("gemini", "sk-fake-key-0000", "user-1")).rejects.toThrow(/postgres/i);
  });

  test("list refuses", async () => {
    await expect(store.list()).rejects.toBeInstanceOf(ProviderKeyUnavailableError);
  });

  test("revoke refuses", async () => {
    await expect(store.revoke("gemini")).rejects.toBeInstanceOf(ProviderKeyUnavailableError);
  });

  test("open refuses", async () => {
    await expect(store.open("gemini")).rejects.toBeInstanceOf(ProviderKeyUnavailableError);
  });

  test("no error message ever contains the plaintext it was called with", async () => {
    try {
      await store.put("gemini", "sk-should-never-leak-9999", "user-1");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("sk-should-never-leak-9999");
    }
  });
});

describe("the registry builds FsProviderKeyStore when STORE_BACKEND is not postgres (PT-7b2)", () => {
  const saved = process.env.STORE_BACKEND;

  afterEach(() => {
    if (saved === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = saved;
    resetProviderKeyStore();
  });

  test("the default (fs) backend answers with FsProviderKeyStore", () => {
    delete process.env.STORE_BACKEND;
    resetProviderKeyStore();
    expect(getProviderKeyStore(LOCAL_TENANT)).toBeInstanceOf(FsProviderKeyStore);
  });
});
