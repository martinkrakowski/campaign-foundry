import { describe, test, expect } from "vitest";
import { CANONICAL_TEMPLATES } from "../creative-templates.js";
import {
  MAX_TEMPLATE_ID_LENGTH,
  MAX_TEMPLATE_LAYERS,
  MAX_TEMPLATE_NAME_LENGTH,
  MAX_TEMPLATE_VERSION,
  CanonicalTemplateCollisionError,
  InvalidTemplateError,
  TemplateVersionExistsError,
  TemplateWriteUnsupportedError,
  templateProblem,
} from "../template-problem.js";

/** A valid custom template (the image-text canonical shape, new id). */
function validTemplate(): Record<string, unknown> {
  return {
    id: "custom-a",
    version: 1,
    name: "Custom A",
    unit: "standard-web",
    creativeType: "image-text",
    layers: [...CANONICAL_TEMPLATES["image-text"].layers],
  };
}

/** A deep copy of `template` with one own polluting key defined on it. */
function withPollutingKey(value: object, key: string): object {
  const copy = { ...(value as Record<string, unknown>) };
  Object.defineProperty(copy, key, { value: {}, enumerable: true, configurable: true });
  return copy;
}

describe("templateProblem (RW-22)", () => {
  test("returns a problem for null, undefined, primitives, and arrays", () => {
    for (const bad of [null, undefined, "template", 7, true, [], [{ id: "a", kind: "image" }]]) {
      expect(templateProblem(bad)).toBe("template must be a plain object");
    }
  });

  test("catches throwing getters and returns 'template could not be read'", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "id", {
      get() {
        throw new Error("boom");
      },
      enumerable: true,
    });
    expect(templateProblem(hostile)).toBe("template could not be read");
  });

  test("catches a throwing Proxy without throwing", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("trapped");
        },
        has() {
          throw new Error("trapped");
        },
        ownKeys() {
          throw new Error("trapped");
        },
        getOwnPropertyDescriptor() {
          throw new Error("trapped");
        },
      },
    );
    expect(templateProblem(hostile)).toBe("template could not be read");
  });

  test("rejects prototype-polluting keys on template and layer", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(templateProblem(withPollutingKey(validTemplate(), key))).toBe(
        `template contains forbidden key "${key}"`,
      );
    }
    const layer = withPollutingKey({ id: "image", kind: "image" }, "__proto__");
    expect(templateProblem({ ...validTemplate(), layers: [layer] })).toBe(
      'layers[0] contains forbidden key "__proto__"',
    );
  });

  test("rejects missing, empty, overlong, or @-containing template id", () => {
    for (const id of [undefined, 7, null, "", "   ", "a".repeat(MAX_TEMPLATE_ID_LENGTH + 1)]) {
      expect(templateProblem({ ...validTemplate(), id })).toMatch(/template id must/);
    }
    expect(templateProblem({ ...validTemplate(), id: "custom@a" })).toBe(
      'template id must not contain "@"',
    );
    expect(templateProblem({ ...validTemplate(), id: "a".repeat(MAX_TEMPLATE_ID_LENGTH) })).toBe(
      undefined,
    );
  });

  test("rejects non-positive, non-integer, and out-of-range versions", () => {
    for (const version of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_TEMPLATE_VERSION + 1,
      "1",
      null,
    ]) {
      expect(templateProblem({ ...validTemplate(), version })).toMatch(/template version must/);
    }
    expect(templateProblem({ ...validTemplate(), version: MAX_TEMPLATE_VERSION })).toBe(undefined);
  });

  test("rejects missing, empty, or overlong template name", () => {
    for (const name of [undefined, 7, null, "", "   ", "n".repeat(MAX_TEMPLATE_NAME_LENGTH + 1)]) {
      expect(templateProblem({ ...validTemplate(), name })).toMatch(/template name must/);
    }
    expect(
      templateProblem({ ...validTemplate(), name: "n".repeat(MAX_TEMPLATE_NAME_LENGTH) }),
    ).toBe(undefined);
  });

  test("rejects unknown unit and creativeType", () => {
    expect(templateProblem({ ...validTemplate(), unit: "billboard" })).toMatch(
      /template unit must be one of/,
    );
    expect(templateProblem({ ...validTemplate(), creativeType: "print" })).toMatch(
      /template creativeType must be one of/,
    );
  });

  test("rejects non-array, non-iterable, and array-like layers", () => {
    for (const layers of [
      { length: 1 },
      { 0: { id: "image", kind: "image" }, length: 1 },
      "layer",
      { 0: {} },
    ]) {
      expect(templateProblem({ ...validTemplate(), layers })).toBe("layers must be an array");
    }
  });

  test("rejects empty layers", () => {
    expect(templateProblem({ ...validTemplate(), layers: [] })).toBe("layers must not be empty");
  });

  test("rejects enormous layers length in O(1) without walking elements", () => {
    const sparse: unknown[] = [];
    sparse.length = 1_000_000_000;
    expect(templateProblem({ ...validTemplate(), layers: sparse })).toBe(
      `layers must have at most ${MAX_TEMPLATE_LAYERS} entries`,
    );
    const dense = Array.from({ length: MAX_TEMPLATE_LAYERS + 1 }, () => ({
      id: "image",
      kind: "image",
    }));
    expect(templateProblem({ ...validTemplate(), layers: dense })).toBe(
      `layers must have at most ${MAX_TEMPLATE_LAYERS} entries`,
    );
  });

  test("rejects sparse array holes in layers", () => {
    const layers = [
      { id: "image", kind: "image" },
      { id: "shade", kind: "shade" },
      { id: "accent", kind: "accent" },
    ];
    delete layers[1];
    expect(templateProblem({ ...validTemplate(), layers })).toBe("layers[1] must be an object");
  });

  test("rejects malformed layers, duplicate layer ids, unknown kinds, and own elements", () => {
    expect(templateProblem({ ...validTemplate(), layers: [null] })).toMatch(
      /^layers\[0\] must be an object$/,
    );
    expect(templateProblem({ ...validTemplate(), layers: ["image"] })).toMatch(
      /^layers\[0\] must be an object$/,
    );
    expect(templateProblem({ ...validTemplate(), layers: [{ id: "", kind: "image" }] })).toBe(
      "layers[0] id must be a non-empty string",
    );
    expect(templateProblem({ ...validTemplate(), layers: [{ id: "a" }] })).toMatch(
      /^layers\[0\] kind must be one of/,
    );
    expect(
      templateProblem({
        ...validTemplate(),
        layers: [
          { id: "image", kind: "image" },
          { id: "image", kind: "shade" },
        ],
      }),
    ).toBe('layers[1] id "image" is already used by an earlier layer');
    expect(templateProblem({ ...validTemplate(), layers: [{ id: "a", kind: "marquee" }] })).toMatch(
      /^layers\[0\] kind must be one of/,
    );
    expect(
      templateProblem({
        ...validTemplate(),
        layers: [{ id: "a", kind: "static-text", elements: [] }],
      }),
    ).toBe('layers[0] must not carry its own "elements" property');
  });

  test("delegates layer field validation to existing layer*Problem validators", () => {
    const withLayer = (layer: Record<string, unknown>): Record<string, unknown> => ({
      ...validTemplate(),
      layers: [layer],
    });
    expect(templateProblem(withLayer({ id: "a", kind: "image", enabled: "yes" }))).toBe(
      'layers[0].enabled must be a boolean (got "yes")',
    );
    expect(templateProblem(withLayer({ id: "a", kind: "image", link: "https://x" }))).toBe(
      'layers[0].link must be a boolean (got "https://x")',
    );
    expect(templateProblem(withLayer({ id: "a", kind: "image", frame: { x: 2 } }))).toBe(
      "layers[0].x must be a number in [0, 1] (got 2)",
    );
    expect(templateProblem(withLayer({ id: "a", kind: "shade", props: {} }))).toBe(
      'layers[0] must be absent for layer kind "shade" (got {})',
    );
    expect(templateProblem(withLayer({ id: "a", kind: "shade", tracks: [] }))).toBe(
      'layers[0] must be absent for layer kind "shade" (got [])',
    );
    expect(templateProblem(withLayer({ id: "a", kind: "video", startSec: 1 }))).toBe(
      "layers[0].startSec must be absent; clip time is span.startT and span.endT as normalised t, never seconds (got 1)",
    );
    expect(
      templateProblem(withLayer({ id: "a", kind: "image", span: { startT: 0, endT: 1 } })),
    ).toBe('layers[0] must be absent for layer kind "image" (got {"startT":0,"endT":1})');
    expect(
      templateProblem(withLayer({ id: "a", kind: "video", span: { startT: 1, endT: 0 } })),
    ).toBe('layers[0] must have startT < endT (got {"startT":1,"endT":0})');
  });

  test("rejects layers violating CREATIVE_TYPE_RULES or order constraints", () => {
    const base = (): Record<string, unknown> => ({ ...validTemplate() });
    // a kind the creative type does not accept
    expect(
      templateProblem({
        ...base(),
        layers: [...CANONICAL_TEMPLATES["image-text"].layers, { id: "v", kind: "video" }],
      }),
    ).toBe('layers[5] kind "video" is not accepted by creative type "image-text"');
    // a maxOf cap exceeded
    expect(
      templateProblem({
        ...base(),
        layers: [...CANONICAL_TEMPLATES["image-text"].layers, { id: "shade-2", kind: "shade" }],
      }),
    ).toBe('layers must hold at most 1 of kind "shade"');
    // a sharedBudget exceeded
    expect(
      templateProblem({
        ...base(),
        layers: [
          ...CANONICAL_TEMPLATES["image-text"].layers,
          { id: "headline-2", kind: "animated-text" },
        ],
      }),
    ).toBe('layers must hold at most 1 across kinds "static-text", "animated-text"');
    // a required kind present but disabled
    expect(
      templateProblem({
        ...base(),
        layers: CANONICAL_TEMPLATES["image-text"].layers.map((layer) =>
          layer.kind === "static-text" ? { ...layer, enabled: false } : layer,
        ),
      }),
    ).toBe('creative type "image-text" requires an enabled "static-text" layer');
    // an order constraint violated (logo below image)
    expect(
      templateProblem({
        ...base(),
        layers: [
          { id: "logo", kind: "logo" },
          { id: "image", kind: "image" },
          { id: "shade", kind: "shade" },
          { id: "accent", kind: "accent" },
          { id: "static-text", kind: "static-text" },
        ],
      }),
    ).toBe('layers order must satisfy the order constraints of creative type "image-text"');
  });

  test("returns undefined for canonical and valid custom templates", () => {
    for (const template of Object.values(CANONICAL_TEMPLATES)) {
      expect(templateProblem(template)).toBe(undefined);
    }
    expect(templateProblem(validTemplate())).toBe(undefined);
    expect(
      templateProblem({
        id: "a".repeat(MAX_TEMPLATE_ID_LENGTH),
        version: MAX_TEMPLATE_VERSION,
        name: "n".repeat(MAX_TEMPLATE_NAME_LENGTH),
        unit: "standard-web",
        creativeType: "image-text",
        layers: CANONICAL_TEMPLATES["image-text"].layers.map((layer) => ({
          ...layer,
          frame: { x: 0, y: 0, w: 1, h: 1, anchor: "top" },
        })),
      }),
    ).toBe(undefined);
  });

  test("one valid and one invalid template give different outputs", () => {
    expect(templateProblem(validTemplate())).toBe(undefined);
    expect(templateProblem(null)).toBe("template must be a plain object");
  });

  test("exports typed template error classes with expected names and properties", () => {
    const error = new InvalidTemplateError("template id must be a non-empty string");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("InvalidTemplateError");
    expect(error.problem).toBe("template id must be a non-empty string");
    expect(error.message).toBe("template id must be a non-empty string");

    for (const [Ctor, name] of [
      [CanonicalTemplateCollisionError, "CanonicalTemplateCollisionError"],
      [TemplateVersionExistsError, "TemplateVersionExistsError"],
      [TemplateWriteUnsupportedError, "TemplateWriteUnsupportedError"],
    ] as const) {
      const error = new Ctor();
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(name);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});
