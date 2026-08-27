import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import type { CampaignBrief, CopyPool } from "@campaignfoundry/CampaignOrchestration";
import {
  LAYOUT_OPTIONS,
  TONE_OPTIONS,
  PALETTE_SHIFT_OPTIONS,
  STATIC_PLATFORMS,
  HEADLINE_POOL_REF,
  emptyProduct,
  slugify,
  assetFileName,
  fileToBase64,
  initialEditorState,
  editorReducer,
  approvedHeadlines,
  toBrief,
  fromBrief,
  isDirtySinceSave,
  isDirtySinceApply,
  isPristine,
  getDraftKey,
  saveDraftToStorage,
  loadDraftFromStorage,
  purgeDraftFromStorage,
  canPlan,
  type EditorState,
  type EditorAction,
} from "../editor-state";

const reduce = (state: EditorState, ...actions: EditorAction[]): EditorState =>
  actions.reduce(editorReducer, state);

const base = (): EditorState => initialEditorState();

const pool = (statuses: string[]): CopyPool =>
  ({ entries: statuses.map((status, i) => ({ id: `e${i}`, text: `t${i}`, status })) }) as unknown as CopyPool;

const savedBrief = (over: Partial<CampaignBrief> = {}): CampaignBrief =>
  ({
    id: "camp",
    targetRegion: "DE",
    targetAudience: "a",
    campaignMessage: "Hi",
    products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "l.png" }],
    ...over,
  }) as CampaignBrief;

describe("value helpers", () => {
  test("emptyProduct hands out a fresh key each call and sane defaults", () => {
    const a = emptyProduct();
    const b = emptyProduct();
    expect(b.key).toBe(a.key + 1);
    expect(a).toMatchObject({ id: "", name: "", primaryColor: "#1473E6", logoPath: "", inputAsset: "", idTouched: false });
  });

  test("slugify lowercases, collapses runs, trims dashes and caps at 64", () => {
    expect(slugify("Hydra Bottle!")).toBe("hydra-bottle");
    expect(slugify("  --Trail__Runner--  ")).toBe("trail-runner");
    expect(slugify("")).toBe("");
    expect(slugify("!!!")).toBe("");
    // 64-char cap, then any dash the cut left behind is trimmed
    expect(slugify("a".repeat(70))).toBe("a".repeat(64));
    expect(slugify(`${"a".repeat(64)} tail`)).toBe("a".repeat(64));
  });

  test("assetFileName keeps a known extension and falls back to png", () => {
    expect(assetFileName("Logo.PNG", "alpha")).toBe("alpha-logo.png");
    expect(assetFileName("mark.jpg", "alpha")).toBe("alpha-mark.jpg");
    expect(assetFileName("mark.jpeg", "alpha")).toBe("alpha-mark.jpeg");
    expect(assetFileName("mark.webp", "alpha")).toBe("alpha-mark.png");
  });

  test("assetFileName substitutes placeholders for an empty stem or product id", () => {
    expect(assetFileName("!!!.png", "alpha")).toBe("alpha-logo.png");
    expect(assetFileName("mark.png", "")).toBe("product-mark.png");
    expect(assetFileName(`${"z".repeat(70)}.png`, "alpha")).toBe(`alpha-${"z".repeat(58)}.png`);
  });

  test("approvedHeadlines counts only approved entries", () => {
    expect(approvedHeadlines(null)).toBe(0);
    expect(approvedHeadlines(pool([]))).toBe(0);
    expect(approvedHeadlines(pool(["approved", "pending", "approved"]))).toBe(2);
  });
});

describe("fileToBase64", () => {
  test("strips the data-URL prefix", async () => {
    const file = new File(["hello"], "a.png", { type: "image/png" });
    await expect(fileToBase64(file)).resolves.toBe(Buffer.from("hello").toString("base64"));
  });

  test("returns the raw result when there is no comma, and empty for a non-string result", async () => {
    class NoCommaReader {
      result: unknown = "abc";
      error: unknown = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.onload?.();
      }
    }
    vi.stubGlobal("FileReader", NoCommaReader);
    await expect(fileToBase64(new File([""], "a.png"))).resolves.toBe("abc");

    class BinaryReader extends NoCommaReader {
      result: unknown = new ArrayBuffer(2);
    }
    vi.stubGlobal("FileReader", BinaryReader);
    await expect(fileToBase64(new File([""], "a.png"))).resolves.toBe("");
    vi.unstubAllGlobals();
  });

  test("rejects with the reader's error, and with a fallback when it has none", async () => {
    class FailingReader {
      result: unknown = null;
      error: unknown = new Error("boom");
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.onerror?.();
      }
    }
    vi.stubGlobal("FileReader", FailingReader);
    await expect(fileToBase64(new File([""], "a.png"))).rejects.toThrow("boom");

    class SilentReader extends FailingReader {
      error: unknown = null;
    }
    vi.stubGlobal("FileReader", SilentReader);
    await expect(fileToBase64(new File([""], "a.png"))).rejects.toThrow("read failed");
    vi.unstubAllGlobals();
  });
});

