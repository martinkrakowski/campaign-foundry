import { describe, test, expect } from "vitest";
import { ADVERTISING_UNITS } from "../advertising-units.js";
import { LAYER_KINDS, type LayerKind } from "../layer-kinds.js";
import {
  CREATIVE_TYPES,
  CREATIVE_TYPE_RULES,
  OCCLUSION_TABLE,
  checkPairOcclusion,
  checkRepositionOcclusion,
  findOcclusionDelta,
  formatOcclusionReason,
  type CreativeType,
} from "../creative-types.js";
import type { ComplianceResult } from "../ComplianceResult.vo.js";
import { isBriefTemplate, templateFromCanonical } from "../brief-template.js";

describe("creative types and compatibility rules (D119, D124, D131)", () => {
  test("the vocabulary is exactly the three creative types", () => {
    expect(CREATIVE_TYPES).toEqual(["image-text", "image-html", "video"]);
  });

  test("the union is compile-locked", () => {
    const types: readonly CreativeType[] = CREATIVE_TYPES;
    expect(types).toHaveLength(3);
  });

  test("every CREATIVE_TYPE_RULES key is a CREATIVE_TYPES member and vice versa", () => {
    expect(Object.keys(CREATIVE_TYPE_RULES).sort()).toEqual(
      [...CREATIVE_TYPES].sort(),
    );
  });

  test("every kind in every accepts and required list is a LAYER_KINDS member", () => {
    const validKinds = new Set<string>(LAYER_KINDS);
    for (const [type, rule] of Object.entries(CREATIVE_TYPE_RULES)) {
      for (const kind of rule.accepts) {
        expect(
          validKinds.has(kind),
          `creative type "${type}" accepts unknown layer kind "${kind}"`,
        ).toBe(true);
      }
      for (const kind of rule.required) {
        expect(
          validKinds.has(kind),
          `creative type "${type}" requires unknown layer kind "${kind}"`,
        ).toBe(true);
      }
    }
  });

  test("required is a subset of accepts for every type", () => {
    for (const [type, rule] of Object.entries(CREATIVE_TYPE_RULES)) {
      const acceptsSet = new Set(rule.accepts);
      for (const req of rule.required) {
        expect(
          acceptsSet.has(req),
          `creative type "${type}" marks "${req}" required but does not accept it`,
        ).toBe(true);
      }
    }
  });

  test("fill is accepted by no creative type (pins D131)", () => {
    for (const [type, rule] of Object.entries(CREATIVE_TYPE_RULES)) {
      expect(
        rule.accepts.includes("fill"),
        `creative type "${type}" must not accept "fill" until L11 (D131)`,
      ).toBe(false);
    }
  });

  test("every rule names a valid advertising unit and valid, non-empty, duplicate-free output families", () => {
    const validUnits = new Set<string>(ADVERTISING_UNITS);
    const validFamilies = new Set(["static", "motion", "html"]);
    for (const [type, rule] of Object.entries(CREATIVE_TYPE_RULES)) {
      expect(validUnits.has(rule.unit)).toBe(true);
      expect(
        rule.outputFamilies.length,
        `outputFamilies for ${type} must be non-empty`,
      ).toBeGreaterThan(0);
      expect(
        new Set(rule.outputFamilies).size,
        `outputFamilies for ${type} must not contain duplicates`,
      ).toBe(rule.outputFamilies.length);
      for (const family of rule.outputFamilies) {
        expect(
          validFamilies.has(family),
          `creative type "${type}" names unknown output family "${family}"`,
        ).toBe(true);
      }
    }
  });

  test("rules match the plan's §2.1 compatibility table exactly", () => {
    expect(CREATIVE_TYPE_RULES["image-text"]).toEqual({
      unit: "standard-web",
      accepts: [
        "image",
        "shade",
        "accent",
        "static-text",
        "animated-text",
        "logo",
      ],
      required: ["image", "static-text"],
      maxOf: { logo: 1, shade: 1, accent: 1 },
      sharedBudgets: [{ kinds: ["static-text", "animated-text"], max: 1 }],
      orderConstraints: [
        { kind: "logo", relation: "above", target: "image" },
        { kind: "shade", relation: "directly-above", target: "image" },
      ],
      outputFamilies: ["static", "motion"],
    });

    expect(CREATIVE_TYPE_RULES["image-html"]).toEqual({
      unit: "standard-web",
      accepts: ["image", "html", "logo"],
      required: ["image", "html"],
      maxOf: { logo: 1 },
      sharedBudgets: [],
      outputFamilies: ["html"],
    });

    expect(CREATIVE_TYPE_RULES["video"]).toEqual({
      unit: "standard-web",
      accepts: ["video", "shade", "animated-text", "logo"],
      required: ["video", "animated-text"],
      maxOf: { logo: 1, shade: 1 },
      sharedBudgets: [{ kinds: ["animated-text"], max: 1 }],
      outputFamilies: ["motion"],
    });
  });

  test("declared order constraints only name kinds accepted by their creative type", () => {
    for (const [type, rule] of Object.entries(CREATIVE_TYPE_RULES)) {
      if (!rule.orderConstraints) continue;
      const acceptsSet = new Set(rule.accepts);
      for (const constraint of rule.orderConstraints) {
        expect(
          acceptsSet.has(constraint.kind),
          `creative type "${type}" constraint names unaccepted kind "${constraint.kind}"`,
        ).toBe(true);
        expect(
          acceptsSet.has(constraint.target),
          `creative type "${type}" constraint names unaccepted target "${constraint.target}"`,
        ).toBe(true);
      }
    }
  });
});

