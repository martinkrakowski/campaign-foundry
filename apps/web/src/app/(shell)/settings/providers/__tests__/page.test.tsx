import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as briefsApi from "@/lib/briefs-api";
import * as providerKeysApi from "@/lib/provider-keys-api";
import { ProviderKeysApiError } from "@/lib/provider-keys-api";
import { authClient } from "@/lib/auth-client";
import * as editorDirtyContext from "@/lib/editor-dirty-context";
import { renderWithRun, ShellProviders } from "@/__tests__/helpers";
import { Header } from "@/components/shell/Header";
import ProviderKeysSettingsPage from "../page";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useActiveMember: vi.fn(() => ({ data: null, isPending: false })),
    // Bare stand-ins: only the dirty-state integration tests below mount `Header`
    // alongside this page, and `useBetterAuthState` reads all three under
    // better-auth — `session?.data?.user?.email` etc. is optional-chained
    // throughout, so an unconfigured `vi.fn()` (resolving to `undefined`) is a
    // safe default for every other test in this file, which never renders `Header`.
    useSession: vi.fn(() => ({ data: null, isPending: false })),
    useListOrganizations: vi.fn(() => ({ data: null, isPending: false })),
    useActiveOrganization: vi.fn(() => ({ data: null, isPending: false })),
  },
}));

const asOwner = () =>
  vi.mocked(authClient.useActiveMember).mockReturnValue({
    data: { role: "owner" },
    isPending: false,
  } as never);

const asAdmin = () =>
  vi.mocked(authClient.useActiveMember).mockReturnValue({
    data: { role: "admin" },
    isPending: false,
  } as never);

const asMember = () =>
  vi.mocked(authClient.useActiveMember).mockReturnValue({
    data: { role: "member" },
    isPending: false,
  } as never);

const betterAuthCapabilities = (): briefsApi.HostCapabilities => ({
  motion: true,
  auth: { mode: "better-auth", google: false },
});

