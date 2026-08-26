import { mergePool, type CopyPool, type CopyPoolEntry } from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import { BrandComplianceChecker } from "@campaignfoundry/GovernanceAndCompliance";
import { findBriefById } from "../../../lib/brief-files.js";
import { assertSafeId } from "../../../lib/load-brief.js";
import { copyGenerator } from "../../../lib/pipeline.js";
import { readPool, writePool } from "../../../lib/pools.js";

const DEFAULT_COUNT = 10;
const MAX_COUNT = 25;

function parseCount(value: unknown): number {
  const count = value === undefined ? DEFAULT_COUNT : value;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new Error(`count must be an integer between 1 and ${MAX_COUNT}`);
  }
  return count;
}

function allocateIds(count: number, taken: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  let n = 1;
  while (ids.length < count) {
    const id = `h${n}`;
    n += 1;
    if (!taken.has(id)) ids.push(id);
  }
  return ids;
}

async function gateEntries(
  texts: readonly string[],
  takenIds: ReadonlySet<string>,
): Promise<CopyPoolEntry[]> {
  const compliance = new BrandComplianceChecker();
  const ids = allocateIds(texts.length, takenIds);
  const entries: CopyPoolEntry[] = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const result = await compliance.validateLegalCopy(text);
    entries.push(
      result.passed
        ? { id: ids[i], text, status: "approved" }
        : { id: ids[i], text, status: "rejected", reason: result.reason },
    );
  }
  return entries;
}

function normalisedText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function usableTexts(headlines: readonly string[], existing: readonly { text: string }[]): string[] {
  const taken = new Set(existing.map((entry) => normalisedText(entry.text)));
  const unique: string[] = [];
  for (const raw of headlines) {
    const text = raw.trim();
    if (!text) continue;
    const key = normalisedText(text);
    if (taken.has(key)) continue;
    taken.add(key);
    unique.push(text);
  }
  return unique;
}

/**
 * POST /campaigns/pools/copy — generate headlines, legal-gate each, persist the pool.
 *
 * Body `{ briefId, count? }`. Default count 10, max 25. 404 unknown brief, 503
 * without OPENROUTER_API_KEY, 422 if the generator returns nothing usable.
 * Planner / `pool://` consumption is out of scope.
 */
export default defineEventHandler(async (event) => {
  let briefId: string;
  let count: number;
  try {
    const body: unknown = await readBody(event);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("Request body must be an object.");
    }
    const record = body as Record<string, unknown>;
    assertSafeId(record.briefId, "briefId");
    briefId = record.briefId;
    count = parseCount(record.count);
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  const found = await findBriefById(briefId);
  if (!found) {
    setResponseStatus(event, 404);
    return { error: `Brief "${briefId}" not found.` };
  }

  const generator = copyGenerator();
  if (!generator) {
    setResponseStatus(event, 503);
    return { error: "OPENROUTER_API_KEY is not set" };
  }

  const existing = await readPool(briefId);
  const headlines = usableTexts(
    await generator.suggestHeadlines({ brief: found.brief, count }),
    existing?.entries ?? [],
  );
  if (headlines.length === 0) {
    setResponseStatus(event, 422);
    return { error: "Copy generator returned no usable headlines" };
  }

  const incoming: CopyPool = {
    briefId,
    generatedAt: new Date().toISOString(),
    model: generator.model,
    entries: await gateEntries(headlines, new Set(existing?.entries.map((entry) => entry.id) ?? [])),
  };
  const next = mergePool(existing ?? incoming, incoming);
  await writePool(next);
  setResponseStatus(event, 201);
  return { pool: next };
});
