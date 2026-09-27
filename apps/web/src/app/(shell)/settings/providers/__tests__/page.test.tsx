import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as briefsApi from "@/lib/briefs-api";
import * as providerKeysApi from "@/lib/provider-keys-api";
import { ProviderKeysApiError } from "@/lib/provider-keys-api";
import { authClient } from "@/lib/auth-client";
import ProviderKeysSettingsPage from "../page";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useActiveMember: vi.fn(() => ({ data: null, isPending: false })),
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

  test("a rejected capabilities probe never asks for provider keys — nothing renders, no unhandled rejection", async () => {
    const listSpy = vi.spyOn(providerKeysApi, "listProviderKeys");
    vi.spyOn(briefsApi, "getCapabilities").mockRejectedValue(new Error("probe unreachable"));
    const { container } = render(<ProviderKeysSettingsPage />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toBe("");
    expect(listSpy).not.toHaveBeenCalled();
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
});

describe("ProviderKeysSettingsPage — list states", () => {
  test("shows a loading state while the list is in flight", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockImplementation(() => new Promise(() => {}));
    asOwner();

    render(<ProviderKeysSettingsPage />);

    expect(await screen.findByText("Loading…")).toBeTruthy();
  });

  test("shows 'none' for every provider with no registered key", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    asOwner();

    render(<ProviderKeysSettingsPage />);

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

    render(<ProviderKeysSettingsPage />);

    expect(await screen.findByText("…1234 (2026-09-27)")).toBeTruthy();
  });

  test("the 503 'needs Postgres' answer surfaces as the list's error message", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockRejectedValue(
      new ProviderKeysApiError(
        "Org provider keys need STORE_BACKEND=postgres: BYOK is Postgres-only, as Better Auth already is.",
        503,
      ),
    );
    asOwner();

    render(<ProviderKeysSettingsPage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Org provider keys need STORE_BACKEND=postgres: BYOK is Postgres-only, as Better Auth already is.",
    );
  });

  test("a non-ProviderKeysApiError rejection falls back to a fixed sentence", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockRejectedValue(new Error("boom"));
    asOwner();

    render(<ProviderKeysSettingsPage />);

    expect(await screen.findByText("Could not load provider keys.")).toBeTruthy();
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

    const { unmount } = render(<ProviderKeysSettingsPage />);
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

    const { unmount } = render(<ProviderKeysSettingsPage />);
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

    render(<ProviderKeysSettingsPage />);

    expect(await screen.findByLabelText("Gemini key")).toBeTruthy();
    expect(screen.getByLabelText("OpenRouter key")).toBeTruthy();
    expect(screen.getByLabelText("Firefly client ID")).toBeTruthy();
    expect(screen.getByLabelText("Firefly client secret")).toBeTruthy();
  });

  test("an admin sees write controls for every provider", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    asAdmin();

    render(<ProviderKeysSettingsPage />);

    expect(await screen.findByLabelText("Gemini key")).toBeTruthy();
  });

  test("a member sees the list read-only: no inputs, no revoke button, even with a key set", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([
      { provider: "gemini", last4: "1234", createdAt: "2026-09-27T00:00:00.000Z" },
    ]);
    asMember();

    render(<ProviderKeysSettingsPage />);

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

    render(<ProviderKeysSettingsPage />);

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

    render(<ProviderKeysSettingsPage />);

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

    render(<ProviderKeysSettingsPage />);

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

    render(<ProviderKeysSettingsPage />);

    expect(await screen.findByText("…5678 (2026-09-27)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(revokeSpy).toHaveBeenCalledWith("openrouter"));
    await waitFor(() => expect(screen.getAllByText("none").length).toBeGreaterThan(0));
  });
});

describe("ProviderKeysSettingsPage — error messages", () => {
  test("a 400 from setProviderKey is shown verbatim", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    vi.spyOn(providerKeysApi, "setProviderKey").mockRejectedValue(
      new ProviderKeysApiError("Provide { key }, 8-4096 characters.", 400),
    );
    asOwner();

    render(<ProviderKeysSettingsPage />);
    const input = await screen.findByLabelText("Gemini key");
    await user.type(input, "short");
    await user.click(submitButtonFor(input));

    expect(await screen.findByText("Provide { key }, 8-4096 characters.")).toBeTruthy();
  });

  test("a 403 from setProviderKey is shown verbatim", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    vi.spyOn(providerKeysApi, "setProviderKey").mockRejectedValue(
      new ProviderKeysApiError("Only an owner or admin may manage provider keys.", 403),
    );
    asOwner();

    render(<ProviderKeysSettingsPage />);
    const input = await screen.findByLabelText("Gemini key");
    await user.type(input, "some-key-value-1234");
    await user.click(submitButtonFor(input));

    expect(
      await screen.findByText("Only an owner or admin may manage provider keys."),
    ).toBeTruthy();
  });

  test("a 409 from setProviderKey is shown verbatim", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    vi.spyOn(providerKeysApi, "setProviderKey").mockRejectedValue(
      new ProviderKeysApiError("Provider key was replaced concurrently; retry.", 409),
    );
    asOwner();

    render(<ProviderKeysSettingsPage />);
    const input = await screen.findByLabelText("OpenRouter key");
    await user.type(input, "some-key-value-1234");
    const openRouterForm = input.closest("form") as HTMLFormElement;
    await user.click(openRouterForm.querySelector('button[type="submit"]') as HTMLButtonElement);

    expect(await screen.findByText("Provider key was replaced concurrently; retry.")).toBeTruthy();
  });

  test("a 503 from setProviderKey (KEK not configured) is shown verbatim", async () => {
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

    render(<ProviderKeysSettingsPage />);
    const input = await screen.findByLabelText("Gemini key");
    await user.type(input, "some-key-value-1234");
    await user.click(submitButtonFor(input));

    expect(
      await screen.findByText(
        "KEY_ENCRYPTION_KEYS is not set: org provider keys cannot be sealed or opened.",
      ),
    ).toBeTruthy();
  });

  test("a non-ProviderKeysApiError rejection from setProviderKey falls back to a fixed sentence", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([]);
    vi.spyOn(providerKeysApi, "setProviderKey").mockRejectedValue(new Error("boom"));
    asOwner();

    render(<ProviderKeysSettingsPage />);
    const input = await screen.findByLabelText("Gemini key");
    await user.type(input, "some-key-value-1234");
    await user.click(submitButtonFor(input));

    expect(await screen.findByText("Could not save the key.")).toBeTruthy();
  });

  test("a revoke failure is shown verbatim and a non-ProviderKeysApiError rejection falls back", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue(betterAuthCapabilities());
    vi.spyOn(providerKeysApi, "listProviderKeys").mockResolvedValue([
      { provider: "firefly", last4: "efgh", createdAt: "2026-09-27T00:00:00.000Z" },
    ]);
    vi.spyOn(providerKeysApi, "revokeProviderKey").mockRejectedValueOnce(
      new ProviderKeysApiError("BYOK needs Postgres", 503),
    );
    asOwner();

    render(<ProviderKeysSettingsPage />);
    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("BYOK needs Postgres")).toBeTruthy();

    vi.spyOn(providerKeysApi, "revokeProviderKey").mockRejectedValueOnce(new Error("boom"));
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("Could not revoke the key.")).toBeTruthy();
  });
});
