import type { CopyPool, CopyPoolEntry, CopyPoolEntryStatus } from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import { BrandComplianceChecker } from "@campaignfoundry/GovernanceAndCompliance";
import { SYMLINK_WRITE_ERROR } from "../../../lib/brief-files.js";
import { assertSafeId } from "../../../lib/load-brief.js";
import { isPoolDirSymlink, readPool, withPoolLock, writePool } from "../../../lib/pools.js";

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
  const ids = new Set<string>();
  return entries.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`entries[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw new Error(`entries[${index}].id must be a non-empty string`);
    }
    if (ids.has(record.id)) {
      throw new Error(`entries[${index}].id "${record.id}" appears more than once`);
    }
    ids.add(record.id);
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

function normalisedText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Apply one patch. Edited or newly-approved text is re-run through the legal
 * gate: a failure forces `rejected` with the new reason; a pass clears any
 * stale reason (a HITL `rejected` without text keeps its reason).
 */
async function applyPatch(current: CopyPoolEntry, patch: EntryPatch): Promise<CopyPoolEntry> {
  const text = patch.text ?? current.text;
  let status = patch.status;
  let reason = status === "approved" ? undefined : current.reason;
  if (patch.text !== undefined || status === "approved") {
    const legal = await new BrandComplianceChecker().validateLegalCopy(text);
    if (legal.passed) {
      reason = undefined;
    } else {
      status = "rejected";
      reason = legal.reason;
    }
  }
  return reason === undefined ? { id: current.id, text, status } : { id: current.id, text, status, reason };
}

/** The id of another entry whose normalised text matches `text`, if any. */
function collidingId(entries: readonly CopyPoolEntry[], id: string, text: string): string | undefined {
  const key = normalisedText(text);
  return entries.find((entry) => entry.id !== id && normalisedText(entry.text) === key)?.id;
}

/**
 * PATCH /campaigns/pools/:briefId — HITL approve/reject/edit by entry id.
 * Edited or newly-approved text is re-run through the legal gate; a legal
 * failure is persisted as rejected with a reason (not 422) so HITL can see why.
 * An edit that duplicates another entry's text is a 422 naming that entry.
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

  if (await isPoolDirSymlink(briefId)) {
    setResponseStatus(event, 400);
    return { error: SYMLINK_WRITE_ERROR };
  }

  return withPoolLock(briefId, async () => {
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
    if (patches.length === 0) {
      return { pool };
    }

    let entries: readonly CopyPoolEntry[] = pool.entries;
    for (const patch of patches) {
      entries = await Promise.all(
        entries.map(async (entry) => (entry.id === patch.id ? applyPatch(entry, patch) : entry)),
      );
    }
    for (const patch of patches) {
      if (patch.text === undefined) continue;
      const other = collidingId(entries, patch.id, patch.text);
      if (other !== undefined) {
        setResponseStatus(event, 422);
        return { error: `Edited text for entry "${patch.id}" duplicates entry "${other}".` };
      }
    }

    const next: CopyPool = { ...pool, entries };
    await writePool(next);
    return { pool: next };
  });
});
