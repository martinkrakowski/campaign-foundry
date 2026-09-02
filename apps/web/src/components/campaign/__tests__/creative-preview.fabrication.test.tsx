import { describe, test, expect } from "vitest";
import { render, type RenderResult } from "@testing-library/react";
import type { MotionKind } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import { PreviewDock, derivePreviewRatio } from "../PreviewDock";
import { MOTION_KIND_META } from "../MotionKindPanel";
import { previewDockProps } from "../preview-props";
import { initialEditorState, emptyProduct, type EditorState } from "../editor-state";
import { ratioDisplayName, platformDisplayName } from "../display-names";
import * as messages from "../messages";

/**
 * W9.4 — the D26 fabrication guard. The preview may only show what the compositor
 * draws: nothing but the brief's own words, the domain's display labels, and the
 * messages file's sanctioned strings. Every whitespace token of rendered text must be
 * a substring of some corpus string derived from the brief — so a caption, an
 * engagement rail, a handle or a "original sound" credit would need a home in the
 * corpus to pass, and the corpus is closed to them (the reverse test proves it).
 *
 * D45: the props come from the PRODUCT derivation (`previewDockProps`) — the same
 * call the host makes — so this file maps nothing of its own, and "exactly as the
 * host wires them" is a fact instead of a claim. The Review figure derives the same
 * look from the same projection, so a passing corpus here is also the dock==figure
 * parity statement (R7.2's acceptance).
 */

const niche = (): EditorState => {
  const state = initialEditorState("variation");
  state.campaignName = "Summer Launch";
  state.campaignMessage = "Stay wild. Stay hydrated.";
  state.targetAudience = "Urban outdoor enthusiasts, 25-40";
  state.targetRegion = "LATAM";
  state.products = [
    { ...emptyProduct(1, "#1473E6"), id: "alpha" },
    { ...emptyProduct(2, "#F04E23"), id: "beta" },
  ];
  state.variation.layout = ["headline-bottom", "headline-top"];
  state.variation.tone = ["bold", "subtle"];
  state.variation.ratio = ["9:16", "1:1"];
  state.platforms = ["instagram-story", "tiktok", "linkedin"];
  state.motion = [];
  return state;
};

/** A classic draft: the look comes from its treatment, never its leftover axes. */
const classic = (): EditorState => {
  const state = initialEditorState("brief");
  state.campaignName = "Summer Launch";
  state.campaignMessage = "Stay wild. Stay hydrated.";
  state.products = [{ ...emptyProduct(1, "#1473E6"), id: "alpha" }];
  state.treatments = [{ id: "bold-hero", layout: "headline-bottom", tone: "subtle" }];
  // Leftovers a visit to Randomized would leave behind: the classic look must not read them.
  state.variation.layout = ["headline-top"];
  state.variation.tone = ["bold"];
  return state;
};

/** A randomized draft that asked for video: the caption names the style in words (D50). */
const withMotion = (): EditorState => {
  const state = niche();
  state.formats = ["static", "motion"];
  state.motion = ["ken-burns-in"];
  return state;
};

/**
 * The closed universe the preview may draw its words from — derived from the same
 * props derivation the host uses, so the corpus and the render cannot drift apart:
 * the brief's own strings plus the display labels and messages the surface is
 * allowed to show. A raw ratio, a raw platform id, or a word the compositor never
 * prints is a violation on sight.
 */
function corpusTokensFor(state: EditorState): Set<string> {
  const props = previewDockProps(state, 0, 6);
  if (props === null) throw new Error("the fabrication fixtures always have a product to draw");
  const ratio = derivePreviewRatio(props.platformId, undefined);
  const platformLabel =
    props.platformId !== undefined ? platformDisplayName(props.platformId) : messages.previewNoPlatform;
  const caption =
    props.motion !== undefined
      ? messages.previewCaptionMotion(ratioDisplayName(ratio), platformLabel, MOTION_KIND_META[props.motion])
      : messages.previewCaption(ratioDisplayName(ratio), platformLabel);
  const fallbackCaption = messages.previewCaption(ratioDisplayName("1:1"), messages.previewNoPlatform);
  const corpusString = [
    props.campaignName,
    props.headline,
    messages.previewLegend,
    messages.previewStep(props.step, props.stepCount),
    caption,
    fallbackCaption,
  ].join(" ");
  return new Set(corpusString.split(/\s+/).filter((t) => t.length > 0));
}