describe("initialEditorState", () => {
  test("defaults to brief mode with two blank products and every static platform", () => {
    const state = initialEditorState();
    expect(state.mode).toBe("brief");
    expect(state.source.kind).toBe("new");
    expect(state.products).toHaveLength(2);
    expect(state.platforms).toEqual([...STATIC_PLATFORMS]);
    expect(state.formats).toEqual(["static"]);
  });

  test("honours an explicit mode", () => {
    expect(initialEditorState("variation").mode).toBe("variation");
  });
});

describe("editorReducer — identity and copy", () => {
  test("setMode switches mode", () => {
    expect(reduce(base(), { type: "setMode", mode: "variation" }).mode).toBe("variation");
  });

  test("patch merges fields without touching the pool when briefId is unchanged", () => {
    const seeded = { ...base(), pool: pool(["approved"]), headlineAxisDropped: true };
    seeded.variation = { ...seeded.variation, headline: true };
    const next = reduce(seeded, { type: "patch", patch: { targetRegion: "DE" } });
    expect(next.targetRegion).toBe("DE");
    expect(next.pool).not.toBeNull();
    expect(next.variation.headline).toBe(true);
  });

  test("patch resets the pool and headline axis when briefId actually changes", () => {
    const seeded = { ...base(), briefId: "old", pool: pool(["approved"]), headlineAxisDropped: true };
    seeded.variation = { ...seeded.variation, headline: true };
    const next = reduce(seeded, { type: "patch", patch: { briefId: "new" } });
    expect(next.pool).toBeNull();
    expect(next.headlineAxisDropped).toBe(false);
    expect(next.variation.headline).toBe(false);
  });

  test("patch with the same briefId keeps the pool", () => {
    const seeded = { ...base(), briefId: "same", pool: pool(["approved"]) };
    expect(reduce(seeded, { type: "patch", patch: { briefId: "same" } }).pool).not.toBeNull();
  });
});

describe("editorReducer — products", () => {
  test("setProduct patches only the matching key", () => {
    const state = base();
    const [first, second] = state.products;
    const next = reduce(state, { type: "setProduct", key: first.key, patch: { primaryColor: "#000000" } });
    expect(next.products[0].primaryColor).toBe("#000000");
    expect(next.products[1]).toBe(second);
  });

  test("editing the name derives the id until the id is touched directly", () => {
    const state = base();
    const key = state.products[0].key;
    const derived = reduce(state, { type: "setProduct", key, patch: { name: "Hydra Bottle" } });
    expect(derived.products[0].id).toBe("hydra-bottle");
    expect(derived.products[0].idTouched).toBe(false);

    const touched = reduce(derived, { type: "setProduct", key, patch: { id: "custom" } });
    expect(touched.products[0].idTouched).toBe(true);

    const renamed = reduce(touched, { type: "setProduct", key, patch: { name: "Something Else" } });
    expect(renamed.products[0].id).toBe("custom");
  });

  test("addProduct appends and removeProduct drops by key", () => {
    const added = reduce(base(), { type: "addProduct" });
    expect(added.products).toHaveLength(3);
    const removed = reduce(added, { type: "removeProduct", key: added.products[1].key });
    expect(removed.products).toHaveLength(2);
    expect(removed.products.map((p) => p.key)).not.toContain(added.products[1].key);
  });
});

