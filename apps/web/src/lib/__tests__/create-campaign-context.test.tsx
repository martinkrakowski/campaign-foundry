import { describe, test, expect } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateCampaignProvider, useCreateCampaign } from "../create-campaign-context";
import { createCampaign } from "../create-campaign";

const Probe = () => {
  const { createDialogOpen, openCreateDialog, closeCreateDialog, seedVersion } = useCreateCampaign();
  return (
    <div>
      <span data-testid="open">{String(createDialogOpen)}</span>
      <span data-testid="version">{seedVersion}</span>
      <button type="button" onClick={openCreateDialog}>
        open
      </button>
      <button type="button" onClick={closeCreateDialog}>
        close
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
      await createCampaign({ name: "Summer Spark", targetRegion: "EU", targetAudience: "a", mode: "brief" });
    });
    expect(screen.getByTestId("version").textContent).toBe("1");
    await waitFor(() => expect(localStorage.getItem("cf:create-seed")).not.toBeNull());
  });

  test("answers the defaults outside a provider, the way SectionModeContext does", async () => {
    const user = userEvent.setup();
    render(<Probe />);
    expect(screen.getByTestId("open").textContent).toBe("false");
    expect(screen.getByTestId("version").textContent).toBe("0");
    // The default gestures are no-ops: the shell's create dialog simply is not there.
    await user.click(screen.getByRole("button", { name: "open" }));
    await user.click(screen.getByRole("button", { name: "close" }));
    expect(screen.getByTestId("open").textContent).toBe("false");
  });
});
