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

/**
 * `listPageSize` has to be a positive integer, and this is the one message both
 * adapters use for it: the page size is how the two are held to the same
 * conformance, so a refusal that differs between them is a refusal one of them
 * does not make.
 */
export const LIST_PAGE_SIZE_PROBLEM = "listPageSize must be a positive integer.";

/**
 * A private copy of `bytes`, so a stored object is detached from the buffer it
 * was written from and a read never hands back a view of the store's own memory.
 *
 * `new Uint8Array(bytes)` and NOT `bytes.slice()`: `Buffer` extends `Uint8Array`
 * but `Buffer.prototype.slice` is `subarray`, so on a Buffer — which is what
 * `fs.readFile`, `Buffer.concat`, sharp and ffmpeg all return — `slice()`
 * aliases the caller's buffer instead of copying it. A fake that aliases would
 * make a stored object change under the test that just wrote it, and would hide
 * the same defect in a real adapter that did the same thing.
 */
function detached(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

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
    const pageSize = options.listPageSize ?? DEFAULT_LIST_PAGE_SIZE;
    // Refused here rather than defended against in `list`, because the loop
    // there advances BY the page size: a zero never terminates, and being a
    // synchronous loop it starves the event loop too, so it takes the whole test
    // worker down rather than failing one test. S3's own `max-keys` treats a zero
    // as a clamp, so this is the adapter refusing what the store would paper
    // over — and it refuses the same way in both adapters.
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new Error(LIST_PAGE_SIZE_PROBLEM);
    }
    this.listPageSize = pageSize;
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
      bytes: detached(bytes),
      contentType: options.contentType,
      etag: createHash("md5").update(bytes).digest("hex"),
      lastModified: new Date(this.now()),
    });
  }

  async get(key: ObjectKey): Promise<ObjectContent | undefined> {
    assertObjectKey(key);
    const stored = this.objects.get(key);
    if (stored === undefined) return undefined;
    return { bytes: detached(stored.bytes), contentType: stored.contentType };
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
    this.objects.set(dstKey, { ...stored, bytes: detached(stored.bytes) });
  }

  async presignGet(key: ObjectKey, options: PresignGetOptions): Promise<string> {
    assertObjectKey(key);
    const url = new URL(`${this.publicEndpoint}/${this.bucket}/${key}`);
    url.searchParams.set("X-Amz-Expires", String(options.expiresInSeconds));
    if (options.version !== undefined) url.searchParams.set("v", options.version);
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
   * A digest of what a real signature covers, so two keys never collide and a
   * changed option changes it.
   *
   * **`version` and `responseContentDisposition` are in it, and that is the point
   * rather than completeness** (PT-4f, D209a). Both are parameters in the query
   * SigV4 signs, so a digest that covered only the key and the window would hand
   * back the SAME signature for two URLs a real store treats as different
   * objects-in-time — and the fake would then be the one adapter on which
   * "changing `v` changes the URL" is false, which is precisely the claim the
   * conformance case exists to check. `responseContentType` is covered by the
   * same argument and was left out of that sentence only because nothing signs one
   * today; it is included below so the two cannot be told apart by omission.
   */
  private digest(key: ObjectKey, options: PresignGetOptions): string {
    const moment = options.now ?? this.now();
    return createHash("sha256")
      .update(
        [
          key,
          options.expiresInSeconds,
          moment,
          options.version ?? "",
          options.responseContentDisposition ?? "",
          options.responseContentType ?? "",
        ].join(" "),
      )
      .digest("hex");
  }
}