describe("editorReducer — treatments", () => {
  test("add, patch the matching index, and remove", () => {
    const added = reduce(base(), { type: "addTreatment" }, { type: "addTreatment" });
    expect(added.treatments).toHaveLength(2);
    expect(added.treatments[0]).toEqual({ id: "", layout: LAYOUT_OPTIONS[0], tone: TONE_OPTIONS[0] });

    const patched = reduce(added, { type: "setTreatment", index: 1, patch: { id: "bold" } });
    expect(patched.treatments[1].id).toBe("bold");
    expect(patched.treatments[0].id).toBe("");

    const removed = reduce(patched, { type: "removeTreatment", index: 0 });
    expect(removed.treatments).toHaveLength(1);
    expect(removed.treatments[0].id).toBe("bold");
  });
});

describe("editorReducer — variation axes", () => {
  test("setVariation writes the named numeric field", () => {
    expect(reduce(base(), { type: "setVariation", field: "seed", value: "42" }).variation.seed).toBe("42");
  });

  test("toggles remove a selected value and re-add it in canonical order", () => {
    const off = reduce(base(), { type: "toggleLayout", value: LAYOUT_OPTIONS[0] });
    expect(off.variation.layout).toEqual([LAYOUT_OPTIONS[1]]);
    const on = reduce(off, { type: "toggleLayout", value: LAYOUT_OPTIONS[0] });
    expect(on.variation.layout).toEqual([...LAYOUT_OPTIONS]);
  });

  test("tone, background and palette toggle the same way", () => {
    const state = reduce(
      base(),
      { type: "toggleTone", value: TONE_OPTIONS[0] },
      { type: "toggleBackground", value: "genai" },
      { type: "togglePalette", value: PALETTE_SHIFT_OPTIONS[0] },
    );
    expect(state.variation.tone).toEqual([TONE_OPTIONS[1]]);
    expect(state.variation.background).toEqual(["procedural", "genai"]);
    expect(state.variation.paletteShift).toEqual([PALETTE_SHIFT_OPTIONS[1], PALETTE_SHIFT_OPTIONS[2]]);
  });

  test("toggleHeadline flips the flag", () => {
    const on = reduce(base(), { type: "toggleHeadline" });
    expect(on.variation.headline).toBe(true);
    expect(reduce(on, { type: "toggleHeadline" }).variation.headline).toBe(false);
  });

  test("togglePlatform removes and restores in canonical order", () => {
    const off = reduce(base(), { type: "togglePlatform", value: STATIC_PLATFORMS[1] });
    expect(off.platforms).toEqual([STATIC_PLATFORMS[0], STATIC_PLATFORMS[2]]);
    expect(reduce(off, { type: "togglePlatform", value: STATIC_PLATFORMS[1] }).platforms).toEqual([...STATIC_PLATFORMS]);
  });
});

describe("editorReducer — motion, duration and formats", () => {
  test("toggleMotion adds then removes", () => {
    const on = reduce(base(), { type: "toggleMotion", value: "ken-burns-in" });
    expect(on.motion).toEqual(["ken-burns-in"]);
    expect(reduce(on, { type: "toggleMotion", value: "ken-burns-in" }).motion).toEqual([]);
  });

  test("duration is appended, written by index and removed by index", () => {
    const added = reduce(base(), { type: "addDuration" }, { type: "addDuration" });
    expect(added.duration).toEqual([5, 5]);
    const set = reduce(added, { type: "setDuration", index: 1, value: 8 });
    expect(set.duration).toEqual([5, 8]);
    expect(reduce(set, { type: "removeDuration", index: 0 }).duration).toEqual([8]);
  });

  test("toggleFormat adds then removes", () => {
    const on = reduce(base(), { type: "toggleFormat", value: "motion" });
    expect(on.formats).toEqual(["static", "motion"]);
    expect(reduce(on, { type: "toggleFormat", value: "motion" }).formats).toEqual(["static"]);
  });
});

