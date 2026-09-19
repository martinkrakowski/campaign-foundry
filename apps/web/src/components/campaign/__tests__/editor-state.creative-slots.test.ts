import { describe, test, expect } from "vitest";
import type {
  CampaignBrief,
  CampaignType,
  PlanInput,
} from "@campaignfoundry/CampaignOrchestration";
import { PlanVariationsUseCase } from "@campaignfoundry/CampaignOrchestration";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import {
  editorReducer,
  fromBrief,
  toBrief,
  draftOccupancy,
  canAddCreative,
  type EditorAction,
  type EditorState,
} from "../editor-state";
// The same cross-app import `editor-state.test.ts` makes, for the same reason: a
// mirror without the thing it mirrors is exactly the drift these tests exist to
// catch. `parseBrief` is the gate the real route puts in front of the planner, so
// the projection is driven through it before it is planned.
import { parseBrief } from "../../../../../api/server/lib/load-brief";
import { motionRatiosFor } from "../../../../../api/server/lib/platform-zones";

/**
 * **SL4 — the two gestures, measured against the REAL planner.**
 *
 * The React suite (`brief-editor.creatives.test.tsx`) drives the buttons and a
 * mocked `/campaigns/plan`, which can assert what the editor SENDS but never
 * what the draw does with it: a fixture cannot prove that deleting one creative
 * leaves the others byte-identical, because the fixture is the answer.
 *
 * So this file goes gesture → `toBrief` → `parseBrief` → `PlanVariationsUseCase`
 * and asserts the plans on both sides of the gesture. It is still a test of the
 * gesture — the gesture IS the action, and every brief below is a projection of
 * a draft the reducer produced, never a hand-written occupancy block.
 */

const reduce = (state: EditorState, ...actions: EditorAction[]): EditorState =>
  actions.reduce(editorReducer, state);

/**
 * A stub hasher. The policy hash is provenance — it is not in the variants, and
 * SL2's replay is explicitly not a function of occupancy — so the domain's
 * `nodeCryptoPolicyHasher` would only put node's crypto inside a happy-dom
 * project to compute a string nothing here reads. Deterministic, so the two
 * plans in a comparison are hashed the same way.
 */
const hasher = (payload: string): string => `h${payload.length}`;

const savedBrief = (over: Partial<CampaignBrief> = {}): CampaignBrief =>
  ({
    schemaVersion: 1,
    id: "slots",
    targetRegion: "DE",
    targetAudience: "riders",
    campaignMessage: "Hi",
    products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "l.png" }],
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE as CampaignType),
    mode: "variation",
    variation: {
      count: 4,
      axes: {
        layout: ["headline-top", "headline-bottom"],
        tone: ["bold", "subtle"],
        background: { source: ["procedural"] },
        paletteShift: [0],
      },
    },
    output: { formats: ["static"], platforms: ["instagram-feed", "linkedin"] },
    ...over,
  }) as CampaignBrief;

/**
 * The draft as the editor holds it. `fromBrief` is how a loaded campaign becomes
 * one, so every state below started life as a brief the parser accepted.
 */
const draft = (over: Partial<CampaignBrief> = {}): EditorState => fromBrief(savedBrief(over));

/**
 * Plan the draft's own projection, through the parser the route uses, with the
 * input the route resolves — `planInputFor`, term for term, for a brief with no
 * copy pool: the requested ratio subset and the motion platforms' own ratios.
 * Resolving it from the brief rather than hard-coding it is what lets a motion
 * fixture and a static one share this helper and still be planned honestly.
 */
const planOf = (state: EditorState) => {
  const brief = parseBrief(toBrief(state));
  const requested = brief.variation?.axes?.ratio as PlanInput["ratios"];
  const planned = new PlanVariationsUseCase(hasher).plan(brief, {
    ...(requested === undefined ? {} : { ratios: requested }),
    ...motionRatiosFor(brief.output?.platforms),
  });
  if (!planned.success) throw planned.error;
  return planned.value;
};

/** The emitted asset key in variation mode — `Variant.ts:7-12`'s identity, spelled out. */
const assetKeys = (plan: { variants: readonly { index: number; productId: string }[] }) =>
  plan.variants.map((variant) => `${variant.productId}/v${variant.index}`);

/** What the projection actually carries, for the assertions that are about the document. */
const occupancyOf = (state: EditorState) => toBrief(state).variation?.occupancy;
const countOf = (state: EditorState) => toBrief(state).variation?.count;

