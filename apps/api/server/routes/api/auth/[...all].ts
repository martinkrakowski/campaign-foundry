import { toWebRequest } from "h3";
import { auth } from "../../../lib/auth/instance.js";
import { authMode } from "../../../lib/config.js";

/**
 * Route handler delegating `/api/auth/**` to Better Auth's HTTP handler (PT-1a, Finding 1).
 * Under `AUTH_MODE=better-auth`, converts the h3 event to a standard Web Request and invokes `auth().handler`.
 * Under `AUTH_MODE=local`, answers 404.
 */
export default defineEventHandler(async (event) => {
  if (authMode() !== "better-auth") {
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }
  return auth().handler(toWebRequest(event));
});
