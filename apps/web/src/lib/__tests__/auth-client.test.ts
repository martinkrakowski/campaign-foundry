import { describe, test, expect, vi } from "vitest";

/**
 * Wraps the real `createAuthClient` rather than replacing it, so the rest of this file
 * (and every other module importing `authClient`) still gets a working client — this
 * spy exists only to see what `auth-client.ts` itself passed in, which is the one thing
 * PT-1b2 item 6 needs asserted: that the module is configured with `basePath` and no
 * absolute `baseURL` of its own.
 */
const createAuthClientSpy = vi.fn();

vi.mock("better-auth/react", async () => {
  const actual = await vi.importActual<typeof import("better-auth/react")>("better-auth/react");
  return {
    ...actual,
    createAuthClient: (options?: unknown) => {
      createAuthClientSpy(options);
      return actual.createAuthClient(options as never);
    },
  };
});

const { authClient, useSession, signIn, signOut, organization, useListOrganizations } =
  await import("../auth-client");

describe("authClient", () => {
  test("creates auth client configured with plugins and basePath", () => {
    expect(authClient).toBeDefined();
    expect(typeof useSession).toBe("function");
    expect(typeof signIn).toBe("function");
    expect(typeof signOut).toBe("function");
    expect(organization).toBeDefined();
    expect(typeof organization.setActive).toBe("function");
    expect(typeof useListOrganizations).toBe("function");
  });

  // PT-1b2 item 6: the client must reach the API through the same-origin rewrite
  // (`/api/auth/*` in next.config.ts, per the module's own doc comment) rather than an
  // absolute URL naming a host of its own — an absolute `baseURL` would bypass that
  // rewrite and point every request at a fixed origin regardless of where the app is
  // deployed. Asserted on what `auth-client.ts` itself passed to `createAuthClient`,
  // not on better-auth's internal resolution of it.
  test('is configured with basePath "/api/auth" and no absolute origin (baseURL)', () => {
    expect(createAuthClientSpy).toHaveBeenCalledTimes(1);
    const options = createAuthClientSpy.mock.calls[0]?.[0] as
      | { basePath?: string; baseURL?: string }
      | undefined;
    expect(options?.basePath).toBe("/api/auth");
    expect(options?.baseURL).toBeUndefined();
  });
});
