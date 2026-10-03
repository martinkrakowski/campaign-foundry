import { relative } from "node:path";
import type { InputAssetPort } from "@campaignfoundry/CampaignOrchestration";
import { isAssetId, type AssetStorePort } from "../ports/asset-store.port.js";
import { resolveAssetPath } from "@campaignfoundry/CreativeGeneration";
import { getAssetStore } from "../ports/index.js";
import type { RunEnvironment } from "../run-environment.js";

/**
 * A root that names nothing on disk, used only to run the ref through
 * `resolveAssetPath` and get a NORMALISED path back out. It must be ABSOLUTE: a
 * relative one would resolve every ref against the process's cwd, so the same ref
 * could be safe in one deployment and unsafe in another.
 */
const SYNTHETIC_ROOT = "/__input_assets__";

/** The one shape a brief's ref takes once it is stored (PT-4b's `assetRelPath`). */
const INPUTS_PREFIX = "assets/inputs/";

export interface ObjectInputAssetsOptions {
  /**
   * Read each ref through this instance ONCE — one store fetch, shared by every
   * caller, including the ones that arrive while it is still in flight. Off unless
   * asked for, and only `buildPipeline` asks (see `inputAssets`).
   *
   * A read that fails is not remembered, so a re-run after an upload still sees
   * it; see {@link ObjectInputAssets.fetch} for the one place that is decided.
   */
  readonly memo?: boolean;
}

/** A safe ref's two halves: the campaign it belongs to, and the asset's name. */
export interface InputRef {
  readonly slug: string;
  readonly name: string;
}

/**
 * `assets/inputs/<slug>/<name>`, or `undefined` when the ref carries no campaign to
 * read through.
 *
 * `rel` is ALREADY normalised — it comes out of `resolveAssetPath`, so
 * `assets/inputs/a/../b/logo.png` arrives here as `assets/inputs/b/logo.png` and
 * reads campaign `b`, exactly as fs reads that file for the same ref.
 *
 * `undefined` covers every ref no object can ever answer under `s3`: the
 * root-level demo ref the repo ships (`assets/inputs/hydra-logo.png`), a ref
 * outside `inputs/` at all, and one that named a campaign with nothing after it
 * (`assets/inputs/<slug>/`, which normalises to no asset name at all). All three
 * are ENOENT rather than "unsafe" — the ref passed the safety check, so a
 * consumer must hear "could not be read", never "is not a valid asset path".
 */
function parseInputRef(rel: string): InputRef | undefined {
  if (!rel.startsWith(INPUTS_PREFIX)) return undefined;
  const rest = rel.slice(INPUTS_PREFIX.length);
  // No slash at all: the root-level demo ref, or a ref that named `inputs/` and
  // nothing more. Both have no campaign to read through. (An EMPTY first segment
  // cannot reach here — `resolve` collapses `inputs//logo.png` to
  // `inputs/logo.png` before the path comes back — so this is `< 0`, not `<= 0`,
  // and there is no empty-name case to guard: a trailing slash is stripped too.)
  const slash = rest.indexOf("/");
  if (slash < 0) return undefined;
  return { slug: rest.slice(0, slash), name: rest.slice(slash + 1) };
}

/**
 * A stored ref's campaign and name, or `undefined` when it names no campaign (PT-4k2a).
 *
 * **`undefined` covers the unsafe refs as well as the campaign-less ones**, which is why
 * {@link ObjectInputAssets.read} keeps its own `resolveAssetPath` gate: a caller that
 * wants the two apart (only `read` does) asks `resolveAssetPath` itself, and a caller
 * that only wants to know "does this ref name a campaign to check" — the write-side
 * checks, which answer "no campaign, nothing to check" for either — asks this.
 *
 * **It is the ONE parse of a stored path ref**, deliberately: the normalising
 * (`resolveAssetPath`) and the splitting are one decision, and a second caller that
 * re-implemented either would eventually disagree with `read` about which campaign a
 * ref names — which is exactly the question this lane's 404s turn on.
 */
export function parseStoredInputRef(ref: string): InputRef | undefined {
  const safePath = resolveAssetPath(ref, SYNTHETIC_ROOT);
  if (safePath === undefined) return undefined;
  return parseInputRef(relative(SYNTHETIC_ROOT, safePath));
}

/**
 * The `ENOENT` fs's `readFile` would have raised, which is what the consumers
 * branch on: the logo skips it silently, a scene and a music bed report "could
 * not be read" with this as their `cause`.
 *
 * It is a REJECTION and never `undefined`. `undefined` means "this ref is unsafe,
 * skip the asset", and a store that answers that for a perfectly safe ref turns a
 * scene's "could not be read" into "is not a valid asset path" — which tells the
 * operator to fix a brief that names nothing wrong with it (PT-4c's `cause`
 * tests pin that difference).
 */
