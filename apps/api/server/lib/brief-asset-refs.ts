import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { objectStore } from "./config.js";
import { parseStoredInputRef } from "./object-store/object-input-assets.js";
import { CampaignNotFoundError } from "./ownership.js";
import { isAssetId } from "./ports/asset-store.port.js";
import type { BriefStorePort } from "./ports/brief-store.port.js";
import { getAssetStore, getBriefStore } from "./ports/index.js";
import type { StorageScope } from "./run-environment.js";

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
   * remap under `s3` in `save` mode (PT-4k2b).
   */
  readonly brief: CampaignBrief;
  /** The distinct owner slugs that are not `target`, in first-seen order. */
  readonly copyFrom: readonly string[];
  /** The ids IN `brief` whose owner is not `target` — what a copy has to bring over. */
  readonly foreignIds: ReadonlySet<string>;
}

/**
 * Every ref a brief carries, in the order {@link import("./asset-files.js").rewriteAssetPaths}
 * walks them: products (logo, then input asset), the brief's own `audio.path`, then every
 * `copy.timeline.beats[].background`.
 *
 * **The three groups are scanned independently**, the way
 * `extractSourceAssetBriefIds` scans them and against `rewriteAssetPaths`' own early
 * return: a brief whose `products` is missing or malformed must still have its audio and
 * its beat backgrounds checked, or a duplicate silently keeps refs from a campaign the
 * caller cannot see. Nothing here creates a key — a ref is read, never written, so the
 * absent-stays-absent discipline (`asset-files.ts`) has nothing to break here.
 */
function collectRefs(brief: CampaignBrief): readonly string[] {
  const refs: string[] = [];
  for (const product of brief.products) {
    refs.push(product.logoPath);
    if (product.inputAsset !== undefined) refs.push(product.inputAsset);
  }
  if (brief.audio !== undefined) refs.push(brief.audio.path);
  for (const beat of brief.copy?.timeline?.beats ?? []) {
    if (beat.background !== undefined) refs.push(beat.background);
  }
  return refs;
}

/** Refuse (404) a campaign the caller cannot SEE. `campaignVisibility` never throws to say "not found". */
async function assertVisible(briefs: BriefStorePort, briefId: string, slug: string): Promise<void> {
  if ((await briefs.campaignVisibility(slug)) !== "visible") {
    throw new BriefRefNotFoundError(briefId);
  }
}

/**
 * Resolve one ref to the asset id it names, and refuse the ones the caller may not use
 * (PT-4k2a, D210 a/c/d).
 *
 * **The backend decides how much is checked, and nothing else does.** `OBJECT_STORE` is
 * the s3 switch (`config.ts`) and `BriefStorePort.supportsTeams` is the team switch; from
 * those two the whole rule follows:
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
 */
export async function resolveBriefAssetRefs(
  scope: StorageScope,
  brief: CampaignBrief,
  opts: { target: string; mode: "save" | "render" },
): Promise<ResolvedBriefRefs> {
  // PT-4k2b owns `save`: the four write routes, the foreign-asset copies and the
  // retiring of `assertSourceVisible` all land with it. Refused rather than silently
  // doing today's path-derived check, so a caller cannot mistake this half for the
  // write side — the routes in this lane pass `render` and nothing else.
  if (opts.mode === "save") {
    throw new Error("save mode lands in PT-4k2b");
  }

  const refs = collectRefs(brief);
  const briefs = getBriefStore(scope);
  // fs: `supportsTeams` is false, so `campaignVisibility` can never answer "hidden"
  // here — there is no team to be outside of, and D210(d) leaves fs untouched. Skipping
  // before the loop is what keeps a uuid or a foreign path from buying a lookup whose
  // answer this backend cannot act on.
  if (!briefs.supportsTeams) {
    return { brief, copyFrom: [], foreignIds: new Set() };
  }
  const underS3 = objectStore() === "s3";

  const copyFrom: string[] = [];
  const seenOwners = new Set<string>();
  const foreignIds = new Set<string>();
  const noteOwner = (slug: string): void => {
    if (slug === opts.target || seenOwners.has(slug)) return;
    seenOwners.add(slug);
    copyFrom.push(slug);
  };

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
      await assertVisible(briefs, brief.id, owner.slug);
      if (owner.slug !== opts.target) {
        noteOwner(owner.slug);
        foreignIds.add(ref);
      }
      continue;
    }

    const stored = parseStoredInputRef(ref);
    // **A ref that names NO campaign is left alone in `render`** (D210 c), and that is
    // the ONLY place the two modes would differ for it: `save` refuses it (D208 d — "a
    // root-level demo ref cannot be saved under s3"), `render` does not. It leaks
    // nothing — no campaign means no team to be outside of — and
    // `ObjectInputAssets` already answers it as ENOENT or unsafe, so today's
    // skip/reject semantics hold. This is the editor's own default brief: the products
    // in `apps/web/src/lib/run-context.tsx:553` carry root-level
    // `assets/inputs/hydra-logo.png` refs, which is why D210(e) sequences the web's id
    // writing before staging moves to s3 rather than refusing the brief outright.
    if (stored === undefined) continue;
    await assertVisible(briefs, brief.id, stored.slug);

    if (underS3) {
      const id = (await getAssetStore(scope).listAssets(stored.slug)).find(
        (entry) => entry.name === stored.name,
      )?.id;
      // No row for this name in a campaign the caller CAN see: a missing upload, not a
      // hidden campaign — and it still answers the route's one hidden-campaign 404, or
      // "the asset is not there" and "the campaign is not yours" become two probes.
      if (id === undefined) throw new BriefRefNotFoundError(brief.id);
    }
    noteOwner(stored.slug);
  }

  return { brief, copyFrom, foreignIds };
}
