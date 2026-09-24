import { constants, createReadStream } from "node:fs";
import { open, readdir, readFile, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { outputRoot } from "../config.js";
import { resolveConfined, resolveConfinedForRead } from "../confined-path.js";
import type {
  OutputLookup,
  OutputStorePort,
  PackageFileEntry,
  StoredFile,
} from "./output-store.port.js";

const MISSING: OutputLookup = { found: false, reason: "missing" };

/** The run cache and the job records live under the output root but are not output. */
function isHidden(posix: string): boolean {
  return (
    posix === "cache" || posix.startsWith("cache/") || posix === "jobs" || posix.startsWith("jobs/")
  );
}

/** Whether `path` is an existing directory; false for anything else, missing included. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Output as files under `<outputRoot>`: renders and proofs at their relative
 * paths, packages under `packages/<campaignId>/<platformId>/`. The root is
 * resolved per call unless one is given, the same shape the other file stores use.
 */
export class FsOutputStore implements OutputStorePort {
  private readonly customRoot?: string;

  constructor(root?: string) {
    if (root) this.customRoot = resolve(root);
  }

  private get root(): string {
    return this.customRoot ?? resolve(outputRoot());
  }

  async openOutput(relativePath: string): Promise<OutputLookup> {
    const root = this.root;
    let target: string;
    if (relativePath === "") {
      // resolveConfined rejects the base itself; the root is a directory, which the
      // isFile check below answers as missing.
      target = root;
    } else {
      try {
        target = resolveConfined(root, relativePath);
      } catch {
        return { found: false, reason: "invalid" };
      }
      try {
        // A symlink inside the root may aim outside it; resolveConfinedForRead validates
        // the real path and returns it, so the open below re-checks the same real path,
        // not a lexical name that could have been swapped since.
        target = await resolveConfinedForRead(root, relativePath);
        // Judge the hidden areas on the real target, never the raw string: however the
        // path is spelled ("camp/../cache/run.json") or wherever a symlink in the root
        // points, the run cache and the job records are not output.
        if (
          isHidden(
            relative(await realpath(root), target)
              .split(sep)
              .join("/"),
          )
        )
          return MISSING;
      } catch {
        return MISSING;
      }
    }

    let handle: FileHandle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      // Missing, or the checked entry was swapped for a symlink before this open (ELOOP).
      return MISSING;
    }
    let size: number;
    try {
      const st = await handle.stat();
      if (!st.isFile()) {
        // Directories are not downloadable output; streaming one fails with EISDIR.
        await handle.close();
        return MISSING;
      }
      size = st.size;
    } catch {
      await handle.close();
      return MISSING;
    }
    const file: StoredFile = {
      name: basename(target),
      size,
      stream(range) {
        const stream =
          range === undefined
            ? handle.createReadStream()
            : handle.createReadStream({ start: range.start, end: range.end });
        // FileHandle read streams close their handle when they end; this covers every
        // other exit, including a client abort (destroyed without an 'end'). Closing an
        // already-closed handle does not throw.
        stream.on("close", () => {
          void handle.close();
        });
        return stream;
      },
      close: () => handle.close(),
    };
    return { found: true, file };
  }

  async listPackageManifests(campaignId: string): Promise<readonly object[]> {
    if (!SAFE_ID_PATTERN.test(campaignId)) return [];
    let campaignDir: string;
    try {
      // The campaign dir, or a manifest inside it, may be a symlink aiming outside the root.
      campaignDir = await resolveConfinedForRead(this.root, "packages", campaignId);
    } catch {
      return [];
    }
    if (!(await isDirectory(campaignDir))) return [];

    const manifests: object[] = [];
    const entries = await readdir(campaignDir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      if (!SAFE_ID_PATTERN.test(entry.name)) continue;
      try {
        const manifestPath = await resolveConfinedForRead(campaignDir, entry.name, "manifest.json");
        const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          manifests.push(parsed);
        }
      } catch {
        continue;
      }
    }
    return manifests;
  }

  async listPackageFiles(
    campaignId: string,
    platformId: string,
  ): Promise<readonly PackageFileEntry[] | undefined> {
    if (!SAFE_ID_PATTERN.test(campaignId) || !SAFE_ID_PATTERN.test(platformId)) return undefined;
    let platformDir: string;
    try {
      // The platform dir may be a symlink aiming outside the output root.
      platformDir = await resolveConfinedForRead(this.root, "packages", campaignId, platformId);
    } catch {
      return undefined;
    }
    if (!(await isDirectory(platformDir))) return undefined;

    const out: PackageFileEntry[] = [];
    async function walk(current: string, rel: string): Promise<void> {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full, nextRel);
        } else if (entry.isFile()) {
          out.push({ name: nextRel, open: () => createReadStream(full) });
        }
      }
    }
    await walk(platformDir, "");
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}
