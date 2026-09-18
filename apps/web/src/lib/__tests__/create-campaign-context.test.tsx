import { describe, test, expect } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateCampaignProvider, useCreateCampaign } from "../create-campaign-context";
import { createCampaign } from "../create-campaign";

const Probe = () => {
  const {
    createDialogOpen,
    openCreateDialog,
    closeCreateDialog,
    templateLibraryOpen,
    openTemplateLibrary,
    closeTemplateLibrary,
    seedVersion,
  } = useCreateCampaign();
  return (
    <div>
      <span data-testid="open">{String(createDialogOpen)}</span>
      <span data-testid="library">{String(templateLibraryOpen)}</span>
      <span data-testid="version">{seedVersion}</span>
      <button type="button" onClick={openCreateDialog}>
        open
      </button>
      <button type="button" onClick={closeCreateDialog}>
        close
      </button>
      <button type="button" onClick={openTemplateLibrary}>
        open library
      </button>
      <button type="button" onClick={closeTemplateLibrary}>
        close library
      </button>
    </div>
  );
};

describe("CreateCampaignProvider", () => {
  test("holds the dialog's open state", async () => {
    const user = userEvent.setup();
    render(
      <CreateCampaignProvider>
        <Probe />
      </CreateCampaignProvider>,
    );
    expect(screen.getByTestId("open").textContent).toBe("false");
    await user.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByTestId("open").textContent).toBe("true");
    await user.click(screen.getByRole("button", { name: "close" }));
    expect(screen.getByTestId("open").textContent).toBe("false");
  });

  /**
   * TM4 — the template library's open state is a second, independent channel:
   * the two overlays are never open at once (F22), so neither gesture may move
   * the other's flag.
   */
  test("holds the template library's open state, independently of the dialog's", async () => {
    const user = userEvent.setup();
    render(
      <CreateCampaignProvider>
        <Probe />
      </CreateCampaignProvider>,
    );
    expect(screen.getByTestId("library").textContent).toBe("false");
    await user.click(screen.getByRole("button", { name: "open library" }));
    expect(screen.getByTestId("library").textContent).toBe("true");
    expect(screen.getByTestId("open").textContent).toBe("false");
    await user.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByTestId("library").textContent).toBe("true");
    await user.click(screen.getByRole("button", { name: "close library" }));
    expect(screen.getByTestId("library").textContent).toBe("false");
    expect(screen.getByTestId("open").textContent).toBe("true");
  });

  test("republishes a published seed as a version bump", async () => {
    render(
      <CreateCampaignProvider>
        <Probe />
      </CreateCampaignProvider>,
    );
    expect(screen.getByTestId("version").textContent).toBe("0");
    // The provider never consumes the key — a full page load on the blank route must
    // still find it — so the bump is the only thing it publishes.
    await act(async () => {
      await createCampaign({ name: "Summer Spark", type: "social-post" });
    });
    expect(screen.getByTestId("version").textContent).toBe("1");
    await waitFor(() => expect(localStorage.getItem("cf:create-seed")).not.toBeNull());
  });

  test("answers the defaults outside a provider, the way SectionModeContext does", async () => {
    const user = userEvent.setup();
    render(<Probe />);
    expect(screen.getByTestId("open").textContent).toBe("false");
    expect(screen.getByTestId("version").textContent).toBe("0");
    expect(screen.getByTestId("library").textContent).toBe("false");
    // The default gestures are no-ops: the shell's create dialog simply is not there.
    await user.click(screen.getByRole("button", { name: "open" }));
    await user.click(screen.getByRole("button", { name: "close" }));
    await user.click(screen.getByRole("button", { name: "open library" }));
    await user.click(screen.getByRole("button", { name: "close library" }));
    expect(screen.getByTestId("open").textContent).toBe("false");
    expect(screen.getByTestId("library").textContent).toBe("false");
  });
});
