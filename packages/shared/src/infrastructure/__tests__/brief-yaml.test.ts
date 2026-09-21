import { describe, test, expect } from "vitest";
import { parse } from "yaml";
import { BRIEF_KEY_ORDER, dumpBrief } from "../brief-yaml.js";

// Moved from `apps/web/src/components/campaign/__tests__/dump-brief.test.ts` (R4.3):
// the web fork of the serialiser was deleted, so its unit tests follow the one
// shared implementation. Two assertions were corrected, because they described the
// deleted fork's over-quoting contract rather than the real one: the fork quoted
// `campaignMessage` ("Stay wild. Stay hydrated.") with `quoteYamlScalar`, while the
// canonical writer — the `yaml` package's emitter at the 1.2 default schema — emits
// it plain, exactly as the API's canonical dump always did. `#1473E6` stays quoted
// (a plain scalar may not start with `#`). The deleted `quoteYamlScalar` tests have
// no surviving subject; quoting is now covered by the byte-for-byte round-trip
// corpus tests in `apps/api/server/lib/__tests__/brief-corpus.test.ts`.

const brief = {
  id: "camp",
  targetRegion: "DE",
  targetAudience: "fans",
  campaignMessage: "Stay wild. Stay hydrated.",
  localizedMessage: "Bleib wild",
  products: [
    {
      id: "alpha",
      name: "Alpha",
      primaryColor: "#1473E6",
      logoPath: "assets/inputs/a.png",
      inputAsset: "assets/inputs/bg.png",
    },
  ],
  mode: "variation",
  type: "short-video",
  variation: {
    count: 12,
    seed: 42,
    minDistance: 2,
    coverage: { perProduct: 1, perRatio: 1 },
    axes: {
      layout: ["headline-top", "headline-bottom"],
      tone: ["bold", "subtle"],
      background: { source: ["procedural"] },
      paletteShift: [0, 0.1, 0.2],
    },
  },
  output: { formats: ["static"], platforms: ["instagram-feed", "linkedin", "x"] },
};

