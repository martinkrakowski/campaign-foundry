import { describe, test, expect } from "vitest";
import { render, type RenderResult } from "@testing-library/react";
import type { AspectRatioValue } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { PreviewDock, PreviewStrip, derivePreviewRatio } from "../PreviewDock";
import { initialEditorState, emptyProduct, type EditorState } from "../editor-state";
import type { LayoutOption, ToneOption } from "../CreativePreview";
import { ratioDisplayName, platformDisplayName } from "../display-names";
import * as messages from "../messages";

/**
 * W9.4 — the D26 fabrication guard. The previews may only show what the compositor
 * draws: nothing but the brief's own words, the domain's display labels, and the
 * messages file's sanctioned strings. Every whitespace token of rendered text must be
 * a substring of some corpus string derived from the brief — so a caption, an
 * engagement rail, a handle or a "original sound" credit would need a home in the
 * corpus to pass, and the corpus is closed to them (the reverse test proves it).
 */

const niche = (): EditorState => {
  const state = initialEditorState("variation");
  state.campaignName = "Summer Launch";
  state.campaignMessage = "Stay wild. Stay hydrated.";
  state.targetAudience = "Urban outdoor enthusiasts, 25-40";
  state.targetRegion = "LATAM";
  state.products = [emptyProduct(1, "#1473E6"), emptyProduct(2, "#F04E23")];
  state.variation.layout = ["headline-bottom", "headline-top"];
  state.variation.tone = ["bold", "subtle"];
  state.variation.ratio = ["9:16", "1:1"];
  state.platforms = ["instagram-story", "tiktok", "linkedin"];
  state.motion = [];
  return state;
};

/** The previews' props are derived from the editor state, exactly as the host wires them. */
function previewFrom(state: EditorState) {
  return {
    campaignName: state.campaignName,
    headline: state.campaignMessage,
    primaryColor: state.products[0]?.primaryColor ?? "#1473E6",
    layout: (state.variation.layout[0] as LayoutOption) ?? ("headline-top" as LayoutOption),
    tone: (state.variation.tone[0] as ToneOption) ?? ("bold" as ToneOption),
    platformId: state.platforms[0],
    ratio: state.variation.ratio[0] as AspectRatioValue | undefined,
    step: 1,
    stepCount: 6,
  };
}

/**
 * The closed universe the previews may draw their words from: the brief's own strings
 * plus the display labels and messages the surfaces are allowed to show. A raw ratio,
 * a raw platform id, or a word the compositor never prints is a violation on sight.
 */
function corpusTokensFor(state: EditorState): Set<string> {
  const caption = messages.previewCaption(
    ratioDisplayName(derivePreviewRatio(state.platforms[0], state.variation.ratio[0])),
    platformDisplayName(state.platforms[0]),
  );
  const fallbackCaption = messages.previewCaption(ratioDisplayName("1:1"), messages.previewNoPlatform);
  const corpusString = [
    state.campaignName,
    state.campaignMessage,
    messages.previewLegend,
    messages.previewStep(1, 6),
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

describe("the previews only ever speak the brief and the sanctioned labels", () => {
  const state = niche();
  const corpusTokens = corpusTokensFor(state);

  test.each([
    ["PreviewDock", <PreviewDock key="dock" {...previewFrom(state)} />],
    ["PreviewStrip", <PreviewStrip key="strip" {...previewFrom(state)} />],
    // Also: the pre-platform state — no platform picked yet, defaults only.
    [
      "PreviewDock without a platform",
      <PreviewDock key="noplatform" {...previewFrom(state)} platformId={undefined} ratio={undefined} />,
    ],
  ] as const)("%s renders text that is all exact members of the brief-derived corpus token set", (_name, ui) => {
    const view = render(ui);
    const tokens = previewTokens(view);
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(
        corpusTokens.has(token),
        `token "${token}" has no exact match in the sanctioned corpus token set`,
      ).toBe(true);
    }
  });

  test("no rendered preview contains the mock's invented chrome, whatever the tokeniser does", () => {
    // Direct and tokenizer-independent: the substring guard above proves every token has
    // a home in the corpus, but a subtle tokenisation bug could weaken it. This asserts
    // the rejected chrome (§2.3) against the rendered text itself, so the two checks
    // fail for different reasons and cannot both be defeated by one mistake.
    for (const ui of [
      <PreviewDock key="d" {...previewFrom(state)} />,
      <PreviewStrip key="s" {...previewFrom(state)} />,
    ]) {
      const { container } = render(ui);
      const rendered = container.textContent ?? "";
      for (const fake of ["12.4K", "1,203", "8,741", "@", "original sound", "Following", "For You"]) {
        expect(rendered, `the preview must never render "${fake}"`).not.toContain(fake);
      }
    }
  });

  test("the corpus itself stays clean of the chrome it must never show", () => {
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