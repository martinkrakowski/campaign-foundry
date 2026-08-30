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
function corpusFor(state: EditorState): string {
  const caption = messages.previewCaption(
    ratioDisplayName(derivePreviewRatio(state.platforms[0], state.variation.ratio[0])),
    platformDisplayName(state.platforms[0]),
  );
  const fallbackCaption = messages.previewCaption(ratioDisplayName("1:1"), messages.previewNoPlatform);
  return [
    state.campaignName,
    state.campaignMessage,
    messages.previewLegend,
    messages.previewStep(1, 6),
    caption,
    fallbackCaption,
  ].join(" ");
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
    if (node.parentElement !== null && !node.parentElement.closest("svg")) {
      push((node as Text).data);
    }
    node = walker.nextNode();
  }
  return tokens;
}

describe("the previews only ever speak the brief and the sanctioned labels", () => {
  const state = niche();
  const corpus = corpusFor(state);

  test.each([
    ["PreviewDock", <PreviewDock key="dock" {...previewFrom(state)} />],
    ["PreviewStrip", <PreviewStrip key="strip" {...previewFrom(state)} />],
    // Also: the pre-platform state — no platform picked yet, defaults only.
    [
      "PreviewDock without a platform",
      <PreviewDock key="noplatform" {...previewFrom(state)} platformId={undefined} ratio={undefined} />,
    ],
  ] as const)("%s renders text that is all substrings of the brief-derived corpus", (_name, ui) => {
    const view = render(ui);
    const tokens = previewTokens(view);
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(token, `token "${token}" has no home in the sanctioned corpus`).toSatisfy((t: string) =>
        corpus.includes(t),
      );
    }
  });

  test("the corpus itself stays clean of the chrome it must never show", () => {
    // The separators "·" and "/" are sanctioned (the caption and step readout use
    // them), so test the substantive tokens: the numbers, the handle, the credit.
    for (const fake of ["12.4K", "1,203", "8,741", "@handle", "original", "sound", "Following", "For you"]) {
      expect(corpus, `corpus must stay clean of "${fake}"`).not.toContain(fake);
    }
    // Teeth: had a fake rail been rendered, its tokens would need a corpus home to
    // pass the gate, and the corpus is closed to them.
    expect(["12.4K", "1,203", "8,741", "@handle"].map((t) => corpus.includes(t))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});