import { describe, test, expect } from "vitest";
import {
  axisProductSize,
  drawableRatios,
  maxMinDistance,
  motionPackagedRatios,
  motionUnavailableReason,
  validateIdentity,
  validateCopy,
  validateProducts,
  validateTreatments,
  validatePolicy,
  validateOutput,
  validateMotion,
  validateState,
  hasErrors,
  hasSectionErrors,
  getTotalErrorCount,
} from "../validate";
import { initialEditorState, editorReducer, type EditorState } from "../editor-state";

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

/** A state that passes every rule, so each test can break exactly one thing. */
const valid = (over: Partial<EditorState> = {}): EditorState => ({
  ...initialEditorState(),
  briefId: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [product(), product({ key: 2, id: "beta", name: "B" })],
  ...over,
});

describe("maxMinDistance", () => {
  test("is six axes by default and seven with the headline pool", () => {
    const state = valid();
    expect(maxMinDistance(state)).toBe(6);
    expect(maxMinDistance(editorReducer(state, { type: "toggleHeadline" }))).toBe(7);
  });

  test("motion adds two axes only while it is a requested format", () => {
    const state = valid();
    // kinds retained after switching motion off are inert — VariationPolicy.vo counts
    // them only when `output.formats` includes motion, and the client must agree or a
    // draft passes here and is rejected by the planner
    expect(maxMinDistance({ ...state, motion: ["ken-burns-in"] })).toBe(6);
    expect(maxMinDistance({ ...state, formats: ["static", "motion"], motion: ["ken-burns-in"] })).toBe(8);
    // requesting motion without kinds draws nothing, so it adds nothing
    expect(maxMinDistance({ ...state, formats: ["static", "motion"], motion: [] })).toBe(6);
  });
});

describe("motionUnavailableReason", () => {
  test("is the probe's reason exactly when motion is requested and off, else absent", () => {
    expect(motionUnavailableReason(valid())).toBeUndefined();
    expect(motionUnavailableReason(valid({ formats: ["static", "motion"] }))).toBeUndefined();
    expect(motionUnavailableReason(valid({ capabilities: { motion: true }, formats: ["motion"] }))).toBeUndefined();
    expect(motionUnavailableReason(valid({ capabilities: { motion: false, reason: "no ffmpeg" }, formats: ["motion"] }))).toBe(
      "Motion format is not available: no ffmpeg.",
    );
    expect(motionUnavailableReason(valid({ capabilities: { motion: false }, formats: ["motion"] }))).toBe(
      "Motion format is not available: capability off.",
    );
  });
});

describe("axisProductSize", () => {
  test("multiplies the axes a static brief draws from", () => {
    // 2 products × 3 ratios × 2 layouts × 2 tones × 1 background × 3 palette shifts
    expect(axisProductSize(valid())).toBe(2 * 3 * 2 * 2 * 1 * 3);
  });

  test("a motion-only brief is limited to the ratios its motion platforms package", () => {
    const reel = valid({
      formats: ["motion"],
      platforms: ["instagram-reel"],
      motion: ["ken-burns-in"],
      duration: [4],
    });
    // instagram-reel is 9:16, so one ratio — and one motion kind × one duration
    expect(axisProductSize(reel)).toBe(2 * 1 * 2 * 2 * 1 * 3 * 1);

    // a second motion platform at the same ratio adds nothing; tiktok is 9:16 too
    expect(axisProductSize({ ...reel, platforms: ["instagram-reel", "tiktok"] })).toBe(axisProductSize(reel));
  });

  test("a mixed brief keeps every ratio and adds the still slot", () => {
    const mixed = valid({
      formats: ["static", "motion"],
      platforms: ["instagram-feed", "instagram-reel"],
      motion: ["ken-burns-in", "ken-burns-out"],
      duration: [4, 6],
    });
    // 2 kinds × 2 durations + 1 still = 5 on the motion axis, and all three ratios
    expect(axisProductSize(mixed)).toBe(2 * 3 * 2 * 2 * 1 * 3 * 5);
  });

  test("unknown platform ids and a motion format with no kinds do not collapse it to zero", () => {
    const unknown = valid({ formats: ["motion"], platforms: ["myspace"], motion: ["ken-burns-in"] });
    expect(axisProductSize(unknown)).toBeGreaterThan(0);
    const noKinds = valid({ formats: ["motion"], platforms: ["instagram-reel"], motion: [] });
    expect(axisProductSize(noKinds)).toBeGreaterThan(0);
  });

  test("the headline axis multiplies by the approved pool", () => {
    const base = valid();
    const pooled = {
      ...base,
      variation: { ...base.variation, headline: true },
      pool: { entries: [{ id: "a", text: "x", status: "approved" }, { id: "b", text: "y", status: "approved" }] },
    } as unknown as typeof base;
    expect(axisProductSize(pooled)).toBe(axisProductSize(base) * 2);
  });

  test("a requested ratio subset shrinks the space; a motion-only brief intersects it", () => {
    const narrowed = { ...valid(), variation: { ...valid().variation, ratio: ["1:1", "16:9"] } };
    expect(axisProductSize(narrowed)).toBe(axisProductSize(valid()) / 3 * 2);

    const reel = valid({
      formats: ["motion"],
      platforms: ["instagram-reel"],
      motion: ["ken-burns-in"],
      duration: [4],
      variation: { ...valid().variation, ratio: ["1:1", "9:16"] },
    });
    // instagram-reel packages motion at 9:16 only, so the draw narrows to one ratio
    expect(drawableRatios(reel)).toEqual(["9:16"]);
    expect(axisProductSize(reel)).toBe(2 * 1 * 2 * 2 * 1 * 3 * 1);
  });
});

