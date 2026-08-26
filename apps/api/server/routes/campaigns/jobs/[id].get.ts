import { getJob } from "../../../lib/jobs.js";

/**
 * GET /campaigns/jobs/:id — snapshot of an in-process generate job.
 * Unknown or missing id → 404 (process restart empties the in-memory map).
 */
export default defineEventHandler((event) => {
  const id = getRouterParam(event, "id");
  const job = id ? getJob(id) : undefined;
  if (!job) {
    setResponseStatus(event, 404);
    return { error: "Job not found" };
  }
  return job;
});
