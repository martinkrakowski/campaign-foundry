import type {
  CampaignBrief,
  CopyPool,
  CopyPoolEntryStatus,
} from "@campaignfoundry/CampaignOrchestration";

export type {
  CopyPool,
  CopyPoolEntry,
  CopyPoolEntryStatus,
} from "@campaignfoundry/CampaignOrchestration";

/** Same path as run-context `API`. Local so RunProvider can import these helpers without a cycle. */
const API = "/api/pipeline";

export interface BriefEntry {
  file: string;
  brief: CampaignBrief;
  /** SHA-256 of the file's bytes, for the conditional write (API E1.0). */
  revision?: string;
}

export interface AssetUploadResult {
  path: string;
}

/** What this host can produce, from the API's boot probe (`GET /campaigns/capabilities`). */
export interface HostCapabilities {
  motion: boolean;
  reason?: string;
  /** The probe's ffmpeg version, when it could read one. Additive: absent on older hosts. */
  version?: string;
  /** Auth capabilities reported by the host (PT-1b1, PT-1b2). */
  auth?: {
    mode: "local" | "better-auth";
    google: boolean;
  };
}

/** Delay between retries while the probe's answer is still "not probed". */
export const CAPABILITIES_RETRY_MS = 150;
/** Give-up point for the boot-probe window; a later focus refetch gets another round. */
export const CAPABILITIES_MAX_RETRIES = 3;

/**
 * The capabilities route answers during the boot probe window with
 * `{ motion: false, reason: "not probed" }`. That is a transient snapshot, not a
 * verdict — treat it as retry-able rather than disabling motion on its strength.
 */
export function isTransientCapabilities(capabilities: HostCapabilities): boolean {
  return !capabilities.motion && capabilities.reason === "not probed";
}

/**
 * The host's capabilities, or `null` when they cannot be known (route missing,
 * network failure, malformed payload). `null` leaves the editor ungated — an
 * unreachable probe must not read as "this host cannot do motion".
 */