describe("drawableRatios", () => {
  test("a static or mixed brief draws every selected ratio", () => {
    expect(drawableRatios(valid())).toEqual(["1:1", "9:16", "16:9"]);
    const narrowed = { ...valid(), variation: { ...valid().variation, ratio: ["16:9"] } };
    expect(drawableRatios(narrowed)).toEqual(["16:9"]);
    const mixed = valid({ formats: ["static", "motion"], platforms: ["instagram-reel"], motion: ["ken-burns-in"] });
    expect(drawableRatios(mixed)).toEqual(["1:1", "9:16", "16:9"]);
  });

  test("motionPackagedRatios lists the ratios of requested motion platforms only", () => {
    const reel = valid({ platforms: ["instagram-feed", "instagram-reel", "tiktok"] });
    expect([...motionPackagedRatios(reel)].sort()).toEqual(["9:16"]);
    expect(motionPackagedRatios(valid({ platforms: ["instagram-feed", "linkedin"] })).size).toBe(0);
  });

  test("a selection the narrowing empties is flagged in the editor, not left to the run", () => {
    // Structurally valid, so D7 keeps Save open — but VariationPolicy.fromBrief
    // refuses it at plan time, so the editor has to say the brief cannot run.
    const noneDrawable = valid({
      mode: "variation",
      formats: ["motion"],
      platforms: ["instagram-reel"],
      motion: ["ken-burns-in"],
      variation: { ...valid().variation, ratio: ["1:1", "16:9"] },
    });
    expect(validatePolicy(noneDrawable).ratio).toMatch(
      /None of the selected ratios can be drawn: motion-only output can draw \[9:16\] only/,
    );

    // and when no platform packages motion at all, the fix named is different
    const noMotionPlatform = valid({
      mode: "variation",
      formats: ["motion"],
      platforms: ["instagram-feed", "linkedin"],
      motion: ["ken-burns-in"],
      variation: { ...valid().variation, ratio: ["1:1"] },
    });
    expect(validatePolicy(noMotionPlatform).ratio).toMatch(
      /no selected platform packages motion at any ratio/,
    );

    // a selection that still has a drawable member is not flagged
    expect(validatePolicy(valid({ mode: "variation" })).ratio).toBeUndefined();
  });

  test("a selection the motion narrowing empties draws nothing at all", () => {
    const allExcluded = valid({
      formats: ["motion"],
      platforms: ["instagram-reel"],
      motion: ["ken-burns-in"],
      variation: { ...valid().variation, ratio: ["1:1"] },
    });
    expect(drawableRatios(allExcluded)).toEqual([]);
  });
});

describe("validateIdentity", () => {
  test("rejects an id that is not a path-safe slug", () => {
    expect(validateIdentity(valid({ briefId: "Not Safe" })).briefId).toMatch(/Lowercase letters/);
    expect(validateIdentity(valid())).toEqual({});
  });

  test("a new draft may not take an id that already exists", () => {
    expect(validateIdentity(valid(), ["camp"]).briefId).toMatch(/already exists/);
    expect(validateIdentity(valid(), ["other"])).toEqual({});
  });

  test("a loaded file may keep its own id but not take another brief's", () => {
    const loaded = valid({
      source: { kind: "file", file: "camp.yaml", loadedId: "camp", savedSnapshot: null, revision: undefined },
    });
    // unchanged id — its own filename is not a conflict
    expect(validateIdentity(loaded, ["camp", "other"])).toEqual({});
    // renamed onto a different existing brief
    expect(validateIdentity({ ...loaded, briefId: "other" }, ["camp", "other"]).briefId).toMatch(/already exists/);
    // renamed to something free
    expect(validateIdentity({ ...loaded, briefId: "fresh" }, ["camp", "other"])).toEqual({});
  });

  test("without a list of existing ids no conflict is reported", () => {
    expect(validateIdentity(valid())).toEqual({});
  });
});

