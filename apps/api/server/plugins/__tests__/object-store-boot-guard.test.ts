import { describe, test, expect, afterEach, vi } from "vitest";
import plugin from "../object-store-boot-guard.js";

/**
 * The `s3` boot guard (PT-4d). It is VALIDATION, not a probe: it reads the six
 * `S3_*` variables through `objectStoreSettings()` and refuses to boot on a
 * missing or malformed one, with no network call anywhere in this file.
 *
 * What it deliberately does NOT catch is a wrong bucket NAME, and there is a test
 * saying so — see the last one. A guard that claimed to catch it would be lying
 * in a comment, and an operator reading that comment on a broken deployment would
 * look in the wrong place.
 */

const KEYS = [
  "OBJECT_STORE",
  "STORE_BACKEND",
  "S3_ENDPOINT",
  "S3_PUBLIC_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

/** A complete, valid `s3` configuration — the thing the guard is protecting. */
function validS3Env(): void {
  process.env.OBJECT_STORE = "s3";
  process.env.STORE_BACKEND = "postgres";
  process.env.S3_ENDPOINT = "http://s3.example:8333";
  process.env.S3_PUBLIC_ENDPOINT = "https://s3.example:8333";
  process.env.S3_REGION = "us-east-1";
  process.env.S3_BUCKET = "campaigns";
  process.env.S3_ACCESS_KEY_ID = "key-id";
  process.env.S3_SECRET_ACCESS_KEY = "secret-value";
}

describe("object-store-boot-guard (PT-4d)", () => {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.restoreAllMocks();
  });

  test("refuses to boot OBJECT_STORE=s3 without STORE_BACKEND=postgres", () => {
    validS3Env();
    process.env.STORE_BACKEND = "fs";
    expect(() => plugin({} as never)).toThrow("OBJECT_STORE=s3 requires STORE_BACKEND=postgres");
  });

  test.each(KEYS.filter((key) => key.startsWith("S3_")))(
    "refuses to boot OBJECT_STORE=s3 with %s unset",
    (key) => {
      validS3Env();
      delete process.env[key];
      expect(() => plugin({} as never)).toThrow(`${key} is required when OBJECT_STORE=s3.`);
    },
  );

  test.each(KEYS.filter((key) => key.startsWith("S3_")))(
    "refuses to boot OBJECT_STORE=s3 with %s blank",
    (key) => {
      validS3Env();
      process.env[key] = "   ";
      expect(() => plugin({} as never)).toThrow(`${key} is required when OBJECT_STORE=s3.`);
    },
  );

  test("refuses to boot with an endpoint that is not a plain origin", () => {
    validS3Env();
    process.env.S3_ENDPOINT = "s3://bucket.example";
    expect(() => plugin({} as never)).toThrow(
      "S3_ENDPOINT must be a plain http(s) origin with no query, fragment or credentials when OBJECT_STORE=s3.",
    );
  });

  test("refuses to boot with credentials in the endpoint URL", () => {
    validS3Env();
    process.env.S3_PUBLIC_ENDPOINT = "https://user:pass@s3.example";
    expect(() => plugin({} as never)).toThrow("S3_PUBLIC_ENDPOINT must be a plain http(s) origin");
  });

  test("never names a value: an endpoint is a hostname and a key is a credential", () => {
    validS3Env();
    delete process.env.S3_BUCKET;
    const error = (() => {
      try {
        plugin({} as never);
        return undefined;
      } catch (thrown) {
        return thrown as Error;
      }
    })();
    expect(error?.message).toBe("S3_BUCKET is required when OBJECT_STORE=s3.");
    expect(error?.message).not.toContain("s3.example");
    expect(error?.message).not.toContain("secret-value");
  });

  test("boots fine under OBJECT_STORE=s3 with every variable set, and calls nothing", () => {
    validS3Env();
    // A boot check that reached the network would fail a rolling restart for a
    // bucket that is still starting; this is the assertion that it does not.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(() => plugin({} as never)).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns early under OBJECT_STORE=fs, whatever the S3_* variables say", () => {
    for (const key of KEYS) if (key.startsWith("S3_")) delete process.env[key];
    process.env.OBJECT_STORE = "fs";
    process.env.STORE_BACKEND = "fs";
    expect(() => plugin({} as never)).not.toThrow();
  });

  test("honest about its scope: a WRONG BUCKET NAME passes this guard", () => {
    validS3Env();
    process.env.S3_BUCKET = "no-such-bucket";
    // The failure this guard cannot catch, pinned so the claim in its docstring is
    // tested rather than asserted: `S3ObjectStore.get` maps every 404 — and
    // `NoSuchBucket` is a 404 — to `undefined`, so every input read then answers
    // ENOENT and a run fails on the brief rather than on the deployment.
    expect(() => plugin({} as never)).not.toThrow();
  });
});
