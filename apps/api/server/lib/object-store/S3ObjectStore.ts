import { AwsClient } from "aws4fetch";
import {
  assertObjectKey,
  ObjectExistsError,
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

/** A non-2xx the store did not already map onto `undefined` or `ObjectExistsError`. */
export class S3RequestError extends Error {
  readonly status: number;
  /** The body's `<Code>`, when it had one — a HEAD response never does. */
  readonly code?: string;

  constructor(operation: string, status: number, code?: string) {
    super(
      `The object store answered ${status} to ${operation}${code === undefined ? "" : ` (${code})`}.`,
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
    this.listPageSize = options.listPageSize ?? DEFAULT_LIST_PAGE_SIZE;
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
    // The Uint8Array itself, not a Blob or a stream: aws4fetch hashes only a
    // string, an ArrayBuffer or an ArrayBufferView.
    const response = await this.send(this.objectUrl(key), "PUT", headers, bytes);
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
    const response = await this.send(this.objectUrl(key), "GET", {});
    if (response.status === 404) return undefined;
    if (!response.ok) await this.fail("get", response);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? undefined,
    };
  }

  async head(key: ObjectKey): Promise<ObjectMetadata | undefined> {
    assertObjectKey(key);
    const response = await this.send(this.objectUrl(key), "HEAD", {});
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
    const response = await this.send(this.objectUrl(key), "DELETE", {});
    if (response.status === 404) return;
    if (!response.ok) await this.fail("delete", response);
  }

  async copy(srcKey: ObjectKey, dstKey: ObjectKey): Promise<void> {
    assertObjectKey(srcKey);
    assertObjectKey(dstKey);
    const response = await this.send(this.objectUrl(dstKey), "PUT", {
      "x-amz-copy-source": `/${this.bucket}/${srcKey}`,
    });
    if (!response.ok) await this.fail("copy", response);
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
      const response = await this.send(url, "GET", {});
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
    for (const object of await this.list(prefix)) {
      await this.delete(object.key);
    }
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
    url: URL,
    method: string,
    headers: Record<string, string>,
    body?: Uint8Array,
  ): Promise<Response> {
    const request = await this.client.sign(url, {
      method,
      headers,
      // The bytes' own `ArrayBuffer`, not the view and never a Blob or a stream:
      // aws4fetch hashes only a string, an ArrayBuffer or an ArrayBufferView,
      // and the `BodyInit` this repo's lib declares does not accept a
      // `Uint8Array`. `slice()` is what makes the buffer EXACTLY the bytes — the
      // same bytes `head().size` and the same bytes a caller still holds — and
      // it is a copy of a buffer the caller has already handed over.
      body: body === undefined ? undefined : body.slice().buffer,
    });
    return this.fetchImpl(request);
  }

  /**
   * Turn a non-2xx into `S3RequestError`, carrying the status and the body's
   * `<Code>`. Nothing else about the request is read: not the URL, not the
   * headers, and no `cause` — the `Request` above holds the signed query and the
   * `Authorization` header, so a cause chain is a credential in a log.
   */
  private async fail(operation: string, response: Response): Promise<never> {
    const code = /<Code>([^<]*)<\/Code>/.exec(await response.text())?.[1];
    throw new S3RequestError(operation, response.status, code);
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