describe("validateCopy", () => {
  test("only the campaign message belongs to Copy — its section renders it", () => {
    expect(validateCopy(valid())).toEqual({});
    expect(Object.keys(validateCopy(valid({ campaignMessage: "  " })))).toEqual(["campaignMessage"]);
  });

  test("region and audience are filed under Identity, where their inputs live", () => {
    const errors = validateIdentity(valid({ targetRegion: " ", targetAudience: "" }));
    expect(errors.targetRegion).toMatch(/Target region is required/);
    expect(errors.targetAudience).toMatch(/Target audience is required/);
    expect(validateCopy(valid({ targetRegion: " ", targetAudience: "" }))).toEqual({});
  });
});

describe("validateProducts", () => {
  test("classic needs two unique products, randomized needs one", () => {
    expect(validateProducts(valid())).toEqual({});
    expect(validateProducts(valid({ products: [product()] })).products).toMatch(/at least 2 unique products/);
    expect(validateProducts(valid({ mode: "variation", products: [product()] }))).toEqual({});
    expect(validateProducts(valid({ mode: "variation", products: [] })).products).toMatch(
      /randomized campaign requires at least 1 unique product\./,
    );
  });

  test("flags a malformed id, a duplicate id, a blank name, a bad colour and a missing logo", () => {
    const errors = validateProducts(
      valid({
        products: [
          product({ id: "Bad Id" }),
          product({ key: 2, id: "alpha", name: " ", primaryColor: "blue", logoPath: " " }),
          product({ key: 3, id: "alpha" }),
        ],
      }),
    );
    expect(errors["product-0-id"]).toMatch(/path-safe slug/);
    expect(errors["product-2-id"]).toMatch(/Duplicate product id "alpha"/);
    expect(errors["product-1-name"]).toMatch(/Name is required/);
    expect(errors["product-1-color"]).toMatch(/6-digit hex/);
    expect(errors["product-1-logo"]).toMatch(/Logo path is required/);
  });
});

describe("validateTreatments", () => {
  test("is skipped outside classic mode and when there are none", () => {
    expect(validateTreatments(valid())).toEqual({});
    expect(
      validateTreatments(valid({ mode: "variation", treatments: [{ id: "!!", layout: "x", tone: "y" }] })),
    ).toEqual({});
  });

  test("flags a malformed id, a duplicate, an invalid layout and an invalid tone", () => {
    const errors = validateTreatments(
      valid({
        treatments: [
          { id: "ok", layout: "headline-top", tone: "bold" },
          { id: "ok", layout: "sideways", tone: "shouty" },
          { id: "BAD", layout: "headline-top", tone: "bold" },
        ],
      }),
    );
    expect(errors["treatment-1-id"]).toMatch(/Duplicate treatment id "ok"/);
    expect(errors["treatment-1-layout"]).toMatch(/Invalid layout/);
    expect(errors["treatment-1-tone"]).toMatch(/Invalid tone/);
    expect(errors["treatment-2-id"]).toMatch(/path-safe slug/);
  });
});

