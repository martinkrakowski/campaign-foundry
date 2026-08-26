import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { StatusChip } from "../StatusChip";
import { editorReducer, initialEditorState, type EditorState } from "../editor-state";

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
  test("a fresh draft has not been applied", () => {
    render(<StatusChip state={initialEditorState()} />);
    expect(screen.getByText("Draft not applied")).toBeTruthy();
  });

  test("applying a new draft reports that it was never saved", () => {
    const applied = reduce({ ...initialEditorState(), briefId: "camp" }, { type: "apply" });
    render(<StatusChip state={applied} />);
    expect(screen.getByText("Applied, never saved")).toBeTruthy();
  });

  test("a loaded brief that is applied and saved is green", () => {
    const state = reduce(
      initialEditorState(),
      { type: "load", brief: saved(), entry: { file: "camp.yaml", revision: "r1" } },
      { type: "save" },
      { type: "apply" },
    );
    render(<StatusChip state={state} />);
    expect(screen.getByText("Saved & applied")).toBeTruthy();
  });

  test("editing after a save reports unsaved edits", () => {
    const state = reduce(
      initialEditorState(),
      { type: "load", brief: saved(), entry: { file: "camp.yaml", revision: "r1" } },
      { type: "save" },
      { type: "apply" },
      { type: "patch", patch: { campaignMessage: "Changed" } },
    );
    render(<StatusChip state={state} />);
    expect(screen.getByText("Applied, unsaved edits")).toBeTruthy();
  });
});
