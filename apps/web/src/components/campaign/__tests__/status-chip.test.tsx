import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { StatusChip } from "../StatusChip";
import { editorReducer, initialEditorState, toBrief, type EditorState } from "../editor-state";

const saved = (): CampaignBrief =>
  ({
    id: "camp",
    targetRegion: "DE",
    targetAudience: "a",
    campaignMessage: "Hi",
    products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "l.png" }],
  }) as CampaignBrief;

const reduce = (state: EditorState, ...actions: Parameters<typeof editorReducer>[1][]) =>
  actions.reduce(editorReducer, state);

describe("StatusChip", () => {
  // D41: two states — "Unsaved changes" / "Saved" — written-or-not, never
  // applied-or-not. The old four-state vocabulary (and the "Draft not applied"
  // badge it produced) no longer exists.

  test("a pristine, untouched new editor renders no chip — there is nothing to be unsaved", () => {
    // The two-state reduction regressed here: `isDirtySinceSave` treats a new source
    // as unwritten (true, and other callers depend on that), so a blank form the user
    // never touched rendered "Unsaved changes" — a report about changes that do not
    // exist. The chip declines to speak until the draft has something in it; the old
    // four-state vocabulary stays gone either way.
    render(<StatusChip state={initialEditorState()} />);
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.queryByText("Draft not applied")).toBeNull();
  });

  test("a new editor with content typed reads Unsaved changes", () => {
    // The suppression above is about *untouched*, not about new: once the user has
    // typed, there are real changes to be unsaved and the chip must say so.
    const typed = reduce(initialEditorState(), { type: "patch", patch: { campaignMessage: "Hi" } });
    render(<StatusChip state={typed} />);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  test("a committed-but-unsaved draft reads Unsaved changes — the chip says written-or-not, not applied-or-not", () => {
    const applied = reduce({ ...initialEditorState(), briefId: "camp" }, { type: "apply" });
    render(<StatusChip state={applied} />);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  test("a loaded brief reads Saved", () => {
    const state = reduce(
      initialEditorState(),
      { type: "load", brief: saved(), entry: { file: "camp.yaml", revision: "r1" } },
    );
    render(<StatusChip state={state} />);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  test("editing after a save reads Unsaved changes, and saving returns it to Saved", () => {
    const edited = reduce(
      initialEditorState(),
      { type: "load", brief: saved(), entry: { file: "camp.yaml", revision: "r1" } },
      { type: "patch", patch: { campaignMessage: "Changed" } },
    );
    const { rerender } = render(<StatusChip state={edited} />);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    // the save snapshots what the server stored — the brief the PUT echoed
    const storedBrief = toBrief(edited);
    const stored = reduce(
      edited,
      { type: "save", saved: storedBrief },
      { type: "apply", applied: storedBrief },
    );
    rerender(<StatusChip state={stored} />);
    expect(screen.getByText("Saved")).toBeTruthy();
  });
});
