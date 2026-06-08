import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBrief, parseRegenerateOnly, loadBrief } from "../load-brief.js";

const valid = {
  id: "camp",
  targetRegion: "DE",
  targetAudience: "aud",
  campaignMessage: "Hello",
  products: [{ id: "alpha" }, { id: "beta" }],
};

describe("parseBrief", () => {
  test("accepts a structurally valid brief", () => {
    expect(parseBrief(valid).id).toBe("camp");
  });

  test.each([
    ["a non-object", 42, /must be an object/],
    ["null", null, /must be an object/],
    ["a missing required field (campaignMessage)", { id: "camp", targetRegion: "DE", targetAudience: "a", products: valid.products }, /missing required field/],
    ["a non-slug id", { ...valid, id: "Bad Id" }, /Campaign id must be a path-safe/],
    ["non-array products", { ...valid, products: "x" }, /"products" must be an array/],
    ["a non-slug product id", { ...valid, products: [{ id: "Alpha" }, { id: "beta" }] }, /Product id must be a path-safe/],
  ])("rejects %s", (_label, input, message) => {
    expect(() => parseBrief(input)).toThrow(message);
  });

  test("validates optional treatments structurally", () => {
    expect(() => parseBrief({ ...valid, treatments: "x" })).toThrow(/"treatments" must be an array/);
    expect(() => parseBrief({ ...valid, treatments: [{ id: "Bad", layout: "headline-top", tone: "bold" }] })).toThrow(
      /Treatment id must be a path-safe/,
    );
    expect(() =>
      parseBrief({ ...valid, treatments: [{ id: "t", layout: "sideways", tone: "bold" }] }),
    ).toThrow(/invalid layout/);
    expect(() =>
      parseBrief({ ...valid, treatments: [{ id: "t", layout: "headline-top", tone: "loud" }] }),
    ).toThrow(/invalid tone/);
    expect(() =>
      parseBrief({
        ...valid,
        treatments: [
          { id: "dup", layout: "headline-top", tone: "bold" },
          { id: "dup", layout: "headline-bottom", tone: "subtle" },
        ],
      }),
    ).toThrow(/Duplicate treatment id/);
    // A valid treatments array passes.
    expect(parseBrief({ ...valid, treatments: [{ id: "t", layout: "headline-top", tone: "bold" }] }).treatments).toHaveLength(1);
  });
});

describe("parseRegenerateOnly", () => {
  test("returns undefined when absent", () => {
    expect(parseRegenerateOnly(undefined)).toBeUndefined();
    expect(parseRegenerateOnly(null)).toBeUndefined();
  });

  test("rejects a non-array and an empty array", () => {
    expect(() => parseRegenerateOnly("x")).toThrow(/must be an array/);
    expect(() => parseRegenerateOnly([])).toThrow(/at least one target/);
  });

  test("rejects entries with non-string fields", () => {
    expect(() => parseRegenerateOnly([{ productId: "p", aspectRatio: "1:1" }])).toThrow(/require string/);
  });

  test("maps valid targets", () => {
    expect(parseRegenerateOnly([{ productId: "p", aspectRatio: "1:1", treatment: "default" }])).toEqual([
      { productId: "p", aspectRatio: "1:1", treatment: "default" },
    ]);
  });
});

describe("loadBrief", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("loads a JSON brief", async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-brief-"));
    const path = join(dir, "c.json");
    writeFileSync(path, JSON.stringify(valid));
    expect((await loadBrief(path)).id).toBe("camp");
  });

  test("loads a YAML brief", async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-brief-"));
    const path = join(dir, "c.yaml");
    writeFileSync(path, "id: camp\ntargetRegion: DE\ntargetAudience: a\ncampaignMessage: Hi\nproducts:\n  - id: alpha\n  - id: beta\n");
    expect((await loadBrief(path)).products).toHaveLength(2);
  });
});
