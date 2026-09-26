import { describe, test, expect } from "vitest";
import type { TenantContext } from "../../tenant.js";
import {
  canManageProviderKeys,
  encodeFireflyPlaintext,
  isProvider,
  last4Of,
  ProviderKeyUnavailableError,
} from "../provider-key.port.js";

describe("isProvider (PT-7b2)", () => {
  test("accepts each provider the migration checks for", () => {
    expect(isProvider("gemini")).toBe(true);
    expect(isProvider("openrouter")).toBe(true);
    expect(isProvider("firefly")).toBe(true);
  });

  test("rejects an unknown provider, a non-string, and undefined", () => {
    expect(isProvider("unknown")).toBe(false);
    expect(isProvider(42)).toBe(false);
    expect(isProvider(undefined)).toBe(false);
  });
});

describe("canManageProviderKeys (PT-7b2)", () => {
  const tenant = (roles: string[]): TenantContext => ({
    orgId: "local",
    userId: "u1",
    roles,
    teamIds: [],
  });

  test("owner and admin may manage keys", () => {
    expect(canManageProviderKeys(tenant(["owner"]))).toBe(true);
    expect(canManageProviderKeys(tenant(["admin"]))).toBe(true);
  });

  test("a plain member may not", () => {
    expect(canManageProviderKeys(tenant(["member"]))).toBe(false);
    expect(canManageProviderKeys(tenant([]))).toBe(false);
  });
});

describe("last4Of (PT-7b2)", () => {
  test("gemini and openrouter: the last 4 characters of the plaintext key", () => {
    expect(last4Of("gemini", "sk-fake-key-abcd")).toBe("abcd");
    expect(last4Of("openrouter", "sk-fake-key-wxyz")).toBe("wxyz");
  });

  test("firefly: the last 4 characters of clientSecret, not the encoded JSON", () => {
    const plaintext = encodeFireflyPlaintext("fake-client-id", "fake-client-secret");
    expect(plaintext.endsWith('"}')).toBe(true);
    expect(last4Of("firefly", plaintext)).toBe("cret");
  });
});

describe("ProviderKeyUnavailableError (PT-7b2)", () => {
  test("carries a 503 status and the message it was given", () => {
    const error = new ProviderKeyUnavailableError("KEY_ENCRYPTION_KEYS is not set.");
    expect(error.statusCode).toBe(503);
    expect(error.status).toBe(503);
    expect(error.message).toBe("KEY_ENCRYPTION_KEYS is not set.");
    expect(error.name).toBe("ProviderKeyUnavailableError");
  });
});
