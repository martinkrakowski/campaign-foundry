import { errorMessage } from "@campaignfoundry/shared";
import { getTemplateStore } from "../../lib/ports/index.js";

import { requestTenant } from "../../lib/tenant.js";
/**
 * GET /campaigns/templates — list every template record in the library, one
 * entry per version (D123, L7). A store read failure is a 500, never an
 * empty list — an empty answer reads as "no templates yet" to the library
 * page, the same rule `GET /campaigns/briefs` follows for the brief store.
 */
export default defineEventHandler(async (event) => {
  try {
    const templates = await getTemplateStore(requestTenant(event)).listTemplates();
    return { templates };
  } catch (error) {
    console.warn(`[templates] could not read templates: ${errorMessage(error)}`);
    setResponseStatus(event, 500);
    return { error: `Could not read templates: ${errorMessage(error)}` };
  }
});
