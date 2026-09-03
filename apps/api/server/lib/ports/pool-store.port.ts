import type { CopyPool } from "@campaignfoundry/CampaignOrchestration";

/**
 * Thrown by `readPool` for a pool file that parses but is not a `CopyPool`; routes map it to 422.
 */
export class InvalidCopyPoolError extends Error {
  constructor(briefId: string, detail: string) {
    super(`Copy pool briefs/${briefId}/pools.json is invalid: ${detail}.`);
    this.name = "InvalidCopyPoolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first shape problem of a persisted entry, or undefined when it is a `CopyPoolEntry`. */
function entryProblem(value: unknown, index: number, seen: Set<string>): string | undefined {
  const at = `entries[${index}]`;
  if (!isRecord(value)) return `${at} must be an object`;
  if (typeof value.id !== "string" || value.id.length === 0) return `${at}.id must be a non-empty string`;
  if (seen.has(value.id)) return `${at}.id "${value.id}" appears more than once`;
  seen.add(value.id);
  if (typeof value.text !== "string") return `${at}.text must be a string`;
  if (value.status !== "approved" && value.status !== "rejected") {
    return `${at}.status must be "approved" or "rejected"`;
  }
  if (value.reason !== undefined && typeof value.reason !== "string") return `${at}.reason must be a string`;
  return undefined;
}

/** The first shape problem of a parsed pool file, or undefined when it is a `CopyPool`. */
export function copyPoolProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "must be an object";
  for (const field of ["briefId", "generatedAt", "model"] as const) {
    if (typeof value[field] !== "string") return `${field} must be a string`;
  }
  if (!Array.isArray(value.entries)) return "entries must be an array";
  const seen = new Set<string>();
  for (let i = 0; i < value.entries.length; i++) {
    const problem = entryProblem(value.entries[i], i, seen);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** Shape guard for a parsed pool file — the persistence boundary, since the file is hand-editable. */
export function isCopyPool(value: unknown): value is CopyPool {
  return copyPoolProblem(value) === undefined;
}

/**
 * Port for loading, writing, copying, and locking the per-brief copy pool.
 *
 * The pool is keyed by the brief's id — the same store key as the brief itself —
 * so `copyPool` is part of the duplicate path: a stored pool carries the id of
 * the brief it belongs to (`CopyPool.briefId`), and a copy that names the old
 * brief would hand the new one a pool it can never read.
 *
 * This port is the boundary between the HTTP routes / application layer and the
 * underlying storage mechanism (local filesystem today, S3/blob storage next).
 * No node:fs, path joining, or process.cwd() may leak through this interface.
 */
export interface PoolStorePort {
  /**
   * Read the pool stored under `briefId`; undefined when absent.
   * A file that is not a `CopyPool` (hand-edited) throws `InvalidCopyPoolError`
   * naming the problem, so a route answers 422 instead of a 500 from a bare
   * `TypeError` downstream.
   */
  readPool(briefId: string): Promise<CopyPool | undefined>;

  /**
   * Write the pool under its own `pool.briefId`. Atomic: a crash never leaves
   * half-written JSON and two overlapping writers never share a temp file.
   */
  writePool(pool: CopyPool): Promise<void>;

  /**
   * Copy the pool from `fromBriefId` to `toBriefId`, rewriting the copied
   * pool's own `briefId` to the destination. Undefined when the source has no
   * pool; `InvalidCopyPoolError` when the source pool is hand-edited.
   * Refuses to write through a symlinked `briefs/<toBriefId>` directory.
   */
  copyPool(fromBriefId: string, toBriefId: string): Promise<CopyPool | undefined>;

  /**
   * Serialise read→merge→write sections per brief within this process, so a
   * concurrent POST/PATCH always merges into the latest file instead of
   * clobbering the other request's entries. Errors in `fn` do not poison the chain.
   */
  withPoolLock<T>(briefId: string, fn: () => Promise<T>): Promise<T>;

  /**
   * True when `briefs/<briefId>` exists and is a symlink — writes through it are refused.
   */
  isPoolDirSymlink(briefId: string): Promise<boolean>;
}
