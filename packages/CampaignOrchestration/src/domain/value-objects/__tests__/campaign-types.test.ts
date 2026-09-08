import { describe, test, expect } from "vitest";
import {
  CAMPAIGN_TYPES,
  CAMPAIGN_TYPE_PRESETS,
  CAMPAIGN_TYPE_PROMPT_HINTS,
  DEFAULT_CAMPAIGN_TYPE,
  campaignTypePromptSentence,
  type CampaignType,
} from "../campaign-types.js";

describe("campaign types (D108–D112)", () => {
  test("the vocabulary is exactly the three types, in display order", () => {
    expect(CAMPAIGN_TYPES).toEqual(["social-post", "paid-social", "short-video"]);
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

  test("each preset matches the plan's §2.1 table", () => {
    expect(CAMPAIGN_TYPE_PRESETS["social-post"]).toEqual({
      platforms: ["instagram-feed", "linkedin", "x"],
      formats: ["static"],
      mode: "brief",
    });
    expect(CAMPAIGN_TYPE_PRESETS["paid-social"]).toEqual({
      platforms: ["instagram-feed", "linkedin", "x", "instagram-story", "instagram-reel", "tiktok", "youtube-short"],
      formats: ["static", "motion"],
      mode: "variation",
    });
    expect(CAMPAIGN_TYPE_PRESETS["short-video"]).toEqual({
      platforms: ["instagram-story", "instagram-reel", "tiktok", "youtube-short"],
      formats: ["motion"],
      mode: "variation",
    });
  });

  test("presets only ever request the two known formats and the two known modes", () => {
    for (const preset of Object.values(CAMPAIGN_TYPE_PRESETS)) {
      for (const format of preset.formats) {
        expect(["static", "motion"]).toContain(format);
      }
      expect(["brief", "variation"]).toContain(preset.mode);
    }
  });

  test("the union is compile-locked: a fourth type is a type error until added", () => {
    const names: readonly CampaignType[] = CAMPAIGN_TYPES;
    expect(names).toHaveLength(3);
  });

  test("each type has a distinct prompt hint; short-video is not the social-post phrase", () => {
    expect(Object.keys(CAMPAIGN_TYPE_PROMPT_HINTS).sort()).toEqual([...CAMPAIGN_TYPES].sort());
    expect(CAMPAIGN_TYPE_PROMPT_HINTS["social-post"]).toBe("a social post for organic feeds");
    expect(CAMPAIGN_TYPE_PROMPT_HINTS["paid-social"]).toBe(
      "paid social advertising across feeds, stories and reels",
    );
    expect(CAMPAIGN_TYPE_PROMPT_HINTS["short-video"]).toBe("short-form video for social feeds");
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
  });
});