describe("fault 1 — delete removes exactly that creative, and every survivor is byte-identical", () => {
  test("the survivors are deep-equal, index, seed, axes and asset key alike", () => {
    const before = draft();
    const planBefore = planOf(before);
    expect(planBefore.variants.map((v) => v.index)).toEqual([0, 1, 2, 3]);

    const after = reduce(before, { type: "deleteCreative", index: 1 });
    const planAfter = planOf(after);

    // Exactly that creative, and nothing else, is gone.
    expect(planAfter.variants.map((v) => v.index)).toEqual([0, 2, 3]);
    // **The property the whole plan exists for.** Whole `Variant` objects, axes
    // included — a scheme that kept the index and the seed while moving the axes
    // is the near-miss design SL2 had to reject, and it survives an assertion on
    // seeds alone because seeds are index-derived.
    expect(planAfter.variants).toEqual(planBefore.variants.filter((v) => v.index !== 1));
    // And alongside, the two index-derived things an operator can see on disk.
    expect(planAfter.variants.map((v) => v.seed)).toEqual(
      planBefore.variants.filter((v) => v.index !== 1).map((v) => v.seed),
    );
    expect(assetKeys(planAfter)).toEqual(["alpha/v0", "alpha/v2", "alpha/v3"]);
    // The tombstoned slot's own path is not reissued to anybody.
    expect(assetKeys(planAfter)).not.toContain("alpha/v1");
  });

  test("a second delete is still byte-identical for what is left", () => {
    const before = draft();
    const planBefore = planOf(before);
    const after = reduce(
      before,
      { type: "deleteCreative", index: 1 },
      { type: "deleteCreative", index: 3 },
    );

    expect(occupancyOf(after)).toEqual({ nextIndex: 4, tombstoned: [1, 3] });
    expect(planOf(after).variants).toEqual(
      planBefore.variants.filter((v) => v.index !== 1 && v.index !== 3),
    );
  });
});

