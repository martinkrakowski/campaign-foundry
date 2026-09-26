/**
 * Metering and quotas (PT-7a, D175, H2).
 *
 * Provider access is platform-held: one set of credentials serves every org,
 * so an org's spend has to be metered and gated instead of read off its own
 * bill. Every non-cached, successful generation — a background a provider
 * resolved, or a copy-pool request — records one usage row, and
 * `generate.post.ts`'s admission region refuses a run before any provider
 * call once the calling org is at or over its monthly quota. No org other
 * than the operator's is admitted until this exists (D175).
 */

/** Whose credentials a generation billed. Always `"platform"` in this wave; PT-7b adds `"org"` (BYOK). */
export type KeyOwner = "platform" | "org";

/** One generation to record. */
export interface UsageRecord {
  readonly orgId: string;
  readonly provider: string;
  readonly model: string;
  /** Images or copy variants this generation produced. */
  readonly units: number;
  readonly keyOwner: KeyOwner;
}

/**
 * How long an unsettled reservation counts toward this month's quota (PT-7a2,
 * D175). A crashed worker or dropped run stops consuming quota after this
 * window without needing an explicit cleanup pass.
 */
export const RESERVATION_TTL_MS = 60 * 60 * 1000;

export interface UsageStorePort {
  /** Record one generation. Never called for a cached result — the provider was not called. */
  record(usage: UsageRecord): Promise<void>;
  /**
   * How many generations `orgId` has recorded since the start of `now`'s UTC
   * calendar month (a row count, not a sum of `units`: the quota is
   * "every generation … against a quota", D175).
   */
  countThisMonth(orgId: string, now: Date): Promise<number>;
  /** The org's monthly generation quota, or null for unlimited. */
  quota(orgId: string): Promise<number | null>;
  /**
   * Reserve one generation slot for `orgId` (PT-7a2, D175). Returns a
   * reservation id, or null when the org is at or over its monthly quota.
   */
  reserve(orgId: string): Promise<string | null>;
  /**
   * Settle a reserved slot into a recorded row with its generation details
   * (PT-7a2, D175).
   */
  settle(id: string, record: UsageRecord): Promise<void>;
  /**
   * Release a previously reserved slot (PT-7a2, D175), freeing it for another
   * generation (e.g. on provider error, cached result, or fallback).
   */
  release(id: string): Promise<void>;
}
