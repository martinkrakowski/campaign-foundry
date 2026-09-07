import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Kit files import types and constants from the @campaignfoundry/* domain packages
// (ratio-frame, creative-glyph, platform-card, swatch-chip, duration-strip,
// preview-layers) — the domain's own vocabulary, not a sibling feature's. Those
// imports are explicitly out of scope here; do not "fix" them.
//
// What this test polices is the sibling feature: no file under components/ui
// imports @/components/campaign except the declared allowlist below. The
// allowlist may only ever shrink — an entry that no longer matches any kit file
// is a failure, not a silent pass, because a stale entry is permission for a
// violation that was already fixed.
const allowlist: Record<string, string> = {
  "section-outline.tsx":
    "renders the editor's section vocabulary; a kit-shaped component with a feature's data model, not yet untangled.",
  "confirm-dialog.tsx": "default labels from campaign/messages.",
  "seg-bar.tsx": "default labels from campaign/messages.",
  "theme-toggle.tsx": "default labels from campaign/messages.",
};

const kitDir = resolve(__dirname, "..");
const kitFiles = readdirSync(kitDir).filter((file) => /\.(ts|tsx)$/.test(file));
const CAMPAIGN_IMPORT = /@\/components\/campaign/;

describe("the kit does not import the campaign feature (D87)", () => {
  test("every kit file outside the allowlist is free of @/components/campaign imports", () => {
    const violations = kitFiles
      .filter((file) => !(file in allowlist))
      .map((file) => ({ file, hit: readFileSync(join(kitDir, file), "utf-8").search(CAMPAIGN_IMPORT) }))
      .filter((entry) => entry.hit !== -1);
    expect(violations).toEqual([]);
  });

  test("every allowlist entry still matches a kit file that still needs it, each with a reason", () => {
    for (const [file, reason] of Object.entries(allowlist)) {
      expect(reason.trim().length, `${file} must carry a one-line reason`).toBeGreaterThan(0);
      const source = kitFiles.includes(file) ? readFileSync(join(kitDir, file), "utf-8") : "";
      expect(
        source,
        `${file} no longer imports the campaign feature — remove its allowlist entry (the list may only shrink)`,
      ).toMatch(CAMPAIGN_IMPORT);
    }
  });

  test("mode-panel has left the kit entirely", () => {
    expect(kitFiles).not.toContain("mode-panel.tsx");
  });
});
