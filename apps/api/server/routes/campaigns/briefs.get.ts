import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
import { loadBrief } from "../../lib/load-brief.js";

/** Brief formats the CLI/loader understands. */
const BRIEF_PATTERN = /\.(ya?ml|json)$/i;

/**
 * GET /campaigns/briefs — list the campaign briefs available under `<repo>/briefs`,
 * each parsed so the UI's brief picker can show a summary and load one without a
 * second request. Unparseable files are skipped (a malformed brief shouldn't break
 * the list). Directory is fixed (no user input), so there's no traversal surface.
 */
export default defineEventHandler(async () => {
  const dir = resolve(projectRoot(), "briefs");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => BRIEF_PATTERN.test(f)).sort();
  } catch {
    return { briefs: [] };
  }

  const briefs = [];
  for (const file of files) {
    try {
      briefs.push({ file, brief: await loadBrief(resolve(dir, file)) });
    } catch {
      // Skip a malformed/invalid brief rather than failing the whole list.
    }
  }
  return { briefs };
});
