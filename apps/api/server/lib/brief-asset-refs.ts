import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { collectRefs, extractSourceAssetBriefIds, rewriteAssetPaths } from "./asset-files.js";
import { objectStore } from "./config.js";
import { parseStoredInputRef } from "./object-store/object-input-assets.js";
import { assertSourceVisible, CampaignNotFoundError } from "./ownership.js";
import { isAssetId, type AssetStorePort } from "./ports/asset-store.port.js";
import type { BriefStorePort } from "./ports/brief-store.port.js";
import { getAssetStore, getBriefStore } from "./ports/index.js";
import type { StorageScope } from "./run-environment.js";

export { collectRefs };

/**
 * A brief ref the caller may not use (PT-4k2a, D208 B/D, D210 a/c/d).
 *
 * A SUBCLASS of `CampaignNotFoundError`, and the reason is the route contract: every
 * existing `instanceof CampaignNotFoundError` catch keeps mapping this to 404, while a
 * route that has to tell an s3 refusal from the non-s3 `assertSourceVisible` rejection
 * can tell them apart BY CLASS and never by asking which backend answered — a test
 * that branched on `objectStore()` would pin the wrong thing to the wrong half.
 *
 * **`campaignId` is the CALLER'S OWN brief id, never the ref and never a slug read out
 * of it.** The id was sent by the caller, so naming it tells them nothing they did not
 * already know. An `assetOwner().slug` is a campaign they may be unable to see, and
 * putting it in a message body turns the one 404 back into the oracle D210(c) exists
 * to close: hidden and absent must be indistinguishable, and "Campaign X not found"
 * naming X is how a guessable slug becomes a probe.
 */
export class BriefRefNotFoundError extends CampaignNotFoundError {
  constructor(briefId: string) {
    super(briefId);
    this.name = "BriefRefNotFoundError";
  }
}

/** What {@link resolveBriefAssetRefs} hands back. */
export interface ResolvedBriefRefs {
  /**
   * The brief every ref resolved, as an ASSET ID where the backend has ids — the input
   * unchanged in `render` mode, which is a check and not a rewrite, and the ref→id
   * remap under `s3` in `save` mode (PT-4k2b): a path ref names a row the caller may
   * see, and under `s3` what is STORED is that row's id (D208 D), so the brief handed
   * back is the one to write, not the one that arrived.
   */
  readonly brief: CampaignBrief;
  /** The distinct owner slugs that are not `target`, in first-seen order. */
  readonly copyFrom: readonly string[];
  /** The ids IN `brief` whose owner is not `target` — what a copy has to bring over. */
  readonly foreignIds: ReadonlySet<string>;
  /**
   * The ids IN `brief` whose owner IS `target` — the refs a copy does NOT have to
   * bring over, because the new campaign already holds the row (PT-4k2b).
   *
   * Empty off s3 (no row owns anything there) and, for a PATH ref, in `render` too: a
   * path is not an id, and a render brief is never rewritten. It exists so a copy can
   * tell "the source's own asset, already the target's" from "a third campaign's asset
   * this copy must remap" — from the FRESH target's point of view the source's own ids
   * are foreign too, which is why a copy that has just minted its target checks
   * `foreignIds ∪ ownIds` rather than `foreignIds`.
   */
  readonly ownIds: ReadonlySet<string>;
}

/** Refuse (404) a campaign the caller cannot SEE. `campaignVisibility` never throws to say "not found". */
async function assertVisible(briefs: BriefStorePort, briefId: string, slug: string): Promise<void> {
  if ((await briefs.campaignVisibility(slug)) !== "visible") {
    throw new BriefRefNotFoundError(briefId);
  }
}

