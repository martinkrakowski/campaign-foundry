import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  approvedTexts,
  HEADLINE_POOL_REF,
  PlanVariationsUseCase,
  type CampaignBrief,
  type CopyPool,
  type PlanInput,
  type VariationPlanner,
} from "@campaignfoundry/CampaignOrchestration";
import { err, errorMessage, ok, type Result } from "@campaignfoundry/shared";
import { briefsDir, isErrno } from "./brief-files.js";
import { resolveConfined } from "./confined-path.js";
import { motionRatiosFor } from "./platform-zones.js";

/** Confined path `briefs/<briefId>/pools.json` — a directory, invisible to the briefs lister. */
export function poolPath(briefId: string): string {
  return resolveConfined(briefsDir(), briefId, "pools.json");
}

/** True when `briefs/<briefId>` exists and is a symlink — writes through it are refused. */
export async function isPoolDirSymlink(briefId: string): Promise<boolean> {
  try {
    return (await lstat(dirname(poolPath(briefId)))).isSymbolicLink();
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

/** Thrown by `readPool` for a pool file that parses but is not a `CopyPool`; routes map it to 422. */
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
 * Read `briefs/<briefId>/pools.json`; undefined when absent. A file that is not
 * a `CopyPool` (hand-edited) throws `InvalidCopyPoolError` naming the problem,
 * so a route answers 422 instead of a 500 from a bare `TypeError` downstream.
 */
export async function readPool(briefId: string): Promise<CopyPool | undefined> {
  let raw: string;
  try {
    raw = await readFile(poolPath(briefId), "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new InvalidCopyPoolError(briefId, `not JSON (${errorMessage(error)})`);
  }
  const problem = copyPoolProblem(parsed);
  if (problem !== undefined) throw new InvalidCopyPoolError(briefId, problem);
  return parsed as CopyPool;
}

/**
 * Atomic write: unique temp sibling then rename, so a crash never leaves
 * half-written JSON and two overlapping writers never share a temp file.
 */
export async function writePool(pool: CopyPool): Promise<void> {
  const dest = poolPath(pool.briefId);
  const tmp = `${dest}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(pool, null, 2)}\n`, "utf8");
    await rename(tmp, dest);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

const chains = new Map<string, Promise<unknown>>();

/**
 * Serialise read→merge→write sections per brief within this process, so a
 * concurrent POST/PATCH always merges into the latest file instead of
 * clobbering the other request's entries. Errors in `fn` do not poison the chain.
 */
export function withPoolLock<T>(briefId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(briefId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(briefId, settled);
  void settled.then(() => {
    if (chains.get(briefId) === settled) chains.delete(briefId);
  });
  return run;
}

/** True when the brief draws headlines from its approved copy pool. */
export function wantsHeadlinePool(brief: CampaignBrief): boolean {
  return brief.variation?.axes?.headline === HEADLINE_POOL_REF;
}

/**
 * Plan-time input for a brief — everything the brief itself cannot carry:
 * - `headlines`: the approved texts of `briefs/<id>/pools.json` when the brief
 *   requests `headline: pool://copy`. A missing pool yields no headlines — the
 *   planner then fails loud naming the pool file. An invalid pool file is an
 *   `err` carrying the `InvalidCopyPoolError` message, so plan and generate
 *   both fail loud with it.
 * - `motionRatios`: the ratios of the requested motion platforms (see
 *   `motionRatiosFor`), present only when the brief lists `output.platforms`.
 */
export async function planInputFor(brief: CampaignBrief): Promise<Result<PlanInput, Error>> {
  const motion = motionRatiosFor(brief.output?.platforms);
  if (!wantsHeadlinePool(brief)) return ok(motion);
  try {
    const pool = await readPool(brief.id);
    return ok({ headlines: pool ? approvedTexts(pool) : [], ...motion });
  } catch (error) {
    if (error instanceof InvalidCopyPoolError) return err(error);
    throw error;
  }
}

/** The variation planner with `input` (the resolved pool + platform ratios) bound for every `plan` call. */
export function pooledPlanner(input: PlanInput): VariationPlanner {
  const planner = new PlanVariationsUseCase();
  return {
    plan: (brief) => planner.plan(brief, input),
    replan: (plan, index, attempt) => planner.replan(plan, index, attempt),
  };
}
