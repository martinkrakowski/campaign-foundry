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
 * staying within 64 characters by trimming the base before the suffix.
 * `attempt` performs the actual write; a collision is ITS conflict signal
 * (`isExistsError`), the same one two concurrent callers of the same name
 * race on, never a separate check-then-act read here. The caller guarantees
 * `slugify(name)` is non-empty before calling.
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
 * POST /campaigns/briefs/:id/duplicate — copy a yaml/yml/json brief to `briefs/<newId>.yaml`.
 *
 * Body is `{ newId, overrides? }` (the legacy, client-named target — kept
 * working until PT-5c2 removes it, since the web still sends it until
 * PT-5c) or `{ name, overrides? }` (PT-5b2, D178: the server derives the
 * slug by the same rule `POST /campaigns` uses). Exactly one of `newId`/
 * `name` is required; both or neither is 400. `overrides` accepts
 * `targetRegion` and `targetAudience` only (D71) and wins over the source.
 * Source is looked up by `brief.id` (filename may differ). 404 if the source
 * is missing, 409 if any file already has the target id. The copy gets
 * `id: <target>`; writes stay under `projectRoot()/briefs/`.
 * Copies any brief-scoped assets (`assets/inputs/<id>/*`) into `assets/inputs/<target>/*`
 * and rewrites logoPath and inputAsset, while leaving shared root assets untouched (L5.5).
 * The copy pool is copied too (D71/C9), rewritten to name the new brief — a
 * duplicated `pool://copy` source otherwise plans against a file that never existed.
 *
 * D166 item 2: the source brief's own asset-scoped fields may in turn name a
 * THIRD campaign's id as an asset source (`extractSourceAssetBriefIds`) —
 * each such id is checked with `assertSourceVisible` before its assets are
 * copied, same as `briefs.post.ts`'s "Save as…".
 *
 * D166 item 3 / D177 (PT-5b2): the target's own availability is claimed
 * BEFORE any copy or write, rather than relying on `createBrief`'s eventual
 * EEXIST — an existing-but-hidden target must never have its asset directory
 * written into ahead of that conflict. The legacy `newId` path claims it the
 * way this route always has, `campaignVisibility` — unchanged, so an
 * existing-but-hidden `newId` still 409s here exactly as before. A
 * server-derived `name` claims it with `createCampaign` instead: the only
 * check that also sees an fs reserved directory (D179, a blank
 * `POST /campaigns` create) — `campaignVisibility` cannot, since it answers
 * on file existence alone — and, on Postgres, mints the versionless row this
 * write's own `createBrief` call then completes as its first Save (D177).
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

  let target: { kind: "newId"; value: string } | { kind: "name"; value: string };
  let overrides: unknown;
  try {
    const body: unknown = await readBody(event);
    const record =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
    const rawNewId = record?.newId;
    const rawName = record?.name;
    if (rawNewId !== undefined && rawName !== undefined) {
      throw new Error('Pass "newId" or "name", not both.');
    }
    if (rawNewId !== undefined) {
      assertSafeId(rawNewId, "newId");
      if (isReservedCampaignId(rawNewId)) {
        throw new Error(`"${rawNewId}" is reserved; choose another campaign id.`);
      }
      target = { kind: "newId", value: rawNewId };
    } else if (typeof rawName === "string") {
      if (slugify(rawName) === "") {
        throw new Error('"name" must contain at least one letter or digit.');
      }
      target = { kind: "name", value: rawName };
    } else {
      throw new Error('"newId" or "name" is required.');
    }
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
  // team when the caller supplies none — the same visibility the caller
  // could already see (they just proved they own `sourceSlug`), never a
  // widening to org-wide by omission. `undefined` here (fs, or the
  // theoretically-unreachable "hidden after we just asserted ownership")
  // behaves like "no team" for a fresh insert, same as before this fix.
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
  // CampaignNotFoundError/InvalidCopyPoolError, and a parse failure would
  // surface as an uncaught 500 instead. Validated once against the SOURCE's
  // own (already-safe) id as a placeholder: every candidate this route ever
  // tries is SAFE_ID-shaped by construction (the legacy `newId`, asserted
  // above; a derived slug, by `withDerivedSlug`), and nothing else parseBrief
  // checks depends on `id`'s value (`load-brief.ts:1216` only checks its
  // shape) — so each attempt just swaps `id` into the validated object,
  // rather than re-parsing per candidate. `mode` is deliberately NOT an
  // override: a classic source overridden to "variation" needs a
  // `variation.count` that parseBrief requires and that is an editor default
  // ("12"), not this route's to invent; the reverse direction leaves the
  // source's `variation` block in the file, structurally valid but inert.
  // The copy inherits the source's mode.
  let template: CampaignBrief;
  try {
    template = parseBrief({ ...source.brief, ...overrideValues(overrides), id: sourceSlug });
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  /**
   * Claim `targetSlug` (via `reserve`), then copy the source's assets and
   * pool into it and write it as version 1. `reserve` throws an EEXIST-coded
   * error on a collision — the retry loop's own signal for the `name` path,
   * and this route's usual 409 for the legacy `newId` path.
   */
  const attempt = async (
    targetSlug: string,
    reserve: () => Promise<void>,
  ): Promise<StoredBrief> => {
    if (await isPoolDirSymlink(scope, targetSlug)) {
      throw new Error(SYMLINK_WRITE_ERROR);
    }
    let brief: CampaignBrief = { ...template, id: targetSlug };
    return getBriefStore(scope).withBriefLock(targetSlug, async () => {
      await reserve();

      // Resolve the source pool first so a malformed source throws
      // InvalidCopyPoolError before any dest write (the 422 path must leave
      // the destination brief absent). createBrief is exclusive (wx); writing
      // the dest pool first left an orphan when the dest file existed but was
      // unparseable — findBriefById skips those, then wx turns into a 409.
      const sourcePool = await readPool(scope, sourceSlug);

      // D166 item 2 (PT-2c, greptile thread U90U): every additional source id
      // — extracted from the brief, before the primary source's own paths
      // below are rewritten off `id` — is checked for visibility BEFORE any
      // copy runs, including the primary source's `copyAssets` just below.
      const additionalSourceIds = extractSourceAssetBriefIds(brief, targetSlug).filter(
        (fromId) => fromId !== sourceSlug,
      );
      for (const fromId of additionalSourceIds) {
        await assertSourceVisible(scope, fromId);
      }

      // Copy assets from source brief to new brief, and any referenced brief-scoped assets
      const sourceMap = await getAssetStore(scope).copyAssets(sourceSlug, targetSlug);
      brief = rewriteAssetPaths(brief, sourceSlug, targetSlug, sourceMap);
      for (const fromId of additionalSourceIds) {
        const addMap = await getAssetStore(scope).copyAssets(fromId, targetSlug);
        brief = rewriteAssetPaths(brief, fromId, targetSlug, addMap);
      }

      const created = await getBriefStore(scope).createBrief(brief, { teamId: sourceTeamId });
      // The dest pool write (or the stale-pool delete when the source has none)
      // runs under withPoolLock(targetSlug) as well as the brief lock: they are
      // different maps, so without it a concurrent POST /campaigns/pools/:targetSlug
      // could interleave. The source pool needs no lock: writePool renames atomically.
      await withPoolLock(scope, targetSlug, async () => {
        if (sourcePool) {
          await copyPool(scope, sourceSlug, targetSlug);
        } else {
          await deletePool(scope, targetSlug);
        }
      });
      return created;
    });
  };

  /** The legacy path's own check (D166 item 3), unchanged. */
  const reserveVisible = (targetSlug: string) => async (): Promise<void> => {
    if ((await getBriefStore(scope).campaignVisibility(targetSlug)) !== "absent") {
      const existErr = new Error(`Brief "${targetSlug}" already exists.`);
      (existErr as { code?: string }).code = "EEXIST";
      throw existErr;
    }
  };
  /** The `name` path's claim (D177/D179): also sees an fs reserved directory. */
  const reserveMinted = (targetSlug: string) => async (): Promise<void> => {
    await getBriefStore(scope).createCampaign(targetSlug, { teamId: sourceTeamId });
  };

  try {
    const created =
      target.kind === "newId"
        ? await attempt(target.value, reserveVisible(target.value))
        : await withDerivedSlug(target.value, (slug) => attempt(slug, reserveMinted(slug)));
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
      // Only the legacy `newId` path can reach this: `withDerivedSlug` retries
      // an EEXIST from `reserveMinted` on the next candidate rather than
      // surfacing it.
      setResponseStatus(event, 409);
      return { error: `Brief "${target.value}" already exists.` };
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
