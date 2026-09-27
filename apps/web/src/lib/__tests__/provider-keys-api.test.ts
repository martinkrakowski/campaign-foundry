import { describe, test, expect, vi, afterEach } from "vitest";
import {
  isProvider,
  isProviderKeysApiError,
  listProviderKeys,
  ProviderKeysApiError,
  revokeProviderKey,
  setProviderKey,
} from "../provider-keys-api";
import { NoMembershipError } from "../auth-errors";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const mockFetch = (
  handler: (url: string, init?: RequestInit) => Response | Promise<Response> | never,
) => {
  vi.mocked(globalThis.fetch).mockImplementation((url, init) =>
    Promise.resolve(handler(String(url), init)),
  );
};

describe("provider-keys-api", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("type guards and errors", () => {
    test("isProvider returns true only for known providers", () => {
      expect(isProvider("gemini")).toBe(true);
      expect(isProvider("openrouter")).toBe(true);
      expect(isProvider("firefly")).toBe(true);
      expect(isProvider("openai")).toBe(false);
      expect(isProvider(null)).toBe(false);
      expect(isProvider(123)).toBe(false);
    });

    test("isProviderKeysApiError identifies error instances", () => {
      const err = new ProviderKeysApiError("fail", 400);
      expect(isProviderKeysApiError(err)).toBe(true);
      expect(err.name).toBe("ProviderKeysApiError");
      expect(err.status).toBe(400);
      expect(isProviderKeysApiError(new Error("fail"))).toBe(false);
      expect(isProviderKeysApiError(null)).toBe(false);
    });
  });

  describe("listProviderKeys", () => {
    test("reads the list route and returns summaries", async () => {
      const calledUrls: string[] = [];
      mockFetch((url) => {
        calledUrls.push(url);
        return json([{ provider: "gemini", last4: "1234", createdAt: "2026-09-27T00:00:00.000Z" }]);
      });

      const list = await listProviderKeys();
      expect(calledUrls).toEqual(["/api/pipeline/campaigns/provider-keys"]);
      expect(list).toEqual([
        { provider: "gemini", last4: "1234", createdAt: "2026-09-27T00:00:00.000Z" },
      ]);
    });

    test("returns empty array when no keys are registered", async () => {
      mockFetch(() => json([]));
      await expect(listProviderKeys()).resolves.toEqual([]);
    });

    test("rejects with 503 message on file backend ('needs Postgres')", async () => {
      mockFetch(() =>
        json(
          {
            error:
              "Org provider keys need STORE_BACKEND=postgres: BYOK is Postgres-only, as Better Auth already is.",
          },
          503,
        ),
      );

      await expect(listProviderKeys()).rejects.toMatchObject({
        name: "ProviderKeysApiError",
        status: 503,
        message:
          "Org provider keys need STORE_BACKEND=postgres: BYOK is Postgres-only, as Better Auth already is.",
      });
    });

    test("rejects with fallback 503 message when error message is omitted", async () => {
      mockFetch(() => new Response("", { status: 503 }));
      await expect(listProviderKeys()).rejects.toMatchObject({
        status: 503,
        message: "Provider keys are currently unavailable.",
      });
    });

    test("rejects with fallback message for arbitrary status code", async () => {
      mockFetch(() => new Response("", { status: 502 }));
      await expect(listProviderKeys()).rejects.toMatchObject({
        status: 502,
        message: "Request failed (HTTP 502)",
      });
    });

    test("rejects with fallback message when the body is malformed JSON", async () => {
      mockFetch(() => new Response("not json{", { status: 502 }));
      await expect(listProviderKeys()).rejects.toMatchObject({
        status: 502,
        message: "Request failed (HTTP 502)",
      });
    });

    test("rejects when response body is not an array", async () => {
      mockFetch(() => json({ not: "an array" }));
      await expect(listProviderKeys()).rejects.toMatchObject({
        status: 500,
        message: "Invalid provider keys response",
      });
    });

    test("rejects with status 0 on fetch network failure", async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("offline"));
      await expect(listProviderKeys()).rejects.toMatchObject({
        status: 0,
        message: "Network error",
      });
    });

    test("rejects with response status when response stream fails", async () => {
      mockFetch(
        () =>
          ({
            ok: true,
            status: 200,
            text: () => Promise.reject(new Error("stream closed")),
          }) as unknown as Response,
      );

      await expect(listProviderKeys()).rejects.toMatchObject({
        status: 200,
        message: "Network error",
      });
    });

    test("redirects on 401 unauthenticated", async () => {
      const assign = vi.fn();
      window.location.assign = assign;
      mockFetch(() => json({ code: "unauthenticated" }, 401));

      try {
        await listProviderKeys();
        expect.unreachable();
      } catch (err) {
        expect(isProviderKeysApiError(err)).toBe(true);
        expect(assign).toHaveBeenCalledWith("/sign-in");
      }
    });

    test("throws NoMembershipError on 403 no_membership", async () => {
      mockFetch(() => json({ code: "no_membership", error: "No org" }, 403));
      await expect(listProviderKeys()).rejects.toThrow(NoMembershipError);
    });
  });

  describe("setProviderKey", () => {
    test("sends PUT with { key } for gemini and returns summary", async () => {
      let requestMethod = "";
      let requestBody = "";
      mockFetch((url, init) => {
        requestMethod = init?.method ?? "";
        requestBody = String(init?.body);
        return json({
          provider: "gemini",
          last4: "abcd",
          createdAt: "2026-09-27T01:00:00.000Z",
        });
      });

      const res = await setProviderKey("gemini", { key: "secret-key-1234-abcd" });
      expect(requestMethod).toBe("PUT");
      expect(JSON.parse(requestBody)).toEqual({ key: "secret-key-1234-abcd" });
      expect(res).toEqual({
        provider: "gemini",
        last4: "abcd",
        createdAt: "2026-09-27T01:00:00.000Z",
      });
    });

    test("sends PUT with { clientId, clientSecret } for firefly", async () => {
      let requestBody = "";
      mockFetch((url, init) => {
        requestBody = String(init?.body);
        return json({
          provider: "firefly",
          last4: "efgh",
          createdAt: "2026-09-27T01:00:00.000Z",
        });
      });

      const res = await setProviderKey("firefly", {
        clientId: "firefly-client-id",
        clientSecret: "firefly-secret-efgh",
      });
      expect(JSON.parse(requestBody)).toEqual({
        clientId: "firefly-client-id",
        clientSecret: "firefly-secret-efgh",
      });
      expect(res.last4).toBe("efgh");
    });

    test("rejects with 400 and API error message for invalid key payload", async () => {
      mockFetch(() => json({ error: "Provide { key }, 8-4096 characters." }, 400));
      await expect(setProviderKey("gemini", { key: "short" })).rejects.toMatchObject({
        status: 400,
        message: "Provide { key }, 8-4096 characters.",
      });
    });

    test("rejects with fallback 400 message when error string is empty", async () => {
      mockFetch(() => json({ error: "" }, 400));
      await expect(setProviderKey("gemini", { key: "short" })).rejects.toMatchObject({
        status: 400,
        message: "Invalid provider key payload.",
      });
    });

    test("rejects with 403 when caller is not owner or admin", async () => {
      mockFetch(() => json({ error: "Only an owner or admin may manage provider keys." }, 403));
      await expect(setProviderKey("gemini", { key: "secret-key-1234" })).rejects.toMatchObject({
        status: 403,
        message: "Only an owner or admin may manage provider keys.",
      });
    });

    test("rejects with fallback 403 message when error message is omitted", async () => {
      mockFetch(() => new Response("", { status: 403 }));
      await expect(setProviderKey("gemini", { key: "secret-key-1234" })).rejects.toMatchObject({
        status: 403,
        message: "Only an owner or admin may manage provider keys.",
      });
    });

    test("rejects with 409 when concurrent update conflict occurs", async () => {
      mockFetch(() => json({ error: "replaced concurrently; retry" }, 409));
      await expect(setProviderKey("openrouter", { key: "secret-key-1234" })).rejects.toMatchObject({
        status: 409,
        message: "replaced concurrently; retry",
      });
    });

    test("rejects with fallback 409 message when error message is omitted", async () => {
      mockFetch(() => new Response("", { status: 409 }));
      await expect(setProviderKey("openrouter", { key: "secret-key-1234" })).rejects.toMatchObject({
        status: 409,
        message: "Provider key was replaced concurrently; retry.",
      });
    });

    test("rejects with 503 when KEK is not configured", async () => {
      mockFetch(() =>
        json(
          {
            error: "KEY_ENCRYPTION_KEYS is not set: org provider keys cannot be sealed or opened.",
          },
          503,
        ),
      );
      await expect(setProviderKey("gemini", { key: "secret-key-1234" })).rejects.toMatchObject({
        status: 503,
        message: "KEY_ENCRYPTION_KEYS is not set: org provider keys cannot be sealed or opened.",
      });
    });
  });

  describe("revokeProviderKey", () => {
    test("sends DELETE to provider endpoint and resolves on success", async () => {
      let requestMethod = "";
      let requestedUrl = "";
      mockFetch((url, init) => {
        requestedUrl = url;
        requestMethod = init?.method ?? "";
        return json({ revoked: true });
      });

      await revokeProviderKey("gemini");
      expect(requestedUrl).toBe("/api/pipeline/campaigns/provider-keys/gemini");
      expect(requestMethod).toBe("DELETE");
    });

    test("rejects with 403 when caller is not owner or admin", async () => {
      mockFetch(() => json({ error: "Only an owner or admin may manage provider keys." }, 403));
      await expect(revokeProviderKey("firefly")).rejects.toMatchObject({
        status: 403,
        message: "Only an owner or admin may manage provider keys.",
      });
    });

    test("rejects with 503 when store is unavailable", async () => {
      mockFetch(() => json({ error: "BYOK needs Postgres" }, 503));
      await expect(revokeProviderKey("openrouter")).rejects.toMatchObject({
        status: 503,
        message: "BYOK needs Postgres",
      });
    });
  });
});