describe("editorReducer — pool and capabilities", () => {
  test("setPool for a different brief is ignored", () => {
    const state = { ...base(), briefId: "camp" };
    expect(reduce(state, { type: "setPool", briefId: "other", pool: pool(["approved"]) })).toBe(state);
  });

  test("an empty pool drops the headline axis and records that it was dropped", () => {
    const state = reduce({ ...base(), briefId: "camp" }, { type: "toggleHeadline" });
    const next = reduce(state, { type: "setPool", briefId: "camp", pool: pool(["pending"]) });
    expect(next.variation.headline).toBe(false);
    expect(next.headlineAxisDropped).toBe(true);
  });

  test("a pool with approved copy keeps the axis and clears the dropped flag", () => {
    const state = reduce({ ...base(), briefId: "camp" }, { type: "toggleHeadline" });
    const next = reduce(state, { type: "setPool", briefId: "camp", pool: pool(["approved"]) });
    expect(next.variation.headline).toBe(true);
    expect(next.headlineAxisDropped).toBe(false);
  });

  test("an empty pool with the axis already off still reports nothing dropped", () => {
    const next = reduce({ ...base(), briefId: "camp" }, { type: "setPool", briefId: "camp", pool: null });
    expect(next.headlineAxisDropped).toBe(false);
  });

  test("loadPool for a different brief is ignored", () => {
    const state = { ...base(), briefId: "camp", pool: null };
    const next = reduce(state, { type: "loadPool", briefId: "other", pool: pool(["approved"]) });
    expect(next.pool).toBeNull();
    expect(next).toBe(state);
  });

  test("loadPool for current brief updates pool without touching variation", () => {
    const state = reduce({ ...base(), briefId: "camp" }, { type: "toggleHeadline" });
    expect(state.variation.headline).toBe(true);
    const next = reduce(state, { type: "loadPool", briefId: "camp", pool: pool([]) });
    expect(next.pool).toEqual(pool([]));
    expect(next.variation.headline).toBe(true);
    expect(next.headlineAxisDropped).toBe(false);
  });

  test("loadPool with null pool clears previous pool", () => {
    const state = { ...base(), briefId: "camp", pool: pool(["approved"]) };
    const next = reduce(state, { type: "loadPool", briefId: "camp", pool: null });
    expect(next.pool).toBeNull();
  });

  test("setCapabilities stores the probe result", () => {
    const next = reduce(base(), { type: "setCapabilities", capabilities: { motion: false, reason: "no ffmpeg" } });
    expect(next.capabilities).toEqual({ motion: false, reason: "no ffmpeg" });
  });
});

describe("editorReducer — load, apply, save, discard", () => {
  test("load replaces the state from a brief", () => {
    const next = reduce(base(), { type: "load", brief: savedBrief(), entry: { file: "camp.yaml", revision: "r1" } });
    expect(next.briefId).toBe("camp");
    expect(next.source).toMatchObject({ kind: "file", file: "camp.yaml", revision: "r1" });
  });

  test("apply snapshots the current brief", () => {
    const next = reduce({ ...base(), briefId: "camp" }, { type: "apply" });
    expect(next.appliedSnapshot).toMatchObject({ id: "camp" });
  });

  test("save on a new draft promotes the source to a file", () => {
    const next = reduce({ ...base(), briefId: "camp" }, { type: "save" });
    expect(next.source).toMatchObject({ kind: "file", file: "camp.yaml", loadedId: "camp", revision: undefined });
  });

  test("save on a loaded file keeps the file identity and refreshes the snapshot", () => {
    const loaded = reduce(base(), { type: "load", brief: savedBrief(), entry: { file: "camp.yaml", revision: "r1" } });
    const edited = reduce(loaded, { type: "patch", patch: { campaignMessage: "Changed" } });
    const next = reduce(edited, { type: "save" });
    expect(next.source).toMatchObject({ kind: "file", file: "camp.yaml", revision: "r1" });
    expect(next.source.kind === "file" && next.source.savedSnapshot?.campaignMessage).toBe("Changed");
  });

  test("discard on a loaded file reverts to the saved snapshot", () => {
    const loaded = reduce(base(), { type: "load", brief: savedBrief(), entry: { file: "camp.yaml", revision: "r1" } });
    const edited = reduce(loaded, { type: "patch", patch: { campaignMessage: "Changed" } });
    expect(reduce(edited, { type: "discard" }).campaignMessage).toBe("Hi");
  });

  test("discard on a new draft resets to the initial state in the same mode", () => {
    const dirty = reduce({ ...base(), mode: "variation", briefId: "camp" }, { type: "patch", patch: { targetRegion: "DE" } });
    const next = reduce(dirty, { type: "discard" });
    expect(next.mode).toBe("variation");
    expect(next.briefId).toBe("");
    expect(next.source.kind).toBe("new");
  });

  test("discard on a file source with no snapshot falls back to a fresh state", () => {
    const state: EditorState = {
      ...base(),
      source: { kind: "file", file: "camp.yaml", loadedId: "camp", savedSnapshot: null, revision: undefined },
      briefId: "camp",
    };
    expect(reduce(state, { type: "discard" }).briefId).toBe("");
  });
});

