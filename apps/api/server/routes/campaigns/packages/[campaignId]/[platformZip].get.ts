import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { getOutputStore, type PackageFileEntry } from "../../../../lib/ports/index.js";
import { measure, storeZipStream, type ZipEntry } from "../store-zip.js";

import { requestTenant } from "../../../../lib/tenant.js";
type FileEntry = ZipEntry & Pick<PackageFileEntry, "open">;

/** Packaging swaps the platform folder with rm + rename; a walk can land in that gap. */
const isRewriteError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** First pass: take each file's size + CRC without holding the bytes. */
async function measureEntries(entries: readonly PackageFileEntry[]): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (const entry of entries) {
    // Call through the entry, never a detached copy of its method: a store whose
    // open() reads instance state through `this` must keep it.
    out.push({ name: entry.name, open: () => entry.open(), ...(await measure(entry.open())) });
  }
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

  let files: FileEntry[];
  try {
    const entries = await getOutputStore(requestTenant(event)).listPackageFiles(
      campaignId,
      platformId,
    );
    if (entries === undefined) {
      setResponseStatus(event, 404);
      return { error: "Not found" };
    }
    files = await measureEntries(entries);
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
    storeZipStream(files, (entry) => entry.open()),
  );
});