describe("dumpBrief", () => {
  test("emits schemaVersion as the first key in canonical order (D133)", () => {
    const yaml = dumpBrief({ schemaVersion: 1, ...brief });
    expect(yaml.startsWith("schemaVersion: 1\n")).toBe(true);
    expect(yaml.indexOf("schemaVersion:")).toBeLessThan(yaml.indexOf("id:"));
  });

  test("emits template after schemaVersion and before id (D120, D123)", () => {
    const yaml = dumpBrief({
      schemaVersion: 1,
      template: {
        id: "canonical-image-text",
        version: 1,
        creativeType: "image-text",
        unit: "standard-web",
        layers: [{ id: "img", kind: "image" }],
      },
      ...brief,
    });
    expect(yaml.indexOf("schemaVersion:")).toBeLessThan(yaml.indexOf("template:"));
    expect(yaml.indexOf("template:")).toBeLessThan(yaml.indexOf("id:"));
  });

  test("emits canonical key order and quotes unsafe strings", () => {
    const yaml = dumpBrief(brief);
    expect(yaml.indexOf("id:")).toBeLessThan(yaml.indexOf("targetRegion:"));
    expect(yaml.indexOf("products:")).toBeLessThan(yaml.indexOf("mode:"));
    expect(yaml.indexOf("mode:")).toBeLessThan(yaml.indexOf("variation:"));
    // The campaign type (D108–D112) sits in canonical position between its
    // neighbours — the key still serialises if dropped from BRIEF_KEY_ORDER
    // (at the end, in remaining-keys order), so only a positional assertion
    // catches that mutation.
    expect(yaml.indexOf("mode:")).toBeLessThan(yaml.indexOf("type:"));
    expect(yaml.indexOf("type:")).toBeLessThan(yaml.indexOf("variation:"));
    expect(yaml).toContain("id: camp");
    expect(yaml).toContain("type: short-video");
    expect(yaml).toContain("campaignMessage: Stay wild. Stay hydrated.");
    expect(yaml).toContain('primaryColor: "#1473E6"');
    expect(yaml).toContain("- headline-top");
    expect(yaml).toContain("- static");
    expect(yaml).toContain("paletteShift:");
    expect(yaml).toContain("- 0.1");
  });

  test("emits clickDestination in canonical order after output (HL2)", () => {
    expect(BRIEF_KEY_ORDER).toContain("clickDestination");
    expect(BRIEF_KEY_ORDER.indexOf("output")).toBeLessThan(
      BRIEF_KEY_ORDER.indexOf("clickDestination"),
    );
    const yaml = dumpBrief({
      ...brief,
      extra: "custom",
      clickDestination: "https://example.com/landing",
    });
    expect(yaml.indexOf("output:")).toBeLessThan(yaml.indexOf("clickDestination:"));
    expect(yaml.indexOf("clickDestination:")).toBeLessThan(yaml.indexOf("extra:"));
    expect(yaml).toContain("clickDestination: https://example.com/landing");
    expect(dumpBrief(parse(yaml) as object)).toBe(yaml);
  });

  test("skips undefined, dumps leftover keys, and handles empty / null / boolean values", () => {
    const yaml = dumpBrief({
      ...brief,
      localizedMessage: undefined,
      flag: true,
      empty: [],
      box: {},
      nada: null,
      nested: [1, [true], {}],
      ones: [{ id: "solo" }],
      partial: { keep: 1, drop: undefined },
      leftover: "z",
      skip: undefined,
      n: 1n,
    } as object);
    expect(yaml).not.toContain("localizedMessage:");
    expect(yaml).not.toContain("skip:");
    expect(yaml).toContain("flag: true");
    expect(yaml).toContain("empty: []");
    expect(yaml).toContain("box: {}");
    expect(yaml).toContain("nada: null");
    expect(yaml).toContain("leftover: z");
    expect(yaml).toContain("n: 1");
    expect(yaml).toContain("- 1");
    expect(yaml).toContain("- true");
    expect(yaml).toContain("- id: solo");
    expect(yaml).toContain("keep: 1");
    expect(yaml).not.toContain("drop:");
  });

  test("round-trips through the loader's schema — what is dumped parses back identical", () => {
    // One schema for load and dump (R4.3): the `yaml` package default, YAML 1.2.
    // A writer and a parser on different schemas is the real hazard, so the writer
    // is pinned to the same default the loader parses with.
    const dumped = dumpBrief(brief);
    expect(parse(dumped)).toEqual(brief);
  });

  test("a brief without type emits no type: line (D112 — existing briefs dump byte-for-byte as before)", () => {
    const withoutType: Record<string, unknown> = { ...brief };
    delete withoutType.type;
    const yaml = dumpBrief(withoutType);
    expect(yaml).not.toContain("type:");
    expect(yaml.indexOf("mode:")).toBeLessThan(yaml.indexOf("variation:"));
  });

  test("round-trips output.sizes (D113 — nested under output, already in key order)", () => {
    const withSizes = { ...brief, output: { ...brief.output, sizes: ["728x90"] } };
    const dumped = dumpBrief(withSizes);
    expect(parse(dumped)).toEqual(withSizes);
    expect(dumped).toContain("sizes:");
    expect(dumped).toContain("728x90");
  });

  test("a brief without output.sizes emits no sizes: line", () => {
    const yaml = dumpBrief(brief);
    expect(yaml).not.toMatch(/^\s*sizes:/m);
    expect(parse(yaml).output.sizes).toBeUndefined();
  });
});

