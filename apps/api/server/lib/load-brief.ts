import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import * as yaml from "js-yaml";
import type { CampaignBrief } from "@campaignforge/CampaignOrchestration";

const REQUIRED_FIELDS = ["id", "targetRegion", "targetAudience", "campaignMessage", "products"] as const;

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
  return record as unknown as CampaignBrief;
}

/** Load and parse a brief from a .yaml / .yml / .json file. */
export async function loadBrief(path: string): Promise<CampaignBrief> {
  const raw = await readFile(path, "utf8");
  const data = extname(path).toLowerCase() === ".json" ? JSON.parse(raw) : yaml.load(raw);
  return parseBrief(data);
}
