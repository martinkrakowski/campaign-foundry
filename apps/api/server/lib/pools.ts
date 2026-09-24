import {
  approvedTexts,
  HEADLINE_POOL_REF,
  PlanVariationsUseCase,
  type CampaignBrief,
  type CopyPool,
  type PlanInput,
  type VariationPlanner,
} from "@campaignfoundry/CampaignOrchestration";
import { nodeCryptoPolicyHasher } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { err, ok, type Result } from "@campaignfoundry/shared";
import { motionRatiosFor } from "./platform-zones.js";
import { getPoolStore } from "./ports/index.js";
import { InvalidCopyPoolError, type StoredPool } from "./ports/pool-store.port.js";

import type { TenantContext } from "./tenant.js";
export {
  copyPoolProblem,
  InvalidCopyPoolError,
  isCopyPool,
  type StoredPool,
} from "./ports/pool-store.port.js";

/** Read `briefs/<briefId>/pools.json` through the pool store port; undefined when absent. */
export async function readPool(
  tenant: TenantContext,
  briefId: string,
): Promise<StoredPool | undefined> {
  return getPoolStore(tenant).readPool(briefId);
}

/**
 * Write the pool through the pool store port — an atomic replace of
 * `briefs/<pool.briefId>/pools.json`, conditional when `expectedRevision` is
 * given: a stale one is refused with `ECONFLICT` carrying the fresh revision.
 */
export async function writePool(
  tenant: TenantContext,
  pool: CopyPool,
  options?: { expectedRevision?: string },
): Promise<StoredPool> {
  return getPoolStore(tenant).writePool(pool, options);
}

/** Copy `briefs/<fromBriefId>/pools.json` to `briefs/<toBriefId>/`, rewritten to name the destination. */
export async function copyPool(
  tenant: TenantContext,
  fromBriefId: string,
  toBriefId: string,
): Promise<CopyPool | undefined> {
  return getPoolStore(tenant).copyPool(fromBriefId, toBriefId);
}

/** Remove `briefs/<briefId>/pools.json` through the pool store port; a missing file is a no-op. */
export async function deletePool(tenant: TenantContext, briefId: string): Promise<void> {
  await getPoolStore(tenant).deletePool(briefId);
}

/** Serialise read→merge→write sections per brief within this process. */
export function withPoolLock<T>(
  tenant: TenantContext,
  briefId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return getPoolStore(tenant).withPoolLock(briefId, fn);
}

/** True when `briefs/<briefId>` exists and is a symlink — writes through it are refused. */
export async function isPoolDirSymlink(tenant: TenantContext, briefId: string): Promise<boolean> {
  return getPoolStore(tenant).isPoolDirSymlink(briefId);
}

/** True when the brief draws headlines from its approved copy pool. */
export function wantsHeadlinePool(brief: CampaignBrief): boolean {
  return brief.variation?.axes?.headline === HEADLINE_POOL_REF;
}

/**
 * Plan-time input for a brief — everything the planner resolves on the brief's
 * behalf:
 * - `headlines`: the approved texts of `briefs/<id>/pools.json` when the brief
 *   requests `headline: pool://copy`. A missing pool yields no headlines — the
 *   planner then fails loud naming the pool file. An invalid pool file is an
 *   `err` carrying the `InvalidCopyPoolError` message, so plan and generate
 *   both fail loud with it.
 * - `motionRatios`: the ratios of the requested motion platforms (see
 *   `motionRatiosFor`), present only when the brief lists `output.platforms`.
 * - `ratios`: the brief's `variation.axes.ratio` selection, present only when
 *   the brief carries the axis (absent → every ratio). The parser has already
 *   bounded it to supported values; the policy re-checks.
 */
export async function planInputFor(
  tenant: TenantContext,
  brief: CampaignBrief,
): Promise<Result<PlanInput, Error>> {
  const motion = motionRatiosFor(brief.output?.platforms);
  const requested = brief.variation?.axes?.ratio as PlanInput["ratios"];
  const ratios = requested === undefined ? {} : { ratios: requested };
  if (!wantsHeadlinePool(brief)) return ok({ ...ratios, ...motion });
  try {
    const stored = await readPool(tenant, brief.id);
    const headlines = stored ? approvedTexts(stored.pool) : [];
    return ok({ ...ratios, headlines, ...motion });
  } catch (error) {
    if (error instanceof InvalidCopyPoolError) return err(error);
    throw error;
  }
}

/** The variation planner with `input` (the resolved pool + platform ratios) bound for every `plan` call. */
export function pooledPlanner(input: PlanInput): VariationPlanner {
  const planner = new PlanVariationsUseCase(nodeCryptoPolicyHasher);
  return {
    plan: (brief) => planner.plan(brief, input),
    replan: (plan, index, attempt) => planner.replan(plan, index, attempt),
  };
}