/**
 * Resolve one ref to the asset id it names, and refuse the ones the caller may not use
 * (PT-4k2a render, PT-4k2b save; D208 B/D, D210 a/c/d).
 *
 * **The backend decides how much is checked, and nothing else does.** `OBJECT_STORE` is
 * the s3 switch (`config.ts`) and `BriefStorePort.supportsTeams` is the team switch; from
 * those two the whole rule follows, and it holds for BOTH modes:
 *
 * | backend | id ref | path ref |
 * | --- | --- | --- |
 * | fs (no teams) | untouched, no store call | untouched, no store call |
 * | pg + fs (staging) | untouched — fs has no ids to own | team check only |
 * | s3 (pg + objects) | `assetOwner` → team check | team check → `listAssets` by name |
 *
 * The s3 row is the only place an id can be resolved at all, which is why
 * `listAssets(slug)` + `name` is the whole path→id resolver here and why this lane needs
 * no `AssetStorePort` change (D210 a). `assetOwner` and `listAssets` are org-scoped only,
 * by design (`object-asset-store.ts`), so the TEAM half is always the one explicit
 * `campaignVisibility` call — made for every ref, including a ref the caller already
 * owns, because "in my org" is not "mine to see".
 *
 * **`mode` is what changes what is DONE with the answer, not what is checked** (D210 a):
 * `render` is a check and hands the input brief back untouched, `save` is a write and
 * hands back the brief to store — every ref as the id of a row the caller can see (D208
 * D). So `save` also records what a copy has to bring over (`copyFrom`, `foreignIds`,
 * `ownIds`), refuses the one ref shape that names no campaign at all, and is the only
 * mode that refuses on a row or a campaign being absent; off `s3` it is exactly the
 * route code these four write paths already ran.
 */
