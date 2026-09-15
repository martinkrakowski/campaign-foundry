/**
 * Music rights record for a brief's optional audio bed (VE-D8).
 *
 * A missing licence is a legal fact, not a warning: load refuses a brief that
 * cannot name who granted the licence. The fields that scope it (expiry,
 * territory) travel with the generated asset all the way to packaging so the
 * legal gate and the post-render re-check at packaging can each answer "is
 * this still cleared?" without re-parsing the brief.
 */
export interface AudioRights {
  /** Identifier for the licence with the rights holder. Required — a missing licence is a legal fact. */
  readonly licenceId: string;
  /** Who granted the licence (a vendor, a library, the artist). Required alongside `licenceId`. */
  readonly source: string;
  /**
   * ISO-8601 date or date-time the licence stops covering use. Absent means no
   * expiry. Checked twice: the legal gate halts a run once `now()` reaches it,
   * and packaging re-checks against the run's `packagedAt` because packaging
   * can happen well after the run (D11 — it never re-renders).
   */
  readonly expiresOn?: string;
  /**
   * ISO 3166-1 alpha-2 codes the licence covers. Absent means worldwide. When
   * present it must be non-empty, and the brief's own `targetRegion` must
   * itself be alpha-2 — `targetRegion` is free text (`CampaignBrief.ts:24`),
   * so it cannot otherwise be matched against this set (load refuses the
   * mismatch; the legal gate halts on non-membership).
   */
  readonly territories?: readonly string[];
}

const ALPHA2_PATTERN = /^[A-Z]{2}$/;

/** `true` when `code` is exactly two uppercase ASCII letters (ISO 3166-1 alpha-2). */
export function isAlpha2(code: string): boolean {
  return ALPHA2_PATTERN.test(code);
}

/**
 * `targetRegion`, trimmed and upper-cased — the shape the territory check
 * compares, never the raw brief value. Tolerant of the D15 leniency that lets
 * `targetRegion` be `null` on a half-written brief: `?? ""` fails the alpha-2
 * test rather than throwing on `.trim()`.
 */
export function normalizeRegion(targetRegion: string | null | undefined): string {
  return (targetRegion ?? "").trim().toUpperCase();
}

/**
 * Strict ISO-8601 date or date-time: `YYYY-MM-DD`, optionally followed by
 * `THH:MM:SS`, optional fractional seconds, and an optional `Z`/`±HH:MM`
 * offset. Narrower than what `Date.parse` alone accepts (e.g. "March 3 2024"
 * parses in most engines) so a malformed date is refused at load rather than
 * silently accepted in one engine's grammar and not another's.
 */
const EXPIRES_ON_PATTERN =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Parses `expiresOn` to epoch milliseconds, or `undefined` when it is not that shape. */
export function parseExpiresOnMs(value: string): number | undefined {
  if (!EXPIRES_ON_PATTERN.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * `true` when `expiresOnMs` is strictly before `atMs` — the one halt/refuse
 * comparison shared by the legal gate (against `now()`) and packaging
 * (against `packagedAt`). Equal to the instant is still covered.
 */
export function isExpired(expiresOnMs: number, atMs: number): boolean {
  return expiresOnMs < atMs;
}

/**
 * `true` when `targetRegion` is covered by `territories` — absent
 * `territories` means worldwide, always covered. The legal gate halts a run
 * when this is `false`. Load already refused any brief where `targetRegion`
 * itself is not alpha-2 while `territories` is present, so a well-formed
 * brief compares two alpha-2 codes here; a brief that reaches the use case
 * without going through load (tests only) compares whatever it was given,
 * which fails membership rather than throwing.
 */
export function territoryCovered(
  targetRegion: string | null | undefined,
  territories: readonly string[] | undefined,
): boolean {
  if (territories === undefined) return true;
  return territories.includes(normalizeRegion(targetRegion));
}

/**
 * Structural type guard for a persisted `audioRights` value — used by the
 * report guard (`isPersistedAsset`) so a hand-edited or corrupt report.json
 * with a malformed rights record is skipped (and counted), the same failure
 * mode as a motion row without a readable video path, never a thrown error.
 */
export function isAudioRights(value: unknown): value is AudioRights {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.licenceId !== "string" || rec.licenceId.length === 0) return false;
  if (typeof rec.source !== "string" || rec.source.length === 0) return false;
  if (rec.expiresOn !== undefined) {
    if (typeof rec.expiresOn !== "string" || parseExpiresOnMs(rec.expiresOn) === undefined) return false;
  }
  if (rec.territories !== undefined) {
    if (!Array.isArray(rec.territories) || rec.territories.length === 0) return false;
    if (!rec.territories.every((t) => typeof t === "string" && isAlpha2(t))) return false;
  }
  return true;
}
