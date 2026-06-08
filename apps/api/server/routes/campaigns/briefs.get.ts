import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { errorMessage, projectRoot } from "@campaignfoundry/shared";
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
    // withFileTypes + isFile() lists only regular files; symlinks (isFile() is false
    // for them) are skipped, so a symlink dropped into briefs/ can't make us read a
    // file outside the directory — defense-in-depth on the "fixed directory" assumption.
    const entries = await readdir(dir, { withFileTypes: true });
    files = entries
      .filter((e) => e.isFile() && BRIEF_PATTERN.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch (error) {
    console.warn(`[briefs] could not read ${dir}: ${errorMessage(error)}`);
    return { briefs: [] };
  }

  const briefs = [];
  for (const file of files) {
    try {
      briefs.push({ file, brief: await loadBrief(resolve(dir, file)) });
    } catch (error) {
      // Skip a malformed/invalid brief rather than failing the whole list — but log
      // it so a reviewer can see why their brief isn't appearing in the picker.
      console.warn(`[briefs] skipped ${file}: ${errorMessage(error)}`);
    }
  }
  return { briefs };
});
