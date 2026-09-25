import type { BetterAuthOptions } from "better-auth";
import { organization, magicLink } from "better-auth/plugins";
import type { PgPool } from "../db/pg-client.js";
import { safeId } from "./id.js";
import type { MailerPort } from "./mailer.port.js";

/** A Google OAuth client, present only when both its settings are configured (item 9). */
export interface GoogleCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface AuthDeps {
  /** A `pg.Pool`-shaped object: a real one in production, PGlite's double in tests. */
  readonly database: PgPool;
  readonly secret: string;
  /**
   * The API's own reachable origin (`BETTER_AUTH_URL`). Magic-link and OAuth
   * callback URLs are absolute and navigated to directly by the browser (an
   * email click, a provider redirect), so they are built from the API's own
   * address, not the web app's `/api/pipeline` proxy path — Better Auth folds
   * any path component out of `baseURL` at init and rebuilds links from the
   * origin plus `basePath` alone, so a proxy path given here would be silently
   * dropped anyway. `basePath` stays Better Auth's default, `/api/auth`,
   * because that is the path Next's rewrite hands the API *after* stripping
   * `/api/pipeline` (`next.config.ts:36`) — the one path the server actually
   * receives, proxied or not.
   */
  readonly baseURL: string;
  /** Origins the web app is reachable at, trusted for the proxied requests item 10 names. */
  readonly trustedOrigins?: readonly string[];
  /**
   * Whether session cookies carry the `Secure` attribute (finding 2). In
   * production the API runs behind a reverse proxy over plain HTTP internally,
   * while browsers reach the web app over HTTPS. Derived from `WEB_ORIGIN`'s
   * protocol (true when HTTPS).
   */
  readonly useSecureCookies?: boolean;
  readonly mailer: MailerPort;
  readonly google?: GoogleCredentials;
}

/**
 * Better Auth's configuration (PT-1a, D174b). Building this is pure — no I/O,
 * no env read — so the schema-agreement test and the production instance
 * (`lib/auth/instance.ts`) share exactly one definition of the schema 0008
 * ships. `org` fields are mapped, never renamed on the JS side, so `org.id`
 * stays the same immutable surrogate id `tenantRoot` and every other port
 * already key on (D174b(1)).
 */
// No return-type annotation, deliberately: `betterAuth()` infers each plugin's
// endpoints (e.g. `auth.api.signInMagicLink`) from the literal type of the
// `plugins` array it is called with. Annotating this function's return as the
// general `BetterAuthOptions` would widen that array away before `betterAuth()`
// ever sees it, and every plugin-specific method on `auth.api` would vanish
// from the type (though not the runtime, which is why this only shows up in
// `tsc`, not in a test).
export function authOptions(deps: AuthDeps) {
  if (deps.secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters long.");
  }
  return {
    // `PgPool` is deliberately looser than Kysely's own `PostgresPool`/
    // `PostgresQueryResult` types (e.g. `command` as `string`, not the literal
    // union Kysely declares): our double (`pglite-pg-pool.ts`) and the real
    // driver both return values those narrower types cannot express without
    // narrowing Kysely never needs, since its driver only compares `command`
    // against a fixed set of strings at runtime (`postgres-driver.js`) rather
    // than exhaustively switching over the type. The two shapes are
    // runtime-compatible; only the declared types are not directly comparable.
    database: deps.database as unknown as BetterAuthOptions["database"],
    secret: deps.secret,
    baseURL: deps.baseURL,
    trustedOrigins: deps.trustedOrigins ? [...deps.trustedOrigins] : undefined,
    advanced: {
      ...(deps.useSecureCookies !== undefined ? { useSecureCookies: deps.useSecureCookies } : {}),
      database: {
        // Every model's id, org included: SAFE_ID_PATTERN, not Better Auth's
        // default mixed-case alphabet (item 7).
        generateId: () => safeId(),
      },
    },
    user: {
      modelName: "user",
      fields: {
        name: "name",
        email: "email",
        emailVerified: "email_verified",
        image: "image",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    session: {
      modelName: "session",
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        token: "token",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
      },
    },
    account: {
      modelName: "account",
      fields: {
        userId: "user_id",
        accountId: "account_id",
        providerId: "provider_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        scope: "scope",
        password: "password",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "verification",
      fields: {
        identifier: "identifier",
        value: "value",
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    // Google only when both settings are present (item 9): an incomplete pair
    // (one env var set, the other not) is treated as absent, not half-wired.
    socialProviders: deps.google
      ? { google: { clientId: deps.google.clientId, clientSecret: deps.google.clientSecret } }
      : undefined,
    plugins: [
      magicLink({
        disableSignUp: false,
        sendMagicLink: async ({ email, url }) => {
          await deps.mailer.send({
            to: email,
            subject: "Sign in to Campaign Foundry",
            html: `<p>Sign in by following this link:</p><p><a href="${url}">${url}</a></p>`,
          });
        },
      }),
      organization({
        schema: {
          organization: {
            modelName: "org",
            fields: {
              name: "name",
              slug: "slug",
              logo: "logo",
              metadata: "metadata",
              createdAt: "created_at",
            },
          },
          member: {
            modelName: "member",
            fields: {
              organizationId: "org_id",
              userId: "user_id",
              role: "role",
              createdAt: "created_at",
            },
          },
          invitation: {
            modelName: "invitation",
            fields: {
              organizationId: "org_id",
              email: "email",
              role: "role",
              status: "status",
              teamId: "team_id",
              inviterId: "inviter_id",
              expiresAt: "expires_at",
              createdAt: "created_at",
            },
          },
          team: {
            modelName: "team",
            fields: {
              name: "name",
              organizationId: "org_id",
              createdAt: "created_at",
              updatedAt: "updated_at",
            },
          },
          teamMember: {
            modelName: "team_member",
            fields: { teamId: "team_id", userId: "user_id", createdAt: "created_at" },
          },
        },
        teams: { enabled: true },
        // D175: no user creates an org, and no org invites another member,
        // until PT-7 (metering) and PT-2 (authorisation) exist.
        allowUserToCreateOrganization: false,
        invitationLimit: 0,
      }),
    ],
  };
}
