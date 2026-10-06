import type { ListedObject, ObjectStorePort } from "@campaignfoundry/CampaignOrchestration";
import { cachePrefix } from "../object-store/object-keys.js";

/**
 * D242: a render-cache object is expired once it is MORE than this old,
 * measured from the store's `LastModified`, which is the moment of its LAST
 * WRITE. A cache hit does not refresh it, so an entry used daily is still
 * expired on day 31 and regenerated once.
 */
export const CACHE_TTL_MS = 30 * 24 * 60 * 60_000;

/** What `ObjectBackgroundCache` writes under `org/<org>/cache/`: a lower-case sha256 digest and `.png`. Anything else there is not ours to delete. */
const CACHE_KEY_TAIL = /^[0-9a-f]{64}\.png$/;

export interface CacheExpiryPlan {
  readonly orgId: string;
  /** The sha256 digests of the entries older than the TTL. */
  readonly expired: readonly string[];
  /** Recognised entries that are not old enough. */
  readonly kept: number;
  /** Keys under the cache prefix that are not `<digest>.png`: never deleted. */
  readonly unrecognised: number;
}

export interface CacheExpiryResult {
  readonly plans: readonly CacheExpiryPlan[];
  readonly deleted: number;
}

/** The key of one cache entry, REBUILT from an org id and a validated digest. */
export function cacheObjectKey(orgId: string, digest: string): string {
  return `${cachePrefix(orgId)}${digest}.png`;
}

function isExpired(object: ListedObject, now: number): boolean {
  const age = now - object.lastModified.getTime();
  return age > CACHE_TTL_MS;
}

/**
 * D242, read only: which cache entries of one org are older than the TTL. Lists
 * `org/<org>/cache/` and nothing else (never a campaign prefix, never another
 * org), and puts every key it does not recognise in `unrecognised` instead of
 * touching it.
 */
export async function planCacheExpiry(
  store: ObjectStorePort,
  orgId: string,
  now: number,
): Promise<CacheExpiryPlan> {
  const prefix = cachePrefix(orgId);
  const expired: string[] = [];
  let kept = 0;
  let unrecognised = 0;
  for (const object of await store.list(prefix)) {
    const tail = object.key.startsWith(prefix) ? object.key.slice(prefix.length) : "";
    if (!CACHE_KEY_TAIL.test(tail)) {
      unrecognised++;
    } else if (isExpired(object, now)) {
      expired.push(tail.slice(0, 64));
    } else {
      kept++;
    }
  }
  return { orgId, expired, kept, unrecognised };
}

/** The lines the CLI and the sweep log for one org's plan: a header, then one line per expired entry. */
export function describeCachePlan(plan: CacheExpiryPlan): string[] {
  return [
    `  cache org ${plan.orgId}: ${plan.expired.length} expired, ${plan.kept} kept, ${plan.unrecognised} unrecognised`,
    ...plan.expired.map((digest) => `    expired ${cacheObjectKey(plan.orgId, digest)}`),
  ];
}

/**
 * Plan EVERY org first (a store that fails on any org throws before the first
 * delete), report each plan through `onPlan`, then delete, only when `apply` is
 * set. Nothing is deleted on a dry run, the default of every caller.
 */
export async function expireCache(
  store: ObjectStorePort,
  orgIds: readonly string[],
  options: {
    readonly apply: boolean;
    readonly now: () => number;
    readonly onPlan?: (plan: CacheExpiryPlan) => void;
  },
): Promise<CacheExpiryResult> {
  const plans: CacheExpiryPlan[] = [];
  for (const orgId of orgIds) plans.push(await planCacheExpiry(store, orgId, options.now()));
  for (const plan of plans) options.onPlan?.(plan);
  let deleted = 0;
  if (options.apply) {
    for (const plan of plans) {
      for (const digest of plan.expired) {
        await store.delete(cacheObjectKey(plan.orgId, digest));
        deleted++;
      }
    }
  }
  return { plans, deleted };
}
