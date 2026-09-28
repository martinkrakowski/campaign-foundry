import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ShellProviders, renderWithRun, nextMock, storedTemplate } from "@/__tests__/helpers";
import { CreateCampaignProvider, useCreateCampaign } from "@/lib/create-campaign-context";
import { editorReducer, initialEditorState, saveDraftToStorage } from "@/components/campaign/editor-state";
import BriefIndexPage from "../page";
import BriefIdPage from "../[id]/page";
import NewBriefPage from "../new/page";

const storedBrief = (id: string) => ({
  id,
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  template: storedTemplate,
  products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("cf:brief-picked", "1");
});

describe("the bare /brief route (D37)", () => {
  test("redirects to the brief last opened", async () => {
    localStorage.setItem("cf:brief", JSON.stringify(storedBrief("camp")));
    renderWithRun(<BriefIndexPage />);
    await vi.waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/brief/camp"));
  });

  test("redirects to the grid when no last-opened brief is recorded", async () => {
    renderWithRun(<BriefIndexPage />);
    await vi.waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/grid"));
  });

  test("redirects to the grid when the record is unreadable", async () => {
    localStorage.setItem("cf:brief", "{ not json");
    renderWithRun(<BriefIndexPage />);
    await vi.waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/grid"));
  });

  test("redirects to the grid when the record is not a brief", async () => {
    localStorage.setItem("cf:brief", JSON.stringify(["not", "a", "brief"]));
    renderWithRun(<BriefIndexPage />);
    await vi.waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/grid"));
  });

  test("redirects to the grid when the last-opened id is malformed", async () => {
    localStorage.setItem("cf:brief", JSON.stringify(storedBrief("Not Safe")));
    renderWithRun(<BriefIndexPage />);
    await vi.waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/grid"));
  });

  test("never renders an editor itself", () => {
    localStorage.setItem("cf:brief", JSON.stringify(storedBrief("camp")));
    renderWithRun(<BriefIndexPage />);
    expect(screen.queryByLabelText("Campaign Name")).toBeNull();
  });
});

describe("the /brief/{id} route (D37)", () => {
  test("hands the route's id to the editor", async () => {
    const page = await BriefIdPage({ params: Promise.resolve({ id: "camp" }) });
    expect((page as React.ReactElement<{ briefId?: string }>).props.briefId).toBe("camp");
  });
});

/**
 * PT-5c1 (D177) — `/brief/new` no longer starts a blank campaign itself
 * (create always mints through `POST /campaigns` first, landing on
 * `/brief/<campaignId>`); its one remaining job is W3's resume of a draft
 * abandoned under the pre-lane `cf:draft:new` key. Every other behaviour a
 * mounted `BriefEditor` has — mode toggle, action bar, Save as… — is
 * `BriefEditor`'s own contract, exercised at `/brief/{id}` in
 * `brief-editor.test.tsx`; this route's own contract is just the branch.
 */
const Probe = () => {
  const { createDialogOpen } = useCreateCampaign();
  return <span data-testid="dialog-open">{String(createDialogOpen)}</span>;
};

const renderNewBriefPage = () =>
  render(
    <ShellProviders>
      <CreateCampaignProvider>
        <Probe />
        <NewBriefPage />
      </CreateCampaignProvider>
    </ShellProviders>,
  );

describe("/brief/new — resume or create (PT-5c1, W3)", () => {
  test("with no recoverable draft, opens the create dialog and redirects to the grid", async () => {
    renderNewBriefPage();
    await waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/grid"));
    expect(screen.getByTestId("dialog-open").textContent).toBe("true");
    expect(screen.queryByLabelText("Campaign Name")).toBeNull();
  });

  test("a pristine stored draft is not recoverable — opens the dialog too", async () => {
    saveDraftToStorage(initialEditorState());
    renderNewBriefPage();
    await waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/grid"));
    expect(screen.getByTestId("dialog-open").textContent).toBe("true");
  });

  test("resumes an abandoned blank draft instead of opening the dialog (W3)", async () => {
    saveDraftToStorage(
      editorReducer(initialEditorState(), {
        type: "patch",
        patch: { campaignName: "Half-written" },
      }),
    );
    renderNewBriefPage();
    expect(await screen.findByLabelText("Campaign Name")).toHaveValue("Half-written");
    expect(nextMock().router.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("dialog-open").textContent).toBe("false");
  });
});