describe("validatePolicy", () => {
  const randomized = (over: Partial<EditorState["variation"]> = {}) => {
    const state = valid({ mode: "variation" });
    return { ...state, variation: { ...state.variation, ...over } };
  };

  test("is skipped entirely in classic mode", () => {
    expect(validatePolicy(valid({ mode: "brief" }))).toEqual({});
  });

  test("count must be an integer of at least one", () => {
    expect(validatePolicy(randomized({ count: "" })).count).toMatch(/integer >= 1/);
    expect(validatePolicy(randomized({ count: "0" })).count).toMatch(/integer >= 1/);
    expect(validatePolicy(randomized({ count: "1.5" })).count).toMatch(/integer >= 1/);
    expect(validatePolicy(randomized({ count: "3" })).count).toBeUndefined();
  });

  test("seed is optional but bounded to uint32", () => {
    expect(validatePolicy(randomized({ seed: "" })).seed).toBeUndefined();
    expect(validatePolicy(randomized({ seed: "0" })).seed).toBeUndefined();
    expect(validatePolicy(randomized({ seed: "nope" })).seed).toMatch(/\[0, 2\^32\)/);
    expect(validatePolicy(randomized({ seed: "-1" })).seed).toMatch(/\[0, 2\^32\)/);
    expect(validatePolicy(randomized({ seed: "4294967296" })).seed).toMatch(/\[0, 2\^32\)/);
  });

  test("minDistance is bounded by the number of active axes", () => {
    expect(validatePolicy(randomized({ minDistance: "6" })).minDistance).toBeUndefined();
    expect(validatePolicy(randomized({ minDistance: "7" })).minDistance).toMatch(/\[0, 6\]/);
    expect(validatePolicy(randomized({ minDistance: "-1" })).minDistance).toMatch(/\[0, 6\]/);
    expect(validatePolicy(randomized({ minDistance: "" })).minDistance).toBeUndefined();
    expect(validatePolicy(randomized({ headline: true, minDistance: "7" })).minDistance).toBeUndefined();
  });

  test("coverage fields are optional integers of at least zero", () => {
    expect(validatePolicy(randomized({ perProduct: "", perRatio: "" }))).toEqual({});
    expect(validatePolicy(randomized({ perProduct: "1.5" })).perProduct).toMatch(/integer >= 0/);
    expect(validatePolicy(randomized({ perRatio: "x" })).perRatio).toMatch(/integer >= 0/);
  });

  test("every axis list must keep at least one value", () => {
    expect(validatePolicy(randomized({ layout: [] })).layout).toMatch(/at least one layout/);
    expect(validatePolicy(randomized({ tone: [] })).tone).toMatch(/at least one tone/);
    expect(validatePolicy(randomized({ ratio: [] })).ratio).toMatch(/at least one aspect ratio/);
    expect(validatePolicy(randomized({ background: [] })).background).toMatch(/at least one background/);
    expect(validatePolicy(randomized({ paletteShift: [] })).paletteShift).toMatch(/at least one palette/);
  });

  test("the ratio floor must fit the count: perRatio × the ratios the plan draws", () => {
    // 1 × 3 = 3 of 12 fits
    expect(validatePolicy(randomized()).perRatio).toBeUndefined();
    // 2 × 3 = 6 of 5 does not — the planner would refuse it
    const over = validatePolicy(randomized({ perRatio: "2", count: "5" }));
    expect(over.perRatio).toMatch(/coverage\.perRatio 2 × 3 selected ratios exceeds count 5/);
    expect(over.perRatio).toMatch(/lower the floor, raise the count, or select fewer ratios/);
    // selecting a third ratio is what can make a valid floor impossible
    const twoRatios = { ...randomized({ perRatio: "2", count: "5" }).variation, ratio: ["1:1", "16:9"] };
    expect(validatePolicy({ ...randomized(), variation: twoRatios }).perRatio).toBeUndefined();
    // an unset floor never trips it, whatever the count parses to
    expect(validatePolicy(randomized({ perRatio: "", count: "-5" })).perRatio).toBeUndefined();
  });
});

describe("validateOutput", () => {
  // Briefs that request motion are randomized here: on a classic brief the mode rule
  // ("switch to Randomized") correctly outranks every capability/compatibility message.
  test("formats and platforms must be non-empty", () => {
    expect(validateOutput(valid())).toEqual({});
    expect(validateOutput(valid({ formats: [] })).formats).toMatch(/at least one format/);
    expect(validateOutput(valid({ platforms: [] })).platforms).toMatch(/at least one platform/);
  });

  test("motion is refused while the capability is off, with the probe's reason", () => {
    const off = valid({ mode: "variation", formats: ["static", "motion"], capabilities: { motion: false, reason: "no ffmpeg" } });
    expect(validateOutput(off).formats).toMatch(/not available: no ffmpeg/);
    const noReason = valid({ mode: "variation", formats: ["motion"], capabilities: { motion: false } });
    expect(validateOutput(noReason).formats).toMatch(/capability off/);
    const on = valid({ mode: "variation", formats: ["static", "motion"],
      platforms: ["instagram-feed", "instagram-reel"],
      capabilities: { motion: true },
    });
    expect(validateOutput(on).formats).toBeUndefined();
  });

  test("a platform packaging none of the requested formats says how to resolve it", () => {
    const errors = validateOutput(valid({ formats: ["motion"], platforms: ["instagram-feed", "instagram-reel"] }));
    expect(errors.platforms).toBe(
      '"instagram-feed" only packages static — request that format, or remove the platform.',
    );
  });

  test("a format no platform packages names the platforms that would", () => {
    const errors = validateOutput(valid({ mode: "variation", formats: ["static", "motion"], platforms: ["instagram-feed", "linkedin", "x"] }));
    // the remedy, not just the rejection: these four appear in the picker the moment
    // motion is requested, so the message points straight at them
    expect(errors.formats).toBe(
      'No selected platform packages "motion" — add one of: instagram-story, instagram-reel, tiktok, youtube-short.',
    );
  });

  test("a capability-off motion brief with its motion platform selected is structurally compatible", () => {
    // D12: the compatibility mirror must not add an error a save would be blocked by —
    // the only complaint is the capability, which does not gate persistence.
    const errors = validateOutput(
      valid({ mode: "variation", formats: ["static", "motion"],
        platforms: ["instagram-feed", "instagram-reel"],
        capabilities: { motion: false, reason: "no ffmpeg" },
      }),
    );
    expect(errors.platforms).toBeUndefined();
    expect(errors.formats).toMatch(/not available: no ffmpeg/);
  });
});

