import { homedir } from "node:os";
import { join } from "node:path";
import type { PremiseResult, PremiseStatus } from "./types.js";

export const ARTIFACT_FILE_NAME = "plan-verify.json";
export const ARTIFACT_VERSION = 1;
export const PLAN_VERIFY_ARTIFACT_ENV = "PLAN_VERIFY_ARTIFACT";
export const PROVENANCE_UNKNOWN = "unknown";

export type ArtifactScope =
  | { readonly kind: "full" }
  | { readonly kind: "partial"; readonly plans: readonly string[] };

export interface GitProvenance {
  readonly branch: string;
  readonly head: string;
}

export interface ArtifactPremiseRecord {
  readonly lane: string;
  readonly plan: string;
  readonly status: PremiseStatus;
  readonly reason?: string;
}

export interface PlanVerifyArtifact {
  readonly version: number;
  readonly at: string;
  readonly git: GitProvenance;
  readonly scope: ArtifactScope;
  readonly plans: readonly string[];
  readonly premises: readonly ArtifactPremiseRecord[];
}

export function artifactPathFor(env: Record<string, string | undefined>): string {
  const override = env[PLAN_VERIFY_ARTIFACT_ENV];
  if (override !== undefined && override !== "") {
    return override;
  }
  const root = env.WAVE_LOG_ROOT && env.WAVE_LOG_ROOT !== "" ? env.WAVE_LOG_ROOT : join(homedir(), ".waves");
  return join(root, ARTIFACT_FILE_NAME);
}

export function buildArtifact(
  results: readonly PremiseResult[],
  meta: {
    readonly at: string;
    readonly git: GitProvenance;
    readonly scope: ArtifactScope;
    readonly plans: readonly string[];
  },
): PlanVerifyArtifact {
  return {
    version: ARTIFACT_VERSION,
    at: meta.at,
    git: meta.git,
    scope: meta.scope,
    plans: meta.plans,
    premises: results.map((r) => ({
      lane: r.premise.lane,
      plan: r.premise.plan,
      status: r.status,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    })),
  };
}

export function serializeArtifact(artifact: PlanVerifyArtifact): string {
  return JSON.stringify(artifact, null, 2) + "\n";
}

export function errorText(thrown: unknown): string {
  if (thrown instanceof Error) {
    return thrown.message !== "" ? thrown.message : thrown.name;
  }
  if (typeof thrown === "string") {
    return thrown;
  }
  return String(thrown);
}

export function parseArtifact(text: string): PlanVerifyArtifact {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err: unknown) {
    throw new Error(`not valid JSON: ${errorText(err)}`);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("malformed artifact: expected object");
  }

  const record = raw as Record<string, unknown>;

  if (record.version !== ARTIFACT_VERSION) {
    throw new Error(`malformed artifact: unexpected version ${String(record.version)}`);
  }

  if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))) {
    throw new Error("malformed artifact: invalid or missing at");
  }

  if (typeof record.git !== "object" || record.git === null || Array.isArray(record.git)) {
    throw new Error("malformed artifact: missing git provenance");
  }

  const rawGit = record.git as Record<string, unknown>;
  if (typeof rawGit.head !== "string" || rawGit.head === "") {
    throw new Error("malformed artifact: git provenance missing head");
  }
  const git: GitProvenance = {
    branch: String(rawGit.branch),
    head: rawGit.head,
  };

  if (typeof record.scope !== "object" || record.scope === null || Array.isArray(record.scope)) {
    throw new Error("malformed artifact: missing scope");
  }

  const rawScope = record.scope as Record<string, unknown>;
  let scope: ArtifactScope;
  if (rawScope.kind === "full") {
    if ("plans" in rawScope) {
      throw new Error("malformed artifact: full scope cannot have plans");
    }
    scope = { kind: "full" };
  } else if (rawScope.kind === "partial") {
    if (!Array.isArray(rawScope.plans)) {
      throw new Error("malformed artifact: partial scope missing plans array");
    }
    scope = { kind: "partial", plans: [...rawScope.plans as readonly string[]] };
  } else {
    throw new Error("malformed artifact: unknown scope kind");
  }

  if (!Array.isArray(record.plans)) {
    throw new Error("malformed artifact: plans must be an array");
  }
  for (const p of record.plans) {
    if (typeof p !== "string") {
      throw new Error("malformed artifact: plan entry must be a string");
    }
  }

  if (!Array.isArray(record.premises)) {
    throw new Error("malformed artifact: premises must be an array");
  }

  const premises: ArtifactPremiseRecord[] = [];
  for (const item of record.premises) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("malformed artifact: premise entry must be an object");
    }
    const rawItem = item as Record<string, unknown>;
    if (typeof rawItem.lane !== "string" || rawItem.lane === "") {
      throw new Error("malformed artifact: premise entry missing lane");
    }
    if (rawItem.status !== "holds" && rawItem.status !== "stale" && rawItem.status !== "timed-out" && rawItem.status !== "error") {
      throw new Error("malformed artifact: premise entry has invalid status");
    }
    if ("reason" in rawItem) {
      if (typeof rawItem.reason !== "string") {
        throw new Error("malformed artifact: premise reason must be a string");
      }
    }
    premises.push({
      lane: rawItem.lane,
      plan: String(rawItem.plan),
      status: rawItem.status,
      ...(typeof rawItem.reason === "string" ? { reason: rawItem.reason } : {}),
    });
  }

  return {
    version: ARTIFACT_VERSION,
    at: record.at,
    git,
    scope,
    plans: [...record.plans],
    premises,
  };
}
