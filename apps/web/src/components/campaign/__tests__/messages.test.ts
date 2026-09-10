import { describe, test, expect } from "vitest";
import * as messages from "../messages";
import { formatDisplayName } from "../display-names";

const forbidden = [
  "[",
  ">=",
  "×",
  "variation.",
  "coverage.",
  "axis",
  "axes",
  "draw",
  "floor",
  "package",
  "planner",
  "parser",
  // the raw values a user must never see — display-names.ts converts them at the call site
  "static",
  "motion",
  "9:16",
  "1:1",
  "16:9",
  "pool://copy",
  "procedural",
  "asset-pool",
  "genai",
  // raw platform ids are jargon too — display-names.ts converts them at the call site
  "instagram-feed",
  "instagram-story",
  "instagram-reel",
  "tiktok",
  "youtube-short",
  "linkedin",
];

/**
 * Representative arguments for formatters the generic set cannot call (an object
 * shape, an array-first signature, or a method on a number). A new formatter is
 * not listed here — it is called with GENERIC_ARGS, and the scan fails out loud
 * if that produces no string. `startFromRatioCaption` is listed because its
 * production caller passes raw ratio ids; the sample must be those ids, or a
 * join-the-ids regression is invisible to the gate.
 */
const SAMPLE_ARGS = {
  estimateSentence: [
    {
      creatives: 1,
      ratios: [{ label: "Square", count: 1 }],
      products: 1,
      genaiCalls: 0,
    },
  ],
  formatsUnsupported: ["Video", ["Instagram Story"]],
  // One arg so the default `max = 60` branch is taken; callers that pass both
  // are covered by CopySection.
  headlineCounter: [10],
  joinList: [["alpha", "beta"]],
  platformsIncompatible: ["Instagram Feed", ["Still images"]],
  // Two ids so the plural arm is taken; the singular is covered by validate.
  platformsUnknown: [["story-tv", "my-tv"]],
  ratioExcludedPackaged: [["Tall"]],
  ratioNoneDrawablePackaged: [["Square"]],
  // Array-first: GENERIC_ARGS' bare string would throw, and the sample is the
  // kind of display-name list the production caller passes.
  templateRequiredNote: [["Image", "Static text"]],
  templateOcclusionNote: ["Shade", "Static text", "mute"],
  startFromRatioCaption: [["1:1", "9:16", "16:9"]],
  timelineBeatUnderFloor: [1, 1.8, 2, 6],
  timelineDwell: [1.8],
  timelineDwellUnderFloor: [1.8, 2],
} as const satisfies Partial<Record<keyof typeof messages, readonly unknown[]>>;

/** A string, a number, a string array, a boolean — enough for most formatters. */
const GENERIC_ARGS: readonly unknown[] = ["sample", 1, ["sample"], true];

/**
 * Pre-existing formatters whose scanned output still contains a forbidden term.
 * Shrink-only: an entry whose export is gone, or whose output no longer hits the
 * list, is a failure — the violation was fixed, and the permission must go.
 */
const JARGON_ALLOWLIST = {
  timelineBeatUnderFloor:
    "pre-existing: the clip's readability floor in seconds, not variation-policy jargon.",
  timelineDwellUnderFloor:
    "pre-existing: same readability-floor wording as the dwell caption.",
} as const satisfies Partial<Record<keyof typeof messages, string>>;

function stringsFrom(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsFrom);
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(stringsFrom);
  return [];
}

function argsFor(name: string): readonly unknown[] {
  if (Object.hasOwn(SAMPLE_ARGS, name)) {
    return SAMPLE_ARGS[name as keyof typeof SAMPLE_ARGS] as readonly unknown[];
  }
  return GENERIC_ARGS;
}

function scanMessages(): {
  entries: { name: string; strings: string[] }[];
  unscannable: string[];
} {
  const entries: { name: string; strings: string[] }[] = [];
  const unscannable: string[] = [];
  for (const [name, value] of Object.entries(messages)) {
    if (typeof value === "string") {
      entries.push({ name, strings: [value] });
      continue;
    }
    if (typeof value !== "function") continue;
    try {
      const extracted = stringsFrom(
        (value as (...args: unknown[]) => unknown)(...argsFor(name)),
      );
      if (extracted.length === 0) unscannable.push(name);
      else entries.push({ name, strings: extracted });
    } catch {
      unscannable.push(name);
    }
  }
  return { entries, unscannable };
}

