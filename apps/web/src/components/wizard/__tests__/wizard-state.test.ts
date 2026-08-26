import { describe, test, expect, afterEach, vi } from "vitest";
import type { CopyPool } from "@campaignfoundry/CampaignOrchestration";
import {
  approvedHeadlines,
  assetFileName,
  canPlan,
  fileToBase64,
  initialWizardState,
  slugify,
  stepsFor,
  toBrief,
  wizardReducer,
  type WizardState,
} from "../wizard-state";

const withStep = (stepIndex: number, over: Partial<WizardState> = {}): WizardState => ({
  ...initialWizardState,
  stepIndex,
  ...over,
});

describe("slugify / assetFileName", () => {
  test("slugs names and strips junk", () => {
    expect(slugify("Hydra Bottle")).toBe("hydra-bottle");
    expect(slugify("  --X--  ")).toBe("x");
    expect(slugify("")).toBe("");
    expect(slugify("a".repeat(80))).toHaveLength(64);
  });

  test("namespaces the basename by product id so two logo.png files do not collide", () => {
    expect(assetFileName("My Logo.PNG", "alpha")).toBe("alpha-my-logo.png");
    expect(assetFileName("logo.png", "beta")).toBe("beta-logo.png");
    expect(assetFileName("photo.JPEG", "gamma")).toBe("gamma-photo.jpeg");
    expect(assetFileName("...", "delta")).toBe("delta-logo.png");
    expect(assetFileName("no-ext", "epsilon")).toBe("epsilon-no-ext.png");
    expect(assetFileName("logo.png", "")).toBe("product-logo.png");
    expect(assetFileName("logo.png", "a".repeat(64))).toBe(`${"a".repeat(64)}.png`);
    expect(assetFileName("logo.png", "a".repeat(63))).toBe(`${"a".repeat(63)}.png`);
  });
});

describe("fileToBase64", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("encodes the file bytes", async () => {
    const file = new File([new Uint8Array([104, 105])], "x.png", { type: "image/png" });
    expect(await fileToBase64(file)).toBe(btoa("hi"));
  });

  test("strips a data-URL prefix and falls back when FileReader returns a bare string", async () => {
    class FakeReader {
      result: string | ArrayBuffer | null = "data:image/png;base64,abc";
      error: Error | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.onload?.();
      }
    }
    vi.stubGlobal("FileReader", FakeReader);
    expect(await fileToBase64(new File([""], "x.png"))).toBe("abc");

    class BareReader extends FakeReader {
      result = "not-a-data-url";
    }
    vi.stubGlobal("FileReader", BareReader);
    expect(await fileToBase64(new File([""], "x.png"))).toBe("not-a-data-url");

    class BufferReader extends FakeReader {
      result: string | ArrayBuffer | null = new ArrayBuffer(0);
    }
    vi.stubGlobal("FileReader", BufferReader);
    expect(await fileToBase64(new File([""], "x.png"))).toBe("");
    vi.unstubAllGlobals();
  });

  test("rejects when FileReader fails", async () => {
    class FailReader {
      result = null;
      error: Error | null = new Error("nope");
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.onerror?.();
      }
    }
    vi.stubGlobal("FileReader", FailReader);
    await expect(fileToBase64(new File([""], "x.png"))).rejects.toThrow("nope");

    class SilentFailReader extends FailReader {
      error = null;
    }
    vi.stubGlobal("FileReader", SilentFailReader);
    await expect(fileToBase64(new File([""], "x.png"))).rejects.toThrow("read failed");
    vi.unstubAllGlobals();
  });
});

describe("stepsFor", () => {
  test("inserts the policy step only for randomized campaigns", () => {
    expect(stepsFor("brief")).not.toContain("policy");
    expect(stepsFor("variation")).toContain("policy");
  });
});