export async function getCapabilities(): Promise<HostCapabilities | null> {
  let res: Response;
  try {
    res = await fetch(`${API}/campaigns/capabilities`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  // The body is a stream: it can still fail after fetch resolved. A rejection here
  // would escape into the caller's `void load()` as an unhandled rejection and leave
  // capabilities unresolved, so degrade to "unknown" like every other failure.
  let data: unknown;
  try {
    data = await parseJsonBody(res);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const motion = (data as { motion?: unknown }).motion;
  if (typeof motion !== "boolean") return null;
  const reason = (data as { reason?: unknown }).reason;
  const version = (data as { version?: unknown }).version;
  const rawAuth = (data as { auth?: unknown }).auth;
  const auth =
    typeof rawAuth === "object" &&
    rawAuth !== null &&
    ((rawAuth as { mode?: unknown }).mode === "local" ||
      (rawAuth as { mode?: unknown }).mode === "better-auth") &&
    typeof (rawAuth as { google?: unknown }).google === "boolean"
      ? {
          mode: (rawAuth as { mode: "local" | "better-auth" }).mode,
          google: (rawAuth as { google: boolean }).google,
        }
      : undefined;
  // Rebuilding the object rather than passing `data` through is deliberate — it is
  // untrusted JSON — but every field the UI shows has to be carried across, or the
  // component that renders it is dead code that still reaches 100% coverage.
  return {
    motion,
    ...(typeof reason === "string" ? { reason } : {}),
    ...(typeof version === "string" ? { version } : {}),
    ...(auth !== undefined ? { auth } : {}),
  };
}

export interface PlanEstimate {
  creatives: number;
  axisProductSize: number;
  feasible: boolean;
  genaiCalls: number;
  /** Frames to encode — motion plans only. */
  frames?: number;
  /**
   * VE5b2 — mirrors `VariationEstimate.sceneBackgrounds` (VariationPlan.vo.ts:19):
   * present, and `true`, only when the plan's timeline names at least one per-beat
   * background — PlanVariationsUseCase.use-case.ts:307 sets it with a conditional
   * spread that never writes `false`, so a scene-free plan's JSON stays
   * byte-identical. `isEstimate` below does not validate this field — same as the
   * pre-existing `frames` — so it is not normalised here either; a payload that
   * disagrees with the contract passes through unchanged, and `estimateSentence`
   * reads it with `=== true`, never truthiness.
   */
  sceneBackgrounds?: true;
}

/**
 * One planned creative, as `plan.post.ts:57-70` serializes it.
 *
 * SL3 widened this from the two fields the estimate's ratio split read to the
 * whole serialized shape, because the sidebar's creatives list is a row per
 * planned creative and every field it shows comes from here. **Every field stays
 * optional, and that is not laziness**: `planCampaign` does not validate the
 * array (`variants: Array.isArray(rec.variants) ? rec.variants : []`, below) — it
 * is an unchecked cast over whatever the route answered. Declaring `index:
 * number` would let a consumer key a row on a value the parse never checked. So
 * the list guards `typeof index === "number"` at the point it keys on it, and a
 * variant without one is not a row.
 *
 * `index` is the SLOT (SL-D1: identity in variation mode is `productId` +
 * `index`), monotonic and holey since SL2 — never the array position.
 */
export interface PlanVariant {
  readonly index?: number;
  readonly aspectRatio?: string;
  readonly productId?: string;
  readonly layout?: string;
  readonly tone?: string;
  readonly backgroundSource?: string;
  readonly paletteShift?: number;
  readonly headline?: string;
  readonly motion?: string;
  readonly durationSec?: number;
}

export type PlanResult =
  | {
      kind: "ok";
      policyHash: string;
      seed: number;
      estimate: PlanEstimate;
      variants: PlanVariant[];
    }
  | { kind: "infeasible"; error: string }
  | { kind: "unavailable" };

/** HTTP error whose message is the API `{ error }` string when present. */
export class BriefsApiError extends Error {
  readonly status: number;
  /**
   * The fresh revision a 409 conflict carries in its body — the store's answer to
   * "what is there now". Absent on every other failure. The client drops it only
   * if it never reads it: it is what lets the next Save answer the conditional
   * write instead of the user reloading.
   */
  readonly revision?: string;
  /** Error code from the API (e.g. "unauthenticated" or "no_membership"). */
  readonly code?: string;

  constructor(message: string, status: number, revision?: string, code?: string) {
    super(message);
    this.name = "BriefsApiError";
    this.status = status;
    if (revision !== undefined) this.revision = revision;
    if (code !== undefined) this.code = code;
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
    // A conflict body carries the store's fresh revision alongside `error` (API E1.0);
    // every other failure has none. Parse it here, once, so callers can adopt it.
    const revision =
      typeof data === "object" &&
      data !== null &&
      typeof (data as { revision?: unknown }).revision === "string"
        ? (data as { revision: string }).revision
        : undefined;
    const code =
      typeof data === "object" &&
      data !== null &&
      typeof (data as { code?: unknown }).code === "string"
        ? (data as { code: string }).code
        : undefined;

    if (res.status === 401 && (code === "unauthenticated" || code === undefined)) {
      if (typeof window !== "undefined") {
        window.location.assign("/sign-in");
      }
    }

    throw new BriefsApiError(
      errorFrom(data, `Request failed (HTTP ${res.status})`),
      res.status,
      revision,
      code,
    );
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

function asBriefEntry(data: unknown): BriefEntry {
  if (typeof data !== "object" || data === null) {
    throw new BriefsApiError("Invalid response", 200);
  }
  const rec = data as { file?: unknown; brief?: unknown; revision?: unknown };
  // `typeof [] === "object"`, and listing consumers read `brief.products.length`.
  if (
    typeof rec.file !== "string" ||
    typeof rec.brief !== "object" ||
    rec.brief === null ||
    Array.isArray(rec.brief)
  ) {
    throw new BriefsApiError("Invalid response", 200);
  }
  if (!Array.isArray((rec.brief as { products?: unknown }).products)) {
    throw new BriefsApiError("Invalid response", 200);
  }
  const entry: BriefEntry = { file: rec.file, brief: rec.brief as CampaignBrief };
  return typeof rec.revision === "string" ? { ...entry, revision: rec.revision } : entry;
}

export async function listBriefs(): Promise<BriefEntry[]> {
  const data = await requestJson(`${API}/campaigns/briefs`);
  if (typeof data !== "object" || data === null) return [];
  const briefs = (data as { briefs?: unknown }).briefs;
  if (!Array.isArray(briefs)) return [];
  // Same per-entry shape check the single-entry callers use: a malformed 200 body
  // must throw into the picker's error path, not reach a field access in render.
  return briefs.map(asBriefEntry);
}

export async function createBrief(
  brief: CampaignBrief,
  opts: { replace?: boolean } = {},
): Promise<BriefEntry> {
  const query = opts.replace ? "?replace=1" : "";
  return asBriefEntry(
    await requestJson(`${API}/campaigns/briefs${query}`, jsonInit("POST", brief)),
  );
}

export async function updateBrief(
  id: string,
  brief: CampaignBrief,
  opts: { revision?: string } = {},
): Promise<BriefEntry> {
  const query = opts.revision ? `?revision=${opts.revision}` : "";
  return asBriefEntry(
    await requestJson(
      `${API}/campaigns/briefs/${encodeURIComponent(id)}${query}`,
      jsonInit("PUT", brief),
    ),
  );
}

/**
 * D71 — the duplicate contract's overrides, exactly the route's own: region and
 * audience only. Anything else (notably `mode`) is a 400 — the copy inherits the
 * source's mode.
 */
export interface DuplicateOverrides {
  readonly targetRegion?: string;
  readonly targetAudience?: string;
}

export async function duplicateBrief(
  id: string,
  newId: string,
  overrides?: DuplicateOverrides,
): Promise<BriefEntry> {
  return asBriefEntry(
    await requestJson(
      `${API}/campaigns/briefs/${encodeURIComponent(id)}/duplicate`,
      jsonInit("POST", { newId, overrides }),
    ),
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AssetEntry {
  name: string;
  type: string;
  size: number;
  thumbnailUrl: string;
}

export async function uploadAsset(input: {
  briefId: string;
  name: string;
  contentBase64: string;
}): Promise<AssetUploadResult> {
  const data = await requestJson(`${API}/campaigns/assets`, jsonInit("POST", input));
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as { path?: unknown }).path !== "string"
  ) {
    throw new BriefsApiError("Invalid response", 200);
  }
  return { path: (data as { path: string }).path };
}

/**
 * List assets stored for a campaign brief (`GET /campaigns/assets?briefId=`).
 * 404 is treated as an empty list, matching the other collection routes.
 */
export async function listAssets(
  briefId: string,
  signal?: AbortSignal,
): Promise<{ assets: AssetEntry[] }> {
  let res: Response;
  try {
    res = await fetch(`${API}/campaigns/assets?briefId=${encodeURIComponent(briefId)}`, { signal });
  } catch {
    throw new BriefsApiError("Network error", 0);
  }
  if (res.status === 404) return { assets: [] };
  const data = await parseJsonBody(res);
  if (!res.ok) {
    throw new BriefsApiError(errorFrom(data, `Request failed (HTTP ${res.status})`), res.status);
  }
  if (
    typeof data !== "object" ||
    data === null ||
    !Array.isArray((data as { assets?: unknown }).assets)
  ) {
    return { assets: [] };
  }
  return data as { assets: AssetEntry[] };
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
export async function planCampaign(
  brief: CampaignBrief,
  signal?: AbortSignal,
): Promise<PlanResult> {
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
  if (
    typeof rec.policyHash !== "string" ||
    typeof rec.seed !== "number" ||
    !isEstimate(rec.estimate)
  ) {
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

/** One copied creative in a platform package (mirrors Distribution PackageManifestItem). */
export interface PackageItem {
  productId: string;
  /** The social canvas. Display items carry `size` instead (D113) — exactly one of the two. */
  aspectRatio?: string;
  /** The display family's canvas (the `728x90` form); ratio items omit it. */
  size?: string;
  treatment: string;
  format?: "static" | "motion" | "html";
  source: string;
  packagedPath: string;
  posterPath?: string;
  /** Packaged raster fallback of an html item (D122). */
  fallbackPath?: string;
  durationSec?: number;
  bytes: number;
  checks: { size: "pass" | "fail"; duration?: "pass" | "fail" };
}

/** One platform's package, from POST /campaigns/package or GET /campaigns/packages/:id. */
export interface PackagedPlatform {
  platformId: string;
  items: PackageItem[];
  skipped?: number;
  manifestPath?: string;
}

function isPackageItem(value: unknown): value is PackageItem {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  const checks = rec.checks;
  if (typeof checks !== "object" || checks === null) return false;
  const size = (checks as { size?: unknown }).size;
  // The canvas is a social ratio or a display size (D113) — exactly one of the two.
  const hasRatio = typeof rec.aspectRatio === "string";
  const hasSize = typeof rec.size === "string";
  return (
    typeof rec.productId === "string" &&
    hasRatio !== hasSize &&
    typeof rec.treatment === "string" &&
    typeof rec.source === "string" &&
    typeof rec.packagedPath === "string" &&
    typeof rec.bytes === "number" &&
    (size === "pass" || size === "fail")
  );
}

function asPackagedPlatforms(data: unknown): PackagedPlatform[] {
  if (typeof data !== "object" || data === null) return [];
  const platforms = (data as { platforms?: unknown }).platforms;
  if (!Array.isArray(platforms)) return [];
  const out: PackagedPlatform[] = [];
  for (const entry of platforms) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.platformId !== "string" || !Array.isArray(rec.items)) continue;
    const platform: PackagedPlatform = {
      platformId: rec.platformId,
      items: rec.items.filter(isPackageItem),
    };
    if (typeof rec.skipped === "number") platform.skipped = rec.skipped;
    if (typeof rec.manifestPath === "string") platform.manifestPath = rec.manifestPath;
    out.push(platform);
  }
  return out;
}

/**
 * Copy a run's renders into per-platform folders. Never re-renders. `include`
 * is the list of approved asset keys; omitted packages every asset.
 */
export async function packageCampaign(
  campaignId: string,
  platforms: readonly string[],
  opts: { include?: readonly string[]; signal?: AbortSignal } = {},
): Promise<{ platforms: PackagedPlatform[] }> {
  const body =
    opts.include === undefined
      ? { campaignId, platforms }
      : { campaignId, platforms, include: opts.include };
  const data = await requestJson(`${API}/campaigns/package`, {
    ...jsonInit("POST", body),
    signal: opts.signal,
  });
  return { platforms: asPackagedPlatforms(data) };
}

/**
 * List persisted platform manifests for a campaign. 404 (nothing packaged yet)
 * is an empty list, not an error.
 */
export async function listPackages(
  campaignId: string,
  signal?: AbortSignal,
): Promise<{ platforms: PackagedPlatform[] }> {
  let res: Response;
  try {
    res = await fetch(`${API}/campaigns/packages/${encodeURIComponent(campaignId)}`, { signal });
  } catch {
    throw new BriefsApiError("Network error", 0);
  }
  if (res.status === 404) return { platforms: [] };
  const data = await parseJsonBody(res);
  if (!res.ok) {
    throw new BriefsApiError(errorFrom(data, `Request failed (HTTP ${res.status})`), res.status);
  }
  return { platforms: asPackagedPlatforms(data) };
}

/** One HITL change for PATCH /campaigns/pools/:briefId (text re-runs the legal gate). */
export interface PoolEntryPatch {
  id: string;
  status: CopyPoolEntryStatus;
  text?: string;
}

/**
 * A pool as the API stores it, with the revision of the bytes it was read from
 * (API E1.0, for pools). Absent on a host that predates it.
 */
export interface StoredPool {
  pool: CopyPool;
  revision?: string;
}

/** Default suggestion batch for POST /campaigns/pools/copy (the API's own default). */
export const POOL_SUGGESTION_COUNT = 10;

function asStoredPool(data: unknown): StoredPool {
  if (typeof data !== "object" || data === null) throw new BriefsApiError("Invalid response", 200);
  const pool = (data as { pool?: unknown }).pool;
  if (
    typeof pool !== "object" ||
    pool === null ||
    !Array.isArray((pool as { entries?: unknown }).entries)
  ) {
    throw new BriefsApiError("Invalid response", 200);
  }
  const revision = (data as { revision?: unknown }).revision;
  return typeof revision === "string"
    ? { pool: pool as CopyPool, revision }
    : { pool: pool as CopyPool };
}

/**
 * The brief's copy pool and its revision; 404 (nothing generated yet) is `null`,
 * not an error. The revision is what the next write guards itself with.
 */
export async function getPool(briefId: string, signal?: AbortSignal): Promise<StoredPool | null> {
  let res: Response;
  try {
    res = await fetch(`${API}/campaigns/pools/${encodeURIComponent(briefId)}`, { signal });
  } catch {
    throw new BriefsApiError("Network error", 0);
  }
  if (res.status === 404) return null;
  const data = await parseJsonBody(res);
  if (!res.ok) {
    throw new BriefsApiError(errorFrom(data, `Request failed (HTTP ${res.status})`), res.status);
  }
  return asStoredPool(data);
}

/**
 * Generate `count` headline suggestions into the pool (legal-gated server-side).
 * The brief is sent inline — the model needs its products and message, and the
 * pool is stored under `brief.id` — so the wizard can generate before Save.
 * Without OPENROUTER_API_KEY the API answers 503 — surfaced as a BriefsApiError.
 * `opts.revision` guards the merge: a stale one is a 409 carrying the fresh
 * revision, so a concurrent edit is not silently overwritten.
 */
export async function generatePool(
  brief: CampaignBrief,
  count = POOL_SUGGESTION_COUNT,
  opts: { revision?: string } = {},
): Promise<StoredPool & { added: number }> {
  const query = opts.revision ? `?revision=${encodeURIComponent(opts.revision)}` : "";
  const data = await requestJson(
    `${API}/campaigns/pools/copy${query}`,
    jsonInit("POST", { brief, count }),
  );
  const added = (data as { added?: unknown }).added;
  return { ...asStoredPool(data), added: typeof added === "number" ? added : 0 };
}

/**
 * Approve / reject / edit pool entries by id. `opts.revision` guards the write:
 * a stale one is a 409 carrying the fresh revision, so a concurrent edit is not
 * silently overwritten.
 */
export async function patchPool(
  briefId: string,
  entries: readonly PoolEntryPatch[],
  opts: { revision?: string } = {},
): Promise<StoredPool> {
  const query = opts.revision ? `?revision=${encodeURIComponent(opts.revision)}` : "";
  return asStoredPool(
    await requestJson(
      `${API}/campaigns/pools/${encodeURIComponent(briefId)}${query}`,
      jsonInit("PATCH", { entries }),
    ),
  );
}