function absent(ref: string, detail: string): Error {
  const error = new Error(`Input asset "${ref}" was not found: ${detail}`);
  (error as NodeJS.ErrnoException).code = "ENOENT";
  return error;
}

/**
 * `InputAssetPort` over the object store (PT-4d, D206) — the `s3` half of the
 * `inputAssets` switch in `pipeline.ts`, and the second implementation of the one
 * port `FileSystemInputAssets` already is. The five consumers are unchanged and
 * know nothing about it: the seam PT-4c cut is exactly this wide.
 *
 * **A ref means the same thing here as on disk.** `assets/inputs/<slug>/<name>`
 * is resolved org-scoped through PT-4b's `ObjectAssetStore` (D206: org-scoped,
 * NOT team-filtered — team visibility is `PgBriefStore`'s, and the routes gate on
 * `campaignMeta` before a run exists), then through the `asset` row, then
 * `get`. That adapter already owns the SQL; there is deliberately no second copy
 * of it here.
 *
 * **A ref is an id or a path, and shape decides (PT-4k1, D203/D208d).** A bare
 * lower-case uuid is the asset's own id and is read org-scoped through the row
 * it names; everything else is the path form above. Under `s3` both are
 * readable, and a stored path ref stays readable with no migration (D208: no
 * data migration) — which is why the branch is an `if`, not a switch on a
 * backend. The two branches converge on the same three outcomes below, so a
 * consumer learns nothing about which form a brief used.
 *
 * **Three outcomes, byte-identical to fs** — this is the whole contract, because
 * each consumer's failure policy is written against these three:
 * - `undefined` for exactly what `resolveAssetPath` refuses (empty, absolute,
 *   outside `<root>/assets`, `assets` itself, `..`), so "unsafe" stays
 *   indistinguishable from "never named";
 * - ENOENT for every safe ref no campaign, row or object answers, INCLUDING the
 *   root-level demo ref — see {@link absent} for why that is not `undefined`;
 * - a store or database failure REJECTED UNCHANGED, so the logo warns and a scene
 *   or bed fails loudly, as fs does for `EACCES`. Swallowing it into `undefined`
 *   would turn a bucket that cannot be read into a brief that named no asset.
 *
 * **The store is built lazily, per read.** Constructing this touches neither
 * `database()` nor `objectStoreClient()`: the first is behind `getAssetStore`,
 * and an unsafe ref must answer `undefined` even on a host whose bucket is
 * misconfigured — otherwise a brief naming `/etc/passwd` would fail a run for a
 * reason that has nothing to do with the ref.
 *
 * ## Must not: re-export this from `lib/object-store/index.ts`
 *
 * `getAssetStore` comes from the ports barrel, and that barrel imports
 * `lib/object-store/index.ts`. A re-export here would close
 * `ports/index → object-store/index → object-input-assets → ports/index`, which is
 * invisible until a lazy `require` resolves it halfway. `pipeline.ts` imports
 * this file directly for the same reason it imports `S3ObjectStore` directly.
 */
export class ObjectInputAssets implements InputAssetPort {
  /**
   * Absent unless `memo` was asked for — an off switch that costs no Map.
   *
   * The IN-FLIGHT promise, not resolved bytes. `GenerateCampaignUseCase` renders
   * cells through `mapWithConcurrency` with eight in flight, and every one of them
   * reads the same logo, so the cells that start while the first read is still
   * waiting on the bucket must JOIN it rather than each open their own: a store
   * read is a network round trip, and a memo that only remembered answers still
   * lets a concurrent run open eight of them for one object.
   */
  private readonly memo: Map<string, Promise<Uint8Array>> | undefined;

  constructor(
    private readonly env: RunEnvironment,
    options: ObjectInputAssetsOptions = {},
  ) {
    this.memo = options.memo === true ? new Map() : undefined;
  }

