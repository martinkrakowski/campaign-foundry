import { MOTION_KINDS, type MotionKind } from "./MotionKind.vo.js";

/**
 * The variation axes' vocabulary and defaults, in the one place both the planner and
 * the editor can read them.
 *
 * Keeping these here — a leaf with no runtime dependency beyond the motion kinds —
 * lets the web app read the domain without dragging in orchestration use cases (D18).
 * The VO re-exports every name below, so its own public surface is unchanged.
 */

/**
 * Background *axis* values from the brief parser (`procedural` | `asset-pool` | `genai`).
 * Distinct from the rendered-asset BackgroundSource (firefly/imagen/…).
 */
export const BACKGROUND_AXIS_SOURCES = ["procedural", "asset-pool", "genai"] as const;
export type BackgroundAxisSource = (typeof BACKGROUND_AXIS_SOURCES)[number];

/** The only supported pool reference for the `headline` axis. */
export const HEADLINE_POOL_REF = "pool://copy";

/**
 * The `anchor` axis: where the headline block sits vertically (plan
 * 2026-09-01, T4). The axis is optional — a brief without it derives the
 * placement from `layout` (`headline-top` → `top`, else `bottom`), which is
 * byte-identical to the pre-axis behaviour, so it must never join the hash,
 * the axis product or the draw for such a brief (D57's conditional-spread
 * pattern). The horizontal edge itself stays `layout`'s.
 */
export const ANCHOR_VALUES = ["top", "middle", "bottom"] as const;
export type AnchorKind = (typeof ANCHOR_VALUES)[number];

/**
 * `variation.occupancy` exactly as a brief AUTHORS it (SL-D2): the monotonic
 * allocation cursor, plus the slots that were deleted. It lives in this leaf so
 * the entity, the planner's VO and the editor all read one declaration and
 * cannot drift — the resolved form, with the live slots computed, is
 * `VariationOccupancy` in `VariationPolicy.vo.ts`.
 *
 * `tombstoned` is optional and means `[]`; `nextIndex` is not, because it is
 * the whole point of the block. Absent occupancy is the pre-SL1 brief and is
 * never stored: see `resolveOccupancy`.
 */
export interface AuthoredOccupancy {
  readonly nextIndex: number;
  readonly tombstoned?: readonly number[];
}

export const DEFAULT_BACKGROUND_SOURCES: readonly BackgroundAxisSource[] = ["procedural"];
export const DEFAULT_PALETTE_SHIFT: readonly number[] = [0];
/**
 * Motion axis default when `output.formats` requests "motion" but the brief
 * lists no `axes.motion`: every kind. A brief that asks for clips gets clips;
 * a static brief (no motion format) draws no motion kinds at all.
 */
export const DEFAULT_MOTION: readonly MotionKind[] = MOTION_KINDS;
/**
 * The default clip length in whole seconds, when no duration is elsewhere supplied.
 *
 * This is the one constant the whole stack reads for "how long is a clip by default",
 * exported from this browser-safe leaf so the orchestrator, the editor and the API
 * cannot drift from each other (L1): the use case and the editor previously each kept
 * a private copy that disagreed (6 vs 5). The duration *axis* default below is derived
 * from it, so a brief with no `axes.duration` runs exactly this long.
 */
export const DEFAULT_DURATION_SEC = 6;
/** Clip length in whole seconds; the parser bounds it to [2, 30]. */
export const DEFAULT_DURATION: readonly number[] = [DEFAULT_DURATION_SEC];
export const MIN_DURATION_SEC = 2;
export const MAX_DURATION_SEC = 30;

/** The largest `variation.seed`: the seeded PRNG's state is a uint32 (`SeededRandom.vo.ts`). */
export const UINT32_MAX = 0xffffffff;

/**
 * A `max` that is not a constant: `minDistance` is bounded by how many of
 * `DISTANCE_AXES` the brief actually activates, which only the policy knows.
 * The rule below says the bound is dynamic; the VO supplies the number.
 */
export const POLICY_MAX_ACTIVE_AXES = "active-axes";

/**
 * What an ABSENT key means for a policy integer — the question M3 exists to
 * answer, written down once instead of inferred from five separate `??`s:
 *
 * - `required` — there is no absence. The policy refuses the brief outright, so
 *   no value is ever substituted for the missing key.
 * - `default` — absence means exactly `value`, and the domain substitutes it.
 * - `derived` — absence means a value only the caller can compute (the seed is
 *   `seedFrom(brief.id)`), so it is neither a constant nor a refusal.
 */
export type PolicyIntegerAbsence =
  | { readonly kind: "required" }
  | { readonly kind: "default"; readonly value: number }
  | { readonly kind: "derived" };

/**
 * One free-typed policy integer's rule. `min`/`max` are the domain's own bounds
 * (`max` absent means unbounded above, and `POLICY_MAX_ACTIVE_AXES` means the
 * policy computes it); `absent` says what a missing key means; `omitWhenDefault`
 * says whether the EDITOR drops the key when the draft equals that default.
 */
export interface PolicyIntegerRule {
  /**
   * The object key the brief writes — what the editor spreads and what the
   * loader reads. For the coverage pair this is the member name inside the
   * block, not the path: `perProduct`, not `coverage.perProduct`.
   */
  readonly key: string;
  /** The same field as an error message names it — the dotted path, where there is one. */
  readonly field: string;
  readonly min: number;
  readonly max?: number | typeof POLICY_MAX_ACTIVE_AXES;
  readonly absent: PolicyIntegerAbsence;
  /**
   * Whether `toBrief` omits the key when the parsed draft equals what absence
   * already means.
   *
   * True only for the `coverage` members: `coverage` is a BLOCK whose absence
   * means both floors are 0, so writing `perProduct: 0` into it would grow the
   * document to say what its absence already says. False for `minDistance`,
   * which is a top-level key an operator authored: dropping a stored
   * `minDistance: 1` on save would rewrite every document that carries one.
   * False for `count` and `seed`, which have no constant default to equal.
   */
  readonly omitWhenDefault: boolean;
}

