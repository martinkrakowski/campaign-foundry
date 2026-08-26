import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { outputRoot } from "../../../../lib/config.js";
import { resolveConfined } from "../../../../lib/confined-path.js";
import { measure, storeZipStream, type ZipEntry } from "../store-zip.js";

type FileEntry = ZipEntry & { readonly path: string };

/** Packaging swaps the platform folder with rm + rename; a walk can land in that gap. */
const isRewriteError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** First pass: walk the folder and take each file's size + CRC without holding the bytes. */
async function collectEntries(dir: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function walk(current: string, rel: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, nextRel);
      } else if (entry.isFile()) {
        out.push({ name: nextRel, path: full, ...(await measure(createReadStream(full))) });
      }
    }
  }
  await walk(dir, "");
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * GET /campaigns/packages/:campaignId/:platformId.zip — store-only zip of that
 * platform folder, streamed. 404 if the directory does not exist; 409 if the
 * folder disappears mid-walk (packaging is rewriting it — retry).
 */
export default defineEventHandler(async (event) => {
  const campaignId = String(getRouterParam(event, "campaignId"));
  const platformZip = String(getRouterParam(event, "platformZip"));
  if (!SAFE_ID_PATTERN.test(campaignId)) {
    setResponseStatus(event, 400);
    return { error: "Invalid campaign id" };
  }
  if (!platformZip.endsWith(".zip")) {
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }
  const platformId = platformZip.slice(0, -".zip".length);
  if (!SAFE_ID_PATTERN.test(platformId)) {
    setResponseStatus(event, 400);
    return { error: "Invalid platform id" };
  }

  const platformDir = resolveConfined(outputRoot(), "packages", campaignId, platformId);

  try {
    const st = await stat(platformDir);
    if (!st.isDirectory()) {
      setResponseStatus(event, 404);
      return { error: "Not found" };
    }
  } catch {
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }

  let files: FileEntry[];
  try {
    files = await collectEntries(platformDir);
  } catch (error) {
    if (isRewriteError(error)) {
      setResponseStatus(event, 409);
      return { error: "Package is being rewritten, retry" };
    }
    throw error;
  }

  setHeader(event, "content-type", "application/zip");
  setHeader(event, "content-disposition", `attachment; filename="${platformId}.zip"`);
  return sendStream(
    event,
    storeZipStream(files, (entry) => createReadStream(entry.path)),
  );
});
