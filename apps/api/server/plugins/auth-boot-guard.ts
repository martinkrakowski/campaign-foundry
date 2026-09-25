import { authMode, storeBackend } from "../lib/config.js";

/**
 * Refuse to boot `AUTH_MODE=better-auth` without `STORE_BACKEND=postgres`
 * (PT-1a item 4). Better Auth's tables (0008) exist only in Postgres; a host
 * running the file stores would start authenticated and then fail every auth
 * request instead of failing at boot, where the operator can see why.
 */
export default defineNitroPlugin(() => {
  if (authMode() === "better-auth" && storeBackend() !== "postgres") {
    throw new Error(
      "AUTH_MODE=better-auth requires STORE_BACKEND=postgres: Better Auth's tables (0008_auth) are Postgres-only, and this host would boot authenticated with no store for them.",
    );
  }
});
