import { authMode, authSettings, databaseSettings, storeBackend } from "../lib/config.js";

/**
 * Boot-time checks for `AUTH_MODE=better-auth` (PT-1a item 4, Finding 4).
 * 1. Refuse to boot without `STORE_BACKEND=postgres`: Better Auth's tables (0008)
 *    exist only in Postgres; a host running the file stores would start
 *    authenticated and then fail every auth request instead of failing at boot,
 *    where the operator can see why.
 * 2. Validate required auth settings at boot (DATABASE_URL, BETTER_AUTH_SECRET,
 *    WEB_ORIGIN) and refuse to boot on missing or invalid configuration.
 * 3. When `RESEND_API_KEY` is not set, warn loudly with console.warn that
 *    sign-in email will only be logged (LogMailer), not sent. Does not refuse boot.
 */
export default defineNitroPlugin(() => {
  if (authMode() !== "better-auth") return;

  if (storeBackend() !== "postgres") {
    throw new Error(
      "AUTH_MODE=better-auth requires STORE_BACKEND=postgres: Better Auth's tables (0008_auth) are Postgres-only, and this host would boot authenticated with no store for them.",
    );
  }

  const db = databaseSettings();
  if (!db.url) {
    throw new Error("DATABASE_URL is not set (required when AUTH_MODE=better-auth).");
  }

  const settings = authSettings();
  if (!settings.secret) {
    throw new Error("BETTER_AUTH_SECRET is not set (required when AUTH_MODE=better-auth).");
  }
  if (settings.secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters long.");
  }
  if (!settings.webOrigin) {
    throw new Error("WEB_ORIGIN is not set (required when AUTH_MODE=better-auth).");
  }
  try {
    const parsed = new URL(settings.webOrigin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error();
    }
  } catch {
    throw new Error(`WEB_ORIGIN must be a valid http or https URL, not "${settings.webOrigin}".`);
  }
  if (settings.resendApiKey && !settings.emailFrom) {
    throw new Error("EMAIL_FROM is not set (required alongside RESEND_API_KEY).");
  }

  if (!settings.resendApiKey) {
    console.warn(
      "[auth] RESEND_API_KEY is not set: sign-in email will only be logged (LogMailer), not sent.",
    );
  }
});
