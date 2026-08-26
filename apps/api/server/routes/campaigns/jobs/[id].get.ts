import { getJob } from "../../../lib/jobs.js";

/**
 * GET /campaigns/jobs/:id — snapshot of an in-process generate job.
 * Unknown id → 404 (a process restart empties the in-memory map, and settled
 * jobs expire after JOB_TTL_MS — both look the same to the poller).
 */
export default defineEventHandler((event) => {
  // The router only matches with `:id` present; String() keeps the call branch-free.
  const job = getJob(String(getRouterParam(event, "id")));
  if (!job) {
    setResponseStatus(event, 404);
    return { error: "Job not found" };
  }
  return job;
});
