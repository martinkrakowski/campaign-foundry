import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DISPLAY_SIZE_VALUES } from "@campaignfoundry/CampaignOrchestration/display-sizes";
import {
  CREATIVE_TYPES,
  CREATIVE_TYPE_RULES,
} from "@campaignfoundry/CampaignOrchestration/creative-types";
import {
  CANONICAL_TEMPLATES,
  type CanonicalTemplateId,
} from "@campaignfoundry/CampaignOrchestration/creative-templates";
import {
  isBriefTemplate,
  templateFromCanonical,
} from "@campaignfoundry/CampaignOrchestration/brief-template";
import {
  LAYER_KINDS,
  type LayerKind,
} from "@campaignfoundry/CampaignOrchestration/layer-kinds";
import {
  addableKinds,
  canMoveLayer,
  findLegalInsertionIndex,
  layerMoveDirections,
  platformsToFormats,
  platformsToRatios,
  platformsToSizes,
  clampPolicy,
  removableLayerIds,
  OCCLUSION_TABLE,
  checkPairOcclusion,
  checkRepositionOcclusion,
  findOcclusionDelta,
} from "../derive";
import * as deriveModule from "../derive";
import {
  initialEditorState,
  editorReducer,
  axisProductSize,
  type EditorState,
} from "../editor-state";

