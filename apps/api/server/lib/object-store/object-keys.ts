import { assertObjectKey, type ObjectKey } from "@campaignfoundry/CampaignOrchestration";

/**
 * The org segment of every key. Looser than the brief `SAFE_ID_PATTERN` on
 * purpose, because an org id is not a brief id: it comes from the auth
 * provider's own namespace (Better Auth's org `id` is a slug the provider
 * minted), and a key builder that refused a legitimate org would fail the
 * write rather than the configuration. Upper case, `_` and `-` are all legal
 * key characters, so this admits nothing `OBJECT_KEY_PATTERN` later refuses.
 */
const ORG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * A campaign's and an asset's own id, both `gen_random_uuid()` (D168,
 * `0016_asset.sql`). Deliberately the same shape `PgBriefStore.resolveCampaign`
 * tries first, so a uuid that reaches here has already been a campaign id
 * somewhere rather than arriving as an arbitrary string from a route.
 *
 * **Exported so the ref RESOLVER asks the same question this does** (fix 1:
 * `render-target.ts`). `campaign.id` is a `uuid` column, so whether a ref is
 * tried as an id before it is tried as a slug decides whether a uuid-addressed
 * run resolves or fails — and two copies of this expression would be free to
 * disagree about which refs those are. The pattern is the codebase's, unchanged:
 * four other modules spell it identically, and a looser one here would accept a
 * ref those four refuse.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The segment every uploaded input lives under — `kind = 'input'` in the row. */
const INPUT_SEGMENT = "inputs";

/** Where a campaign's renders and proofs live (D203: proofs under `renders/`). */
const RENDERS_SEGMENT = "renders";

/**
 * Where a campaign's PLATFORM PACKAGES live (PT-4h1, D203: packages are listed
 * from object prefixes and there is no `package` table).
 *
 * It is the fourth campaign-scoped segment beside `inputs` and `renders`, and it
 * is a SIBLING of them rather than a subtree: a package holds copies of renders,
 * never the renders themselves, so `deletePrefix` here must not be able to reach
 * one.
 */
const PACKAGES_SEGMENT = "packages";

/**
 * The background cache sits outside C7's campaign shape, because a cache entry
 * belongs to no campaign: its key is a digest of a provider, a model, a prompt,
 * a ratio and a seed, so there is no campaign id to hang it off even when one
 * generated it. It is still tenant-scoped BY PREFIX (D203, D167) — see
 * {@link cachePrefix}.
 */
const CACHE_SEGMENT = "cache";

/**
 * Refuse an id that is not the shape its own column declares, before it is
 * joined into a key.
 *
 * Each id is checked against its OWN pattern, not against one pattern for all
 * three: a single pattern wide enough for an org id (`_`, upper case) would
 * happily let a campaign id through as a path segment carrying a `_`, and the
 * key would be legal, self-consistent and ambiguous — two different campaigns
 * spelled the same way once a caller normalised them. The message names the
 * PARAMETER and never its value, for the reason `assertObjectKey` gives: the
 * value is a string from a header or a row that nothing here has vetted, and a
 * refusal that echoes it lands in whatever logged the throw.
 */
function segment(name: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new Error(`Refusing an object key: ${name} is not a well-formed id.`);
  }
  return value;
}

/**
 * Where one uploaded input's bytes live, as one key (PT-4b, C7):
 * `org/<orgId>/campaign/<campaignId>/inputs/<assetId>`.
 *
 * **A key never contains the campaign's slug or the asset's name** (DoD 3), and
 * that is structural rather than a rule this function could forget: it takes
 * three ids and there is nowhere to put a slug or a name. A slug is a
 * user-chosen, renameable string, and a name is an upload's own label — either
 * in the store's namespace is a name the app can be made to change, which is
 * how a path stops being an address. The asset id is the one identity here
 * that the database owns and never renames, and the row is what maps it back
 * to a name for a listing.
 *
 * The key is per-ASSET, not per name, which is why the exclusive create cannot
 * rest on the key: two uploads of the same name produce two different keys, so
 * both would find a free one. The unique index on `asset (campaign_id, kind,
 * name)` is what makes the second a refusal — see `ObjectAssetStore.writeAsset`.
 */
