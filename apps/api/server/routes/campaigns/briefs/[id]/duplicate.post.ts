import { isReservedCampaignId, type CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import { extractSourceAssetBriefIds, rewriteAssetPaths } from "../../../../lib/asset-files.js";
import { isExistsError, SYMLINK_WRITE_ERROR } from "../../../../lib/brief-files.js";
import { assertSafeId, parseBrief } from "../../../../lib/load-brief.js";
import {
  copyPool,
  deletePool,
  InvalidCopyPoolError,
  isPoolDirSymlink,
  readPool,
  withPoolLock,
} from "../../../../lib/pools.js";
import { getAssetStore, getBriefStore } from "../../../../lib/ports/index.js";
import {
  assertOwnedCampaign,
  assertSourceVisible,
  CampaignNotFoundError,
  resolveCampaignRef,
} from "../../../../lib/ownership.js";

import { requestTenant } from "../../../../lib/tenant.js";
/** The duplicate contract's overrides: `targetRegion` and `targetAudience` only. */
function overrideValues(overrides: unknown): Record<string, unknown> {
  if (overrides === undefined || overrides === null) return {};
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error('"overrides" must be an object.');
  }
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key !== "targetRegion" && key !== "targetAudience") {
      throw new Error('"overrides" accepts "targetRegion" and "targetAudience" only.');
    }
    picked[key] = value;
  }
  return picked;
}