describe("occlusion table and guard checks (D135, D136)", () => {
  test("every LAYER_KINDS member is declared in OCCLUSION_TABLE with explicit behavior", () => {
    const tableKeys = Object.keys(OCCLUSION_TABLE).sort();
    const allKinds = [...LAYER_KINDS].sort();
    expect(tableKeys).toEqual(allKinds);
  });

  test("OCCLUSION_TABLE matches D135 verbatim classification", () => {
    // image and fill are opaque — anything below them is hidden
    expect(OCCLUSION_TABLE.image).toEqual({
      behavior: "opaque",
      obscures: "all",
    });
    expect(OCCLUSION_TABLE.fill).toEqual({
      behavior: "opaque",
      obscures: "all",
    });

    // shade and accent are attenuating — text below them is muted, not lost
    expect(OCCLUSION_TABLE.shade).toEqual({
      behavior: "attenuating",
      obscures: ["static-text", "animated-text"],
    });
    expect(OCCLUSION_TABLE.accent).toEqual({
      behavior: "attenuating",
      obscures: ["static-text", "animated-text"],
    });

    // logo is local — it overlaps only where it sits
    expect(OCCLUSION_TABLE.logo).toEqual({
      behavior: "local",
      obscures: ["static-text", "animated-text"],
    });

    // unclassified by D135: static-text, animated-text, html, video have behavior "none"
    expect(OCCLUSION_TABLE["static-text"]).toEqual({ behavior: "none" });
    expect(OCCLUSION_TABLE["animated-text"]).toEqual({ behavior: "none" });
    expect(OCCLUSION_TABLE.html).toEqual({ behavior: "none" });
    expect(OCCLUSION_TABLE.video).toEqual({ behavior: "none" });
  });

  test("each behaviour class produces the finding it should for a pair that triggers it (D135, D136)", () => {
    // 1. opaque: image and fill obscure anything below them
    const imageOnText = checkPairOcclusion("image", "static-text");
    expect(imageOnText.passed).toBe(true);
    expect(imageOnText.reason).toBe(
      "the image layer now sits above the headline and will hide it",
    );

    const fillOnImage = checkPairOcclusion("fill", "image");
    expect(fillOnImage.passed).toBe(true);
    expect(fillOnImage.reason).toBe(
      "the fill layer now sits above the image and will hide it",
    );

    const imageOnAccent = checkPairOcclusion("image", "accent");
    expect(imageOnAccent.passed).toBe(true);
    expect(imageOnAccent.reason).toBe(
      "the image layer now sits above the accent and will hide it",
    );

    // 2. attenuating: shade and accent mute text below them
    const shadeOnText = checkPairOcclusion("shade", "static-text");
    expect(shadeOnText.passed).toBe(true);
    expect(shadeOnText.reason).toBe(
      "the shade layer now sits above the headline and will mute it",
    );

    const accentOnAnimText = checkPairOcclusion("accent", "animated-text");
    expect(accentOnAnimText.passed).toBe(true);
    expect(accentOnAnimText.reason).toBe(
      "the accent layer now sits above the headline and will mute it",
    );

    // 3. local: logo overlaps text where it sits
    const logoOnText = checkPairOcclusion("logo", "static-text");
    expect(logoOnText.passed).toBe(true);
    expect(logoOnText.reason).toBe(
      "the logo layer now sits above the headline and will overlap where it sits",
    );

    const logoOnAnimText = checkPairOcclusion("logo", "animated-text");
    expect(logoOnAnimText.passed).toBe(true);
    expect(logoOnAnimText.reason).toBe(
      "the logo layer now sits above the headline and will overlap where it sits",
    );

    // Stacked images: image is opaque and obscures all, so image above image warns (L8o-fix2)
    const imageOnImage = checkPairOcclusion("image", "image");
    expect(imageOnImage.passed).toBe(true);
    expect(imageOnImage.reason).toBe(
      "the image layer now sits above the image and will hide it",
    );
  });

  test("each behaviour class produces NO finding for a pair that does not trigger it (D135, D136)", () => {
    // Opaque layer below another layer produces no finding
    expect(checkPairOcclusion("static-text", "image")).toEqual({
      passed: true,
    });

    // Attenuating layer above non-text (e.g. shade directly above image) produces no finding
    expect(checkPairOcclusion("shade", "image")).toEqual({ passed: true });
    expect(checkPairOcclusion("accent", "image")).toEqual({ passed: true });

    // Local layer above non-text (e.g. logo above image or shade) produces no finding
    expect(checkPairOcclusion("logo", "image")).toEqual({ passed: true });
    expect(checkPairOcclusion("logo", "shade")).toEqual({ passed: true });

    // Behavior "none" produces no finding
    expect(checkPairOcclusion("static-text", "shade")).toEqual({
      passed: true,
    });
    expect(checkPairOcclusion("animated-text", "video")).toEqual({
      passed: true,
    });
    expect(checkPairOcclusion("video", "shade")).toEqual({ passed: true });
    expect(checkPairOcclusion("html", "image")).toEqual({ passed: true });

    // Same layer kind compared to itself produces no finding when behavior is "none" or doesn't obscure
    expect(checkPairOcclusion("shade", "shade")).toEqual({ passed: true });
    expect(checkPairOcclusion("static-text", "static-text")).toEqual({
      passed: true,
    });
  });

  test("the message names both layers in each finding (D135)", () => {
    const findings = [
      checkPairOcclusion("shade", "static-text"),
      checkPairOcclusion("accent", "animated-text"),
      checkPairOcclusion("image", "accent"),
      checkPairOcclusion("fill", "image"),
      checkPairOcclusion("logo", "static-text"),
    ];
    for (const finding of findings) {
      expect(finding.reason).toBeDefined();
      expect(finding.reason).toMatch(
        /^the \S+ layer now sits above .+ and will (hide it|mute it|overlap where it sits)$/,
      );
    }
    // Verbatim from D135: "the shade layer now sits above the headline and will mute it"
    expect(checkPairOcclusion("shade", "static-text").reason).toBe(
      "the shade layer now sits above the headline and will mute it",
    );
  });

  test("formatOcclusionReason formats subject and target layers accurately", () => {
    expect(formatOcclusionReason("html", "image", "opaque")).toBe(
      "the HTML layer now sits above the image and will hide it",
    );
    expect(formatOcclusionReason("shade", "html", "opaque")).toBe(
      "the shade layer now sits above the HTML and will hide it",
    );
    expect(formatOcclusionReason("static-text", "video", "opaque")).toBe(
      "the headline layer now sits above the video and will hide it",
    );
  });

  test("checkRepositionOcclusion evaluates per layer on reposition", () => {
    // Canonical video layers: video (0), shade (1), animated-text (2), logo (3)
    const videoCanonical = templateFromCanonical("short-video").layers;

    // Moving shade (1) up to (2) puts shade above animated-text
    const reordered = [
      videoCanonical[0]!,
      videoCanonical[2]!, // animated-text at 1
      videoCanonical[1]!, // shade at 2
      videoCanonical[3]!,
    ];
    const finding = checkRepositionOcclusion(reordered, 2, 1);
    expect(finding.passed).toBe(true);
    expect(finding.reason).toBe(
      "the shade layer now sits above the headline and will mute it",
    );

    // Moving shade back down from (2) to (1) restores order and clears finding
    const cleared = checkRepositionOcclusion(videoCanonical, 1, 2);
    expect(cleared).toEqual({ passed: true });

    // Moving animated-text down to 1 puts it under shade at 2
    const movedDownFinding = checkRepositionOcclusion(reordered, 1, 2);
    expect(movedDownFinding.passed).toBe(true);
    expect(movedDownFinding.reason).toBe(
      "the shade layer now sits above the headline and will mute it",
    );

    // In a stack without logo, moving animated-text back up to 2 clears finding
    const threeLayers = [
      videoCanonical[0]!,
      videoCanonical[1]!,
      videoCanonical[2]!,
    ];
    const movedUpCleared = checkRepositionOcclusion(threeLayers, 2, 1);
    expect(movedUpCleared).toEqual({ passed: true });

    // D135 worked example: a static-text moved to sit beneath a shade that was not already above it
    // before: [bg, shade, text] — shade(1) is below text(2)
    // move text 2 -> 1 puts it beneath shade at 2
    const headlineUnderShade = [
      { id: "bg", kind: "video" as LayerKind },
      { id: "text", kind: "static-text" as LayerKind },
      { id: "shade", kind: "shade" as LayerKind },
    ];
    const textMovedUnderShade = checkRepositionOcclusion(
      headlineUnderShade,
      1,
      2,
    );
    expect(textMovedUnderShade.passed).toBe(true);
    expect(textMovedUnderShade.reason).toBe(
      "the shade layer now sits above the headline and will mute it",
    );
    // The message names both layers in the pair (D135)
    expect(textMovedUnderShade.reason).toContain("shade");
    expect(textMovedUnderShade.reason).toContain("headline");

    // When shade was already above static-text before the move, moving static-text up (0 -> 1)
    // produces NO finding because the move did not create the occlusion (L8o-fix3, D135).
    const textMovedUpPreExisting = checkRepositionOcclusion(
      headlineUnderShade,
      1,
      0,
    );
    expect(textMovedUpPreExisting).toEqual({ passed: true });

    // In videoCanonical, moving animated-text from 1 to 2 places it beneath logo at 3;
    // but logo was already above animated-text before the move, so it produces NO finding (L8o-fix3, D135).
    const movedUpUnderLogo = checkRepositionOcclusion(videoCanonical, 2, 1);
    expect(movedUpUnderLogo).toEqual({ passed: true });

    // Regression case: pre-existing shade over a moved-up text produces NO finding (L8o-fix3, D135)
    const L = (kind: LayerKind) => ({ id: kind, kind });
    // before: [image, static-text, animated-text, shade]   — shade(3) is already above static-text(1)
    // move static-text 1 -> 2
    const after = [
      L("image"),
      L("animated-text"),
      L("static-text"),
      L("shade"),
    ];
    expect(checkRepositionOcclusion(after, 2, 1).reason).toBeUndefined();
    expect(checkRepositionOcclusion(after, 2, 1)).toEqual({ passed: true });

    // Two stacked images still warn, in both move directions (L8o-fix3)
    const stackedImages = [
      { id: "img1", kind: "image" as LayerKind },
      { id: "img2", kind: "image" as LayerKind },
    ];
    // Move img2 from 0 up to 1: img2 now sits above img1
    const imgMovedUp = checkRepositionOcclusion(stackedImages, 1, 0);
    expect(imgMovedUp.passed).toBe(true);
    expect(imgMovedUp.reason).toBe(
      "the image layer now sits above the image and will hide it",
    );
    // Move img1 from 1 down to 0: img2 now sits above img1
    const imgMovedDown = checkRepositionOcclusion(stackedImages, 0, 1);
    expect(imgMovedDown.passed).toBe(true);
    expect(imgMovedDown.reason).toBe(
      "the image layer now sits above the image and will hide it",
    );

    // Out of range or empty layers returns { passed: true }
    expect(checkRepositionOcclusion([], 0)).toEqual({ passed: true });
    expect(checkRepositionOcclusion(videoCanonical, -1)).toEqual({
      passed: true,
    });
    expect(checkRepositionOcclusion(videoCanonical, 10)).toEqual({
      passed: true,
    });
    expect(checkRepositionOcclusion(videoCanonical, 1, -1)).toEqual({
      passed: true,
    });
    expect(checkRepositionOcclusion(videoCanonical, 1, 10)).toEqual({
      passed: true,
    });

    // Moving shade from 2 down to 1: shade was already above static-text at 0 before the move (2 > 0),
    // so moving it closer (1 > 0) does not create the occlusion (L8o-fix3, D135).
    const downOccludesBelow = [
      { id: "text", kind: "static-text" as LayerKind },
      { id: "shade", kind: "shade" as LayerKind },
      { id: "video", kind: "video" as LayerKind },
    ];
    const movedDownPreExisting = checkRepositionOcclusion(
      downOccludesBelow,
      1,
      2,
    );
    expect(movedDownPreExisting).toEqual({ passed: true });

    // Calling without from parameter checks both directions
    expect(checkRepositionOcclusion(reordered, 2).reason).toBe(
      "the shade layer now sits above the headline and will mute it",
    );
    expect(checkRepositionOcclusion(videoCanonical, 1)).toEqual({
      passed: true,
    });

    // Calling without from parameter where a layer above occludes subject (and subject occludes nothing below)
    const aboveOccludesSubject = [
      { id: "text", kind: "static-text" as LayerKind },
      { id: "shade", kind: "shade" as LayerKind },
    ];
    // Subject at 0 is static-text (occludes nothing below); shade at 1 occludes static-text
    const noFromAboveOccludes = checkRepositionOcclusion(
      aboveOccludesSubject,
      0,
    );
    expect(noFromAboveOccludes.passed).toBe(true);
    expect(noFromAboveOccludes.reason).toBe(
      "the shade layer now sits above the headline and will mute it",
    );
    // Qodo's case: in canonical video with shade removed, moving animated-text down past video
    // leaves logo above animated-text both before and after; the scan must not report that
    // pre-existing relationship as a new occlusion (L8o-fix2, D135).
    // Layers before move: video (0), animated-text (1), logo (2)
    // Layers after move: animated-text (0), video (1), logo (2) [to = 0, from = 1]
    const videoWithoutShade = [
      videoCanonical[0]!, // video
      videoCanonical[2]!, // animated-text
      videoCanonical[3]!, // logo
    ];
    const animatedTextMovedDownPastVideo = [
      videoWithoutShade[1]!, // animated-text at 0
      videoWithoutShade[0]!, // video at 1
      videoWithoutShade[2]!, // logo at 2
    ];
    const qodoFinding = checkRepositionOcclusion(
      animatedTextMovedDownPastVideo,
      0,
      1,
    );
    expect(qodoFinding).toEqual({ passed: true });
  });

  test("an occluding order is still a valid template (D135, D136) — warns and never refuses", () => {
    // In video, shade sitting above animated-text occludes, but is a VALID template:
    // video creative type has NO order constraints on shade!
    const canonicalVideo = templateFromCanonical("short-video");
    const occludingVideoTemplate = {
      ...canonicalVideo,
      layers: [
        canonicalVideo.layers[0]!, // video (0)
        canonicalVideo.layers[2]!, // animated-text (1)
        canonicalVideo.layers[1]!, // shade (2) — occludes animated-text!
        canonicalVideo.layers[3]!, // logo (3)
      ],
    };

    // 1. checkPairOcclusion detects occlusion but passes (advisory, never refuses)
    const finding = checkPairOcclusion("shade", "animated-text");
    expect(finding.passed).toBe(true);
    expect(finding.reason).toBeDefined();

    // 2. isBriefTemplate accepts it (warn, never refuse)
    expect(isBriefTemplate(occludingVideoTemplate)).toBe(true);

    // 3. Similarly, swapping accent (2) and static-text (3) in image-text satisfies constraints
    const canonicalSocial = templateFromCanonical("social-post");
    const occludingSocialTemplate = {
      ...canonicalSocial,
      layers: [
        canonicalSocial.layers[0]!, // image (0)
        canonicalSocial.layers[1]!, // shade (1) — directly above image (satisfied)
        canonicalSocial.layers[3]!, // static-text (2)
        canonicalSocial.layers[2]!, // accent (3) — occludes static-text!
        canonicalSocial.layers[4]!, // logo (4) — above image (satisfied)
      ],
    };
    expect(isBriefTemplate(occludingSocialTemplate)).toBe(true);
  });

  test("an advisory finding is distinguished from a failure and clean pass without guessing (D136, T2a)", () => {
    // Producer returns explicit advisory representation
    const advisory = checkPairOcclusion("shade", "static-text");
    expect(advisory.passed).toBe(true);
    expect(advisory.severity).toBe("advisory");
    expect(advisory.reason).toBe(
      "the shade layer now sits above the headline and will mute it",
    );

    const repositionAdvisory = checkRepositionOcclusion(
      [
        { kind: "video" },
        { kind: "animated-text" },
        { kind: "shade" },
        { kind: "logo" },
      ],
      2,
      1,
    );
    expect(repositionAdvisory.passed).toBe(true);
    expect(repositionAdvisory.severity).toBe("advisory");
    expect(repositionAdvisory.reason).toBeDefined();

    // Consumer discrimination: tell the three states apart without guessing
    type Verdict = "pass" | "advisory" | "fail";
    const classify = (r: ComplianceResult): Verdict => {
      if (!r.passed) return "fail";
      if (r.severity === "advisory") return "advisory";
      return "pass";
    };

    const failure: ComplianceResult = {
      passed: false,
      reason: "Prohibited terminology detected: miracle",
    };
    const cleanPass: ComplianceResult = { passed: true };

    expect(classify(advisory)).toBe("advisory");
    expect(classify(repositionAdvisory)).toBe("advisory");
    expect(classify(failure)).toBe("fail");
    expect(classify(cleanPass)).toBe("pass");
  });

  describe("findOcclusionDelta (D135, D136, L8o-fix5)", () => {
    test("detects newly created occluding pairs and ignores pre-existing ones", () => {
      // 1. Move creates occlusion: shade moved above animated-text
      const beforeMove = [
        { id: "video", kind: "video" as LayerKind },
        { id: "shade", kind: "shade" as LayerKind },
        { id: "animated-text", kind: "animated-text" as LayerKind },
      ];
      const afterMove = [
        { id: "video", kind: "video" as LayerKind },
        { id: "animated-text", kind: "animated-text" as LayerKind },
        { id: "shade", kind: "shade" as LayerKind },
      ];
      expect(findOcclusionDelta(beforeMove, afterMove)).toEqual({
        above: "shade",
        below: "animated-text",
        behavior: "attenuating",
      });

      // 2. Pre-existing occlusion is ignored when unrelated layer is added
      const afterAddUnrelated = [
        { id: "video", kind: "video" as LayerKind },
        { id: "animated-text", kind: "animated-text" as LayerKind },
        { id: "shade", kind: "shade" as LayerKind },
        { id: "video-2", kind: "video" as LayerKind },
      ];
      expect(findOcclusionDelta(afterMove, afterAddUnrelated)).toBeNull();

      // 3. Removing a layer produces no newly created occlusion
      const afterRemove = [
        { id: "video", kind: "video" as LayerKind },
        { id: "shade", kind: "shade" as LayerKind },
      ];
      expect(findOcclusionDelta(beforeMove, afterRemove)).toBeNull();

      // 4. Adding a layer that creates an occlusion
      const afterAddOccluding = [
        { id: "video", kind: "video" as LayerKind },
        { id: "animated-text", kind: "animated-text" as LayerKind },
        { id: "shade", kind: "shade" as LayerKind },
      ];
      const beforeAdd = [
        { id: "video", kind: "video" as LayerKind },
        { id: "animated-text", kind: "animated-text" as LayerKind },
      ];
      expect(findOcclusionDelta(beforeAdd, afterAddOccluding)).toEqual({
        above: "shade",
        below: "animated-text",
        behavior: "attenuating",
      });

      // 5. Identical stacks produce no delta
      expect(findOcclusionDelta(beforeMove, beforeMove)).toBeNull();

      // 6. Supports layers without explicit ids, preserving reference identity
      const vLayer = { kind: "video" as LayerKind };
      const tLayer = { kind: "animated-text" as LayerKind };
      const sLayer = { kind: "shade" as LayerKind };
      const beforeRef = [vLayer, sLayer, tLayer];
      const afterRef = [vLayer, tLayer, sLayer];
      expect(findOcclusionDelta(beforeRef, afterRef)).toEqual({
        above: "shade",
        below: "animated-text",
        behavior: "attenuating",
      });

      // 7. Non-occluding addition without ids
      const newVLayer = { kind: "video" as LayerKind };
      expect(findOcclusionDelta([vLayer], [vLayer, newVLayer])).toBeNull();
    });
  });
});
