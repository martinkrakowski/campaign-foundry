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

  test("a fresh, never-written draft reads Unsaved changes, and nothing speaks of applying", () => {
    render(<StatusChip state={initialEditorState()} />);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.queryByText("Draft not applied")).toBeNull();
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
