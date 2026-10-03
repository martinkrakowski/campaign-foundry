import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { objectStoreSettings, type S3Settings } from "../../config.js";
import { S3ObjectStore, S3RequestError } from "../S3ObjectStore.js";

/**
 * The three values that must never reach a log, a thrown message or a `cause`
 * (brief correction C2). The key id is in here because it travels in the
 * `Authorization: … Credential=` header and in a presigned URL's
 * `X-Amz-Credential`; the host because an endpoint is internal by design and
 * names a network a log should not describe.
 */
const MARKERS = [
  "MARKER-SECRET-7f3a",
  "MARKER-KEYID-7f3a",
  "marker-host-7f3a",
  "Signature=",
] as const;

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

/** Every message in an error's `cause` chain: a credential reaches a log through any link. */
function errorChain(error: unknown, seen = new Set<unknown>()): string {
  if (typeof error === "string") return error;
  if (!(error instanceof Error) || seen.has(error)) return "";
  seen.add(error);
  const cause: unknown = (error as { cause?: unknown }).cause;
  return [error.message, errorChain(cause, seen)].filter((part) => part !== "").join(" | ");
}

/**
 * Render one console argument as text. Handles the shapes a leak actually takes:
 * a string, an `Error` with a `cause`, a `Request` (whose `url` carries the signed
 * query and whose `headers` carry the `Authorization` credential), and a plain
 * object or array of any of those.
 */
function rendered(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (value instanceof Error) return errorChain(value);
  if (depth > 4) return String(value);
  const parts: string[] = [];
  const url: unknown = (value as { url?: unknown }).url;
  if (url !== undefined) parts.push(`url=${rendered(url, depth + 1)}`);
  if (Array.isArray(value)) {
    for (const entry of value) parts.push(rendered(entry, depth + 1));
  } else {
    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
      if (name === "url") continue;
      parts.push(`${name}=${rendered(entry, depth + 1)}`);
    }
  }
  return parts.length === 0 ? String(value) : parts.join(" ");
}

/** Run every path, keeping what each one threw, and assert that each one refused. */
async function collect(
  paths: readonly (readonly [string, () => Promise<unknown>])[],
): Promise<unknown[]> {
  const thrown: unknown[] = [];
  for (const [what, call] of paths) {
    const error = await call().then(
      () => undefined,
      (rejected: unknown) => rejected,
    );
    expect(error, `${what} must refuse`).toBeInstanceOf(Error);
    thrown.push(error);
  }
  return thrown;
}

/** Answer every request with this status and body. A fresh fetch per store, so no test shares one. */
function answering(status: number, body: string): typeof fetch {
  return async () => new Response(body, { status, headers: { "content-type": "application/xml" } });
}

/** Run `objectStoreSettings()` with `name` set to `value`, and put `name` back whatever happens. */
async function withEnv(name: string, value: string | undefined): Promise<unknown> {
  const held = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return objectStoreSettings();
  } finally {
    if (held === undefined) delete process.env[name];
    else process.env[name] = held;
  }
}

/** The store under test, built from the config the marker env actually produced. */
function settings(): S3Settings {
  const resolved = objectStoreSettings();
  if (resolved === undefined) {
    throw new Error("objectStoreSettings() returned undefined while OBJECT_STORE=s3.");
  }
  return resolved;
}

beforeAll(() => {
  process.env.OBJECT_STORE = "s3";
  process.env.STORE_BACKEND = "postgres";
  process.env.S3_ENDPOINT = "http://marker-host-7f3a.invalid";
  process.env.S3_PUBLIC_ENDPOINT = "https://marker-host-7f3a.invalid";
  process.env.S3_REGION = "us-east-1";
  process.env.S3_BUCKET = "campaign-foundry-test";
  process.env.S3_ACCESS_KEY_ID = "MARKER-KEYID-7f3a";
  process.env.S3_SECRET_ACCESS_KEY = "MARKER-SECRET-7f3a";
});

afterAll(() => {
  for (const name of OBJECT_STORE_VARS) {
    if (SAVED[name] === undefined) delete process.env[name];
    else process.env[name] = SAVED[name];
  }
});

