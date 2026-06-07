import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { outputRoot } from "../../lib/config.js";

/** GET /campaigns/result — the most recent run's report.json, or an empty result. */
export default defineEventHandler(async () => {
  try {
    return JSON.parse(await readFile(resolve(outputRoot(), "report.json"), "utf8"));
  } catch {
    return { halted: false, assets: [], log: null };
  }
});
