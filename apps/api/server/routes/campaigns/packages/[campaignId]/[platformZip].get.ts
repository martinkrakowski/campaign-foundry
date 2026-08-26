import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { send } from "h3";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { outputRoot } from "../../../../lib/config.js";
import { resolveConfined } from "../../../../lib/confined-path.js";
import { buildStoreZip } from "../store-zip.js";

async function collectFiles(dir: string): Promise<Array<{ name: string; data: Buffer }>> {
  const out: Array<{ name: string; data: Buffer }> = [];
  async function walk(current: string, rel: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, nextRel);
      } else if (entry.isFile()) {
        out.push({ name: nextRel, data: await readFile(full) });
      }
    }
  }
  await walk(dir, "");
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * GET /campaigns/packages/:campaignId/:platformId.zip — store-only zip of that
 * platform folder. 404 if the directory does not exist.
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

  const files = await collectFiles(platformDir);
  const zip = buildStoreZip(files);
  setHeader(event, "content-disposition", `attachment; filename="${platformId}.zip"`);
  return send(event, zip, "application/zip");
});
