import { createAuthClient } from "better-auth/react";
import { organizationClient, magicLinkClient } from "better-auth/client/plugins";

/**
 * Better Auth client for the web application (PT-1b2, D174b).
 *
 * Configured with organizationClient and magicLinkClient plugins. Reaches the API
 * through same-origin rewrite `/api/auth/*` mapped in `next.config.ts`.
 */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [organizationClient(), magicLinkClient()],
});

export const { useSession, signOut, signIn, organization, useListOrganizations } = authClient;
