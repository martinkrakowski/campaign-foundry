import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { applyVerdicts, verdictsProblem, type Verdict } from "../../lib/decisions.js";
import { getDecisionStore } from "../../lib/ports/index.js";
import { LOCAL_TENANT } from "../../lib/tenant.js";

/**
 * PUT /campaigns/decisions — replace a campaign's review decisions with the
 * reviewer's whole verdict map `{ campaignId, decisions: { [key]: verdict } }`
 * (D173). The server stamps who and when: a verdict that did not change keeps
 * its original record, and a key left out is back in review. Answers the
 * stored decisions.
 */
export default defineEventHandler(async (event) => {
  const tenant = LOCAL_TENANT;
  const body: unknown = await readBody(event);
  const campaignId = (body as { campaignId?: unknown } | null)?.campaignId;
  if (typeof campaignId !== "string" || !SAFE_ID_PATTERN.test(campaignId)) {
    setResponseStatus(event, 400);
    return { error: "Invalid campaign id" };
  }
  const verdicts = (body as { decisions?: unknown }).decisions;
  const problem = verdictsProblem(verdicts);
  if (problem !== undefined) {
    setResponseStatus(event, 400);
    return { error: problem };
  }
  const store = getDecisionStore(tenant);
  const next = applyVerdicts(
    await store.readDecisions(campaignId),
    verdicts as Record<string, Verdict>,
    tenant.userId,
    new Date().toISOString(),
  );
  await store.writeDecisions(campaignId, next);
  return { decisions: next };
});
