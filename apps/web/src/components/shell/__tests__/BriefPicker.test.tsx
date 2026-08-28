import { describe, test, expect, beforeEach, vi } from "vitest";
import { useEffect } from "react";
import { render } from "@testing-library/react";
import { ShellProviders } from "@/__tests__/helpers";
import { useEditorDirty } from "@/lib/editor-dirty-context";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EMPTY_REPORT, json, mockPipelineApi, nextMock, renderWithRun } from "@/__tests__/helpers";
import { BriefPicker } from "../BriefPicker";

/** The picker with the editor claiming unsaved changes, so the guard prompts. */
const renderDirty = (ui: React.ReactElement) => {
  const RaiseDirty = () => {
    const { setDirty } = useEditorDirty();
    useEffect(() => setDirty(true), [setDirty]);
    return null;
  };
  return render(
    <ShellProviders>
      <RaiseDirty />
      {ui}
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
  test("Create new closes the picker and navigates to /brief/new", async () => {
    const user = userEvent.setup();
    route({ briefs: [] });
    renderWithRun(<BriefPicker />);
    await screen.findByText(/No briefs found/);
    await user.click(screen.getByText("Create new"));
    expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Load a campaign brief" })).toBeNull());
  });

  test("duplicates an entry, reloads, and selects the copy", async () => {
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
    await waitFor(() => expect(JSON.parse(localStorage.getItem("cf:brief") ?? "{}").id).toBe("demo-copy"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Load a campaign brief" })).toBeNull());
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
