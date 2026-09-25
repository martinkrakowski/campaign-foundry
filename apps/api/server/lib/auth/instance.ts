import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { betterAuth } from "better-auth";
import pg from "pg";
import { projectRoot } from "@campaignfoundry/shared";
import { authSettings, databaseSettings } from "../config.js";
import { databaseConfig } from "../db/database-config.js";
import { poolOptions } from "../db/pg-client.js";
import { authOptions } from "./options.js";
import { LogMailer } from "./log-mailer.js";
import { ResendMailer } from "./resend-mailer.js";

type Auth = ReturnType<typeof betterAuth>;

let shared: Auth | undefined;
let sharedPool: pg.Pool | undefined;

function readCa(path: string): string {
  return readFileSync(resolve(projectRoot(), path), "utf8");
}

/**
 * Better Auth's own connection pool (PT-1a). A second, separate `pg.Pool` from
 * the one `db/database.ts` builds for the stores: Better Auth's Kysely adapter
 * needs a `pg.Pool`-shaped object (`connect`/`query`/`end`/`on`), not a
 * `SqlClient`, so it cannot share the process's `SqlClient` pool directly.
 * Both pools are sized from the same `DATABASE_POOL_MAX`, so the operator's
 * accounting for the Aiven service's 15-connection budget must include this
 * one too — recorded under Deviations in the PR, not solved here.
 */
function pool(): pg.Pool {
  sharedPool ??= new pg.Pool(poolOptions(databaseConfig(databaseSettings(), readCa)));
  return sharedPool;
}

/**
 * Build the options a `betterAuth()` instance needs from the process's
 * settings, throwing on whatever is missing — called once, lazily, by
 * `auth()`, never at import (a server on `AUTH_MODE=local` must boot with none
 * of this set).
 */
function build(): Auth {
  const settings = authSettings();
  if (!settings.secret) {
    throw new Error("BETTER_AUTH_SECRET is not set (required when AUTH_MODE=better-auth).");
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

/** Forget the instance and its pool (the next `auth()` builds fresh from the environment). */
export function resetAuth(): void {
  shared = undefined;
  sharedPool = undefined;
}
