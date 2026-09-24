import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import {
  applyVerdicts,
  verdictsProblem,
  withDecisionLock,
  type Verdict,
} from "../../lib/decisions.js";
import { DecisionConflictError } from "../../lib/ports/index.js";
import { reportRevision } from "../../lib/report.js";
import { LOCAL_TENANT } from "../../lib/tenant.js";

/**
 * PUT /campaigns/decisions — replace a campaign's review decisions with the
 * reviewer's whole verdict map
 * `{ campaignId, revision, decisions: { [key]: verdict } }` (D173).
 *
 * `revision` is the one the reviewer's GET answered (null when none was
 * recorded). A save from a stale read is a 409 carrying the current revision,
 * not a silent overwrite of another tab's decisions (D82). The server stamps
 * who, when and the run: the revision of the campaign report being reviewed,
 * so a campaign with no report has nothing to decide on (409). A verdict that
 * did not change keeps its original record, and a key left out is back in
 * review. Answers the stored decisions and their new revision.
 */
export default defineEventHandler(async (event) => {
  const tenant = LOCAL_TENANT;
  const body: unknown = await readBody(event);
  const campaignId = (body as { campaignId?: unknown } | null)?.campaignId;
  if (typeof campaignId !== "string" || !SAFE_ID_PATTERN.test(campaignId)) {
    setResponseStatus(event, 400);
    return { error: "Invalid campaign id" };
  }
  const expected = (body as { revision?: unknown }).revision;
  if (expected !== null && typeof expected !== "string") {
    setResponseStatus(event, 400);
    return { error: "revision must be the one the decisions were read at, or null" };
  }
  const verdicts = (body as { decisions?: unknown }).decisions;
  const problem = verdictsProblem(verdicts);
  if (problem !== undefined) {
    setResponseStatus(event, 400);
    return { error: problem };
  }
  // Under the campaign's decision lock, so the run a verdict is stamped with is
  // the report it stays against: a report write retires under the same lock.
  // The lock is per process; across processes the store's own compare-and-swap
  // (one step in Postgres; D79 on files) refuses the loser.
  return withDecisionLock(tenant, campaignId, async (store) => {
    const run = await reportRevision(tenant, campaignId);
    if (run === undefined) {
      setResponseStatus(event, 409);
      return { error: "This campaign has no run to review." };
    }
    const current = await store.readDecisions(campaignId);
    if (current.revision !== expected) {
      setResponseStatus(event, 409);
      return { error: "These decisions changed in another tab.", revision: current.revision };
    }
    const next = applyVerdicts(
      current.decisions,
      verdicts as Record<string, Verdict>,
      tenant.userId,
      new Date().toISOString(),
      run,
    );
    try {
      // The store checks the revision again in the write itself: another process's
      // save between this read and this write is a 409 too, not a silent overwrite.
      const revision = await store.writeDecisions(campaignId, next, expected);
      return { decisions: next, revision };
    } catch (error) {
      if (!(error instanceof DecisionConflictError)) throw error;
      setResponseStatus(event, 409);
      return { error: "These decisions changed in another tab.", revision: error.revision };
    }
  });
});
