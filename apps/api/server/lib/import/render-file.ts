import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { relative } from "node:path";
import { errorMessage } from "@campaignfoundry/shared";
import { isErrno } from "../brief-files.js";
import { resolveConfined } from "../confined-path.js";
import { parentsAreReal } from "./census.js";
import { fingerprint, type DigestFile } from "./digest.js";
import type { Reviewed } from "./rows-step.js";

/** The most a render may weigh to be imported: 512 MiB. A larger one is refused and listed (PT-8d). */
export const MAX_RENDER_BYTES = 512 * 1024 * 1024;

/**
 * A render's source file as the import may use it, BEFORE any byte is read:
 * not there, the reviewed file (where it is, and its size), or refused.
 */
export type RenderFileState =
  | { readonly state: "absent" }
  | {
      readonly state: "ok";
      readonly rel: string;
      readonly file: string;
      readonly size: number;
    }
  | { readonly state: "refused"; readonly reason: string };

/** `maxBytes`: the cap, 512 MiB when absent. `read`: how the bytes are read, `readFile` when absent. */
export interface RenderFileOptions {
  readonly maxBytes?: number;
  readonly read?: (file: string) => Promise<Buffer>;
}

/**
 * The reviewed stamps of a digest's files: every entry that has a `fingerprint`
 * (`size:<n>:mtime:<ms>`), keyed by `rel`, as `replan` and `plan` hold them.
 */
export function renderFingerprints(files: readonly DigestFile[]): Map<string, string> {
  const stamps = new Map<string, string>();
  for (const file of files) {
    if (file.fingerprint !== undefined) stamps.set(file.rel, file.fingerprint);
  }
  return stamps;
}

/**
 * Whether `<outputRoot>/<path>` is still the render the plan's digest covered
 * (PT-8d; D221, D225), without reading it: confined to the output root, never
 * through a symlink (the file or a directory above it), a regular file, its
 * `lstat` size and time equal to the reviewed stamp, and not over the cap. A
 * file that is not there is `absent` unless the digest named it: then it was
 * removed after the review. It never throws.
 */
export async function statReviewedRender(
  outputRoot: string,
  path: string,
  fingerprints: ReadonlyMap<string, string>,
  options: RenderFileOptions = {},
): Promise<RenderFileState> {
  const refused = (reason: string): RenderFileState => ({ state: "refused", reason });
  let file: string;
  try {
    file = resolveConfined(outputRoot, path);
  } catch (error) {
    return refused(errorMessage(error));
  }
  const rel = relative(outputRoot, file);
  let st: Stats;
  try {
    st = await lstat(file);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) return refused(errorMessage(error));
    if (!fingerprints.has(rel)) return { state: "absent" };
    return refused(`${rel} changed since the digest`);
  }
  const parents = await parentsAreReal(outputRoot, rel);
  if (parents !== undefined) return refused(parents);
  if (st.isSymbolicLink()) return refused(`${rel} is a symlink; the importer never follows one`);
  if (!st.isFile()) return refused(`${rel} is not a regular file.`);
  const reviewed = fingerprints.get(rel);
  if (reviewed === undefined) return refused(`${rel} is not in the reviewed digest`);
  if (fingerprint(st) !== reviewed) return refused(`${rel} changed since the digest`);
  const maxBytes = options.maxBytes ?? MAX_RENDER_BYTES;
  if (st.size > maxBytes) {
    return refused(`${rel} is ${st.size} bytes; the render cap is ${maxBytes} bytes.`);
  }
  return { state: "ok", rel, file, size: st.size };
}

/**
 * Read one render for the import: {@link statReviewedRender} first, then the
 * bytes, whole. Bytes that are not the size just checked are refused (the file
 * changed while it was read). It never throws: a read that fails is refused.
 */
export async function readReviewedRender(
  outputRoot: string,
  path: string,
  fingerprints: ReadonlyMap<string, string>,
  options: RenderFileOptions = {},
): Promise<Reviewed> {
  const found = await statReviewedRender(outputRoot, path, fingerprints, options);
  if (found.state !== "ok") return found;
  const read = options.read ?? ((file: string) => readFile(file));
  try {
    const bytes = await read(found.file);
    if (bytes.length !== found.size) {
      return { state: "refused", reason: `${found.rel} changed while it was read` };
    }
    return { state: "ok", bytes };
  } catch (error) {
    return { state: "refused", reason: errorMessage(error) };
  }
}
