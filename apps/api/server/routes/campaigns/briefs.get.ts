import { errorMessage } from "@campaignfoundry/shared";
import { getBriefStore } from "../../lib/ports/index.js";

/**
 * GET /campaigns/briefs — list the campaign briefs available in the brief store,
 * each parsed so the UI's brief picker can show a summary and load one without a
 * second request. Unparseable files are skipped (a malformed brief shouldn't break
 * the list). A store read failure is a 500, not an empty list — an empty answer
 * reads as "no campaigns yet" to every consumer.
 */
export default defineEventHandler(async (event) => {
  try {
    const briefs = await getBriefStore().listBriefs();
    return { briefs };
  } catch (error) {
    console.warn(`[briefs] could not read briefs: ${errorMessage(error)}`);
    setResponseStatus(event, 500);
    return { error: `Could not read briefs: ${errorMessage(error)}` };
  }
});