describe("toBrief", () => {
  const filled = (over: Partial<EditorState> = {}): EditorState => ({
    ...base(),
    briefId: "camp",
    targetRegion: "DE",
    targetAudience: "a",
    campaignMessage: "Hi",
    ...over,
  });

  test("classic mode emits treatments only when there are any", () => {
    expect(toBrief(filled())).not.toHaveProperty("treatments");
    const withTreatments = reduce(filled(), { type: "addTreatment" });
    expect(toBrief(withTreatments).treatments).toHaveLength(1);
  });

  test("localizedMessage is emitted only when it is non-blank after trimming", () => {
    expect(toBrief(filled({ localizedMessage: "   " }))).not.toHaveProperty("localizedMessage");
    expect(toBrief(filled({ localizedMessage: " Hallo " }))).toMatchObject({ localizedMessage: "Hallo" });
  });

  test("a product's inputAsset is emitted only when non-blank", () => {
    const state = filled();
    const withAsset = reduce(state, { type: "setProduct", key: state.products[0].key, patch: { inputAsset: " a.png " } });
    expect(toBrief(withAsset).products[0]).toMatchObject({ inputAsset: "a.png" });
    const blank = reduce(state, { type: "setProduct", key: state.products[0].key, patch: { inputAsset: "  " } });
    expect(toBrief(blank).products[0]).not.toHaveProperty("inputAsset");
  });

  test("variation mode emits count and omits non-numeric seed and minDistance", () => {
    const state = filled({ mode: "variation" });
    const brief = toBrief({ ...state, variation: { ...state.variation, seed: "", minDistance: "" } });
    expect(brief.variation).toMatchObject({ count: 12 });
    expect(brief.variation).not.toHaveProperty("seed");
    expect(brief.variation).not.toHaveProperty("minDistance");
  });

  test("variation mode emits numeric seed and minDistance when present", () => {
    const state = filled({ mode: "variation" });
    const brief = toBrief({ ...state, variation: { ...state.variation, seed: "7", minDistance: "3" } });
    expect(brief.variation).toMatchObject({ count: 12, seed: 7, minDistance: 3 });
  });

  test("an unparseable count degrades to zero", () => {
    const state = filled({ mode: "variation" });
    expect(toBrief({ ...state, variation: { ...state.variation, count: "" } }).variation?.count).toBe(0);
  });

  test("coverage carries only the positive halves and is dropped when both are zero", () => {
    const state = filled({ mode: "variation" });
    const both = toBrief({ ...state, variation: { ...state.variation, perProduct: "2", perRatio: "3" } });
    expect(both.variation?.coverage).toEqual({ perProduct: 2, perRatio: 3 });

    const onlyProduct = toBrief({ ...state, variation: { ...state.variation, perProduct: "2", perRatio: "0" } });
    expect(onlyProduct.variation?.coverage).toEqual({ perProduct: 2 });

    const onlyRatio = toBrief({ ...state, variation: { ...state.variation, perProduct: "0", perRatio: "3" } });
    expect(onlyRatio.variation?.coverage).toEqual({ perRatio: 3 });

    const neither = toBrief({ ...state, variation: { ...state.variation, perProduct: "0", perRatio: "0" } });
    expect(neither.variation).not.toHaveProperty("coverage");
  });

  test("the headline axis is emitted as a pool reference only when enabled", () => {
    const state = filled({ mode: "variation" });
    expect(toBrief(state).variation?.axes).not.toHaveProperty("headline");
    const on = reduce(state, { type: "toggleHeadline" });
    expect(toBrief(on).variation?.axes).toMatchObject({ headline: HEADLINE_POOL_REF });
  });
});