  async read(ref: string): Promise<Uint8Array | undefined> {
    const inFlight = this.memo?.get(ref);
    // A COPY, twice over: so a consumer that wrote into what it was handed cannot
    // change what the next consumer reads, and so a caller that JOINS an in-flight
    // read cannot change what the others are about to be handed. `readFile` gives
    // every caller a fresh Buffer, and this keeps that true for a memoised read.
    if (inFlight !== undefined) return Buffer.from(await inFlight);

    // **A ref that is an ASSET ID is read as one, and this check is FIRST**
    // (PT-4k1, D203's shape rule, D208d). `resolveAssetPath` refuses a bare uuid
    // — it is not under `<root>/assets` — so an id checked below read as an
    // UNSAFE ref and every scene and bed reported "is not a valid asset path"
    // for a brief naming an asset that is right there. `isAssetId` is the one
    // discriminator, and it is exported from the port so no layer can invent a
    // second one.
    //
    // `FileSystemInputAssets` is deliberately UNTOUCHED and needs no id branch:
    // on fs a uuid is not a path either, so it answers `undefined` there too —
    // the two backends agree on a ref neither can read, and no fs caller starts
    // receiving ids from this lane (D208d: fs stores path refs, unchanged).
    if (isAssetId(ref)) {
      // The store is looked up HERE, before the pending promise exists, for the
      // same reason and with the same wording as the path branch below: a
      // synchronous throw from `getAssetStore` must reject `read` with nothing
      // memoised, not run `memo.delete` before the `memo.set` this line's callee
      // is about to reach (f22778b5).
      const assets = getAssetStore(this.env);
      const pending = this.fetchById(ref, assets);
      if (this.memo !== undefined) this.memo.set(ref, pending);
      return Buffer.from(await pending);
    }

    // The SAFETY gate stays its own `resolveAssetPath` call: `read` must tell "unsafe,
    // skip the asset" (`undefined`) from "safe but unreadable" (ENOENT), and
    // `parseStoredInputRef` collapses both into `undefined` (see its note). The ref is
    // pure and the call is a string operation, so the one extra normalisation buys the
    // write-side checks a parse that cannot drift from this one.
    if (resolveAssetPath(ref, SYNTHETIC_ROOT) === undefined) return undefined;

    const target = parseStoredInputRef(ref);
    if (target === undefined) {
      throw absent(ref, "only assets/inputs/<slug>/<name> is a stored ref on this backend.");
    }

    // The store is looked up HERE, before any promise exists: `getAssetStore` can
    // throw synchronously (a malformed OBJECT_STORE), and a throw inside `fetch`
    // would run its `memo.delete` BEFORE the `memo.set` below — leaving an
    // already-rejected promise cached for the run. Thrown here, `read` simply
    // rejects and nothing is stored.
    const assets = getAssetStore(this.env);

    // Stored BEFORE it is awaited, which is the whole of it: the next cell to ask
    // while this one is still in flight finds the promise and waits on it.
    const pending = this.fetch(ref, target, assets);
    if (this.memo !== undefined) this.memo.set(ref, pending);
    return Buffer.from(await pending);
  }

  /**
   * One read of one ref, and the only place the memo is forgotten.
   *
   * Everything here is inside a `try` whose `catch` drops the entry, because a
   * promise that is left in the map after rejecting is a permanent answer: the
   * bucket that could not be read at the moment the run started, and the asset
   * that had not been uploaded yet, are both things a LATER read has to be able to
   * find. Only this caller owns the entry — a caller that joined an in-flight read
   * never stored it, and so must not delete it.
   */
  private async fetch(ref: string, target: InputRef, assets: AssetStorePort): Promise<Uint8Array> {
    try {
      // The store's own org-scoped resolve → row → `get`, left to propagate: an
      // `S3RequestError` or a pg error is a deployment that cannot answer, and the
      // caller must hear it as one.
      const bytes = await assets.readAsset(target.slug, target.name);
      if (bytes === undefined) {
        throw absent(ref, "no campaign, asset row or object in this org answers it.");
      }
      return bytes;
    } catch (error) {
      this.memo?.delete(ref);
      throw error;
    }
  }

  /**
   * One read of one asset id, and the id branch's half of "a failed read is not
   * remembered" (PT-4k1). It is its own method rather than a parameter of
   * {@link ObjectInputAssets.fetch} because the two have nothing to share but the
   * memo and the `catch`: an id names a row directly, so there is no slug/name
   * pair to parse and no `InputRef` to carry — folding them together would mean
   * a union threading a `undefined` ref through the path branch's SQL.
   *
   * **Both paths forget on failure, and that is not a detail.** An id ref is
   * memoised exactly as a path ref is — same map, keyed by the ref string, so a
   * brief that mixes both forms keeps one entry per ref — and a cached rejection
   * would be a permanent answer for the rest of the run: the asset that had not
   * been uploaded yet is exactly what a re-run has to be able to find.
   */
  private async fetchById(ref: string, assets: AssetStorePort): Promise<Uint8Array> {
    try {
      // Left to propagate, as on the path branch: a store that refuses is a
      // deployment that cannot answer, and ENOENT means "this ref names nothing
      // here" — a different, non-retryable-looking claim than "the bucket is
      // down", which is what would mislead a consumer that branches on the code.
      const bytes = await assets.readAssetById(ref);
      if (bytes === undefined) {
        // `undefined` covers a row this org does not hold — another org's id
        // included, which must read as absent rather than forbidden — and a row
        // whose object is gone. Both are "could not be read", which is what
        // ENOENT says; `undefined` would say the ref is unsafe, and blame a brief
        // for naming nothing wrong.
        throw absent(ref, "no asset row in this org answers it.");
      }
      return bytes;
    } catch (error) {
      this.memo?.delete(ref);
      throw error;
    }
  }
}
