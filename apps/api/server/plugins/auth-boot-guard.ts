import { authMode, authSettings, storeBackend } from "../lib/config.js";

/**
 * Boot-time checks for `AUTH_MODE=better-auth` (PT-1a item 4, Finding 4).
 * 1. Refuse to boot without `STORE_BACKEND=postgres`: Better Auth's tables (0008)
 *    exist only in Postgres; a host running the file stores would start
 *    authenticated and then fail every auth request instead of failing at boot,
 *    where the operator can see why.
 * 2. When `RESEND_API_KEY` is not set, warn loudly with console.warn that
 *    sign-in email will only be logged (LogMailer), not sent. Does not refuse boot.
 */
export default defineNitroPlugin(() => {
  if (authMode() !== "better-auth") return;

  if (storeBackend() !== "postgres") {
    throw new Error(
      "AUTH_MODE=better-auth requires STORE_BACKEND=postgres: Better Auth's tables (0008_auth) are Postgres-only, and this host would boot authenticated with no store for them.",
    );
  }

  const settings = authSettings();
  if (!settings.resendApiKey) {
    console.warn(
      "[auth] RESEND_API_KEY is not set: sign-in email will only be logged (LogMailer), not sent.",
    );
  }
});
