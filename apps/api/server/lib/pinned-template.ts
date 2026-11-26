import { isOrgTemplateId, type BriefTemplate } from "@campaignfoundry/CampaignOrchestration";
import { getTemplateStore } from "./ports/index.js";
import type { StorageScope } from "./run-environment.js";

/**
 * A pinned org template that cannot be loaded: missing, cross-org, version
 * mismatched or creativeType mismatched — all one 400 (no existence leak
 * between the arms). A store failure is NOT this: it rethrows and answers 500.
 */
export class PinnedTemplateError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "PinnedTemplateError";
  }
}

/**
 * Resolve a brief's pinned template reference against the tenant's
 * `TemplateStorePort` (RW-22). A canonical id is platform-owned and offline:
 * it resolves with zero store calls. An org id (`tpl-<uuid>`) is proved to
 * exist in THIS org's store, at the pinned version, with a matching
 * `creativeType` — `unit` and `layers` are deliberately not compared, because
 * a brief edits its own materialised copy of them. The brief's layers stay
 * exactly as the body carried them (generation renders from the brief, never
 * from a later template version).
 */
export async function resolvePinnedOrgTemplate(
  scope: StorageScope,
  template: BriefTemplate,
): Promise<void> {
  if (!isOrgTemplateId(template.id)) return;
  const stored = await getTemplateStore(scope).findTemplate(template.id, template.version);
  if (!stored) {
    // One message for missing, version-mismatched and cross-org — the caller
    // cannot learn which arm fired from the answer.
    throw new PinnedTemplateError(
      `Campaign brief field "template.id" references unknown template "${template.id}" (version ${template.version}).`,
    );
  }
  if (stored.creativeType !== template.creativeType) {
    throw new PinnedTemplateError(
      `Campaign brief field "template.id" ("${template.id}" version ${template.version}) has creativeType "${stored.creativeType}", which does not match brief template.creativeType "${template.creativeType}".`,
    );
  }
}
