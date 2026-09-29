import {
  isReservedCampaignId,
  slugify,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
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
import type { StoredBrief } from "../../../../lib/ports/brief-store.port.js";
import {
  assertOwnedCampaign,
  assertSourceVisible,
  CampaignNotFoundError,
  resolveCampaignRef,
} from "../../../../lib/ownership.js";

import { requestTenant } from "../../../../lib/tenant.js";

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Marks an EEXIST raised while claiming the CANDIDATE slug itself (via
 * `reserveMinted`) — the only failure `withDerivedSlug`'s retry loop may
 * retry past (PT-5b2 fix-round item 3). A conflict raised AFTER a
 * successful reservation is a real, reportable conflict, never a taken
 * candidate to skip past.
 */
class SlugTakenError extends Error {}

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
 * Derive a slug from `name` (D178: the server derives the slug, the same
 * rule `routes/campaigns/index.post.ts` uses — duplicated here rather than
 * imported, since a route file is not a shared module; keep the two copies
 * in step by eye) and hand each candidate to `attempt` until one is not
 * taken: the base, then `-2`, `-3`, … — skipping a reserved id and a
 * uuid-shaped candidate (D178: it would collide with ref resolution, #613) —
 * staying within 64 characters by trimming the base before the suffix. Only
 * a `SlugTakenError` retries the next suffix; any other failure — including
 * an ordinary EEXIST `attempt` raises for a reason other than the candidate
 * itself being taken — propagates immediately. The caller guarantees
 * `slugify(name)` is non-empty before calling.
 *
 * PT-5c2: `newId` (the client-minted target) retired with this lane — the
 * web has sent `name` only since PT-5c1, and the API accepts nothing else
 * (D177, D178: no client may mint a campaign id).
 */
async function withDerivedSlug<T>(name: string, attempt: (slug: string) => Promise<T>): Promise<T> {
  const base = slugify(name);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const candidate = suffix ? `${base.slice(0, 64 - suffix.length)}${suffix}` : base;
    if (isReservedCampaignId(candidate) || CANONICAL_UUID_PATTERN.test(candidate)) continue;
    try {
      return await attempt(candidate);
    } catch (error) {
      if (!(error instanceof SlugTakenError)) throw error;
    }
  }
}

/**
 * POST /campaigns/briefs/:id/duplicate — copy a brief to a server-derived slug.
 *
 * Body is `{ name, overrides? }` (PT-5b2, D178: the server derives the slug
 * by the same rule `POST /campaigns` uses, deduplicated per org — the caller
 * never picks an id). `name` is required (400 otherwise). `overrides`
 * accepts `targetRegion` and `targetAudience` only (D71) and wins over the
 * source. Source is looked up by `brief.id` (filename may differ). 404 if
 * the source is missing; writes stay under `projectRoot()/briefs/`.
 * Copies any brief-scoped assets (`assets/inputs/<id>/*`) into `assets/inputs/<target>/*`
 * and rewrites logoPath and inputAsset, while leaving shared root assets untouched (L5.5).
 * The copy pool is copied too (D71/C9), rewritten to name the new brief — a
 * duplicated `pool://copy` source otherwise plans against a file that never existed.
 * The copy inherits the source campaign's own team (PT-5b2 fix-round item 1,
 * security) — this route accepts no explicit `teamId`.
 *
 * D166 item 2: the source brief's own asset-scoped fields may in turn name a
 * THIRD campaign's id as an asset source (`extractSourceAssetBriefIds`) —
 * each such id is checked with `assertSourceVisible` before its assets are
 * copied, same as `briefs.post.ts`'s "Save as…". PT-5b2 fix-round item 2:
 * this check, and resolving the source pool, run ONCE against `sourceSlug`/
 * `template` before any target slug is ever claimed — a hidden reference or
 * a malformed pool answers 404/422 without minting anything to release.
 *
 * D166 item 3 / D177 (PT-5b2): the target's own availability is claimed
 * BEFORE any copy or write, rather than relying on `createBrief`'s eventual
 * EEXIST — an existing-but-hidden target must never have its asset directory
 * written into ahead of that conflict. `createCampaign` claims it: the only
 * check that also sees an fs reserved directory (D179, a blank
 * `POST /campaigns` create) — `campaignVisibility` cannot, since it answers
 * on file existence alone — and, on Postgres, mints the versionless row this
 * write's own `createBrief` call then completes as its first Save (D177).
 * PT-5b2 fix-round items 2/3: once that reservation succeeds, a later
 * failure (asset copy, the first-version `createBrief`, the pool write)
 * releases it (`releaseCampaign`, `deleteAssets`) and propagates as-is —
 * never retried onto a different suffix, even when the failure is itself
 * EEXIST-shaped (a concurrent writer's own Save racing this exact slug).
 *
 * PT-5b3 (D168, D177): `createCampaign` also stores the typed name and the
 * SOURCE's own type (`template.type`), the same rule
 * `routes/campaigns/index.post.ts` uses for a sourced create.
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

  let name: string;
  let overrides: unknown;
  try {
    const body: unknown = await readBody(event);
    const record =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
    const rawName = record?.name;
    if (typeof rawName !== "string") {
      throw new Error('"name" is required.');
    }
    if (slugify(rawName) === "") {
      throw new Error('"name" must contain at least one letter or digit.');
    }
    name = rawName;
    overrides = record?.overrides;
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  // Resolve a uuid source to its slug on a backend that has one (D178). On fs
  // the id IS the slug (D179) and findBriefById below matches by slug only —
  // skipping this call there avoids scanning the whole brief directory twice
  // for the same source (once here, once in assertOwnedCampaign below).
  const briefs = getBriefStore(scope);
  let sourceSlug = id;
  // PT-5b2 fix-round item 1 (security): a copy inherits the SOURCE's own
  // team — the same visibility the caller could already see (they just
  // proved they own `sourceSlug`), never a widening to org-wide by omission.
  // `undefined` here (fs, or the theoretically-unreachable "hidden after we
  // just asserted ownership") behaves like "no team" for a fresh insert.
  let sourceTeamId: string | null | undefined;
  if (briefs.supportsTeams) {
    try {
      sourceSlug = await resolveCampaignRef(scope, id);
    } catch (error) {
      if (error instanceof CampaignNotFoundError) {
        setResponseStatus(event, 404);
        return { error: `Brief "${id}" not found.` };
      }
      throw error;
    }
    sourceTeamId = await briefs.campaignTeam(sourceSlug);
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

  // D71 — overrides are merged and validated HERE, before any write attempt,
  // in their own try/catch, so parseBrief's answer is a 400 — never inside
  // `attempt` below, where the outer catch only maps SYMLINK/EEXIST/
  // InvalidCopyPoolError, and a parse failure would surface as an uncaught
  // 500 instead. Validated once against the SOURCE's own (already-safe) id
  // as a placeholder: every candidate this route ever tries is SAFE_ID-shaped
  // by construction (`withDerivedSlug`'s own derivation), and nothing else
  // parseBrief checks depends on `id`'s value (`load-brief.ts:1216` only
  // checks its shape) — so each attempt just swaps `id` into the validated
  // object, rather than re-parsing per candidate. `mode` is deliberately NOT
  // an override: a classic source
  // overridden to "variation" needs a `variation.count` that parseBrief
  // requires and that is an editor default ("12"), not this route's to
  // invent; the reverse direction leaves the source's `variation` block in
  // the file, structurally valid but inert. The copy inherits the source's
  // mode.
  let template: CampaignBrief;
  try {
    template = parseBrief({ ...source.brief, ...overrideValues(overrides), id: sourceSlug });
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  // PT-5b2 fix-round item 2 (coderabbit PRRT_kwDOSzP1zc6mgBvA): resolve the
  // source pool and check every additional source id's visibility BEFORE any
  // target slug is ever claimed — these depend only on `sourceSlug`/
  // `template`, not on which candidate eventually wins, so a malformed pool
  // or a hidden reference 422s/404s without minting (and then having to
  // release) a versionless row or directory for nothing.
  let sourcePool;
  try {
    sourcePool = await readPool(scope, sourceSlug);
  } catch (error) {
    if (!(error instanceof InvalidCopyPoolError)) throw error;
    setResponseStatus(event, 422);
    return { error: error.message };
  }
  const additionalSourceIds = extractSourceAssetBriefIds(template, sourceSlug).filter(
    (fromId) => fromId !== sourceSlug,
  );
  try {
    for (const fromId of additionalSourceIds) {
      await assertSourceVisible(scope, fromId);
    }
  } catch (error) {
    if (error instanceof CampaignNotFoundError) {
      setResponseStatus(event, 404);
      return { error: `Brief "${error.campaignId}" not found.` };
    }
    throw error;
  }

  /**
   * Claim `targetSlug` with `createCampaign` (D177/D179: also sees an fs
   * reserved directory, the only check that does — `campaignVisibility`
   * answers on file existence alone), then copy the source's assets and pool
   * into it and write it as version 1. An EEXIST from `createCampaign`
   * itself means the candidate is taken (`SlugTakenError`, retried by
   * `withDerivedSlug`); ANY later failure means the reservation held and
   * this failure is real — released (`releaseCampaign`, `deleteAssets`) and
   * propagated unmodified, never retried onto a different suffix.
   * `displayName` (PT-5b3, D168, D177) is the name the caller typed; `type`
   * is the SOURCE's own (`template.type`), the same rule
   * `routes/campaigns/index.post.ts` uses for a sourced create.
   */
  const attempt = async (targetSlug: string, displayName: string): Promise<StoredBrief> => {
    return getBriefStore(scope).withBriefLock(targetSlug, async () => {
      if (await isPoolDirSymlink(scope, targetSlug)) {
        throw new Error(SYMLINK_WRITE_ERROR);
      }
      try {
        await getBriefStore(scope).createCampaign(targetSlug, {
          teamId: sourceTeamId,
          name: displayName,
          type: template.type,
        });
      } catch (error) {
        if (isExistsError(error)) throw new SlugTakenError();
        throw error;
      }
      try {
        let brief: CampaignBrief = { ...template, id: targetSlug };
        const sourceMap = await getAssetStore(scope).copyAssets(sourceSlug, targetSlug);
        brief = rewriteAssetPaths(brief, sourceSlug, targetSlug, sourceMap);
        for (const fromId of additionalSourceIds) {
          const addMap = await getAssetStore(scope).copyAssets(fromId, targetSlug);
          brief = rewriteAssetPaths(brief, fromId, targetSlug, addMap);
        }

        // The pool first and version 1 last, both under the pool lock (a
        // different map from the brief lock above, so without it a
        // concurrent POST /campaigns/pools/:targetSlug could interleave): a
        // pool failure then leaves nothing versioned, so the reservation
        // below is still releasable. The source pool needs no lock:
        // writePool renames atomically.
        return await withPoolLock(scope, targetSlug, async () => {
          if (sourcePool) {
            await copyPool(scope, sourceSlug, targetSlug);
          } else {
            await deletePool(scope, targetSlug);
          }
          return getBriefStore(scope).createBrief(brief, { teamId: sourceTeamId });
        });
      } catch (error) {
        // The pool lives inside the same reserved directory `releaseCampaign`
        // removes on fs (D177/D179): deleted first (a no-op if nothing was
        // ever written), or its own `rmdir` would refuse a non-empty directory.
        await withPoolLock(scope, targetSlug, () => deletePool(scope, targetSlug));
        const released = await getBriefStore(scope).releaseCampaign(targetSlug);
        // Only when the campaign itself is gone too, never after a real,
        // versioned brief.
        if (released) await getAssetStore(scope).deleteAssets(targetSlug);
        throw error;
      }
    });
  };

  try {
    const created = await withDerivedSlug(name, (slug) => attempt(slug, name));
    setResponseStatus(event, 201);
    return { file: created.file, brief: created.brief };
  } catch (error) {
    // X22 — the symlink refusal from createBrief must answer 400 exactly like
    // briefs.post.ts and briefs/[id].put.ts; it used to re-throw into a 500.
    if (errorMessage(error) === SYMLINK_WRITE_ERROR) {
      setResponseStatus(event, 400);
      return { error: errorMessage(error) };
    }
    // The legacy path's own reserveVisible conflict, or (PT-5b2 fix-round
    // items 3/5) a post-reservation conflict on the `name` path — never
    // retried, and the message already names the slug that conflicted
    // (the store's own error), never the raw `name` (qodo PRRT_kwDOSzP1zc6mgAEv).
    if (isExistsError(error)) {
      setResponseStatus(event, 409);
      return { error: errorMessage(error) };
    }
    if (!(error instanceof InvalidCopyPoolError)) throw error;
    setResponseStatus(event, 422);
    return { error: error.message };
  }
});
