/**
 * ObjectStorePort — outbound port for the S3-compatible object store (PT-4a,
 * D201–D204).
 *
 * Two implementations sit behind it and are held to ONE conformance suite, so a
 * use case never learns which it has: `InMemoryObjectStore` (this package, used
 * by tests and by the `fs` backend) and `S3ObjectStore` (`apps/api`, on
 * aws4fetch).
 *
 * Keys are relative and confined by `OBJECT_KEY_PATTERN` — never absolute, never
 * an empty segment, never a `.` or `..` segment — which is what lets an adapter
 * join a key onto an endpoint or a root directory without re-deriving whether
 * the result stays inside it. `assertObjectKey` is the single implementation of
 * that rule, exported so an adapter calls it rather than writing its own.
 *
 * `presignGet` takes the clock as an option rather than reading one: D204 signs
 * in 15-minute windows so a browser cache can be reused, and a window that is
 * untestable is a window nobody will keep. The window itself belongs to the
 * signed-url lane; this port has no opinion about its length.
 */

/** The characters a key may contain, anchored — no whitespace, no `&`, no `?`. */
export const OBJECT_KEY_PATTERN = /^[A-Za-z0-9._/-]+$/;

/** The name of an existing object, carried on `ObjectExistsError` for the caller. */
export type ObjectKey = string;

/**
 * Thrown by a conditional create (`ifNoneMatch: "*"`) when the key is already
 * taken. The store is left exactly as it was: the conditional write never
 * replaced the original (D174c's exclusive create).
 */
export class ObjectExistsError extends Error {
  readonly key: ObjectKey;

  constructor(key: ObjectKey) {
    super(`An object already exists at key "${key}".`);
    this.name = "ObjectExistsError";
    this.key = key;
  }
}

/**
 * Refuse a key outside `OBJECT_KEY_PATTERN`, or one that escapes its own shape
 * with an absolute path, an empty segment or a `.`/`..` segment.
 *
 * The message names the RULE and never the key. The key is the one string
 * reaching this function that has not been through anything, so it may be
 * anything — including a value that came from a header or a query — and a
 * rejected key that gets echoed lands in whatever logged the throw. The same
 * reason `keyEncryptionSettings()` never echoes a misplaced key. Callers that
 * want the offending value log it themselves, having decided it is safe to.
 */
export function assertObjectKey(key: ObjectKey): void {
  const problem = objectKeyProblem(key);
  if (problem !== undefined) {
    throw new Error(`Refusing an object key: ${problem}.`);
  }
}

/** Why `key` is not a usable object key, or undefined when it is. */
export function objectKeyProblem(key: ObjectKey): string | undefined {
  if (!OBJECT_KEY_PATTERN.test(key)) {
    return `a key must be non-empty and match ${OBJECT_KEY_PATTERN.source}`;
  }
  if (key.startsWith("/")) return "a key must be relative, not absolute";
  if (key.includes("//")) return "a key must not contain an empty segment";
  const traversal = key.split("/").find((segment) => segment === "." || segment === "..");
  if (traversal !== undefined) return `a key must not contain a "${traversal}" segment`;
  return undefined;
}

/** `put`'s options. Both are absent for an unconditional write. */
export interface PutObjectOptions {
  readonly contentType?: string;
  /** `"*"` makes the create exclusive: a key that exists throws `ObjectExistsError`. */
  readonly ifNoneMatch?: "*";
}

/** A body and the type it was stored with, as `get` returns it. */
export interface ObjectContent {
  readonly bytes: Uint8Array;
  readonly contentType?: string;
}

/** What `head` reports about an object without transferring it. */
export interface ObjectMetadata {
  readonly size: number;
  readonly contentType?: string;
  /** Unquoted, so a real store and `InMemoryObjectStore` answer the same. */
  readonly etag?: string;
}

/** One entry of a prefix listing. */
export interface ListedObject {
  readonly key: ObjectKey;
  readonly size: number;
  readonly etag?: string;
  readonly lastModified: Date;
}

/** `presignGet`'s options. `now` is milliseconds since the epoch. */
export interface PresignGetOptions {
  readonly expiresInSeconds: number;
  /** Defaults to the adapter's own clock; passed in so a window is testable. */
  readonly now?: number;
  /**
   * The value this object stands for at this revision, sent as the query
   * parameter `v` and signed with the rest (PT-4f, D209a).
   *
   * **A NAMED field, never a generic query map**, and the reason is exactly the
   * signature: a map handed to `URL.searchParams` lands in the query string the
   * signature covers, so a caller could put `X-Amz-Expires` in it and decide its
   * own window, or add an `X-Amz-*` parameter of its own. One named parameter
   * cannot be misused that way, and `v` is chosen because it is not an
   * `X-Amz-*` or a `response-*` name — so it rides the URL without displacing
   * anything SigV4 or S3 reserve.
   *
   * It is what carries a report's revision into the URL the server signed
   * (D204), so a browser re-fetches exactly when the bytes behind it changed
   * instead of on every poll tick, and it is signed rather than appended by the
   * client — a client-appended `?v=` is one a caller can edit to anything.
   */
  readonly version?: string;
  readonly responseContentDisposition?: string;
  readonly responseContentType?: string;
}

/**
 * The object store a use case writes renders and proofs through (D203: proofs
 * under `renders/`, inputs through the same port).
 *
 * Nothing here knows about S3, HTTP or a filesystem: keys are strings, bodies
 * are bytes, and a missing object is `undefined` rather than an error — except
 * where a create was asked to be exclusive.
 */
export interface ObjectStorePort {
  /** Store `bytes` at `key`, replacing whatever was there. */
  put(key: ObjectKey, bytes: Uint8Array, options?: PutObjectOptions): Promise<void>;

  /** The object at `key`, or `undefined` when there is none. */
  get(key: ObjectKey): Promise<ObjectContent | undefined>;

  /** The object's metadata, or `undefined` when there is none. */
  head(key: ObjectKey): Promise<ObjectMetadata | undefined>;

  /** Remove the object at `key`; idempotent — a missing object is not an error. */
  delete(key: ObjectKey): Promise<void>;

  /**
   * Every object under `prefix`, paginating internally so a caller never sees a
   * page size. The prefix is a key prefix and is confined by `assertObjectKey`,
   * so an empty prefix — which would list, and `deletePrefix` would empty, the
   * whole store — is refused rather than honoured.
   */
  list(prefix: ObjectKey): Promise<readonly ListedObject[]>;

  /** Remove every object under `prefix`. Idempotent. */
  deletePrefix(prefix: ObjectKey): Promise<void>;

  /** Copy `srcKey` to `dstKey` within the store, without a download and an upload. */
  copy(srcKey: ObjectKey, dstKey: ObjectKey): Promise<void>;

  /**
   * A URL a browser can GET the object at without credentials, valid for
   * `expiresInSeconds` from `now`.
   */
  presignGet(key: ObjectKey, options: PresignGetOptions): Promise<string>;
}