export function inputKey(orgId: string, campaignId: string, assetId: string): ObjectKey {
  const key = [
    "org",
    segment("the org id", orgId, ORG_ID_PATTERN),
    "campaign",
    segment("the campaign id", campaignId, UUID_PATTERN),
    INPUT_SEGMENT,
    segment("the asset id", assetId, UUID_PATTERN),
  ].join("/");
  // The composed key through the port's own rule, so an adapter that joins a key
  // onto an endpoint never has to re-derive whether the result stays inside it.
  assertObjectKey(key);
  return key;
}

/**
 * The prefix every one of a campaign's uploaded inputs lives under — the same
 * key with the asset id left off.
 *
 * The trailing `/` is load-bearing and is why this is not
 * `inputKey(...).slice(0, -36)`: a prefix without one is a prefix of the
 * campaign's other keys too, so `deletePrefix` on it would empty a namespace
 * this lane does not own, and `list` would answer with a neighbouring
 * campaign's assets. This is what `deleteAssets` empties.
 */
export function inputPrefix(orgId: string, campaignId: string): ObjectKey {
  const prefix = [
    "org",
    segment("the org id", orgId, ORG_ID_PATTERN),
    "campaign",
    segment("the campaign id", campaignId, UUID_PATTERN),
    INPUT_SEGMENT,
    "",
  ].join("/");
  assertObjectKey(prefix);
  return prefix;
}

/**
 * Where one campaign's RENDERS live (PT-4e, D203): `org/<orgId>/campaign/<campaignId>/renders/`.
 *
 * The shape is `inputPrefix` with `renders` in place of `inputs`, and for the
 * same reason: a render key is built by REPLACING the leading campaign segment
 * of the path the use case already produced with this prefix, so the leading
 * slug — the one thing the use case's paths carry that a key must not (DoD 3) —
 * is dropped at the join rather than somewhere a rule has to remember to drop
 * it. What survives the join is the product, the ratio and the variant index,
 * which is what the report JSON names and what the caller reads back.
 *
 * Both the org and the campaign id are checked against their OWN patterns, as
 * above: a render key that carried a slug here would be self-consistent,
 * renameable and ambiguous, which is the whole failure this key shape exists to
 * remove.
 */
export function renderPrefix(orgId: string, campaignId: string): ObjectKey {
  const prefix = [
    "org",
    segment("the org id", orgId, ORG_ID_PATTERN),
    "campaign",
    segment("the campaign id", campaignId, UUID_PATTERN),
    RENDERS_SEGMENT,
    "",
  ].join("/");
  assertObjectKey(prefix);
  return prefix;
}

/**
 * Where one campaign's rendered creatives are PACKAGED per platform (PT-4h1,
 * D203): `org/<orgId>/campaign/<campaignId>/packages/`.
 *
 * The shape is `renderPrefix` with `packages` in place of `renders`, and for the
 * same reason: below it every key is built by REPLACING the leading campaign
 * segment of the path the use case produced with a generation prefix, so the
 * slug — the one thing a key must not carry (DoD 3) — is dropped at the join
 * rather than by a rule that has to remember to drop it.
 *
 * Both ids are checked against their OWN patterns, exactly as in `renderPrefix`:
 * a package prefix that carried a slug here would be self-consistent,
 * renameable and ambiguous, which is the whole failure this key shape removes.
 * The trailing `/` is load-bearing for the third time: a platform prefix below
 * it is `<platformId>/<generation>/`, and without the separator `packages` would
 * also prefix `packages-archive/`.
 */
export function packagePrefix(orgId: string, campaignId: string): ObjectKey {
  const prefix = [
    "org",
    segment("the org id", orgId, ORG_ID_PATTERN),
    "campaign",
    segment("the campaign id", campaignId, UUID_PATTERN),
    PACKAGES_SEGMENT,
    "",
  ].join("/");
  assertObjectKey(prefix);
  return prefix;
}