describe("fromBrief", () => {
  test("without an entry the source stays a new draft", () => {
    expect(fromBrief(savedBrief()).source.kind).toBe("new");
  });

  test("with an entry the source records file, id and revision", () => {
    expect(fromBrief(savedBrief(), { file: "camp.yaml", revision: "r1" }).source).toMatchObject({
      kind: "file",
      file: "camp.yaml",
      loadedId: "camp",
      revision: "r1",
    });
  });

  test("a brief with no products falls back to two blank drafts", () => {
    expect(fromBrief(savedBrief({ products: [] })).products).toHaveLength(2);
  });

  test("loaded products are marked as having a deliberate id", () => {
    expect(fromBrief(savedBrief()).products[0]).toMatchObject({ id: "alpha", idTouched: true });
  });

  test("treatments, mode, formats and platforms default when absent", () => {
    const state = fromBrief(savedBrief());
    expect(state.treatments).toEqual([]);
    expect(state.mode).toBe("brief");
    expect(state.formats).toEqual(["static"]);
    expect(state.platforms).toEqual([...STATIC_PLATFORMS]);
    expect(state.localizedMessage).toBe("");
  });

  test("treatments, mode, output and localizedMessage are carried through when present", () => {
    const state = fromBrief(
      savedBrief({
        mode: "variation",
        localizedMessage: "Hallo",
        treatments: [{ id: "bold-bottom", layout: "headline-bottom", tone: "bold" }],
        output: { formats: ["static", "motion"], platforms: ["linkedin"] },
      } as Partial<CampaignBrief>),
    );
    expect(state.mode).toBe("variation");
    expect(state.localizedMessage).toBe("Hallo");
    expect(state.treatments).toEqual([{ id: "bold-bottom", layout: "headline-bottom", tone: "bold" }]);
    expect(state.formats).toEqual(["static", "motion"]);
    expect(state.platforms).toEqual(["linkedin"]);
  });
});

describe("dirty tracking", () => {
  test("a new draft is always dirty against save", () => {
    expect(isDirtySinceSave(base())).toBe(true);
  });

  test("a file source with no snapshot is dirty against save", () => {
    const state: EditorState = {
      ...base(),
      source: { kind: "file", file: "camp.yaml", loadedId: "camp", savedSnapshot: null, revision: undefined },
    };
    expect(isDirtySinceSave(state)).toBe(true);
  });

  test("a freshly loaded file is clean until it is edited", () => {
    const loaded = reduce(base(), { type: "load", brief: savedBrief(), entry: { file: "camp.yaml" } });
    const saved = reduce(loaded, { type: "save" });
    expect(isDirtySinceSave(saved)).toBe(false);
    expect(isDirtySinceSave(reduce(saved, { type: "patch", patch: { campaignMessage: "Changed" } }))).toBe(true);
  });

  test("dirt against apply follows the applied snapshot", () => {
    const state = { ...base(), briefId: "camp" };
    expect(isDirtySinceApply(state)).toBe(true);
    const applied = reduce(state, { type: "apply" });
    expect(isDirtySinceApply(applied)).toBe(false);
    expect(isDirtySinceApply(reduce(applied, { type: "patch", patch: { campaignMessage: "Changed" } }))).toBe(true);
  });
});

describe("draft storage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  test("the key follows the loaded id for a file and the temp id for a new draft", () => {
    const fresh = base();
    expect(getDraftKey(fresh)).toBe(`cf:draft:${fresh.source.kind === "new" ? fresh.source.tempId : ""}`);
    const loaded = reduce(fresh, { type: "load", brief: savedBrief(), entry: { file: "camp.yaml" } });
    expect(getDraftKey(loaded)).toBe("cf:draft:camp");
  });

  test("a saved draft round-trips and can be purged", () => {
    const state = { ...base(), briefId: "camp" };
    saveDraftToStorage(state);
    expect(loadDraftFromStorage(state)?.briefId).toBe("camp");
    purgeDraftFromStorage(state);
    expect(loadDraftFromStorage(state)).toBeNull();
  });

  test("a corrupt or shapeless entry loads as null rather than throwing", () => {
    const state = { ...base(), briefId: "camp" };
    localStorage.setItem(getDraftKey(state), "{ not json");
    expect(loadDraftFromStorage(state)).toBeNull();
    localStorage.setItem(getDraftKey(state), JSON.stringify({ timestamp: 1 }));
    expect(loadDraftFromStorage(state)).toBeNull();
  });

  test("every storage helper is inert where localStorage is unavailable", () => {
    const state = { ...base(), briefId: "camp" };
    vi.stubGlobal("localStorage", undefined);
    expect(() => saveDraftToStorage(state)).not.toThrow();
    expect(loadDraftFromStorage(state)).toBeNull();
    expect(() => purgeDraftFromStorage(state)).not.toThrow();
  });
});

