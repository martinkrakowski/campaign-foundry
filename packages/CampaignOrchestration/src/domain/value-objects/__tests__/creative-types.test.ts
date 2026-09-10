import { describe, test, expect } from "vitest";
import { ADVERTISING_UNITS } from "../advertising-units.js";
import { LAYER_KINDS, type LayerKind } from "../layer-kinds.js";
import {
  CREATIVE_TYPES,
  CREATIVE_TYPE_RULES,
  OCCLUSION_TABLE,
  checkPairOcclusion,
  checkRepositionOcclusion,
  checkTemplateOcclusion,
  formatOcclusionReason,
  type CreativeType,
} from "../creative-types.js";
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
      outputFamilies: ["html"],
    });

    expect(CREATIVE_TYPE_RULES["video"]).toEqual({
      unit: "standard-web",
      accepts: ["video", "shade", "animated-text", "logo"],
      required: ["video"],
      maxOf: { logo: 1, shade: 1 },
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

    // Same layer kind compared to itself produces no finding
    expect(checkPairOcclusion("shade", "shade")).toEqual({ passed: true });
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

    // D135 worked example: moving a static-text headline up so it lands beneath a shade
    const headlineUnderShade = [
      { id: "bg", kind: "video" as LayerKind },
      { id: "text", kind: "static-text" as LayerKind },
      { id: "shade", kind: "shade" as LayerKind },
    ];
    // Moving static-text up from 0 to 1 places it directly beneath shade at 2
    const textMovedUp = checkRepositionOcclusion(headlineUnderShade, 1, 0);
    expect(textMovedUp.passed).toBe(true);
    expect(textMovedUp.reason).toBe(
      "the shade layer now sits above the headline and will mute it",
    );
    // The message names both layers in the pair (D135)
    expect(textMovedUp.reason).toContain("shade");
    expect(textMovedUp.reason).toContain("headline");

    // In videoCanonical, moving animated-text from 1 to 2 places it beneath logo at 3
    const movedUpUnderLogo = checkRepositionOcclusion(videoCanonical, 2, 1);
    expect(movedUpUnderLogo.passed).toBe(true);
    expect(movedUpUnderLogo.reason).toBe(
      "the logo layer now sits above the headline and will overlap where it sits",
    );

    // Out of range or empty layers returns { passed: true }
    expect(checkRepositionOcclusion([], 0)).toEqual({ passed: true });
    expect(checkRepositionOcclusion(videoCanonical, -1)).toEqual({
      passed: true,
    });
    expect(checkRepositionOcclusion(videoCanonical, 10)).toEqual({
      passed: true,
    });

    // Moving a layer down where it occludes a layer below it (and is not occluded by layers above)
    const downOccludesBelow = [
      { id: "text", kind: "static-text" as LayerKind },
      { id: "shade", kind: "shade" as LayerKind },
      { id: "video", kind: "video" as LayerKind },
    ];
    // Moving shade from 2 down to 1: video at 2 does not occlude shade, but shade at 1 occludes static-text at 0
    const movedDownOccludingBelow = checkRepositionOcclusion(
      downOccludesBelow,
      1,
      2,
    );
    expect(movedDownOccludingBelow.passed).toBe(true);
    expect(movedDownOccludingBelow.reason).toBe(
      "the shade layer now sits above the headline and will mute it",
    );

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
  });

  test("checkTemplateOcclusion scans entire template for occluding pairs", () => {
    const occluding = [
      { id: "video", kind: "video" as LayerKind },
      { id: "animated-text", kind: "animated-text" as LayerKind },
      { id: "shade", kind: "shade" as LayerKind },
    ];
    expect(checkTemplateOcclusion(occluding)).toEqual({
      passed: true,
      reason: "the shade layer now sits above the headline and will mute it",
    });

    const nonOccluding = [
      { id: "video", kind: "video" as LayerKind },
      { id: "shade", kind: "shade" as LayerKind },
      { id: "animated-text", kind: "animated-text" as LayerKind },
    ];
    expect(checkTemplateOcclusion(nonOccluding)).toEqual({ passed: true });
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
});
