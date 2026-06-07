import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import * as yaml from "js-yaml";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";

const REQUIRED_FIELDS = ["id", "targetRegion", "targetAudience", "campaignMessage", "products"] as const;

const LAYOUTS = ["headline-bottom", "headline-top"] as const;
const TONES = ["bold", "subtle"] as const;
/**
 * Treatment ids become a filesystem path segment (`<product>/<ratio>/<id>.png`)
 * and the stable asset identity, and the brief is untrusted input. Constrain ids
 * to a path-safe slug so a malformed brief is a clean 400 here, not a late export
 * crash (the exporter's traversal guard would otherwise be the only line of
 * defence, failing mid-run).
 */
const TREATMENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Structurally validate the optional `treatments` array, when present. */
function validateTreatments(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error('Campaign brief field "treatments" must be an array.');
  }
  const seen = new Set<string>();
  for (const t of value) {
    const rec = t as Record<string, unknown>;
    if (typeof rec?.id !== "string" || !TREATMENT_ID.test(rec.id)) {
      throw new Error(
        `Treatment id must be a path-safe slug (lowercase letters, digits, hyphens; max 64 chars); got ${JSON.stringify(rec?.id)}.`,
      );
    }
    if (seen.has(rec.id)) {
      throw new Error(`Duplicate treatment id "${rec.id}" — ids must be unique within a brief.`);
    }
    seen.add(rec.id);
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
