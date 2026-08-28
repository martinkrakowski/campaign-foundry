import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import type { CampaignBrief, CopyPool } from "@campaignfoundry/CampaignOrchestration";
import {
  LAYOUT_OPTIONS,
  RATIO_OPTIONS,
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
  normalizeDraftState,
  type EditorState,
  type EditorAction,
} from "../editor-state";
import { dumpBrief } from "../../wizard/dump-brief";
import yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";

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
    const a = emptyProduct(1);
    const b = emptyProduct(2);
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

  test("ratio toggles remove a selected canvas and re-add it in canonical order", () => {
    const off = reduce(base(), { type: "toggleRatio", value: "9:16" });
    expect(off.variation.ratio).toEqual(["1:1", "16:9"]);
    const reordered = reduce(off, { type: "toggleRatio", value: "9:16" });
    expect(reordered.variation.ratio).toEqual(["1:1", "9:16", "16:9"]);
    // deselecting down to none is possible (validation flags it, the state keeps it)
    const none = reduce(
      base(),
      { type: "toggleRatio", value: "1:1" },
      { type: "toggleRatio", value: "9:16" },
      { type: "toggleRatio", value: "16:9" },
    );
    expect(none.variation.ratio).toEqual([]);
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

  test("togglePlatform orders motion platforms after the static ones", () => {
    const state = reduce(
      { ...base(), platforms: ["instagram-feed"] },
      { type: "togglePlatform", value: "tiktok" },
      { type: "togglePlatform", value: "linkedin" },
    );
    expect(state.platforms).toEqual(["instagram-feed", "linkedin", "tiktok"]);
    expect(reduce(state, { type: "togglePlatform", value: "linkedin" }).platforms).toEqual(["instagram-feed", "tiktok"]);
  });
});

