import { describe, expect, test } from "vitest";
import { ObjectExistsError } from "@campaignfoundry/CampaignOrchestration";
import type { S3Settings } from "../../config.js";
import { S3RequestError, S3ObjectStore } from "../S3ObjectStore.js";

const SETTINGS: S3Settings = {
  endpoint: "http://store.invalid:8333",
  publicEndpoint: "https://objects.example",
  region: "us-east-1",
  bucket: "campaign-foundry-test",
  accessKeyId: "app-key",
  secretAccessKey: "app-secret",
};

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

/** One canned answer, and the list of requests that were made to get it. */
interface Canned {
  readonly requests: Request[];
  readonly fetchImpl: typeof fetch;
}

/** A fetch that answers `responses` in order, recording every `Request` it is given. */
function canned(...responses: Response[]): Canned {
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

function store(options: { fetchImpl: typeof fetch; listPageSize?: number; now?: () => number }) {
  return new S3ObjectStore({
    settings: SETTINGS,
    fetchImpl: options.fetchImpl,
    listPageSize: options.listPageSize,
    now: options.now ?? (() => 1_763_000_000_000),
  });
}

describe("S3ObjectStore requests", () => {
  test("every URL is path-style, and the request is signed rather than bare", async () => {
    const { requests, fetchImpl } = canned(new Response(null, { status: 200 }));
    await store({ fetchImpl }).put("campaigns/c1/renders/hero.png", BYTES);
    const request = requests[0];
    expect(request?.url).toBe(
      "http://store.invalid:8333/campaign-foundry-test/campaigns/c1/renders/hero.png",
    );
    expect(request?.method).toBe("PUT");
    // Signed by header: an `Authorization` with a Credential scope, and no
    // signature in the query — that is the API's own request, not a presign.
    expect(request?.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=app-key\/\d{8}\/us-east-1\/s3\/aws4_request, /,
    );
    expect(request?.url).not.toContain("X-Amz-Signature");
  });

  test("put sends the content type and the bytes", async () => {
    const { requests, fetchImpl } = canned(new Response(null, { status: 200 }));
    await store({ fetchImpl }).put("campaigns/c1/renders/hero.png", BYTES, {
      contentType: "image/png",
    });
    const request = requests[0];
    expect(request?.headers.get("content-type")).toBe("image/png");
    expect(request?.headers.get("if-none-match")).toBeNull();
    expect(new Uint8Array(await request?.arrayBuffer())).toEqual(BYTES);
  });

  test("a conditional create sends If-None-Match: * and answers 200", async () => {
    const { requests, fetchImpl } = canned(new Response(null, { status: 200 }));
    await store({ fetchImpl }).put("campaigns/c1/renders/hero.png", BYTES, { ifNoneMatch: "*" });
    expect(requests[0]?.headers.get("if-none-match")).toBe("*");
  });

  test("a conditional create onto a taken key answers 412 as ObjectExistsError", async () => {
    const { fetchImpl } = canned(
      new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 }),
    );
    const error = await store({ fetchImpl })
      .put("campaigns/c1/renders/hero.png", BYTES, { ifNoneMatch: "*" })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ObjectExistsError);
    expect((error as ObjectExistsError).key).toBe("campaigns/c1/renders/hero.png");
  });

  test("get answers the bytes and the content type", async () => {
    const { fetchImpl } = canned(
      new Response(BYTES, { status: 200, headers: { "content-type": "image/png" } }),
    );
    const read = await store({ fetchImpl }).get("campaigns/c1/renders/hero.png");
    expect(read?.bytes).toEqual(BYTES);
    expect(read?.contentType).toBe("image/png");
  });

  test("get on an object the store typed as nothing reports no content type", async () => {
    const { fetchImpl } = canned(new Response(BYTES, { status: 200 }));
    const read = await store({ fetchImpl }).get("campaigns/c1/renders/hero.png");
    expect(read?.bytes).toEqual(BYTES);
    expect(read?.contentType).toBeUndefined();
  });

  test("get and head of a missing key are undefined, not an error", async () => {
    const { requests, fetchImpl } = canned(
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
      new Response(null, { status: 404 }),
    );
    const s3 = store({ fetchImpl });
    expect(await s3.get("campaigns/c1/renders/none.png")).toBeUndefined();
    expect(await s3.head("campaigns/c1/renders/none.png")).toBeUndefined();
    expect(requests.map((request) => request.method)).toEqual(["GET", "HEAD"]);
  });

  test("head reports the size, the type and an unquoted etag", async () => {
    const { fetchImpl } = canned(
      new Response(null, {
        status: 200,
        headers: {
          "content-length": "11",
          "content-type": "image/png",
          etag: '"9a0364b9e99bb480dd25e1f0284c8555"',
        },
      }),
    );
    const metadata = await store({ fetchImpl }).head("campaigns/c1/renders/hero.png");
    expect(metadata).toEqual({
      size: 11,
      contentType: "image/png",
      etag: "9a0364b9e99bb480dd25e1f0284c8555",
    });
  });

  test("head of an object the store described with no headers at all reports zeroes", async () => {
    const { fetchImpl } = canned(new Response(null, { status: 200 }));
    const metadata = await store({ fetchImpl }).head("campaigns/c1/renders/hero.png");
    expect(metadata).toEqual({ size: 0, contentType: undefined, etag: undefined });
  });

  test("delete is idempotent: 204 and 404 both leave the store without the key", async () => {
    const { requests, fetchImpl } = canned(
      new Response(null, { status: 204 }),
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
    );
    const s3 = store({ fetchImpl });
    await expect(s3.delete("campaigns/c1/renders/hero.png")).resolves.toBeUndefined();
    await expect(s3.delete("campaigns/c1/renders/hero.png")).resolves.toBeUndefined();
    expect(requests.map((request) => request.method)).toEqual(["DELETE", "DELETE"]);
  });

  test("copy sends x-amz-copy-source as /bucket/src", async () => {
    const { requests, fetchImpl } = canned(
      new Response(
        "<CopyObjectResult><ETag>&quot;9a0364b9e99bb480dd25e1f0284c8555&quot;</ETag></CopyObjectResult>",
        { status: 200 },
      ),
    );
    await store({ fetchImpl }).copy(
      "campaigns/c1/renders/hero.png",
      "campaigns/c1/renders/hero-2x.png",
    );
    const request = requests[0];
    expect(request?.method).toBe("PUT");
    expect(request?.url).toBe(
      "http://store.invalid:8333/campaign-foundry-test/campaigns/c1/renders/hero-2x.png",
    );
    expect(request?.headers.get("x-amz-copy-source")).toBe(
      "/campaign-foundry-test/campaigns/c1/renders/hero.png",
    );
  });
});

