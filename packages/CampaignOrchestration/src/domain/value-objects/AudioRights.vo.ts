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

/**
 * ISO 3166-1's user-assigned codes: `AA`, `QM`-`QZ`, `XA`-`XZ`, `ZZ` — reserved
 * for private use and never assigned to a country or territory. Expressed as a
 * pattern/range rule, not a pasted list — this is not a country-assignment
 * check (real assignment is not verified; `QA`, for one, is a real, assigned
 * code and correctly stays outside this pattern).
 */
const USER_ASSIGNED_PATTERN = /^(?:AA|Q[M-Z]|X[A-Z]|ZZ)$/;

/**
 * `true` when `code` is exactly two uppercase ASCII letters (ISO 3166-1 alpha-2)
 * AND is not one of the ISO 3166-1 user-assigned codes (`AA`, `QM`-`QZ`,
 * `XA`-`XZ`, `ZZ`) reserved for private use. Shape-checked only — whether a
 * code is actually *assigned* to a country is not verified (VE-D8).
 */
export function isAlpha2(code: string): boolean {
  return ALPHA2_PATTERN.test(code) && !USER_ASSIGNED_PATTERN.test(code);
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
 * `THH:MM:SS`, optional fractional seconds, and — when a time is present — a
 * **required** `Z`/`±HH:MM` offset. Narrower than what `Date.parse` alone
 * accepts (e.g. "March 3 2024" parses in most engines, and an offset-less
 * date-time parses as the *host's local time*) so a malformed or
 * timezone-ambiguous value is refused at load rather than silently accepted
 * in one engine's grammar, or one server's timezone, and not another's. A
 * date-time with no offset is refused outright — there is no tolerant
 * fallback — because there is no correct instant to assign it.
 */
const EXPIRES_ON_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/**
 * `true` when `year`-`month`-`day` (1-indexed month) is a real Gregorian
 * calendar date. Checked on the digits as written, never on a value `Date`
 * has already normalised — `Date.UTC(2026, 1, 30)` (Feb 30) silently rolls
 * over to March 2, which is exactly the failure this guards against.
 */
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/**
 * Parses `expiresOn` to epoch milliseconds, or `undefined` when it is not a
 * valid, unambiguous ISO-8601 date or date-time (VE-D8 fix2 #1/#2).
 *
 * A date-only value (`YYYY-MM-DD`, no time) is UTC and **valid through the
 * end of that day**: "expires on 2026-06-30" reads as "good through June
 * 30", not "expires at its first instant" — so it resolves to
 * `2026-06-30T23:59:59.999Z`, the same instant `isExpired` then compares
 * against at both the legal gate and packaging. A date-time always carries an
 * explicit `Z` or offset (the pattern above admits nothing else), so it needs
 * no such rule — it already names one instant.
 */
export function parseExpiresOnMs(value: string): number | undefined {
  const match = EXPIRES_ON_PATTERN.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) return undefined;

  if (!value.includes("T")) {
    return Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  }
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

/** The only keys a persisted `audio` block, and its nested `rights` record, may
 * carry — the boundary's own allow-list (`validateAudio` in load-brief.ts),
 * restated here so a caller checking the FULL contract (not just `rights`)
 * cannot drift from what the API load path refuses. */
const AUDIO_KEYS = ["path", "rights"] as const;
const AUDIO_RIGHTS_KEYS = ["licenceId", "source", "expiresOn", "territories"] as const;

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/**
 * `true` when `value` is a complete, boundary-legal `audio` block: a plain
 * object carrying only `path`/`rights`, whose `path` is a non-empty string and
 * whose `rights` carries only the rights vocabulary and passes `isAudioRights`
 * (VE-D8 fix3). This is the FULL contract `parseBrief` enforces on load/save —
 * narrower than `isAudioRights` alone, which only proves the nested `rights`
 * record. A caller retaining a stored or loaded `audio` value (the editor's
 * draft recovery, a loaded brief carried through untouched) reuses this rather
 * than a second, drifting copy of the rules: a record this refuses is one
 * `parseBrief` would refuse too, so it must be dropped before it can produce a
 * save the user cannot repair or clear.
 */
export function isAudio(
  value: unknown,
): value is { path: string; rights: AudioRights } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (!hasOnlyKeys(rec, AUDIO_KEYS)) return false;
  if (typeof rec.path !== "string" || rec.path.length === 0) return false;
  const rights = rec.rights;
  if (typeof rights !== "object" || rights === null || Array.isArray(rights)) return false;
  if (!hasOnlyKeys(rights as Record<string, unknown>, AUDIO_RIGHTS_KEYS)) return false;
  return isAudioRights(rights);
}
