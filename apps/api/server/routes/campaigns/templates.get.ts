import { errorMessage } from "@campaignfoundry/shared";
import { getTemplateStore } from "../../lib/ports/index.js";
import {
  MAX_TEMPLATES_PAGE_SIZE,
  byIdThenVersion,
  decodeTemplateCursor,
  paginateTemplates,
  type PaginatedTemplateStorePort,
  type TemplateListOptions,
  type TemplateListPage,
} from "../../lib/ports/template-store.port.js";

import { requestTenant } from "../../lib/tenant.js";
/**
 * GET /campaigns/templates — list every template record in the library, one
 * entry per version (D123, L7), optionally paginated. Without a `limit` the
 * whole library is returned (bounded by the per-org caps) — the shape the
 * web client's `listTemplates` has always read — so a caller that asks for
 * nothing misses nothing. With `limit` (and `cursor`), the list is served in
 * `byIdThenVersion` order through the store's own pagination, or over the
 * plain list when the store does not serve it (minimal test doubles).
 * A store read failure is a 500, never an empty list — an empty answer reads
 * as "no templates yet" to the library page, the same rule
 * `GET /campaigns/briefs` follows for the brief store.
 */
export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event);
    let limit: number | undefined;
    if (query.limit !== undefined) {
      const raw = String(query.limit);
      if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_TEMPLATES_PAGE_SIZE) {
        setResponseStatus(event, 400);
        return { error: 'Invalid "limit" query parameter.' };
      }
      limit = Number(raw);
    }
    let cursor: string | undefined;
    if (query.cursor !== undefined) {
      cursor = String(query.cursor);
      try {
        decodeTemplateCursor(cursor);
      } catch {
        setResponseStatus(event, 400);
        return { error: 'Invalid "cursor" query parameter.' };
      }
    }
    const options: TemplateListOptions | undefined =
      limit === undefined && cursor === undefined ? undefined : { limit, cursor };
    const store = getTemplateStore(requestTenant(event));
    const paginated = store as Partial<PaginatedTemplateStorePort>;
    const page: TemplateListPage =
      typeof paginated.listTemplatesPage === "function"
        ? await paginated.listTemplatesPage(options)
        : {
            ...paginateTemplates([...(await store.listTemplates())].sort(byIdThenVersion), options),
            skipped: 0,
          };
    const { templates, skipped, nextCursor } = page;
    // `nextCursor` is left out entirely when there is no next page, so a
    // body without it is unambiguous to a client that reads its presence.
    return { templates, skipped, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  } catch (error) {
    console.warn(`[templates] could not read templates: ${errorMessage(error)}`);
    setResponseStatus(event, 500);
    return { error: `Could not read templates: ${errorMessage(error)}` };
  }
});