describe("the object store never echoes a credential", () => {
  test("every objectStoreSettings() error path names the variable and not the value", async () => {
    const paths: (readonly [string, () => Promise<unknown>])[] = [
      ["a missing S3_ENDPOINT", () => withEnv("S3_ENDPOINT", undefined)],
      ["a missing S3_PUBLIC_ENDPOINT", () => withEnv("S3_PUBLIC_ENDPOINT", undefined)],
      ["a missing S3_REGION", () => withEnv("S3_REGION", undefined)],
      ["a missing S3_BUCKET", () => withEnv("S3_BUCKET", undefined)],
      ["a missing S3_ACCESS_KEY_ID", () => withEnv("S3_ACCESS_KEY_ID", undefined)],
      ["a missing S3_SECRET_ACCESS_KEY", () => withEnv("S3_SECRET_ACCESS_KEY", undefined)],
      ["a relative S3_ENDPOINT", () => withEnv("S3_ENDPOINT", "not-a-url")],
      [
        "an S3_ENDPOINT with a query",
        () => withEnv("S3_ENDPOINT", "https://marker-host-7f3a.invalid?t=1"),
      ],
      [
        "an S3_ENDPOINT with credentials",
        () =>
          withEnv("S3_ENDPOINT", "https://MARKER-KEYID-7f3a:MARKER-SECRET-7f3a@objects.example"),
      ],
      ["a non-http S3_ENDPOINT", () => withEnv("S3_ENDPOINT", "s3://bucket")],
      ["a relative S3_PUBLIC_ENDPOINT", () => withEnv("S3_PUBLIC_ENDPOINT", "objects.example")],
      [
        "a non-https S3_PUBLIC_ENDPOINT",
        () => withEnv("S3_PUBLIC_ENDPOINT", "ftp://objects.example"),
      ],
      ["fs as the store backend", () => withEnv("STORE_BACKEND", "fs")],
    ];

    const thrown = await collect(paths);
    const messages = thrown.map((error) => (error as Error).message);
    for (const error of thrown) {
      for (const marker of MARKERS) {
        expect(errorChain(error)).not.toContain(marker);
      }
    }
    // They do say which variable, which is what makes them useful at all — and
    // asserted as a SET rather than by index, so adding a path above cannot
    // silently move an assertion onto a different error (which is how the
    // position-based version of this test hid a message change for a round).
    expect(new Set(messages)).toEqual(
      new Set([
        "S3_ENDPOINT is required when OBJECT_STORE=s3.",
        "S3_PUBLIC_ENDPOINT is required when OBJECT_STORE=s3.",
        "S3_REGION is required when OBJECT_STORE=s3.",
        "S3_BUCKET is required when OBJECT_STORE=s3.",
        "S3_ACCESS_KEY_ID is required when OBJECT_STORE=s3.",
        "S3_SECRET_ACCESS_KEY is required when OBJECT_STORE=s3.",
        "S3_ENDPOINT must be a plain http(s) origin with no query, fragment or credentials when OBJECT_STORE=s3.",
        "S3_PUBLIC_ENDPOINT must be a plain http(s) origin with no query, fragment or credentials when OBJECT_STORE=s3.",
        "OBJECT_STORE=s3 requires STORE_BACKEND=postgres: only Postgres knows a campaign uuid, and a render key is derived from one.",
      ]),
    );
  });

  test("every S3ObjectStore error path carries the status and never the request", async () => {
    const bodies: readonly (readonly [string, number, string])[] = [
      ["a 403 on get", 403, "<Error><Code>SignatureDoesNotMatch</Code></Error>"],
      ["a 500 on get", 500, "upstream exploded"],
      ["a 412 on a conditional put", 412, "<Error><Code>PreconditionFailed</Code></Error>"],
      ["a 403 on head", 403, ""],
      ["a 503 on delete", 503, "<Error><Code>SlowDown</Code></Error>"],
      ["a 403 on copy", 403, "<Error><Code>AccessDenied</Code></Error>"],
      ["a 403 on list", 403, "<Error><Code>AccessDenied</Code></Error>"],
      ["a 500 on deletePrefix", 500, "<Error><Code>InternalError</Code></Error>"],
    ];
    const paths = bodies.map(
      ([what, status, body], index): readonly [string, () => Promise<unknown>] => {
        const s3 = new S3ObjectStore({ settings: settings(), fetchImpl: answering(status, body) });
        const calls: readonly ((s: S3ObjectStore) => Promise<unknown>)[] = [
          (s) => s.get("campaigns/c1/renders/hero.png"),
          (s) => s.get("campaigns/c1/renders/hero.png"),
          (s) => s.put("campaigns/c1/renders/hero.png", new Uint8Array([1]), { ifNoneMatch: "*" }),
          (s) => s.head("campaigns/c1/renders/hero.png"),
          (s) => s.delete("campaigns/c1/renders/hero.png"),
          (s) => s.copy("campaigns/c1/a.png", "campaigns/c1/b.png"),
          (s) => s.list("campaigns/c1/"),
          (s) => s.deletePrefix("campaigns/c1/"),
        ];
        return [what, () => (calls[index] as (s: S3ObjectStore) => Promise<unknown>)(s3)];
      },
    );

    const thrown = await collect(paths);
    // A HEAD error has no body at all, and the 500 on get has no <Code>: both
    // must still refuse with the status alone.
    expect((thrown[1] as Error).message).toBe("The object store answered 500 to get.");
    expect((thrown[3] as Error).message).toBe("The object store answered 403 to head.");
    expect((thrown[0] as Error).message).toBe(
      "The object store answered 403 to get (SignatureDoesNotMatch).",
    );
    for (const error of thrown) {
      for (const marker of MARKERS) {
        expect(errorChain(error)).not.toContain(marker);
      }
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    }
  });

  test("a transport failure never leaks the endpoint through a cause", async () => {
    // Two rejections, because the two halves of `transportCode` are different
    // shapes: undici's real one carries `code`, and a caller-supplied fetch can
    // reject with a bare TypeError that carries nothing at all.
    const rejections: readonly unknown[] = [
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND marker-host-7f3a.invalid"), {
          code: "ENOTFOUND",
        }),
      }),
      new TypeError("fetch failed"),
    ];
    const thrown: unknown[] = [];
    for (const rejection of rejections) {
      const rejecting: typeof fetch = async () => {
        throw rejection;
      };
      const s3 = new S3ObjectStore({ settings: settings(), fetchImpl: rejecting });
      for (const call of [
        (s: S3ObjectStore) => s.get("campaigns/c1/a.png"),
        (s: S3ObjectStore) => s.put("campaigns/c1/a.png", new Uint8Array([1])),
        (s: S3ObjectStore) => s.head("campaigns/c1/a.png"),
        (s: S3ObjectStore) => s.delete("campaigns/c1/a.png"),
        (s: S3ObjectStore) => s.copy("campaigns/c1/a.png", "campaigns/c1/b.png"),
        (s: S3ObjectStore) => s.list("campaigns/c1/"),
      ]) {
        const error = await call(s3).then(
          () => undefined,
          (rejected: unknown) => rejected,
        );
        expect(error, "a rejected fetch must refuse").toBeInstanceOf(Error);
        thrown.push(error);
      }
    }
    expect(thrown).toHaveLength(rejections.length * 6);
    for (const error of thrown) {
      for (const marker of MARKERS) {
        expect(errorChain(error)).not.toContain(marker);
      }
      // The whole chain, not just the top: an unwrapped `cause` is where a host
      // survives, and `fetch failed` on its own says nothing worth hiding.
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    }
    // The one thing that does survive is the errno, and it is a field.
    expect((thrown[0] as S3RequestError).code).toBe("ENOTFOUND");
    expect((thrown[6] as S3RequestError).code).toBeUndefined();
  });

  test("no console argument carries a marker, and the detector is proved on a control", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    try {
      const s3 = new S3ObjectStore({
        settings: settings(),
        fetchImpl: answering(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>"),
      });
      for (const call of [
        (s: S3ObjectStore) => s.get("campaigns/c1/renders/hero.png"),
        (s: S3ObjectStore) => s.put("campaigns/c1/a.png", new Uint8Array([1])),
        (s: S3ObjectStore) => s.head("campaigns/c1/a.png"),
        (s: S3ObjectStore) => s.delete("campaigns/c1/a.png"),
        (s: S3ObjectStore) => s.copy("campaigns/c1/a.png", "campaigns/c1/b.png"),
        (s: S3ObjectStore) => s.list("campaigns/c1/"),
        (s: S3ObjectStore) => s.deletePrefix("campaigns/c1/"),
      ]) {
        await call(s3).catch(() => undefined);
      }
      // The one place a credential belongs is the URL the caller asked for, so
      // it is asserted here — and never near an error.
      const presigned = await s3.presignGet("campaigns/c1/a.png", { expiresInSeconds: 1200 });
      expect(presigned).toContain("X-Amz-Signature=");
      expect(presigned).toContain("MARKER-KEYID-7f3a");

      const said = spies.flatMap((spy) =>
        spy.mock.calls.map((args) => args.map((arg) => rendered(arg)).join(" ")),
      );
      for (const line of said) {
        for (const marker of MARKERS) {
          expect(line).not.toContain(marker);
        }
      }

      // The control: without it, `said` being empty would make the loop above
      // prove nothing, and a spy that stopped recording would read as clean.
      const control = await s3.get("campaigns/c1/renders/hero.png").then(
        () => new Error("unreachable"),
        (error: unknown) => error,
      );
      console.error(control, { request: { url: presigned, headers: { authorization: "sig" } } });
      const after = spies
        .flatMap((spy) => spy.mock.calls.map((args) => args.map((arg) => rendered(arg)).join(" ")))
        .slice(said.length);
      expect(after.join("\n")).toContain("The object store answered 403 to get");
      expect(after.join("\n")).toContain("X-Amz-Signature=");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