describe("wizardReducer", () => {
  test("clamps next/back and setMode", () => {
    expect(wizardReducer(withStep(0), { type: "back" }).stepIndex).toBe(0);
    expect(wizardReducer(withStep(4), { type: "next" }).stepIndex).toBe(4); // classic last
    expect(wizardReducer(withStep(3), { type: "next" }).stepIndex).toBe(4);
    expect(
      wizardReducer(withStep(5, { mode: "variation" }), { type: "setMode", mode: "brief" }).stepIndex,
    ).toBe(4);
  });

  test("patches scalars and variation fields", () => {
    const patched = wizardReducer(initialWizardState, { type: "patch", patch: { briefId: "camp" } });
    expect(patched.briefId).toBe("camp");
    expect(
      wizardReducer(initialWizardState, { type: "setVariation", field: "count", value: "8" }).variation
        .count,
    ).toBe("8");
  });

  test("auto-slugs a product id until the id is touched", () => {
    const key = initialWizardState.products[0].key;
    const named = wizardReducer(initialWizardState, {
      type: "setProduct",
      key,
      patch: { name: "Hydra Bottle" },
    });
    expect(named.products[0].id).toBe("hydra-bottle");
    const touched = wizardReducer(named, { type: "setProduct", key, patch: { id: "custom" } });
    expect(touched.products[0].idTouched).toBe(true);
    const renamed = wizardReducer(touched, { type: "setProduct", key, patch: { name: "Other" } });
    expect(renamed.products[0].id).toBe("custom");
  });

  test("adds and removes products by stable key", () => {
    const added = wizardReducer(initialWizardState, { type: "addProduct" });
    expect(added.products).toHaveLength(3);
    expect(added.products[2]).toMatchObject({
      id: "",
      name: "",
      primaryColor: "#1473E6",
      logoPath: "",
      inputAsset: "",
      idTouched: false,
    });
    expect(new Set(added.products.map((product) => product.key)).size).toBe(3);
    const firstKey = added.products[0].key;
    expect(wizardReducer(added, { type: "removeProduct", key: firstKey }).products).toHaveLength(2);
  });

  test("toggles axes and platforms, preserving allowlist order", () => {
    const off = wizardReducer(initialWizardState, { type: "toggleLayout", value: "headline-top" });
    expect(off.variation.layout).toEqual(["headline-bottom"]);
    const on = wizardReducer(off, { type: "toggleLayout", value: "headline-top" });
    expect(on.variation.layout).toEqual(["headline-top", "headline-bottom"]);
    expect(
      wizardReducer(initialWizardState, { type: "toggleTone", value: "bold" }).variation.tone,
    ).toEqual(["subtle"]);
    expect(
      wizardReducer(initialWizardState, { type: "toggleBackground", value: "genai" }).variation
        .background,
    ).toEqual(["procedural", "genai"]);
    expect(
      wizardReducer(initialWizardState, { type: "togglePalette", value: 0 }).variation.paletteShift,
    ).toEqual([0.1, 0.2]);
    expect(
      wizardReducer(initialWizardState, { type: "togglePlatform", value: "x" }).platforms,
    ).toEqual(["instagram-feed", "linkedin"]);
  });
});

