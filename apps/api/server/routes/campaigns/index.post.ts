import {
  CAMPAIGN_TYPES,
  isReservedCampaignId,
  slugify,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import { extractSourceAssetBriefIds, rewriteAssetPaths } from "../../lib/asset-files.js";
import { isErrno, isExistsError, SYMLINK_WRITE_ERROR } from "../../lib/brief-files.js";
import { parseBrief } from "../../lib/load-brief.js";
import {
  copyPool,
  deletePool,
  InvalidCopyPoolError,
  isPoolDirSymlink,
  readPool,
  withPoolLock,
} from "../../lib/pools.js";
import { getAssetStore, getBriefStore, TeamsNotSupportedError } from "../../lib/ports/index.js";
import type { ResolvedCampaign, StoredBrief } from "../../lib/ports/brief-store.port.js";
import {
  assertOwnedCampaign,
  assertSourceVisible,
  canAssignTeam,
  CampaignNotFoundError,
  resolveCampaignRef,
} from "../../lib/ownership.js";

import { requestTenant } from "../../lib/tenant.js";

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Derive a slug from `name` (D178: the server derives the slug — the same
 * rule `duplicate.post.ts` uses, duplicated there rather than imported,
 * since a route file is not a shared module) and hand each candidate to
 * `attempt` until one is not taken: the base, then `-2`, `-3`, … — skipping a
 * reserved id and a uuid-shaped candidate (it would collide with D178's ref
 * resolution, #613) — staying within 64 characters by trimming the base
 * before the suffix. `attempt` performs the actual write; a collision is ITS
 * conflict signal (`isExistsError`), the same one two concurrent callers of
 * the same name race on, never a separate check-then-act read here. The
 * caller guarantees `slugify(name)` is non-empty before calling.
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
      if (!isExistsError(error)) throw error;
    }
  }
}

