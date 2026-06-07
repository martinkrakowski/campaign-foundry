import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import * as yaml from "js-yaml";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";

const REQUIRED_FIELDS = ["id", "targetRegion", "targetAudience", "campaignMessage", "products"] as const;

const LAYOUTS = ["headline-bottom", "headline-top"] as const;
const TONES = ["bold", "subtle"] as const;

/** Structurally validate the optional `treatments` array, when present. */
function validateTreatments(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error('Campaign brief field "treatments" must be an array.');
  }
  for (const t of value) {
    const rec = t as Record<string, unknown>;
    if (typeof rec?.id !== "string" || rec.id.length === 0) {
      throw new Error("Each treatment requires a non-empty string \"id\".");
    }
    if (!LAYOUTS.includes(rec.layout as (typeof LAYOUTS)[number])) {
      throw new Error(`Treatment "${rec.id}" has invalid layout (expected one of ${LAYOUTS.join(", ")}).`);
    }
    if (!TONES.includes(rec.tone as (typeof TONES)[number])) {
      throw new Error(`Treatment "${rec.id}" has invalid tone (expected one of ${TONES.join(", ")}).`);
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
  validateTreatments(record.treatments);
  return record as unknown as CampaignBrief;
}

/** Load and parse a brief from a .yaml / .yml / .json file. */
export async function loadBrief(path: string): Promise<CampaignBrief> {
  const raw = await readFile(path, "utf8");
  const data = extname(path).toLowerCase() === ".json" ? JSON.parse(raw) : yaml.load(raw);
  return parseBrief(data);
}
