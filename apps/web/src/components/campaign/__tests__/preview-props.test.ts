import { describe, test, expect } from "vitest";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { previewDockProps, previewIdentityKey, previewRailKey } from "../preview-props";
import { initialEditorState, emptyProduct, STATIC_PLATFORMS, toBrief } from "../editor-state";

/** A product the preview can actually draw — emptyProduct's id is the blank draft's placeholder. */
const namedProduct = (key = 1, primaryColor = "#1473E6") => ({
  ...emptyProduct(key, primaryColor),
  id: `p${key}`,
});

/**
 * The state→dock mapping's own contract (D45): mode-aware look, real motion, the
 * projection's output rule for the platform, and the wizard step readout. The
 * fabrication guard proves the words stay sanctioned; these tests pin the wiring.
 */

describe("previewDockProps", () => {
  test("a randomized draft takes the look from the first value of each axis", () => {
    const state = initialEditorState("variation");
    state.products = [namedProduct()];
    state.variation.layout = ["headline-bottom", "headline-top"];
    state.variation.tone = ["subtle", "bold"];
    const props = previewDockProps(state, 2, 6)!;
    expect(props.layout).toBe("headline-bottom");
    expect(props.tone).toBe("subtle");
  });

  test("the anchor is passed only while the saved brief will carry the axis (T4)", () => {
    const state = initialEditorState("variation");
    state.products = [namedProduct()];
    // The derived top/bottom pair means the axis is ABSENT: the dock derives
    // the placement from layout, exactly as the compositor does.
    expect(previewDockProps(state, 0, 6)!.anchor).toBeUndefined();
    // Selecting Middle makes the axis real, and the first value feeds the dock.
    state.variation.anchor = ["middle", "top"];
    state.anchorExplicit = true;
    expect(previewDockProps(state, 0, 6)!.anchor).toBe("middle");
    // A classic draft never reads the axis, whatever its treatments say.
    const classic = initialEditorState("brief");
    classic.products = [namedProduct()];
    classic.variation.anchor = ["middle"];
    classic.anchorExplicit = true;
    expect(previewDockProps(classic, 0, 6)!.anchor).toBeUndefined();
  });

  test("a classic draft takes the look from its treatment, never its leftover axes", () => {
    const state = initialEditorState("brief");
    state.products = [namedProduct()];
    state.treatments = [{ id: "bold-hero", layout: "headline-bottom", tone: "subtle" }];
    // A visit to Randomized leaves axes behind; the projection drops them, so the dock must too.
    state.variation.layout = ["headline-top"];
    state.variation.tone = ["bold"];
    const props = previewDockProps(state, 0, 6)!;
    expect(props.layout).toBe("headline-bottom");
    expect(props.tone).toBe("subtle");
  });

  test("a classic draft with no treatment draws the renderer's default, axes or not", () => {
    const state = initialEditorState("brief");
    state.products = [namedProduct()];
    state.variation.layout = ["headline-bottom"];
    state.variation.tone = ["subtle"];
    const props = previewDockProps(state, 0, 6)!;
    expect(props.layout).toBeUndefined();
    expect(props.tone).toBeUndefined();
  });

  test("motion is real: the first picked kind, only for video in a randomized draft", () => {
    const state = initialEditorState("variation");
    state.products = [namedProduct()];
    state.formats = ["static", "motion"];
    state.motion = ["ken-burns-in", "headline-rise"];
    expect(previewDockProps(state, 0, 6)!.motion).toBe("ken-burns-in");
    // Video asked for but no kind picked yet — the readout shows a still, not a guess.
    state.motion = [];
    expect(previewDockProps(state, 0, 6)!.motion).toBeUndefined();
    // A classic draft never reads the motion axis, whatever it still carries.
    const classic = initialEditorState("brief");
    classic.products = [namedProduct()];
    classic.formats = ["static", "motion"];
    classic.motion = ["ken-burns-in"];
    expect(previewDockProps(classic, 0, 6)!.motion).toBeUndefined();
  });

  test("a classic draft that still holds motion omits the platform, as toBrief omits output (D99/D45)", () => {
    const state = initialEditorState("brief");
    state.products = [namedProduct()];
    state.formats = ["static", "motion"];
    // The draft still holds Video; the saved brief is the absent-key default.
    expect(toBrief(state)).not.toHaveProperty("output");
    expect(previewDockProps(state, 0, 6)!.platformId).toBeUndefined();
  });

  test("the platform comes from the draft's own output, as the projection emits it", () => {
    const state = initialEditorState("variation");
    state.products = [namedProduct()];
    // The default static output is the absent-key case: the projection omits it, so
    // the caption reads "no platform yet" exactly as the Review figure's does.
    expect(previewDockProps(state, 0, 6)!.platformId).toBeUndefined();
    // A declared-but-default output survives the projection, and its platforms with it.
    state.outputExplicit = true;
    expect(previewDockProps(state, 0, 6)!.platformId).toBe(STATIC_PLATFORMS[0]);
    // A diverging output is emitted, and its first platform names the caption.
    state.outputExplicit = false;
    state.platforms = ["instagram-story", "tiktok"];
    expect(previewDockProps(state, 0, 6)!.platformId).toBe("instagram-story");
  });

  test("the step readout is the walk's cursor, one-based, and the count is the walk's length", () => {
    const state = initialEditorState("brief");
    state.products = [namedProduct()];
    const props = previewDockProps(state, 4, 6)!;
    expect(props.step).toBe(5);
    expect(props.stepCount).toBe(6);
  });

  test("a draft with no product derives no dock — nothing to draw, nothing invented", () => {
    const state = initialEditorState("variation");
    state.products = [];
    expect(previewDockProps(state, 0, 6)).toBeNull();
  });

  test("a blank draft's placeholder product derives no dock until it is named", () => {
    const state = initialEditorState("variation");
    expect(previewDockProps(state, 0, 6)).toBeNull();
    state.products = [namedProduct()];
    expect(previewDockProps(state, 0, 6)).not.toBeNull();
  });

  test("a new draft keys the frame on tempId; a loaded brief leaves identity to brief.id", () => {
    const draft = initialEditorState("variation");
    draft.products = [namedProduct()];
    expect(draft.source.kind).toBe("new");
    expect(previewIdentityKey(draft)).toBe("new");
    expect(previewDockProps(draft, 0, 6)!.identityKey).toBe("new");

    const loaded = {
      ...draft,
      source: {
        kind: "file" as const,
        file: "camp.yaml",
        loadedId: "camp",
        savedSnapshot: null,
        revision: undefined,
      },
    };
    expect(previewIdentityKey(loaded)).toBeUndefined();
    expect(previewDockProps(loaded, 0, 6)!.identityKey).toBeUndefined();
  });

  /**
   * D141 — "In `everything` there is no step cursor: `stepIndex` is stale
   * outside guided … `previewDockProps`' step readout must not show a guided
   * cursor in that presentation." The caller (BriefEditor) now omits the
   * cursor entirely when it is not guided, rather than passing a stale one.
   */
  test("omitting the cursor omits the step readout — Everything has no step (D141)", () => {
    const state = initialEditorState("brief");
    state.products = [namedProduct()];
    const props = previewDockProps(state)!;
    expect(props.step).toBeUndefined();
    expect(props.stepCount).toBeUndefined();
    // Everything about the rest of the look is unaffected by omitting the cursor.
    expect(props.campaignName).toBe(state.campaignName);
  });

  test("the style is carried exactly as toBrief will emit it (T5/D45)", () => {
    const state = initialEditorState("variation");
    state.products = [namedProduct()];
    // A style-less draft: the absent key — the dock resolves the defaults itself.
    expect(previewDockProps(state, 0, 6)!.style).toBeUndefined();
    // A declared style rides to the dock, so it cannot show a typography the
    // saved brief would not carry.
    state.style = { fontFamily: "Lora", align: "left" };
    state.styleExplicit = true;
    expect(previewDockProps(state, 0, 6)!.style).toEqual({ fontFamily: "Lora", align: "left" });
    // The same derivation toBrief uses decides — a diverging draft without the
    // flag is emitted here too.
    state.styleExplicit = false;
    expect(previewDockProps(state, 0, 6)!.style).toEqual({ fontFamily: "Lora", align: "left" });
  });
});

