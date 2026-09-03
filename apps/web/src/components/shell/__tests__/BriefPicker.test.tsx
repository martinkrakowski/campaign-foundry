import { describe, test, expect, beforeEach, vi } from "vitest";
import { useEffect } from "react";
import { render } from "@testing-library/react";
import { ShellProviders } from "@/__tests__/helpers";
import { useEditorDirty } from "@/lib/editor-dirty-context";
import { CreateCampaignProvider } from "@/lib/create-campaign-context";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EMPTY_REPORT, json, mockPipelineApi, nextMock, renderWithRun as renderWithShell } from "@/__tests__/helpers";
import * as messages from "@/components/campaign/messages";
import { BriefPicker } from "../BriefPicker";
import { CreateCampaignDialog } from "../CreateCampaignDialog";

/**
 * W1: the picker and the create dialog are shell overlays mounted side by side in
 * the layout; the suite mounts both so the create gesture is exercisable end to end.
 */
const renderWithRun = (ui: React.ReactElement) =>
  renderWithShell(
    <CreateCampaignProvider>
      {ui}
      <CreateCampaignDialog />
    </CreateCampaignProvider>,
  );

/** The picker with the editor claiming unsaved changes, so the guard prompts. */
const renderDirty = (ui: React.ReactElement) => {
  const RaiseDirty = () => {
    const { setDirty } = useEditorDirty();
    useEffect(() => setDirty(true), [setDirty]);
    return null;
  };
  return render(
    <ShellProviders>
      <CreateCampaignProvider>
        <RaiseDirty />
        {ui}
        <CreateCampaignDialog />
      </CreateCampaignProvider>
    </ShellProviders>,
  );
};

beforeEach(() => localStorage.removeItem("cf:brief-picked"));

const demo = {
  file: "demo.yaml",
  brief: { id: "demo", targetRegion: "DE", products: [{ id: "a" }, { id: "b" }] },
};

const route = (opts: { briefs?: unknown; post?: (url: string, init: RequestInit) => Response; failReload?: boolean } = {}) => {
  let listed = 0;
  mockPipelineApi({
    post: (url, init) => (opts.post ? opts.post(url, init) : json({ jobId: "job-1" }, 202)),
    result: (url) => {
      if (url.includes("/campaigns/briefs")) {
        listed += 1;
        if (opts.failReload && listed > 1) return json({ error: "fail" }, 500);
        return json({ briefs: opts.briefs ?? [demo] });
      }
      return json(EMPTY_REPORT);
    },
  });
};