describe("messages jargon test", () => {
  test("no message contains forbidden jargon", () => {
    const { entries } = scanMessages();
    for (const { name, strings } of entries) {
      if (name in JARGON_ALLOWLIST) continue;
      for (const str of strings) {
        for (const term of forbidden) {
          expect(str, `${name}: ${JSON.stringify(str)}`).not.toContain(term);
        }
      }
    }
  });

  test("every function export produced a scannable string", () => {
    const { unscannable } = scanMessages();
    expect(unscannable).toEqual([]);
  });

  test("every SAMPLE_ARGS key names a function export", () => {
    for (const name of Object.keys(SAMPLE_ARGS)) {
      expect(typeof (messages as Record<string, unknown>)[name], name).toBe(
        "function",
      );
    }
  });

  test("the jargon allowlist only covers formatters that still violate, and may only shrink", () => {
    const { entries } = scanMessages();
    const byName = new Map(entries.map((entry) => [entry.name, entry.strings]));
    for (const [name, reason] of Object.entries(JARGON_ALLOWLIST)) {
      expect(
        reason.trim().length,
        `${name} must carry a one-line reason`,
      ).toBeGreaterThan(0);
      const scanned = byName.get(name) ?? [];
      expect(
        scanned.length,
        `${name} is not a scanned function export — remove its allowlist entry`,
      ).toBeGreaterThan(0);
      const stillHits = scanned.some((str) =>
        forbidden.some((term) => str.includes(term)),
      );
      expect(
        stillHits,
        `${name} no longer hits the jargon list — remove its allowlist entry`,
      ).toBe(true);
    }
  });

  test("no message offers apply or launch — the D35 verbs moved (H8)", () => {
    // D35 retired "apply" as a user-facing concept and H8's "Save without applying"
    // advertised a control that does not exist; D35 also dropped "launch", because
    // the run verb is Generate. The words may survive in code, state and types —
    // only the rendered strings moved. "appl" catches apply/applied/applies.
    const { entries } = scanMessages();
    for (const { name, strings } of entries) {
      for (const str of strings) {
        const lower = str.toLowerCase();
        expect(lower, `${name}: ${JSON.stringify(str)}`).not.toContain("appl");
        expect(lower, `${name}: ${JSON.stringify(str)}`).not.toContain(
          "launch",
        );
      }
    }
  });

  test("display names replace raw format/ratio/platform ids", () => {
    expect(formatDisplayName("Still images")).toBe("Still images");
    expect(formatDisplayName("Video")).toBe("Video");
    expect(formatDisplayName("invalid")).toBe("invalid");
  });
});

describe("descriptor messages", () => {
  test("formats beat counts with singular and plural nouns", () => {
    expect(messages.descriptorBeats(1)).toBe("1 beat");
    expect(messages.descriptorBeats(0)).toBe("0 beats");
    expect(messages.descriptorBeats(3)).toBe("3 beats");
  });

  test("quotes pooled headline text", () => {
    expect(messages.descriptorHeadline("Stay wild")).toBe('"Stay wild"');
  });
});

describe("readout.ratioFloor", () => {
  test("states the budget, and only says it is too many when it is", () => {
    expect(messages.readoutRatioFloor(3, 2, 6, 12, false)).not.toContain(
      "too many",
    );
    expect(messages.readoutRatioFloor(3, 2, 6, 5, true)).toContain("too many");
  });
});

describe("startFromRatioCaption", () => {
  test("is a count with both plural arms, never the raw ratio ids", () => {
    expect(messages.startFromRatioCaption(["16:9"])).toBe("1 ratio");
    expect(messages.startFromRatioCaption(["1:1", "9:16", "16:9"])).toBe(
      "3 ratios",
    );
  });
});

describe("template messages (L5)", () => {
  test("templateRequiredNote agrees its verb with the count", () => {
    expect(messages.templateRequiredNote(["Solo"])).toBe(
      "Solo is part of every creative and cannot be removed.",
    );
    expect(messages.templateRequiredNote(["Solo", "Pair"])).toBe(
      "Solo and Pair are part of every creative and cannot be removed.",
    );
  });

  test("reviewTemplateLayers formats one and many", () => {
    expect(messages.reviewTemplateLayers(1)).toBe("1 layer");
    expect(messages.reviewTemplateLayers(3)).toBe("3 layers");
  });

  test("templateOcclusionNote formats all occlusion effects and target layers (D135)", () => {
    expect(messages.templateOcclusionNote("Shade", "Static text", "mute")).toBe(
      "the shade layer now sits above the headline and will mute it",
    );
    expect(
      messages.templateOcclusionNote("Accent", "Animated text", "mute"),
    ).toBe("the accent layer now sits above the headline and will mute it");
    expect(messages.templateOcclusionNote("Image", "Accent", "hide")).toBe(
      "the image layer now sits above the accent and will hide it",
    );
    expect(
      messages.templateOcclusionNote("Logo", "Static text", "overlap"),
    ).toBe(
      "the logo layer now sits above the headline and will overlap where it sits",
    );
    expect(messages.templateOcclusionNote("Logo", "Accent", "overlap")).toBe(
      "the logo layer now sits above the accent and will overlap where it sits",
    );
  });
});
