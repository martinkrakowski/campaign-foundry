import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SignInPage from "../page";
import * as briefsApi from "@/lib/briefs-api";
import { authClient } from "@/lib/auth-client";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      magicLink: vi.fn(),
      social: vi.fn(),
    },
    signOut: vi.fn(),
    useSession: vi.fn(),
  },
}));

describe("SignInPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("renders email input and submit button", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: false },
    });

    render(<SignInPage />);

    expect(screen.getByRole("heading", { name: /Sign in to Campaign Foundry/i })).toBeTruthy();
    expect(screen.getByLabelText(/Email address/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continue with email/i })).toBeTruthy();
  });

  test("submits email and shows success message on magic link sent", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: false },
    });
    const magicLinkSpy = vi.spyOn(authClient.signIn, "magicLink").mockResolvedValue({} as never);

    render(<SignInPage />);

    const input = screen.getByLabelText(/Email address/i);
    await user.type(input, "user@example.com");
    await user.click(screen.getByRole("button", { name: /Continue with email/i }));

    expect(magicLinkSpy).toHaveBeenCalledWith({
      email: "user@example.com",
      callbackURL: "/grid",
    });

    await waitFor(() => {
      expect(screen.getByText(/Magic link sent!/i)).toBeTruthy();
      expect(screen.getByText("user@example.com")).toBeTruthy();
    });

    // Can switch to use a different email
    await user.click(screen.getByRole("button", { name: /Use a different email/i }));
    expect(screen.getByLabelText(/Email address/i)).toBeTruthy();
  });

  test("displays error message when magic link fails with an error response or exception", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: false },
    });
    vi.spyOn(authClient.signIn, "magicLink").mockResolvedValue({
      error: { message: "Invalid email domain" },
    } as never);

    render(<SignInPage />);

    const input = screen.getByLabelText(/Email address/i);
    await user.type(input, "bad@example.com");
    await user.click(screen.getByRole("button", { name: /Continue with email/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Invalid email domain");
    });

    // When magic link rejects
    vi.spyOn(authClient.signIn, "magicLink").mockRejectedValue(new Error("Network failed"));
    await user.click(screen.getByRole("button", { name: /Continue with email/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Network failed");
    });
  });

  test("renders 'Continue with Google' button when auth.google is true", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: true },
    });
    const socialSpy = vi.spyOn(authClient.signIn, "social").mockResolvedValue({} as never);

    render(<SignInPage />);

    const googleBtn = await screen.findByRole("button", { name: /Continue with Google/i });
    expect(googleBtn).toBeTruthy();

    await user.click(googleBtn);
    expect(socialSpy).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/grid",
    });

    // The loading flag was only ever cleared in the catch branch — a successful
    // resolution left it (and the disabled button) stuck forever. `finally` fixes it.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Continue with Google/i }).hasAttribute("disabled"),
      ).toBe(false);
    });
  });

  test("shows an error and re-enables the button when Google sign-in resolves with an error", async () => {
    // Better Auth's client actions resolve `{ data, error }` rather than throwing —
    // the same shape `authClient.signIn.magicLink` already reports through. The old
    // handler only ever awaited the promise and checked nothing, so this path left
    // the button disabled with no error shown.
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: true },
    });
    vi.spyOn(authClient.signIn, "social").mockResolvedValue({
      error: { message: "Account already linked to a different provider" },
    } as never);

    render(<SignInPage />);

    const googleBtn = await screen.findByRole("button", { name: /Continue with Google/i });
    await user.click(googleBtn);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Account already linked to a different provider",
      );
    });
    expect(
      screen.getByRole("button", { name: /Continue with Google/i }).hasAttribute("disabled"),
    ).toBe(false);
  });

  test("falls back to a generic message when Google sign-in's resolved error has no message", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: true },
    });
    vi.spyOn(authClient.signIn, "social").mockResolvedValue({ error: {} } as never);

    render(<SignInPage />);

    const googleBtn = await screen.findByRole("button", { name: /Continue with Google/i });
    await user.click(googleBtn);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Failed to sign in with Google.");
    });
  });

  test("hides 'Continue with Google' button when auth.google is false", async () => {
    // A deferred promise, resolved only once the assertion below has run: the button
    // is ALSO absent before capabilities resolve (nothing has said auth.google yet),
    // so asserting absence too early is vacuous — it would pass just as readily under
    // a mutant that drops the `.google` check entirely (`capabilities?.auth ?`), since
    // that mutant only diverges from the real code once `capabilities` is non-null.
    // Wait the resolution out, THEN assert the button stays gone.
    let resolveCaps!: (caps: briefsApi.HostCapabilities) => void;
    vi.spyOn(briefsApi, "getCapabilities").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCaps = resolve;
        }),
    );

    render(<SignInPage />);

    expect(screen.queryByRole("button", { name: /Continue with Google/i })).toBeNull();

    await act(async () => {
      resolveCaps({ motion: true, auth: { mode: "better-auth", google: false } });
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: /Continue with Google/i })).toBeNull();
  });

  test("handles Google sign-in failure with error display", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: true },
    });
    vi.spyOn(authClient.signIn, "social").mockRejectedValue(new Error("Google OAuth error"));

    render(<SignInPage />);

    const googleBtn = await screen.findByRole("button", { name: /Continue with Google/i });
    await user.click(googleBtn);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Google OAuth error");
    });
  });

  test("handles non-Error rejection from Google sign-in", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: true },
    });
    vi.spyOn(authClient.signIn, "social").mockRejectedValue("string failure");

    render(<SignInPage />);

    const googleBtn = await screen.findByRole("button", { name: /Continue with Google/i });
    await user.click(googleBtn);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Failed to sign in with Google.");
    });
  });

  test("handles magic link error with no message and non-Error rejection", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: false },
    });
    vi.spyOn(authClient.signIn, "magicLink").mockResolvedValue({
      error: {},
    } as never);

    render(<SignInPage />);

    const input = screen.getByLabelText(/Email address/i);
    await user.type(input, "user@example.com");
    await user.click(screen.getByRole("button", { name: /Continue with email/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Failed to send magic link.");
    });

    vi.spyOn(authClient.signIn, "magicLink").mockRejectedValue("raw string rejection");
    await user.click(screen.getByRole("button", { name: /Continue with email/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Failed to send magic link.");
    });
  });

  test("does not call magicLink when email is whitespace-only", async () => {
    const { fireEvent } = await import("@testing-library/react");
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: false },
    });
    const magicLinkSpy = vi.spyOn(authClient.signIn, "magicLink");

    const { container } = render(<SignInPage />);
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    expect(magicLinkSpy).not.toHaveBeenCalled();
  });

  test("does not set capabilities if unmounted before promise resolves", async () => {
    // React 19 (this app's version) silently drops a setState call on an unmounted
    // component — there is no "component is unmounted" warning to catch, so the honest
    // maximum assertion here is that resolving late causes no React `act` warning
    // (which DOES fire for a state update React can't attribute to a render) and no
    // unhandled rejection.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolveCaps!: (caps: briefsApi.HostCapabilities) => void;
    vi.spyOn(briefsApi, "getCapabilities").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCaps = resolve;
        }),
    );

    const { unmount } = render(<SignInPage />);
    unmount();
    await act(async () => {
      resolveCaps({ motion: true, auth: { mode: "better-auth", google: true } });
      await Promise.resolve();
    });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test("a rejected capabilities probe leaves the form usable, with no unhandled rejection", async () => {
    // The mount effect had no `.catch` — a rejected `getCapabilities()` (a network
    // blip, a probe route down) was an unhandled rejection vitest fails the run on.
    // The fix is the discriminator: without the `.catch`, this test fails the suite
    // rather than the assertion below.
    vi.spyOn(briefsApi, "getCapabilities").mockRejectedValue(new Error("probe unreachable"));

    render(<SignInPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Continue with email/i })).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /Continue with Google/i })).toBeNull();
  });
});
