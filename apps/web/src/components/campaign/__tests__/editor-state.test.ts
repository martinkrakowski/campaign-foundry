import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import type { CampaignBrief, CopyPool } from "@campaignfoundry/CampaignOrchestration";
import { timelineProblem } from "@campaignfoundry/CampaignOrchestration/copy-timeline";
import { axisProductSize } from "../validate";
import { platformsToFormats } from "../derive";
import {
  BACKGROUND_OPTIONS,
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
  motionPackagedRatios,
  DEFAULT_DURATION_SEC,
  MAX_BEATS,
  MAX_WEIGHT,
  type EditorState,
  type EditorAction,
} from "../editor-state";
import { dumpBrief } from "../dump-brief";
import { load } from "js-yaml";
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
  test("defaults to brief mode with one blank product and every static platform", () => {
    const state = initialEditorState();
    expect(state.mode).toBe("brief");
    expect(state.source.kind).toBe("new");
    expect(state.campaignName).toBe("");
    expect(state.briefId).toBe("");
    expect(state.products).toHaveLength(1);
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

  test("patching campaignName on a new draft derives briefId via slugify", () => {
    const next = reduce(base(), { type: "patch", patch: { campaignName: "Summer Launch 2026!" } });
    expect(next.campaignName).toBe("Summer Launch 2026!");
    expect(next.briefId).toBe("summer-launch-2026");
  });

  test("patching campaignName on a file-loaded draft does not re-derive briefId", () => {
    const fileState = fromBrief(savedBrief({ id: "original-id" }), { file: "original-id.yaml" });
    const next = reduce(fileState, { type: "patch", patch: { campaignName: "Renamed Campaign" } });
    expect(next.campaignName).toBe("Renamed Campaign");
    expect(next.briefId).toBe("original-id");
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
    const state = { ...base(), products: [emptyProduct(1), emptyProduct(2)] };
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
    expect(added.products).toHaveLength(2);
    const removed = reduce(added, { type: "removeProduct", key: added.products[1].key });
    expect(removed.products).toHaveLength(1);
    expect(removed.products.map((p) => p.key)).not.toContain(added.products[1].key);
  });

  test("addProduct picks the next unused swatch from SWATCH_PALETTE and wraps around", () => {
    let state = base(); // key 1 has #1473E6 (index 0)
    for (let i = 1; i < 8; i++) {
      state = reduce(state, { type: "addProduct" });
    }
    expect(state.products).toHaveLength(8);
    // All 8 swatches used; 9th product wraps around
    const ninth = reduce(state, { type: "addProduct" });
    expect(ninth.products).toHaveLength(9);
    expect(ninth.products[8].primaryColor).toBe("#1473E6");
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
    // outputExplicit is reserved for briefs that declared `output` on load; a bare
    // toggle no longer sets it, so a toggle back to the default round-trips clean.
    expect(off.outputExplicit).toBe(false);
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
    // de-duplicates this axis, so a repeat would draw nothing. The first offer is
    // the domain's DEFAULT_DURATION_SEC; the next free second is the smallest in range.
    const added = reduce(base(), { type: "addDuration" }, { type: "addDuration" });
    expect(added.duration).toEqual([DEFAULT_DURATION_SEC, 2]);
    const set = reduce(added, { type: "setDuration", index: 1, value: 8 });
    expect(set.duration).toEqual([DEFAULT_DURATION_SEC, 8]);
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
    // see togglePlatform: toggling never sets outputExplicit on its own
    expect(on.outputExplicit).toBe(false);
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

  test("mode and output are omitted when they equal the absent-key defaults", () => {
    // absent mode means classic and absent output means the static pipeline —
    // writing them would grow every classic brief on save and read a freshly
    // loaded file back as dirty (its snapshot carries no such keys)
    const brief = toBrief(filled());
    expect(brief).not.toHaveProperty("mode");
    expect(brief).not.toHaveProperty("output");
  });

  test("a variation mode and a diverging output are written", () => {
    expect(toBrief(filled({ mode: "variation" })).mode).toBe("variation");
    const motion = toBrief(filled({ formats: ["static", "motion"] }));
    expect(motion.output).toEqual({ formats: ["static", "motion"], platforms: [...STATIC_PLATFORMS] });
  });

  test("an output the loaded brief declared stays written even at default values", () => {
    const declared = fromBrief(
      savedBrief({ output: { formats: ["static"], platforms: [...STATIC_PLATFORMS] } }),
      { file: "camp.yaml" },
    );
    expect(toBrief(declared).output).toEqual({ formats: ["static"], platforms: [...STATIC_PLATFORMS] });
  });

  test("an output the user has toggled on then off back to default is omitted", () => {
    // A toggle that leaves the output back at the absent-key default must not force
    // an `output` block, otherwise a save after the toggle would grow the brief and
    // read the saved file back as dirty — the corpus round-trip is a merge gate.
    const toggled = reduce(
      filled(),
      { type: "toggleFormat", value: "motion" },
      { type: "toggleFormat", value: "motion" },
    );
    expect(toBrief(toggled).output).toBeUndefined();
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

  test("a brief with no products falls back to one blank draft", () => {
    expect(fromBrief(savedBrief({ products: [] })).products).toHaveLength(1);
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

  test("an unusable product entry is replaced, not dereferenced, so the draft survives", () => {
    // Reading `.key` off a null entry throws inside loadDraftFromStorage's try/catch,
    // which returns null — the user loses every recovered edit because one entry was junk.
    const state = { ...base(), briefId: "camp" };
    const draft = {
      ...state,
      products: [null, "not-a-product", { ...state.products[0], key: 7 }],
      nextProductKey: 8,
    };
    localStorage.setItem(getDraftKey(state), JSON.stringify({ state: draft, timestamp: 1 }));

    const restored = loadDraftFromStorage(state);
    expect(restored).not.toBeNull();
    const products = (restored as EditorState).products;
    expect(products).toHaveLength(3);
    expect(products.map((p) => p.key)).toEqual([1, 2, 7]);
    expect(products[0].name).toBe("");
    expect(products[2].key).toBe(7);
    // and the counter still outlives every key
    expect((restored as EditorState).nextProductKey).toBe(8);
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
    expect(restored.products).toHaveLength(1);
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

  test("a restored draft with a stale counter below the highest key clamps to maxKey + 1", () => {
    const state = {
      ...base(),
      products: [emptyProduct(1), emptyProduct(2), emptyProduct(3), emptyProduct(4), emptyProduct(5)],
      nextProductKey: 3,
    };
    const normalized = normalizeDraftState(state as unknown as Record<string, unknown>);
    expect(normalized.nextProductKey).toBe(6);
  });

  test("addProduct after a stale-counter restore cannot mint an existing key", () => {
    const restored = normalizeDraftState({
      ...base(),
      products: [emptyProduct(1), emptyProduct(2), emptyProduct(3), emptyProduct(4), emptyProduct(5)],
      nextProductKey: 3,
    } as unknown as Record<string, unknown>);
    const added = reduce(restored, { type: "addProduct" });
    expect(added.products.map((p) => p.key)).toEqual([1, 2, 3, 4, 5, 6]);
    const removed = reduce(added, { type: "removeProduct", key: 6 });
    expect(removed.products).toHaveLength(5);
  });

  test("a restored draft with invalid product keys repairs them to their position", () => {
    const raw = {
      ...base(),
      products: [
        { ...emptyProduct(1), id: "a" },
        { ...emptyProduct(0), id: "b" },
        { ...emptyProduct(1), id: "c", key: "not-a-number" },
      ],
    };
    const normalized = normalizeDraftState(raw as unknown as Record<string, unknown>);
    expect(normalized.products.map((p) => p.key)).toEqual([1, 2, 3]);
  });

  test("a restored draft with no products gets nextProductKey = 1", () => {
    const raw = { products: [] as never[], nextProductKey: undefined };
    const normalized = normalizeDraftState(raw as unknown as Record<string, unknown>);
    expect(normalized.nextProductKey).toBe(1);
  });

  test("a restored draft keeps its explicit-mode flag, and a wrong-typed one is repaired", () => {
    const kept = normalizeDraftState({ ...base(), modeExplicit: true } as unknown as Record<string, unknown>);
    expect(kept.modeExplicit).toBe(true);
    const repaired = normalizeDraftState({ ...base(), modeExplicit: "yes" } as unknown as Record<string, unknown>);
    expect(repaired.modeExplicit).toBe(false);
  });

  test("a restored draft keeps its explicit-output flag, and a wrong-typed one is repaired", () => {
    const kept = normalizeDraftState({ ...base(), outputExplicit: true } as unknown as Record<string, unknown>);
    expect(kept.outputExplicit).toBe(true);
    const repaired = normalizeDraftState({ ...base(), outputExplicit: "yes" } as unknown as Record<string, unknown>);
    expect(repaired.outputExplicit).toBe(false);
  });

  test("a legacy restored draft without campaignName backfills campaignName from briefId", () => {
    const raw = { briefId: "legacy-brief-slug", products: [] as never[] };
    const normalized = normalizeDraftState(raw as unknown as Record<string, unknown>);
    expect(normalized.campaignName).toBe("legacy-brief-slug");
    expect(normalized.briefId).toBe("legacy-brief-slug");
  });

  test("a restored draft with explicit campaignName preserves it", () => {
    const raw = { briefId: "my-slug", campaignName: "My Campaign", products: [] as never[] };
    const normalized = normalizeDraftState(raw as unknown as Record<string, unknown>);
    expect(normalized.campaignName).toBe("My Campaign");
    expect(normalized.briefId).toBe("my-slug");
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
    const parsed = load(yamlText) as CampaignBrief;
    const entry = { file, revision: undefined as unknown as undefined };
    const state = fromBrief(parsed, entry);
    const roundTrippedBrief = toBrief(state);
    const originalSerialised = dumpBrief(parsed);
    const roundTrippedSerialised = dumpBrief(roundTrippedBrief);
    expect(roundTrippedSerialised).toBe(originalSerialised);
  });
});

describe("mode fidelity across a load → save round trip", () => {
  const classic = (over: Partial<CampaignBrief> = {}): CampaignBrief =>
    ({
      id: "camp",
      targetRegion: "DE",
      targetAudience: "a",
      campaignMessage: "Hi",
      products: [{ id: "p", name: "P", primaryColor: "#FF7A00", logoPath: "assets/p.png" }],
      ...over,
    }) as CampaignBrief;
  const entry = { file: "camp.yaml", revision: undefined as unknown as undefined };
  const trip = (brief: CampaignBrief) => toBrief(fromBrief(brief, entry));

  test("a brief that spells out the default mode keeps it", () => {
    // `mode: brief` is redundant — its absence means the same thing — but a file that
    // wrote it must come back holding it, or saving silently rewrites the author's file.
    expect(trip(classic({ mode: "brief" })).mode).toBe("brief");
  });

  test("a brief that omits mode still omits it", () => {
    expect("mode" in trip(classic())).toBe(false);
  });

  test("a variation brief keeps its mode without needing the flag", () => {
    expect(trip(classic({ mode: "variation" })).mode).toBe("variation");
  });

  test("switching a loaded variation brief back to classic omits mode, as the default does", () => {
    // The toggle-on→off rule `output` follows: returning to the default must serialise
    // like the default, so a variation → brief → variation cycle is byte-identical.
    const loaded = fromBrief(classic({ mode: "variation" }), entry);
    const switched = reduce(loaded, { type: "setMode", mode: "brief" });
    expect("mode" in toBrief(switched)).toBe(false);
  });

  test("switching a file that spelled out the default to variation writes variation", () => {
    const loaded = fromBrief(classic({ mode: "brief" }), entry);
    const switched = reduce(loaded, { type: "setMode", mode: "variation" });
    expect(toBrief(switched).mode).toBe("variation");
  });
});

describe("the count clamp and its one-time notice", () => {
  const variation = (): EditorState => ({ ...initialEditorState(), mode: "variation", briefId: "camp" });

  test("narrowing an axis below the count lowers the count and says so, once", () => {
    const start = variation();
    const ceiling = axisProductSize(start);
    const atCeiling = editorReducer(start, { type: "setVariation", field: "count", value: String(ceiling) });
    expect(atCeiling.countNotice).toBeNull();

    // half the layouts go, so half the combinations do: the count cannot stand
    const narrowed = editorReducer(atCeiling, { type: "toggleLayout", value: LAYOUT_OPTIONS[0] });
    const lowered = axisProductSize(narrowed);
    expect(lowered).toBeLessThan(ceiling);
    expect(narrowed.variation.count).toBe(String(lowered));
    expect(narrowed.countNotice).toBe(lowered);
  });

  test("a count that still fits is left alone, and clears a standing notice", () => {
    const start = variation();
    const narrowed = editorReducer(
      editorReducer(start, { type: "setVariation", field: "count", value: String(axisProductSize(start)) }),
      { type: "toggleLayout", value: LAYOUT_OPTIONS[0] },
    );
    expect(narrowed.countNotice).not.toBeNull();

    // widening it back leaves the (now small) count alone and takes the notice down
    const widened = editorReducer(narrowed, { type: "toggleLayout", value: LAYOUT_OPTIONS[0] });
    expect(widened.countNotice).toBeNull();
    expect(widened.variation.count).toBe(narrowed.variation.count);
  });

  test("setting the count by hand answers the notice", () => {
    const noticed = editorReducer(
      editorReducer(variation(), { type: "setVariation", field: "count", value: String(axisProductSize(variation())) }),
      { type: "toggleLayout", value: LAYOUT_OPTIONS[0] },
    );
    expect(noticed.countNotice).not.toBeNull();

    const answered = editorReducer(noticed, { type: "setVariation", field: "count", value: "3" });
    expect(answered.countNotice).toBeNull();
    expect(answered.variation.count).toBe("3");
  });

  test("the notice is said once: the next thing the user does takes it down", () => {
    const noticed = editorReducer(
      editorReducer(variation(), { type: "setVariation", field: "count", value: String(axisProductSize(variation())) }),
      { type: "toggleLayout", value: LAYOUT_OPTIONS[0] },
    );
    expect(noticed.countNotice).not.toBeNull();

    const seeded = editorReducer(noticed, { type: "setVariation", field: "seed", value: "42" });
    expect(seeded.countNotice).toBeNull();
    expect(seeded.variation.seed).toBe("42");
    // and the count it was lowered to stands — the notice going does not undo the clamp
    expect(seeded.variation.count).toBe(noticed.variation.count);
  });

  test("every axis that shrinks the ceiling clamps, not just layout and tone", () => {
    const atCeiling = (s: EditorState) =>
      editorReducer(s, { type: "setVariation", field: "count", value: String(axisProductSize(s)) });

    // a ratio: the planner would have refused this policy before, rather than the
    // editor lowering the count for it
    const ratioed = editorReducer(atCeiling(variation()), { type: "toggleRatio", value: RATIO_OPTIONS[0] });
    expect(Number(ratioed.variation.count)).toBe(axisProductSize(ratioed));
    expect(ratioed.countNotice).toBe(axisProductSize(ratioed));

    // and a product, which is not a variation axis at all
    const twoProducts = { ...variation(), products: [emptyProduct(1), emptyProduct(2)] };
    const named = editorReducer(
      editorReducer(twoProducts, { type: "setProduct", key: 1, patch: { id: "alpha" } }),
      { type: "setProduct", key: 2, patch: { id: "beta" } },
    );
    const dropped = editorReducer(atCeiling(named), { type: "removeProduct", key: 2 });
    expect(Number(dropped.variation.count)).toBe(axisProductSize(dropped));
  });

  test("the last background and the last palette shift hold, like every other axis", () => {
    let s = variation();
    for (const option of BACKGROUND_OPTIONS.filter((o) => s.variation.background.includes(o)).slice(0, -1)) {
      s = editorReducer(s, { type: "toggleBackground", value: option });
    }
    const lastBackground = s.variation.background;
    expect(lastBackground.length).toBe(1);
    expect(editorReducer(s, { type: "toggleBackground", value: lastBackground[0] })).toBe(s);

    for (const shift of s.variation.paletteShift.slice(0, -1)) {
      s = editorReducer(s, { type: "togglePalette", value: shift });
    }
    const lastShift = s.variation.paletteShift;
    expect(lastShift.length).toBe(1);
    expect(editorReducer(s, { type: "togglePalette", value: lastShift[0] })).toBe(s);
  });
});

describe("the axis min-one guard", () => {
  const variation = (): EditorState => ({ ...initialEditorState(), mode: "variation", briefId: "camp" });

  test("the last tone stays selected, exactly as the last layout does", () => {
    const oneTone = editorReducer(variation(), { type: "toggleTone", value: TONE_OPTIONS[0] });
    expect(oneTone.variation.tone).toEqual([TONE_OPTIONS[1]]);

    const refused = editorReducer(oneTone, { type: "toggleTone", value: TONE_OPTIONS[1] });
    expect(refused).toBe(oneTone);
  });

  test("a count that is not a number at all counts as zero, so nothing is clamped", () => {
    const blank = { ...variation(), variation: { ...variation().variation, count: "" } };
    const narrowed = editorReducer(blank, { type: "toggleLayout", value: LAYOUT_OPTIONS[0] });
    // 0 is never above the ceiling, so the count is left as the user typed it
    expect(narrowed.variation.count).toBe("");
    expect(narrowed.countNotice).toBeNull();
  });
});

describe("a campaign name the slug throws away is still work", () => {
  test("a name of only stripped characters is not pristine", () => {
    // "!!!" slugs to "", so the brief is byte-identical to a blank one. Comparing briefs
    // alone would call this pristine — the draft would not be autosaved and leaving would
    // not prompt, so the name the user typed would disappear without a word.
    const typed = editorReducer(initialEditorState(), { type: "patch", patch: { campaignName: "!!!" } });
    expect(typed.briefId).toBe("");
    expect(JSON.stringify(toBrief(typed))).toBe(JSON.stringify(toBrief(initialEditorState())));
    expect(isPristine(typed)).toBe(false);
  });

  test("an untouched editor is still pristine", () => {
    expect(isPristine(initialEditorState())).toBe(true);
  });
});

describe("L4.1 Whole-corpus round-trip tests (D7)", () => {
  const briefsDir = path.resolve(__dirname, "../../../../../../briefs");
  const yamlFiles = fs.readdirSync(briefsDir).filter((f) => f.endsWith(".yaml"));

  test("discovers all corpus YAML files on disk", () => {
    expect(yamlFiles.length).toBeGreaterThanOrEqual(7);
  });

  test.each(yamlFiles)(
    "round-trips %s byte-identically after a platform toggle on→off (policy, format, ratio and axisProductSize all unchanged)",
    (filename) => {
      const rawYaml = fs.readFileSync(path.join(briefsDir, filename), "utf8");
      const loadedBrief = load(rawYaml) as CampaignBrief;
      const state = fromBrief(loadedBrief, { file: filename });

      const serialized = toBrief(state);
      expect(serialized).toMatchObject({ id: loadedBrief.id });

      // A platform toggle must not clobber a stored format/ratio divergence, and
      // toggling on then off must leave the brief deep-equal to the original. The
      // API `dumpBrief` is deterministic (fixed key order, no refs), so deep
      // equality of `toBrief` objects means the saved bytes are identical too —
      // which in turn keeps `policyHash` and `axisProductSize` stable (D7/D9).
      const testPlatform = state.platforms.includes("tiktok") ? "x" : "tiktok";
      const toggled = reduce(state, { type: "togglePlatform", value: testPlatform });
      const untoggled = reduce(toggled, { type: "togglePlatform", value: testPlatform });

      const roundTripped = toBrief(untoggled);
      expect(roundTripped).toEqual(serialized);
      expect(roundTripped.id).toBe(loadedBrief.id);
      expect(axisProductSize(untoggled)).toBe(axisProductSize(state));
    },
  );

  test("synthetic fixture 1: stored formats override", () => {
    const briefWithCustomFormats: CampaignBrief = {
      ...savedBrief(),
      output: { formats: ["motion"], platforms: ["instagram-feed"] },
    };
    const state = fromBrief(briefWithCustomFormats);
    expect(state.formatsOverridden).toBe(true);
    expect(state.formats).toEqual(["motion"]);

    // Toggling a platform does NOT overwrite formats
    const toggled = reduce(state, { type: "togglePlatform", value: "linkedin" });
    expect(toggled.formats).toEqual(["motion"]);
    const untoggled = reduce(toggled, { type: "togglePlatform", value: "linkedin" });
    expect(untoggled.formats).toEqual(["motion"]);
  });

  test("synthetic fixture 2: stored ratio override", () => {
    const briefWithCustomRatio: CampaignBrief = {
      ...savedBrief(),
      mode: "variation",
      variation: {
        count: 4,
        axes: {
          layout: ["headline-top"],
          tone: ["bold"],
          ratio: ["1:1"],
          background: { source: ["procedural"] },
          paletteShift: [0],
        },
      } as unknown as CampaignBrief["variation"],
      output: { formats: ["static"], platforms: ["instagram-feed", "x"] },
    };
    const state = fromBrief(briefWithCustomRatio);
    expect(state.ratioOverridden).toBe(true);
    expect(state.variation.ratio).toEqual(["1:1"]);

    // Toggling a platform does NOT overwrite ratios
    const toggled = reduce(state, { type: "togglePlatform", value: "linkedin" });
    expect(toggled.variation.ratio).toEqual(["1:1"]);
    const untoggled = reduce(toggled, { type: "togglePlatform", value: "linkedin" });
    expect(untoggled.variation.ratio).toEqual(["1:1"]);
  });

  test("synthetic fixture 3: absent-key case (no output or ratio declared)", () => {
    const briefAbsent: CampaignBrief = {
      ...savedBrief(),
      mode: "variation",
      variation: {
        count: 4,
        axes: {
          layout: ["headline-top"],
          tone: ["bold"],
          background: { source: ["procedural"] },
          paletteShift: [0],
        },
      } as unknown as CampaignBrief["variation"],
    };
    const state = fromBrief(briefAbsent);
    // absent axes.ratio means all 3 ratios in domain, which differs from static platforms (2 ratios)
    expect(state.ratioOverridden).toBe(true);
    expect(state.outputExplicit).toBe(false);

    const serialized = toBrief(state);
    expect(serialized.output).toBeUndefined();
    expect(serialized.variation?.axes?.ratio).toBeUndefined();
  });
});

describe("L4.5 Fresh-draft Video on→off identity test (D9)", () => {
  test("turning Video on and then off on fresh draft is an identity operation", () => {
    const fresh = initialEditorState("variation");
    const initialBrief = toBrief(fresh);
    const initialSize = axisProductSize(fresh);

    // Turn Video on -> seeds defaults (all motion kinds, duration [DEFAULT_DURATION_SEC])
    const videoOn = reduce(fresh, { type: "toggleFormat", value: "motion" });
    expect(videoOn.formats).toContain("motion");
    expect(videoOn.motion.length).toBe(4);
    expect(videoOn.duration).toEqual([DEFAULT_DURATION_SEC]);
    expect(videoOn.motionSeeded).toBe(true);

    // Turn Video off without touching motion/duration -> retracts seeded motion/duration
    const videoOff = reduce(videoOn, { type: "toggleFormat", value: "motion" });
    expect(videoOff.formats).toEqual(["static"]);
    expect(videoOff.motion).toEqual([]);
    expect(videoOff.duration).toEqual([]);
    expect(axisProductSize(videoOff)).toBe(initialSize);

    // A fresh on→off round-trip is byte-identical: no output block is invented and
    // the motion/duration axes are absent, so the stored bytes, policyHash and
    // axisProductSize are all identical to the untouched fresh draft.
    const finalBrief = toBrief(videoOff);
    expect(finalBrief).toEqual(initialBrief);
    expect(finalBrief.variation?.axes?.motion).toBeUndefined();
    expect(finalBrief.variation?.axes?.duration).toBeUndefined();
  });

  test("touching motion kinds prevents retraction when Video is toggled off", () => {
    const fresh = initialEditorState("variation");
    const videoOn = reduce(fresh, { type: "toggleFormat", value: "motion" });
    const customized = reduce(videoOn, { type: "toggleMotion", value: "ken-burns-out" });
    expect(customized.motionTouched).toBe(true);

    const videoOff = reduce(customized, { type: "toggleFormat", value: "motion" });
    // Retraction does not happen because user explicitly touched motion
    expect(videoOff.motion).toContain("ken-burns-in");
  });
});

describe("DEFAULT_DURATION_SEC (L1)", () => {
  test("the editor re-exports the domain leaf constant rather than keeping a private copy", async () => {
    const { DEFAULT_DURATION_SEC: domainDefault } = await import(
      "@campaignfoundry/CampaignOrchestration/variation-defaults"
    );
    // The editor's default is the domain's, so changing the one constant moves the
    // editor's seed and `nextFreeDuration` along with it — no private 5-vs-6 drift.
    expect(DEFAULT_DURATION_SEC).toBe(domainDefault);
  });

  test("the seeded duration follows the editor's exported constant", () => {
    const fresh = initialEditorState("variation");
    const videoOn = reduce(fresh, { type: "toggleFormat", value: "motion" });
    expect(videoOn.duration).toEqual([DEFAULT_DURATION_SEC]);
  });
});

describe("motionPackagedRatios", () => {
  test("accepts an EditorState and lists ratios whose platforms package motion", () => {
    const state = {
      ...initialEditorState("variation"),
      platforms: ["instagram-reel", "x", "instagram-feed"],
    };
    const ratios = motionPackagedRatios(state);
    // Only instagram-reel packages motion (9:16); x and the static feed do not.
    expect(Array.from(ratios)).toEqual(["9:16"]);
  });

  test("accepts a raw platform-id array (the array overload)", () => {
    const ratios = motionPackagedRatios(["instagram-reel", "instagram-feed"]);
    expect(Array.from(ratios)).toEqual(["9:16"]);
  });
});


describe("a draft written before the override flags existed", () => {
  const legacy = (over: Record<string, unknown>) =>
    normalizeDraftState({
      mode: "variation",
      briefId: "camp",
      platforms: ["instagram-feed"],
      ...over,
    } as Record<string, unknown>);

  test("authored formats survive, because an absent flag is not a claim they were derived", () => {
    // `instagram-feed` derives static only; this draft holds motion as well, which can
    // only have been authored. Restoring it as "not overridden" hands the next platform
    // toggle permission to overwrite it.
    const restored = legacy({ formats: ["static", "motion"] });
    expect(restored.formatsOverridden).toBe(true);
    const toggled = editorReducer(restored, { type: "togglePlatform", value: "linkedin" });
    expect(toggled.formats).toEqual(["static", "motion"]);
  });

  test("authored motion kinds survive turning Video off", () => {
    const restored = legacy({ motion: ["ken-burns-in"], duration: [4] });
    expect(restored.motionTouched).toBe(true);
  });

  test("a draft that matches what the platforms derive is not marked overridden", () => {
    expect(legacy({ formats: ["static"] }).formatsOverridden).toBe(false);
    expect(legacy({ motion: [], duration: [] }).motionTouched).toBe(false);
  });

  test("a flag that is present is believed, not re-inferred", () => {
    // the user turned an override off deliberately; the data still differs, and that is
    // not the restore's business to second-guess
    expect(legacy({ formats: ["static", "motion"], formatsOverridden: false }).formatsOverridden).toBe(false);
  });
});

describe("the output remedies do what their labels say", () => {
  const motionOnly = () =>
    editorReducer(
      { ...initialEditorState(), mode: "variation", briefId: "camp", platforms: ["instagram-reel"], formats: ["motion"] },
      { type: "patch", patch: {} },
    );

  test("Add a photo platform clears the exclusion instead of toggling a platform off", () => {
    const fixed = editorReducer(motionOnly(), { type: "addPhotoOutput" });
    // the warning is raised by formats holding motion without static, so the remedy has
    // to add the format, not merely a platform
    expect(fixed.formats).toContain("static");
    expect(fixed.platforms.length).toBeGreaterThan(0);

    // …and pressing it twice is pressing it once, rather than undoing itself
    const again = editorReducer(fixed, { type: "addPhotoOutput" });
    expect(again.formats).toEqual(fixed.formats);
    expect(again.platforms).toEqual(fixed.platforms);
  });

  test("adding a clip length uses the second the user clicked", () => {
    const base = { ...initialEditorState(), mode: "variation" as const, duration: [6] };
    expect(editorReducer(base, { type: "addDuration", value: 12 }).duration).toEqual([6, 12]);
    // a second already on the reel would be a no-op for the planner, so fall back
    expect(editorReducer(base, { type: "addDuration", value: 6 }).duration).not.toEqual([6, 6]);
    // and with no second named at all, the old behaviour stands
    expect(editorReducer(base, { type: "addDuration" }).duration.length).toBe(2);
  });

  test("an override flag lifts when the selection returns to what the platforms derive", () => {
    const start = { ...initialEditorState(), mode: "variation" as const, platforms: ["instagram-feed"] };
    const on = editorReducer(start, { type: "toggleFormat", value: "motion" });
    expect(on.formatsOverridden).toBe(true);
    // back to the derived set: a latched flag would freeze formats against the next
    // platform change, leaving the previous platform's formats on screen
    const off = editorReducer(on, { type: "toggleFormat", value: "motion" });
    expect(off.formatsOverridden).toBe(false);
  });
});

describe("override detection is about bytes, not sets", () => {
  test("a brief whose formats are in a different order is overridden, not derived", () => {
    // `instagram-feed` and a video platform derive ["static", "motion"]; this brief says
    // the same two the other way round. Reading that as "derived" lets the next platform
    // toggle rewrite it into canonical order — changing the serialised output of a brief
    // nobody edited, which the corpus round-trip gate exists to prevent.
    const reversed = normalizeDraftState({
      mode: "variation",
      briefId: "camp",
      platforms: ["instagram-feed", "instagram-reel"],
      formats: ["motion", "static"],
    } as Record<string, unknown>);
    expect(reversed.formatsOverridden).toBe(true);
  });
})

describe("the load path and the draft path agree about what counts as overridden", () => {
  test("a brief loaded from disk with reordered formats is overridden, exactly as a draft is", () => {
    // `fromBrief` used its own inline set comparison while `normalizeDraftState` used
    // `differsFrom`, so the same brief got a different verdict depending on where it came
    // from — and the load path, the one that reads other people's briefs, was the lenient
    // of the two. A later platform toggle would then rewrite an order nobody edited.
    const loaded = fromBrief(
      savedBrief({ output: { formats: ["motion", "static"], platforms: ["instagram-feed", "instagram-reel"] } }),
    );
    expect(loaded.formatsOverridden).toBe(true);
  });

  test("a brief whose formats match the derived order is still not overridden", () => {
    const loaded = fromBrief(
      savedBrief({ output: { formats: platformsToFormats(["instagram-feed"]), platforms: ["instagram-feed"] } }),
    );
    expect(loaded.formatsOverridden).toBe(false);
  });
})

const authored = (state: EditorState) =>
  state.timeline.beats.map((beat) => ({ text: beat.text, weight: beat.weight }));

describe("copy timeline (E5.1)", () => {
  // A variation draft that can carry a serialised timeline: variation mode and the
  // motion format, with no `axes.headline` — the D5 gate `canSerializeTimeline`.
  const motionState = (): EditorState =>
    ({ ...initialEditorState("variation"), briefId: "camp", formats: ["static", "motion"] }) as EditorState;

  const named = (texts: string[]): EditorState => {
    let state = motionState();
    texts.forEach((text, index) => {
      state = reduce(state, { type: "addBeat" });
      state = reduce(state, { type: "setBeatText", index, text });
    });
    return state;
  };

  const texts = (state: EditorState): string[] => state.timeline.beats.map((beat) => beat.text);

  // A corpus-style motion brief that round-trips byte-for-byte once a timeline is
  // added — mirrors briefs/sample-motion.yaml's full axis set plus `copy.timeline`.
  const timelineBrief = (over: Partial<CampaignBrief> = {}): CampaignBrief =>
    ({
      id: "sample-timeline",
      targetRegion: "DE",
      targetAudience: "Urban outdoor enthusiasts",
      campaignMessage: "Stay wild.",
      localizedMessage: "Bleib wild.",
      products: [
        { id: "hydra-bottle", name: "Hydra Bottle", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
      ],
      mode: "variation",
      variation: {
        count: 8,
        seed: 3,
        minDistance: 2,
        coverage: { perProduct: 1, perRatio: 1 },
        axes: {
          layout: ["headline-top", "headline-bottom"],
          tone: ["bold", "subtle"],
          background: { source: ["procedural"] },
          paletteShift: [0, 0.1],
          motion: ["ken-burns-in", "headline-rise"],
          duration: [6],
        },
      } as unknown as CampaignBrief["variation"],
      output: { formats: ["static", "motion"], platforms: ["instagram-feed", "instagram-reel"] },
      copy: {
        timeline: {
          beats: [
            { text: "Stay wild.", weight: 3 },
            { text: "Stay hydrated.", weight: 2 },
            { text: "Find your trail.", weight: 1 },
          ],
          transition: "fade",
          keyBeat: 2,
        },
      },
      ...over,
    }) as CampaignBrief;

  describe("the reducer actions", () => {
    test("addBeat appends a blank first-weighted beat to the end", () => {
      const first = reduce(motionState(), { type: "addBeat" });
      expect(authored(first)).toEqual([{ text: "", weight: 1 }]);
      expect(first.timeline.keyBeat).toBe(1);
      const second = reduce(first, { type: "addBeat" });
      expect(authored(second)).toEqual([
        { text: "", weight: 1 },
        { text: "", weight: 1 },
      ]);
      // the poster stays; tweaking a row never re-points it
      expect(second.timeline.keyBeat).toBe(1);
    });

    test("setBeatText and setBeatWeight patch the named beat only", () => {
      const edited = reduce(
        reduce(named(["One", "Two", "Three"]), { type: "setBeatText", index: 1, text: "Updated" }),
        { type: "setBeatWeight", index: 1, weight: 4 },
      );
      expect(authored(edited)).toEqual([
        { text: "One", weight: 1 },
        { text: "Updated", weight: 4 },
        { text: "Three", weight: 1 },
      ]);
    });

    test("setKeyBeat makes the 1-based poster and setTransition swaps the cut", () => {
      const edited = reduce(
        reduce(named(["One", "Two", "Three"]), { type: "setKeyBeat", index: 2 }),
        { type: "setTransition", transition: "cut" },
      );
      expect(edited.timeline.keyBeat).toBe(3);
      expect(edited.timeline.transition).toBe("cut");
    });

    test("removeBeat removes exactly one beat per key", () => {
      expect(texts(reduce(named(["One", "Two", "Three"]), { type: "removeBeat", index: 1 }))).toEqual([
        "One",
        "Three",
      ]);
    });

    test("moveBeat reorders without duplicating or dropping", () => {
      const moved = reduce(named(["One", "Two", "Three"]), { type: "moveBeat", from: 0, to: 2 });
      expect(texts(moved)).toEqual(["Two", "Three", "One"]);
    });

    test("a no-op move and an off-range remove return the same state object", () => {
      const state = reduce(named(["One", "Two", "Three"]), { type: "setKeyBeat", index: 1 });
      expect(editorReducer(state, { type: "moveBeat", from: 2, to: 2 })).toBe(state);
      expect(editorReducer(state, { type: "removeBeat", index: 4 })).toBe(state);
    });

    test("an out-of-range move source is a no-op, never an injected undefined beat", () => {
      const state = reduce(named(["One", "Two", "Three"]), { type: "addBeat" });
      const moved = editorReducer(state, { type: "moveBeat", from: 4, to: 0 });
      expect(moved).toBe(state);
      expect(moved.timeline.beats.every((beat) => beat.text !== undefined && beat.weight !== undefined)).toBe(true);
    });

    test("an out-of-range move DESTINATION is a no-op and leaves the poster pointing at a beat", () => {
      // `to` was unchecked: moving the selected first beat to index 9 of a three-beat list
      // appended it and recorded keyBeat 10 — a timeline the API refuses on Save.
      const state = reduce(named(["One", "Two", "Three"]), { type: "setKeyBeat", index: 0 });
      for (const to of [3, 9, -1, 1.5]) {
        const moved = editorReducer(state, { type: "moveBeat", from: 0, to });
        expect(moved).toBe(state);
      }
      expect(state.timeline.keyBeat).toBeLessThanOrEqual(state.timeline.beats.length);
    });

    test("addBeat refuses past the domain's beat ceiling", () => {
      let state = motionState();
      for (let i = 0; i < MAX_BEATS; i += 1) state = reduce(state, { type: "addBeat" });
      expect(state.timeline.beats).toHaveLength(MAX_BEATS);
      // The parser rejects more, so the editor must not build a draft Save cannot take.
      expect(editorReducer(state, { type: "addBeat" })).toBe(state);
    });

    test("setBeatWeight refuses a weight the parser would reject", () => {
      const state = named(["One", "Two", "Three"]);
      for (const weight of [0, -1, 1.5, MAX_WEIGHT + 1, Number.NaN]) {
        expect(editorReducer(state, { type: "setBeatWeight", index: 1, weight })).toBe(state);
      }
      // The bounds themselves are accepted.
      expect(reduce(state, { type: "setBeatWeight", index: 1, weight: 1 }).timeline.beats[1]?.weight).toBe(1);
      expect(
        reduce(state, { type: "setBeatWeight", index: 1, weight: MAX_WEIGHT }).timeline.beats[1]?.weight,
      ).toBe(MAX_WEIGHT);
      // An index outside the list is a no-op too, like the move and remove cases.
      expect(editorReducer(state, { type: "setBeatWeight", index: 7, weight: 2 })).toBe(state);
    });

    test("setKeyBeat refuses an index no beat occupies", () => {
      const state = named(["One", "Two", "Three"]);
      for (const index of [3, 9, -1, 0.5]) {
        expect(editorReducer(state, { type: "setKeyBeat", index })).toBe(state);
      }
      expect(reduce(state, { type: "setKeyBeat", index: 2 }).timeline.keyBeat).toBe(3);
    });
  });

  describe("keyBeat follows the beat, not the row (D7/E5.1)", () => {
    test("moving the poster itself carries the poster to its new row", () => {
      const poster = 0;
      const moved = reduce(
        reduce(named(["One", "Two", "Three"]), { type: "setKeyBeat", index: poster }),
        { type: "moveBeat", from: poster, to: 2 },
      );
      expect(texts(moved)).toEqual(["Two", "Three", "One"]);
      expect(moved.timeline.keyBeat).toBe(3);
    });

    test("a beat carried forward across the poster shifts the poster's row left", () => {
      const state = reduce(named(["One", "Two", "Three", "Four"]), { type: "setKeyBeat", index: 2 });
      const moved = reduce(state, { type: "moveBeat", from: 0, to: 3 });
      expect(texts(moved)).toEqual(["Two", "Three", "Four", "One"]);
      // the poster (Three) is now second — keyBeat tracks the row, and the selected
      // text is unchanged because rows moved
      expect(moved.timeline.keyBeat).toBe(2);
    });

    test("a beat carried back across the poster shifts the poster's row right", () => {
      const state = reduce(named(["One", "Two", "Three", "Four"]), { type: "setKeyBeat", index: 0 });
      const moved = reduce(state, { type: "moveBeat", from: 3, to: 0 });
      expect(texts(moved)).toEqual(["Four", "One", "Two", "Three"]);
      expect(moved.timeline.keyBeat).toBe(2);
    });

    test("a beat that moves above the poster without crossing it leaves the poster's row alone", () => {
      const state = reduce(named(["One", "Two", "Three", "Four"]), { type: "setKeyBeat", index: 2 });
      const moved = reduce(state, { type: "moveBeat", from: 0, to: 1 });
      expect(texts(moved)).toEqual(["Two", "One", "Three", "Four"]);
      expect(moved.timeline.keyBeat).toBe(3);
    });

    test("a beat that moves below the poster without crossing it leaves the poster's row alone", () => {
      const state = reduce(named(["One", "Two", "Three", "Four"]), { type: "setKeyBeat", index: 0 });
      const moved = reduce(state, { type: "moveBeat", from: 2, to: 3 });
      expect(texts(moved)).toEqual(["One", "Two", "Four", "Three"]);
      expect(moved.timeline.keyBeat).toBe(1);
    });

    test("removing a beat before the poster decrements it", () => {
      const state = reduce(named(["One", "Two", "Three", "Four"]), { type: "setKeyBeat", index: 2 });
      const removed = reduce(state, { type: "removeBeat", index: 0 });
      expect(texts(removed)).toEqual(["Two", "Three", "Four"]);
      expect(removed.timeline.keyBeat).toBe(2);
    });

    test("removing the poster itself keeps the row — the shifted beat inherits it", () => {
      const state = reduce(named(["One", "Two", "Three", "Four"]), { type: "setKeyBeat", index: 2 });
      const removed = reduce(state, { type: "removeBeat", index: 2 });
      expect(texts(removed)).toEqual(["One", "Two", "Four"]);
      expect(removed.timeline.keyBeat).toBe(3);
    });

    test("removing the poster when it is last picks the new last beat", () => {
      const state = reduce(named(["One", "Two", "Three"]), { type: "setKeyBeat", index: 2 });
      const removed = reduce(state, { type: "removeBeat", index: 2 });
      expect(texts(removed)).toEqual(["One", "Two"]);
      expect(removed.timeline.keyBeat).toBe(2);
    });

    test("removing a beat after the poster leaves it alone", () => {
      const state = reduce(named(["One", "Two", "Three"]), { type: "setKeyBeat", index: 0 });
      const removed = reduce(state, { type: "removeBeat", index: 2 });
      expect(texts(removed)).toEqual(["One", "Two"]);
      expect(removed.timeline.keyBeat).toBe(1);
    });

    test("removing the last beat empties the draft and resets the poster to its sentinel", () => {
      const state = reduce(named(["One"]), { type: "setKeyBeat", index: 0 });
      const removed = reduce(state, { type: "removeBeat", index: 0 });
      expect(removed.timeline).toEqual({ beats: [], transition: "fade", keyBeat: 1 });
      // an empty timeline has no `copy` block to write, and a later add can rebuild it
      expect(toBrief(removed).copy).toBeUndefined();
      expect(reduce(removed, { type: "addBeat" }).timeline.keyBeat).toBe(1);
    });
  });

  describe("the keyBeat invariant holds through a scripted session", () => {
    test("no sequence of edits can leave keyBeat outside [1, beats.length]", () => {
      let state = named(["One", "Two", "Three"]);
      const script: EditorAction[] = [
        { type: "moveBeat", from: 0, to: 2 },
        { type: "setKeyBeat", index: 1 },
        { type: "moveBeat", from: 2, to: 0 },
        { type: "setBeatWeight", index: 0, weight: 4 },
        { type: "addBeat" },
        { type: "moveBeat", from: 1, to: 3 },
        { type: "removeBeat", index: 2 },
        { type: "removeBeat", index: 0 },
        { type: "addBeat" },
        { type: "moveBeat", from: 0, to: 2 },
        { type: "removeBeat", index: 1 },
      ];
      for (const action of script) {
        state = editorReducer(state, action);
        if (state.timeline.beats.length === 0) {
          expect(state.timeline.keyBeat).toBe(1);
        } else {
          expect(state.timeline.keyBeat).toBeGreaterThanOrEqual(1);
          expect(state.timeline.keyBeat).toBeLessThanOrEqual(state.timeline.beats.length);
        }
      }
      // And the draft that comes out of this is structurally sound for the running
      // paths: poster in range, integer weights in [1, MAX_WEIGHT], ≤ MAX_BEATS beats
      // — at 6 s every beat clears the 1.2 s readability floor (D3).
      const timeline = toBrief(state).copy?.timeline;
      expect(timeline).toBeDefined();
      expect(timelineProblem(timeline!, [6])).toBeUndefined();
    });
  });

  describe("toBrief/fromBrief round-trip (D11)", () => {
    test("fromBrief loads a declared timeline and toBrief writes it back", () => {
      const loaded = fromBrief(timelineBrief());
      expect(loaded.copyExplicit).toBe(true);
      expect(authored(loaded)).toEqual([
        { text: "Stay wild.", weight: 3 },
        { text: "Stay hydrated.", weight: 2 },
        { text: "Find your trail.", weight: 1 },
      ]);
      expect(loaded.timeline.transition).toBe("fade");
      expect(loaded.timeline.keyBeat).toBe(2);
      // Every row carries a distinct React identity, minted on load.
      expect(new Set(loaded.timeline.beats.map((b) => b.key)).size).toBe(3);
      expect(toBrief(loaded).copy).toEqual(timelineBrief().copy);
    });

    test("a timeline brief survives a load → save byte-for-byte", () => {
      const brief = timelineBrief();
      const roundTripped = toBrief(fromBrief(brief, { file: "camp.yaml", revision: undefined as unknown as undefined }));
      expect(dumpBrief(roundTripped)).toBe(dumpBrief(brief));
    });

    test("the serialised copy block sits after variation, as the canonical key order is", () => {
      // `dumpBrief` puts any key outside the known order last, so `copy` lands at the
      // tail of its YAML. The object we hand it should match that: copy after variation.
      const written = toBrief(fromBrief(timelineBrief()));
      const keys = Object.keys(written);
      expect(keys.indexOf("variation")).toBeLessThan(keys.indexOf("copy"));
    });

    test("a brief with no copy block does not grow one", () => {
      const written = toBrief(fromBrief(savedBrief({ mode: "variation" })));
      expect("copy" in written).toBe(false);
    });

    test("a declared-but-empty copy block round-trips (copyExplicit)", () => {
      const brief = savedBrief({ copy: {} });
      const roundTripped = toBrief(fromBrief(brief, { file: "camp.yaml", revision: undefined as unknown as undefined }));
      expect(roundTripped.copy).toEqual({});
      expect(dumpBrief(roundTripped)).toBe(dumpBrief(brief));
    });

    test("a host without the ffmpeg capability still round-trips a loaded timeline verbatim", () => {
      const loaded = { ...fromBrief(timelineBrief()), capabilities: { motion: false, reason: "no ffmpeg on host" } };
      const written = toBrief(loaded);
      // the brief arrives with motion formats (the parser required them), so the
      // timeline persists even though this host has no controls for it (D11/D12)
      expect(written.copy).toEqual(timelineBrief().copy);
      expect(written.output?.formats).toContain("motion");
    });
  });

  describe("the D5 gate: a timeline serialises only where the parser allows it", () => {
    test("authoring is gated on canSerializeTimeline, never on the beats in the draft", () => {
      const authored = reduce(reduce(motionState(), { type: "addBeat" }), {
        type: "setBeatText",
        index: 0,
        text: "Hook",
      });
      expect(toBrief(authored).copy?.timeline?.beats).toEqual([{ text: "Hook", weight: 1 }]);
    });

    test("Video off drops the timeline from the brief but keeps the beats in the draft", () => {
      const authored = reduce(reduce(motionState(), { type: "addBeat" }), {
        type: "setBeatText",
        index: 0,
        text: "Hook",
      });
      const videoOff = reduce(authored, { type: "toggleFormat", value: "motion" });
      expect(videoOff.timeline.beats).toHaveLength(1);
      expect(toBrief(videoOff).copy).toBeUndefined();
    });

    test("a switch to classic mode does the same, and the draft survives the round trip", () => {
      const authored = reduce(reduce(motionState(), { type: "addBeat" }), {
        type: "setBeatText",
        index: 0,
        text: "Hook",
      });
      const classic = reduce(authored, { type: "setMode", mode: "brief" });
      expect(toBrief(classic).copy).toBeUndefined();
      const back = reduce(classic, { type: "setMode", mode: "variation" });
      expect(toBrief(back).copy?.timeline?.beats).toEqual([{ text: "Hook", weight: 1 }]);
    });

    test("a timeline cannot combine with axes.headline: pool://copy", () => {
      const authored = reduce(reduce(motionState(), { type: "addBeat" }), {
        type: "setBeatText",
        index: 0,
        text: "Hook",
      });
      const heightened = reduce(authored, { type: "toggleHeadline" });
      expect(heightened.variation.headline).toBe(true);
      // the beats are still in the draft; only the serialisation is gated
      expect(heightened.timeline.beats).toHaveLength(1);
      expect(toBrief(heightened).copy).toBeUndefined();
    });
  });

  describe("drafts written before timelines existed", () => {
    test("a legacy draft restores an empty timeline and no copy flag", () => {
      const restored = normalizeDraftState({ mode: "brief", briefId: "camp" });
      expect(restored.timeline).toEqual({ beats: [], transition: "fade", keyBeat: 1 });
      expect(restored.copyExplicit).toBe(false);
    });

    test("a draft with a timeline keeps it, repairing broken beats and clamping keyBeat", () => {
      const restored = normalizeDraftState({
        mode: "brief",
        briefId: "camp",
        copyExplicit: true,
        timeline: {
          beats: [null, { text: "kept", weight: 7 }, { text: 42, weight: 99 }, { text: "ok", weight: -3 }],
          transition: "slide",
          keyBeat: 20,
        },
      });
      expect(authored(restored)).toEqual([
        { text: "", weight: 1 },
        { text: "kept", weight: 7 },
        { text: "", weight: 1 },
        { text: "ok", weight: 1 },
      ]);
      expect(restored.timeline.transition).toBe("fade");
      expect(restored.timeline.keyBeat).toBe(4);
      expect(restored.copyExplicit).toBe(true);
    });

    test("a malformed timeline object repairs its shape and its poster", () => {
      const nonArray = normalizeDraftState({
        mode: "brief",
        briefId: "camp",
        timeline: { beats: "nope", transition: "cut", keyBeat: 0 },
      });
      expect(nonArray.timeline).toEqual({ beats: [], transition: "cut", keyBeat: 1 });

      const missingWeight = normalizeDraftState({
        mode: "brief",
        briefId: "camp",
        timeline: { beats: [{ text: "takable" }], keyBeat: -5 },
      });
      expect(authored(missingWeight)).toEqual([{ text: "takable", weight: 1 }]);
      expect(missingWeight.timeline.transition).toBe("fade");
      expect(missingWeight.timeline.keyBeat).toBe(1);
    });
  });
})
