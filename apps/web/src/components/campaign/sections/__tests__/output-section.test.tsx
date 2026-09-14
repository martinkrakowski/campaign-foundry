import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OutputSection } from "../OutputSection";
import {
  editorReducer,
  fromBrief,
  initialEditorState,
  toBrief,
  type EditorAction,
  type EditorState,
} from "../../editor-state";
import * as messages from "../../messages";
import { clickDestinationProblem } from "@campaignfoundry/CampaignOrchestration/click-destination";

const state = (over: Partial<EditorState> = {}): EditorState => ({
  ...initialEditorState(),
  ...over,
});

/**
 * The section is controlled. The serialisation claim cannot be observed through
 * a bare `vi.fn()`, so the dispatch runs the real reducer and rerenders — the
 * same harness the Identity section's two-direction claims use.
 */
const renderWithReducer = (initial: EditorState) => {
  let current = initial;
  const dispatch = vi.fn((action: EditorAction) => {
    current = editorReducer(current, action);
    rerender(<OutputSection state={current} dispatch={dispatch} errors={{}} />);
  });
  const { rerender, container } = render(
    <OutputSection state={current} dispatch={dispatch} errors={{}} />,
  );
  return { dispatch, container, getState: () => current };
};

const destinationInput = (): HTMLInputElement =>
  screen.getByLabelText(messages.clickDestinationLabel) as HTMLInputElement;

describe("OutputSection — the click destination (HL5b, HL-D3)", () => {
  test("typing a destination carries it into the serialised brief", async () => {
    const user = userEvent.setup();
    const { getState } = renderWithReducer(state());
    const destination = "https://example.com/landing?utm_source=ad";

    await user.type(destinationInput(), destination);

    expect(getState().clickDestination).toBe(destination);
    expect(toBrief(getState()).clickDestination).toBe(destination);
  });

  test("an invalid destination shows the domain's problem inline", async () => {
    const user = userEvent.setup();
    renderWithReducer(state());

    await user.type(destinationInput(), "not-a-url");

    const problem = clickDestinationProblem("not-a-url");
    expect(problem).toBeDefined();
    // The sentence is the one voice; the decision is the domain's, never a
    // second URL check in the web app.
    expect(screen.getByText(messages.clickDestinationProblem(problem!))).toBeTruthy();
  });

  test("an empty field is valid and emits no clickDestination", () => {
    const { getState } = renderWithReducer(state());

    expect(destinationInput().value).toBe("");
    expect(clickDestinationProblem(undefined)).toBeUndefined();
    expect("clickDestination" in toBrief(getState())).toBe(false);
  });

  test("a loaded brief with a destination shows it in the input", () => {
    const destination = "https://example.com/promo";
    const brief = { ...toBrief(state()), clickDestination: destination };

    renderWithReducer(fromBrief(brief));

    expect(destinationInput().value).toBe(destination);
  });
});