describe("fault 2 — add allocates a fresh index, above every index ever used", () => {
  test("the new slot is the old nextIndex, never a tombstoned one, and nothing else moves", () => {
    // Start from a draft that already HAS a hole, so "a new row appeared" cannot
    // pass for "a fresh index was allocated": a scheme that filled the lowest
    // tombstoned slot would also produce one more creative.
    const deleted = reduce(draft(), { type: "deleteCreative", index: 1 });
    const planBefore = planOf(deleted);
    expect(planBefore.variants.map((v) => v.index)).toEqual([0, 2, 3]);
    const nextIndexBefore = draftOccupancy(deleted).nextIndex;
    expect(nextIndexBefore).toBe(4);

    const added = reduce(deleted, { type: "addCreative" });
    const planAfter = planOf(added);

    const fresh = planAfter.variants.filter(
      (variant) => !planBefore.variants.some((was) => was.index === variant.index),
    );
    expect(fresh).toHaveLength(1);
    // The allocation is monotonic (SL-D3): the new slot is the cursor itself,
    // which is above every index ever issued and is NOT the hole at 1.
    expect(fresh[0]!.index).toBe(nextIndexBefore);
    expect(fresh[0]!.index).toBe(4);
    expect(planAfter.variants.map((v) => v.index)).not.toContain(1);
    expect(occupancyOf(added)).toEqual({ nextIndex: 5, tombstoned: [1] });

    // And the creatives that already existed are untouched — the same objects,
    // the same seeds, the same asset keys.
    expect(planAfter.variants.filter((v) => v.index !== 4)).toEqual(planBefore.variants);
    expect(assetKeys(planAfter)).toEqual(["alpha/v0", "alpha/v2", "alpha/v3", "alpha/v4"]);
  });

  test("an add on a brief with no hole writes a bare cursor, with no empty tombstone list", () => {
    const added = reduce(draft(), { type: "addCreative" });
    expect(occupancyOf(added)).toEqual({ nextIndex: 5 });
    expect(planOf(added).variants.map((v) => v.index)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("fault 3 — neither gesture touches count", () => {
  /**
   * SL2's constraint, and the one most likely to be "helpfully" broken, because
   * both directions read as tidying up: an add that raised `count` would make
   * `allocated === count` again and re-open the exhaustive search on the very
   * gesture the allocation gate guards, and a delete that lowered it would
   * strand a brief whose plan that search produced.
   */
  test("count is the recipe's target cardinality and stays where the operator put it", () => {
    const before = draft();
    expect(countOf(before)).toBe(4);

    const deleted = reduce(before, { type: "deleteCreative", index: 0 });
    expect(countOf(deleted)).toBe(4);
    expect(draftOccupancy(deleted).liveIndices).toEqual([1, 2, 3]);

    const added = reduce(deleted, { type: "addCreative" });
    expect(countOf(added)).toBe(4);
    expect(draftOccupancy(added).liveIndices).toEqual([1, 2, 3, 4]);

    // The divergence is visible where it is supposed to be: the document asks
    // for four and carries four live slots numbered 1..4.
    expect(occupancyOf(added)).toEqual({ nextIndex: 5, tombstoned: [0] });
  });

  /**
   * **The reason the constraint exists, asserted on the planner rather than
   * restated.** SL2 keeps the exhaustive search open for a DELETE — `allocated
   * === count` still holds, so the search answers the same question it always
   * did and chooses the same set — and closes it for an ADD, because
   * re-choosing from scratch would move every creative the operator already has
   * to make room for one more.
   *
   * The fixture is the reported tight case (`PlanVariationsUseCase.use-case.test.ts`,
   * "a tight motion-only brief"): two products at 9:16, one motion kind, one
   * duration, three palette shifts — 24 points, of which minDistance 2 admits
   * exactly 8 — driven here through the editor's own projection. The 3 × count
   * random draw falls short of 8, so both plans below come from the exhaustive
   * search; verified by instrumenting `enumerateAxes`'s branch while writing
   * this test.
   */
  const tightMotionBrief = {
    products: [
      { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "l.png" },
      { id: "beta", name: "B", primaryColor: "#1473E6", logoPath: "m.png" },
    ],
    variation: {
      count: 8,
      minDistance: 2,
      axes: { paletteShift: [0, 0.1, 0.2], motion: ["ken-burns-out"], duration: [5] },
    },
    output: { formats: ["motion"], platforms: ["instagram-reel"] },
  } as Partial<CampaignBrief>;

  test("a delete on a brief the exhaustive search planned still plans, and its survivors are byte-identical", () => {
    const tight = draft(tightMotionBrief);
    const planBefore = planOf(tight);
    expect(planBefore.variants).toHaveLength(8);

    const deleted = reduce(tight, { type: "deleteCreative", index: 5 });
    // The whole of why this works: `count` is still 8, so `allocated === count`
    // and the search is still asked "choose 8 points" — the same question, the
    // same answer, seven of which are emitted.
    expect(countOf(deleted)).toBe(8);
    expect(planOf(deleted).variants).toEqual(planBefore.variants.filter((v) => v.index !== 5));
  });

  /**
   * And the known reachable state on the other side, recorded rather than
   * papered over: `canAddCreative` is a CEILING, not a guarantee. Here the
   * cursor is nowhere near `axisProductSize` (8 of 24), so the control is
   * offered — and the planner still refuses, because a ninth slot cannot keep
   * its distance from the eight and the exhaustive fallback is deliberately
   * closed once `allocated > count`. The refusal is loud and names the
   * shortfall, and ⌘Z takes the add back.
   */
  test("an add the axes cannot satisfy is refused LOUDLY by the planner, not silently by the editor", () => {
    const tight = draft(tightMotionBrief);
    expect(canAddCreative(tight)).toBe(true);

    const added = reduce(tight, { type: "addCreative" });
    expect(countOf(added)).toBe(8);
    expect(occupancyOf(added)).toEqual({ nextIndex: 9 });
    expect(() => planOf(added)).toThrow(/distinct variants/);
  });
});

describe("the gestures refuse what the planner would", () => {
  test("the last creative cannot be deleted", () => {
    const one = draft({ variation: { count: 1, axes: { layout: ["headline-top"] } } } as Partial<
      Partial<CampaignBrief>
    >);
    expect(draftOccupancy(one).liveIndices).toEqual([0]);
    // Identity-equal: a refused gesture is not a state change, so nothing
    // downstream re-renders and no history entry is pushed.
    expect(editorReducer(one, { type: "deleteCreative", index: 0 })).toBe(one);

    // The positive half — the same gesture on a draft with two live slots works,
    // so the refusal above is the floor and not a delete that never works.
    const two = draft({ variation: { count: 2, axes: { layout: ["headline-top"] } } } as Partial<
      Partial<CampaignBrief>
    >);
    expect(occupancyOf(editorReducer(two, { type: "deleteCreative", index: 0 }))).toEqual({
      nextIndex: 2,
      tombstoned: [0],
    });
  });

  test("a slot that is not live cannot be deleted — unallocated, fractional, negative or already gone", () => {
    const deleted = reduce(draft(), { type: "deleteCreative", index: 1 });
    // Already tombstoned: a duplicate is a brief the domain refuses outright.
    expect(editorReducer(deleted, { type: "deleteCreative", index: 1 })).toBe(deleted);
    // Never allocated — at the cursor and beyond it.
    expect(editorReducer(deleted, { type: "deleteCreative", index: 4 })).toBe(deleted);
    expect(editorReducer(deleted, { type: "deleteCreative", index: -1 })).toBe(deleted);
    // Not a slot at all. `liveIndices` answers this with the rest.
    expect(editorReducer(deleted, { type: "deleteCreative", index: 1.5 })).toBe(deleted);
  });

  test("add is refused when the axes cannot produce another creative", () => {
    // 2 layouts × 2 tones × 2 ratios = 8 with count 8: the cursor is already at
    // the ceiling, so a ninth slot is unplannable by construction.
    const full = draft({
      variation: {
        count: 8,
        axes: {
          layout: ["headline-top", "headline-bottom"],
          tone: ["bold", "subtle"],
          ratio: ["1:1", "9:16"],
          background: { source: ["procedural"] },
          paletteShift: [0],
        },
      },
    } as Partial<CampaignBrief>);
    expect(canAddCreative(full)).toBe(false);
    expect(editorReducer(full, { type: "addCreative" })).toBe(full);

    // A delete does NOT free capacity: the cursor is what the ceiling bounds,
    // and a tombstoned slot is still drawn (SL2's replay). Deleting to make room
    // for an add would be the compaction this whole plan exists to remove.
    const deleted = reduce(full, { type: "deleteCreative", index: 0 });
    expect(draftOccupancy(deleted).liveIndices).toHaveLength(7);
    expect(canAddCreative(deleted)).toBe(false);

    // The positive half: a brief with room in its axes adds.
    expect(canAddCreative(draft())).toBe(true);
    expect(occupancyOf(editorReducer(draft(), { type: "addCreative" }))).toEqual({ nextIndex: 5 });
  });
});

describe("draftOccupancy — the editor's mirror of the domain's resolveOccupancy", () => {
  test("an absent block resolves to count, exactly as the domain resolves it", () => {
    const state = draft();
    expect(occupancyOf(state)).toBeUndefined();
    expect(draftOccupancy(state)).toEqual({
      nextIndex: 4,
      tombstoned: [],
      liveIndices: [0, 1, 2, 3],
    });
  });

  test("a count that does not parse resolves to no slots, not to a guess", () => {
    const blank: EditorState = {
      ...draft(),
      variation: { ...draft().variation, count: "" },
    };
    expect(draftOccupancy(blank)).toEqual({ nextIndex: 0, tombstoned: [], liveIndices: [] });
  });

  test("an authored block is read verbatim, count or no count", () => {
    const holey = fromBrief(
      savedBrief({
        variation: {
          count: 3,
          occupancy: { nextIndex: 6, tombstoned: [1, 4] },
          axes: {
            layout: ["headline-top", "headline-bottom"],
            tone: ["bold", "subtle"],
            background: { source: ["procedural"] },
            paletteShift: [0],
          },
        },
      } as Partial<CampaignBrief>),
    );
    // `count` is 3 and six slots were allocated: the divergence SL-D5 describes,
    // read off the document rather than reconciled away.
    expect(draftOccupancy(holey)).toEqual({
      nextIndex: 6,
      tombstoned: [1, 4],
      liveIndices: [0, 2, 3, 5],
    });
  });
});

describe("SL1's back-compat, which SL4 must not regress", () => {
  test("a brief that never had occupancy saves without acquiring one", () => {
    // Every kind of edit that is not a creative gesture: the block stays absent.
    const edited = reduce(
      draft(),
      { type: "patch", patch: { targetAudience: "commuters" } },
      { type: "toggleTone", value: "playful" },
      { type: "setVariation", field: "count", value: "6" },
    );
    expect(occupancyOf(edited)).toBeUndefined();
    expect(Object.keys(toBrief(edited).variation ?? {})).not.toContain("occupancy");
  });

  test("a gesture is what materialises the block, and it materialises it from count", () => {
    const deleted = reduce(draft(), { type: "deleteCreative", index: 2 });
    // `nextIndex` is the count the brief already asked for — the resolution the
    // domain was already doing, written down now that a slot has been deleted.
    expect(occupancyOf(deleted)).toEqual({ nextIndex: 4, tombstoned: [2] });
  });
});