export async function resolveBriefAssetRefs(
  scope: StorageScope,
  brief: CampaignBrief,
  opts: { target: string; mode: "save" | "render" },
): Promise<ResolvedBriefRefs> {
  const refs = collectRefs(brief);
  const briefs = getBriefStore(scope);

  // **`save` off s3 IS today's route code, behaviour for behaviour** (D208 D: "fs and
  // pg+fs-objects are unchanged"), and it answers `copyFrom` from PATHS alone — exactly
  // what `extractSourceAssetBriefIds` reads — because there are no asset rows off s3 to
  // own an id and nothing for an id ref to be remapped to. Returning here rather than
  // falling into the `!briefs.supportsTeams` return below is what keeps a Save-as copy
  // from silently dropping: that return answers `copyFrom: []`, which on fs would throw
  // away the copy the route has always made.
  //
  // `assertSourceVisible`, NOT `assertVisible`: this branch must not change one answer
  // any of the four write routes gives today, and the two differ in both directions —
  // `assertSourceVisible` refuses `"hidden"` only (letting `"absent"` through, which a
  // directory of demo assets answers), makes no call at all on a backend with no teams,
  // and raises a plain `CampaignNotFoundError(fromId)`, so `Brief "<slug>" not found.`
  // off s3 is what `duplicate.post` and `index.post` already answer — through THIS branch,
  // since PT-4k2b2 retired their last two direct call sites along with the docstring that
  // described them. `assertVisible` would refuse anything `!== "visible"`, inventing a 404
  // staging has never given.
  if (opts.mode === "save" && objectStore() !== "s3") {
    const copyFrom = extractSourceAssetBriefIds(brief, opts.target);
    for (const fromId of copyFrom) {
      await assertSourceVisible(scope, fromId);
    }
    return { brief, copyFrom, foreignIds: new Set(), ownIds: new Set() };
  }

  // fs: `supportsTeams` is false, so `campaignVisibility` can never answer "hidden"
  // here — there is no team to be outside of, and D210(d) leaves fs untouched. Skipping
  // before the loop is what keeps a uuid or a foreign path from buying a lookup whose
  // answer this backend cannot act on. `save` never reaches it (the branch above
  // returned), and under `s3` it cannot fire at all: `config.ts` refuses s3 without
  // postgres, so `s3` is always a backend with teams.
  if (!briefs.supportsTeams) {
    return { brief, copyFrom: [], foreignIds: new Set(), ownIds: new Set() };
  }
  const underS3 = objectStore() === "s3";
  // Per-call memos, keyed by slug: two distinct refs into one campaign (a logo and a
  // scene) share its visibility answer and its asset listing. A rejected check is
  // memoised too, and that is right: it is the same 404 (or the same 500) either way.
  const visibility = new Map<string, Promise<void>>();
  const visible = (slug: string): Promise<void> => {
    let check = visibility.get(slug);
    if (check === undefined) {
      check = assertVisible(briefs, brief.id, slug);
      visibility.set(slug, check);
    }
    return check;
  };
  const listings = new Map<string, ReturnType<AssetStorePort["listAssets"]>>();
  const listing = (slug: string): ReturnType<AssetStorePort["listAssets"]> => {
    let entries = listings.get(slug);
    if (entries === undefined) {
      entries = getAssetStore(scope).listAssets(slug);
      listings.set(slug, entries);
    }
    return entries;
  };

  const copyFrom: string[] = [];
  const seenOwners = new Set<string>();
  const foreignIds = new Set<string>();
  const ownIds = new Set<string>();
  const noteOwner = (slug: string): void => {
    if (slug === opts.target || seenOwners.has(slug)) return;
    seenOwners.add(slug);
    copyFrom.push(slug);
  };
  // The raw ref each `save`-mode path ref must become, keyed by the string
  // `collectRefs` handed back. The RAW string, not `parseStoredInputRef`'s normalised
  // one: `rewriteAssetPath` tests `path in pathMap` against the brief's own text, so a
  // key built from `./logo.png`-style normalisation would never be found.
  const refToId: Record<string, string> = {};

  for (const ref of refs) {
    if (isAssetId(ref)) {
      // **On pg + fs an id is left alone.** `FileSystemInputAssets` has no id branch
      // (a uuid is not a path there either, so it answers `undefined`), so there is no
      // row behind it to own and nothing an id could leak: asking would only invent a
      // 404 staging has never answered.
      if (!underS3) continue;
      const owner = await getAssetStore(scope).assetOwner(ref);
      // `undefined` covers an absent row AND another org's id — org-scoped by design,
      // so the two are the same answer and must be the same 404.
      if (owner === undefined) throw new BriefRefNotFoundError(brief.id);
      await visible(owner.slug);
      if (owner.slug !== opts.target) {
        noteOwner(owner.slug);
        foreignIds.add(ref);
      } else {
        // The target's OWN row: nothing to copy, and the id is already the thing a save
        // stores (D208 D), so it is recorded as its own rather than as a source.
        ownIds.add(ref);
      }
      continue;
    }

    const stored = parseStoredInputRef(ref);
    // **A ref that names NO campaign is the one place the two modes part company**
    // (D210 c, D208 d): `save` REFUSES it — a root-level demo ref, a malformed id, an
    // upper-case uuid, an unsafe path — because what is stored under `s3` is an id and
    // there is no row behind any of them; `render` lets it through, which leaks nothing
    // (no campaign means no team to be outside of) and keeps `ObjectInputAssets`' own
    // ENOENT/unsafe answer. It stays the editor's default brief's refs in render
    // (`run-context.tsx:553`), which is exactly why D210(e) sequences the web writing
    // ids before staging moves to s3 rather than refusing the brief outright.
    if (stored === undefined) {
      if (opts.mode === "save") throw new BriefRefNotFoundError(brief.id);
      continue;
    }
    await visible(stored.slug);

    if (underS3) {
      const id = (await listing(stored.slug)).find((entry) => entry.name === stored.name)?.id;
      // No row for this name in a campaign the caller CAN see: a missing upload, not a
      // hidden campaign — and it still answers the route's one hidden-campaign 404, or
      // "the asset is not there" and "the campaign is not yours" become two probes.
      if (id === undefined) throw new BriefRefNotFoundError(brief.id);
      if (opts.mode === "save") {
        refToId[ref] = id;
        if (stored.slug === opts.target) ownIds.add(id);
        else foreignIds.add(id);
      }
    }
    noteOwner(stored.slug);
  }

  // **`save` returns the REWRITTEN brief, `render` the input object.** From = to, so
  // `rewriteAssetPaths`' prefix branch is a no-op here and only the `path in pathMap`
  // entries apply — which is the whole of the remap, and it keeps its absent-stays-
  // absent discipline (`asset-files.ts`) for `audio` and `background` for free. In
  // `render` this stays the INPUT object (`toBe`): a check that handed back a copy would
  // make every caller compare objects instead of passing the body's own brief on.
  const resolved =
    opts.mode === "save" ? rewriteAssetPaths(brief, opts.target, opts.target, refToId) : brief;
  return { brief: resolved, copyFrom, foreignIds, ownIds };
}

