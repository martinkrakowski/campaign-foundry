import { getCapabilities } from "../../lib/capabilities.js";

/**
 * GET /campaigns/capabilities — what this host can actually produce, from the boot probe.
 *
 * `{ motion: boolean, reason?: string }`; `reason` is present only when `motion` is false.
 *
 * Nitro does not await the `ffmpeg-check` plugin, so a request arriving in the first
 * moments after boot sees the probe's initial snapshot: `{ motion: false, reason: "not
 * probed" }`. That is a transient answer, not a verdict — a client must treat the exact
 * reason `"not probed"` as retry-able and refetch before disabling anything, or it will
 * report motion as unavailable on a host that supports it.
 */
export default defineEventHandler(() => getCapabilities());
