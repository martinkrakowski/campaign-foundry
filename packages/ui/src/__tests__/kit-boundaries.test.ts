import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Kit files import types and constants from the @campaignfoundry workspace
// packages (ratio-frame, creative-glyph, platform-card, swatch-chip,
// duration-strip, preview-layers) — the domain's own vocabulary, not a sibling
// feature's. Those imports are explicitly out of scope here; do not "fix" them.
//
// What this test polices is the sibling feature, on both sides of the P1 split:
//   - packages/ui/src: nothing may import the editor feature, the app alias,
//     or the editor messages module.
//   - packages/ui/src/__tests__: nothing may import apps/, the app alias, or
//     the editor feature either (the source scan skips this directory, which
//     is how a reverse import of ModelSelector previously slipped through).
//   - apps/web/src/components/ui: only the declared allowlist may.
// The allowlist may only ever shrink — an entry that no longer matches any kit
// file is a failure, not a silent pass, because a stale entry is permission
// for a violation that was already fixed.
const allowlist: Record<string, string> = {
  "section-outline.tsx":
    "renders the editor's section vocabulary; a kit-shaped component with a feature's data model, not yet untangled.",
  "confirm-dialog.tsx": "default labels from the editor messages module.",
  "seg-bar.tsx": "default labels from the editor messages module.",
  "theme-toggle.tsx": "default labels from the editor messages module.",
};

const packageKitDir = resolve(import.meta.dirname, "..");
const packageTestDir = resolve(import.meta.dirname);
const webKitDir = resolve(import.meta.dirname, "../../../../apps/web/src/components/ui");

const appAlias = "@" + "/";
const editorFeature = "campaign" + "/";
const messagesMod = "messages";

/** Recurse a kit root, skipping `__tests__`. Nested sources are in scope (D87). */
function listKitSources(dir: string, root: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      names.push(...listKitSources(full, root));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      names.push(relative(root, full));
    }
  }
  return names;
}

const packageFiles = listKitSources(packageKitDir, packageKitDir);
const packageTestFiles = listKitSources(packageTestDir, packageTestDir);
const webFiles = listKitSources(webKitDir, webKitDir);

const IMPORT_SPEC =
  /(?:^\s*import\s+["']([^"']+)["']|(?<!\/\/[^\n]*)\bfrom\s+["']([^"']+)["'])/gm;

function importSpecs(source: string): string[] {
  return [...source.matchAll(IMPORT_SPEC)].map((m) => m[1] ?? m[2] ?? "");
}

function hitsEditorFeature(spec: string): boolean {
  return spec.includes(appAlias) || spec.includes(editorFeature) || spec.includes(messagesMod);
}

function hitsAppWorkspace(spec: string): boolean {
  return spec.includes("apps/") || spec.includes(appAlias) || spec.includes(editorFeature);
}

describe("the kit does not import the campaign feature (D87)", () => {
  test("every file in the package kit is free of the editor feature, the app alias, and the messages module", () => {
    const violations = packageFiles
      .map((file) => {
        const specs = importSpecs(readFileSync(join(packageKitDir, file), "utf-8")).filter(hitsEditorFeature);
        return { file, specs };
      })
      .filter((entry) => entry.specs.length > 0);
    expect(violations).toEqual([]);
  });

  test("every file under the package kit's __tests__ is free of apps/, the app alias, and the editor feature", () => {
    const violations = packageTestFiles
      .map((file) => {
        const specs = importSpecs(readFileSync(join(packageTestDir, file), "utf-8")).filter(hitsAppWorkspace);
        return { file, specs };
      })
      .filter((entry) => entry.specs.length > 0);
    expect(violations).toEqual([]);
  });

  test("every web kit file outside the allowlist is free of editor-feature imports", () => {
    const violations = webFiles
      .filter((file) => !(file in allowlist))
      .map((file) => {
        const specs = importSpecs(readFileSync(join(webKitDir, file), "utf-8")).filter((spec) =>
          spec.includes(editorFeature),
        );
        return { file, specs };
      })
      .filter((entry) => entry.specs.length > 0);
    expect(violations).toEqual([]);
  });

  test("every allowlist entry still matches a web kit file that still needs it, each with a reason", () => {
    for (const [file, reason] of Object.entries(allowlist)) {
      expect(reason.trim().length, `${file} must carry a one-line reason`).toBeGreaterThan(0);
      const source = webFiles.includes(file) ? readFileSync(join(webKitDir, file), "utf-8") : "";
      const specs = importSpecs(source);
      expect(
        specs.some((spec) => spec.includes(editorFeature)),
        `${file} no longer imports the campaign feature — remove its allowlist entry (the list may only shrink)`,
      ).toBe(true);
    }
  });

  test("mode-panel has left the kit entirely", () => {
    expect(packageFiles).not.toContain("mode-panel.tsx");
    expect(webFiles).not.toContain("mode-panel.tsx");
  });
});
