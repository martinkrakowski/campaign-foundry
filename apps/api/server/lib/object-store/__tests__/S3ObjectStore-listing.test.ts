import { describe, expect, test } from "vitest";
import type { S3Settings } from "../../config.js";
import { S3ObjectStore } from "../S3ObjectStore.js";

/** A trailing slash on the endpoints, so the paths below prove they are stripped. */
const SETTINGS: S3Settings = {
  endpoint: "http://store.invalid:8333/",
  publicEndpoint: "https://objects.example/",
  region: "us-east-1",
  bucket: "campaign-foundry-test",
  accessKeyId: "app-key",
  secretAccessKey: "app-secret",
};

/** 2025-11-13T02:13:20Z, and the same instant 21 minutes earlier. */
const NOW = 1_763_000_000_000;

function xmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
}

function canned(...responses: Response[]): { requests: Request[]; fetchImpl: typeof fetch } {
  const requests: Request[] = [];
  let index = 0;
  const fetchImpl: typeof fetch = async (input) => {
    requests.push(input as Request);
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (response === undefined) throw new Error("canned fetch ran out of responses");
    return response.clone();
  };
  return { requests, fetchImpl };
}

function result(...parts: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${parts.join("")}</ListBucketResult>`;
}

function entry(key: string, size: number, etag?: string): string {
  return [
    "<Contents>",
    `<Key>${key}</Key>`,
    `<Size>${size}</Size>`,
    etag === undefined ? "" : `<ETag>&quot;${etag}&quot;</ETag>`,
    "<LastModified>2026-10-03T09:00:00.000Z</LastModified>",
    "</Contents>",
  ].join("");
}

function store(fetchImpl: typeof fetch, listPageSize?: number): S3ObjectStore {
  return new S3ObjectStore({ settings: SETTINGS, fetchImpl, listPageSize, now: () => NOW });
}

describe("S3ObjectStore.list", () => {
  test("one page: the request names list-type 2, the prefix and max-keys", async () => {
    const { requests, fetchImpl } = canned(
      xmlResponse(
        result(entry("campaigns/c1/renders/a.png", 11, "aaa"), "<IsTruncated>false</IsTruncated>"),
      ),
    );
    const listed = await store(fetchImpl, 2).list("campaigns/c1/renders/");
    expect(listed).toEqual([
      {
        key: "campaigns/c1/renders/a.png",
        size: 11,
        etag: "aaa",
        lastModified: new Date("2026-10-03T09:00:00.000Z"),
      },
    ]);
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe("/campaign-foundry-test");
    expect(url.searchParams.get("list-type")).toBe("2");
    expect(url.searchParams.get("prefix")).toBe("campaigns/c1/renders/");
    expect(url.searchParams.get("max-keys")).toBe("2");
    expect(url.searchParams.get("continuation-token")).toBeNull();
  });

  test("max-keys defaults to S3's own ceiling of 1000", async () => {
    const { requests, fetchImpl } = canned(xmlResponse(result("<IsTruncated>false</IsTruncated>")));
    await store(fetchImpl).list("campaigns/c1/");
    expect(new URL(requests[0]?.url ?? "").searchParams.get("max-keys")).toBe("1000");
  });

  test("a second page is fetched with the store's own continuation token", async () => {
    const { requests, fetchImpl } = canned(
      xmlResponse(
        result(
          entry("campaigns/c1/renders/a.png", 1),
          entry("campaigns/c1/renders/b.png", 2),
          "<IsTruncated>true</IsTruncated>",
          "<NextContinuationToken>1/tok+en=</NextContinuationToken>",
        ),
      ),
      xmlResponse(
        result(entry("campaigns/c1/renders/c.png", 3), "<IsTruncated>false</IsTruncated>"),
      ),
    );
    const listed = await store(fetchImpl, 2).list("campaigns/c1/renders/");
    expect(listed.map((found) => found.key)).toEqual([
      "campaigns/c1/renders/a.png",
      "campaigns/c1/renders/b.png",
      "campaigns/c1/renders/c.png",
    ]);
    expect(requests).toHaveLength(2);
    // The token is a store-chosen opaque string, so it is signed verbatim.
    expect(new URL(requests[1]?.url ?? "").searchParams.get("continuation-token")).toBe(
      "1/tok+en=",
    );
  });

  test("a body with no IsTruncated and no Contents ends after one page", async () => {
    const { requests, fetchImpl } = canned(xmlResponse(result()));
    expect(await store(fetchImpl).list("campaigns/c1/")).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  test("entity-encoded text is decoded, and an unknown entity is left as written", async () => {
    const { fetchImpl } = canned(
      xmlResponse(
        result(
          // `&nbsp;` and `&toString;` are written RAW here on purpose: the first
          // is an entity this parser does not define and the second names an
          // INHERITED Object property, so both must survive untouched. Escaping
          // them (`&amp;nbsp;`) would have tested the opposite — a known entity
          // followed by literal text — which is how the first cut of this test
          // passed while leaving the unknown-entity branch uncovered.
          "<Contents><Key>a&amp;b&lt;c&gt;d&quot;e&apos;f&#71;&#x48;&nbsp;&toString;</Key><Size>5</Size><LastModified>2026-10-03T09:00:00.000Z</LastModified></Contents>",
          "<IsTruncated>false</IsTruncated>",
        ),
      ),
    );
    const listed = await store(fetchImpl).list("campaigns/c1/");
    // Every predefined entity, both numeric forms, and no ETag — which is what
    // covers the unquoted-etag branch honestly too.
    expect(listed).toEqual([
      {
        key: `a&b<c>d"e'fGH&nbsp;&toString;`,
        size: 5,
        etag: undefined,
        lastModified: new Date("2026-10-03T09:00:00.000Z"),
      },
    ]);
  });

  test("a body that declares a DOCTYPE or an entity is refused before it is parsed", async () => {
    for (const body of [
      `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "y">]><ListBucketResult/>`,
      `<?xml version="1.0"?><!ENTITY lol "lol"><ListBucketResult/>`,
    ]) {
      const { fetchImpl } = canned(xmlResponse(body));
      await expect(store(fetchImpl).list("campaigns/c1/")).rejects.toThrow(
        /Refusing a listing that declares a DOCTYPE or an XML entity/,
      );
    }
  });

  test("a character reference past U+10FFFF is refused, not a bare RangeError", async () => {
    // `String.fromCodePoint` throws a RangeError for all three of these, and that
    // RangeError would otherwise surface out of `list()` naming nothing about a
    // listing. The 400-digit one parses to `Infinity`, which is how the
    // `Number.isInteger` half of the guard earns its place.
    for (const reference of ["&#x110000;", "&#1114112;", `&#${"9".repeat(400)};`]) {
      const { fetchImpl } = canned(
        xmlResponse(
          result(
            `<Contents><Key>a${reference}b</Key><Size>1</Size><LastModified>2026-10-03T09:00:00.000Z</LastModified></Contents>`,
            "<IsTruncated>false</IsTruncated>",
          ),
        ),
      );
      await expect(store(fetchImpl).list("campaigns/c1/")).rejects.toThrow(
        "Refusing a listing with an out-of-range character reference.",
      );
    }
    // The last code point itself is still fine, so the guard is a bound and not a ban.
    const { fetchImpl } = canned(
      xmlResponse(
        result(
          "<Contents><Key>a&#x10FFFF;b</Key><Size>1</Size><LastModified>2026-10-03T09:00:00.000Z</LastModified></Contents>",
          "<IsTruncated>false</IsTruncated>",
        ),
      ),
    );
    expect((await store(fetchImpl).list("campaigns/c1/"))[0]?.key).toBe("a\u{10FFFF}b");
  });

  test("a Size that is not a whole number of bytes is refused", async () => {
    // `Number("seven")` is NaN and would travel on as an ordinary-looking size:
    // a caller summing sizes gets NaN and never notices where it started.
    for (const size of ["seven", "-5", "1.5", "1e3", " 11", ""]) {
      const { fetchImpl } = canned(
        xmlResponse(
          result(
            `<Contents><Key>campaigns/c1/a.png</Key><Size>${size}</Size><LastModified>2026-10-03T09:00:00.000Z</LastModified></Contents>`,
            "<IsTruncated>false</IsTruncated>",
          ),
        ),
      );
      await expect(store(fetchImpl).list("campaigns/c1/")).rejects.toThrow(
        "Refusing a listing entry whose Size is not a whole number of bytes.",
      );
    }
    // Past the safe-integer ceiling `^\d+$` still passes, so the bound needs its
    // own check: `Number("999…9")` is a number, and an unsafe one.
    const { fetchImpl } = canned(
      xmlResponse(
        result(
          `<Contents><Key>campaigns/c1/a.png</Key><Size>${"9".repeat(20)}</Size><LastModified>2026-10-03T09:00:00.000Z</LastModified></Contents>`,
          "<IsTruncated>false</IsTruncated>",
        ),
      ),
    );
    await expect(store(fetchImpl).list("campaigns/c1/")).rejects.toThrow(
      "Refusing a listing entry whose Size is not a safe whole number of bytes.",
    );
  });

  test("a LastModified that is not a date is refused", async () => {
    // `new Date("whenever")` is an Invalid Date, and every comparison against one
    // is false — so a listing sorted by lastModified would be ordered by nothing.
    const { fetchImpl } = canned(
      xmlResponse(
        result(
          "<Contents><Key>campaigns/c1/a.png</Key><Size>11</Size><LastModified>whenever</LastModified></Contents>",
          "<IsTruncated>false</IsTruncated>",
        ),
      ),
    );
    await expect(store(fetchImpl).list("campaigns/c1/")).rejects.toThrow(
      "Refusing a listing entry whose LastModified is not a date.",
    );
  });

  test("deletePrefix validates the whole listing BEFORE deleting any of it", async () => {
    // A key from the store is not a key this adapter wrote: a proxy, a replication
    // target or a second writer can put one under the prefix that the alphabet
    // refuses. A loop that validated and deleted as it went would leave the
    // prefix half-erased; this one deletes nothing at all.
    const { requests, fetchImpl } = canned(
      xmlResponse(
        result(
          entry("campaigns/c1/renders/a.png", 1),
          "<Contents><Key>campaigns/c1/renders/od d.png</Key><Size>1</Size><LastModified>2026-10-03T09:00:00.000Z</LastModified></Contents>",
          "<IsTruncated>false</IsTruncated>",
        ),
      ),
      new Response(null, { status: 204 }),
    );
    const error = await store(fetchImpl)
      .deletePrefix("campaigns/c1/renders/")
      .catch((thrown: unknown) => thrown);
    expect((error as Error).message).toBe(
      "The listing under this prefix contains a key outside the allowed alphabet; nothing was deleted.",
    );
    // Neither the odd key nor the prefix is named, and not one DELETE was sent.
    expect((error as Error).message).not.toContain("od d.png");
    expect((error as Error).message).not.toContain("campaigns/c1/renders/");
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
  });

  test("a Contents block with no Key, Size or LastModified is refused", async () => {
    const { fetchImpl } = canned(xmlResponse(result("<Contents><Size>5</Size></Contents>")));
    await expect(store(fetchImpl).list("campaigns/c1/")).rejects.toThrow(
      /Refusing a listing entry with no Key, Size or LastModified/,
    );
  });

  test("a truncated body with no NextContinuationToken is refused", async () => {
    const { fetchImpl } = canned(
      xmlResponse(result(entry("campaigns/c1/a.png", 1), "<IsTruncated>true</IsTruncated>")),
    );
    await expect(store(fetchImpl).list("campaigns/c1/")).rejects.toThrow(
      /Refusing a truncated listing with no NextContinuationToken/,
    );
  });

  test("deletePrefix lists first, then issues one DELETE per key it found", async () => {
    const { requests, fetchImpl } = canned(
      xmlResponse(
        result(
          entry("campaigns/c1/renders/a.png", 1),
          entry("campaigns/c1/renders/b.png", 2),
          "<IsTruncated>false</IsTruncated>",
        ),
      ),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    );
    await store(fetchImpl).deletePrefix("campaigns/c1/renders/");
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        "GET /campaign-foundry-test",
        "DELETE /campaign-foundry-test/campaigns/c1/renders/a.png",
        "DELETE /campaign-foundry-test/campaigns/c1/renders/b.png",
      ],
    );
  });
});

