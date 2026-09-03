import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { BriefDocumentError, patchBriefYaml } from "../brief-files.js";
import { parseBriefText } from "../load-brief.js";
import { FsBriefStore } from "../ports/fs-brief-store.js";

/**
 * The R4 corpus test (D36). A save must not destroy what the operator wrote, so
 * every fixture — comments, blank lines, quoted `#`, merges, CRLF, a BOM, a
 * leading `---`, and the `.json` brief — is **copied into an mkdtemp directory**
 * and round-tripped there. No test in this file ever writes into `briefs/`;
 * the real-corpus test reads the operator's files read-only and saves the copies.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "brief-corpus");
const REPO_BRIEFS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "briefs");

const YAML_FIXTURES = ["anchors-merge.yaml", "comments.yaml", "doc-start.yaml", "scalars.yaml"];

let dir: string;
let store: FsBriefStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cf-brief-corpus-"));
  store = new FsBriefStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Copy a fixture into the temp briefs dir (optionally transformed) and return its path. */
const copy = (name: string, transform?: (text: string) => string): string => {
  let text = readFileSync(join(FIXTURES, name), "utf8");
  if (transform) text = transform(text);
  const path = join(dir, name);
  writeFileSync(path, text, "utf8");
  return path;
};

const loadBrief = (path: string): CampaignBrief => parseBriefText(path, readFileSync(path, "utf8"));

