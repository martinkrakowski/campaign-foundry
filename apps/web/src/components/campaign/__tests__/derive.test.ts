import { describe, test, expect, vi } from "vitest";
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
  type BriefTemplate,
} from "@campaignfoundry/CampaignOrchestration/brief-template";
import { LAYER_KINDS, type LayerKind } from "@campaignfoundry/CampaignOrchestration/layer-kinds";
import { assembleHtml } from "@campaignfoundry/CampaignOrchestration/markup-assembler";
import type { CreativeTemplateLayer } from "@campaignfoundry/CampaignOrchestration/creative-templates";
import type { PlatformProfile } from "@campaignfoundry/Distribution/platform-profiles";
import {
  addableKinds,
  canMoveLayer,
  findLegalInsertionIndex,
  htmlByteBudget,
  htmlWeightReading,
  layerMoveDirections,
  platformsToFormats,
  platformsToRatios,
  platformsToSizes,
  disableableLayerIds,
  findOcclusionDeltaOverEnabled,
  removableLayerIds,
  toggleableLayerIds,
  OCCLUSION_TABLE,
  checkPairOcclusion,
  checkRepositionOcclusion,
  findOcclusionDelta,
} from "../derive";
import * as deriveModule from "../derive";
import { initialEditorState, editorReducer, type EditorState } from "../editor-state";

