import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import * as yaml from "js-yaml";
import {
  LAYOUT_VALUES,
  SAFE_ID_PATTERN,
  TONE_VALUES,
  type CampaignBrief,
  type RegenerationTarget,
} from "@campaignfoundry/CampaignOrchestration";

const REQUIRED_FIELDS = ["id", "targetRegion", "targetAudience", "campaignMessage", "products"] as const;

/** Structurally validate the optional `treatments` array, when present. */
function validateTreatments(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error('Campaign brief field "treatments" must be an array.');
  }
  const seen = new Set<string>();
  for (const t of value) {
    const rec = t as Record<string, unknown>;
    if (typeof rec?.id !== "string" || !SAFE_ID_PATTERN.test(rec.id)) {
      throw new Error(
        `Treatment id must be a path-safe slug (lowercase letters, digits, hyphens; max 64 chars); got ${JSON.stringify(rec?.id)}.`,
      );
    }
    if (seen.has(rec.id)) {
      throw new Error(`Duplicate treatment id "${rec.id}" — ids must be unique within a brief.`);
    }
    seen.add(rec.id);
    if (!LAYOUT_VALUES.includes(rec.layout as (typeof LAYOUT_VALUES)[number])) {
      throw new Error(`Treatment "${rec.id}" has invalid layout (expected one of ${LAYOUT_VALUES.join(", ")}).`);
    }
    if (!TONE_VALUES.includes(rec.tone as (typeof TONE_VALUES)[number])) {
      throw new Error(`Treatment "${rec.id}" has invalid tone (expected one of ${TONE_VALUES.join(", ")}).`);
    }
  }
}

/** Structurally validate an untrusted value into a CampaignBrief. Business rules live in the use case. */
export function parseBrief(data: unknown): CampaignBrief {
  if (typeof data !== "object" || data === null) {
    throw new Error("Campaign brief must be an object.");
  }
  const record = data as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in record)) {
      throw new Error(`Campaign brief is missing required field: "${field}".`);
    }
  }
  if (!Array.isArray(record.products)) {
    throw new Error('Campaign brief field "products" must be an array.');
  }
  for (const p of record.products) {
    const id = (p as Record<string, unknown>)?.id;
    if (typeof id !== "string" || !SAFE_ID_PATTERN.test(id)) {
      throw new Error(
        `Product id must be a path-safe slug (lowercase letters, digits, hyphens; max 64 chars); got ${JSON.stringify(id)}.`,
      );
    }
  }
  validateTreatments(record.treatments);
  return record as unknown as CampaignBrief;
}

/**
 * Structurally validate an untrusted `regenerateOnly` list (the HITL re-roll targets).
 * Returns undefined when absent (a full run). These strings only ever drive set
 * membership in the use case — never path construction — but we validate shape so a
 * malformed payload fails fast with a clear 400 instead of a runtime error.
 */
export function parseRegenerateOnly(value: unknown): RegenerationTarget[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('"regenerateOnly" must be an array of { productId, aspectRatio, treatment }.');
  }
  // An empty list would enable selective mode yet target nothing — a silent no-op
  // run. Reject it so the contract fails fast instead (omit the field for a full run).
  if (value.length === 0) {
    throw new Error('"regenerateOnly" must contain at least one target (omit it for a full run).');
  }
  return value.map((entry) => {
    const rec = entry as Record<string, unknown>;
    if (
      typeof rec?.productId !== "string" ||
      typeof rec?.aspectRatio !== "string" ||
      typeof rec?.treatment !== "string"
    ) {
      throw new Error(
        '"regenerateOnly" entries require string productId, aspectRatio, and treatment.',
      );
    }
    return { productId: rec.productId, aspectRatio: rec.aspectRatio, treatment: rec.treatment };
  });
}

/** Load and parse a brief from a .yaml / .yml / .json file. */
export async function loadBrief(path: string): Promise<CampaignBrief> {
  const raw = await readFile(path, "utf8");
  const data = extname(path).toLowerCase() === ".json" ? JSON.parse(raw) : yaml.load(raw);
  return parseBrief(data);
}
