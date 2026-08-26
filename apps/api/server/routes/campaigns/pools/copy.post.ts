import {
  CopyGeneratorError,
  mergePool,
  type CampaignBrief,
  type CopyPool,
  type CopyPoolEntry,
} from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import { BrandComplianceChecker } from "@campaignfoundry/GovernanceAndCompliance";
import { findBriefById, SYMLINK_WRITE_ERROR } from "../../../lib/brief-files.js";
import { assertSafeId, parseBrief } from "../../../lib/load-brief.js";
import { copyGenerator } from "../../../lib/pipeline.js";
import { InvalidCopyPoolError, isPoolDirSymlink, readPool, withPoolLock, writePool } from "../../../lib/pools.js";

const DEFAULT_COUNT = 10;
const MAX_COUNT = 25;
/** Longest headline the compositor is briefed for; the model is told the same. */
const MAX_HEADLINE_CHARS = 60;

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

/** Trimmed, non-empty, ≤ 60 chars, de-duplicated by normalised text. */
function usableTexts(headlines: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of headlines) {
    const text = raw.trim();
    if (!text || text.length > MAX_HEADLINE_CHARS) continue;
    const key = normalisedText(text);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(text);
  }
  return unique;
}

/** Drop texts already in the pool (same normalised identity `mergePool` uses). */
function newTexts(texts: readonly string[], existing: readonly { text: string }[]): string[] {
  const taken = new Set(existing.map((entry) => normalisedText(entry.text)));
  return texts.filter((text) => !taken.has(normalisedText(text)));
}

interface HttpFailure {
  readonly status: number;
  readonly body: { error: string };
  readonly retryAfterSeconds?: number;
}

/** Map a generator failure to a sanitised HTTP reply — never echo upstream bodies. */
function mapGeneratorError(error: CopyGeneratorError): HttpFailure {
  switch (error.kind) {
    case "missing_key":
      return { status: 503, body: { error: "OPENROUTER_API_KEY is not set" } };
    case "auth":
      return { status: 502, body: { error: "OpenRouter rejected the configured API key" } };
    case "rate_limited":
      return error.retryAfterSeconds === undefined
        ? { status: 503, body: { error: "OpenRouter is rate limiting copy generation" } }
        : {
            status: 429,
            body: { error: "OpenRouter is rate limiting copy generation" },
            retryAfterSeconds: error.retryAfterSeconds,
          };
    case "network":
      return { status: 503, body: { error: "OpenRouter could not be reached" } };
    case "malformed":
      return { status: 422, body: { error: "Copy generator returned an unreadable response" } };
    case "upstream":
      return { status: 502, body: { error: "OpenRouter returned an error" } };
  }
}

/**
 * POST /campaigns/pools/copy — generate headlines, legal-gate each, persist the pool.
 *
 * Body `{ briefId, count? }` for a saved brief, or `{ brief, count? }` with the
 * brief inline (validated like generate; the pool is stored under `brief.id`),
 * so the wizard can curate a pool before the brief is saved. Default count 10,
 * max 25. Reply `{ pool, added }`: 201 when new entries were persisted, 200
 * (`added: 0`, no write) when the model only repeated known headlines. 404
 * unknown `briefId`, 503 without OPENROUTER_API_KEY, 422 if the generator
 * returned nothing usable at all.
 * Upstream failures: 502 auth/other, 429 (+ Retry-After) or 503 rate limit,
 * 503 network/timeout, 422 unreadable body. Approved entries feed the planner
 * when a brief sets `variation.axes.headline: pool://copy` (see lib/pools.ts).
 */
export default defineEventHandler(async (event) => {
  let brief: CampaignBrief | undefined;
  let briefId: string;
  let count: number;
  try {
    const body: unknown = await readBody(event);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("Request body must be an object.");
    }
    const record = body as Record<string, unknown>;
    if (record.brief !== undefined) {
      brief = parseBrief(record.brief);
      briefId = brief.id;
    } else {
      assertSafeId(record.briefId, "briefId");
      briefId = record.briefId;
    }
    count = parseCount(record.count);
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  if (brief === undefined) {
    const found = await findBriefById(briefId);
    if (!found) {
      setResponseStatus(event, 404);
      return { error: `Brief "${briefId}" not found.` };
    }
    brief = found.brief;
  }
  if (await isPoolDirSymlink(briefId)) {
    setResponseStatus(event, 400);
    return { error: SYMLINK_WRITE_ERROR };
  }

  const generator = copyGenerator();
  if (!generator) {
    setResponseStatus(event, 503);
    return { error: "OPENROUTER_API_KEY is not set" };
  }

  let suggested: readonly string[];
  try {
    suggested = await generator.suggestHeadlines({ brief, count });
  } catch (error) {
    if (!(error instanceof CopyGeneratorError)) throw error;
    const failure = mapGeneratorError(error);
    setResponseStatus(event, failure.status);
    if (failure.retryAfterSeconds !== undefined) setHeader(event, "retry-after", failure.retryAfterSeconds);
    return failure.body;
  }
  const usable = usableTexts(suggested);
  if (usable.length === 0) {
    setResponseStatus(event, 422);
    return { error: "Copy generator returned no usable headlines" };
  }

  // The slow LLM call is done; read→merge→write is serialised per brief so a
  // concurrent request's entries are merged into, never overwritten.
  return withPoolLock(briefId, async () => {
    let existing: CopyPool | undefined;
    try {
      existing = await readPool(briefId);
    } catch (error) {
      if (!(error instanceof InvalidCopyPoolError)) throw error;
      setResponseStatus(event, 422);
      return { error: error.message };
    }
    const headlines = newTexts(usable, existing?.entries ?? []).slice(0, count);
    if (headlines.length === 0 && existing) {
      return { pool: existing, added: 0 };
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
    return { pool: next, added: headlines.length };
  });
});
