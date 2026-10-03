import { createHash } from "node:crypto";
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
} from "../../application/ports/out/ObjectStorePort.js";

/** S3's own `max-keys` ceiling, which the fake pages at by default. */
const DEFAULT_LIST_PAGE_SIZE = 1000;

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType?: string;
  readonly etag: string;
  readonly lastModified: Date;
}

export interface InMemoryObjectStoreOptions {
  /** Keys per `list` page, so the pagination loop is exercisable offline. */
  readonly listPageSize?: number;
  /** The clock `lastModified` reads. Injected so a listing is reproducible. */
  readonly now?: () => number;
  /** The origin `presignGet` builds its URLs on, e.g. `https://s3.example`. */
  readonly publicEndpoint?: string;
  /** The bucket name those URLs carry, so the path shape matches a real store. */
  readonly bucket?: string;
}

/**
 * `ObjectStorePort` in a Map (PT-4a) — the fake every use case test runs
 * against, and the one half of the conformance suite that needs no server.
 *
 * It pages `list` at `listPageSize` the way a real store pages on
 * `NextContinuationToken` and then joins the pages, so a caller never sees the
 * page size and the loop a real bucket forces is walked offline too.
 *
 * `presignGet` returns a URL of the real one's SHAPE — same path, same
 * `X-Amz-Expires` and `response-content-*` parameters, same host — with a
 * signature that is a digest of the key and the window rather than a SigV4
 * signature. Nothing can verify it and nothing outside this process accepts it;
 * what a test needs from it is the shape, and pretending it is more would be
 * the lie that lets a caller depend on it.
 */
export class InMemoryObjectStore implements ObjectStorePort {
  private readonly objects = new Map<ObjectKey, StoredObject>();
  private readonly listPageSize: number;
  private readonly now: () => number;
  private readonly publicEndpoint: string;
  private readonly bucket: string;

  constructor(options: InMemoryObjectStoreOptions = {}) {
    this.listPageSize = options.listPageSize ?? DEFAULT_LIST_PAGE_SIZE;
    this.now = options.now ?? (() => Date.now());
    this.publicEndpoint = (options.publicEndpoint ?? "https://memory.invalid").replace(/\/+$/, "");
    this.bucket = options.bucket ?? "in-memory";
  }

  async put(key: ObjectKey, bytes: Uint8Array, options: PutObjectOptions = {}): Promise<void> {
    assertObjectKey(key);
    if (options.ifNoneMatch !== undefined && this.objects.has(key)) {
      throw new ObjectExistsError(key);
    }
    this.objects.set(key, {
      // Copied, so a caller reusing its buffer cannot change a stored object.
      bytes: bytes.slice(),
      contentType: options.contentType,
      etag: createHash("md5").update(bytes).digest("hex"),
      lastModified: new Date(this.now()),
    });
  }

  async get(key: ObjectKey): Promise<ObjectContent | undefined> {
    assertObjectKey(key);
    const stored = this.objects.get(key);
    if (stored === undefined) return undefined;
    return { bytes: stored.bytes.slice(), contentType: stored.contentType };
  }

  async head(key: ObjectKey): Promise<ObjectMetadata | undefined> {
    assertObjectKey(key);
    const stored = this.objects.get(key);
    if (stored === undefined) return undefined;
    return {
      size: stored.bytes.length,
      contentType: stored.contentType,
      etag: stored.etag,
    };
  }

  async delete(key: ObjectKey): Promise<void> {
    assertObjectKey(key);
    this.objects.delete(key);
  }

  async list(prefix: ObjectKey): Promise<readonly ListedObject[]> {
    assertObjectKey(prefix);
    const matched = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, stored]) => ({
        key,
        size: stored.bytes.length,
        etag: stored.etag,
        lastModified: stored.lastModified,
      }));
    const listed: ListedObject[] = [];
    for (let start = 0; start < matched.length; start += this.listPageSize) {
      listed.push(...matched.slice(start, start + this.listPageSize));
    }
    return listed;
  }

  async deletePrefix(prefix: ObjectKey): Promise<void> {
    assertObjectKey(prefix);
    for (const [key] of [...this.objects.entries()]) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }

  async copy(srcKey: ObjectKey, dstKey: ObjectKey): Promise<void> {
    assertObjectKey(srcKey);
    assertObjectKey(dstKey);
    const stored = this.objects.get(srcKey);
    if (stored === undefined) {
      throw new Error("Cannot copy an object that does not exist.");
    }
    this.objects.set(dstKey, { ...stored, bytes: stored.bytes.slice() });
  }

  async presignGet(key: ObjectKey, options: PresignGetOptions): Promise<string> {
    assertObjectKey(key);
    const url = new URL(`${this.publicEndpoint}/${this.bucket}/${key}`);
    url.searchParams.set("X-Amz-Expires", String(options.expiresInSeconds));
    if (options.responseContentDisposition !== undefined) {
      url.searchParams.set("response-content-disposition", options.responseContentDisposition);
    }
    if (options.responseContentType !== undefined) {
      url.searchParams.set("response-content-type", options.responseContentType);
    }
    url.searchParams.set("X-Amz-Signature", this.digest(key, options));
    return url.toString();
  }

  /**
   * A digest of what a real signature covers — the key and the window — so two
   * keys never collide and a changed expiry changes it.
   */
  private digest(key: ObjectKey, options: PresignGetOptions): string {
    const moment = options.now ?? this.now();
    return createHash("sha256")
      .update(`${key} ${options.expiresInSeconds} ${moment}`)
      .digest("hex");
  }
}
