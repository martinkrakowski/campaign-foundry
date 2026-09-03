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
import { InvalidCopyPoolError } from "./ports/pool-store.port.js";

export { copyPoolProblem, InvalidCopyPoolError, isCopyPool } from "./ports/pool-store.port.js";

/** Read `briefs/<briefId>/pools.json` through the pool store port; undefined when absent. */
export async function readPool(briefId: string): Promise<CopyPool | undefined> {
  return getPoolStore().readPool(briefId);
}

/** Write the pool through the pool store port — an atomic replace of `briefs/<pool.briefId>/pools.json`. */
export async function writePool(pool: CopyPool): Promise<void> {
  await getPoolStore().writePool(pool);
}

/** Copy `briefs/<fromBriefId>/pools.json` to `briefs/<toBriefId>/`, rewritten to name the destination. */
export async function copyPool(fromBriefId: string, toBriefId: string): Promise<CopyPool | undefined> {
  return getPoolStore().copyPool(fromBriefId, toBriefId);
}

/** Serialise read→merge→write sections per brief within this process. */
export function withPoolLock<T>(briefId: string, fn: () => Promise<T>): Promise<T> {
  return getPoolStore().withPoolLock(briefId, fn);
}

/** True when `briefs/<briefId>` exists and is a symlink — writes through it are refused. */
export async function isPoolDirSymlink(briefId: string): Promise<boolean> {
  return getPoolStore().isPoolDirSymlink(briefId);
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
export async function planInputFor(brief: CampaignBrief): Promise<Result<PlanInput, Error>> {
  const motion = motionRatiosFor(brief.output?.platforms);
  const requested = brief.variation?.axes?.ratio as PlanInput["ratios"];
  const ratios = requested === undefined ? {} : { ratios: requested };
  if (!wantsHeadlinePool(brief)) return ok({ ...ratios, ...motion });
  try {
    const pool = await readPool(brief.id);
    return ok({ ...ratios, headlines: pool ? approvedTexts(pool) : [], ...motion });
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