describe("S3ObjectStore failures", () => {
  test("a 403 carries the status and the body's Code, and nothing else", async () => {
    const { fetchImpl } = canned(
      new Response("<Error><Code>SignatureDoesNotMatch</Code></Error>", { status: 403 }),
    );
    const error = await store({ fetchImpl })
      .get("campaigns/c1/renders/hero.png")
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(S3RequestError);
    expect((error as S3RequestError).status).toBe(403);
    expect((error as S3RequestError).code).toBe("SignatureDoesNotMatch");
    expect((error as Error).message).toBe(
      "The object store answered 403 to get (SignatureDoesNotMatch).",
    );
  });

  test("a 500 with no Code still names the status", async () => {
    const { fetchImpl } = canned(new Response("upstream exploded", { status: 500 }));
    const error = await store({ fetchImpl })
      .delete("campaigns/c1/renders/hero.png")
      .catch((thrown: unknown) => thrown);
    expect((error as S3RequestError).status).toBe(500);
    expect((error as S3RequestError).code).toBeUndefined();
    expect((error as Error).message).toBe("The object store answered 500 to delete.");
  });

  test("a failing put, head, copy and list all refuse the same way", async () => {
    const refused = () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    for (const call of [
      (s3: S3ObjectStore) => s3.put("campaigns/c1/a.png", BYTES),
      (s3: S3ObjectStore) => s3.head("campaigns/c1/a.png"),
      (s3: S3ObjectStore) => s3.copy("campaigns/c1/a.png", "campaigns/c1/b.png"),
      (s3: S3ObjectStore) => s3.list("campaigns/c1/"),
    ]) {
      const { fetchImpl } = canned(refused());
      const error = await call(store({ fetchImpl })).catch((thrown: unknown) => thrown);
      expect((error as S3RequestError).status).toBe(403);
      expect((error as S3RequestError).code).toBe("AccessDenied");
    }
  });

  test("the adapter never retries: a 500 is one request", async () => {
    const { requests, fetchImpl } = canned(new Response("boom", { status: 503 }));
    await store({ fetchImpl })
      .get("campaigns/c1/renders/hero.png")
      .catch(() => undefined);
    expect(requests).toHaveLength(1);
  });

  test("a Buffer body is uploaded as exactly its bytes, never Node's shared pool", async () => {
    const { requests, fetchImpl } = canned(new Response(null, { status: 200 }));
    // `Buffer.prototype.slice` is `subarray`, so the copy that used to be made
    // here was a VIEW and `.buffer` on it was the whole 8 KiB pool. Nothing
    // downstream would have noticed: an S3 header-auth request is signed
    // UNSIGNED-PAYLOAD, so the store never hashes what arrived.
    await store({ fetchImpl }).put("campaigns/c1/renders/a.bin", Buffer.from([1, 2, 3]));
    const sent = await requests[0]?.arrayBuffer();
    expect(sent?.byteLength).toBe(3);
  });

  test("a transport failure is refused, naming the operation and no host", async () => {
    // undici's shape, verbatim: the real cause names the syscall AND the host,
    // and `S3_ENDPOINT` is an in-cluster address.
    const rejecting: typeof fetch = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND marker-host-7f3a.invalid"), {
          code: "ENOTFOUND",
        }),
      });
    };
    const error = await store({ fetchImpl: rejecting })
      .get("campaigns/c1/renders/hero.png")
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(S3RequestError);
    expect((error as S3RequestError).status).toBe(0);
    // The errno is a diagnosis and stays; the host is a disclosure and does not.
    expect((error as S3RequestError).code).toBe("ENOTFOUND");
    expect((error as Error).message).toBe(
      "The object store could not be reached for get (ENOTFOUND).",
    );
    expect((error as Error).message).not.toContain("marker-host-7f3a");
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  test("a page size that is not a positive integer is refused at construction", () => {
    // `max-keys=0` is a clamp in S3, not a refusal, so a zero would quietly give
    // back 1000-key pages where the caller asked for none. The fake refuses the
    // same values with the same message, because a divergence here is a
    // conformance difference the suite cannot see.
    for (const pageSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new S3ObjectStore({ settings: SETTINGS, listPageSize: pageSize })).toThrow(
        "listPageSize must be a positive integer.",
      );
    }
    expect(
      () =>
        new S3ObjectStore({
          settings: SETTINGS,
          listPageSize: 1,
          fetchImpl: async () => new Response(),
        }),
    ).not.toThrow();
  });

  test("copy reads the body, and a 200 carrying an Error is not a successful copy", async () => {
    // S3 documents this: CopyObject can answer 200 with an <Error> document,
    // because the copy is evaluated after the status line is committed. Believing
    // the status alone reports a failed copy as done.
    const { fetchImpl } = canned(
      new Response("<Error><Code>InternalError</Code><Message>we tried</Message></Error>", {
        status: 200,
      }),
    );
    const error = await store({ fetchImpl })
      .copy("campaigns/c1/a.png", "campaigns/c1/b.png")
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(S3RequestError);
    expect((error as S3RequestError).status).toBe(200);
    expect((error as S3RequestError).code).toBe("InternalError");
    expect((error as Error).message).toBe("The object store answered 200 to copy (InternalError).");
  });

  test("copy refuses a 200 whose body is neither a CopyObjectResult nor an Error", async () => {
    const { fetchImpl } = canned(new Response("<html>gateway</html>", { status: 200 }));
    await expect(
      store({ fetchImpl }).copy("campaigns/c1/a.png", "campaigns/c1/b.png"),
    ).rejects.toThrow("Refusing a 200 copy whose body is neither a CopyObjectResult nor an Error.");
  });

  test("with no injected fetch it falls back to the platform one, without calling it", async () => {
    // presignGet signs and returns; it never fetches. So this proves the default
    // was taken and is callable, with no socket opened — the alternative
    // assertion would be a live request to a host that does not exist.
    const bare = new S3ObjectStore({ settings: SETTINGS });
    expect(
      await bare.presignGet("campaigns/c1/renders/hero.png", { expiresInSeconds: 1200 }),
    ).toContain("X-Amz-Signature=");
  });

  test("every method refuses a key outside the confined shape", async () => {
    const { requests, fetchImpl } = canned(new Response(null, { status: 200 }));
    const s3 = store({ fetchImpl });
    const bad = "campaigns/../escape.png";
    await expect(s3.put(bad, BYTES)).rejects.toThrow(/Refusing an object key/);
    await expect(s3.get(bad)).rejects.toThrow(/Refusing an object key/);
    await expect(s3.head(bad)).rejects.toThrow(/Refusing an object key/);
    await expect(s3.delete(bad)).rejects.toThrow(/Refusing an object key/);
    await expect(s3.list(bad)).rejects.toThrow(/Refusing an object key/);
    await expect(s3.deletePrefix(bad)).rejects.toThrow(/Refusing an object key/);
    await expect(s3.copy(bad, "campaigns/c1/b.png")).rejects.toThrow(/Refusing an object key/);
    await expect(s3.copy("campaigns/c1/a.png", bad)).rejects.toThrow(/Refusing an object key/);
    await expect(s3.presignGet(bad, { expiresInSeconds: 60 })).rejects.toThrow(
      /Refusing an object key/,
    );
    // Refused before signing, so a bad key never becomes a signed request.
    expect(requests).toHaveLength(0);
  });
});
