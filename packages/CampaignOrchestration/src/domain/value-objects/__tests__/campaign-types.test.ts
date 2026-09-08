import { describe, test, expect } from "vitest";
import { ADVERTISING_UNITS } from "../advertising-units.js";
import { CREATIVE_TYPES, CREATIVE_TYPE_RULES } from "../creative-types.js";
import { CANONICAL_TEMPLATES, CANONICAL_TEMPLATE_IDS } from "../creative-templates.js";
import {
  CAMPAIGN_TYPES,
  CAMPAIGN_TYPE_PRESETS,
  CAMPAIGN_TYPE_PROMPT_HINTS,
  DEFAULT_CAMPAIGN_TYPE,
  campaignTypePromptSentence,
  type CampaignType,
} from "../campaign-types.js";

describe("campaign types (D108–D112, A5/D117)", () => {
  test("the vocabulary is exactly the four types, in display order", () => {
    // display-ad joined last (D117) — after the sizes render, so the option
    // cannot exist before its campaigns can.
    expect(CAMPAIGN_TYPES).toEqual(["social-post", "paid-social", "short-video", "display-ad"]);
  });

  test("the default is a member of the vocabulary (D112)", () => {
    expect((CAMPAIGN_TYPES as readonly string[]).includes(DEFAULT_CAMPAIGN_TYPE)).toBe(true);
    expect(DEFAULT_CAMPAIGN_TYPE).toBe("social-post");
  });

  test("every type has a preset keyed by its own vocabulary value", () => {
    expect(Object.keys(CAMPAIGN_TYPE_PRESETS).sort()).toEqual([...CAMPAIGN_TYPES].sort());
  });

  test("no preset pairs motion formats with classic mode (D110 — the run path would refuse it)", () => {
    for (const [type, preset] of Object.entries(CAMPAIGN_TYPE_PRESETS)) {
      const motion = preset.formats.includes("motion");
      expect(
        !(motion && preset.mode === "brief"),
        `${type} requests motion under mode "brief" — the API refuses that on every run path`,
      ).toBe(true);
    }
  });

  test("each preset matches the plan's table — the type plan's §2.1 and the display plan's A5 row (D120)", () => {
    expect(CAMPAIGN_TYPE_PRESETS["social-post"]).toEqual({
      unit: "standard-web",
      creativeType: "image-text",
      template: "canonical-image-text",
      platforms: ["instagram-feed", "linkedin", "x"],
      formats: ["static"],
      mode: "brief",
    });
    expect(CAMPAIGN_TYPE_PRESETS["paid-social"]).toEqual({
      unit: "standard-web",
      creativeType: "image-text",
      template: "canonical-image-text",
      platforms: ["instagram-feed", "linkedin", "x", "instagram-story", "instagram-reel", "tiktok", "youtube-short"],
      formats: ["static", "motion"],
      mode: "variation",
    });
    expect(CAMPAIGN_TYPE_PRESETS["short-video"]).toEqual({
      unit: "standard-web",
      creativeType: "video",
      template: "canonical-video",
      platforms: ["instagram-story", "instagram-reel", "tiktok", "youtube-short"],
      formats: ["motion"],
      mode: "variation",
    });
    expect(CAMPAIGN_TYPE_PRESETS["display-ad"]).toEqual({
      unit: "standard-web",
      creativeType: "image-text",
      template: "canonical-image-text",
      platforms: ["google-display", "meta-audience-network", "display-web"],
      formats: ["static"],
      mode: "brief",
    });
  });

  test("every preset names a CREATIVE_TYPES member, an ADVERTISING_UNITS member, and a template in CANONICAL_TEMPLATES", () => {
    const validUnits = new Set<string>(ADVERTISING_UNITS);
    const validTypes = new Set<string>(CREATIVE_TYPES);
    const validTemplates = new Set<string>(Object.values(CANONICAL_TEMPLATES).map((t) => t.id));

    for (const [type, preset] of Object.entries(CAMPAIGN_TYPE_PRESETS)) {
      expect(
        validUnits.has(preset.unit),
        `preset "${type}" names unknown unit "${preset.unit}"`,
      ).toBe(true);
      expect(
        validTypes.has(preset.creativeType),
        `preset "${type}" names unknown creativeType "${preset.creativeType}"`,
      ).toBe(true);
      expect(
        validTemplates.has(preset.template),
        `preset "${type}" names unknown template "${preset.template}"`,
      ).toBe(true);
    }
  });

  test("CANONICAL_TEMPLATE_IDS and CAMPAIGN_TYPE_PRESETS template values are consistent", () => {
    const canonicalSet = new Set<string>(CANONICAL_TEMPLATE_IDS);

    // Every preset id is a canonical id
    for (const [type, preset] of Object.entries(CAMPAIGN_TYPE_PRESETS)) {
      expect(
        canonicalSet.has(preset.template),
        `preset "${type}" names template "${preset.template}" which is not in CANONICAL_TEMPLATE_IDS`,
      ).toBe(true);
    }
  });

  test("each preset's formats are a subset of its creativeType's outputFamilies (subset rule)", () => {
    for (const rule of Object.values(CREATIVE_TYPE_RULES)) {
      expect(rule.outputFamilies.length).toBeGreaterThan(0);
      expect(new Set(rule.outputFamilies).size).toBe(rule.outputFamilies.length);
    }

    for (const [type, preset] of Object.entries(CAMPAIGN_TYPE_PRESETS)) {
      const allowedFamilies = new Set<string>(CREATIVE_TYPE_RULES[preset.creativeType].outputFamilies);
      for (const format of preset.formats) {
        expect(
          allowedFamilies.has(format),
          `preset "${type}" format "${format}" is not allowed by creative type "${preset.creativeType}" outputFamilies`,
        ).toBe(true);
      }
    }

    expect(CREATIVE_TYPE_RULES[CAMPAIGN_TYPE_PRESETS["short-video"].creativeType].outputFamilies).toEqual(["motion"]);
    expect(CREATIVE_TYPE_RULES[CAMPAIGN_TYPE_PRESETS["social-post"].creativeType].outputFamilies).toEqual(["static", "motion"]);
    expect(CREATIVE_TYPE_RULES[CAMPAIGN_TYPE_PRESETS["paid-social"].creativeType].outputFamilies).toEqual(["static", "motion"]);
    expect(CREATIVE_TYPE_RULES[CAMPAIGN_TYPE_PRESETS["display-ad"].creativeType].outputFamilies).toEqual(["static", "motion"]);
  });

  test("presets only ever request the two known formats and the two known modes", () => {
    for (const preset of Object.values(CAMPAIGN_TYPE_PRESETS)) {
      for (const format of preset.formats) {
        expect(["static", "motion"]).toContain(format);
      }
      expect(["brief", "variation"]).toContain(preset.mode);
    }
  });

  test("the union is compile-locked: a fifth type is a type error until added", () => {
    const names: readonly CampaignType[] = CAMPAIGN_TYPES;
    expect(names).toHaveLength(4);
  });

  test("each type has a distinct prompt hint; short-video is not the social-post phrase", () => {
    expect(Object.keys(CAMPAIGN_TYPE_PROMPT_HINTS).sort()).toEqual([...CAMPAIGN_TYPES].sort());
    expect(CAMPAIGN_TYPE_PROMPT_HINTS["social-post"]).toBe("a social post for organic feeds");
    expect(CAMPAIGN_TYPE_PROMPT_HINTS["paid-social"]).toBe(
      "paid social advertising across feeds, stories and reels",
    );
    expect(CAMPAIGN_TYPE_PROMPT_HINTS["short-video"]).toBe("short-form video for social feeds");
    expect(CAMPAIGN_TYPE_PROMPT_HINTS["display-ad"]).toBe("static display advertising in IAB banner sizes");
    expect(CAMPAIGN_TYPE_PROMPT_HINTS["short-video"]).not.toBe(CAMPAIGN_TYPE_PROMPT_HINTS["social-post"]);
    expect(CAMPAIGN_TYPE_PROMPT_HINTS["paid-social"]).not.toBe(CAMPAIGN_TYPE_PROMPT_HINTS["social-post"]);
  });

  test("absent type uses the social-post prompt sentence", () => {
    expect(campaignTypePromptSentence(undefined)).toBe(campaignTypePromptSentence(DEFAULT_CAMPAIGN_TYPE));
    expect(campaignTypePromptSentence(undefined)).toBe("Campaign type: a social post for organic feeds.");
    expect(campaignTypePromptSentence("paid-social")).toBe(
      "Campaign type: paid social advertising across feeds, stories and reels.",
    );
    expect(campaignTypePromptSentence("short-video")).toBe(
      "Campaign type: short-form video for social feeds.",
    );
    expect(campaignTypePromptSentence("display-ad")).toBe(
      "Campaign type: static display advertising in IAB banner sizes.",
    );
  });

  test("a non-vocabulary type uses the social-post prompt sentence", () => {
    expect(campaignTypePromptSentence("corrupted" as never)).toBe(
      "Campaign type: a social post for organic feeds.",
    );
  });
});