describe("validateOutput — motion needs a randomized campaign", () => {
  test("a classic brief requesting motion is told to switch mode", () => {
    const errors = validateOutput(valid({ mode: "brief", formats: ["motion"], platforms: ["instagram-reel"] }));
    expect(errors.formats).toMatch(/requires a randomized campaign — switch the mode to Randomized/);
  });

  test("the mode rule outranks the capability message — it is the root cause", () => {
    const errors = validateOutput(
      valid({ mode: "brief", formats: ["motion"], platforms: ["instagram-reel"], capabilities: { motion: false, reason: "no ffmpeg" } }),
    );
    expect(errors.formats).toMatch(/switch the mode to Randomized/);
  });

  test("a randomized brief requesting motion on a motion platform is clean", () => {
    expect(validateOutput(valid({ mode: "variation", formats: ["motion"], platforms: ["instagram-reel"] }))).toEqual({});
  });
});

describe("validateMotion", () => {
  test("is skipped unless motion is a requested format", () => {
    expect(validateMotion(valid())).toEqual({});
  });

  test("a motion request needs at least one kind and one duration", () => {
    const errors = validateMotion(valid({ formats: ["motion"] }));
    expect(errors.motion).toMatch(/at least one motion kind/);
    expect(errors.duration).toMatch(/at least one duration/);
    expect(validateMotion(valid({ formats: ["motion"], motion: ["ken-burns-in"], duration: [5] }))).toEqual({});
  });

  test("durations are whole seconds bounded to the API's 2–30 range", () => {
    expect(validateMotion(valid({ formats: ["motion"], motion: ["ken-burns-in"], duration: [2, 30] })).duration).toBeUndefined();
    const bad = validateMotion(valid({ formats: ["motion"], motion: ["ken-burns-in"], duration: [1, 31] }));
    expect(bad.duration).toMatch(/whole seconds between 2 and 30/);
    expect(
      validateMotion(valid({ formats: ["motion"], motion: ["ken-burns-in"], duration: [Number.NaN] })).duration,
    ).toMatch(/whole seconds between 2 and 30/);
  });
});

describe("validateMotion — duplicate durations", () => {
  test("a repeated length is reported, because the planner draws each once", () => {
    const errors = validateMotion(
      valid({ formats: ["static", "motion"], motion: ["ken-burns-in"], duration: [6, 6] }),
    );
    expect(errors.duration).toMatch(/Each duration must be distinct/);
  });

  test("distinct lengths pass", () => {
    expect(
      validateMotion(valid({ formats: ["static", "motion"], motion: ["ken-burns-in"], duration: [6, 8] })).duration,
    ).toBeUndefined();
  });
});

describe("aggregation", () => {
  test("validateState reports every section", () => {
    expect(Object.keys(validateState(valid())).sort()).toEqual([
      "copy",
      "identity",
      "motion",
      "output",
      "policy",
      "products",
      "treatments",
    ]);
  });

  test("hasErrors, hasSectionErrors and getTotalErrorCount agree", () => {
    const clean = validateState(valid());
    expect(hasErrors(clean.identity)).toBe(false);
    expect(hasSectionErrors(clean, "identity")).toBe(false);
    expect(hasSectionErrors(clean, "nonexistent")).toBe(false);
    expect(getTotalErrorCount(clean)).toBe(0);

    // both of these now land in Identity, which is where their inputs are rendered
    const broken = validateState(valid({ briefId: "Bad Id", targetRegion: "" }));
    expect(hasErrors(broken.identity)).toBe(true);
    expect(hasSectionErrors(broken, "copy")).toBe(false);
    expect(getTotalErrorCount(broken)).toBe(2);
  });
});