describe("dumpBrief layer and props order (L3b, D134)", () => {
  // Layers written with their keys scrambled — and props written in reverse
  // union order — so the assertions below can only pass if the writer orders
  // them, not if the fixture happens to be ordered already.
  const templated = {
    ...brief,
    template: {
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [
        { kind: "image", id: "bg" },
        // `shade` carries no props since R-D4 (withdrawn 2026-09-15).
        { kind: "shade", id: "tint" },
        { kind: "accent", id: "band", props: { fadeHeight: 0.06, solidHeight: 0.05 } },
        { kind: "static-text", id: "head", props: { typeFloor: 0.4, anchor: "top" } },
        { kind: "logo", id: "mark", props: { margin: 0.04, width: 0 } },
      ],
    },
  };

  test("emits a layer's keys as id, kind, props", () => {
    const yaml = dumpBrief(templated);
    expect(yaml.indexOf("id: bg")).toBeLessThan(yaml.indexOf("kind: image"));
    expect(yaml.indexOf("id: tint")).toBeLessThan(yaml.indexOf("kind: shade"));
    expect(yaml.indexOf("id: band")).toBeLessThan(yaml.indexOf("kind: accent"));
    expect(yaml.indexOf("kind: accent")).toBeLessThan(yaml.indexOf("props:"));
    expect(yaml.indexOf("props:")).toBeLessThan(yaml.indexOf("solidHeight: 0.05"));
  });

  test("emits props keys in the order the LayerProps union declares them", () => {
    const yaml = dumpBrief(templated);
    expect(yaml.indexOf("solidHeight:")).toBeLessThan(yaml.indexOf("fadeHeight:"));
    expect(yaml.indexOf("anchor:")).toBeLessThan(yaml.indexOf("typeFloor:"));
    expect(yaml.indexOf("width:")).toBeLessThan(yaml.indexOf("margin:"));
  });

  test("a shade layer carries no props (R-D4) and round-trips through YAML verbatim", () => {
    const yaml = dumpBrief(templated);
    const parsed = parse(yaml) as typeof templated;
    expect(parsed.template.layers[1]).toEqual({ kind: "shade", id: "tint" });
  });

  test("a fill layer's role round-trips through YAML (L11, D131)", () => {
    // A brand role is a string in a vocabulary, not a number in [0, 1] like
    // the geometry props around it — it has to survive the writer's ordering
    // pass and the reader unchanged, or a template loses its band's colour.
    const withFill = {
      ...templated,
      template: {
        ...templated.template,
        layers: [
          ...templated.template.layers,
          { kind: "fill", id: "band-fill", props: { role: "primary" } },
        ],
      },
    };
    const yaml = dumpBrief(withFill);
    const parsed = parse(yaml) as typeof withFill;
    expect(parsed.template.layers[5]).toEqual({
      id: "band-fill",
      kind: "fill",
      props: { role: "primary" },
    });
  });

  test("a layer key named after an Object.prototype member survives the dump", () => {
    // `constructor` is also an inherited member of the writer's accumulator;
    // an own layer key of that name must still be emitted (L3b review).
    const withPrototypeKey = {
      ...brief,
      template: {
        id: "canonical-image-text",
        version: 1,
        creativeType: "image-text",
        unit: "standard-web",
        layers: [{ id: "bg", kind: "image", constructor: "x" }],
      },
    };
    const yaml = dumpBrief(withPrototypeKey);
    expect(yaml).toContain("constructor: x");
    expect(parse(yaml)).toEqual(withPrototypeKey);
  });

  test("a template whose layers carry no props dumps and reparses exactly as today", () => {
    const propless = {
      ...brief,
      template: {
        id: "canonical-video",
        version: 1,
        creativeType: "video",
        unit: "standard-web",
        layers: [
          { id: "video", kind: "video" },
          { id: "shade", kind: "shade" },
          { id: "animated-text", kind: "animated-text" },
          { id: "logo", kind: "logo" },
        ],
      },
    };
    const yaml = dumpBrief(propless);
    expect(parse(yaml)).toEqual(propless);
    // Byte-stable: what parse reads back dumps again unchanged.
    expect(dumpBrief(parse(yaml) as object)).toBe(yaml);
  });

  test("entries the order cannot name pass through untouched", () => {
    // A template that is not an object with a layers array, a layer that is
    // not an object, and a props that is not an object are all emitted as
    // written — the writer reorders keys, it never validates them.
    const yaml = dumpBrief({
      ...brief,
      template: { id: "x", layers: ["junk", { id: "tint", kind: "shade", props: null }] },
    });
    expect(yaml).toContain("template:");
    expect(yaml).toContain("- junk");
    expect(yaml).toContain("props: null");
    expect(parse(yaml)).toEqual({
      ...brief,
      template: { id: "x", layers: ["junk", { id: "tint", kind: "shade", props: null }] },
    });
  });

  test("a disabled layer survives a YAML round trip in its declared key position (id, kind, enabled, props)", () => {
    const withDisabledLayer = {
      ...brief,
      template: {
        id: "canonical-image-text",
        version: 1,
        creativeType: "image-text",
        unit: "standard-web",
        layers: [
          { kind: "image", id: "bg" },
          // Keys deliberately scrambled to prove the writer orders them
          { props: { width: 0.16 }, enabled: false, kind: "logo", id: "tint" },
          { id: "band", kind: "accent", enabled: true },
        ],
      },
    };
    const yaml = dumpBrief(withDisabledLayer);
    // Declared key position: id, kind, enabled, props
    expect(yaml.indexOf("id: tint")).toBeLessThan(yaml.indexOf("kind: logo"));
    expect(yaml.indexOf("kind: logo")).toBeLessThan(yaml.indexOf("enabled: false"));
    expect(yaml.indexOf("enabled: false")).toBeLessThan(yaml.indexOf("props:"));
    expect(yaml.indexOf("props:")).toBeLessThan(yaml.indexOf("width: 0.16"));

    // Round-trip determinism and byte-identity
    const parsed = parse(yaml) as typeof withDisabledLayer;
    expect(parsed.template.layers[1]).toEqual({
      id: "tint",
      kind: "logo",
      enabled: false,
      props: { width: 0.16 },
    });
    expect(parsed.template.layers[2]).toEqual({
      id: "band",
      kind: "accent",
      enabled: true,
    });
    expect(dumpBrief(parsed)).toBe(yaml);
  });

  test("a layer with no enabled behaves exactly as today — an existing brief round-trips byte-identically", () => {
    // templated has no enabled field on any layer; dumping and reparsing produces byte-identical YAML
    const yaml = dumpBrief(templated);
    expect(yaml).not.toContain("enabled:");
    const reparsed = parse(yaml) as typeof templated;
    expect(dumpBrief(reparsed)).toBe(yaml);
  });
});