describe("editorReducer — motion, duration and formats", () => {
  test("toggleMotion adds then removes", () => {
    const on = reduce(base(), { type: "toggleMotion", value: "ken-burns-in" });
    expect(on.motion).toEqual(["ken-burns-in"]);
    expect(reduce(on, { type: "toggleMotion", value: "ken-burns-in" }).motion).toEqual([]);
  });

  test("duration is appended, written by index and removed by index", () => {
    // each Add offers a length the list does not already hold — the planner
    // de-duplicates this axis, so a repeat would draw nothing
    const added = reduce(base(), { type: "addDuration" }, { type: "addDuration" });
    expect(added.duration).toEqual([5, 2]);
    const set = reduce(added, { type: "setDuration", index: 1, value: 8 });
    expect(set.duration).toEqual([5, 8]);
    expect(reduce(set, { type: "removeDuration", index: 0 }).duration).toEqual([8]);
  });

  test("Add duration never offers a length already in the list", () => {
    let state = base();
    for (let i = 0; i < 8; i += 1) state = reduce(state, { type: "addDuration" });
    expect(new Set(state.duration).size).toBe(state.duration.length);
    expect(state.duration.every((s) => Number.isInteger(s) && s >= 2 && s <= 30)).toBe(true);
  });

  test("Add duration is a no-op once every length is taken", () => {
    const full = Array.from({ length: 29 }, (_, i) => i + 2); // 2..30
    const state = { ...base(), duration: full };
    expect(reduce(state, { type: "addDuration" })).toBe(state);
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

  test("apply records the brief handed to it, not the state at dispatch time", () => {
    const state = { ...base(), briefId: "camp" };
    // Save & apply awaits the network before dispatching, so the draft may have moved
    // on; the run holds the pre-await brief and the snapshot must match it
    const applied = toBrief(state);
    const edited = reduce(state, { type: "patch", patch: { campaignMessage: "typed during save" } });
    const next = reduce(edited, { type: "apply", applied });

    expect(next.appliedSnapshot).toEqual(applied);
    // the edit made mid-request is therefore still unapplied, which is the truth
    expect(isDirtySinceApply(next)).toBe(true);
  });

  test("apply falls back to the current draft when handed nothing", () => {
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

  test("the ratio axis is emitted only when the selection constrains", () => {
    const state = filled({ mode: "variation" });
    // a full selection is the default (absent → every ratio): no key, byte-stable
    expect(toBrief(state).variation?.axes).not.toHaveProperty("ratio");
    const narrowed = reduce(state, { type: "toggleRatio", value: "9:16" });
    expect(toBrief(narrowed).variation?.axes).toMatchObject({ ratio: ["1:1", "16:9"] });
    // re-selecting the full set drops the key again — it no longer constrains
    const restored = reduce(narrowed, { type: "toggleRatio", value: "9:16" });
    expect(toBrief(restored).variation?.axes).not.toHaveProperty("ratio");
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

  test("a pre-#85 draft with no ratio axis restores instead of crashing toBrief", () => {
    // The exact regression: an older build's draft.state has no `variation.ratio`
    // key at all (JSON.stringify never wrote one, because the field did not exist
    // yet). toBrief's `state.variation.ratio.length` throws on an unnormalized
    // restore — this proves the load path itself, not just the reducer.
    const state = { ...base(), briefId: "camp" };
    const legacyVariation: Record<string, unknown> = { ...state.variation };
    delete legacyVariation.ratio;
    const legacyDraft = { ...state, variation: legacyVariation };
    localStorage.setItem(getDraftKey(state), JSON.stringify({ state: legacyDraft, timestamp: 1 }));

    const restored = loadDraftFromStorage(state);
    expect(restored).not.toBeNull();
    // Absent means every ratio — the same semantics toBrief already gives an
    // absent `axes.ratio` on the brief itself.
    expect(restored?.variation.ratio).toEqual([...RATIO_OPTIONS]);
    expect(() => toBrief(restored as EditorState)).not.toThrow();
  });

  test("a draft missing an entire top-level field (not just a variation key) still restores", () => {
    const state = { ...base(), briefId: "camp", campaignMessage: "hi" };
    const legacy: Record<string, unknown> = { ...state };
    delete legacy.headlineAxisDropped;
    localStorage.setItem(getDraftKey(state), JSON.stringify({ state: legacy, timestamp: 1 }));

    const restored = loadDraftFromStorage(state);
    expect(restored?.headlineAxisDropped).toBe(false);
    // What the draft actually specified still wins over the default.
    expect(restored?.campaignMessage).toBe("hi");
  });

  test("normalization never overrides a key the draft actually set", () => {
    const state = { ...base(), briefId: "camp" };
    const draft = { ...state, variation: { ...state.variation, ratio: ["9:16"] }, formats: ["motion"] };
    localStorage.setItem(getDraftKey(state), JSON.stringify({ state: draft, timestamp: 1 }));

    const restored = loadDraftFromStorage(state);
    expect(restored?.variation.ratio).toEqual(["9:16"]);
    expect(restored?.formats).toEqual(["motion"]);
  });

  test("a draft whose mode the old build never wrote still resolves to a valid mode", () => {
    const state = { ...base(), briefId: "camp" };
    const legacy: Record<string, unknown> = { ...state };
    delete legacy.mode;
    localStorage.setItem(getDraftKey(state), JSON.stringify({ state: legacy, timestamp: 1 }));
    expect(loadDraftFromStorage(state)?.mode).toBe("brief");
  });

  test("a variation value that is present but not an object falls back to the default shape", () => {
    const state = { ...base(), briefId: "camp" };
    const corrupt = { ...state, variation: null };
    localStorage.setItem(getDraftKey(state), JSON.stringify({ state: corrupt, timestamp: 1 }));
    expect(loadDraftFromStorage(state)?.variation).toEqual(base().variation);
  });

  test("a present mode survives, and an invalid one falls back to brief instead of leaking", () => {
    const state = { ...base(), briefId: "camp" };
    const store = (mode: unknown) =>
      localStorage.setItem(getDraftKey(state), JSON.stringify({ state: { ...state, mode }, timestamp: 1 }));
    // The first cut of normalizeDraftState validated mode but then let the raw
    // spread overwrite it: a garbage string restored verbatim. Both legal values
    // must round-trip and every other value must collapse to the default.
    store("variation");
    expect(loadDraftFromStorage(state)?.mode).toBe("variation");
    store("brief");
    expect(loadDraftFromStorage(state)?.mode).toBe("brief");
    store("totally-not-a-real-mode");
    expect(loadDraftFromStorage(state)?.mode).toBe("brief");
    store(null);
    expect(loadDraftFromStorage(state)?.mode).toBe("brief");
  });

  test("a wrong-typed list is repaired, so the reducer cannot later call .filter on a string", () => {
    const state = { ...base(), briefId: "camp" };
    const corrupt = {
      ...state,
      formats: "motion",
      variation: { ...state.variation, ratio: "9:16", layout: 42 },
    };
    localStorage.setItem(getDraftKey(state), JSON.stringify({ state: corrupt, timestamp: 1 }));
    const restored = loadDraftFromStorage(state) as EditorState;
    expect(restored.variation.ratio).toEqual([...RATIO_OPTIONS]);
    expect(restored.variation.layout).toEqual([...LAYOUT_OPTIONS]);
    expect(restored.formats).toEqual(["static"]);
    // toggleOrdered runs `.includes` and `.filter` on the list — the failure the
    // unrepaired string would have produced on the user's next click.
    expect(() => reduce(restored, { type: "toggleRatio", value: "1:1" })).not.toThrow();
    expect(reduce(restored, { type: "toggleRatio", value: "1:1" }).variation.ratio).toEqual(["9:16", "16:9"]);
  });

  test("every other repaired field takes its default when the draft's value is not its type", () => {
    const state = { ...base(), briefId: "camp", campaignMessage: "kept" };
    const corrupt = {
      ...state,
      source: null,
      products: "not a list",
      treatments: { id: "t" },
      motion: "ken-burns-in",
      duration: 5,
      platforms: null,
      // 7, not 12: the default is "12", so a coerced String(12) would pass by accident
      variation: { ...state.variation, headline: "yes", count: 7 },
    };
    localStorage.setItem(getDraftKey(state), JSON.stringify({ state: corrupt, timestamp: 1 }));
    const restored = loadDraftFromStorage(state) as EditorState;
    expect(restored.source.kind).toBe("new");
    expect(restored.products).toHaveLength(2);
    expect(restored.treatments).toEqual([]);
    expect(restored.motion).toEqual([]);
    expect(restored.duration).toEqual([]);
    expect(restored.platforms).toEqual(base().platforms);
    expect(restored.variation.headline).toBe(false);
    expect(restored.variation.count).toBe("12");
    // and a valid value beside them is untouched
    expect(restored.campaignMessage).toBe("kept");
    // the repaired draft is a complete EditorState: every consumer of it works
    expect(() => toBrief(restored)).not.toThrow();
    expect(() => getDraftKey(restored)).not.toThrow();
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

  test("a requested ratio subset round-trips, and a brief without the axis keeps every ratio", () => {
    const policy = randomized.variation as { axes: Record<string, unknown> };
    const selected = {
      ...randomized,
      variation: { ...policy, axes: { ...policy.axes, ratio: ["1:1", "16:9"] } },
    } as unknown as CampaignBrief;
    const state = fromBrief(selected, { file: "camp.yaml" });
    expect(state.variation.ratio).toEqual(["1:1", "16:9"]);
    expect(toBrief(state).variation?.axes).toMatchObject({ ratio: ["1:1", "16:9"] });
    // no key → all three selected, and saving back stays key-free
    const plain = fromBrief(randomized, { file: "camp.yaml" });
    expect(plain.variation.ratio).toEqual(["1:1", "9:16", "16:9"]);
    expect(toBrief(plain).variation?.axes).not.toHaveProperty("ratio");
  });
});

describe("restore", () => {
  test("reinstates a recovered draft", () => {
    const draft = { ...base(), briefId: "recovered", campaignMessage: "from storage" };
    expect(reduce(base(), { type: "restore", state: draft })).toMatchObject({
      briefId: "recovered",
      campaignMessage: "from storage",
    });
  });

  test("keeps the probe's verdict rather than the draft's stale one", () => {
    const probed = { ...base(), capabilities: { motion: false, reason: "no ffmpeg" } };
    // the draft was persisted before the probe answered
    const draft = { ...base(), briefId: "recovered", capabilities: null };
    expect(reduce(probed, { type: "restore", state: draft })).toMatchObject({
      briefId: "recovered",
      capabilities: { motion: false, reason: "no ffmpeg" },
    });
  });

  test("takes the draft's verdict when this session has none", () => {
    const draft = { ...base(), capabilities: { motion: true } };
    expect(reduce(base(), { type: "restore", state: draft }).capabilities).toEqual({ motion: true });
  });
});

describe("isPristine", () => {
  test("is true for a freshly opened editor and false once anything is typed", () => {
    expect(isPristine(initialEditorState())).toBe(true);
    expect(isPristine(initialEditorState("variation"))).toBe(true);
    expect(isPristine(reduce(base(), { type: "patch", patch: { briefId: "x" } }))).toBe(false);
  });
});

describe("deterministic product keys (D16)", () => {
  test("fromBrief of a 3-product brief yields keys 1, 2, 3 and counter 4", () => {
    const brief = savedBrief({
      products: [
        { id: "a", name: "A", primaryColor: "#000", logoPath: "" },
        { id: "b", name: "B", primaryColor: "#111", logoPath: "" },
        { id: "c", name: "C", primaryColor: "#222", logoPath: "" },
      ],
    });
    const state = fromBrief(brief);
    expect(state.products.map((p) => p.key)).toEqual([1, 2, 3]);
    expect(state.nextProductKey).toBe(4);
  });

  test("fromBrief called twice yields identical keys (no Date.now)", () => {
    const brief = savedBrief({
      products: [{ id: "a", name: "A", primaryColor: "#000", logoPath: "" }],
    });
    const state1 = fromBrief(brief);
    const state2 = fromBrief(brief);
    expect(state1.products[0].key).toBe(state2.products[0].key);
    expect(state1.nextProductKey).toBe(state2.nextProductKey);
  });

  test("a restored 5-product draft without counter gets nextProductKey = 6", () => {
    const state = { ...base(), products: [emptyProduct(1), emptyProduct(2), emptyProduct(3), emptyProduct(4), emptyProduct(5)] };
    const raw = { ...state, nextProductKey: undefined };
    delete (raw as Record<string, unknown>).nextProductKey;
    const normalized = normalizeDraftState(raw as unknown as Record<string, unknown>);
    expect(normalized.nextProductKey).toBe(6);
  });

  test("a restored draft with stored counter of 42 keeps 42", () => {
    const state = { ...base(), products: [emptyProduct(1)], nextProductKey: 42 };
    const normalized = normalizeDraftState(state as unknown as Record<string, unknown>);
    expect(normalized.nextProductKey).toBe(42);
  });

  test("a restored draft with no products gets nextProductKey = 1", () => {
    const raw = { products: [] as never[], nextProductKey: undefined };
    const normalized = normalizeDraftState(raw as unknown as Record<string, unknown>);
    expect(normalized.nextProductKey).toBe(1);
  });

  test("addProduct after fromBrief uses deterministic counter", () => {
    const brief = savedBrief({
      products: [
        { id: "a", name: "A", primaryColor: "#000", logoPath: "" },
        { id: "b", name: "B", primaryColor: "#111", logoPath: "" },
      ],
    });
    const state = fromBrief(brief);
    const withAdded = reduce(state, { type: "addProduct" });
    expect(withAdded.products).toHaveLength(3);
    expect(withAdded.products[2].key).toBe(3);
    expect(withAdded.nextProductKey).toBe(4);
  });

  test("toBrief output contains no key or nextProductKey", () => {
    const state = base();
    const brief = savedBrief({
      products: [{ id: "a", name: "A", primaryColor: "#000", logoPath: "" }],
    });
    const stateWithProduct = fromBrief(brief);
    const roundTripped = toBrief(stateWithProduct);
    const serialised = JSON.stringify(roundTripped);
    expect(serialised).not.toContain('"key"');
    expect(serialised).not.toContain('"nextProductKey"');
  });

  test("removeProduct removes exactly one by key", () => {
    const state = fromBrief(savedBrief({
      products: [
        { id: "a", name: "A", primaryColor: "#000", logoPath: "" },
        { id: "b", name: "B", primaryColor: "#111", logoPath: "" },
        { id: "c", name: "C", primaryColor: "#222", logoPath: "" },
        { id: "d", name: "D", primaryColor: "#333", logoPath: "" },
        { id: "e", name: "E", primaryColor: "#444", logoPath: "" },
      ],
    }));
    const removed = reduce(state, { type: "removeProduct", key: 3 });
    expect(removed.products).toHaveLength(4);
    expect(removed.products.map((p) => p.key)).not.toContain(3);
    expect(removed.products.map((p) => p.key)).toEqual([1, 2, 4, 5]);
  });
});

describe("whole-corpus round-trip", () => {
  const briefDir = path.join(process.cwd(), "briefs");
  const files = fs.readdirSync(briefDir).filter((f) => f.endsWith(".yaml"));

  test.each(files)("%s round-trips fromBrief → toBrief → serialise byte-for-byte", (file) => {
    const filePath = path.join(briefDir, file);
    const yamlText = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(yamlText) as CampaignBrief;
    const entry = { file, revision: undefined as unknown as undefined };
    const state = fromBrief(parsed, entry);
    const roundTrippedBrief = toBrief(state);
    const originalSerialised = dumpBrief(parsed);
    const roundTrippedSerialised = dumpBrief(roundTrippedBrief);
    expect(roundTrippedSerialised).toBe(originalSerialised);
  });
});
