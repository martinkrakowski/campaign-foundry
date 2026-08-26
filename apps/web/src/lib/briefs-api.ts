import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { API } from "./run-context";

export interface BriefEntry {
  file: string;
  brief: CampaignBrief;
}

export interface BriefWriteResult {
  file: string;
  brief: CampaignBrief;
}

export interface AssetUploadResult {
  path: string;
}

export interface PlanEstimate {
  creatives: number;
  axisProductSize: number;
  feasible: boolean;
  genaiCalls: number;
}

export type PlanResult =
  | { kind: "ok"; policyHash: string; seed: number; estimate: PlanEstimate; variants: unknown[] }
  | { kind: "infeasible"; error: string }
  | { kind: "unavailable" };

/** HTTP error whose message is the API `{ error }` string when present. */
export class BriefsApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BriefsApiError";
    this.status = status;
  }
}

export function isBriefsApiError(error: unknown): error is BriefsApiError {
  return error instanceof BriefsApiError;
}

export function unknownErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function parseJsonBody(res: Response): Promise<unknown> {
  const raw = await res.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function errorFrom(data: unknown, fallback: string): string {
  if (typeof data === "object" && data !== null) {
    const message = (data as { error?: unknown }).error;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new BriefsApiError("Network error", 0);
  }
  const data = await parseJsonBody(res);
  if (!res.ok) {
    throw new BriefsApiError(errorFrom(data, `Request failed (HTTP ${res.status})`), res.status);
  }
  return data;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function asWriteResult(data: unknown): BriefWriteResult {
  if (typeof data !== "object" || data === null) {
    throw new BriefsApiError("Invalid response", 200);
  }
  const rec = data as { file?: unknown; brief?: unknown };
  if (typeof rec.file !== "string" || typeof rec.brief !== "object" || rec.brief === null) {
    throw new BriefsApiError("Invalid response", 200);
  }
  return { file: rec.file, brief: rec.brief as CampaignBrief };
}

export async function listBriefs(): Promise<BriefEntry[]> {
  const data = await requestJson(`${API}/campaigns/briefs`);
  if (typeof data !== "object" || data === null) return [];
  const briefs = (data as { briefs?: unknown }).briefs;
  return Array.isArray(briefs) ? (briefs as BriefEntry[]) : [];
}

export async function createBrief(
  brief: CampaignBrief,
  opts: { replace?: boolean } = {},
): Promise<BriefWriteResult> {
  const query = opts.replace ? "?replace=1" : "";
  return asWriteResult(await requestJson(`${API}/campaigns/briefs${query}`, jsonInit("POST", brief)));
}

export async function updateBrief(id: string, brief: CampaignBrief): Promise<BriefWriteResult> {
  return asWriteResult(
    await requestJson(`${API}/campaigns/briefs/${encodeURIComponent(id)}`, jsonInit("PUT", brief)),
  );
}

export async function duplicateBrief(id: string, newId: string): Promise<BriefWriteResult> {
  return asWriteResult(
    await requestJson(
      `${API}/campaigns/briefs/${encodeURIComponent(id)}/duplicate`,
      jsonInit("POST", { newId }),
    ),
  );
}

export async function uploadAsset(input: {
  briefId: string;
  name: string;
  contentBase64: string;
}): Promise<AssetUploadResult> {
  const data = await requestJson(`${API}/campaigns/assets`, jsonInit("POST", input));
  if (typeof data !== "object" || data === null || typeof (data as { path?: unknown }).path !== "string") {
    throw new BriefsApiError("Invalid response", 200);
  }
  return { path: (data as { path: string }).path };
}

function isEstimate(value: unknown): value is PlanEstimate {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.creatives === "number" &&
    typeof rec.axisProductSize === "number" &&
    typeof rec.feasible === "boolean" &&
    typeof rec.genaiCalls === "number"
  );
}

/**
 * Dry-run the variation planner. 404 and network failure are "estimate unavailable"
 * (lane A's route may not exist on this branch) — never a thrown wizard-breaking error.
 */
export async function planCampaign(brief: CampaignBrief, signal?: AbortSignal): Promise<PlanResult> {
  let res: Response;
  try {
    res = await fetch(`${API}/campaigns/plan`, { ...jsonInit("POST", brief), signal });
  } catch {
    return { kind: "unavailable" };
  }
  if (res.status === 404) return { kind: "unavailable" };
  const data = await parseJsonBody(res);
  if (res.status === 422) {
    return { kind: "infeasible", error: errorFrom(data, "Variation plan is not feasible.") };
  }
  if (!res.ok) {
    if (res.status >= 500) return { kind: "unavailable" };
    return { kind: "infeasible", error: errorFrom(data, `Plan failed (HTTP ${res.status})`) };
  }
  if (typeof data !== "object" || data === null) return { kind: "unavailable" };
  const rec = data as Record<string, unknown>;
  if (typeof rec.policyHash !== "string" || typeof rec.seed !== "number" || !isEstimate(rec.estimate)) {
    return { kind: "unavailable" };
  }
  return {
    kind: "ok",
    policyHash: rec.policyHash,
    seed: rec.seed,
    estimate: rec.estimate,
    variants: Array.isArray(rec.variants) ? rec.variants : [],
  };
}
