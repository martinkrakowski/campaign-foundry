import { describe, test, expect, vi, afterEach } from "vitest";
import { resetProviderKeyStore } from "../../../../lib/ports/index.js";
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
  // The shared registry (lib/ports/index.ts) caches a PgProviderKeyStore per
  // org id; the harness's own resetAllStores() (tenant-harness.ts, not owned
  // by this lane) does not know this slot exists, so a stale store bound to
  // the previous test's now-closed PGlite instance would otherwise survive.
  afterEach(() => {
    restoreKek();
    resetProviderKeyStore();
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