/** Tokenize while keeping the headline's line wrap honest (lines must not fuse words). */
function previewTokens(view: RenderResult): string[] {
  const { container } = view;
  const tokens: string[] = [];
  const push = (text: string): void => {
    tokens.push(...text.split(/\s+/).filter((t) => t.length > 0));
  };
  container.querySelectorAll("text").forEach((textEl) => {
    push(textEl.firstChild?.textContent ?? "");
    textEl.querySelectorAll("tspan").forEach((tspan) => push(tspan.textContent ?? ""));
  });
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null) {
    // Skip only what the <text>/<tspan> pass above already collected — not the whole
    // SVG subtree. Excluding every descendant of <svg> would let text smuggled into a
    // <foreignObject> escape the guard entirely, which is the one thing it exists to
    // stop.
    const parent = node.parentElement;
    if (parent !== null && parent.closest("text") === null) {
      push((node as Text).data);
    }
    node = walker.nextNode();
  }
  return tokens;
}

describe("the preview only ever speaks the brief and the sanctioned labels", () => {
  const variationState = niche();
  const classicState = classic();
  const motionState = withMotion();
  // Also: the pre-platform state — no platform picked yet, defaults only.
  const noPlatformState = niche();
  noPlatformState.platforms = [];

  test.each([
    ["the dock, randomized", variationState],
    ["the dock, classic", classicState],
    ["the dock, moving", motionState],
    ["the dock without a platform", noPlatformState],
  ] as const)("%s renders text that is all exact members of the brief-derived corpus token set", (_name, state) => {
    const props = previewDockProps(state, 0, 6);
    expect(props).not.toBeNull();
    const view = render(<PreviewDock {...props!} />);
    const tokens = previewTokens(view);
    expect(tokens.length).toBeGreaterThan(0);
    const corpusTokens = corpusTokensFor(state);
    for (const token of tokens) {
      expect(
        corpusTokens.has(token),
        `token "${token}" has no exact match in the sanctioned corpus token set`,
      ).toBe(true);
    }
  });

  test("the classic look comes from the treatment — the leftover axes are never read (D45)", () => {
    // The mode-awareness half of the mapping, asserted on the props themselves: the
    // axes this classic draft carries are leftovers of a Randomized visit, and the
    // dock must agree with the Review figure (which reads the projection, where they
    // no longer exist) rather than with them.
    const props = previewDockProps(classicState, 0, 6)!;
    expect(props.layout).toBe("headline-bottom");
    expect(props.tone).toBe("subtle");
  });

  test("the moving creative names its style, and the style is display-label vocabulary", () => {
    const props = previewDockProps(motionState, 0, 6)!;
    const motion = props.motion;
    expect(motion).toBe("ken-burns-in");
    expect(MOTION_KIND_META[motion as MotionKind]).toBe("slow zoom in");
  });

  test("no rendered preview contains the mock's invented chrome, whatever the tokeniser does", () => {
    // Direct and tokenizer-independent: the substring guard above proves every token has
    // a home in the corpus, but a subtle tokenisation bug could weaken it. This asserts
    // the rejected chrome (§2.3) against the rendered text itself, so the two checks
    // fail for different reasons and cannot both be defeated by one mistake.
    const { container } = render(<PreviewDock {...previewDockProps(variationState, 0, 6)!} />);
    const rendered = container.textContent ?? "";
    for (const fake of ["12.4K", "1,203", "8,741", "@", "original sound", "Following", "For You"]) {
      expect(rendered, `the preview must never render "${fake}"`).not.toContain(fake);
    }
  });

  test("a draft with no product derives no dock at all (D26, M3)", () => {
    // `products.length === 0` is a real state (a brief file can carry it), and the
    // answer is explicit: nothing to draw, nothing rendered — never an invented colour.
    const empty = niche();
    empty.products = [];
    expect(previewDockProps(empty, 0, 6)).toBeNull();
  });

  test("the corpus itself stays clean of the chrome it must never show", () => {
    const corpusTokens = corpusTokensFor(variationState);
    // The separators "·" and "/" are sanctioned (the caption and step readout use
    // them), so test the substantive tokens: the numbers, the handle, the credit.
    for (const fake of ["12.4K", "1,203", "8,741", "@handle", "original", "sound", "Following", "For you"]) {
      expect(corpusTokens.has(fake), `corpus must stay clean of "${fake}"`).toBe(false);
    }
    // Teeth: had a fake rail been rendered, its tokens would need a corpus home to
    // pass the gate, and the corpus is closed to them.
    expect(["12.4K", "1,203", "8,741", "@handle"].map((t) => corpusTokens.has(t))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