/**
 * POST /campaigns — mint a campaign (D177, D178). Body `{ name, type, source?, teamId? }`.
 *
 * The server derives the slug from `name` (the same rule `duplicate.post.ts`
 * uses), deduplicated per org: `-2`, `-3`, … — never a reserved id, never a
 * uuid-shaped candidate. A name that slugifies to empty answers 400.
 *
 * With no `source`: mints the campaign with no version yet — a Postgres row
 * with no `brief_version`, or a reserved `briefs/<slug>/` directory on fs
 * (D179) — through `createCampaign`. `type` is validated against the known
 * campaign types but not stored anywhere yet (D177's correction: a blank
 * brief cannot be a version, and `campaign` has no `type` column); the
 * eventual first Save's own brief body carries it, the same as any other
 * brief field.
 *
 * With a `source`: that campaign's latest version becomes version 1, exactly
 * as `duplicate.post.ts`'s `newId` path does today — brief-scoped assets and
 * the copy pool included. `type` is ignored; the copy carries the source
 * brief's own `type`.
 *
 * Answers 201 `{ campaignId, slug, revision? }` — `revision` only for a
 * sourced create, which writes a version; a blank create has none yet.
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);

  let name: string;
  let source: string | undefined;
  let teamId: string | null | undefined;
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

    const rawSource = record?.source;
    if (rawSource !== undefined) {
      if (typeof rawSource !== "string" || rawSource === "") {
        throw new Error('"source" must be a non-empty string.');
      }
      source = rawSource;
    }

    // Validated, but not stored anywhere yet (see the doc comment above) —
    // and not even validated for a sourced create: the copy carries the
    // source brief's own `type`, so a caller need not get this right when
    // `source` is set.
    const rawType = record?.type;
    if (source === undefined && rawType !== undefined) {
      if (typeof rawType !== "string" || !(CAMPAIGN_TYPES as readonly string[]).includes(rawType)) {
        throw new Error(`"type" must be one of: ${CAMPAIGN_TYPES.join(", ")}.`);
      }
    }

    // `null` (PT-5b2 fix-round item 1) clears a sourced create to org-wide
    // instead of inheriting the source's team — `canAssignTeam` below already
    // refuses it for anyone but an owner/admin, the same as `null` does for
    // `briefs/[id].put.ts`.
    const rawTeamId = record?.teamId;
    if (rawTeamId !== undefined) {
      if (rawTeamId !== null && typeof rawTeamId !== "string") {
        throw new Error('"teamId" must be a string or null.');
      }
      teamId = rawTeamId;
    }
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  const store = getBriefStore(scope);
  if (teamId !== undefined && !store.supportsTeams) {
    setResponseStatus(event, 400);
    return { error: new TeamsNotSupportedError().message };
  }
  if (teamId !== undefined && !canAssignTeam(scope, teamId)) {
    setResponseStatus(event, 403);
    return {
      error:
        teamId === null
          ? "Not authorized to clear this campaign's team."
          : `Not authorized to assign team "${teamId}".`,
    };
  }

  if (source === undefined) {
    try {
      const created = await withDerivedSlug(name, (slug) =>
        store.withBriefLock(slug, () => store.createCampaign(slug, { teamId })),
      );
      setResponseStatus(event, 201);
      return { campaignId: created.campaignId, slug: created.slug };
    } catch (error) {
      // `withDerivedSlug` never offers `createCampaign` a reserved or
      // uuid-shaped candidate (it skips both before ever calling `attempt`),
      // so the only realistic failure left is an unknown `teamId` — a typo,
      // or a team from another org — which `canAssignTeam`'s cheap,
      // membership-only check above cannot catch.
      if (isErrno(error, "EFORBIDDEN")) {
        setResponseStatus(event, 403);
        return { error: errorMessage(error) };
      }
      throw error;
    }
  }

  // Resolve a uuid source to its slug on a backend that has one (D178). On fs
  // the id IS the slug (D179), so no lookup runs there.
  let sourceSlug = source;
  // PT-5b2 fix-round item 1 (security): an explicit `teamId` (validated by
  // `canAssignTeam` above, including "explicit null clears to org-wide,
  // owner/admin only") wins; omitted, the copy inherits the SOURCE's own
  // team — the same visibility the caller could already see, never widened
  // to org-wide by omission.
  let sourceTeamId: string | null | undefined;
  if (store.supportsTeams) {
    try {
      sourceSlug = await resolveCampaignRef(scope, source);
    } catch (error) {
      if (error instanceof CampaignNotFoundError) {
        setResponseStatus(event, 404);
        return { error: `Brief "${source}" not found.` };
      }
      throw error;
    }
    sourceTeamId = await store.campaignTeam(sourceSlug);
  }
  const effectiveTeamId = teamId !== undefined ? teamId : sourceTeamId;

  let sourceBrief;
  try {
    sourceBrief = await assertOwnedCampaign(scope, sourceSlug);
  } catch (error) {
    if (error instanceof CampaignNotFoundError) {
      setResponseStatus(event, 404);
      return { error: `Brief "${source}" not found.` };
    }
    throw error;
  }

  // Validated once against the source's own (already-safe) id as a
  // placeholder — every candidate slug is SAFE_ID-shaped by construction
  // (`withDerivedSlug`), and nothing else `parseBrief` checks depends on
  // `id`'s value (`load-brief.ts:1216` only checks its shape) — so each
  // attempt below just swaps `id` in, the same reasoning `duplicate.post.ts`
  // uses for the same problem.
  let template: CampaignBrief;
  try {
    template = parseBrief({ ...sourceBrief.brief, id: sourceSlug });
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  /**
   * Mint `targetSlug` with `createCampaign` (the only check that also sees an
   * fs reserved directory, D179 — `campaignVisibility` cannot, since it
   * answers on file existence alone), then copy the source's assets and pool
   * into it and write it as version 1 — `createBrief`'s own first-save path
   * (D177) completes what `createCampaign` started. One lock for the whole
   * sequence: `createCampaign` no longer locks internally (it would deadlock
   * nested inside this one), by the same house convention `createBrief`
   * follows — the caller owns the lock.
   */
  const attempt = async (targetSlug: string): Promise<ResolvedCampaign & { revision: string }> => {
    if (await isPoolDirSymlink(scope, targetSlug)) {
      throw new Error(SYMLINK_WRITE_ERROR);
    }
    let brief: CampaignBrief = { ...template, id: targetSlug };
    return store.withBriefLock(targetSlug, async () => {
      await store.createCampaign(targetSlug, { teamId: effectiveTeamId });

      const sourcePool = await readPool(scope, sourceSlug);
      const additionalSourceIds = extractSourceAssetBriefIds(brief, targetSlug).filter(
        (fromId) => fromId !== sourceSlug,
      );
      for (const fromId of additionalSourceIds) {
        await assertSourceVisible(scope, fromId);
      }

      const sourceMap = await getAssetStore(scope).copyAssets(sourceSlug, targetSlug);
      brief = rewriteAssetPaths(brief, sourceSlug, targetSlug, sourceMap);
      for (const fromId of additionalSourceIds) {
        const addMap = await getAssetStore(scope).copyAssets(fromId, targetSlug);
        brief = rewriteAssetPaths(brief, fromId, targetSlug, addMap);
      }

      const created: StoredBrief = await store.createBrief(brief, { teamId: effectiveTeamId });
      await withPoolLock(scope, targetSlug, async () => {
        if (sourcePool) {
          await copyPool(scope, sourceSlug, targetSlug);
        } else {
          await deletePool(scope, targetSlug);
        }
      });
      return { campaignId: created.campaignId, slug: targetSlug, revision: created.revision };
    });
  };

  try {
    const created = await withDerivedSlug(name, attempt);
    setResponseStatus(event, 201);
    return { campaignId: created.campaignId, slug: created.slug, revision: created.revision };
  } catch (error) {
    if (errorMessage(error) === SYMLINK_WRITE_ERROR) {
      setResponseStatus(event, 400);
      return { error: errorMessage(error) };
    }
    // D166 item 2: an additional source id hidden from this caller by team.
    if (error instanceof CampaignNotFoundError) {
      setResponseStatus(event, 404);
      return { error: `Brief "${error.campaignId}" not found.` };
    }
    // An unknown teamId, from createCampaign inside `attempt` (see the
    // blank-create catch above for why this is the one realistic failure
    // `canAssignTeam`'s cheap check leaves standing).
    if (isErrno(error, "EFORBIDDEN")) {
      setResponseStatus(event, 403);
      return { error: errorMessage(error) };
    }
    if (!(error instanceof InvalidCopyPoolError)) throw error;
    setResponseStatus(event, 422);
    return { error: error.message };
  }
});
