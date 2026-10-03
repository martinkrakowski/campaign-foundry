import { AwsClient } from "aws4fetch";
import {
  assertObjectKey,
  ObjectExistsError,
  OBJECT_KEY_PATTERN,
  type ListedObject,
  type ObjectContent,
  type ObjectKey,
  type ObjectMetadata,
  type ObjectStorePort,
  type PresignGetOptions,
  type PutObjectOptions,
} from "@campaignfoundry/CampaignOrchestration";
import { parseListObjectsV2 } from "./list-objects-v2.js";
import type { S3Settings } from "../config.js";

/** S3's own `max-keys` ceiling, sent as the page size of every listing. */
const DEFAULT_LIST_PAGE_SIZE = 1000;

/**
 * `listPageSize` has to be a positive integer, and this is the one message both
 * adapters use for it: the page size is how the two are held to the same
 * conformance, so a refusal that differs between them is a refusal one of them
 * does not make. A zero would be sent as `max-keys=0`, which S3 treats as a
 * clamp to the default — a silent 1000-key page where the caller asked for none.
 */
const LIST_PAGE_SIZE_PROBLEM = "listPageSize must be a positive integer.";

/** A non-2xx the store did not already map onto `undefined` or `ObjectExistsError`. */
export class S3RequestError extends Error {
  readonly status: number;
  /** The body's `<Code>`, or the errno code when the store was never reached. */
  readonly code?: string;

  constructor(operation: string, status: number, code?: string) {
    super(
      // Status 0 is the one status that never came from the store: the transport
      // failed first, so there is nothing to answer with but the operation.
      status === 0
        ? `The object store could not be reached for ${operation}${code === undefined ? "" : ` (${code})`}.`
        : `The object store answered ${status} to ${operation}${code === undefined ? "" : ` (${code})`}.`,
    );
    this.name = "S3RequestError";
    this.status = status;
    this.code = code;
  }
}

export interface S3ObjectStoreOptions {
  readonly settings: S3Settings;
  /**
   * The fetch every request goes through. `AwsClient.fetch` is never used: it
   * calls the GLOBAL fetch and retries any status ≥ 500 or 429 up to ten times
   * with a random backoff, so an injected fetch would be impossible and a
   * single failing call would hang for the better part of a minute.
   */
  readonly fetchImpl?: typeof fetch;
  /** `max-keys` per ListObjectsV2 page; `list` joins the pages. */
  readonly listPageSize?: number;
  /** The clock `presignGet` signs from. Injected so D204's windows are testable. */
  readonly now?: () => number;
}

/**
 * `ObjectStorePort` against an S3-compatible store on aws4fetch (PT-4a, D201,
 * D202). The only place `aws4fetch` is imported, the `pg`-behind-`SqlClient`
 * precedent: the signing library stays behind this adapter and no caller sees a
 * URL, a header or a status code.
 *
 * URLs are path-style — `${S3_ENDPOINT}/${bucket}/${key}` — because every store
 * this project has run against (SeaweedFS on midnight, Backblaze B2's S3 API, a
 * cloud bucket) is addressed by hostname plus path, and a virtual-host style
 * request would need a per-bucket DNS name that a self-hosted store has no way
 * to be given.
 *
 * **Nothing here ever puts the endpoint, a header or a signature into an error.**
 * A thrown message names the operation and the status; a `cause` chain is never
 * attached, because the `Request` this adapter hands to `fetch` carries the
 * `Authorization` header and the signed URL. The never-echo test is what keeps
 * that true, and the mutation that echoes the URL is what keeps the test.
 */
export class S3ObjectStore implements ObjectStorePort {
  private readonly client: AwsClient;
  private readonly fetchImpl: typeof fetch;
  private readonly listPageSize: number;
  private readonly now: () => number;
  private readonly endpoint: string;
  private readonly publicEndpoint: string;
  private readonly bucket: string;

