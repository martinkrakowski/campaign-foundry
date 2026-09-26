import { describe, test, expect, vi, afterEach } from "vitest";
import {
  ProviderKeyConflictError,
  ProviderKeyUnavailableError,
  resetProviderKeyStore,
  setProviderKeyStore,
  type ProviderKeyPort,
} from "../../../../lib/ports/index.js";
import type { TenantContext } from "../../../../lib/tenant.js";
import {
  ACME_TENANT,
  LOCAL_TENANT,
  mountTenantRoute,
  setupPgHarness,
} from "../../../__tests__/tenant-harness.js";
import getOneHandler from "../[provider].get.js";
import putHandler from "../[provider].put.js";
import deleteHandler from "../[provider].delete.js";
import listHandler from "../index.get.js";

const MEMBER: TenantContext = {
  orgId: "local",
  userId: "u-member",
  roles: ["member"],
  teamIds: [],
};
const ADMIN: TenantContext = { orgId: "local", userId: "u-admin", roles: ["admin"], teamIds: [] };

const KEK_KEYS = ["KEY_ENCRYPTION_KEYS", "KEY_ENCRYPTION_KEY_CURRENT"] as const;
const saved = Object.fromEntries(KEK_KEYS.map((k) => [k, process.env[k]]));
function setKek(): void {
  process.env.KEY_ENCRYPTION_KEYS = `v1:${Buffer.alloc(32, 7).toString("base64")}`;
  process.env.KEY_ENCRYPTION_KEY_CURRENT = "v1";
}
function restoreKek(): void {
  for (const k of KEK_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

const list = (tenant: TenantContext) =>
  mountTenantRoute(listHandler, { path: "/campaigns/provider-keys", tenant })(
    new Request("http://x/campaigns/provider-keys"),
  );

const getOne = (provider: string, tenant: TenantContext) =>
  mountTenantRoute(getOneHandler, { path: "/campaigns/provider-keys/:provider", tenant })(
    new Request(`http://x/campaigns/provider-keys/${provider}`),
  );

const put = (provider: string, body: unknown, tenant: TenantContext) =>
  mountTenantRoute(putHandler, {
    method: "put",
    path: "/campaigns/provider-keys/:provider",
    tenant,
  })(
    new Request(`http://x/campaigns/provider-keys/${provider}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const del = (provider: string, tenant: TenantContext) =>
  mountTenantRoute(deleteHandler, {
    method: "delete",
    path: "/campaigns/provider-keys/:provider",
    tenant,
  })(new Request(`http://x/campaigns/provider-keys/${provider}`, { method: "DELETE" }));

describe("provider-keys routes (PT-7b2, D175, D176)", () => {
  // tenant-harness.ts's resetAllStores() now resets the provider-key store
  // too, so setupPgHarness()/cleanup() alone keeps the shared registry
  // (lib/ports/index.ts, which caches a PgProviderKeyStore per org id) from
  // holding a stale store bound to a previous test's closed PGlite instance.
  afterEach(() => {
    restoreKek();
  });

  test("owner registers a key; any member (and the owner) can list and read it back", async () => {
    setKek();
    const harness = await setupPgHarness();
    try {
      const putRes = await put("gemini", { key: "sk-fake-gemini-abcd" }, LOCAL_TENANT);
      expect(putRes.status).toBe(200);
      const putBody = (await putRes.json()) as { provider: string; last4: string };
      expect(putBody).toEqual({ provider: "gemini", last4: "abcd", createdAt: expect.any(String) });

      const listRes = await list(MEMBER);
      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toEqual([putBody]);

      const oneRes = await getOne("gemini", MEMBER);
      expect(oneRes.status).toBe(200);
      expect(await oneRes.json()).toEqual(putBody);
    } finally {
      await harness.cleanup();
    }
  });

  test("an admin may also register and revoke a key", async () => {
    setKek();
    const harness = await setupPgHarness();
    try {
      const putRes = await put("openrouter", { key: "sk-fake-or-wxyz" }, ADMIN);
      expect(putRes.status).toBe(200);
      const delRes = await del("openrouter", ADMIN);
      expect(delRes.status).toBe(200);
      expect(await delRes.json()).toEqual({ revoked: true });
      expect(await (await list(ADMIN)).json()).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("a member cannot register a provider key (403)", async () => {
    setKek();
    const harness = await setupPgHarness();
    try {
      const res = await put("gemini", { key: "sk-fake-key-1234" }, MEMBER);
      expect(res.status).toBe(403);
      expect(await list(LOCAL_TENANT).then((r) => r.json())).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("a member cannot revoke a provider key (403)", async () => {
    setKek();
    const harness = await setupPgHarness();
    try {
      await put("gemini", { key: "sk-fake-key-1234" }, LOCAL_TENANT);
      const res = await del("gemini", MEMBER);
      expect(res.status).toBe(403);
      const one = await getOne("gemini", LOCAL_TENANT);
      expect(one.status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });

  test("firefly takes clientId and clientSecret, sealed together", async () => {
    setKek();
    const harness = await setupPgHarness();
    try {
      const res = await put(
        "firefly",
        { clientId: "fake-client-id", clientSecret: "fake-client-secret" },
        LOCAL_TENANT,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { last4: string };
      expect(body.last4).toBe("cret");
    } finally {
      await harness.cleanup();
    }
  });

  test("PUT rejects an unknown provider (400)", async () => {
    setKek();
    const harness = await setupPgHarness();
    try {
      const res = await put("unknown-provider", { key: "sk-fake" }, LOCAL_TENANT);
      expect(res.status).toBe(400);
    } finally {
      await harness.cleanup();
    }
  });

  test("PUT rejects a body missing, empty or the wrong shape for its provider's fields (400)", async () => {
    setKek();
    const harness = await setupPgHarness();
    try {
      const missingKey = await put("gemini", {}, LOCAL_TENANT);
      expect(missingKey.status).toBe(400);

      const emptyKey = await put("gemini", { key: "" }, LOCAL_TENANT);
      expect(emptyKey.status).toBe(400);

      const notAnObject = await mountTenantRoute(putHandler, {
        method: "put",
        path: "/campaigns/provider-keys/:provider",
        tenant: LOCAL_TENANT,
      })(
        new Request("http://x/campaigns/provider-keys/gemini", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify("just a string"),
        }),
      );
      expect(notAnObject.status).toBe(400);

      const missingFireflyField = await put("firefly", { clientId: "only-id" }, LOCAL_TENANT);
      expect(missingFireflyField.status).toBe(400);

      const emptyFireflySecret = await put(
        "firefly",
        { clientId: "an-id", clientSecret: "" },
        LOCAL_TENANT,
      );
      expect(emptyFireflySecret.status).toBe(400);

      const emptyFireflyId = await put(
        "firefly",
        { clientId: "", clientSecret: "a-secret" },
        LOCAL_TENANT,
      );
      expect(emptyFireflyId.status).toBe(400);
    } finally {
      await harness.cleanup();
    }
  });

  test("PUT rejects a key shorter than 8 characters, whitespace-only, or over the length cap (400), and stores nothing", async () => {
    setKek();
    const harness = await setupPgHarness();
    try {
      const short = await put("gemini", { key: "abc" }, LOCAL_TENANT);
      expect(short.status).toBe(400);
      expect(await (await list(LOCAL_TENANT)).json()).toEqual([]);

      const whitespaceOnly = await put("gemini", { key: "        " }, LOCAL_TENANT);
      expect(whitespaceOnly.status).toBe(400);

      const tooLong = await put("gemini", { key: "a".repeat(4097) }, LOCAL_TENANT);
      expect(tooLong.status).toBe(400);

      // Firefly's clientId and clientSecret are held to the same bound.
      const shortFireflySecret = await put(
        "firefly",
        { clientId: "a-long-enough-client-id", clientSecret: "short" },
        LOCAL_TENANT,
      );
      expect(shortFireflySecret.status).toBe(400);

      const shortFireflyId = await put(
        "firefly",
        { clientId: "short", clientSecret: "a-long-enough-client-secret" },
        LOCAL_TENANT,
      );
      expect(shortFireflyId.status).toBe(400);

      // A valid, exactly-minimum-length key is still accepted.
      const exactlyMin = await put("gemini", { key: "12345678" }, LOCAL_TENANT);
      expect(exactlyMin.status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });

  test("GET /:provider and DELETE /:provider both reject an unknown provider (400)", async () => {
    setKek();
    const harness = await setupPgHarness();
    try {
      expect((await getOne("unknown-provider", LOCAL_TENANT)).status).toBe(400);
      expect((await del("unknown-provider", LOCAL_TENANT)).status).toBe(400);
    } finally {
      await harness.cleanup();
    }
  });

  test("GET /:provider answers 404 for a provider never registered", async () => {
    setKek();
    const harness = await setupPgHarness();
    try {
      const res = await getOne("gemini", LOCAL_TENANT);
      expect(res.status).toBe(404);
    } finally {
      await harness.cleanup();
    }
  });

  test("another org's key is invisible: 404 on GET, absent from list, and its own org's key is unaffected", async () => {
    setKek();
    const harness = await setupPgHarness();
    try {
      await put("gemini", { key: "sk-fake-local-key-9999" }, LOCAL_TENANT);

      const acmeOne = await getOne("gemini", ACME_TENANT);
      expect(acmeOne.status).toBe(404);
      expect(await (await list(ACME_TENANT)).json()).toEqual([]);

      // Acme deleting or replacing "gemini" never touches local's key.
      await del("gemini", ACME_TENANT);
      const localOne = await getOne("gemini", LOCAL_TENANT);
      expect(localOne.status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });

  test("replace then revoke: the new key lands, then nothing is left active", async () => {
    setKek();
    const harness = await setupPgHarness();
    try {
      await put("gemini", { key: "sk-fake-first-0001" }, LOCAL_TENANT);
      const replaced = await put("gemini", { key: "sk-fake-second-0002" }, LOCAL_TENANT);
      expect(((await replaced.json()) as { last4: string }).last4).toBe("0002");

      const del1 = await del("gemini", LOCAL_TENANT);
      expect(del1.status).toBe(200);
      expect((await getOne("gemini", LOCAL_TENANT)).status).toBe(404);

      // Revoking again is a no-op, not an error.
      const del2 = await del("gemini", LOCAL_TENANT);
      expect(del2.status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });

  test("PUT answers 503, naming the missing setting, with no key encryption key configured", async () => {
    restoreKek();
    delete process.env.KEY_ENCRYPTION_KEYS;
    delete process.env.KEY_ENCRYPTION_KEY_CURRENT;
    const harness = await setupPgHarness();
    try {
      const res = await put("gemini", { key: "sk-fake-key-0000" }, LOCAL_TENANT);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/KEY_ENCRYPTION_KEYS/);
      expect(body.error).not.toContain("sk-fake-key-0000");
    } finally {
      await harness.cleanup();
    }
  });

  test("PUT answers 503, not 500, when the configured KEK is malformed (wrong key length), and leaks no key material", async () => {
    restoreKek();
    const badKey = Buffer.alloc(16, 9).toString("base64"); // 16 bytes, not the required 32
    process.env.KEY_ENCRYPTION_KEYS = `v1:${badKey}`;
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "v1";
    const harness = await setupPgHarness();
    try {
      const res = await put("gemini", { key: "sk-fake-key-0000" }, LOCAL_TENANT);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).not.toContain(badKey);
      expect(body.error).not.toContain("sk-fake-key-0000");
      expect(await (await list(LOCAL_TENANT)).json()).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("no plaintext ever reaches a response body, a stored row, or the console", async () => {
    setKek();
    const secret = "sk-fake-never-leaks-1234";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = await setupPgHarness();
    try {
      const putRes = await put("gemini", { key: secret }, LOCAL_TENANT);
      const putText = JSON.stringify(await putRes.json());
      expect(putText).not.toContain(secret);

      const listText = JSON.stringify(await (await list(LOCAL_TENANT)).json());
      expect(listText).not.toContain(secret);

      const oneText = JSON.stringify(await (await getOne("gemini", LOCAL_TENANT)).json());
      expect(oneText).not.toContain(secret);

      const rows = await harness.db.query<Record<string, unknown>>("select * from provider_key");
      expect(JSON.stringify(rows.rows)).not.toContain(secret);

      for (const spy of [logSpy, warnSpy, errorSpy]) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(secret);
        }
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      await harness.cleanup();
    }
  });
});

describe("each route translates ProviderKeyUnavailableError to 503, and propagates any other error", () => {
  const fake = (overrides: Partial<ProviderKeyPort>): ProviderKeyPort => ({
    put: async () => {
      throw new Error("unexpected store failure");
    },
    list: async () => {
      throw new Error("unexpected store failure");
    },
    revoke: async () => {
      throw new Error("unexpected store failure");
    },
    open: async () => {
      throw new Error("unexpected store failure");
    },
    ...overrides,
  });

  afterEach(resetProviderKeyStore);

  test("GET (list): 503 naming what's missing on ProviderKeyUnavailableError, 500 on anything else", async () => {
    setProviderKeyStore(
      fake({
        list: async () => {
          throw new ProviderKeyUnavailableError("provider keys need STORE_BACKEND=postgres");
        },
      }),
    );
    const unavailable = await list(LOCAL_TENANT);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: "provider keys need STORE_BACKEND=postgres",
    });

    setProviderKeyStore(fake({}));
    const other = await list(LOCAL_TENANT);
    expect(other.status).toBe(500);
  });

  test("GET /:provider: 503 on ProviderKeyUnavailableError, 500 on anything else", async () => {
    setProviderKeyStore(
      fake({
        list: async () => {
          throw new ProviderKeyUnavailableError("provider keys need STORE_BACKEND=postgres");
        },
      }),
    );
    const unavailable = await getOne("gemini", LOCAL_TENANT);
    expect(unavailable.status).toBe(503);

    setProviderKeyStore(fake({}));
    const other = await getOne("gemini", LOCAL_TENANT);
    expect(other.status).toBe(500);
  });

  test("PUT: 500 (propagated), not 503, when the store fails for a reason other than no KEK", async () => {
    setProviderKeyStore(fake({}));
    const res = await put("gemini", { key: "sk-fake-key-0000" }, LOCAL_TENANT);
    expect(res.status).toBe(500);
  });

  test("PUT: 409 when the store reports a concurrent-write conflict (ProviderKeyConflictError)", async () => {
    setProviderKeyStore(
      fake({
        put: async () => {
          throw new ProviderKeyConflictError();
        },
      }),
    );
    const res = await put("gemini", { key: "sk-fake-key-0000" }, LOCAL_TENANT);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "replaced concurrently; retry" });
  });

  test("DELETE: 503 on ProviderKeyUnavailableError, 500 on anything else", async () => {
    setProviderKeyStore(
      fake({
        revoke: async () => {
          throw new ProviderKeyUnavailableError("provider keys need STORE_BACKEND=postgres");
        },
      }),
    );
    const unavailable = await del("gemini", LOCAL_TENANT);
    expect(unavailable.status).toBe(503);

    setProviderKeyStore(fake({}));
    const other = await del("gemini", LOCAL_TENANT);
    expect(other.status).toBe(500);
  });
});