/**
 * Where ONE campaign's whole object tree lives: `org/<orgId>/campaign/<campaignId>/`
 * (PT-9b, D243).
 *
 * It is a deliberate WIDENING in this file, and it contains `inputs/`,
 * `renders/` and `packages/` rather than naming one of them — where the three
 * prefixes above each answer for one namespace, this answers "everything this
 * campaign owns". A widening that reaches three namespaces at once is a
 * `deletePrefix` away from deleting all three, so what makes it safe is that it
 * has exactly two callers, both of PT-9 and both of which mean it: the purge
 * engine (PT-9g) and the orphan reconciler (PT-9h). **No request-path code may
 * call it** (D243). A handler that wanted it would be asking to empty a whole
 * campaign over one request, and the per-namespace prefixes above are what a
 * handler is for.
 *
 * The trailing `/` is load-bearing for the widest reason in the file: with the
 * separator gone this would prefix a sibling campaign whose id merely BEGINS
 * with this one, and a purge keyed by campaign uuid would empty a neighbour it
 * was never asked about. It is not `inputPrefix(...).slice(0, -"inputs/".length)`
 * for the same reason `inputPrefix` is not a slice: a prefix that is computed
 * from another prefix is a prefix whose correctness is one refactor away from
 * being wrong.
 *
 * Both ids go through the SAME `segment` checks as the prefixes above, against
 * their OWN patterns — never a second validator and never concatenation of an
 * unchecked value, because the value that matters most here is the one the purge
 * will trust: a campaign id that arrived as a slug would name a namespace no
 * write ever populated.
 */
export function campaignPrefix(orgId: string, campaignId: string): ObjectKey {
  const prefix = [
    "org",
    segment("the org id", orgId, ORG_ID_PATTERN),
    "campaign",
    segment("the campaign id", campaignId, UUID_PATTERN),
    "",
  ].join("/");
  assertObjectKey(prefix);
  return prefix;
}

/**
 * The level ABOVE one campaign: `org/<orgId>/campaign/`, where every campaign
 * prefix of one org lives (PT-9h, D239).
 *
 * It has ONE caller, the orphan reconciler, which lists under it to find
 * campaign prefixes that have no row. **No request-path code may call it**
 * (D243): it names every campaign of an org at once, so a `deletePrefix` on it
 * would empty the org's whole campaign tree. It is not `orgPrefix` (9m's
 * `org/<orgId>/`, which also holds the cache), and it is not a slice of
 * `campaignPrefix`, for the reason that file gives. The trailing `/` is
 * load-bearing: without it the prefix would also match `org/<orgId>/campaigns-x/`.
 */
export function orgCampaignsPrefix(orgId: string): ObjectKey {
  const prefix = ["org", segment("the org id", orgId, ORG_ID_PATTERN), "campaign", ""].join("/");
  assertObjectKey(prefix);
  return prefix;
}

/**
 * Where one org's background cache lives (PT-4e, D203): `org/<orgId>/cache/`.
 *
 * It is deliberately OUTSIDE C7's campaign shape and deliberately still
 * tenant-scoped. A cache entry is keyed by a digest of the prompt that produced
 * it, not by a campaign, so there is no campaign id to hang it off — and
 * inventing one would mean a re-run under a different campaign wrote a second
 * copy of the same image. The org prefix is what keeps two tenants out of each
 * other's cache: the prompt is user-authored, so without it one org could
 * fingerprint another's briefs by timing cache hits.
 *
 * Like every prefix here, the trailing `/` is load-bearing — it is why this is
 * not a slice of some longer key.
 */
export function cachePrefix(orgId: string): ObjectKey {
  const prefix = ["org", segment("the org id", orgId, ORG_ID_PATTERN), CACHE_SEGMENT, ""].join("/");
  assertObjectKey(prefix);
  return prefix;
}

/**
 * Everything one org owns in the store: `org/<orgId>/` (D243, PT-9m2). It spans
 * `campaign/` AND `cache/`, so a `deletePrefix` on it empties the whole org.
 * **No request-path code may call it.** Its one caller is the org purge
 * (`lib/deletion/purge-org.ts`). The trailing `/` is load-bearing: without it
 * the prefix `org/acme` would also match `org/acme-two/...`. The id goes through
 * the same `segment` check as every prefix here, never a second validator.
 */
export function orgPrefix(orgId: string): ObjectKey {
  const prefix = ["org", segment("the org id", orgId, ORG_ID_PATTERN), ""].join("/");
  assertObjectKey(prefix);
  return prefix;
}