const localCapabilities = (): briefsApi.HostCapabilities => ({
  motion: true,
  auth: { mode: "local", google: false },
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The one provider row's own submit button — three rows share the "Save" name. */
const submitButtonFor = (fieldEl: HTMLElement): HTMLButtonElement =>
  (fieldEl.closest("form") as HTMLFormElement).querySelector(
    'button[type="submit"]',
  ) as HTMLButtonElement;

describe("ProviderKeysSettingsPage — auth mode", () => {
  test("under local auth mode, shows a notice and makes no provider-key requests", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(localCapabilities());
    const listSpy = vi.spyOn(providerKeysApi, "listProviderKeys");

    render(<ProviderKeysSettingsPage />);

    expect(await screen.findByText(/Provider keys need an organisation account/)).toBeTruthy();
    expect(listSpy).not.toHaveBeenCalled();
    expect(authClient.useActiveMember).not.toHaveBeenCalled();
  });

  test("renders nothing before the capabilities probe resolves", () => {
    vi.spyOn(briefsApi, "getCapabilities").mockImplementation(() => new Promise(() => {}));
    const { container } = render(<ProviderKeysSettingsPage />);
    expect(container.textContent).toBe("");
  });

  test("does not update state if unmounted before the capabilities promise resolves", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolveCaps!: (caps: briefsApi.HostCapabilities) => void;
    vi.spyOn(briefsApi, "getCapabilities").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCaps = resolve;
        }),
    );
    const { unmount } = render(<ProviderKeysSettingsPage />);
    unmount();
    await act(async () => {
      resolveCaps(betterAuthCapabilities());
      await Promise.resolve();
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("does not update state if unmounted before the capabilities promise rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectCaps!: (err: unknown) => void;
    vi.spyOn(briefsApi, "getCapabilities").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCaps = reject;
        }),
    );
    const { unmount } = render(<ProviderKeysSettingsPage />);
    unmount();
    await act(async () => {
      rejectCaps(new Error("too late"));
      await Promise.resolve();
    });
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("ProviderKeysSettingsPage — probe failure and retry (PRRT_kwDOSzP1zc6mXMC3 / PRRT_kwDOSzP1zc6mXO6f)", () => {
  test("a probe that resolves null (briefs-api's own failure shape) shows an error and a Retry button, not a blank page", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(null);

    render(<ProviderKeysSettingsPage />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Could not check this host's settings.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  test("a rejected probe also shows the error and Retry state, with no unhandled rejection", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockRejectedValue(new Error("probe unreachable"));

    render(<ProviderKeysSettingsPage />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  test("Retry re-runs the probe; a successful second attempt renders the real page", async () => {
    const user = userEvent.setup();
    const capsSpy = vi
      .spyOn(briefsApi, "getCapabilities")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);

    await screen.findByRole("button", { name: "Retry" });
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Gemini")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(capsSpy).toHaveBeenCalledTimes(2);
  });

  test("Retry that fails again stays in the failure state", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(null);

    render(<ProviderKeysSettingsPage />);

    await screen.findByRole("button", { name: "Retry" });
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("ProviderKeysSettingsPage — list states", () => {
  test("shows a loading state while the list is in flight", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockImplementation(() => new Promise(() => {}));
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);

    expect(await screen.findByText("Loading…")).toBeTruthy();
  });

  test("shows 'none' for every provider with no registered key", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);

    expect(await screen.findByText("Gemini")).toBeTruthy();
    expect(screen.getByText("OpenRouter")).toBeTruthy();
    expect(screen.getByText("Firefly")).toBeTruthy();
    expect(screen.getAllByText("none")).toHaveLength(3);
  });

  test("shows last4 and the registration date for a set key", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([
      { provider: "gemini", last4: "1234", createdAt: "2026-09-27T00:00:00.000Z" },
    ]);
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);

    expect(await screen.findByText("…1234 (2026-09-27)")).toBeTruthy();
  });

  test("the guidance never says BYOK", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);

    await screen.findByText("Gemini");
    expect(document.body.textContent).not.toContain("BYOK");
  });

  test("a 503 on load maps to a plain message and never shows the server's own text", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockRejectedValue(
      new ProviderKeysApiError(
        "Org provider keys need STORE_BACKEND=postgres: BYOK is Postgres-only, as Better Auth already is.",
        503,
      ),
    );
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Provider keys aren't available on this host right now. Try again shortly.",
    );
    // Never the raw server text or the deployment identifiers it names — the whole
    // point of mapping by status is that these never reach the DOM at all.
    expect(document.body.textContent).not.toContain("STORE_BACKEND");
    expect(document.body.textContent).not.toContain("BYOK");
  });

  test("a 503 naming KEY_ENCRYPTION_KEYS on load renders neither that name nor STORE_BACKEND", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockRejectedValue(
      new ProviderKeysApiError(
        "KEY_ENCRYPTION_KEYS is not set: org provider keys cannot be sealed or opened (STORE_BACKEND=postgres).",
        503,
      ),
    );
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(document.body.textContent).not.toContain("KEY_ENCRYPTION_KEYS");
    expect(document.body.textContent).not.toContain("STORE_BACKEND");
    expect(
      screen.getByText("Provider keys aren't available on this host right now. Try again shortly."),
    ).toBeTruthy();
  });

  test("a non-ProviderKeysApiError rejection falls back to the generic message", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockRejectedValue(new Error("boom"));
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);

    expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
  });

  test("a malformed list entry (the client's own shape check) also maps to the generic message, never its own diagnostic text", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockRejectedValue(
      new ProviderKeysApiError("Invalid provider keys response", 500),
    );
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);

    expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Invalid provider keys response");
  });

  test("does not update state if unmounted before listProviderKeys resolves", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    let resolveList!: (summaries: providerKeysApi.ProviderKeySummary[]) => void;
    vi.spyOn(providerKeysApi, "listProviderKeys").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );
    asOwner();

    const { unmount } = renderWithRun(<ProviderKeysSettingsPage />);
    await screen.findByText("Loading…");
    unmount();
    await act(async () => {
      resolveList([]);
      await Promise.resolve();
    });

    expect(consoleError).not.toHaveBeenCalled();
  });

  test("does not update state if unmounted before listProviderKeys rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    let rejectList!: (err: unknown) => void;
    vi.spyOn(providerKeysApi, "listProviderKeys").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectList = reject;
        }),
    );
    asOwner();

    const { unmount } = renderWithRun(<ProviderKeysSettingsPage />);
    await screen.findByText("Loading…");
    unmount();
    await act(async () => {
      rejectList(new Error("too late"));
      await Promise.resolve();
    });

    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("ProviderKeysSettingsPage — roles", () => {
  test("an owner sees write controls for every provider", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);

    expect(await screen.findByLabelText("Gemini key")).toBeTruthy();
    expect(screen.getByLabelText("OpenRouter key")).toBeTruthy();
    expect(screen.getByLabelText("Firefly client ID")).toBeTruthy();
    expect(screen.getByLabelText("Firefly client secret")).toBeTruthy();
  });

  test("an admin sees write controls for every provider", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    asAdmin();

    renderWithRun(<ProviderKeysSettingsPage />);

    expect(await screen.findByLabelText("Gemini key")).toBeTruthy();
  });

  test("a member sees the list read-only: no inputs, no revoke button, even with a key set", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([
      { provider: "gemini", last4: "1234", createdAt: "2026-09-27T00:00:00.000Z" },
    ]);
    asMember();

    renderWithRun(<ProviderKeysSettingsPage />);

    expect(await screen.findByText("…1234 (2026-09-27)")).toBeTruthy();
    expect(screen.queryByLabelText("Gemini key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
  });

  test("a role with no membership data is treated as read-only", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    vi.mocked(authClient.useActiveMember).mockReturnValue({
      data: null,
      isPending: false,
    } as never);

    renderWithRun(<ProviderKeysSettingsPage />);

    expect(await screen.findByText("Gemini")).toBeTruthy();
    expect(screen.queryByLabelText("Gemini key")).toBeNull();
  });
});

