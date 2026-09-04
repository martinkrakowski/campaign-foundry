import { describe, test, expect } from "vitest";
import {
  alignDisplayName,
  anchorDisplayName,
  formatDisplayName,
  modeDisplayName,
  platformDisplayName,
  ratioDisplayName,
  textEffectDisplayName,
  weightDisplayName,
} from "../display-names";
import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { ANCHOR_VALUES } from "@campaignfoundry/CampaignOrchestration/variation-defaults";
import { TEXT_EFFECT_VALUES } from "@campaignfoundry/CampaignOrchestration/creative-style";

describe("display names", () => {
  test("formats read as things a person makes, not enum values", () => {
    expect(formatDisplayName("static")).toBe("Still images");
    expect(formatDisplayName("motion")).toBe("Video");
    // an unknown value passes through rather than rendering "undefined"
    expect(formatDisplayName("hologram")).toBe("hologram");
  });

  test("every ratio the domain knows has a plain-English name", () => {
    // the guard against the earlier bug: this used to treat RATIO_VALUES as objects,
    // so every ratio silently passed through as "9:16"
    for (const ratio of RATIO_VALUES) {
      expect(ratioDisplayName(ratio)).not.toBe(ratio);
    }
    expect(ratioDisplayName("1:1")).toBe("Square");
    expect(ratioDisplayName("9:16")).toBe("Tall");
    expect(ratioDisplayName("16:9")).toBe("Wide");
    expect(ratioDisplayName("21:9")).toBe("21:9");
  });

  test("platforms use the profile's own label, never a second table", () => {
    expect(platformDisplayName("instagram-feed")).not.toBe("instagram-feed");
    expect(platformDisplayName("not-a-platform")).toBe("not-a-platform");
  });

  test("every anchor the domain knows has a plain-English name (T4)", () => {
    for (const anchor of ANCHOR_VALUES) {
      expect(anchorDisplayName(anchor)).not.toBe(anchor);
    }
    expect(anchorDisplayName("top")).toBe("Top");
    expect(anchorDisplayName("middle")).toBe("Middle");
    expect(anchorDisplayName("bottom")).toBe("Bottom");
    expect(anchorDisplayName("sideways")).toBe("sideways");
  });

  test("every weight and alignment the style vocabulary knows has a plain-English name (T7)", () => {
    // the raw values a user must never see (D18) — an out-of-set value passes
    // through rather than rendering "undefined", like the format names above.
    expect(weightDisplayName(400)).toBe("Regular");
    expect(weightDisplayName(700)).toBe("Bold");
    expect(weightDisplayName(500)).toBe("500");
    expect(alignDisplayName("left")).toBe("Left");
    expect(alignDisplayName("center")).toBe("Center");
    expect(alignDisplayName("right")).toBe("Right");
    expect(alignDisplayName("diagonal")).toBe("diagonal");
  });

  test("every text effect the style vocabulary knows has a plain-English name (T6)", () => {
    for (const effect of TEXT_EFFECT_VALUES) {
      expect(textEffectDisplayName(effect)).not.toBe(effect);
    }
    expect(textEffectDisplayName("fade-in")).toBe("Fade in");
    expect(textEffectDisplayName("rise-in")).toBe("Rise in");
    expect(textEffectDisplayName("slide-in")).toBe("Slide in");
    expect(textEffectDisplayName("scale-in")).toBe("Scale in");
    // an out-of-set value passes through rather than rendering "undefined"
    expect(textEffectDisplayName("spin")).toBe("spin");
  });

  test("both modes the editor knows read Classic and Randomized (D4)", () => {
    expect(modeDisplayName("brief")).toBe("Classic");
    expect(modeDisplayName("variation")).toBe("Randomized");
  });
});

describe("the display-name rule reaches the messages a user reads", () => {
  test("no validator message leaks a raw platform id, format or ratio", async () => {
    const { validateOutput, validatePolicy } = await import("../validate");
    const { initialEditorState } = await import("../editor-state");
    const raw = ["instagram-feed", "instagram-reel", "tiktok", "youtube-short", "static", "motion", "9:16", "1:1", "16:9"];

    // a platform that packages none of the requested formats, and a format no platform takes
    const incompatible = { ...initialEditorState("variation"), formats: ["motion"], platforms: ["instagram-feed"] };
    // a motion-only brief whose chosen shapes cannot be drawn
    const narrowed = {
      ...initialEditorState("variation"),
      formats: ["motion"],
      platforms: ["instagram-reel"],
      motion: ["ken-burns-in"],
      variation: { ...initialEditorState("variation").variation, ratio: ["1:1"] },
    };
    const shown = [
      ...Object.values(validateOutput(incompatible as never)),
      ...Object.values(validatePolicy(narrowed as never)),
    ];
    expect(shown.length).toBeGreaterThan(0);
    for (const message of shown) {
      for (const token of raw) {
        expect(message).not.toContain(token);
      }
    }
  });
});