describe("brief corpus round trip (R4 — a save must not destroy what the operator wrote)", () => {
  test.each(YAML_FIXTURES)(
    "%s: load → save round trip is byte for byte where nothing changed",
    async (name) => {
      const path = copy(name);
      const original = readFileSync(path);
      const brief = loadBrief(path);
      await store.rewriteBrief(brief);
      expect(readFileSync(path)).toEqual(original);
    },
  );

  test("a CRLF corpus file round-trips byte for byte, line endings included", async () => {
    const path = copy("comments.yaml", (text) => text.replace(/\n/g, "\r\n"));
    const original = readFileSync(path);
    await store.rewriteBrief(loadBrief(path));
    expect(readFileSync(path)).toEqual(original);
  });

  test("a BOM-prefixed corpus file round-trips byte for byte, BOM included", async () => {
    const path = copy("comments.yaml", (text) => `\uFEFF${text}`);
    const original = readFileSync(path);
    await store.rewriteBrief(loadBrief(path));
    expect(readFileSync(path)).toEqual(original);
  });

  test("a changed top-level field is written while its neighbours' comments survive", async () => {
    const path = copy("comments.yaml");
    const brief = loadBrief(path);
    await store.rewriteBrief({ ...brief, campaignMessage: "Rewritten message." });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("campaignMessage: Rewritten message.");
    expect(text).toContain("# Corpus fixture — leading comment block.");
    expect(text).toContain("# A hand-written note about the audience.");
    expect(text).toContain("targetRegion: DE # inline note on targetRegion");
    expect(text).toContain('primaryColor: "#1473E6"');
    expect(text).toContain("# Trailing comment at EOF");
    expect(text).toContain("\n\n"); // blank lines survive
  });

  test("a changed nested field keeps its own inline comment", async () => {
    const path = copy("comments.yaml");
    const brief = loadBrief(path);
    const variation = { ...(brief.variation ?? {}), count: 7 };
    await store.rewriteBrief({ ...brief, variation } as CampaignBrief);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("count: 7");
    expect(text).toContain("# how many creatives per slot");
  });

  test("a removed key is deleted and a new key is appended, neighbours intact", async () => {
    const path = copy("comments.yaml");
    const brief = loadBrief(path) as unknown as Record<string, unknown>;
    delete brief.campaignTagline;
    brief.notes = "added by the operator";
    await store.rewriteBrief(brief as unknown as CampaignBrief);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("campaignTagline");
    expect(text).toContain("notes: added by the operator");
    expect(text).toContain('primaryColor: "#1473E6"');
    expect(text).toContain("# Trailing comment at EOF");
  });

  test("a changed array is written fresh and the saved file still parses", async () => {
    const path = copy("comments.yaml");
    const brief = loadBrief(path);
    const products = JSON.parse(JSON.stringify(brief.products));
    products[0].name = "Hydra Bottle MK2";
    await store.rewriteBrief({ ...brief, products } as CampaignBrief);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("name: Hydra Bottle MK2");
    expect(text).toContain("campaignMessage: Stay wild. Stay hydrated.");
    const reparsed = loadBrief(path);
    expect(reparsed.products[0]?.name).toBe("Hydra Bottle MK2");
  });

  test("a changed field in a brief with merge keys leaves the merge untouched", async () => {
    const path = copy("anchors-merge.yaml");
    const brief = loadBrief(path);
    await store.rewriteBrief({ ...brief, campaignMessage: "Edited." });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("campaignMessage: Edited.");
    expect(text).toContain("<<: *defaults");
    expect(text).toContain("tone: bold");
    expect(text).toContain("# Anchors and merge keys must survive a save untouched.");
  });

  test("the .json brief round-trips as JSON, byte for byte where nothing changed", async () => {
    const canonical = JSON.stringify(
      JSON.parse(readFileSync(join(FIXTURES, "corpus-json.json"), "utf8")),
      null,
      2,
    );
    const path = join(dir, "corpus-json.json");
    writeFileSync(path, canonical, "utf8");
    await store.rewriteBrief(loadBrief(path));
    expect(readFileSync(path, "utf8")).toBe(canonical);
  });

  test("a changed .json brief stays JSON.parse-able and never grows YAML", async () => {
    const path = copy("corpus-json.json");
    const brief = loadBrief(path);
    const updated = { ...brief, campaignMessage: "Rewritten JSON message." };
    await store.rewriteBrief(updated);
    const text = readFileSync(path, "utf8");
    expect(text.trimStart().startsWith("{")).toBe(true);
    const parsed = JSON.parse(text) as { campaignMessage: string; products: { id: string }[] };
    expect(parsed.campaignMessage).toBe("Rewritten JSON message.");
    expect(parsed.products[0]?.id).toBe("hydra-bottle");
    // Written as exactly JSON.stringify(…, null, 2) — a YAML-flow emission would
    // be a Document patch leaking into the .json branch (R4.2).
    expect(text).toBe(JSON.stringify(updated, null, 2));
  });

  test("inline comment padding is normalized to one space — the comment text itself is preserved", async () => {
    // The YAML Document API drops the whitespace between a value and its `#`
    // at parse time; the writer re-emits comments with a single space. The
    // comment text is intact; only the padding normalizes (documented deviation).
    const path = copy("comments.yaml", (text) => text.replace("DE # inline", "DE   # inline"));
    await store.rewriteBrief(loadBrief(path));
    const text = readFileSync(path, "utf8");
    expect(text).toContain("DE # inline note on targetRegion");
    expect(text).not.toContain("DE   # inline note on targetRegion");
  });

  test("every brief in briefs/ keeps its comments through a save and reaches a byte fixpoint", async () => {
    const files = readdirSync(REPO_BRIEFS)
      .filter((name) => /\.(yaml|yml|json)$/i.test(name))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const text = readFileSync(join(REPO_BRIEFS, name), "utf8");
      const path = join(dir, name);
      writeFileSync(path, text, "utf8");
      await store.rewriteBrief(loadBrief(path));
      const first = readFileSync(path, "utf8");
      // One save settles any normalization (e.g. inline comment padding); a
      // second save of the same content must then change nothing at all.
      await store.rewriteBrief(loadBrief(path));
      expect(readFileSync(path, "utf8"), name).toBe(first);
      // Every standalone comment line of the operator's file is still there.
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#")) expect(first, `${name}: ${trimmed}`).toContain(trimmed);
      }
    }
  });
});