describe("ProviderKeysSettingsPage — write-only fields", () => {
  test("saving a gemini key clears the field and never leaves the typed secret in the DOM", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    const setSpy = vi.spyOn(providerKeysApi, "setProviderKey").mockResolvedValue({
      provider: "gemini",
      last4: "wxyz",
      createdAt: "2026-09-27T02:00:00.000Z",
    });
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);

    const input = (await screen.findByLabelText("Gemini key")) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");

    await user.type(input, "super-secret-value-wxyz");
    await user.click(submitButtonFor(input));

    await waitFor(() =>
      expect(setSpy).toHaveBeenCalledWith("gemini", { key: "super-secret-value-wxyz" }),
    );
    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.queryByText("super-secret-value-wxyz")).toBeNull();
    expect(document.body.innerHTML).not.toContain("super-secret-value-wxyz");
    expect(await screen.findByText("…wxyz (2026-09-27)")).toBeTruthy();
  });

  test("firefly sends both fields as { clientId, clientSecret } and clears both on save", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    const setSpy = vi.spyOn(providerKeysApi, "setProviderKey").mockResolvedValue({
      provider: "firefly",
      last4: "efgh",
      createdAt: "2026-09-27T02:00:00.000Z",
    });
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);

    const clientId = (await screen.findByLabelText("Firefly client ID")) as HTMLInputElement;
    const clientSecret = screen.getByLabelText("Firefly client secret") as HTMLInputElement;
    expect(clientId.type).toBe("password");
    expect(clientSecret.type).toBe("password");

    await user.type(clientId, "firefly-client-id");
    await user.type(clientSecret, "firefly-secret-efgh");

    const fireflyCard = clientId.closest("form") as HTMLFormElement;
    const saveButton = fireflyCard.querySelector('button[type="submit"]') as HTMLButtonElement;
    await user.click(saveButton);

    await waitFor(() =>
      expect(setSpy).toHaveBeenCalledWith("firefly", {
        clientId: "firefly-client-id",
        clientSecret: "firefly-secret-efgh",
      }),
    );
    await waitFor(() => expect(clientId.value).toBe(""));
    expect(clientSecret.value).toBe("");
  });

  test("revoking a set key returns the row to 'none'", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([
      { provider: "openrouter", last4: "5678", createdAt: "2026-09-27T00:00:00.000Z" },
    ]);
    const revokeSpy = vi.spyOn(providerKeysApi, "revokeProviderKey").mockResolvedValue(undefined);
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);

    expect(await screen.findByText("…5678 (2026-09-27)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(revokeSpy).toHaveBeenCalledWith("openrouter"));
    // Gemini and Firefly already show "none" before the click — asserting only that
    // SOME row says "none" would still pass with a no-op onRevoked, since two rows
    // already say it. Assert the OpenRouter row's own text is gone, and that all
    // three rows (not just the two that were already empty) now say "none".
    await waitFor(() => expect(screen.queryByText("…5678 (2026-09-27)")).toBeNull());
    expect(screen.getAllByText("none")).toHaveLength(3);
  });
});

