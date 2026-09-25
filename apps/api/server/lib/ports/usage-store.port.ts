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
}
