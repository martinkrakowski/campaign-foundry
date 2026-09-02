import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";
import { parseBriefText } from "../load-brief.js";
import { nodeCryptoPolicyHasher } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { VariationPolicy } from "@campaignfoundry/CampaignOrchestration";

/**
 * D57 hash stability over the tracked sample fixtures (T4). The re-roll path
 * pins the persisted policyHash and re-plans from the brief, so a brief
 * written before the anchor axis existed must resolve to the exact hash it
 * had before the axis joined `DISTANCE_AXES`. The values below were captured
 * from the pre-axis code and are pinned here; the fixtures are read
 * read-only, and the pooled brief is fed its approved pool texts exactly as
 * the plan path does.
 */
const BRIEFS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "briefs");

const GOLDEN_HASHES: Record<string, string> = {
  "sample-motion.yaml": "f7291c1016b5d2c4b3b1ff363b86629ffc7c923c66720f98c16cedb5f70b79fb",
  "sample-randomized.yaml": "9f738749b56900e8fb399cad847f079478d116cbc09286f767438e44dc722846",
  "sample-pooled.yaml": "beb5a8cdb07c5bb94fef66f4e89a0ece83a97d994493af521e5b197a782bcf6b",
};

const approvedPoolTexts = (briefId: string): string[] | undefined => {
  const poolPath = join(BRIEFS_DIR, briefId, "pools.json");
  try {
    const pool = JSON.parse(readFileSync(poolPath, "utf8")) as {
      entries: { text: string; status: string }[];
    };
    return pool.entries.filter((entry) => entry.status === "approved").map((entry) => entry.text);
  } catch {
    // A brief without the headline axis has no pool file; the input is unused then.
    return undefined;
  }
};

describe("policyHash is unchanged for every pre-anchor sample brief (D57)", () => {
  const files = Object.keys(GOLDEN_HASHES).sort();
  expect(files.length).toBeGreaterThan(0);

  test.each(files)("%s resolves to its pre-axis policyHash", (file) => {
    const path = join(BRIEFS_DIR, file);
    const brief = parseBriefText(path, readFileSync(path, "utf8"));
    expect(brief.mode).toBe("variation");
    const result = VariationPolicy.fromBrief(
      brief,
      { headlines: approvedPoolTexts(brief.id) },
      nodeCryptoPolicyHasher,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    // The axis is absent from every fixture — the resolution must join nothing.
    expect(result.value.anchor).toEqual([]);
    expect(result.value.policyHash).toBe(GOLDEN_HASHES[file]);
  });

  test("the fixture set is exactly the tracked sample variation briefs", () => {
    const tracked = readdirSync(BRIEFS_DIR)
      .filter((name) => /^sample-.*\.(yaml|json)$/.test(name))
      .sort();
    expect(tracked).toEqual([
      "sample-campaign-orange.yaml",
      "sample-campaign-reuse.yaml",
      "sample-campaign-variants.yaml",
      "sample-campaign.json",
      "sample-campaign.yaml",
      "sample-motion.yaml",
      "sample-pooled.yaml",
      "sample-randomized.yaml",
    ]);
  });
});

describe("the style block is hashed nowhere (T5/D57)", () => {
  // Injected as text, not written to briefs/ — the corpus stays read-only.
  const styledTwinOf = (file: string, styleBlock: string): string => {
    const text = readFileSync(join(BRIEFS_DIR, file), "utf8");
    // Insert the style block right after the required campaignMessage line.
    const anchor = /^campaignMessage:.*$/m;
    if (!anchor.test(text)) throw new Error(`fixture ${file} has no campaignMessage line to anchor on`);
    return text.replace(anchor, (line) => `${line}\n${styleBlock}`);
  };

  test("a styled brief resolves to the exact hash of its style-less twin", () => {
    const file = "sample-randomized.yaml";
    const path = join(BRIEFS_DIR, file);
    const plain = parseBriefText(path, readFileSync(path, "utf8"));
    const styled = parseBriefText(
      path,
      styledTwinOf(
        file,
        ["style:", "  fontFamily: Lora", "  fontWeight: 700", "  sizeScale: 0.08", "  lineHeight: 1.4", "  letterSpacing: 0.05", "  align: left"].join("\n"),
      ),
    );
    expect(styled.style).toBeDefined();
    const pooled = approvedPoolTexts(plain.id);
    const plainPolicy = VariationPolicy.fromBrief(plain, { headlines: pooled }, nodeCryptoPolicyHasher);
    const styledPolicy = VariationPolicy.fromBrief(styled, { headlines: pooled }, nodeCryptoPolicyHasher);
    expect(plainPolicy.success).toBe(true);
    expect(styledPolicy.success).toBe(true);
    if (!plainPolicy.success || !styledPolicy.success) return;
    expect(styledPolicy.value.policyHash).toBe(plainPolicy.value.policyHash);
    // And the styled twin keeps the pre-style golden hash too — the block is
    // invisible to the policy by construction, not by luck.
    expect(styledPolicy.value.policyHash).toBe(GOLDEN_HASHES[file]);
  });
});
