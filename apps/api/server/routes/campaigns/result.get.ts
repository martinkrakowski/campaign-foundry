import { readFile } from "node:fs/promises";
import { outputRoot } from "../../lib/config.js";
import { campaignReportPath, latestReportPath } from "../../lib/report.js";

/** The empty "no run yet" result the UI treats as "never ran". */
const EMPTY = { halted: false, assets: [], log: null };

/**
 * GET /campaigns/result — a run's persisted report.json.
 *
 * With `?campaignId=`, returns that brief's own report (`<output>/reports/<id>.json`),
 * so switching briefs in the UI reloads the right run rather than the most recent one;
 * an unknown or unsafe id yields the empty result. Without it, returns the latest run.
 */
export default defineEventHandler(async (event) => {
  const root = outputRoot();
  const campaignId = getQuery(event).campaignId;

  let path: string | null;
  if (campaignId !== undefined) {
    // A present campaignId must be a single string. Repeated params yield string[] —
    // treat that (and any non-string) as an invalid id → empty, not a fall-through to
    // the latest run, matching the "unknown/unsafe id → empty result" contract.
    if (typeof campaignId !== "string") return EMPTY;
    path = campaignReportPath(root, campaignId); // null for an unsafe/empty id
    if (!path) return EMPTY;
  } else {
    path = latestReportPath(root);
  }

  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return EMPTY;
  }
});
