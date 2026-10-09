import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { collectRefs, rewriteAssetPaths } from "../asset-files.js";
import { isAssetId } from "../ports/asset-store.port.js";

export function rewriteBriefRefs(
  brief: CampaignBrief,
  slug: string,
  refToId: ReadonlyMap<string, string>,
): CampaignBrief {
  const pathMap: Record<string, string> = Object.fromEntries(refToId);
  const rewritten = rewriteAssetPaths(brief, slug, slug, pathMap);
  for (const ref of collectRefs(rewritten)) {
    if (!isAssetId(ref)) {
      throw new Error(`ref survived rewrite as a path, not an asset id: ${ref}`);
    }
  }
  return rewritten;
}
