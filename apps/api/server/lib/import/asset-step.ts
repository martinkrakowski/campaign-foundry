import { type Dirent, readdirSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { resolveAssetPath } from "@campaignfoundry/CreativeGeneration";
import { blocksImport } from "./classify.js";
import { hashBytes, isErrno, isExistsError } from "../brief-files.js";
import type { AssetEntry, AssetStorePort } from "../ports/asset-store.port.js";
import type { ScannedCampaign } from "./scan.js";
import type { StepContext } from "./steps.js";

/**
 * One ref the importer will write as an asset of THIS campaign, resolved from a
 * clean classified ref (D219, D222): the raw path the brief carried, its basename
 * (the name the asset row will record), the absolute path to read, and the `from`
 * value the suffix rule needs (`writeOrReuse`).
 */
export interface RefTarget {
  /** The raw path string the brief named, e.g. `assets/inputs/<slug>/logo.png`. */
  readonly ref: string;
  /** The basename written as the asset's `name`. */
  readonly name: string;
  /** The absolute path under `assets/` the bytes are read from. */
  readonly path: string;
  /** Plain stem for an own ref, the other slug for an other-campaign ref, `"root"` otherwise. */
  readonly from: string;
}

/**
 * The writeable targets of a campaign's refs: every clean ref (own-campaign,
 * other-campaign, root-level, other-safe-assets), resolved through
 * `resolveAssetPath` exactly as `classify.ts` does — never a path outside
 * `assets/`, and never one that did not survive classification.
 */
export function resolveRefTargets(ctx: StepContext, campaign: ScannedCampaign): RefTarget[] {
  const targets: RefTarget[] = [];
  for (const ref of campaign.refs) {
    if (blocksImport(ref)) continue;
    const path = resolveAssetPath(ref.ref, ctx.projectRoot)!;
    const rel = relative(resolve(ctx.projectRoot, "assets"), path);
    const parts = rel.split("/");
    const from = parts[0] !== "inputs" ? "root" : parts.length < 3 ? "root" : parts[1];
    targets.push({ ref: ref.ref, name: basename(path), path, from });
  }
  return targets;
}

/**
 * The regular files sitting directly in `assets/inputs/<slug>/` that no clean
 * ref names (D219, D225): owned-inputs the plan's digest never hashed, so an
 * import must not write them. Counted by `lstat` (`readdir` does not follow
 * links here), so a symlinked input is skipped, never read.
 */
export interface UnreferencedInputs {
  readonly count: number;
  readonly names: readonly string[];
}

export function countUnreferencedInputs(
  ctx: StepContext,
  slug: string,
  refTargets: readonly RefTarget[],
): UnreferencedInputs {
  const dir = join(ctx.projectRoot, "assets", "inputs", slug);
  const referenced = new Set(refTargets.map((t) => t.path));
  const names: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { count: 0, names: [] };
    throw error;
  }
  for (const entry of entries) {
    // `lstat`-based (`withFileTypes`): a symlink answers `isFile() === false`
    // and is skipped, never followed — the importer never reads through one (D222).
    if (!entry.isFile()) continue;
    if (referenced.has(join(dir, entry.name))) continue;
    names.push(entry.name);
  }
  return { count: names.length, names };
}

/**
 * The candidate names `writeOrReuse` tries, in order (D219, mirrored from
 * `object-asset-store.ts:643-658`): the plain `<stem><ext>` first, then
 * `<stem>-<from><ext>`, then `<stem>-<from>-2<ext>`, … — one per call, lazily,
 * so a fresh name is minted on the first that is free.
 */
export function* candidateNames(name: string, from: string): Generator<string> {
  for (let index = 0; ; index++) {
    yield candidateAt(name, from, index);
  }
}

/** The candidate at `index`: plain for 0, `<stem>-<from><ext>` for 1, then `-N`. */
export function candidateAt(name: string, from: string, index: number): string {
  if (index === 0) return name;
  const ext = extname(name);
  const stem = basename(name, ext);
  const base = index === 1 ? `${stem}-${from}` : `${stem}-${from}-${index}`;
  return `${base}${ext}`;
}

export interface WrittenAsset {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly reused: boolean;
}

/** The id `listAssets` reports for `name` (s3 always has one). */
async function reusedId(assets: AssetStorePort, slug: string, name: string): Promise<string> {
  const entries = await assets.listAssets(slug);
  const entry = entries.find((e) => e.name === name);
  return (entry as AssetEntry).id as string;
}

/**
 * Write one ref target as an asset of `slug`, named by its basename, reusing an
 * existing same-name/same-bytes row when one exists (D219, D221). On EEXIST the
 * existing bytes are compared by sha256: equal bytes reuse that row (its id taken
 * from `listAssets`, never a guessed one), different bytes advance to the next candidate.
 */
export function missingAsset(slug: string, name: string): Error {
  return new Error(`asset ${name} of ${slug} has a row but its bytes cannot be read`);
}

export async function writeOrReuse(
  assets: AssetStorePort,
  slug: string,
  name: string,
  bytes: Buffer,
  from: string,
): Promise<WrittenAsset> {
  const sourceSha = hashBytes(bytes);
  for (let index = 0; ; index++) {
    const candidate = candidateAt(name, from, index);
    try {
      const written = await assets.writeAsset(slug, candidate, bytes);
      return {
        id: written.id as string,
        name: candidate,
        key: written.objectKey as string,
        reused: false,
      };
    } catch (error) {
      if (!isExistsError(error)) throw error;
      const existing = await assets.readAsset(slug, candidate);
      if (existing === undefined) throw missingAsset(slug, candidate);
      if (hashBytes(existing) === sourceSha) {
        return {
          id: await reusedId(assets, slug, candidate),
          name: candidate,
          key: (await assets.assetObjectKey(slug, candidate)) as string,
          reused: true,
        };
      }
    }
  }
}
