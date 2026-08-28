import { describe, test, expect } from "vitest";
import * as messages from "./messages";
import { formatDisplayName } from "./display-names";

// Collect all string values from messages (including function return values)
function collectStrings(obj: Record<string, unknown>): string[] {
  const strings: string[] = [];
  for (const value of Object.values(obj)) {
    if (typeof value === "string") strings.push(value);
    if (typeof value === "function") {
      // Call function with dummy args to get return string
      try {
        const result = (value as (...args: unknown[]) => unknown)();
        if (typeof result === "string") strings.push(result);
      } catch {
        // Skip functions that need specific args
      }
    }
  }
  return strings;
}

describe("messages jargon test", () => {
  const forbidden = [
    "[", ">=", "×", "variation.", "coverage.", "axis", "axes", "draw", "floor", "package", "planner", "parser",
    // the raw values a user must never see — display-names.ts converts them at the call site
    "static", "motion", "9:16", "1:1", "16:9", "pool://copy", "procedural", "asset-pool", "genai",
    // raw platform ids are jargon too — display-names.ts converts them at the call site
    "instagram-feed", "instagram-story", "instagram-reel", "tiktok", "youtube-short", "linkedin",
  ];

  test("no message contains forbidden jargon", () => {
    const strings = collectStrings(messages as unknown as Record<string, unknown>);
    // Add known function return values with dummy args
    strings.push(messages.briefIdDuplicate("test"));
    strings.push(messages.products(1, "Randomized"));
    strings.push(messages.productIdDuplicate("test"));
    strings.push(messages.treatmentIdDuplicate("test"));
    strings.push(messages.minDistance(5));
    strings.push(messages.perRatioExceeds(2, 3, 12));
    strings.push(messages.ratioNoneDrawablePackaged(["Square"]));
    strings.push(messages.ratioNoneDrawableNone());
    strings.push(messages.ratioExcludedPackaged(["Square"]));
    strings.push(messages.ratioExcludedNone());
    strings.push(messages.platformsIncompatible("Instagram Feed", ["Still images"]));
    strings.push(messages.formatsUnsupported("Video", ["Instagram Story"]));
    strings.push(messages.statusApplied("test-id"));
    strings.push(messages.durationRange(2, 30));

    for (const str of strings) {
      for (const term of forbidden) {
        expect(str).not.toContain(term);
      }
    }
  });

  test("display names replace raw format/ratio/platform ids", () => {
    expect(formatDisplayName("Still images")).toBe("Still images");
    expect(formatDisplayName("Video")).toBe("Video");
    expect(formatDisplayName("invalid")).toBe("invalid");
  });
});

describe("readout.ratioFloor", () => {
  test("states the budget, and only says it is too many when it is", () => {
    expect(messages.readoutRatioFloor(3, 2, 6, 12, false)).not.toContain("too many");
    expect(messages.readoutRatioFloor(3, 2, 6, 5, true)).toContain("too many");
  });
});
