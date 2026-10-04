import {
  CAMPAIGN_TYPES,
  isReservedCampaignId,
  slugify,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { errorMessage } from "@campaignfoundry/shared";
import { rewriteAssetPaths } from "../../lib/asset-files.js";
import {
  assertRefsCopied,
  BriefRefNotFoundError,
  copyBriefRefs,
  resolveBriefAssetRefs,
  type ResolvedBriefRefs,
} from "../../lib/brief-asset-refs.js";
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
  canAssignTeam,
  CampaignNotFoundError,
  resolveCampaignRef,
} from "../../lib/ownership.js";

import { requestTenant } from "../../lib/tenant.js";

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Marks an EEXIST raised while claiming the CANDIDATE slug itself — the only
 * failure `withDerivedSlug`'s retry loop may retry past (PT-5b2 fix-round
 * item 3). A conflict raised AFTER a successful reservation (a concurrent
 * writer's own Save landing version 1 on this exact slug between the
 * reservation and here, say) is a real, reportable conflict, never a taken
 * candidate to skip past — `attempt` below only ever throws this from its
 * own reservation step, nowhere else.
 */
class SlugTakenError extends Error {}

/**
 * Derive a slug from `name` (D178: the server derives the slug — the same
 * rule `duplicate.post.ts` uses, duplicated there rather than imported,
 * since a route file is not a shared module) and hand each candidate to
 * `attempt` until one is not taken: the base, then `-2`, `-3`, … — skipping a
 * reserved id and a uuid-shaped candidate (it would collide with D178's ref
 * resolution, #613) — staying within 64 characters by trimming the base
 * before the suffix. Only a `SlugTakenError` retries the next suffix; any
 * other failure — including an ordinary EEXIST `attempt` raises for a reason
 * other than the candidate itself being taken — propagates immediately. The
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
      if (!(error instanceof SlugTakenError)) throw error;
    }
  }
}

/**
 * POST /campaigns — mint a campaign (D177, D178). Body
 * `{ name, type, source?, teamId?, teamOf? }`.
 *
 * The server derives the slug from `name` (the same rule `duplicate.post.ts`
 * uses), deduplicated per org: `-2`, `-3`, … — never a reserved id, never a
 * uuid-shaped candidate. A name that slugifies to empty answers 400.
 *
 * With no `source`: mints the campaign with no version yet — a Postgres row
 * with no `brief_version`, or a reserved `briefs/<slug>/` directory on fs
 * (D179) — through `createCampaign`. `name` and `type` are stored on the
 * campaign itself (PT-5b3, 0013): `type` is validated against the known
 * campaign types first (D177's correction: a blank brief cannot be a
 * version, so there is no brief body yet to carry it); a Save later never
 * clears either. `teamOf` (PT-5c2, D177/D178) — a campaign ref (uuid or
 * slug) — inherits THAT campaign's team, for the web's Save as…, which
 * mints no `source` and so has no other way to keep the open campaign's
 * team: resolved through `resolveCampaign` then `campaignTeam`, never
 * `canAssignTeam` (the caller already sees the source, so inheriting its
 * team is not an assignment); an org-wide source means OMITTING `teamId`
 * from the mint, never an explicit `null` (`canAssignTeam` rejects `null`
 * for a non-owner); a ref that resolves to nothing answers 404 and mints
 * NOTHING; on a backend with no team column (fs, D166 item 5), `teamOf` is
 * ignored and the create still answers 201. An explicit `teamId` wins over
 * an inherited `teamOf`.
 *
 * With a `source`: that campaign's latest version becomes version 1, exactly
 * as `duplicate.post.ts`'s own `name` path does — brief-scoped assets and
 * the copy pool included. The caller's own `type` is ignored (never
 * validated for a sourced create): `createCampaign` stores the SOURCE
 * brief's own `type` instead (PT-5b3), while `name` is still the one the
 * caller typed. `teamId` omitted inherits the source's own team (PT-5b2
 * fix-round item 1, security); an explicit value (including `null`, clearing
 * to org-wide) goes through `canAssignTeam` exactly like `createBrief`'s.
 *
 * D166 item 2, closed under `s3` by `resolveBriefAssetRefs` (PT-4k2b2, D210 a/c): a
 * sourced create's own brief may name ANY campaign as an asset source — a THIRD
 * campaign's asset id included, which no path-matching ever saw. The resolve refuses a
 * hidden campaign, another org's, an absent row and a ref naming no campaign at all with
 * THIS route's own one 404, before any slug is ever reserved and before anything is
 * copied; the copy then brings the source's and every third campaign's assets over and
 * remaps every ref onto the copies (carry item 2), so what is written names the NEW
 * campaign's own rows only. Off `s3` this is the path-derived check and copy the route
 * has always made, unchanged.
 *
 * PT-5b2 fix-round items 2/3: `readPool` and that ref resolve run once, before any
 * slug is ever reserved — a malformed pool or a hidden reference answers 422/404
 * without minting anything. Once a candidate IS reserved (`createCampaign`), a later
 * failure (asset copy, the first-version `createBrief`, the pool write) frees the
 * copied assets and then releases that reservation (`deleteAssets`,
 * `releaseCampaign` — in THAT order, PT-4b, because the slug both frees by has to be
 * resolved before the row goes) and propagates as-is — never retried
 * onto a different suffix, even when the failure is itself EEXIST-shaped
 * (a concurrent writer's own Save racing this exact slug).
 *
 * Answers 201 `{ campaignId, slug, revision? }` — `revision` only for a
 * sourced create, which writes a version; a blank create has none yet.
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);

  let name: string;
  let source: string | undefined;
  let teamId: string | null | undefined;
  let teamOf: string | undefined;
  let type: string | undefined;
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

    // Validated and stored on `createCampaign` (PT-5b3, see the doc comment
    // above) — but not even validated for a sourced create: the copy carries
    // the source brief's own `type`, so a caller need not get this right
    // when `source` is set.
    const rawType = record?.type;
    if (source === undefined && rawType !== undefined) {
      if (typeof rawType !== "string" || !(CAMPAIGN_TYPES as readonly string[]).includes(rawType)) {
        throw new Error(`"type" must be one of: ${CAMPAIGN_TYPES.join(", ")}.`);
      }
      type = rawType;
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

    // PT-5c2 (D177, D178): `teamOf` — a campaign REF (uuid or slug) whose
    // team a BLANK create inherits, for the web's Save as… (which mints no
    // `source`, so it has no other way to keep the open campaign's team).
    // Resolved and applied below, in the blank-create branch only.
    const rawTeamOf = record?.teamOf;
    if (rawTeamOf !== undefined) {
      if (typeof rawTeamOf !== "string" || rawTeamOf === "") {
        throw new Error('"teamOf" must be a non-empty string.');
      }
      teamOf = rawTeamOf;
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
    // `teamOf` inherits, exactly the way a sourced create's own
    // `sourceTeamId` does (PT-5b2 fix-round item 1): resolved within the
    // caller's own scope — never through `canAssignTeam`, since inheriting a
    // team the caller can already SEE is not an elevation — and only when
    // the backend has teams at all (D166 item 5: ignored on fs, the create
    // still answers 201). A ref that resolves to nothing (hidden or
    // missing, PT-2d) answers 404 and mints nothing. An explicit `teamId`
    // (validated by `canAssignTeam` above) wins over an inherited one.
    let teamOfTeamId: string | null | undefined;
    if (teamOf !== undefined && store.supportsTeams) {
      let teamOfSlug: string;
      try {
        teamOfSlug = await resolveCampaignRef(scope, teamOf);
      } catch (error) {
        if (error instanceof CampaignNotFoundError) {
          setResponseStatus(event, 404);
          return { error: `Brief "${teamOf}" not found.` };
        }
        throw error;
      }
      teamOfTeamId = await store.campaignTeam(teamOfSlug);
      if (teamOfTeamId === undefined) {
        // The source vanished or became hidden between resolveCampaignRef
        // and this lookup (qodo PRRT_kwDOSzP1zc6m7iqy) — refuse rather than
        // let `undefined` fall through to `effectiveTeamId` below, which
        // would silently mint an ORG-WIDE copy of a source the caller can
        // no longer prove is theirs to inherit from.
        setResponseStatus(event, 404);
        return { error: `Brief "${teamOf}" not found.` };
      }
    }
    const effectiveTeamId = teamId !== undefined ? teamId : teamOfTeamId;
    try {
      const created = await withDerivedSlug(name, (slug) =>
        store.withBriefLock(slug, async () => {
          try {
            return await store.createCampaign(slug, { teamId: effectiveTeamId, name, type });
          } catch (error) {
            if (isExistsError(error)) throw new SlugTakenError();
            throw error;
          }
        }),
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

  // PT-5b2 fix-round item 2 (coderabbit PRRT_kwDOSzP1zc6mgBvA): resolve the
  // source pool and every ref the source's own body carries BEFORE any slug is
  // ever reserved — these depend only on `sourceSlug`/`template`, not on which
  // candidate eventually wins, so a malformed pool or a hidden reference
  // 422s/404s without minting (and then having to release) a versionless row or
  // directory for nothing.
  let sourcePool;
  try {
    sourcePool = await readPool(scope, sourceSlug);
  } catch (error) {
    if (!(error instanceof InvalidCopyPoolError)) throw error;
    setResponseStatus(event, 422);
    return { error: error.message };
  }
  // Resolve the source's refs ONCE, here, against `sourceSlug` as the target (the
  // campaign the caller proved they own) — so every ref is checked, every copy source
  // named, and `template`'s refs normalised to ids under `s3` BEFORE this route reserves
  // a slug or copies a byte (PT-4k2b2, D210 a/c). The `copyFrom` this answers excludes
  // `sourceSlug` itself, which is why the `!== sourceSlug` filter the path-derived check
  // needed is gone: that check could only see PATHS, so an id ref naming a third campaign
  // named no copy source at all and the copy went on to share it (carry item 2).
  let resolved: ResolvedBriefRefs;
  try {
    resolved = await resolveBriefAssetRefs(scope, template, { target: sourceSlug, mode: "save" });
  } catch (error) {
    // `BriefRefNotFoundError` FIRST, and it is a SUBCLASS of `CampaignNotFoundError`
    // (D210 c): its own body is this route's hidden-source 404, never the ref's owner
    // slug — under `s3` a hidden campaign and an absent one must be indistinguishable, or
    // a guessable slug read out of a ref is a probe.
    if (error instanceof BriefRefNotFoundError) {
      setResponseStatus(event, 404);
      return { error: `Brief "${source}" not found.` };
    }
    // The plain `CampaignNotFoundError` is the OFF-`s3` branch, and its body keeps naming
    // the slug the ref named — the answer fs and pg+fs have always given, which D208(D)
    // leaves unchanged. Under `s3` no route reaches it, so the residual difference is
    // confined to the backends that have no ids to resolve at all.
    if (error instanceof CampaignNotFoundError) {
      setResponseStatus(event, 404);
      return { error: `Brief "${error.campaignId}" not found.` };
    }
    throw error;
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
   *
   * The reservation and the copy/write are two separate failure domains
   * (PT-5b2 fix-round items 2/3): an EEXIST from `createCampaign` itself
   * means the candidate is taken (`SlugTakenError`, retried by
   * `withDerivedSlug`); anything after — including an EEXIST from
   * `createBrief` racing a concurrent Save — means the reservation held and
   * this failure is real. That second case releases the reservation and any
   * assets already copied for it, then propagates the original error
   * unmodified, so the route's own catch reports it (409 for that race,
   * naming the slug the store's own message already carries — never
   * retried onto a different suffix).
   */
  const attempt = async (targetSlug: string): Promise<ResolvedCampaign & { revision: string }> => {
    return store.withBriefLock(targetSlug, async () => {
      if (await isPoolDirSymlink(scope, targetSlug)) {
        throw new Error(SYMLINK_WRITE_ERROR);
      }
      try {
        // PT-5b3 (D168, D177): the display name is the one the user typed
        // (`name`, the same value `withDerivedSlug` slugified); the type is
        // the SOURCE's own (`template.type`), never validated against the
        // caller's `type` above, which a sourced create ignores.
        await store.createCampaign(targetSlug, {
          teamId: effectiveTeamId,
          name,
          type: template.type,
        });
      } catch (error) {
        if (isExistsError(error)) throw new SlugTakenError();
        throw error;
      }
      try {
        // `resolved.brief` and not `template`: under `s3` every ref the source carried is
        // already the id of a row the caller can see, and `template` still carries the
        // paths (or the source's own ids) the copy below would then have nothing to map.
        let brief: CampaignBrief = { ...resolved.brief, id: targetSlug };
        const sourceMap = await getAssetStore(scope).copyAssets(sourceSlug, targetSlug);
        brief = rewriteAssetPaths(brief, sourceSlug, targetSlug, sourceMap);
        // Every OTHER campaign the source named, in the order the resolve found them.
        // Under `s3` this is what carries a THIRD campaign's id over (carry item 2); off
        // it is the loop this line replaces, remapping paths prefix for prefix.
        brief = await copyBriefRefs(scope, brief, resolved.copyFrom, targetSlug);
        // **The source's own ids are in this set too.** From the fresh target's point of
        // view the SOURCE's assets are foreign as well, and every one of them had to come
        // back from `sourceMap` — so a source id that survived it (a row deleted between
        // the resolve and the copy, say) is refused here rather than stored still naming
        // another campaign's absent asset. Thrown INSIDE this try, so the rollback below
        // frees what was copied and releases the slug.
        assertRefsCopied(brief, new Set([...resolved.foreignIds, ...resolved.ownIds]), sourceSlug);

        // The pool first and version 1 last, both under the pool lock: a pool
        // failure then leaves nothing versioned, so the reservation below is
        // still releasable, and no other pool write can interleave.
        const created: StoredBrief = await withPoolLock(scope, targetSlug, async () => {
          if (sourcePool) {
            await copyPool(scope, sourceSlug, targetSlug);
          } else {
            await deletePool(scope, targetSlug);
          }
          return store.createBrief(brief, { teamId: effectiveTeamId });
        });
        return { campaignId: created.campaignId, slug: targetSlug, revision: created.revision };
      } catch (error) {
        // The pool lives inside the same reserved directory `releaseCampaign`
        // removes on fs (D177/D179): deleted first (a no-op if nothing was
        // ever written), or `releaseCampaign`'s own `rmdir` would refuse a
        // non-empty directory and answer false for no reason.
        await withPoolLock(scope, targetSlug, () => deletePool(scope, targetSlug));
        // The assets go BEFORE the release, by SLUG, and only while this slug
        // still has no version (PT-4b).
        //
        // Before, because the slug is what each backend can actually act on:
        // `FsAssetStore` stores a copied asset under
        // `assets/inputs/<slug>/` — a uuid is a directory it never wrote — and
        // `ObjectAssetStore` resolves the slug into the uuid its prefix is built
        // from, which it can only do while the campaign row exists. Released
        // first, the row is gone and neither can free anything: on staging
        // (`STORE_BACKEND=postgres`, `OBJECT_STORE=fs`) a failed create then
        // deleted a non-existent uuid directory and left every copied file
        // behind for good.
        //
        // The `hasVersion` guard is what keeps this from eating someone else's
        // work, and the route's own docstring names the race it closes:
        // `withBriefLock` is IN-PROCESS, so a SECOND API instance can write
        // version 1 under this slug between this request's `createCampaign` and
        // its `createBrief`. That campaign is a real, versioned one now, and
        // emptying its assets would delete the WINNER's uploads — while the
        // release below goes on to refuse, correctly, because a version exists.
        // So the free asks first, and `campaignMeta`'s `hasVersion` is exactly
        // the "any version yet" test `releaseCampaign` guards on: `exists(
        // select 1 from brief_version …)` on pg, a brief FILE for the id on fs.
        // One question, asked once, instead of inferred afterwards.
        //
        // Best-effort, and NOT freeing is the safe direction: the release is
        // what makes the campaign go away, so a failure here must not stand in
        // its way, and on S3 the release's cascade takes any rows the failed
        // prefix-delete left — objects without rows are unreachable, rows
        // without objects are a re-upload. The original error is what propagates
        // below either way, which is also why a `campaignMeta` that THROWS (a
        // malformed `campaign.json` on fs) is caught here rather than allowed to
        // replace it: not knowing whether freeing is safe must never be the thing
        // that destroys a real campaign's assets.
        try {
          const meta = await store.campaignMeta(targetSlug);
          if (meta !== undefined && !meta.hasVersion) {
            await getAssetStore(scope).deleteAssets(targetSlug);
          }
        } catch (cleanup) {
          console.warn(
            `[campaigns] could not free the assets of "${targetSlug}" after a failed create: ${errorMessage(cleanup)}`,
          );
        }
        // `releaseCampaign` carries the same guard, independently: it refuses
        // once a real, versioned brief exists for the slug (a concurrent Save
        // won it), so the reservation it drops is always this request's own.
        await store.releaseCampaign(targetSlug);
        throw error;
      }
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
    // PT-5b2 fix-round items 3/5: a conflict AFTER the reservation held (a
    // concurrent writer's own Save racing this exact slug) — never retried,
    // and the message already names the slug the store's own error carries,
    // never the raw `name` (qodo PRRT_kwDOSzP1zc6mgAEv's sibling finding).
    if (isExistsError(error)) {
      setResponseStatus(event, 409);
      return { error: errorMessage(error) };
    }
    // An unknown teamId, from createCampaign inside `attempt` (see the
    // blank-create catch above for why this is the one realistic failure
    // `canAssignTeam`'s cheap check leaves standing).
    if (isErrno(error, "EFORBIDDEN")) {
      setResponseStatus(event, 403);
      return { error: errorMessage(error) };
    }
    // The post-copy refusal above, and the same one every other refusal here gives. It
    // arrives through the OUTER catch because it is thrown inside `attempt`, and without
    // this branch it would surface with h3's own body shape rather than this route's
    // `{ error }` — its `statusCode` is 404, so only the body was wrong. The body names
    // the `source` the CALLER sent, never a ref and never an owner slug read out of one.
    if (error instanceof BriefRefNotFoundError) {
      setResponseStatus(event, 404);
      return { error: `Brief "${source}" not found.` };
    }
    if (!(error instanceof InvalidCopyPoolError)) throw error;
    setResponseStatus(event, 422);
    return { error: error.message };
  }
});
