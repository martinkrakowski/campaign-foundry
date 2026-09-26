import { describe, test, expect, vi, afterEach } from "vitest";
import {
  handleAuthError,
  NoMembershipError,
  isNoMembershipError,
  NO_ORGANISATION_YET_MESSAGE,
} from "../auth-errors";

describe("auth-errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("NoMembershipError has code, status, and default message", () => {
    const err = new NoMembershipError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NoMembershipError);
    expect(err.name).toBe("NoMembershipError");
    expect(err.code).toBe("no_membership");
    expect(err.status).toBe(403);
    expect(err.message).toBe(NO_ORGANISATION_YET_MESSAGE);

    const customErr = new NoMembershipError("Custom no membership");
    expect(customErr.message).toBe("Custom no membership");
  });

  test("isNoMembershipError identifies NoMembershipError and duck-typed objects", () => {
    expect(isNoMembershipError(new NoMembershipError())).toBe(true);
    expect(isNoMembershipError({ code: "no_membership" })).toBe(true);
    expect(isNoMembershipError(new Error("no_membership"))).toBe(false);
    expect(isNoMembershipError(null)).toBe(false);
    expect(isNoMembershipError(undefined)).toBe(false);
    expect(isNoMembershipError({ code: "other" })).toBe(false);
  });

  test("handleAuthError redirects to /sign-in on 401 unauthenticated with assign", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { ...window, location: { ...window.location, assign } });

    handleAuthError(401, { code: "unauthenticated" });
    expect(assign).toHaveBeenCalledWith("/sign-in");

    assign.mockClear();
    handleAuthError(401, null);
    expect(assign).toHaveBeenCalledWith("/sign-in");

    assign.mockClear();
    handleAuthError(401, "string-data");
    expect(assign).toHaveBeenCalledWith("/sign-in");
  });

  test("handleAuthError falls back to setting location.href on 401 when assign is not a function", () => {
    const loc = { href: "" } as unknown as Location;
    vi.stubGlobal("window", { ...window, location: loc });

    handleAuthError(401, { code: "unauthenticated" });
    expect(loc.href).toBe("/sign-in");
  });

  test("handleAuthError does nothing on 401 with other code", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { ...window, location: { ...window.location, assign } });

    handleAuthError(401, { code: "expired_token" });
    expect(assign).not.toHaveBeenCalled();
  });

  test("handleAuthError throws NoMembershipError on 403 no_membership", () => {
    expect(() => handleAuthError(403, { code: "no_membership" })).toThrow(NoMembershipError);

    try {
      handleAuthError(403, { code: "no_membership", error: "Custom server message" });
      expect.unreachable("handleAuthError must throw for a 403 no_membership");
    } catch (e) {
      expect(e).toBeInstanceOf(NoMembershipError);
      expect((e as NoMembershipError).message).toBe("Custom server message");
    }
  });

  test("handleAuthError does nothing on other status or non-membership 403", () => {
    expect(() => handleAuthError(403, { code: "forbidden" })).not.toThrow();
    expect(() => handleAuthError(500, { code: "server_error" })).not.toThrow();
    expect(() => handleAuthError(200, { ok: true })).not.toThrow();
  });
});