  constructor(options: S3ObjectStoreOptions) {
    const { settings } = options;
    this.client = new AwsClient({
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      region: settings.region,
      service: "s3",
    });
    // `fetch` unbound, exactly as `resend-mailer.ts` names its default: Node's
    // is a plain function, and naming it is what keeps the injected branch the
    // only one this file ever has.
    this.fetchImpl = options.fetchImpl ?? fetch;
    const pageSize = options.listPageSize ?? DEFAULT_LIST_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new Error(LIST_PAGE_SIZE_PROBLEM);
    }
    this.listPageSize = pageSize;
    this.now = options.now ?? (() => Date.now());
    this.endpoint = settings.endpoint.replace(/\/+$/, "");
    this.publicEndpoint = settings.publicEndpoint.replace(/\/+$/, "");
    this.bucket = settings.bucket;
  }

  async put(key: ObjectKey, bytes: Uint8Array, options: PutObjectOptions = {}): Promise<void> {
    assertObjectKey(key);
    const headers: Record<string, string> = {};
    if (options.contentType !== undefined) headers["Content-Type"] = options.contentType;
    if (options.ifNoneMatch !== undefined) headers["If-None-Match"] = options.ifNoneMatch;
    // `send` makes the exact-size copy; see the note on the body there.
    const response = await this.send("put", this.objectUrl(key), "PUT", headers, bytes);
    if (response.status === 412) {
      // Drained before the throw so the connection goes back to the pool; a
      // `cancel()` on an unread body is not the same promise everywhere.
      await response.arrayBuffer();
      throw new ObjectExistsError(key);
    }
    if (!response.ok) await this.fail("put", response);
  }

  async get(key: ObjectKey): Promise<ObjectContent | undefined> {
    assertObjectKey(key);
    const response = await this.send("get", this.objectUrl(key), "GET", {});
    if (response.status === 404) return undefined;
    if (!response.ok) await this.fail("get", response);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? undefined,
    };
  }

  async head(key: ObjectKey): Promise<ObjectMetadata | undefined> {
    assertObjectKey(key);
    const response = await this.send("head", this.objectUrl(key), "HEAD", {});
    if (response.status === 404) return undefined;
    if (!response.ok) await this.fail("head", response);
    const contentLength = response.headers.get("content-length");
    return {
      size: contentLength === null ? 0 : Number(contentLength),
      contentType: response.headers.get("content-type") ?? undefined,
      etag: stripQuotes(response.headers.get("etag")),
    };
  }

  async delete(key: ObjectKey): Promise<void> {
    assertObjectKey(key);
    const response = await this.send("delete", this.objectUrl(key), "DELETE", {});
    if (response.status === 404) return;
    if (!response.ok) await this.fail("delete", response);
  }

  async copy(srcKey: ObjectKey, dstKey: ObjectKey): Promise<void> {
    assertObjectKey(srcKey);
    assertObjectKey(dstKey);
    const response = await this.send("copy", this.objectUrl(dstKey), "PUT", {
      "x-amz-copy-source": `/${this.bucket}/${srcKey}`,
    });
    if (!response.ok) await this.fail("copy", response);
    // S3 documents the one case where this is NOT the end of it: CopyObject can
    // answer 200 with an `<Error>` document in the body, because the copy is
    // evaluated after the status line is already committed. Trusting the status
    // alone reports a failed copy as done. The body is also read here for the
    // ordinary reason: an unread response leaves the connection out of the pool.
    const body = await response.text();
    if (body.includes("<Error>")) throw this.refuse("copy", response.status, body);
    if (!body.includes("<CopyObjectResult>")) {
      throw new Error("Refusing a 200 copy whose body is neither a CopyObjectResult nor an Error.");
    }
  }

  async list(prefix: ObjectKey): Promise<readonly ListedObject[]> {
    assertObjectKey(prefix);
    const listed: ListedObject[] = [];
    let continuationToken: string | undefined;
    do {
      const url = new URL(`${this.endpoint}/${this.bucket}`);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("max-keys", String(this.listPageSize));
      if (continuationToken !== undefined)
        url.searchParams.set("continuation-token", continuationToken);
      const response = await this.send("list", url, "GET", {});
      if (!response.ok) await this.fail("list", response);
      const page = parseListObjectsV2(await response.text());
      listed.push(...page.contents);
      continuationToken = page.truncated ? page.nextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return listed;
  }

  async deletePrefix(prefix: ObjectKey): Promise<void> {
    assertObjectKey(prefix);
    // One DELETE per key: the multi-object delete is a POST to `?delete` with an
    // XML body, and a second hand-written XML shape is a second parser to own
    // and to prove against a hostile body.
    const keys = (await this.list(prefix)).map((object) => object.key);
    // ALL OR NOTHING, and the check comes before the first delete rather than
    // inside the loop. A key from the store is not a key this adapter wrote: a
    // proxy, a replication target or a second writer can put one under this
    // prefix that the alphabet would refuse, and a loop that validated and
    // deleted as it went would leave the prefix half-erased with no way to say
    // which half. So one odd key means nothing at all was deleted. The message
    // names neither the key nor the prefix — the caller supplied the prefix, and
    // the key came back from a store, so neither is ours to print.
    for (const key of keys) {
      if (!OBJECT_KEY_PATTERN.test(key)) {
        throw new Error(
          "The listing under this prefix contains a key outside the allowed alphabet; nothing was deleted.",
        );
      }
    }
    for (const key of keys) await this.delete(key);
  }

  async presignGet(key: ObjectKey, options: PresignGetOptions): Promise<string> {
    assertObjectKey(key);
    // The PUBLIC endpoint, not S3_ENDPOINT: the signature is valid for the host
    // it was made for, and a browser cannot reach an in-cluster address.
    const url = new URL(`${this.publicEndpoint}/${this.bucket}/${key}`);
    // Before signing, and set even when the caller passed no window: aws4fetch
    // defaults X-Amz-Expires to 86400 when it is absent, so a caller's own
    // expiry would be ignored rather than honoured.
    url.searchParams.set("X-Amz-Expires", String(options.expiresInSeconds));
    if (options.responseContentDisposition !== undefined) {
      url.searchParams.set("response-content-disposition", options.responseContentDisposition);
    }
    if (options.responseContentType !== undefined) {
      url.searchParams.set("response-content-type", options.responseContentType);
    }
    const signed = await this.client.sign(url, {
      method: "GET",
      aws: { signQuery: true, datetime: amzDate(options.now ?? this.now()) },
    });
    return signed.url;
  }

  private objectUrl(key: ObjectKey): URL {
    return new URL(`${this.endpoint}/${this.bucket}/${key}`);
  }

  private async send(
    operation: string,
    url: URL,
    method: string,
    headers: Record<string, string>,
    body?: Uint8Array,
  ): Promise<Response> {
    const request = await this.client.sign(url, {
      method,
      headers,
      // A COPY of exactly these bytes, into an ArrayBuffer of exactly their
      // length — never the caller's view and never a Blob or a stream (aws4fetch
      // hashes only a string, an ArrayBuffer or an ArrayBufferView).
      //
      // `new Uint8Array(body)`, and emphatically NOT `body.slice()`: `Buffer`
      // extends `Uint8Array` but `Buffer.prototype.slice` is `subarray`, so on a
      // Buffer it returns a VIEW, and `.buffer` on that view is the whole shared
      // 8 KiB pool — `Buffer.from([1,2,3]).slice().buffer.byteLength` is 8192,
      // pool contents included. Nothing would notice: an S3 header-auth request
      // is signed `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD`, so the store never
      // hashes what arrived and accepts the pool silently. `head().size` would
      // then read 8192 and `get()` would hand back other processes' memory, and
      // `fs.readFile`, `Buffer.concat`, sharp and ffmpeg all produce Buffers.
      // The TypedArray constructor copies whatever the input's `slice` does.
      body: body === undefined ? undefined : new Uint8Array(body).buffer,
    });
    try {
      return await this.fetchImpl(request);
    } catch (transport: unknown) {
      // undici reports a transport failure as `TypeError: fetch failed` with a
      // `cause` naming the syscall and the host — and the host here is an
      // in-cluster address, which a log has no business describing. Nothing from
      // the cause survives: not its message, not the host, and not the error
      // itself as a `cause`, because a chain is still a log. Only the errno code
      // is kept, as a field, where it is a diagnosis and not a disclosure.
      throw new S3RequestError(operation, 0, transportCode(transport));
    }
  }

  /**
   * Turn a non-2xx into `S3RequestError`, carrying the status and the body's
   * `<Code>`. Nothing else about the request is read: not the URL, not the
   * headers, and no `cause` — the `Request` above holds the signed query and the
   * `Authorization` header, so a cause chain is a credential in a log.
   */
  private async fail(operation: string, response: Response): Promise<never> {
    throw this.refuse(operation, response.status, await response.text());
  }

  /**
   * The one place an error is built out of a store answer, so "never echo" has
   * one line to hold rather than two. Deliberately an instance method rather than
   * a free function: the settings are in scope here, which is what lets a
   * mutation that appends `this.endpoint` to the message be a one-line change —
   * and the never-echo test is what catches it. A HEAD error has no body at all,
   * which is why the code is optional.
   */
  private refuse(operation: string, status: number, body: string): S3RequestError {
    return new S3RequestError(operation, status, /<Code>([^<]*)<\/Code>/.exec(body)?.[1]);
  }
}

/** `YYYYMMDDTHHMMSSZ` from a millisecond instant — the form SigV4 signs with. */
function amzDate(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** S3 quotes an ETag; the port's `etag` is unquoted, so a fake and a store agree. */
function stripQuotes(value: string | null): string | undefined {
  return value === null ? undefined : value.replace(/^"(.*)"$/, "$1");
}

/**
 * The errno code out of a rejected fetch's cause — `ENOTFOUND`, `ECONNREFUSED`,
 * `CERT_HAS_EXPIRED` — and nothing else. A code names a failure; the cause's
 * message names the host and the syscall, which is a disclosure.
 */
function transportCode(error: unknown): string | undefined {
  const cause: unknown = (error as { cause?: unknown } | null)?.cause;
  const code: unknown = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}