describe("dumpBrief element order (HL1)", () => {
  // A layer and its elements written with keys scrambled, so the assertions
  // below can only pass if the writer orders them.
  const templated = {
    ...brief,
    template: {
      id: "canonical-image-html",
      version: 1,
      creativeType: "image-html",
      unit: "standard-web",
      layers: [
        { kind: "image", id: "bg" },
        {
          elements: [
            {
              text: "Buy",
              kind: "text",
              frame: { anchor: "top", h: 0.44, w: 0.33, y: 0.22, x: 0.11 },
            },
            {
              kind: "image",
              frame: { anchor: "middle", h: 0.2, w: 0.2, y: 0.4, x: 0.4 },
            },
          ],
          props: { alpha: 0.5 },
          enabled: false,
          kind: "html",
          id: "html",
        },
        { kind: "logo", id: "mark" },
      ],
    },
  };

  test("emits a layer's keys as id, kind, enabled, props, elements", () => {
    const yaml = dumpBrief(templated);
    expect(yaml.indexOf("id: html")).toBeLessThan(yaml.indexOf("kind: html"));
    expect(yaml.indexOf("kind: html")).toBeLessThan(yaml.indexOf("enabled: false"));
    expect(yaml.indexOf("enabled: false")).toBeLessThan(yaml.indexOf("props:"));
    expect(yaml.indexOf("props:")).toBeLessThan(yaml.indexOf("elements:"));
  });

  test("emits each element's keys as kind, text, frame, and the frame's as x, y, w, h, anchor", () => {
    const yaml = dumpBrief(templated);
    expect(yaml.indexOf("kind: text")).toBeLessThan(yaml.indexOf("text: Buy"));
    expect(yaml.indexOf("text: Buy")).toBeLessThan(yaml.indexOf("frame:"));
    expect(yaml.indexOf("x: 0.11")).toBeLessThan(yaml.indexOf("y: 0.22"));
    expect(yaml.indexOf("y: 0.22")).toBeLessThan(yaml.indexOf("w: 0.33"));
    expect(yaml.indexOf("w: 0.33")).toBeLessThan(yaml.indexOf("h: 0.44"));
    expect(yaml.indexOf("h: 0.44")).toBeLessThan(yaml.indexOf("anchor: top"));
    // The second element's own frame follows, untouched.
    expect(yaml.indexOf("anchor: top")).toBeLessThan(yaml.indexOf("anchor: middle"));
  });

  test("an html layer's elements round-trip through YAML and dump byte-identically", () => {
    const yaml = dumpBrief(templated);
    expect(parse(yaml)).toEqual(templated);
    expect(dumpBrief(parse(yaml) as object)).toBe(yaml);
  });

  test("elements the order cannot name pass through untouched", () => {
    const passthrough = {
      ...brief,
      template: {
        id: "x",
        layers: [
          { id: "html", kind: "html", elements: "junk" },
          { id: "html-2", kind: "html", elements: ["junk", { frame: null }] },
        ],
      },
    };
    const yaml = dumpBrief(passthrough);
    expect(yaml).toContain("elements: junk");
    expect(yaml).toContain("frame: null");
    expect(parse(yaml)).toEqual(passthrough);
  });
});