/**
 * POST /campaigns/briefs/:id/duplicate — copy a yaml/yml/json brief to `briefs/<newId>.yaml`.
 *
 * Body `{ newId, overrides? }` must be path-safe; `overrides` accepts
 * `targetRegion` and `targetAudience` only (D71) and wins over the source.
 * Source is looked up by `brief.id` (filename may differ). 404 if the source
 * is missing, 409 if any file already has `newId`. The copy gets `id: newId`;
 * writes stay under `projectRoot()/briefs/`.
 * Copies any brief-scoped assets (`assets/inputs/<id>/*`) into `assets/inputs/<newId>/*`
 * and rewrites logoPath and inputAsset, while leaving shared root assets untouched (L5.5).
 * The copy pool is copied too (D71/C9), rewritten to name the new brief — a
 * duplicated `pool://copy` source otherwise plans against a file that never existed.
 *
 * D166 item 2: the source brief's own asset-scoped fields may in turn name a
 * THIRD campaign's id as an asset source (`extractSourceAssetBriefIds`) —
 * each such id is checked with `assertSourceVisible` before its assets are
 * copied, same as `briefs.post.ts`'s "Save as…".
 *
 * D166 item 3: `newId`'s own visibility is checked with `campaignVisibility`
 * before any copy or write, rather than relying on `createBrief`'s eventual
 * EEXIST — an existing-but-hidden `newId` must never have its asset directory
 * written into ahead of that conflict.
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);
  let id: string;
  try {
    id = String(getRouterParam(event, "id"));
    assertSafeId(id, "Campaign id");
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  let newId: string;
  let overrides: unknown;
  try {
    const body: unknown = await readBody(event);
    const record =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
    const value = record?.newId;
    assertSafeId(value, "newId");
    if (isReservedCampaignId(value)) {
      throw new Error(`"${value}" is reserved; choose another campaign id.`);
    }
    newId = value;
    overrides = record?.overrides;
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  let sourceSlug: string;
  try {
    sourceSlug = await resolveCampaignRef(scope, id);
  } catch (error) {
    if (error instanceof CampaignNotFoundError) {
      setResponseStatus(event, 404);
      return { error: `Brief "${id}" not found.` };
    }
    throw error;
  }

  let source;
  try {
    source = await assertOwnedCampaign(scope, sourceSlug);
  } catch (error) {
    if (error instanceof CampaignNotFoundError) {
      setResponseStatus(event, 404);
      return { error: `Brief "${id}" not found.` };
    }
    throw error;
  }

  if (await isPoolDirSymlink(scope, newId)) {
    setResponseStatus(event, 400);
    return { error: SYMLINK_WRITE_ERROR };
  }

  // D71 — overrides are merged and validated HERE, before the lock, in their own
  // try/catch, so parseBrief's answer is a 400. A failure inside withBriefLock
  // surfaces through the outer catch below as a 500 (only EEXIST is mapped there,
  // and briefs.test.ts pins that 500 for the write-failure path) — validation
  // never moves inside it. `mode` is deliberately NOT an override: a classic
  // source overridden to "variation" needs a `variation.count` that parseBrief
  // requires and that is an editor default ("12"), not this route's to invent;
  // the reverse direction leaves the source's `variation` block in the file,
  // structurally valid but inert. The copy inherits the source's mode.
  let brief: CampaignBrief;
  try {
    brief = parseBrief({ ...source.brief, ...overrideValues(overrides), id: newId });
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  try {
    const created = await getBriefStore(scope).withBriefLock(newId, async () => {
      // D166 item 3: checked via campaignVisibility, not findBriefById, so an
      // existing-but-hidden newId also 409s here — BEFORE any copy — instead
      // of surviving this check (findBriefById answers undefined for a hidden
      // campaign too) and having its asset directory written into ahead of
      // createBrief's eventual EEXIST.
      if ((await getBriefStore(scope).campaignVisibility(newId)) !== "absent") {
        const existErr = new Error(`Brief "${newId}" already exists.`);
        (existErr as { code?: string }).code = "EEXIST";
        throw existErr;
      }

      // Resolve the source pool first so a malformed source throws
      // InvalidCopyPoolError before any dest write (the 422 path must leave
      // the destination brief absent). createBrief is exclusive (wx); writing
      // the dest pool first left an orphan when the dest file existed but was
      // unparseable — findBriefById skips those, then wx turns into a 409.
      const sourcePool = await readPool(scope, sourceSlug);

      // D166 item 2 (PT-2c, greptile thread U90U): every additional source id
      // — extracted from the ORIGINAL brief, before the primary source's own
      // paths below are rewritten off `id` — is checked for visibility BEFORE
      // any copy runs, including the primary source's `copyAssets(id, newId)`
      // just below. Checking it only after that first copy let a hidden
      // second source's 404 leave the primary source's files already written
      // into `newId`'s asset directory, with no brief ever created to own
      // them — checking everything first, copying everything after, matches
      // briefs.post.ts's Save-as loop.
      const additionalSourceIds = extractSourceAssetBriefIds(brief, newId).filter(
        (fromId) => fromId !== sourceSlug,
      );
      for (const fromId of additionalSourceIds) {
        await assertSourceVisible(scope, fromId);
      }

      // Copy assets from source brief to new brief, and any referenced brief-scoped assets
      const sourceMap = await getAssetStore(scope).copyAssets(sourceSlug, newId);
      brief = rewriteAssetPaths(brief, sourceSlug, newId, sourceMap);
      for (const fromId of additionalSourceIds) {
        const addMap = await getAssetStore(scope).copyAssets(fromId, newId);
        brief = rewriteAssetPaths(brief, fromId, newId, addMap);
      }

      const created = await getBriefStore(scope).createBrief(brief);
      // The dest pool write (or the stale-pool delete when the source has none)
      // runs under withPoolLock(newId) as well as the brief lock: they are
      // different maps, so without it a concurrent POST /campaigns/pools/:newId
      // could interleave. The source pool needs no lock: writePool renames atomically.
      await withPoolLock(scope, newId, async () => {
        if (sourcePool) {
          await copyPool(scope, sourceSlug, newId);
        } else {
          await deletePool(scope, newId);
        }
      });
      return created;
    });
    setResponseStatus(event, 201);
    return { file: created.file, brief: created.brief };
  } catch (error) {
    // X22 — the symlink refusal from createBrief must answer 400 exactly like
    // briefs.post.ts and briefs/[id].put.ts; it used to re-throw into a 500.
    if (errorMessage(error) === SYMLINK_WRITE_ERROR) {
      setResponseStatus(event, 400);
      return { error: errorMessage(error) };
    }
    if (isExistsError(error)) {
      setResponseStatus(event, 409);
      return { error: `Brief "${newId}" already exists.` };
    }
    // D166 item 2: an additional source id hidden from this caller by team.
    if (error instanceof CampaignNotFoundError) {
      setResponseStatus(event, 404);
      return { error: `Brief "${error.campaignId}" not found.` };
    }
    if (!(error instanceof InvalidCopyPoolError)) throw error;
    setResponseStatus(event, 422);
    return { error: error.message };
  }
});