// The weight meter's memo (HL5c) is only observable at the seam it protects: how
// many times the markup is actually assembled. Wrap the assembler with a spy that
// still runs the real thing, so every other assertion in this file keeps reading
// byte-exact figures while the memo tests count the assemblies behind them.
const { assembleSpy } = vi.hoisted(() => ({ assembleSpy: vi.fn() }));
vi.mock("@campaignfoundry/CampaignOrchestration/markup-assembler", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@campaignfoundry/CampaignOrchestration/markup-assembler")
    >();
  assembleSpy.mockImplementation((options) =>
    actual.assembleHtml(options as Parameters<typeof actual.assembleHtml>[0]),
  );
  return { ...actual, assembleHtml: assembleSpy };
});

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
      expect(platformsToRatios(["instagram-reel", "x", "instagram-feed"])).toEqual([
        "1:1",
        "9:16",
        "16:9",
      ]);
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
      expect(platformsToSizes(["google-display", "meta-audience-network"])).toEqual([
        ...DISPLAY_SIZE_VALUES,
      ]);
      expect(platformsToSizes(["meta-audience-network", "google-display"])).toEqual([
        ...DISPLAY_SIZE_VALUES,
      ]);
    });
  });

  describe("layer cardinality derivations (D124)", () => {
    const stateWithLayers = (
      layers: readonly { id: string; kind: LayerKind; enabled?: boolean }[],
    ) => {
      const state = initialEditorState();
      return { ...state, template: { ...state.template, layers } };
    };

    test("addableKinds omits a kind already at its limit and includes one below it", () => {
      // Canonical image-text: one logo, one shade, one accent, one static-text —
      // every decorated kind sits at its declared cap, and the shared text budget
      // is full. The uncapped kinds remain: `image`, and `fill` since L11 gave
      // the kind a drawer and `image-text` a slot for it (D131), with no cap
      // because each fill owns its own frame.
      const state = initialEditorState();
      // One expect per kind, and a length: D121's scanner refuses a literal
      // list of the vocabulary in a `campaign/` file, tests included.
      expect(addableKinds(state)).toHaveLength(2);
      expect(addableKinds(state)).toContain("image");
      expect(addableKinds(state)).toContain("fill");
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

    test("removableLayerIds omits an enabled required layer when only one enabled instance exists alongside a disabled one, but offers the disabled one", () => {
      const state = initialEditorState();
      const withDisabled = [
        ...state.template.layers,
        { id: "image-disabled", kind: "image" as const, enabled: false },
      ];
      const removable = removableLayerIds(stateWithLayers(withDisabled));
      // Removing the enabled instance leaves zero enabled instances of a required kind,
      // which the boundary refuses. The enabled layer must not be offered.
      expect(removable).not.toContain("image");
      // Removing the disabled instance does not change the enabled count and stays allowed.
      expect(removable).toContain("image-disabled");
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
  });

  describe("the layer toggle (L9, D129, MP-D4)", () => {
    const stateWithLayers = (
      layers: readonly { id: string; kind: LayerKind; enabled?: boolean }[],
    ) => {
      const state = initialEditorState();
      return { ...state, template: { ...state.template, layers } };
    };

    test("disableableLayerIds holds every optional layer and no required kind present once", () => {
      // Canonical image-text: image and static-text are required, each present
      // once — switching either off would leave the type without an enabled
      // instance of it, which the boundary refuses (MP-D4).
      const disableable = disableableLayerIds(initialEditorState());
      expect(disableable).not.toContain("image");
      expect(disableable).not.toContain("static-text");
      expect(disableable).toContain("shade");
      expect(disableable).toContain("accent");
      expect(disableable).toContain("logo");
    });

    test("disableableLayerIds offers both instances of a required kind present twice enabled", () => {
      const state = initialEditorState();
      const doubled = [...state.template.layers, { id: "image-2", kind: "image" as const }];
      const disableable = disableableLayerIds(stateWithLayers(doubled));
      expect(disableable).toContain("image");
      expect(disableable).toContain("image-2");
    });

    test("disableableLayerIds omits the last enabled instance of a required kind, and never offers a layer already off", () => {
      const state = initialEditorState();
      const withDisabled = [
        ...state.template.layers,
        { id: "image-disabled", kind: "image" as const, enabled: false },
      ];
      const disableable = disableableLayerIds(stateWithLayers(withDisabled));
      // One enabled instance left: switching it off strips the type of a kind it
      // requires, so the offer is absent — never present-and-disabled (§1.5).
      expect(disableable).not.toContain("image");
      // A layer that is already off cannot be switched off a second time.
      expect(disableable).not.toContain("image-disabled");
    });

    test("toggleableLayerIds adds every disabled layer to the disableable set", () => {
      const state = initialEditorState();
      const withDisabled = [
        ...state.template.layers,
        { id: "image-disabled", kind: "image" as const, enabled: false },
      ];
      const toggleable = toggleableLayerIds(stateWithLayers(withDisabled));
      // The disabled instance carries a toggle — to switch it back on.
      expect(toggleable).toContain("image-disabled");
      // The last enabled required instance carries none at all.
      expect(toggleable).not.toContain("image");
      // An optional layer carries one either way.
      expect(toggleable).toContain("shade");
    });

    test("toggleableLayerIds is exactly the disableable set on a template holding no disabled layer", () => {
      const state = initialEditorState();
      expect(toggleableLayerIds(state)).toEqual(disableableLayerIds(state));
    });

    test("findOcclusionDeltaOverEnabled ignores a disabled layer: it occludes nothing (MP-D3)", () => {
      const image = { id: "image", kind: "image" as const };
      const text = { id: "static-text", kind: "static-text" as const };
      const shade = { id: "shade", kind: "shade" as const };
      const off = { ...shade, enabled: false };
      // Enabled, the shade sits above the headline and mutes it.
      expect(findOcclusionDeltaOverEnabled([image, shade, text], [image, text, shade])).toEqual({
        above: "shade",
        below: "static-text",
        behavior: "attenuating",
      });
      // Disabled, it draws nothing — the same move is no finding at all.
      expect(findOcclusionDeltaOverEnabled([image, off, text], [image, text, off])).toBeNull();
      // And the layer a disabled one would have occluded is left out of the
      // comparison entirely: no pair involving it can be a new finding.
      expect(findOcclusionDeltaOverEnabled([], [image, off, text])).toBeNull();
      expect(findOcclusionDeltaOverEnabled([], [image, text, shade])).toEqual({
        above: "shade",
        below: "static-text",
        behavior: "attenuating",
      });
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
            { id: "layer-shade", kind: "shade" },
            { id: "layer-logo", kind: "logo" },
          ],
        },
      };

      expect(canMoveLayer(unconstrainedState, 0, "down")).toBe(false);
      expect(layerMoveDirections(unconstrainedState, 0)).not.toContain("down");

      const lastIndex = unconstrainedState.template.layers.length - 1;
      expect(canMoveLayer(unconstrainedState, lastIndex, "up")).toBe(false);
      expect(layerMoveDirections(unconstrainedState, lastIndex)).not.toContain("up");
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
            layers: canonical.layers.filter((l) => requiredKinds.includes(l.kind)),
          },
        };
        for (const kind of addableKinds(minimalState)) {
          const next = editorReducer(minimalState, { type: "addLayer", kind });
          expect(isBriefTemplate(next.template)).toBe(true);
        }

        // 3. Driven over partial states, e.g. image-text missing its optional
        // middle layers (the motivating case where shade directly-above image):
        // X11 made the guard mirror the API's required-kind rule, so the
        // partial base must itself be a valid template — offers from an
        // already-invalid base prove nothing about agreement.
        if (creativeType === "image-text") {
          const imageLogoState: EditorState = {
            ...state,
            template: {
              ...state.template,
              layers: [
                { id: "image", kind: "image" },
                { id: "static-text", kind: "static-text" },
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
          expect(withShade.template.layers[2].kind).toBe("static-text");
          expect(withShade.template.layers[3].kind).toBe("logo");
        }
      }
    });

    test("findLegalInsertionIndex finds the highest legal index preferring topmost", () => {
      // In canonical image-text without logo:
      const noLogoLayers = CANONICAL_TEMPLATES["image-text"].layers.filter(
        (l) => l.kind !== "logo",
      );
      expect(findLegalInsertionIndex("image-text", noLogoLayers, "logo")).toBe(noLogoLayers.length);

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

  describe("html weight meter derivations (HL5c, HL-D6)", () => {
    const ZERO = { top: 0, right: 0, bottom: 0, left: 0 } as const;

    /** An html profile for the two seams that take an injected table. */
    const fakeHtml = (id: string, over: Partial<PlatformProfile> = {}): PlatformProfile => ({
      id,
      label: `Fake ${id}`,
      formats: ["html"],
      sizes: [{ size: "300x250", insets: ZERO }],
      safeInsets: ZERO,
      maxBytes: 64,
      ...over,
    });

    describe("htmlByteBudget", () => {
      test("no html profile among the platforms → no budget", () => {
        expect(htmlByteBudget(["instagram-feed", "google-display"])).toBeUndefined();
        expect(htmlByteBudget([])).toBeUndefined();
        // An id no profile matches is skipped, not a crash.
        expect(htmlByteBudget(["nonexistent-platform"])).toBeUndefined();
      });

      test("the budget is the selected html profile's own maxBytes (HL-D6)", () => {
        const budget = htmlByteBudget(["google-display-html"]);
        expect(budget?.label).toBe("Google Display (HTML5)");
        expect(budget?.maxBytes).toBe(150 * 1024);
      });

      test("two html profiles → the SMALLEST maxBytes is the budget", () => {
        const profiles = {
          wide: fakeHtml("wide", { maxBytes: 200 * 1024 }),
          tight: fakeHtml("tight", { maxBytes: 100 * 1024, label: "Tight" }),
        };
        const budget = htmlByteBudget(["wide", "tight"], profiles);
        expect(budget?.maxBytes).toBe(100 * 1024);
        expect(budget?.label).toBe("Tight");
        // Order-independent: the tightest wins whichever way they are listed.
        expect(htmlByteBudget(["tight", "wide"], profiles)?.maxBytes).toBe(100 * 1024);
      });
    });

    const picture = (over: Partial<CreativeTemplateLayer> = {}): CreativeTemplateLayer => ({
      id: "image",
      kind: "image",
      ...over,
    });
    const copy = (over: Partial<CreativeTemplateLayer> = {}): CreativeTemplateLayer => ({
      id: "copy",
      kind: "static-text",
      ...over,
    });
    const htmlTemplate = (
      layers: readonly CreativeTemplateLayer[] = [
        picture(),
        copy(),
        { id: "shade", kind: "shade" },
        { id: "logo", kind: "logo" },
      ],
    ): BriefTemplate => ({
      id: "canonical-image-html",
      version: 1,
      creativeType: "image-html",
      unit: "standard-web",
      layers,
    });

    const meterState = (over: Partial<EditorState> = {}): EditorState =>
      ({
        ...initialEditorState(),
        template: htmlTemplate(),
        platforms: ["google-display-html"],
        sizes: ["300x250"],
        campaignMessage: "Stay wild",
        products: [
          {
            key: 1,
            id: "alpha",
            name: "A",
            primaryColor: "#1473E6",
            logoPath: "l.png",
            inputAsset: "",
            idTouched: true,
          },
        ],
        ...over,
      }) as EditorState;

    describe("htmlWeightReading", () => {
      test("no html profile selected → no reading", () => {
        expect(htmlWeightReading(meterState({ platforms: ["instagram-feed"] }))).toBeUndefined();
      });

      test("the figure is assembleHtml's byteLength for the same layers and headline", () => {
        const layers = [
          picture(),
          copy({ link: true }),
          { id: "shade", kind: "shade" as const },
          { id: "logo", kind: "logo" as const },
        ];
        const state = meterState({
          template: htmlTemplate(layers),
          clickDestination: "https://example.com/shop",
          campaignMessage: "Stay wild",
        });
        const expected = assembleHtml({
          layers,
          headline: "Stay wild",
          canvas: { size: "300x250" },
          brandColor: "#1473E6",
          style: state.style,
          clickDestination: "https://example.com/shop",
        }).byteLength;
        const reading = htmlWeightReading(state);
        expect(reading?.bytes).toBe(expected);
        expect(reading?.maxBytes).toBe(150 * 1024);
        expect(reading?.profileLabel).toBe("Google Display (HTML5)");
        expect(reading?.overBy).toBe(0);
      });

      test("a longer headline increases the measured bytes", () => {
        const layers = [
          picture(),
          copy(),
          { id: "shade", kind: "shade" as const },
          { id: "logo", kind: "logo" as const },
        ];
        const before = htmlWeightReading(
          meterState({ template: htmlTemplate(layers), campaignMessage: "A" }),
        );
        const after = htmlWeightReading(
          meterState({ template: htmlTemplate(layers), campaignMessage: "A".repeat(80) }),
        );
        expect(before).toBeDefined();
        expect(after?.bytes).toBeGreaterThan(before?.bytes ?? 0);
      });

      test("the figure is the LARGEST across the selected sizes", () => {
        const layers = htmlTemplate().layers;
        const state = meterState({ sizes: ["320x50", "300x600"] });
        const small = assembleHtml({
          layers,
          headline: "Stay wild",
          canvas: { size: "320x50" },
          brandColor: "#1473E6",
          style: state.style,
        }).byteLength;
        const large = assembleHtml({
          layers,
          headline: "Stay wild",
          canvas: { size: "300x600" },
          brandColor: "#1473E6",
          style: state.style,
        }).byteLength;
        expect(small).not.toBe(large);
        expect(htmlWeightReading(state)?.bytes).toBe(Math.max(small, large));
      });

      test("a disabled layer is not measured", () => {
        const measured = [
          picture(),
          copy(),
          { id: "shade", kind: "shade" as const },
          { id: "logo", kind: "logo" as const },
        ];
        const state = meterState({
          template: htmlTemplate([...measured, copy({ id: "copy-off", enabled: false })]),
          campaignMessage: "Stay wild",
        });
        const expected = assembleHtml({
          layers: measured,
          headline: "Stay wild",
          canvas: { size: "300x250" },
          brandColor: "#1473E6",
          style: state.style,
        }).byteLength;
        // The disabled copy would have emitted the same headline again.
        const withIt = assembleHtml({
          layers: [...measured, copy({ id: "copy-off" })],
          headline: "Stay wild",
          canvas: { size: "300x250" },
          brandColor: "#1473E6",
          style: state.style,
        }).byteLength;
        expect(withIt).toBeGreaterThan(expected);
        expect(htmlWeightReading(state)?.bytes).toBe(expected);
      });

      test("a selected size the html profile does not carry contributes nothing", () => {
        const profiles = { "odd-html": fakeHtml("odd-html", { maxBytes: 150 * 1024 }) };
        const state = meterState({
          platforms: ["odd-html"],
          sizes: ["728x90"],
        });
        expect(htmlWeightReading(state, profiles)).toBeUndefined();
      });

      test("an html profile with no sizes at all yields no reading", () => {
        const profiles = {
          "ratio-html": fakeHtml("ratio-html", { sizes: undefined, ratio: "1:1" }),
        };
        expect(
          htmlWeightReading(meterState({ platforms: ["ratio-html"] }), profiles),
        ).toBeUndefined();
      });

      test("a brand colour the assembler refuses leaves nothing to measure", () => {
        expect(
          htmlWeightReading(
            meterState({
              products: [
                {
                  key: 1,
                  id: "alpha",
                  name: "A",
                  primaryColor: "not-a-colour",
                  logoPath: "l.png",
                  inputAsset: "",
                  idTouched: true,
                },
              ],
            }),
          ),
        ).toBeUndefined();
        expect(htmlWeightReading(meterState({ products: [] }))).toBeUndefined();
      });

      test("over budget: overBy names the overage; within budget it is zero", () => {
        const layers = [
          picture(),
          copy(),
          { id: "shade", kind: "shade" as const },
          { id: "logo", kind: "logo" as const },
        ];
        const state = meterState({
          platforms: ["tiny-html"],
          template: htmlTemplate(layers),
          campaignMessage: "A".repeat(500),
        });
        const measured = assembleHtml({
          layers,
          headline: "A".repeat(500),
          canvas: { size: "300x250" },
          brandColor: "#1473E6",
          style: state.style,
        }).byteLength;
        const over = htmlWeightReading(state, {
          "tiny-html": fakeHtml("tiny-html", { maxBytes: 512 }),
        });
        expect(over?.overBy).toBe(measured - 512);
        expect(over?.profileLabel).toBe("Fake tiny-html");
        const within = htmlWeightReading(meterState({ platforms: ["roomy-html"] }), {
          "roomy-html": fakeHtml("roomy-html", { maxBytes: 150 * 1024 }),
        });
        expect(within?.overBy).toBe(0);
      });
    });

    describe("the memo and the expected failure (HL5c fix)", () => {
      const marked = (headline: string): EditorState =>
        meterState({
          campaignMessage: headline,
          template: htmlTemplate([
            picture({ props: { alt: "pack" } }),
            copy({ link: true }),
            { id: "shade", kind: "shade" },
            { id: "logo", kind: "logo", props: { width: 0.2 } },
          ]),
          clickDestination: "https://example.com/shop",
        });

      test("two calls with the same inputs assemble the markup once", () => {
        const state = marked("assemble-once");
        assembleSpy.mockClear();
        const first = htmlWeightReading(state);
        expect(assembleSpy.mock.calls.length).toBeGreaterThan(0);
        const afterFirst = assembleSpy.mock.calls.length;
        const second = htmlWeightReading(state);
        expect(assembleSpy.mock.calls.length).toBe(afterFirst);
        expect(second).toBe(first);
      });

      test("a changed headline re-assembles", () => {
        htmlWeightReading(marked("before-edit"));
        assembleSpy.mockClear();
        htmlWeightReading(marked("after-edit"));
        expect(assembleSpy.mock.calls.length).toBeGreaterThan(0);
      });

      test("changing only a layer link re-weighs", () => {
        const linked = marked("memo-link");
        const unlinked = meterState({
          ...linked,
          template: htmlTemplate([
            picture({ props: { alt: "pack" } }),
            copy(),
            { id: "shade", kind: "shade" },
            { id: "logo", kind: "logo" },
          ]),
        });
        const primed = htmlWeightReading(unlinked);
        const expected = assembleHtml({
          layers: linked.template.layers,
          headline: "memo-link",
          canvas: { size: "300x250" },
          brandColor: "#1473E6",
          style: linked.style,
          clickDestination: "https://example.com/shop",
        }).byteLength;
        expect(primed?.bytes).not.toBe(expected);
        expect(htmlWeightReading(linked)?.bytes).toBe(expected);
      });

      test("a missing or non-hex brand color yields no reading and never calls the assembler", () => {
        const noProducts = { ...marked("no-colour"), products: [] };
        assembleSpy.mockClear();
        expect(htmlWeightReading(noProducts)).toBeUndefined();
        expect(assembleSpy).not.toHaveBeenCalled();
        assembleSpy.mockClear();
        const badColour = meterState({
          campaignMessage: "bad-colour",
          products: [
            {
              key: 1,
              id: "alpha",
              name: "A",
              primaryColor: "rebeccapurple",
              logoPath: "l.png",
              inputAsset: "",
              idTouched: true,
            },
          ],
        });
        expect(htmlWeightReading(badColour)).toBeUndefined();
        expect(assembleSpy).not.toHaveBeenCalled();
      });

      test("an unexpected error from the assembler propagates rather than hiding the meter", () => {
        const state = marked("propagate-boom");
        assembleSpy.mockClear();
        assembleSpy.mockImplementationOnce(() => {
          throw new Error("assembler defect");
        });
        expect(() => htmlWeightReading(state)).toThrow("assembler defect");
        expect(htmlWeightReading(state)?.bytes).toBeGreaterThan(0);
      });
    });
  });
});
