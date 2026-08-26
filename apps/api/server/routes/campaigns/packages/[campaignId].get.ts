import { readdir, readFile, stat } from "node:fs/promises";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { outputRoot } from "../../../lib/config.js";
import { resolveConfined } from "../../../lib/confined-path.js";

/**
 * GET /campaigns/packages/:campaignId — list persisted platform manifests under
 * output/packages/<campaignId>/<platform>/manifest.json. 404 if none.
 */
export default defineEventHandler(async (event) => {
  const campaignId = String(getRouterParam(event, "campaignId"));
  if (!SAFE_ID_PATTERN.test(campaignId)) {
    setResponseStatus(event, 400);
    return { error: "Invalid campaign id" };
  }

  const campaignDir = resolveConfined(outputRoot(), "packages", campaignId);

  try {
    const st = await stat(campaignDir);
    if (!st.isDirectory()) {
      setResponseStatus(event, 404);
      return { error: "No packages found" };
    }
  } catch {
    setResponseStatus(event, 404);
    return { error: "No packages found" };
  }

  const platforms: unknown[] = [];
  const entries = await readdir(campaignDir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (!SAFE_ID_PATTERN.test(entry.name)) continue;
    const manifestPath = resolveConfined(campaignDir, entry.name, "manifest.json");
    try {
      const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        platforms.push(parsed);
      }
    } catch {
      continue;
    }
  }

  if (platforms.length === 0) {
    setResponseStatus(event, 404);
    return { error: "No packages found" };
  }
  return { platforms };
});