/**
 * Copy every source campaign's assets into `target` and remap the brief's refs onto the
 * copies (PT-4k2b, D210 a/b) — the whole-campaign copy `AssetStorePort.copyAssets` has
 * always made, shared by every write route so no route branches on the backend to do it.
 *
 * **One loop for both backend families, because `copyAssets`' map is what each of them
 * reads.** Under `s3` the map's `<source id> → <target id>` entry
 * (`object-asset-store.ts`'s `record`) is the only thing that can remap an id ref, and an
 * id survives `rewriteAssetPaths` untouched without it — a shared id would still read,
 * and would be owned by a campaign whose `deleteAssets` this caller has no right to lean
 * on. Off `s3` there are no ids and the same call's `assets/inputs/<from>/<name> → <target
 * id>` / `name → name` entries make the prefix branch rebuild the path, which is
 * behaviour for behaviour what `briefs.post.ts`'s Save-as loop has always done.
 *
 * `from` is `resolveBriefAssetRefs`' `copyFrom`, in its first-seen order, and is walked in
 * that order: two slugs can name the same file, and the order decides which map sees the
 * ref first.
 */
export async function copyBriefRefs(
  scope: StorageScope,
  brief: CampaignBrief,
  from: readonly string[],
  target: string,
): Promise<CampaignBrief> {
  let copied = brief;
  for (const slug of from) {
    const { paths: map } = await getAssetStore(scope).copyAssets(slug, target);
    copied = rewriteAssetPaths(copied, slug, target, map);
  }
  return copied;
}

/**
 * Refuse a brief that still names one of the ids the copy was supposed to bring over
 * (PT-4k2b) — the same one 404 every other refusal in this module gives, because the ref
 * is still another campaign's asset and storing it would be D208(D)'s violation in the
 * one shape no other check can see.
 *
 * **`copyAssets` copies the rows that exist WHEN it runs, and the resolve that decided
 * they were there ran earlier.** An asset deleted between the two — a concurrent
 * `deleteAssets`, a failed create's rollback — is simply missing from the map, so
 * `rewriteAssetPaths` leaves its id in place and the brief would be written still naming
 * a row that no longer exists in any campaign. Nothing else fails here: no ENOENT, no
 * foreign-owner 404, just a brief that reads wrong later. So the ids the resolve called
 * foreign are checked against the brief that is about to be stored, and a survivor is
 * refused before a version is written.
 *
 * Off `s3` `stale` is always empty (nothing owns an id there), which makes this a no-op
 * rather than a new answer on a backend D208(D) leaves unchanged.
 *
 * A copy passes `foreignIds ∪ ownIds`, not `foreignIds`: from a freshly minted target's
 * own point of view the SOURCE's assets are foreign too, and every one of them has to
 * come back from `sourceMap` under the source's slug.
 */
export function assertRefsCopied(
  brief: CampaignBrief,
  stale: ReadonlySet<string>,
  briefId: string,
): void {
  if (stale.size === 0) return;
  for (const ref of collectRefs(brief)) {
    if (stale.has(ref)) throw new BriefRefNotFoundError(briefId);
  }
}
