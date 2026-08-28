import { describe, test, expect } from "vitest";
import { formatDisplayName, ratioDisplayName, platformDisplayName } from "../display-names";
import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";

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
});