describe("previewRailKey — the memo boundary's identity axis (Qodo, caught in review)", () => {
  /** Two SAVED briefs (no `identityKey` involved) whose every visual/content
   *  field previewFetchKey and rawRailProps can see is identical — the only
   *  thing that differs is `id`. This is deliberately the worst case: the
   *  bug is that the OLD key formula could not tell these apart at all. */
  const twinBrief = (id: string): CampaignBrief => ({
    schemaVersion: 1,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id,
    targetRegion: "DE",
    targetAudience: "a",
    campaignMessage: "Hi",
    products: [{ id: "p1", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
  });

  const sharedRawRailProps = () => {
    const state = initialEditorState("variation");
    state.products = [namedProduct(1)];
    state.products[0].id = "p1";
    state.campaignName = "twin"; // the SAME displayed name for both briefs below
    // A SAVED brief — `previewIdentityKey` must answer `undefined` here (as
    // it does for any `source.kind === "file"`), or this fixture would test
    // the identityKey branch instead of the brief.id fallback the bug is
    // about. `initialEditorState` defaults to a fresh, unsaved draft
    // (`source.kind === "new"`), which is the wrong shape for this fixture.
    state.source = { kind: "file", file: "twin.yaml", loadedId: "twin", savedSnapshot: null, revision: undefined };
    return previewDockProps(state, 0, 6)!;
  };

  test("moves when two saved briefs share every look/content field but differ by id", () => {
    const rawRailProps = sharedRawRailProps();
    const keyA = previewRailKey(rawRailProps, twinBrief("twin-a"), "p1");
    const keyB = previewRailKey(rawRailProps, twinBrief("twin-b"), "p1");
    // Both inputs to previewFetchKey and every field of rawRailProps are
    // identical between A and B — the identity term is the ONLY thing that
    // can distinguish them, and it must.
    expect(keyA).not.toBe(keyB);
  });

  test("still stable across a look-preserving change with the SAME id (CC2 is not weakened)", () => {
    const rawRailProps = sharedRawRailProps();
    const brief = twinBrief("twin-a");
    const keyBefore = previewRailKey(rawRailProps, brief, "p1");
    // A brand-new brief object, `targetAudience` changed — never read by
    // previewFetchKey or carried in rawRailProps.
    const keyAfter = previewRailKey(rawRailProps, { ...brief, targetAudience: "different" }, "p1");
    expect(keyAfter).toBe(keyBefore);
  });

  test("a not-yet-saved draft's identityKey (not brief.id) is the axis, matching usePreviewFrame", () => {
    const rawRailProps = { ...sharedRawRailProps(), identityKey: "temp-1" };
    const briefA = twinBrief(""); // a fresh draft's brief.id is the live, changing slug
    const briefB = { ...briefA, id: "renamed-live-slug" };
    // identityKey is present, so it — not the live slug — is the axis: a
    // rename must not move this key (FI1's contract, preserved through CC1).
    expect(previewRailKey(rawRailProps, briefA, "p1")).toBe(previewRailKey(rawRailProps, briefB, "p1"));
  });

  test("null rawRailProps (nothing to draw) never computes a key", () => {
    expect(previewRailKey(null, twinBrief("x"), "p1")).toBeNull();
  });

  /**
   * CodeRabbit, caught in review: `usePreviewFrame`'s own identity tuple
   * includes `cell.productId` directly, but `productId` here previously fed
   * ONLY the `previewFetchKey` lookup (the product's colour/logo) — neither
   * `rawRailProps` (no product id in the look) nor that lookup's result
   * carries the id itself. So the first product's id changing while its
   * colour and logo stay put — an ordinary, editable-in-the-editor case —
   * would not move the key, even though the real `/preview-frame` request
   * (keyed on `cell.productId`) would ask the server for a different
   * product than the one still painted.
   */
  test("moves when the first product's id changes even though its colour and logo stay put", () => {
    const rawRailPropsFor = (productId: string) => {
      const state = initialEditorState("variation");
      state.products = [{ ...namedProduct(1), id: productId, primaryColor: "#1473E6", logoPath: "a.png" }];
      state.campaignName = "twin";
      state.source = { kind: "file", file: "twin.yaml", loadedId: "twin", savedSnapshot: null, revision: undefined };
      return previewDockProps(state, 0, 6)!;
    };
    const briefWithProduct = (productId: string): CampaignBrief => ({
      schemaVersion: 1,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
      id: "twin",
      targetRegion: "DE",
      targetAudience: "a",
      campaignMessage: "Hi",
      products: [{ id: productId, name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
    });

    // rawRailProps is IDENTICAL between p1 and p2 (the look carries no
    // product id — only colour, which is unchanged) — the product id
    // argument itself is the only thing that can distinguish these calls.
    const keyA = previewRailKey(rawRailPropsFor("p1"), briefWithProduct("p1"), "p1");
    const keyB = previewRailKey(rawRailPropsFor("p2"), briefWithProduct("p2"), "p2");
    expect(keyA).not.toBe(keyB);
  });
});
