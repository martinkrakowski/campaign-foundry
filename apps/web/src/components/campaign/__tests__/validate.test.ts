import { describe, test, expect } from "vitest";
import {
  maxMinDistance,
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
    expect(validatePolicy(randomized({ background: [] })).background).toMatch(/at least one background/);
    expect(validatePolicy(randomized({ paletteShift: [] })).paletteShift).toMatch(/at least one palette/);
  });
});

describe("validateOutput", () => {
  test("formats and platforms must be non-empty", () => {
    expect(validateOutput(valid())).toEqual({});
    expect(validateOutput(valid({ formats: [] })).formats).toMatch(/at least one format/);
    expect(validateOutput(valid({ platforms: [] })).platforms).toMatch(/at least one platform/);
  });

  test("motion is refused while the capability is off, with the probe's reason", () => {
    const off = valid({ formats: ["static", "motion"], capabilities: { motion: false, reason: "no ffmpeg" } });
    expect(validateOutput(off).formats).toMatch(/not available: no ffmpeg/);
    const noReason = valid({ formats: ["motion"], capabilities: { motion: false } });
    expect(validateOutput(noReason).formats).toMatch(/capability off/);
    const on = valid({
      formats: ["static", "motion"],
      platforms: ["instagram-feed", "instagram-reel"],
      capabilities: { motion: true },
    });
    expect(validateOutput(on).formats).toBeUndefined();
  });

  test("a platform that packages none of the requested formats is rejected", () => {
    const errors = validateOutput(valid({ formats: ["motion"], platforms: ["instagram-feed", "instagram-reel"] }));
    expect(errors.platforms).toMatch(
      /Platform "instagram-feed" packages only \[static\], which output\.formats \[motion\] does not request/,
    );
  });

  test("a requested format no platform can package is rejected", () => {
    const errors = validateOutput(valid({ formats: ["static", "motion"], platforms: ["instagram-feed", "linkedin", "x"] }));
    expect(errors.formats).toMatch(
      /Output format "motion" is requested but none of output\.platforms \[instagram-feed, linkedin, x\] can package it/,
    );
  });

  test("a capability-off motion brief with its motion platform selected is structurally compatible", () => {
    // D12: the compatibility mirror must not add an error a save would be blocked by —
    // the only complaint is the capability, which does not gate persistence.
    const errors = validateOutput(
      valid({
        formats: ["static", "motion"],
        platforms: ["instagram-feed", "instagram-reel"],
        capabilities: { motion: false, reason: "no ffmpeg" },
      }),
    );
    expect(errors.platforms).toBeUndefined();
    expect(errors.formats).toMatch(/not available: no ffmpeg/);
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
