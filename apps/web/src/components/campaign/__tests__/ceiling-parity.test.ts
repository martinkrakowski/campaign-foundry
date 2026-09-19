import { describe, test, expect } from "vitest";
import { VariationPolicy } from "@campaignfoundry/CampaignOrchestration";
import { axisProductSize } from "../validate";
import { initialEditorState, toBrief, type EditorState } from "../editor-state";
// The same cross-app import the parser mirror above uses (validate.test.ts): a
// mirror tested without the thing it mirrors is exactly the drift these tests
// exist to catch. `motionRatiosFor` is what the API actually feeds the planner,
// so the domain here is driven by the editor's own draft, end to end.
import { motionRatiosFor } from "../../../../../api/server/lib/platform-zones";

/**
 * The count ceiling is computed twice — `VariationPolicy.axisProductSize` in the
 * domain, `axisProductSize` in the editor — and the editor's copy bounds the count
 * slider. They are two implementations of one quantity, so drift between them is
 * the recurring defect: the editor offers a maximum and the planner refuses it.
 *
 * Each case drives BOTH from a single `EditorState`: the domain sees the brief
 * `toBrief` actually writes, with the `motionRatios` the API actually derives from
 * that brief's platforms. Nothing is asserted against a hand-written literal on
 * the domain side, so a revert of either site's arithmetic — or a divergence
 * between the web's `PLATFORM_PROFILES` and the API's platform zones — shows up
 * here as an inequality rather than as two literals that were updated together.
 */

// axisProductSize is independent of the hash, so the hasher only has to exist.
const stubHasher = (payload: string): string => `len:${payload.length}`;

const product = (over: Record<string, unknown> = {}) => ({
  key: 1,
  id: "alpha",
  name: "A",
  primaryColor: "#1473E6",
  logoPath: "l.png",
  inputAsset: "",
  idTouched: true,
  ...over,
});

// "variation" so `toBrief` actually writes the variation block the domain reads;
// a classic draft saves no policy at all, and the ceiling would have nothing to
// compare against.
const state = (over: Partial<EditorState> = {}): EditorState => ({
  ...initialEditorState("variation"),
  briefId: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [product(), product({ key: 2, id: "beta", name: "B" })],
  ...over,
});

/** The domain's ceiling for the brief this draft saves, fed the API's own motionRatios. */
const domainCeiling = (draft: EditorState): number => {
  const brief = toBrief(draft);
  const result = VariationPolicy.fromBrief(
    brief,
    motionRatiosFor(brief.output?.platforms),
    stubHasher,
  );
  if (!result.success) throw result.error;
  return result.value.axisProductSize;
};

/** Shapes chosen so each exercises a different branch of the per-ratio sum. */
const shapes: ReadonlyArray<readonly [string, EditorState]> = [
  ["static only", state({ formats: ["static"], platforms: ["instagram-feed"] })],
  [
    // The defect's own shape: three ratios requested, motion packaged at one.
    "mixed, motion packaged at one of three ratios",
    state({
      formats: ["static", "motion"],
      platforms: ["instagram-feed", "instagram-reel"],
      motion: ["ken-burns-in"],
      duration: [4],
    }),
  ],
  [
    "mixed, several motion kinds and durations at one packaged ratio",
    state({
      formats: ["static", "motion"],
      platforms: ["instagram-feed", "instagram-reel"],
      motion: ["ken-burns-in", "ken-burns-out"],
      duration: [4, 6],
    }),
  ],
  [
    "mixed, two motion platforms sharing one packaged ratio",
    state({
      formats: ["static", "motion"],
      platforms: ["instagram-feed", "instagram-reel", "tiktok"],
      motion: ["ken-burns-in"],
      duration: [4],
    }),
  ],
  [
    "motion only",
    state({
      formats: ["motion"],
      platforms: ["instagram-reel"],
      motion: ["ken-burns-in"],
      duration: [4],
    }),
  ],
  [
    "motion only, several kinds and durations",
    state({
      formats: ["motion"],
      platforms: ["instagram-reel"],
      motion: ["ken-burns-in", "ken-burns-out"],
      duration: [4, 6],
    }),
  ],
];

describe("the editor's count ceiling and the domain's are one quantity", () => {
  test.each(shapes)("%s — the two ceilings agree", (_name, draft) => {
    expect(axisProductSize(draft)).toBe(domainCeiling(draft));
  });

  test("the mixed case is the discriminating one, and it is not the motion-only number", () => {
    const [, mixed] = shapes[1] as readonly [string, EditorState];
    const [, motionOnly] = shapes[4] as readonly [string, EditorState];
    // Pinned so the agreement above cannot be satisfied by both sites collapsing
    // to some other value. The draft's non-ratio axes give 2 products × 2 layouts
    // × 2 tones × 1 background × 3 palette shifts = 24 base combinations; 9:16
    // carries 1 clip + 1 still and 1:1 and 16:9 carry one still each, so the
    // per-ratio sum is 2 + 1 + 1 = 4 → 96.
    expect(axisProductSize(mixed)).toBe(96);
    // The old arithmetic's answer — the motion factor across all three ratios.
    expect(axisProductSize(mixed)).not.toBe(24 * 3 * 2);
    // Motion-only narrows to the packaged ratio instead, so it was already right.
    expect(axisProductSize(motionOnly)).toBe(24);
  });

  test("widening the packaged ratios widens both ceilings together", () => {
    // Adding a motion platform at a NEW ratio turns one of the still-only ratios
    // into a motion ratio; both sites must move by the same amount.
    const base = shapes[1][1];
    const widened = { ...base, platforms: [...base.platforms, "youtube-shorts"] };
    expect(axisProductSize(widened)).toBe(domainCeiling(widened));
  });
});
