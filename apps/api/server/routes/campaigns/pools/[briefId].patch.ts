import type { CopyPool, CopyPoolEntry, CopyPoolEntryStatus } from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import { BrandComplianceChecker } from "@campaignfoundry/GovernanceAndCompliance";
import { assertSafeId } from "../../../lib/load-brief.js";
import { readPool, writePool } from "../../../lib/pools.js";

interface EntryPatch {
  readonly id: string;
  readonly status: CopyPoolEntryStatus;
  readonly text?: string;
}

function parsePatches(body: unknown): EntryPatch[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Request body must be an object.");
  }
  const entries = (body as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error("entries must be an array");
  }
  return entries.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`entries[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw new Error(`entries[${index}].id must be a non-empty string`);
    }
    if (record.status !== "approved" && record.status !== "rejected") {
      throw new Error(`entries[${index}].status must be "approved" or "rejected"`);
    }
    if (record.text !== undefined && typeof record.text !== "string") {
      throw new Error(`entries[${index}].text must be a string`);
    }
    const text = record.text === undefined ? undefined : record.text.trim();
    if (text !== undefined && text.length === 0) {
      throw new Error(`entries[${index}].text must be a non-empty string`);
    }
    return { id: record.id, status: record.status, text };
  });
}

async function applyPatch(current: CopyPoolEntry, patch: EntryPatch): Promise<CopyPoolEntry> {
  const text = patch.text ?? current.text;
  let status = patch.status;
  let reason = status === "approved" ? undefined : current.reason;
  if (patch.text !== undefined || status === "approved") {
    const legal = await new BrandComplianceChecker().validateLegalCopy(text);
    if (!legal.passed) {
      status = "rejected";
      reason = legal.reason;
    } else if (status === "approved") {
      reason = undefined;
    }
  }
  return reason === undefined ? { id: current.id, text, status } : { id: current.id, text, status, reason };
}

/**
 * PATCH /campaigns/pools/:briefId — HITL approve/reject/edit by entry id.
 * Edited or newly-approved text is re-run through the legal gate; a legal
 * failure is persisted as rejected with a reason (not 422) so HITL can see why.
 */
export default defineEventHandler(async (event) => {
  let briefId: string;
  try {
    briefId = String(getRouterParam(event, "briefId"));
    assertSafeId(briefId, "briefId");
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  let patches: EntryPatch[];
  try {
    patches = parsePatches(await readBody(event));
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  const pool = await readPool(briefId);
  if (!pool) {
    setResponseStatus(event, 404);
    return { error: `Copy pool for brief "${briefId}" not found.` };
  }

  const byId = new Map(pool.entries.map((entry) => [entry.id, entry]));
  for (const patch of patches) {
    if (!byId.has(patch.id)) {
      setResponseStatus(event, 404);
      return { error: `Copy pool entry "${patch.id}" not found.` };
    }
  }

  let entries: readonly CopyPoolEntry[] = pool.entries;
  for (const patch of patches) {
    entries = await Promise.all(
      entries.map(async (entry) => (entry.id === patch.id ? applyPatch(entry, patch) : entry)),
    );
  }

  const next: CopyPool = { ...pool, entries };
  await writePool(next);
  return { pool: next };
});
