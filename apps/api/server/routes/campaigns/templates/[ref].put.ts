import type { CreativeTemplate } from "@campaignfoundry/CampaignOrchestration";
import { getTemplateStore } from "../../../lib/ports/index.js";
import {
  canWriteTemplates,
  parseTemplateWriteBody,
  respondTemplateWriteError,
} from "../../../lib/template-write.js";
import { requestTenant } from "../../../lib/tenant.js";
/**
 * PUT /campaigns/templates/:ref — add the next version of an org template
 * (RW-22, D123's immutability promise). `:ref` is a bare id: an `@` in it is
 * refused (`400`) before anything is looked up, because a version suffix is
 * the GET route's syntax and a PUT never names a version — the store assigns
 * `existing.version + 1`.
 *
 * A missing id and another org's id answer the identical 404 and write
 * nothing: the store is org-scoped, so `findTemplate` cannot see across orgs,
 * and nothing is written for either. The write itself is a new
 * (org, id, version) record — version 1 stays byte-identical — and two
 * concurrent PUTs race the store's primary key, the loser mapped through
 * `TemplateVersionExistsError` to 409.
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);
  if (!canWriteTemplates(scope)) {
    setResponseStatus(event, 403);
    return { error: "Not authorized to save templates." };
  }
  const ref = String(getRouterParam(event, "ref"));
  if (!ref || ref.includes("@")) {
    setResponseStatus(event, 400);
    return { error: 'Template id must not contain "@".' };
  }
  try {
    const { name, unit, creativeType, layers } = await parseTemplateWriteBody(event);
    const store = getTemplateStore(scope);
    const existing = await store.findTemplate(ref);
    if (!existing) {
      setResponseStatus(event, 404);
      return { error: `Template not found: "${ref}"` };
    }
    const template: CreativeTemplate = {
      id: existing.id,
      version: existing.version + 1,
      name: name as string,
      unit: unit as CreativeTemplate["unit"],
      creativeType: creativeType as CreativeTemplate["creativeType"],
      layers: layers as CreativeTemplate["layers"],
    };
    await store.saveTemplate(template, scope.userId);
    return { template };
  } catch (error) {
    return respondTemplateWriteError(event, error);
  }
});