describe("ProviderKeysSettingsPage — error messages (mapped by status only)", () => {
  test("a 400 from setProviderKey maps to a plain message, never the server's own text", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    vi.spyOn(providerKeysApi, "setProviderKey").mockRejectedValue(
      new ProviderKeysApiError("Provide { key }, 8-4096 characters.", 400),
    );
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);
    const input = await screen.findByLabelText("Gemini key");
    await user.type(input, "short");
    await user.click(submitButtonFor(input));

    expect(
      await screen.findByText("That key doesn't look right. Check it and try again."),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("8-4096 characters");
  });

  test("a 403 from setProviderKey maps to the 'only owners and admins' message", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    vi.spyOn(providerKeysApi, "setProviderKey").mockRejectedValue(
      new ProviderKeysApiError("Only an owner or admin may manage provider keys.", 403),
    );
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);
    const input = await screen.findByLabelText("Gemini key");
    await user.type(input, "some-key-value-1234");
    await user.click(submitButtonFor(input));

    expect(
      await screen.findByText("Only owners and admins can manage provider keys."),
    ).toBeTruthy();
  });

  test("a 409 from setProviderKey maps to a plain retry message", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    vi.spyOn(providerKeysApi, "setProviderKey").mockRejectedValue(
      new ProviderKeysApiError("Provider key was replaced concurrently; retry.", 409),
    );
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);
    const input = await screen.findByLabelText("OpenRouter key");
    await user.type(input, "some-key-value-1234");
    await user.click(submitButtonFor(input));

    expect(
      await screen.findByText("That key was just updated somewhere else. Try again."),
    ).toBeTruthy();
  });

  test("a 503 from setProviderKey (KEK not configured) maps to a plain message and never names KEY_ENCRYPTION_KEYS", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    vi.spyOn(providerKeysApi, "setProviderKey").mockRejectedValue(
      new ProviderKeysApiError(
        "KEY_ENCRYPTION_KEYS is not set: org provider keys cannot be sealed or opened.",
        503,
      ),
    );
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);
    const input = await screen.findByLabelText("Gemini key");
    await user.type(input, "some-key-value-1234");
    await user.click(submitButtonFor(input));

    expect(
      await screen.findByText(
        "Provider keys aren't available on this host right now. Try again shortly.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("KEY_ENCRYPTION_KEYS");
  });

  test("a non-ProviderKeysApiError rejection from setProviderKey falls back to the generic message", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    vi.spyOn(providerKeysApi, "setProviderKey").mockRejectedValue(new Error("boom"));
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);
    const input = await screen.findByLabelText("Gemini key");
    await user.type(input, "some-key-value-1234");
    await user.click(submitButtonFor(input));

    expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
  });

  test("a revoke failure maps to a plain message, and a non-ProviderKeysApiError rejection falls back to the generic one", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([
      { provider: "firefly", last4: "efgh", createdAt: "2026-09-27T00:00:00.000Z" },
    ]);
    vi.spyOn(providerKeysApi, "revokeProviderKey").mockRejectedValueOnce(
      new ProviderKeysApiError("Org provider keys need STORE_BACKEND=postgres", 503),
    );
    asOwner();

    renderWithRun(<ProviderKeysSettingsPage />);
    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(
      await screen.findByText(
        "Provider keys aren't available on this host right now. Try again shortly.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("STORE_BACKEND");

    vi.spyOn(providerKeysApi, "revokeProviderKey").mockRejectedValueOnce(new Error("boom"));
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
  });
});

