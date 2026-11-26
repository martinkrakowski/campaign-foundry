import type { ListedObject, ObjectKey } from "./ObjectStorePort.js";

/**
 * PublicAdMediaPort — outbound port for the PUBLIC ad-media bucket (PT-4k).
 *
 * The private object store behind `ObjectStorePort` holds campaign assets that
 * are read back through presigned URLs. Published ad media is the opposite
 * shape: bytes a browser fetches from a plain, unguessable, immutable URL on a
 * dedicated public-read bucket — org-prefixed keys
 * `{org}/{128-bit-random}/{content-hash}.mp4`, written once with an exclusive
 * create and never overwritten.
 *
 * It is a separate port, not a method set on `ObjectStorePort`, because the two
 * stores have different credentials, different endpoints and different
 * lifetimes: publishing to the public bucket must never be able to read,
 * replace or list the private one. The one implementation is
 * `PublicAdMediaStore` (infrastructure), built over an `ObjectStorePort` it
 * does not own.
 */

/** The org segment of a public key: the same shape `object-keys.ts` uses. */
export const PUBLIC_AD_MEDIA_ORG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The 128-bit random middle segment, minted by the store, lowercase hex. */
export const PUBLIC_AD_MEDIA_RANDOM_PATTERN = /^[0-9a-f]{32}$/;

/** The content hash the caller supplies, lowercase hex SHA-256. */
export const PUBLIC_AD_MEDIA_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Refuse an input that does not match its own declared shape — an org id, a
 * hash, a key, a base URL or a byte body.
 *
 * The message names the RULE and never the value, for the reason
 * `assertObjectKey` gives: these inputs arrive from callers nothing here has
 * vetted, and a refusal that echoes one lands in whatever logged the throw.
 */
export class InvalidPublicAdMediaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPublicAdMediaInputError";
  }
}

/** A published object: its store key, and the public URL a browser fetches. */
export interface PublishedAdMedia {
  readonly key: ObjectKey;
  readonly url: string;
}

/**
 * Publish and remove ad media on the public-read bucket.
 *
 * `publish` is an exclusive create: a key collision throws rather than
 * overwrites, and the original bytes stay exactly as they were. `remove` and
 * `removeOrg` are for the org's own purge path.
 */
export interface PublicAdMediaPort {
  /** Store `bytes` under an unguessable key; never overwrites. */
  publish(orgId: string, bytes: Uint8Array, contentHash: string): Promise<PublishedAdMedia>;

  /** Remove the one published object at `key`; idempotent. */
  remove(key: ObjectKey): Promise<void>;

  /** Remove every published object under `orgId/`; idempotent. */
  removeOrg(orgId: string): Promise<void>;

  /**
   * The published objects under `orgId/`, one page at a time, so a caller that
   * only counts or filters never holds the whole listing — the reconcile pass
   * that finds a public object orphaned by a crash between `publish` and the
   * ledger record (D239). The prefix is the caller's responsibility here, not
   * `assertObjectKey`'s: `orgId` is an org id, not a key.
   */
  listPages(orgId: string): AsyncIterable<readonly ListedObject[]>;

  /**
   * Whether the object at `key` is still in the public bucket. The publish
   * path asks this under the ledger's per-key lock, so an object a reconcile
   * pass removed during a long pause is never recorded as published.
   */
  exists(key: ObjectKey): Promise<boolean>;

  /** The public URL for `key`, on the configured base URL. */
  urlFor(key: ObjectKey): string;
}
