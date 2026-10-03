import { relative } from "node:path";
import type { InputAssetPort } from "@campaignfoundry/CampaignOrchestration";
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
interface InputRef {
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

    // PT-4k note: once a brief's refs become asset ids, the id branch has to come
    // BEFORE this check — `resolveAssetPath` refuses a bare uuid, so an id checked
    // here would read as an unsafe ref and every scene and bed would answer "is
    // not a valid asset path".
    const safePath = resolveAssetPath(ref, SYNTHETIC_ROOT);
    if (safePath === undefined) return undefined;

    const target = parseInputRef(relative(SYNTHETIC_ROOT, safePath));
    if (target === undefined) {
      throw absent(ref, "only assets/inputs/<slug>/<name> is a stored ref on this backend.");
    }

    // Stored BEFORE it is awaited, which is the whole of it: the next cell to ask
    // while this one is still in flight finds the promise and waits on it.
    const pending = this.fetch(ref, target);
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
  private async fetch(ref: string, target: InputRef): Promise<Uint8Array> {
    try {
      // The store's own org-scoped resolve → row → `get`, left to propagate: an
      // `S3RequestError` or a pg error is a deployment that cannot answer, and the
      // caller must hear it as one.
      const bytes = await getAssetStore(this.env).readAsset(target.slug, target.name);
      if (bytes === undefined) {
        throw absent(ref, "no campaign, asset row or object in this org answers it.");
      }
      return bytes;
    } catch (error) {
      this.memo?.delete(ref);
      throw error;
    }
  }
}
