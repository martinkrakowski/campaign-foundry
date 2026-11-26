import type { CreativeTemplate } from "@campaignfoundry/CampaignOrchestration";
import { randomUUID } from "node:crypto";
import { getTemplateStore } from "../../lib/ports/index.js";
import {
  canWriteTemplates,
  parseTemplateWriteBody,
  respondTemplateWriteError,
} from "../../lib/template-write.js";
import { requestTenant } from "../../lib/tenant.js";
/**
 * POST /campaigns/templates — create an org template (RW-22).
 *
 * Body `{ name, unit, creativeType, layers }`; the server mints `id`
 * (`tpl-<uuid>`) and writes version 1. Templates are org-wide, so the write
 * gate is `owner`/`admin` (`canWriteTemplates`), never `canAssignTeam`. What
 * makes the fields a template is the store's own `templateProblem` run, mapped
 * through `InvalidTemplateError` — this route never validates them itself. On
 * success the full record the route built is returned (`{ template }`), which
 * is exactly the row the store now holds; `saveTemplate` returns nothing.
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);
  if (!canWriteTemplates(scope)) {
    setResponseStatus(event, 403);
    return { error: "Not authorized to save templates." };
  }
  try {
    const { name, unit, creativeType, layers } = await parseTemplateWriteBody(event);
    const template: CreativeTemplate = {
      id: `tpl-${randomUUID()}`,
      version: 1,
      name: name as string,
      unit: unit as CreativeTemplate["unit"],
      creativeType: creativeType as CreativeTemplate["creativeType"],
      layers: layers as CreativeTemplate["layers"],
    };
    await getTemplateStore(scope).saveTemplate(template, scope.userId);
    setResponseStatus(event, 201);
    return { template };
  } catch (error) {
    return respondTemplateWriteError(event, error);
  }
});
