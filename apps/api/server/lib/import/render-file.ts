import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
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
      readonly dev: number;
      readonly ino: number;
    }
  | { readonly state: "refused"; readonly reason: string };

/**
 * `maxBytes`: the cap, 512 MiB when absent. `open`: how the checked file is opened
 * for reading, `open` of `node:fs/promises` when absent. A test changes the file in it.
 */
export interface RenderFileOptions {
  readonly maxBytes?: number;
  readonly open?: (file: string, flags: number) => Promise<FileHandle>;
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
 * removed after the review. A file that is not there under a symlinked
 * directory answers the same way (absent, or changed when the digest named
 * it) before the directories are checked: no byte is read through the link (the
 * `lstat` does resolve through it),
 * and `plan` and `readReviewed` answer the same. It never throws.
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
  return { state: "ok", rel, file, size: st.size, dev: st.dev, ino: st.ino };
}

/**
 * Read one render for the import: {@link statReviewedRender} first. Then the
 * file is opened ONCE, the file itself never through a symlink (`O_NOFOLLOW`; a
 * directory above it is covered by the device and inode of the checked file),
 * and the open file itself must still be a regular file with the reviewed
 * stamp. No more than its reviewed size plus one byte is read: a file that
 * grew, shrank or was swapped after the check is refused ("changed while it
 * was read"). The stamp is taken again after the read: a file rewritten in
 * place while it was read is refused. It never throws: an open or a read
 * that fails is refused; a failed close is ignored.
 */
export async function readReviewedRender(
  outputRoot: string,
  path: string,
  fingerprints: ReadonlyMap<string, string>,
  options: RenderFileOptions = {},
): Promise<Reviewed> {
  const found = await statReviewedRender(outputRoot, path, fingerprints, options);
  if (found.state !== "ok") return found;
  const changed: Reviewed = { state: "refused", reason: `${found.rel} changed while it was read` };
  const opener = options.open ?? open;
  let fh: FileHandle | undefined;
  try {
    fh = await opener(found.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await fh.stat();
    const same =
      st.isFile() &&
      fingerprint(st) === fingerprints.get(found.rel) &&
      st.dev === found.dev &&
      st.ino === found.ino;
    if (!same) return changed;
    // One byte more than the reviewed size: a file that grew fills it, and is refused.
    const bytes = Buffer.alloc(found.size + 1);
    let filled = 0;
    while (filled < bytes.length) {
      const { bytesRead } = await fh.read(bytes, filled, bytes.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled !== found.size) return changed;
    const after = await fh.stat();
    if (fingerprint(after) !== fingerprints.get(found.rel)) return changed;
    return { state: "ok", bytes: bytes.subarray(0, found.size) };
  } catch (error) {
    if (isErrno(error, "ELOOP")) return changed;
    return { state: "refused", reason: errorMessage(error) };
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