describe("S3ObjectStore.presignGet", () => {
  test("the URL is on the PUBLIC endpoint and carries the window and the signature", async () => {
    const { requests, fetchImpl } = canned(xmlResponse(result("<IsTruncated>false</IsTruncated>")));
    const url = new URL(
      await store(fetchImpl).presignGet("campaigns/c1/renders/hero.png", {
        expiresInSeconds: 1200,
        now: NOW,
      }),
    );
    expect(url.host).toBe("objects.example");
    expect(url.pathname).toBe("/campaign-foundry-test/campaigns/c1/renders/hero.png");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("1200");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20251113T021320Z");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // Signed for a read by the app key, and for no other service or region.
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "app-key/20251113/us-east-1/s3/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    // Nothing was sent: a presign is a signature, not a request.
    expect(requests).toHaveLength(0);
    expect(url.searchParams.get("response-content-disposition")).toBeNull();
  });

  test("the response-content-* parameters are on the URL before it is signed", async () => {
    const { fetchImpl } = canned(xmlResponse(result("<IsTruncated>false</IsTruncated>")));
    const url = new URL(
      await store(fetchImpl).presignGet("campaigns/c1/renders/hero.png", {
        expiresInSeconds: 1200,
        now: NOW,
        responseContentDisposition: 'attachment; filename="hero.png"',
        responseContentType: "image/png",
      }),
    );
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="hero.png"',
    );
    expect(url.searchParams.get("response-content-type")).toBe("image/png");
    // Signed with them present: the canonical query is what the signature covers,
    // so a signature made without them would not verify.
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the store's own clock is used when the caller passes no now", async () => {
    const { fetchImpl } = canned(xmlResponse(result("<IsTruncated>false</IsTruncated>")));
    const s3 = store(fetchImpl);
    const fromClock = new URL(
      await s3.presignGet("campaigns/c1/a.png", { expiresInSeconds: 60 }),
    ).searchParams.get("X-Amz-Signature");
    const explicit = new URL(
      await s3.presignGet("campaigns/c1/a.png", { expiresInSeconds: 60, now: NOW }),
    ).searchParams.get("X-Amz-Signature");
    expect(fromClock).toBe(explicit);
  });

  test("an explicit now of 21 minutes ago signs a window that has already closed", async () => {
    const { fetchImpl } = canned(xmlResponse(result("<IsTruncated>false</IsTruncated>")));
    const url = new URL(
      await store(fetchImpl).presignGet("campaigns/c1/a.png", {
        expiresInSeconds: 1200,
        now: NOW - 21 * 60 * 1000,
      }),
    );
    expect(url.searchParams.get("X-Amz-Date")).toBe("20251113T015220Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("1200");
  });
});