describe("ProviderKeysSettingsPage — unsaved key material marks the page dirty (PRRT_kwDOSzP1zc6mXO6d)", () => {
  test("typing an unsaved key marks the page dirty — the header's own guard prompts on navigation", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    asOwner();

    renderWithRun(
      <>
        <Header />
        <ProviderKeysSettingsPage />
      </>,
    );

    const input = await screen.findByLabelText("Gemini key");
    await user.type(input, "typed-but-not-saved");

    await user.click(screen.getByRole("link", { name: "Grid" }));

    expect(await screen.findByRole("dialog", { name: "Unsaved edits" })).toBeTruthy();
  });

  test("losing write access drops the typed key, so the page is no longer dirty", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    asOwner();

    // Fix round (bots, D185) — a FUNCTION, so the rerender below gets a fresh
    // tree. It used to hand back the identical element object, which React
    // treats as "nothing here changed" and skips; what was actually
    // re-rendering the page was `EditorDirtyProvider` handing every consumer a
    // new context value on every one of its own renders, which this page
    // consumed whether or not it read. It re-reads `useActiveMember` here
    // because it re-renders, and a fresh tree is what says so.
    const tree = () => (
      <>
        <Header />
        <ProviderKeysSettingsPage />
      </>
    );
    const { rerender } = renderWithRun(tree());

    await user.type(await screen.findByLabelText("Gemini key"), "typed-then-demoted");

    asMember();
    rerender(<ShellProviders>{tree()}</ShellProviders>);
    await waitFor(() => expect(screen.queryByLabelText("Gemini key")).toBeNull());

    await user.click(screen.getByRole("link", { name: "Grid" }));

    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
  });

  test("clearing the only typed field un-marks the page dirty", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    asOwner();

    renderWithRun(
      <>
        <Header />
        <ProviderKeysSettingsPage />
      </>,
    );

    const input = await screen.findByLabelText("Gemini key");
    await user.type(input, "typed-then-cleared");
    await user.clear(input);

    await user.click(screen.getByRole("link", { name: "Grid" }));

    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
  });

  test("saving clears the dirty flag along with the field", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    vi.spyOn(providerKeysApi, "setProviderKey").mockResolvedValue({
      provider: "gemini",
      last4: "abcd",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    asOwner();

    renderWithRun(
      <>
        <Header />
        <ProviderKeysSettingsPage />
      </>,
    );

    const input = await screen.findByLabelText("Gemini key");
    await user.type(input, "some-key-value-1234");
    await user.click(submitButtonFor(input));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));

    await user.click(screen.getByRole("link", { name: "Grid" }));

    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
  });

  test("one row's cleared input does not clear another row's still-typed input", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    asOwner();

    renderWithRun(
      <>
        <Header />
        <ProviderKeysSettingsPage />
      </>,
    );

    const geminiInput = await screen.findByLabelText("Gemini key");
    const openRouterInput = screen.getByLabelText("OpenRouter key");

    await user.type(geminiInput, "still-typed");
    await user.type(openRouterInput, "x");
    await user.clear(openRouterInput);

    await user.click(screen.getByRole("link", { name: "Grid" }));

    // OpenRouter's own row is pristine again, but Gemini's is not — the aggregate
    // must still read dirty. A bug here would have the last row to go pristine wipe
    // every other row's flag.
    expect(await screen.findByRole("dialog", { name: "Unsaved edits" })).toBeTruthy();
  });

  test("the aggregate dirty-publish effect does not re-call setDirty when anyDirty is unchanged, even if setDirty's own identity changes", async () => {
    // `setDirty` from the REAL EditorDirtyProvider is stable for the life of that
    // one provider instance (`useCallback(fn, [])`), so nothing in this app's own
    // tree can make its identity change without unmounting the whole page — which
    // would also reset `dirtyRows`, and the ref would start fresh anyway. The only
    // way to exercise "the effect re-runs on a dependency change while `anyDirty`
    // itself is unchanged" is to control that one dependency directly: mock
    // `useEditorDirty` so it returns a NEW `setDirty` function on a later render of
    // the SAME mounted `BetterAuthProviderKeys`, while `dirtyRows` (hence
    // `anyDirty`) is untouched — driven here by the list fetch resolving, which
    // triggers a re-render but touches no dirty-row state at all.
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    let resolveList!: (summaries: providerKeysApi.ProviderKeySummary[]) => void;
    vi.spyOn(providerKeysApi, "listProviderKeys").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );
    asOwner();

    const setDirtyBeforeResolve = vi.fn();
    const setDirtyAfterResolve = vi.fn();
    let activeSetDirty = setDirtyBeforeResolve;
    vi.spyOn(editorDirtyContext, "useEditorDirty").mockImplementation(() => ({
      isDirty: false,
      setDirty: activeSetDirty,
      // D185 — the draft write states, which this page neither reads nor writes.
      hasPendingWrite: false,
      hasFailedWrite: false,
      registerDraftWriter: vi.fn(() => {
        throw new Error("this page registers no draft-write writer");
      }),
      guardedAction: vi.fn(() => true),
      guardedPush: vi.fn(() => true),
    }));

    render(<ProviderKeysSettingsPage />);
    await screen.findByText("Loading…");

    // Mount: `anyDirty` starts `false` (no rows exist yet — the list hasn't
    // resolved), the ref starts `null`, `null !== false` is true, so this is a
    // real (first) publish.
    await waitFor(() => expect(setDirtyBeforeResolve).toHaveBeenCalledWith(false));
    expect(setDirtyBeforeResolve).toHaveBeenCalledTimes(1);

    // Swap the identity the hook resolves to, then resolve the list — this flips
    // `phase`/`keys` but no row exists yet to make `dirtyRows` non-empty, so
    // `anyDirty` is `false` both before and after. The effect's dependency array
    // still changes (a new `setDirty` reference), so it reruns; the ref guard must
    // recognise `anyDirty` is unchanged and skip the call.
    activeSetDirty = setDirtyAfterResolve;
    await act(async () => {
      resolveList([]);
      await Promise.resolve();
    });
    await screen.findByText("Gemini");

    // The guarded effect (line 188) must never call the new identity — that is
    // the branch this test exists to prove. A separate, unrelated effect (the
    // "clear on unmount" one, which also depends on `setDirty`) tears down its
    // OLD instance when `setDirty` changes identity, and ITS cleanup legitimately
    // calls the OLD `setDirty(false)` one more time — that is a real, correct
    // call from a different effect, not a second call from the guarded one, so
    // it is not asserted against here.
    expect(setDirtyAfterResolve).not.toHaveBeenCalled();
  });
});