/**
 * **The five free-typed policy integers, and what `0` and "absent" mean for
 * each** (M3, `docs/planning/2026-09-18_creatives-as-slots.md`).
 *
 * They do NOT all agree, and they should not: `count: 0` is meaningless, a
 * `seed` of 0 is as good a seed as any, and a coverage floor of 0 is the
 * absence of a floor. What M3 closes is that the disagreement used to live in
 * five scattered `??` expressions — one in the domain VO, one per site in the
 * editor's `toBrief` — so the safety of any one field was "lossless only via a
 * domain default two packages away". Here it is one table, and both sides read
 * it: `VariationPolicy.fromBrief` resolves absence and bounds from these rules,
 * and `toBrief` decides which keys to write from them.
 *
 * Per field, the three questions and their answers:
 *
 * | field | is absent the same as 0? | is 0 legal? | where does the default come from? |
 * | --- | --- | --- | --- |
 * | `count` | no — absent is refused, and 0 is below the floor | **no** (min 1) | nowhere: the key is required |
 * | `seed` | **no** — absent is a derived seed, 0 is the seed 0 | **yes**, and it is a real seed | `seedFrom(brief.id)`, in the domain |
 * | `minDistance` | no — absent means 1, 0 is refused (SL-D6) | **no** (min 1) | this table's default of 1; the API loader reads a STORED 0 as 1 rather than refusing the document |
 * | `coverage.perProduct` | **yes** | yes — it means "no floor" | this table's default of 0 |
 * | `coverage.perRatio` | **yes** | yes — it means "no floor" | this table's default of 0 |
 *
 * The editor assumes exactly these defaults: it reads them from here.
 *
 * **Not to be confused with the editor's fresh-draft values.** A brand-new
 * variation draft starts at `count: "12"`, `minDistance: "2"`, `perProduct: "1"`,
 * `perRatio: "1"` (`fromBrief`, `apps/web/.../editor-state.ts`), and only
 * `count` agrees with anything here. Those are not absence rules: they are
 * authored values, pre-typed into the fields, and a save writes every one of
 * them down. Absence is what this table governs, and it only ever arises when a
 * field is cleared or a brief was written without the key.
 */
export const POLICY_INTEGERS = {
  /**
   * The plan's size. Required — a randomized campaign has no meaning without a
   * total (`load-brief.ts` says so too) — so absence is a refusal and never a
   * substituted number. 0 is below the floor: a plan of nothing is not a plan.
   */
  count: {
    key: "count",
    field: "count",
    min: 1,
    absent: { kind: "required" },
    omitWhenDefault: false,
  },
  /**
   * The draw's seed. The one field where 0 is emphatically NOT absence: absent
   * means `seedFrom(brief.id)`, a derived uint32 that is almost never 0, while
   * a written 0 is the seed zero and reproduces a different plan. Bounded above
   * because the PRNG's state is a uint32.
   */
  seed: {
    key: "seed",
    field: "seed",
    min: 0,
    max: UINT32_MAX,
    absent: { kind: "derived" },
    omitWhenDefault: false,
  },
  /**
   * The minimum Hamming distance between two drawn variants. **SL-D6**: the
   * floor is 1, not 0 — at 0 the searches accept two variants at the same point
   * in the axis space, so a plan could quietly contain duplicate creatives.
   * 1 is also what an absent key has always meant, so the bound refuses only an
   * EXPLICIT 0.
   *
   * **Where a 0 actually gets turned into a 1.** `apps/api/server/lib/load-brief.ts`
   * clamps `minDistance: 0` to 1 inside `validateVariation`, and that runs on
   * EVERY brief that goes through `parseBrief` — a stored document being opened,
   * yes, but equally a save, a `POST /campaigns/plan` preview and a generate.
   * Its stated reason is the stored document (refusing one would make the
   * campaign vanish from the picker rather than surface an error), and that is
   * SL-D6's decision, unmoved by this lane. The consequence worth knowing is the
   * other half: a LIVE draft typed as 0 is planned at 1 by the API while the
   * editor shows the field's own refusal. A 0 reaching this domain undefaulted
   * is therefore a caller that skipped the loader entirely — an in-process
   * caller, or a test.
   */
  minDistance: {
    key: "minDistance",
    field: "minDistance",
    min: 1,
    max: POLICY_MAX_ACTIVE_AXES,
    absent: { kind: "default", value: 1 },
    omitWhenDefault: false,
  },
  /**
   * The per-product coverage floor. Absence and 0 mean the same thing — no
   * floor — which is why the editor writes neither.
   */
  perProduct: {
    key: "perProduct",
    field: "coverage.perProduct",
    min: 0,
    absent: { kind: "default", value: 0 },
    omitWhenDefault: true,
  },
  /** The per-ratio coverage floor; absence and 0 mean the same thing. */
  perRatio: {
    key: "perRatio",
    field: "coverage.perRatio",
    min: 0,
    absent: { kind: "default", value: 0 },
    omitWhenDefault: true,
  },
} as const satisfies Record<string, PolicyIntegerRule>;

/** The five names, for a caller that wants to walk the table. */
export type PolicyIntegerName = keyof typeof POLICY_INTEGERS;