describe("BriefPicker create / duplicate", () => {
  test("Create new closes the picker and opens the create dialog, without navigating (W1)", async () => {
    const user = userEvent.setup();
    route({ briefs: [] });
    renderWithRun(<BriefPicker />);
    await screen.findByText(/No briefs found/);
    await user.click(screen.getByText("Create new"));
    // W1 (D66/D67): the row is a door to the dialog now — the blank route is reached
    // by the dialog's Create, so nothing navigates and the picker closes first (F22).
    expect(nextMock().router.push).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Load a campaign brief" })).toBeNull());
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
  });

  test("picking a brief navigates to its route instead of setting state (D37)", async () => {
    const user = userEvent.setup();
    route({});
    renderWithRun(<BriefPicker />);
    await screen.findByText("demo.yaml");

    await user.click(screen.getByRole("button", { name: /demo\.yaml/ }));

    // The route is the source of truth for which brief is open; the editor loads
    // the brief from it, so the picker no longer sets the shell's brief directly.
    expect(nextMock().router.push).toHaveBeenCalledWith("/brief/demo");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Load a campaign brief" })).toBeNull());
  });

  test("picking with an unsaved draft prompts exactly once, and leaving navigates", async () => {
    const user = userEvent.setup();
    route({});
    renderDirty(<BriefPicker />);
    await screen.findByText("demo.yaml");

    await user.click(screen.getByRole("button", { name: /demo\.yaml/ }));

    // One question, not two: the ConfirmDialog is the guard's whole prompt.
    const dialogs = await screen.findAllByRole("dialog", { name: "Unsaved edits" });
    expect(dialogs).toHaveLength(1);
    expect(nextMock().router.push).not.toHaveBeenCalled();

    await user.click(within(dialogs[0]).getByRole("button", { name: "Leave" }));
    expect(nextMock().router.push).toHaveBeenCalledTimes(1);
    expect(nextMock().router.push).toHaveBeenCalledWith("/brief/demo");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Load a campaign brief" })).toBeNull());
  });

  test("a refused prompt does not navigate and keeps the picker open", async () => {
    const user = userEvent.setup();
    route({});
    renderDirty(<BriefPicker />);
    await screen.findByText("demo.yaml");

    await user.click(screen.getByRole("button", { name: /demo\.yaml/ }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));

    expect(nextMock().router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Load a campaign brief" })).toBeTruthy();
  });

  test("duplicates a clean editor's entry, reloads, and navigates to the copy's route", async () => {
    const user = userEvent.setup();
    const copy = { id: "demo-copy", targetRegion: "DE", products: [{ id: "a" }] };
    route({
      failReload: true,
      post: (url, init) => {
        expect(url).toContain("/campaigns/briefs/demo/duplicate");
        expect(JSON.parse(String(init.body))).toEqual({ newId: "demo-copy" });
        return json({ file: "demo-copy.yaml", brief: copy }, 201);
      },
    });
    renderWithRun(<BriefPicker />);
    await screen.findByText("demo.yaml");
    await user.click(screen.getByText("Duplicate"));
    await user.type(screen.getByLabelText("New brief id"), "demo-copy{Enter}");
    // D37: the copy is opened by navigating to it — the editor at that route loads
    // it and commits it to the shell, so the picker never sets the brief itself.
    // D67: the clean editor's guard is silent, so the write runs at once.
    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/demo-copy"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Load a campaign brief" })).toBeNull());
  });

  test("on a dirty editor, accepting the guard on Duplicate prompts exactly once, POSTs, and navigates (D67)", async () => {
    const user = userEvent.setup();
    const copy = { id: "demo-copy", targetRegion: "DE", products: [{ id: "a" }] };
    route({
      failReload: true,
      post: (url) => {
        expect(url).toContain("/campaigns/briefs/demo/duplicate");
        return json({ file: "demo-copy.yaml", brief: copy }, 201);
      },
    });
    renderDirty(<BriefPicker />);
    await screen.findByText("demo.yaml");
    await user.click(screen.getByText("Duplicate"));
    await user.type(screen.getByLabelText("New brief id"), "demo-copy{Enter}");

    // D67: the whole async sequence lives inside ONE guarded action — the question
    // comes first, and the navigation inside carries no second guard (a nested guard
    // would park again: the guard does not clear the dirty flag).
    const dialogs = await screen.findAllByRole("dialog", { name: "Unsaved edits" });
    expect(dialogs).toHaveLength(1);
    await user.click(within(dialogs[0]).getByRole("button", { name: "Leave" }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/demo-copy"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Load a campaign brief" })).toBeNull());
    // One question for one gesture: no second "Unsaved edits" after the write.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(screen.queryAllByRole("dialog", { name: "Unsaved edits" })).toHaveLength(0);
  });

  test("declining the guard on Duplicate performs no POST (D67)", async () => {
    const user = userEvent.setup();
    const post = vi.fn((_url: string, _init: RequestInit) => json({}, 201));
    route({ post: (url, init) => post(url, init) });
    renderDirty(<BriefPicker />);
    await screen.findByText("demo.yaml");
    await user.click(screen.getByText("Duplicate"));
    await user.type(screen.getByLabelText("New brief id"), "demo-copy{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));

    // The question comes first: a refused duplicate wrote nothing at all.
    expect(post).not.toHaveBeenCalled();
    expect(nextMock().router.push).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Load a campaign brief" })).toBeTruthy();
  });

  test("declining the unsaved-changes prompt leaves the picker open", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => false);
    route({});
    renderDirty(<BriefPicker />);
    await screen.findByText("demo.yaml");

    await user.click(screen.getByRole("button", { name: /Create new/ }));

    expect(nextMock().router.push).not.toHaveBeenCalled();
    // the picker closing on a refused navigation dismisses the very list the user is
    // still choosing from
    expect(screen.getByRole("dialog", { name: "Load a campaign brief" })).toBeTruthy();
  });

  test("rejects an unsafe duplicate id, surfaces API errors, and cancels", async () => {
    const user = userEvent.setup();
    route({
      post: () => json({ error: 'Brief "taken" already exists.' }, 409),
    });
    renderWithRun(<BriefPicker />);
    await screen.findByText("demo.yaml");
    await user.click(screen.getByText("Duplicate"));
    await user.type(screen.getByLabelText("New brief id"), "Bad Id{Enter}");
    expect(await screen.findByText(/path-safe slug/)).toBeTruthy();
    await user.clear(screen.getByLabelText("New brief id"));
    await user.type(screen.getByLabelText("New brief id"), "taken{Enter}");
    expect(await screen.findByText(/already exists/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New brief id")).toBeNull();
  });
});
