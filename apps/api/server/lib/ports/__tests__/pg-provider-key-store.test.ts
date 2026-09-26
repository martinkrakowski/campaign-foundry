import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { ProviderKeyUnavailableError } from "../provider-key.port.js";
import { PgProviderKeyStore } from "../pg-provider-key-store.js";

const KEK_KEYS = ["KEY_ENCRYPTION_KEYS", "KEY_ENCRYPTION_KEY_CURRENT"] as const;
const savedKek = Object.fromEntries(KEK_KEYS.map((k) => [k, process.env[k]]));
const b64_1 = Buffer.alloc(32, 1).toString("base64");
const b64_2 = Buffer.alloc(32, 2).toString("base64");

function setKek(): void {
  process.env.KEY_ENCRYPTION_KEYS = `v1:${b64_1}`;
  process.env.KEY_ENCRYPTION_KEY_CURRENT = "v1";
}

function clearKek(): void {
  delete process.env.KEY_ENCRYPTION_KEYS;
  delete process.env.KEY_ENCRYPTION_KEY_CURRENT;
}

describe("PgProviderKeyStore (PT-7b2, D175, D176)", () => {
  let db: SqlClient;

  beforeEach(async () => {
    db = await migratedDatabase();
  });

  afterEach(async () => {
    await db.end();
    for (const k of KEK_KEYS) {
      if (savedKek[k] === undefined) delete process.env[k];
      else process.env[k] = savedKek[k];
    }
  });

  test("an org with no keys lists none", async () => {
    setKek();
    const store = new PgProviderKeyStore(db, "local");
    await expect(store.list()).resolves.toEqual([]);
  });

  test("a key round-trips through put and open, and list carries only provider, last4 and createdAt", async () => {
    setKek();
    const store = new PgProviderKeyStore(db, "local");
    const summary = await store.put("gemini", "sk-fake-gemini-key-0001", "user-1");
    expect(summary.provider).toBe("gemini");
    expect(summary.last4).toBe("0001");
    expect(typeof summary.createdAt).toBe("string");
    expect(new Date(summary.createdAt).toISOString()).toBe(summary.createdAt);

    await expect(store.list()).resolves.toEqual([summary]);
    await expect(store.open("gemini")).resolves.toBe("sk-fake-gemini-key-0001");
  });

  test("opening a provider with no active key answers undefined", async () => {
    setKek();
    const store = new PgProviderKeyStore(db, "local");
    await expect(store.open("openrouter")).resolves.toBeUndefined();
  });

  test("replacing a key revokes the old one: only the new one lists or opens", async () => {
    setKek();
    const store = new PgProviderKeyStore(db, "local");
    await store.put("gemini", "sk-fake-old-key-aaaa", "user-1");
    const replaced = await store.put("gemini", "sk-fake-new-key-bbbb", "user-2");

    const list = await store.list();
    expect(list).toEqual([replaced]);
    expect(list[0]!.last4).toBe("bbbb");
    await expect(store.open("gemini")).resolves.toBe("sk-fake-new-key-bbbb");
  });

  test("revoking a key removes it from the list and from open, and revoking again is a no-op", async () => {
    setKek();
    const store = new PgProviderKeyStore(db, "local");
    await store.put("firefly", '{"clientId":"fake-id","clientSecret":"fake-secret"}', "user-1");

    await store.revoke("firefly");
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.open("firefly")).resolves.toBeUndefined();

    // No active row: a no-op, not an error.
    await expect(store.revoke("firefly")).resolves.toBeUndefined();
  });

  test("another org's keys are invisible, and its own are separate", async () => {
    setKek();
    await db.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
    const local = new PgProviderKeyStore(db, "local");
    const acme = new PgProviderKeyStore(db, "acme");

    await local.put("gemini", "sk-fake-local-key-1111", "user-1");
    await expect(acme.list()).resolves.toEqual([]);
    await expect(acme.open("gemini")).resolves.toBeUndefined();

    await acme.put("gemini", "sk-fake-acme-key-2222", "user-2");
    await expect(local.open("gemini")).resolves.toBe("sk-fake-local-key-1111");
    await expect(acme.open("gemini")).resolves.toBe("sk-fake-acme-key-2222");
  });

  test("put refuses with no key encryption key configured, naming the missing setting", async () => {
    clearKek();
    const store = new PgProviderKeyStore(db, "local");
    await expect(store.put("gemini", "sk-fake-key-0000", "user-1")).rejects.toBeInstanceOf(
      ProviderKeyUnavailableError,
    );
    await expect(store.put("gemini", "sk-fake-key-0000", "user-1")).rejects.toThrow(
      /KEY_ENCRYPTION_KEYS/,
    );
  });

  test("open refuses with no key encryption key configured, for a key sealed while one was", async () => {
    setKek();
    const store = new PgProviderKeyStore(db, "local");
    await store.put("gemini", "sk-fake-key-0000", "user-1");
    clearKek();
    await expect(store.open("gemini")).rejects.toBeInstanceOf(ProviderKeyUnavailableError);
  });

  test("list and revoke work with no key encryption key configured: only put and open need one", async () => {
    setKek();
    const store = new PgProviderKeyStore(db, "local");
    await store.put("gemini", "sk-fake-key-9999", "user-1");
    clearKek();
    await expect(store.list()).resolves.toMatchObject([{ provider: "gemini", last4: "9999" }]);
    await expect(store.revoke("gemini")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  test("no plaintext, ciphertext or sealed fields appear in a list response", async () => {
    setKek();
    const store = new PgProviderKeyStore(db, "local");
    await store.put("openrouter", "sk-or-fake-secret-value-here", "user-1");
    const list = await store.list();
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain("sk-or-fake-secret-value-here");
    expect(list[0]).toEqual({
      provider: "openrouter",
      last4: "here",
      createdAt: list[0]!.createdAt,
    });
  });

  test("a rotated KEK still opens a key sealed under the old version", async () => {
    process.env.KEY_ENCRYPTION_KEYS = `v1:${b64_1}`;
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "v1";
    const store = new PgProviderKeyStore(db, "local");
    await store.put("gemini", "sk-fake-rotate-key-1234", "user-1");

    process.env.KEY_ENCRYPTION_KEYS = `v1:${b64_1},v2:${b64_2}`;
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "v2";
    await expect(store.open("gemini")).resolves.toBe("sk-fake-rotate-key-1234");
  });
});