describe("toBrief / canPlan", () => {
  const filled: WizardState = {
    ...initialWizardState,
    briefId: "camp",
    targetRegion: "DE",
    targetAudience: "fans",
    campaignMessage: "Hi",
    localizedMessage: "Hallo",
    products: [
      {
        key: 10,
        id: "alpha",
        name: "A",
        primaryColor: "#1473E6",
        logoPath: "a.png",
        inputAsset: "in.png",
        idTouched: true,
      },
      {
        key: 11,
        id: "beta",
        name: "B",
        primaryColor: "#E0218A",
        logoPath: "b.png",
        inputAsset: "  ",
        idTouched: true,
      },
    ],
  };

  test("omits empty optional fields in classic mode", () => {
    const classic = toBrief({ ...filled, localizedMessage: "" });
    expect(classic.mode).toBe("brief");
    expect(classic.localizedMessage).toBeUndefined();
    expect(classic.variation).toBeUndefined();
    expect(classic.products[0].inputAsset).toBe("in.png");
    expect(classic.products[1].inputAsset).toBeUndefined();
    expect(classic.output).toEqual({
      formats: ["static"],
      platforms: ["instagram-feed", "linkedin", "x"],
    });
  });

  test("includes variation when randomized, omitting empty nested blocks", () => {
    const randomized = toBrief({
      ...filled,
      mode: "variation",
      variation: {
        count: "12",
        seed: "42",
        minDistance: "2",
        perProduct: "1",
        perRatio: "",
        layout: [],
        tone: [],
        background: [],
        paletteShift: [],
        headline: false,
      },
    });
    expect(randomized.variation).toEqual({
      count: 12,
      seed: 42,
      minDistance: 2,
      coverage: { perProduct: 1 },
      axes: { layout: [], tone: [], background: { source: [] }, paletteShift: [] },
    });
    const ratioOnly = toBrief({
      ...filled,
      mode: "variation",
      variation: {
        count: "nope",
        seed: "",
        minDistance: "",
        perProduct: "",
        perRatio: "1",
        layout: [],
        tone: [],
        background: [],
        paletteShift: [],
        headline: false,
      },
    });
    expect(ratioOnly.variation).toEqual({
      count: 0,
      coverage: { perRatio: 1 },
      axes: { layout: [], tone: [], background: { source: [] }, paletteShift: [] },
    });
    const noOptional = toBrief({
      ...filled,
      mode: "variation",
      variation: {
        count: "3",
        seed: "",
        minDistance: "",
        perProduct: "",
        perRatio: "",
        layout: ["headline-top"],
        tone: ["bold"],
        background: ["procedural"],
        paletteShift: [0],
        headline: false,
      },
    });
    expect(noOptional.variation).toEqual({
      count: 3,
      axes: {
        layout: ["headline-top"],
        tone: ["bold"],
        background: { source: ["procedural"] },
        paletteShift: [0],
      },
    });
  });

  test("emits headline: pool://copy only when the axis is on", () => {
    const on = toBrief({ ...filled, mode: "variation", variation: { ...filled.variation, headline: true } });
    expect(on.variation?.axes?.headline).toBe("pool://copy");
    const off = toBrief({ ...filled, mode: "variation" });
    expect(off.variation?.axes).not.toHaveProperty("headline");
  });

  test("canPlan requires variation mode, an id, a product id, and count >= 1", () => {
    expect(canPlan(initialWizardState)).toBe(false);
    expect(canPlan({ ...filled, mode: "variation" })).toBe(true);
    expect(canPlan({ ...filled, mode: "variation", variation: { ...filled.variation, count: "0" } })).toBe(
      false,
    );
  });
});

describe("headline pool state", () => {
  const pool = (statuses: readonly ("approved" | "rejected")[]): CopyPool => ({
    briefId: "camp",
    generatedAt: "2026-01-01T00:00:00.000Z",
    model: "m",
    entries: statuses.map((status, i) => ({ id: `h${i + 1}`, text: `Line ${i + 1}`, status })),
  });

  test("approvedHeadlines counts approved entries and is 0 without a pool", () => {
    expect(approvedHeadlines(null)).toBe(0);
    expect(approvedHeadlines(pool(["approved", "rejected", "approved"]))).toBe(2);
  });

  test("toggleHeadline flips the axis; setPool stores the pool and drops the axis when nothing is approved", () => {
    const on = wizardReducer(initialWizardState, { type: "toggleHeadline" });
    expect(on.variation.headline).toBe(true);
    expect(wizardReducer(on, { type: "toggleHeadline" }).variation.headline).toBe(false);

    const withPool = wizardReducer(on, { type: "setPool", pool: pool(["approved"]) });
    expect(withPool.pool?.entries).toHaveLength(1);
    expect(withPool.variation.headline).toBe(true);

    const emptied = wizardReducer(withPool, { type: "setPool", pool: pool(["rejected"]) });
    expect(emptied.variation.headline).toBe(false);
    expect(wizardReducer(withPool, { type: "setPool", pool: null }).variation.headline).toBe(false);
  });
});
