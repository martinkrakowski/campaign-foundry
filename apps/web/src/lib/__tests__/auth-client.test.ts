import { describe, test, expect } from "vitest";
import {
  authClient,
  useSession,
  signIn,
  signOut,
  organization,
  useListOrganizations,
} from "../auth-client";

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
});
