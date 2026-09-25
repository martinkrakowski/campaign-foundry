import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { betterAuth } from "better-auth";
import pg from "pg";
import { projectRoot } from "@campaignfoundry/shared";
import { authSettings, databaseSettings } from "../config.js";
import { AUTH_POOL_MAX, databaseConfig } from "../db/database-config.js";
import { poolOptions } from "../db/pg-client.js";
import { authOptions } from "./options.js";
import { LogMailer } from "./log-mailer.js";
import { ResendMailer } from "./resend-mailer.js";

export { AUTH_POOL_MAX, BETTER_AUTH_POOL_MAX } from "../db/database-config.js";

/** Derived from `build`, not `betterAuth` itself — see the note above it. */
export type Auth = ReturnType<typeof build>;

let shared: Auth | undefined;
let sharedPool: pg.Pool | undefined;

function readCa(path: string): string {
  return readFileSync(resolve(projectRoot(), path), "utf8");
}

function isHttps(origin?: string): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Better Auth's own connection pool (PT-1a, Finding 3). Sized to AUTH_POOL_MAX (2),
 * an explicit small cap rather than DATABASE_POOL_MAX, so the store pool (up to 13)
 * and Better Auth's pool (2) together never exceed the Aiven service's 15-connection
 * budget (MAX_POOL). Total per process: DATABASE_POOL_MAX + AUTH_POOL_MAX <= MAX_POOL.
 */
function pool(): pg.Pool {
  const config = databaseConfig(databaseSettings(), readCa);
  sharedPool ??= new pg.Pool(poolOptions({ ...config, max: AUTH_POOL_MAX }));
  return sharedPool;
}

/**
 * Build the options a `betterAuth()` instance needs from the process's
 * settings, throwing on whatever is missing — called once, lazily, by
 * `auth()`, never at import (a server on `AUTH_MODE=local` must boot with none
 * of this set).
 */
// No return-type annotation, deliberately (see the same note in options.ts):
// `betterAuth()`'s generic infers each plugin's endpoints from the literal
// options type. `type Auth` is derived FROM this function, not the other way
// round, so the generic default (`ReturnType<typeof betterAuth>` with no
// arguments) never enters the picture.
function build() {
  const settings = authSettings();
  if (!settings.secret) {
    throw new Error("BETTER_AUTH_SECRET is not set (required when AUTH_MODE=better-auth).");
  }
  if (settings.secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters long.");
  }
  if (!settings.baseURL) {
    throw new Error("BETTER_AUTH_URL is not set (required when AUTH_MODE=better-auth).");
  }
  if (settings.resendApiKey && !settings.emailFrom) {
    throw new Error("EMAIL_FROM is not set (required alongside RESEND_API_KEY).");
  }
  const mailer = settings.resendApiKey
    ? new ResendMailer(settings.resendApiKey, settings.emailFrom!)
    : new LogMailer();
  const google =
    settings.googleClientId && settings.googleClientSecret
      ? { clientId: settings.googleClientId, clientSecret: settings.googleClientSecret }
      : undefined;
  return betterAuth(
    authOptions({
      database: pool(),
      secret: settings.secret,
      baseURL: settings.baseURL,
      trustedOrigins: settings.webOrigin ? [settings.webOrigin] : undefined,
      useSecureCookies: isHttps(settings.webOrigin),
      mailer,
      google,
    }),
  );
}

/** The process's Better Auth instance, built on first use. */
export function auth(): Auth {
  shared ??= build();
  return shared;
}

/** Install an instance for every caller (a test's own `betterAuth()` over PGlite). */
export function setAuth(instance: Auth): void {
  shared = instance;
}

/** The shared connection pool, if built (for tests). */
export function authPool(): pg.Pool | undefined {
  return sharedPool;
}

/** Forget the instance and its pool, closing the pool before discarding it (Finding 6). */
export async function resetAuth(): Promise<void> {
  const poolToClose = sharedPool;
  shared = undefined;
  sharedPool = undefined;
  await poolToClose?.end();
}
