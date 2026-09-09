import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DISPLAY_SIZE_VALUES } from "@campaignfoundry/CampaignOrchestration/display-sizes";
import { CREATIVE_TYPE_RULES } from "@campaignfoundry/CampaignOrchestration/creative-types";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { LAYER_KINDS, type LayerKind } from "@campaignfoundry/CampaignOrchestration/layer-kinds";
import {
  addableKinds,
  platformsToFormats,
  platformsToRatios,
  platformsToSizes,
  clampPolicy,
  removableLayerIds,
} from "../derive";
import { initialEditorState, axisProductSize } from "../editor-state";

describe("derive.ts", () => {
  describe("platformsToFormats", () => {
    test("returns static when platforms is empty or invalid", () => {
      expect(platformsToFormats([])).toEqual(["static"]);
      expect(platformsToFormats(["nonexistent"])).toEqual(["static"]);
    });

    test("derives static for photo-only platforms in canonical order", () => {
      expect(platformsToFormats(["instagram-feed", "linkedin"])).toEqual(["static"]);
    });

    test("derives motion for video-only platforms", () => {
      expect(platformsToFormats(["instagram-story", "tiktok"])).toEqual(["motion"]);
    });

    test("derives static and motion for mixed platforms in canonical order", () => {
      expect(platformsToFormats(["tiktok", "instagram-feed"])).toEqual(["static", "motion"]);
    });

    test("a mixed social+display selection stays static when no motion platform is selected", () => {
      expect(platformsToFormats(["instagram-feed", "google-display"])).toEqual(["static"]);
    });
  });

  describe("platformsToRatios", () => {
    test("returns empty array for empty or invalid platforms", () => {
      expect(platformsToRatios([])).toEqual([]);
      expect(platformsToRatios(["nonexistent"])).toEqual([]);
    });

    test("derives canonical ratios from platforms", () => {
      expect(platformsToRatios(["instagram-feed"])).toEqual(["1:1"]);
      expect(platformsToRatios(["instagram-feed", "x"])).toEqual(["1:1", "16:9"]);
      expect(platformsToRatios(["instagram-story", "linkedin"])).toEqual(["1:1", "9:16"]);
      expect(platformsToRatios(["instagram-reel", "x", "instagram-feed"])).toEqual(["1:1", "9:16", "16:9"]);
    });

    test("a display profile contributes no ratio, even in a mixed selection", () => {
      // Treating a display profile as "1:1" would make the empty case below fail.
      expect(platformsToRatios(["google-display"])).toEqual([]);
      expect(platformsToRatios(["instagram-feed", "google-display"])).toEqual(["1:1"]);
    });
  });

  describe("platformsToSizes", () => {
    test("returns empty for empty, invalid, or social-only platforms", () => {
      expect(platformsToSizes([])).toEqual([]);
      expect(platformsToSizes(["nonexistent"])).toEqual([]);
      expect(platformsToSizes(["instagram-feed", "linkedin"])).toEqual([]);
    });

    test("dedupes in DISPLAY_SIZE_VALUES order, not insertion order", () => {
      expect(platformsToSizes(["google-display", "meta-audience-network"])).toEqual([...DISPLAY_SIZE_VALUES]);
      expect(platformsToSizes(["meta-audience-network", "google-display"])).toEqual([...DISPLAY_SIZE_VALUES]);
    });
  });

  describe("clampPolicy", () => {
    test("clamps variation.count when it exceeds axisProductSize and sets countNotice", () => {
      const state = {
        ...initialEditorState("variation"),
        variation: {
          ...initialEditorState("variation").variation,
          count: "1000",
          layout: ["headline-top"],
          tone: ["bold"],
          ratio: ["1:1"],
          background: ["procedural"],
          paletteShift: [0],
        },
        countNotice: null,
      };
      const max = axisProductSize(state);
      expect(max).toBeLessThan(1000);

      const clamped = clampPolicy(state);
      expect(clamped.variation.count).toBe(String(max));
      expect(clamped.countNotice).toBe(max);
    });

    test("leaves count unchanged and clears notice when count is within ceiling", () => {
      const state = {
        ...initialEditorState("variation"),
        variation: {
          ...initialEditorState("variation").variation,
          count: "2",
        },
        countNotice: 10,
      };
      const clamped = clampPolicy(state);
      expect(clamped.variation.count).toBe("2");
      expect(clamped.countNotice).toBeNull();
    });

    test("returns identical state when count is within ceiling and countNotice is already null", () => {
      const state = {
        ...initialEditorState("variation"),
        variation: {
          ...initialEditorState("variation").variation,
          count: "2",
        },
        countNotice: null,
      };
      const clamped = clampPolicy(state);
      expect(clamped).toBe(state);
    });

    test("treats a non-numeric count as 0 so it can never clamp above the ceiling", () => {
      const state = {
        ...initialEditorState("variation"),
        variation: {
          ...initialEditorState("variation").variation,
          count: "abc",
        },
        countNotice: null,
      };
      // parseInt("abc") → NaN → `|| 0` → 0, which is within the ceiling, so the
      // state is returned unchanged (no spurious clamp, no notice).
      const clamped = clampPolicy(state);
      expect(clamped).toBe(state);
    });
  });

  describe("layer cardinality derivations (D124)", () => {
    const stateWithLayers = (layers: readonly { id: string; kind: LayerKind }[]) => {
      const state = initialEditorState();
      return { ...state, template: { ...state.template, layers } };
    };

    test("addableKinds omits a kind already at its limit and includes one below it", () => {
      // Canonical image-text: one logo, one shade, one accent, one static-text —
      // every decorated kind sits at its declared cap, and the shared text budget
      // is full. Only the uncapped kind remains.
      const state = initialEditorState();
      expect(addableKinds(state)).toEqual(["image"]);
      // Below the cap: dropping the shade frees the single slot the table declares.
      const noShade = stateWithLayers(state.template.layers.filter((l) => l.kind !== "shade"));
      expect(addableKinds(noShade)).toContain("shade");
    });

    test("addableKinds reads the shared text budget from the table", () => {
      // static-text is present, so the one-slot budget is spent: neither text kind
      // may be offered — adding the other would be a brief the boundary refuses.
      const state = initialEditorState();
      expect(addableKinds(state)).not.toContain("static-text");
      expect(addableKinds(state)).not.toContain("animated-text");
      // With the text layer gone the budget is free again: either text kind is
      // offered (and the boundary will still hold the template to `required`).
      const noTexts = stateWithLayers(state.template.layers.filter((l) => l.kind !== "static-text"));
      expect(addableKinds(noTexts)).toContain("static-text");
      expect(addableKinds(noTexts)).toContain("animated-text");
    });

    test("addableKinds preserves the canonical accepts order", () => {
      const state = initialEditorState();
      const kinds = addableKinds(state);
      expect(kinds.length).toBeGreaterThan(0);
      const accepts = CREATIVE_TYPE_RULES["image-text"].accepts;
      for (let i = 1; i < kinds.length; i++) {
        expect(accepts.indexOf(kinds[i])).toBeGreaterThan(accepts.indexOf(kinds[i - 1]));
      }
    });

    test("removableLayerIds omits a required kind present once", () => {
      // Canonical image-text: image and static-text are required, each present
      // once — neither may be offered for removal; the rest may.
      const removable = removableLayerIds(initialEditorState());
      expect(removable).not.toContain("image");
      expect(removable).not.toContain("static-text");
      expect(removable).toContain("shade");
      expect(removable).toContain("accent");
      expect(removable).toContain("logo");
    });

    test("removableLayerIds includes a required kind still present twice", () => {
      const state = initialEditorState();
      const doubled = [...state.template.layers, { id: "image-2", kind: "image" as const }];
      const removable = removableLayerIds(stateWithLayers(doubled));
      expect(removable).toContain("image");
      expect(removable).toContain("image-2");
      // The other required kind is still present once, so it stays pinned.
      expect(removable).not.toContain("static-text");
    });

    test("another creative type's table row drives the same derivations", () => {
      // video caps logo and shade and declares no shared budget: the canonical
      // video template holds one of each capped kind, so the two stay unoffered
      // while the uncapped kinds remain — the fallback for an absent shared
      // budget is table data too, not editor logic.
      const state = initialEditorState();
      const videoState = { ...state, template: templateFromCanonical("short-video") };
      expect(addableKinds(videoState)).toContain("animated-text");
      expect(addableKinds(videoState)).toContain("video");
      expect(addableKinds(videoState)).not.toContain("logo");
      expect(addableKinds(videoState)).not.toContain("shade");
      expect(removableLayerIds(videoState)).not.toContain("video");
      expect(removableLayerIds(videoState)).toContain("logo");
    });

    // Protects D121: CREATIVE_TYPE_RULES is the single source of what a creative
    // type accepts and how many of each kind it holds. A literal kind list in
    // the editor is the second copy the whole arc exists to remove — the guard
    // refuses any bracketed list of two or more bare layer-kind strings under
    // this directory; deriving from the imported table is the only sanctioned
    // spelling. The guard's own test inputs are built by concatenation so this
    // file's raw text never quotes the syntax it hunts.
    const LITERAL_KIND_LIST =
      /\[\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?:\s*,\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))+\s*\]/g;
    const kinds = new Set<string>(LAYER_KINDS);

    const literalKindLists = (source: string): string[] => {
      const offenders: string[] = [];
      for (const list of source.matchAll(LITERAL_KIND_LIST)) {
        const members = [...list[0].matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
        const named = members.filter((member) => kinds.has(member));
        if (named.length >= 2) offenders.push(list[0]);
      }
      return offenders;
    };

    test("no campaign file restates the layer vocabulary as a literal list (D121)", () => {
      const dir = path.resolve(__dirname, "..");
      const offenders: string[] = [];
      const walk = (dirPath: string): void => {
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
          const full = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          for (const list of literalKindLists(fs.readFileSync(full, "utf8"))) {
            offenders.push(`${path.relative(dir, full)}: ${list}`);
          }
        }
      };
      walk(dir);
      expect(offenders).toEqual([]);
    });

    test("the D121 scanner flags a list naming two or more layer kinds, in either quote style", () => {
      const doubleQuoted = "[" + '"image", "logo"' + "]";
      const singleQuoted = "[" + "'static-text', 'animated-text', \"headline-top\"" + "]";
      expect(literalKindLists(doubleQuoted)).toHaveLength(1);
      expect(literalKindLists(singleQuoted)).toHaveLength(1);
    });

    test("the D121 scanner ignores a single kind, non-kind strings, and non-list syntax", () => {
      const oneKind = "[" + '"image", "static"' + "]";
      expect(literalKindLists(oneKind)).toEqual([]);
      expect(literalKindLists('const kind = "shade"; { kind: "accent" }')).toEqual([]);
    });
  });
});