describe("dumpBrief layer tracks order (K1)", () => {
  // A layer and its tracks/stops written with keys scrambled, so the
  // assertions below can only pass if the writer orders them.
  const templated = {
    ...brief,
    template: {
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [
        { kind: "image", id: "bg" },
        {
          tracks: [
            {
              stops: [
                { clock: "pose", easing: "linear", value: 1, t: 0 },
                { clock: "pose", value: 0.5, t: 1 },
              ],
              property: "scale",
            },
          ],
          kind: "image",
          id: "hero",
        },
        { kind: "logo", id: "mark" },
      ],
    },
  };

  test("emits a layer's keys as id, kind, props, elements, tracks — tracks last (K1's positional decision)", () => {
    const yaml = dumpBrief(templated);
    const heroAt = yaml.indexOf("id: hero");
    const heroKindAt = yaml.indexOf("kind: image", heroAt);
    expect(heroAt).toBeLessThan(heroKindAt);
    expect(heroKindAt).toBeLessThan(yaml.indexOf("tracks:"));
    expect(yaml.indexOf("tracks:")).toBeLessThan(yaml.indexOf("property: scale"));
  });

  test("emits a track's keys as property, stops, and a stop's as t, value, easing, clock", () => {
    const yaml = dumpBrief(templated);
    expect(yaml.indexOf("property: scale")).toBeLessThan(yaml.indexOf("stops:"));
    expect(yaml.indexOf("t: 0")).toBeLessThan(yaml.indexOf("value: 1"));
    expect(yaml.indexOf("value: 1")).toBeLessThan(yaml.indexOf("easing: linear"));
    expect(yaml.indexOf("easing: linear")).toBeLessThan(yaml.indexOf("clock: pose"));
    // The second stop carries no easing override; its own key order still holds.
    expect(yaml.indexOf("t: 1")).toBeLessThan(yaml.indexOf("value: 0.5"));
  });

  test("a layer's tracks round-trip through YAML and dump byte-identically", () => {
    const yaml = dumpBrief(templated);
    expect(parse(yaml)).toEqual(templated);
    expect(dumpBrief(parse(yaml) as object)).toBe(yaml);
  });

  test("tracks/stops entries the order cannot name pass through untouched", () => {
    const passthrough = {
      ...brief,
      template: {
        id: "x",
        layers: [
          { id: "a", kind: "image", tracks: "junk" },
          { id: "b", kind: "image", tracks: ["junk", { stops: "junk" }] },
          {
            id: "c",
            kind: "image",
            tracks: [{ property: "opacity", stops: ["junk", { clock: "pose", t: 0, value: 0 }] }],
          },
        ],
      },
    };
    const yaml = dumpBrief(passthrough);
    expect(yaml).toContain("tracks: junk");
    expect(yaml).toContain("stops: junk");
    expect(yaml).toContain("- junk");
    expect(parse(yaml)).toEqual(passthrough);
  });

  test("a layer with no tracks behaves exactly as today — round-trips byte-identically", () => {
    const propless = {
      ...brief,
      template: {
        id: "canonical-video",
        version: 1,
        creativeType: "video",
        unit: "standard-web",
        layers: [
          { id: "video", kind: "video" },
          { id: "logo", kind: "logo" },
        ],
      },
    };
    const yaml = dumpBrief(propless);
    expect(yaml).not.toContain("tracks:");
    expect(parse(yaml)).toEqual(propless);
    expect(dumpBrief(parse(yaml) as object)).toBe(yaml);
  });

  // Positional proof (the plan's own warning): `orderedKeys` appends unnamed
  // keys at the end, so dropping `tracks` from `LAYER_KEY_ORDER` would still
  // leave it *somewhere* near the end — a plain "tracks appears" assertion
  // cannot catch that mutation. This fixture writes an unnamed key ("extra")
  // BEFORE `tracks` in source order: with `tracks` in `LAYER_KEY_ORDER`, it is
  // emitted at its declared (sixth) position, always ahead of any unnamed
  // remainder key regardless of that key's own source position. Drop `tracks`
  // from the order array and it falls into the "remaining keys" bucket too,
  // in source order — after "extra" — flipping this assertion (mirrors the
  // `clickDestination` positional test above).
  test("a layer frame override round-trips and sits after enabled, before props", () => {
    const withFrame = {
      ...brief,
      template: {
        id: "canonical-image-text",
        version: 1,
        creativeType: "image-text",
        unit: "standard-web",
        layers: [
          {
            props: { alt: "pack" },
            byFamily: undefined,
            frame: {
              byFamily: { size: { "300x250": { h: 0.25, x: 0 } }, ratio: { "1:1": { y: 0.1 } } },
              anchor: "top",
              h: 0.5,
              w: 1,
              y: 0,
              x: 0,
            },
            kind: "image",
            id: "bg",
          },
        ],
      },
    };
    const yaml = dumpBrief(withFrame);
    expect(yaml.indexOf("id: bg")).toBeLessThan(yaml.indexOf("kind: image"));
    expect(yaml.indexOf("kind: image")).toBeLessThan(yaml.indexOf("frame:"));
    expect(yaml.indexOf("frame:")).toBeLessThan(yaml.indexOf("props:"));
    expect(yaml.indexOf("x: 0")).toBeLessThan(yaml.indexOf("y: 0"));
    expect(yaml.indexOf("y: 0")).toBeLessThan(yaml.indexOf("w: 1"));
    expect(yaml.indexOf("w: 1")).toBeLessThan(yaml.indexOf("h: 0.5"));
    expect(yaml.indexOf("h: 0.5")).toBeLessThan(yaml.indexOf("anchor: top"));
    expect(yaml.indexOf("anchor: top")).toBeLessThan(yaml.indexOf("byFamily:"));
    expect(yaml.indexOf("ratio:")).toBeLessThan(yaml.indexOf("size:"));
    const parsed = parse(yaml) as typeof withFrame;
    expect(parsed.template.layers[0]).toEqual({
      id: "bg",
      kind: "image",
      frame: {
        x: 0,
        y: 0,
        w: 1,
        h: 0.5,
        anchor: "top",
        byFamily: { ratio: { "1:1": { y: 0.1 } }, size: { "300x250": { h: 0.25, x: 0 } } },
      },
      props: { alt: "pack" },
    });
    expect(dumpBrief(parsed)).toBe(yaml);
  });

  test("byFamily.ratio and byFamily.size dump independently, and a non-object overlay passes through", () => {
    const dump = (byFamily: unknown) =>
      dumpBrief({
        ...brief,
        template: {
          id: "canonical-image-text",
          version: 1,
          creativeType: "image-text",
          unit: "standard-web",
          layers: [
            {
              id: "bg",
              kind: "image",
              frame: { x: 0, y: 0, w: 1, h: 1, anchor: "top", byFamily },
            },
          ],
        },
      });

    const both = dump({
      size: { "300x250": { h: 0.25 } },
      ratio: { "1:1": { y: 0.1 } },
    });
    expect(both).toContain("ratio:");
    expect(both).toContain("size:");
    expect(both.indexOf("ratio:")).toBeLessThan(both.indexOf("size:"));
    expect(dumpBrief(parse(both) as object)).toBe(both);

    const ratioOnly = dump({ ratio: { "9:16": { w: 0.5 } } });
    expect(ratioOnly).toContain("ratio:");
    expect(ratioOnly).not.toContain("size:");

    const sizeOnly = dump({ size: { "728x90": { x: 0.1 } } });
    expect(sizeOnly).toContain("size:");
    expect(sizeOnly).not.toContain("ratio:");

    const empty = dump({});
    expect(empty).toContain("byFamily: {}");

    const passthrough = dump({ size: { "300x250": null }, ratio: "junk" });
    expect(passthrough).toContain("ratio: junk");
    expect(passthrough).toContain("300x250: null");
  });

  test("a brief that omits frame still omits it", () => {
    const yaml = dumpBrief(templated);
    expect(yaml).not.toContain("frame:");
    expect(yaml).not.toContain("byFamily:");
    expect(dumpBrief(parse(yaml) as object)).toBe(yaml);
  });

  test("tracks sits at its declared key position, not merely 'somewhere' (positional proof)", () => {
    const positional = {
      ...brief,
      template: {
        id: "canonical-image-text",
        version: 1,
        creativeType: "image-text",
        unit: "standard-web",
        layers: [
          {
            extra: "z",
            tracks: [{ property: "opacity", stops: [{ t: 0, value: 0, clock: "pose" }] }],
            id: "image",
            kind: "image",
          },
        ],
      },
    };
    const yaml = dumpBrief(positional);
    expect(yaml.indexOf("tracks:")).toBeLessThan(yaml.indexOf("extra:"));
    expect(parse(yaml)).toEqual(positional);
    expect(dumpBrief(parse(yaml) as object)).toBe(yaml);
  });
});

