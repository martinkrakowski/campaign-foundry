import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  ShellProviders,
  renderWithRun,
  nextMock,
  storedTemplate,
  mockPipelineApi,
  json,
} from "@/__tests__/helpers";
import { CreateCampaignProvider, useCreateCampaign } from "@/lib/create-campaign-context";
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
 * `/brief/<campaignId>`); its one remaining job is W3's server-side resume
 * (PT-5d item 5): `GET /campaigns/briefs/draft` answers the caller's latest
 * draft, and this route navigates to that campaign rather than ever mounting
 * a bare editor itself. Every other behaviour a mounted `BriefEditor` has —
 * mode toggle, action bar, Save as… — is `BriefEditor`'s own contract,
 * exercised at `/brief/{id}` in `brief-editor.test.tsx`; this route's own
 * contract is just the branch.
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

const isLatestDraftUrl = (u: string) => u.includes("/campaigns/briefs/draft");

describe("/brief/new — resume or create (PT-5c1, PT-5d, W3)", () => {
  test("with no recoverable draft, opens the create dialog and redirects to the grid", async () => {
    mockPipelineApi({ result: (u) => (isLatestDraftUrl(u) ? json({ latest: null }) : json({})) });
    renderNewBriefPage();
    await waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/grid"));
    expect(screen.getByTestId("dialog-open").textContent).toBe("true");
    expect(screen.queryByLabelText("Campaign Name")).toBeNull();
  });

  test("resumes a caller's latest server draft by navigating to its campaign, never opening the dialog (W3)", async () => {
    mockPipelineApi({
      result: (u) =>
        isLatestDraftUrl(u)
          ? json({ latest: { campaignId: "resumed-1", slug: "resumed-1" } })
          : json({}),
    });
    renderNewBriefPage();
    await waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/brief/resumed-1"));
    expect(screen.getByTestId("dialog-open").textContent).toBe("false");
    // Never a bare editor mounted here (PT-5d item 5): the destination route
    // (`/brief/{id}`) is what loads it, exercised in brief-editor.test.tsx.
    expect(screen.queryByLabelText("Campaign Name")).toBeNull();
  });

  test("unmounting before the latest-draft fetch answers navigates nowhere", async () => {
    let resolveLatest: ((r: Response) => void) | null = null;
    mockPipelineApi({
      result: (u) =>
        isLatestDraftUrl(u)
          ? new Promise<Response>((resolve) => (resolveLatest = resolve))
          : json({}),
    });
    const view = renderNewBriefPage();
    await waitFor(() => expect(resolveLatest).not.toBeNull());
    view.unmount();
    resolveLatest!(json({ latest: { campaignId: "too-late", slug: "too-late" } }));
    await Promise.resolve();
    expect(nextMock().router.replace).not.toHaveBeenCalled();
  });

  // Fix round (bots) — CodeRabbit: a failed lookup must not be silently
  // treated as "no draft" without at least documenting the choice this route
  // makes about it. `fetchLatestServerDraft` now distinguishes the two
  // (`editor-state.ts`); this route deliberately still falls through to the
  // create dialog either way (see its own doc comment for why that is safe
  // here, unlike `CreateCampaignDialog`'s stricter refusal).
  test("a failed latest-draft lookup falls through to the create dialog, same as no draft", async () => {
    mockPipelineApi({ result: (u) => (isLatestDraftUrl(u) ? json({}, 500) : json({})) });
    renderNewBriefPage();
    await waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/grid"));
    expect(screen.getByTestId("dialog-open").textContent).toBe("true");
  });
});