describe("canPlan", () => {
  const ready = (): EditorState => {
    const state = { ...base(), mode: "variation" as const, briefId: "camp" };
    return reduce(state, { type: "setProduct", key: state.products[0].key, patch: { id: "alpha" } });
  };

  test("is true only for a named randomized brief with a product and a count of at least one", () => {
    expect(canPlan(ready())).toBe(true);
  });

  test("is false for classic mode, a missing id, no product, or a count below one", () => {
    expect(canPlan({ ...ready(), mode: "brief" })).toBe(false);
    expect(canPlan({ ...ready(), briefId: "" })).toBe(false);
    expect(canPlan({ ...ready(), products: [] })).toBe(false);
    const noCount = ready();
    expect(canPlan({ ...noCount, variation: { ...noCount.variation, count: "0" } })).toBe(false);
  });
});

describe("temp ids", () => {
  test("falls back to a time-and-random id where crypto.randomUUID is unavailable", () => {
    const original = globalThis.crypto;
    vi.stubGlobal("crypto", undefined);
    try {
      const a = initialEditorState();
      expect(a.source.kind === "new" && a.source.tempId).toMatch(/^temp-\d+-[a-z0-9]+$/);
    } finally {
      vi.stubGlobal("crypto", original);
      vi.unstubAllGlobals();
    }
  });
});

describe("variation policy round-trip", () => {
  const randomized = {
    id: "camp",
    targetRegion: "DE",
    targetAudience: "a",
    campaignMessage: "Hi",
    products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "l.png" }],
    mode: "variation",
    variation: {
      count: 40,
      seed: 7,
      minDistance: 3,
      coverage: { perProduct: 2, perRatio: 5 },
      axes: {
        layout: ["headline-top"],
        tone: ["subtle"],
        background: { source: ["genai"] },
        paletteShift: [0.2],
        headline: HEADLINE_POOL_REF,
        motion: ["ken-burns-in"],
        duration: [6],
      },
    },
  } as unknown as CampaignBrief;

  test("a loaded randomized brief keeps its policy instead of reverting to defaults", () => {
    const state = fromBrief(randomized, { file: "camp.yaml" });
    expect(state.variation).toMatchObject({
      count: "40",
      seed: "7",
      minDistance: "3",
      perProduct: "2",
      perRatio: "5",
      layout: ["headline-top"],
      tone: ["subtle"],
      background: ["genai"],
      paletteShift: [0.2],
      headline: true,
    });
    expect(state.motion).toEqual(["ken-burns-in"]);
    expect(state.duration).toEqual([6]);
  });

  test("saving it back produces the same policy — no silent rewrite", () => {
    const round = toBrief(fromBrief(randomized, { file: "camp.yaml" }));
    expect(round.variation).toEqual(randomized.variation);
  });

  test("a randomized brief with only a count keeps the optional fields absent", () => {
    const sparse = {
      ...randomized,
      variation: { count: 5, axes: { layout: ["headline-top"], tone: ["bold"], background: { source: ["procedural"] }, paletteShift: [0] } },
    } as unknown as CampaignBrief;
    const state = fromBrief(sparse, { file: "camp.yaml" });
    expect(state.variation).toMatchObject({ count: "5", seed: "", minDistance: "", perProduct: "", perRatio: "" });
    expect(state.motion).toEqual([]);
    expect(toBrief(state).variation).toEqual(sparse.variation);
  });

  test("a classic brief still gets the editor's randomized defaults", () => {
    const state = fromBrief(savedBrief(), { file: "camp.yaml" });
    expect(state.variation).toMatchObject({ count: "12", minDistance: "2", perProduct: "1", perRatio: "1" });
  });
});

describe("restore", () => {
  test("reinstates a recovered draft wholesale", () => {
    const draft = { ...base(), briefId: "recovered", campaignMessage: "from storage" };
    expect(reduce(base(), { type: "restore", state: draft })).toBe(draft);
  });
});

describe("isPristine", () => {
  test("is true for a freshly opened editor and false once anything is typed", () => {
    expect(isPristine(initialEditorState())).toBe(true);
    expect(isPristine(initialEditorState("variation"))).toBe(true);
    expect(isPristine(reduce(base(), { type: "patch", patch: { briefId: "x" } }))).toBe(false);
  });
});