describe("dumpBrief element style order (HL5e)", () => {
  // Positional proof, the `tracks` test's own warning: an unnamed key written
  // BEFORE `style` in source order must still emit after it, and `style` must
  // sit between `text` and `frame` however the source scrambles them.
  const styled = {
    ...brief,
    template: {
      id: "canonical-image-html",
      version: 1,
      creativeType: "image-html",
      unit: "standard-web",
      layers: [
        {
          id: "html",
          kind: "html",
          elements: [
            {
              frame: { anchor: "top", h: 0.3, w: 0.5, y: 0.2, x: 0.1 },
              style: { fontFamily: "Lora", fontWeight: 400 },
              extra: "z",
              text: "Buy",
              kind: "text",
            },
          ],
        },
      ],
    },
  };

  test("style sits after text and before frame, and its own keys are ordered", () => {
    const yaml = dumpBrief(styled);
    expect(yaml.indexOf("text: Buy")).toBeLessThan(yaml.indexOf("style:"));
    // The declared position, not merely "somewhere": the unnamed `extra` key
    // comes first in source order yet must emit after `style` and its frame.
    expect(yaml.indexOf("style:")).toBeLessThan(yaml.indexOf("extra:"));
    expect(yaml.indexOf("style:")).toBeLessThan(yaml.indexOf("frame:"));
    expect(yaml.indexOf("fontWeight: 400")).toBeLessThan(yaml.indexOf("fontFamily: Lora"));
  });

  test("an element with a style round-trips and dumps byte-identically", () => {
    const yaml = dumpBrief(styled);
    expect(parse(yaml)).toEqual(styled);
    expect(dumpBrief(parse(yaml) as object)).toBe(yaml);
  });
});