describe("derive.ts", () => {
  describe("platformsToFormats", () => {
    test("returns static when platforms is empty or invalid", () => {
      expect(platformsToFormats([])).toEqual(["static"]);
      expect(platformsToFormats(["nonexistent"])).toEqual(["static"]);
    });

    test("derives static for photo-only platforms in canonical order", () => {
      expect(platformsToFormats(["instagram-feed", "linkedin"])).toEqual([
        "static",
      ]);
    });

    test("derives motion for video-only platforms", () => {
      expect(platformsToFormats(["instagram-story", "tiktok"])).toEqual([
        "motion",
      ]);
    });

    test("derives static and motion for mixed platforms in canonical order", () => {
      expect(platformsToFormats(["tiktok", "instagram-feed"])).toEqual([
        "static",
        "motion",
      ]);
    });

    test("a mixed social+display selection stays static when no motion platform is selected", () => {
      expect(platformsToFormats(["instagram-feed", "google-display"])).toEqual([
        "static",
      ]);
    });
  });

  describe("platformsToRatios", () => {
    test("returns empty array for empty or invalid platforms", () => {
      expect(platformsToRatios([])).toEqual([]);
      expect(platformsToRatios(["nonexistent"])).toEqual([]);
    });

    test("derives canonical ratios from platforms", () => {
      expect(platformsToRatios(["instagram-feed"])).toEqual(["1:1"]);
      expect(platformsToRatios(["instagram-feed", "x"])).toEqual([
        "1:1",
        "16:9",
      ]);
      expect(platformsToRatios(["instagram-story", "linkedin"])).toEqual([
        "1:1",
        "9:16",
      ]);
      expect(
        platformsToRatios(["instagram-reel", "x", "instagram-feed"]),
      ).toEqual(["1:1", "9:16", "16:9"]);
    });

    test("a display profile contributes no ratio, even in a mixed selection", () => {
      // Treating a display profile as "1:1" would make the empty case below fail.
      expect(platformsToRatios(["google-display"])).toEqual([]);
      expect(platformsToRatios(["instagram-feed", "google-display"])).toEqual([
        "1:1",
      ]);
    });
  });

  describe("platformsToSizes", () => {
    test("returns empty for empty, invalid, or social-only platforms", () => {
      expect(platformsToSizes([])).toEqual([]);
      expect(platformsToSizes(["nonexistent"])).toEqual([]);
      expect(platformsToSizes(["instagram-feed", "linkedin"])).toEqual([]);
    });

    test("dedupes in DISPLAY_SIZE_VALUES order, not insertion order", () => {
      expect(
        platformsToSizes(["google-display", "meta-audience-network"]),
      ).toEqual([...DISPLAY_SIZE_VALUES]);
      expect(
        platformsToSizes(["meta-audience-network", "google-display"]),
      ).toEqual([...DISPLAY_SIZE_VALUES]);
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
    const stateWithLayers = (
      layers: readonly { id: string; kind: LayerKind }[],
    ) => {
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
      const noShade = stateWithLayers(
        state.template.layers.filter((l) => l.kind !== "shade"),
      );
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
      const noTexts = stateWithLayers(
        state.template.layers.filter((l) => l.kind !== "static-text"),
      );
      expect(addableKinds(noTexts)).toContain("static-text");
      expect(addableKinds(noTexts)).toContain("animated-text");
    });

    test("addableKinds preserves the canonical accepts order", () => {
      const state = initialEditorState();
      const kinds = addableKinds(state);
      expect(kinds.length).toBeGreaterThan(0);
      const accepts = CREATIVE_TYPE_RULES["image-text"].accepts;
      for (let i = 1; i < kinds.length; i++) {
        expect(accepts.indexOf(kinds[i])).toBeGreaterThan(
          accepts.indexOf(kinds[i - 1]),
        );
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
      const doubled = [
        ...state.template.layers,
        { id: "image-2", kind: "image" as const },
      ];
      const removable = removableLayerIds(stateWithLayers(doubled));
      expect(removable).toContain("image");
      expect(removable).toContain("image-2");
      // The other required kind is still present once, so it stays pinned.
      expect(removable).not.toContain("static-text");
    });

    test("another creative type's table row drives the same derivations", () => {
      // video caps logo and shade and caps animated-text via shared budget: the canonical
      // video template holds one of each capped kind, so they stay unoffered
      // while video remains addable.
      const state = initialEditorState();
      const videoState = {
        ...state,
        template: templateFromCanonical("short-video"),
      };
      expect(addableKinds(videoState)).not.toContain("animated-text");
      expect(addableKinds(videoState)).toContain("video");
      expect(addableKinds(videoState)).not.toContain("logo");
      expect(addableKinds(videoState)).not.toContain("shade");
      expect(removableLayerIds(videoState)).not.toContain("video");
      expect(removableLayerIds(videoState)).not.toContain("animated-text");
      expect(removableLayerIds(videoState)).toContain("logo");
      expect(removableLayerIds(videoState)).toContain("shade");
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
        const members = [...list[0].matchAll(/"([^"]*)"|'([^']*)'/g)].map(
          (m) => m[1] ?? m[2],
        );
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
      const singleQuoted =
        "[" + "'static-text', 'animated-text', \"headline-top\"" + "]";
      expect(literalKindLists(doubleQuoted)).toHaveLength(1);
      expect(literalKindLists(singleQuoted)).toHaveLength(1);
    });

    test("the D121 scanner ignores a single kind, non-kind strings, and non-list syntax", () => {
      const oneKind = "[" + '"image", "static"' + "]";
      expect(literalKindLists(oneKind)).toEqual([]);
      expect(
        literalKindLists('const kind = "shade"; { kind: "accent" }'),
      ).toEqual([]);
    });
  });

  describe("layer move derivations (D128)", () => {
    test("the first layer offers no down and the last offers no up", () => {
      // Rebuilt on a template where the boundary check is the only thing under test (L8m-fix):
      // an unconstrained creative type (image-html) whose layers have no ordering constraints.
      // In canonical image-text, the move down of layer 0 was already forbidden by
      // "shade directly above image", masking the boundary check (index > 0). With an
      // unconstrained first and last layer, removing the index checks (index > 0 / index < length - 1)
      // in layerMoveDirections makes these assertions fail (verified by mutation).
      const unconstrainedState: EditorState = {
        ...initialEditorState(),
        template: {
          id: "canonical-image-html",
          version: 1,
          creativeType: "image-html",
          unit: "standard-web",
          layers: [
            { id: "layer-image", kind: "image" },
            { id: "layer-html", kind: "html" },
            { id: "layer-logo", kind: "logo" },
          ],
        },
      };

      expect(canMoveLayer(unconstrainedState, 0, "down")).toBe(false);
      expect(layerMoveDirections(unconstrainedState, 0)).not.toContain("down");

      const lastIndex = unconstrainedState.template.layers.length - 1;
      expect(canMoveLayer(unconstrainedState, lastIndex, "up")).toBe(false);
      expect(layerMoveDirections(unconstrainedState, lastIndex)).not.toContain(
        "up",
      );
    });

    test("out of bounds index yields no move directions", () => {
      const state = initialEditorState();
      expect(layerMoveDirections(state, -1)).toEqual([]);
      expect(layerMoveDirections(state, 100)).toEqual([]);
    });

    test("a move blocked by an ordering constraint is not offered", () => {
      const state = initialEditorState();
      // Canonical image-text has layers: image (0), shade (1), accent (2), static-text (3), logo (4)
      // Constraints: logo above image, shade directly above image.
      // - shade (index 1) moving down (to 0) or up (to 2) violates "shade directly above image"
      expect(layerMoveDirections(state, 1)).toEqual([]);
      expect(canMoveLayer(state, 1, "down")).toBe(false);
      expect(canMoveLayer(state, 1, "up")).toBe(false);

      // - image (index 0) moving up (to 1) violates "shade directly above image"
      expect(canMoveLayer(state, 0, "up")).toBe(false);

      // - accent (index 2) moving down (to 1) would separate shade from image
      expect(canMoveLayer(state, 2, "down")).toBe(false);
    });

    test("legal moves that satisfy constraints are offered", () => {
      const state = initialEditorState();
      // - accent (index 2) moving up (to 3): swap with static-text is legal
      expect(layerMoveDirections(state, 2)).toEqual(["up"]);
      expect(canMoveLayer(state, 2, "up")).toBe(true);

      // - static-text (index 3) can move down (to 2) or up (to 4)
      expect(layerMoveDirections(state, 3)).toContain("down");
      expect(layerMoveDirections(state, 3)).toContain("up");

      // - logo (index 4) can move down (to 3)
      expect(layerMoveDirections(state, 4)).toEqual(["down"]);
      expect(canMoveLayer(state, 4, "down")).toBe(true);
    });
  });

  describe("addableKinds and addLayer agreement (D124, D128, L8m-fix)", () => {
    test("adding each offered kind to a valid template of each creative type yields a template isBriefTemplate accepts", () => {
      for (const creativeType of CREATIVE_TYPES) {
        const canonical = CANONICAL_TEMPLATES[creativeType];
        const state: EditorState = {
          ...initialEditorState(),
          template: {
            id: canonical.id as CanonicalTemplateId,
            version: canonical.version,
            creativeType: canonical.creativeType,
            unit: canonical.unit,
            layers: canonical.layers,
          },
        };

        // 1. Driven over canonical template offers:
        for (const kind of addableKinds(state)) {
          const next = editorReducer(state, { type: "addLayer", kind });
          expect(isBriefTemplate(next.template)).toBe(true);
        }

        // 2. Driven over minimal valid template (required kinds only):
        const requiredKinds = CREATIVE_TYPE_RULES[creativeType].required;
        const minimalState: EditorState = {
          ...state,
          template: {
            ...state.template,
            layers: canonical.layers.filter((l) =>
              requiredKinds.includes(l.kind),
            ),
          },
        };
        for (const kind of addableKinds(minimalState)) {
          const next = editorReducer(minimalState, { type: "addLayer", kind });
          expect(isBriefTemplate(next.template)).toBe(true);
        }

        // 3. Driven over partial states, e.g. image-text with image and logo
        // (the motivating case where shade directly-above image):
        if (creativeType === "image-text") {
          const imageLogoState: EditorState = {
            ...state,
            template: {
              ...state.template,
              layers: [
                { id: "image", kind: "image" },
                { id: "logo", kind: "logo" },
              ],
            },
          };
          const imageLogoOffered = addableKinds(imageLogoState);
          expect(imageLogoOffered).toContain("shade");
          for (const kind of imageLogoOffered) {
            const next = editorReducer(imageLogoState, {
              type: "addLayer",
              kind,
            });
            expect(isBriefTemplate(next.template)).toBe(true);
          }
          // Verify shade was placed directly above image (index 1), not appended at index 2
          const withShade = editorReducer(imageLogoState, {
            type: "addLayer",
            kind: "shade",
          });
          expect(withShade.template.layers[0].kind).toBe("image");
          expect(withShade.template.layers[1].kind).toBe("shade");
          expect(withShade.template.layers[2].kind).toBe("logo");
        }
      }
    });

    test("findLegalInsertionIndex finds the highest legal index preferring topmost", () => {
      // In canonical image-text without logo:
      const noLogoLayers = CANONICAL_TEMPLATES["image-text"].layers.filter(
        (l) => l.kind !== "logo",
      );
      expect(findLegalInsertionIndex("image-text", noLogoLayers, "logo")).toBe(
        noLogoLayers.length,
      );

      // In image-text with image and logo, shade cannot be topmost (2) but can be at 1:
      const imageLogo = [
        { id: "image", kind: "image" as const },
        { id: "logo", kind: "logo" as const },
      ];
      expect(findLegalInsertionIndex("image-text", imageLogo, "shade")).toBe(1);
    });
  });

  describe("occlusion exports (D135, D136, L8o-fix2, L8o-fix5)", () => {
    test("re-exports active occlusion checks and does not export checkTemplateOcclusion", () => {
      expect(typeof checkPairOcclusion).toBe("function");
      expect(typeof checkRepositionOcclusion).toBe("function");
      expect(typeof findOcclusionDelta).toBe("function");
      expect(OCCLUSION_TABLE).toBeDefined();
      expect("checkTemplateOcclusion" in deriveModule).toBe(false);
    });
  });
});