describe("fail-closed writes (R4.1 — never fall back to a whole-object dump)", () => {
  test("an unparseable file refuses the write and names the reason", () => {
    expect(() => patchBriefYaml("briefs/broken.yaml", "id: [unclosed\n", {})).toThrow(BriefDocumentError);
    expect(() => patchBriefYaml("briefs/broken.yaml", "id: [unclosed\n", {})).toThrow(
      /does not parse as YAML/,
    );
  });

  test("an empty file, a multi-document stream and a non-mapping document are refused", () => {
    expect(() => patchBriefYaml("b.yaml", "", {})).toThrow(/no YAML document/);
    expect(() => patchBriefYaml("b.yaml", "id: a\n---\nid: b\n", {})).toThrow(
      /more than one YAML document/,
    );
    expect(() => patchBriefYaml("b.yaml", "just a scalar\n", {})).toThrow(/not a mapping/);
  });

  test("a write through a YAML alias refuses instead of editing the anchored map", () => {
    const raw = "id: a\nbase: &base\n  count: 4\nvariation: *base\n";
    const brief = { id: "a", base: { count: 4 }, variation: { count: 9 } };
    expect(() => patchBriefYaml("b.yaml", raw, brief)).toThrow(/is a YAML alias/);
  });

  test("an unparseable existing brief refuses the rewrite and leaves the original byte-identical", async () => {
    const broken = "id: broken\nproducts: [this, is, not, a, valid, brief\n";
    const path = join(dir, "broken.yaml");
    writeFileSync(path, broken, "utf8");
    const before = readFileSync(path);
    const brief = { id: "broken", campaignMessage: "Clobbered." } as unknown as CampaignBrief;
    await expect(store.rewriteBrief(brief)).rejects.toThrow();
    expect(readFileSync(path)).toEqual(before);
  });

  test("a replace on an unparseable brief cannot destroy it either", async () => {
    const broken = "id: broken\nproducts: [this, is, not, a, valid, brief\n";
    const path = join(dir, "broken.yaml");
    writeFileSync(path, broken, "utf8");
    const before = readFileSync(path);
    const brief = { id: "broken", campaignMessage: "Clobbered." } as unknown as CampaignBrief;
    await expect(store.replaceBrief(brief)).rejects.toThrow();
    expect(readFileSync(path)).toEqual(before);
  });

  test("a write that fails mid-way leaves the original intact", async () => {
    const path = copy("comments.yaml");
    const original = readFileSync(path);
    const brief = loadBrief(path);
    mkdirSync(`${path}.tmp`); // block the temp write with a directory
    await expect(store.rewriteBrief({ ...brief, campaignMessage: "Nope." })).rejects.toThrow();
    expect(readFileSync(path)).toEqual(original);
    expect(existsSync(`${path}.tmp`)).toBe(true); // unlink of a directory fails harmlessly
  });
});

describe("one YAML schema for load and dump (R4.3)", () => {
  test("the load path pins the yaml package's 1.2 default: timestamps and 0b literals stay strings", () => {
    const brief = parseBriefText(
      "scalars.yaml",
      readFileSync(join(FIXTURES, "scalars.yaml"), "utf8"),
    ) as unknown as Record<string, unknown>;
    expect(brief.reviewBy).toBe("2026-08-31");
    expect(brief.mask).toBe("0b1010");
  });

  test("alias expansion is capped at load — an alias bomb is refused", () => {
    const bomb = [
      "id: bomb",
      "targetRegion: DE",
      "targetAudience: x",
      "campaignMessage: x",
      "products:",
      "  - id: solo",
      "    name: Solo",
      "    logoPath: a.png",
      '    primaryColor: "#000000"',
      "a0: &a0 [0,0,0,0,0,0,0,0,0,0]",
      "a1: &a1 [*a0,*a0,*a0,*a0,*a0,*a0,*a0,*a0,*a0,*a0]",
      "a2: &a2 [*a1,*a1,*a1,*a1,*a1,*a1,*a1,*a1,*a1,*a1]",
      "payload: [*a2,*a2,*a2,*a2,*a2,*a2,*a2,*a2,*a2,*a2]",
    ].join("\n");
    expect(() => parseBriefText("bomb.yaml", bomb)).toThrow(/alias count/);
  });
});

describe("the brief boundary keeps the D15 authoring leniency in the listing (D68)", () => {
  // listBriefs skips any file whose parse throws — so the parser's shape checks
  // decide whether a hand-edited brief stays in the picker or vanishes behind a warn.
  test("a brief whose targetAudience is null still parses and still appears in listBriefs()", async () => {
    // A YAML `targetAudience:` with no value parses to null; rejecting it would make
    // an operator's half-written brief silently vanish from the picker.
    writeFileSync(
      join(dir, "null-audience.yaml"),
      "id: null-audience\ntargetRegion: DE\ntargetAudience:\ncampaignMessage: Hi\nproducts:\n  - id: alpha\n",
      "utf8",
    );
    const listed = await store.listBriefs();
    expect(listed.map((entry) => entry.file)).toContain("null-audience.yaml");
  });

  test("a brief with a list-typed targetRegion is skipped with a warn naming the file (F2)", async () => {
    writeFileSync(
      join(dir, "list-region.yaml"),
      "id: list-region\ntargetRegion: [DE, US]\ntargetAudience: a\ncampaignMessage: Hi\nproducts:\n  - id: alpha\n",
      "utf8",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listed = await store.listBriefs();
    expect(listed.map((entry) => entry.file)).not.toContain("list-region.yaml");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("list-region.yaml"));
    warn.mockRestore();
    expect(vi.isMockFunction(console.warn)).toBe(false);
  });
});
