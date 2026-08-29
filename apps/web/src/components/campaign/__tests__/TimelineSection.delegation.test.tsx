import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * The proportion bar must READ the domain, not agree with it.
 *
 * Its sibling test asserts the rendered seconds equal `resolveTimeline`'s. That is a real
 * contract check and it is not enough on its own: a bar that divides the weights itself
 * produces the same numbers for every ordinary timeline, so the assertion passes while the
 * dependency is gone — verified by mutation, which is why this file exists.
 *
 * So this one replaces `resolveTimeline` with windows no weight division could produce and
 * asserts the bar renders THOSE. It fails the moment the component stops delegating,
 * whatever arithmetic it substitutes.
 */
vi.mock("@campaignfoundry/CampaignOrchestration/copy-timeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@campaignfoundry/CampaignOrchestration/copy-timeline")>();
  return {
    ...actual,
    // Two beats, but windows of 10% and 90% — nothing a 1:1 weight split would ever yield.
    resolveTimeline: vi.fn(() => [
      { text: "One", startT: 0, endT: 0.1, fadeInT: 0 },
      { text: "Two", startT: 0.1, endT: 1, fadeInT: 0 },
    ]),
  };
});

const { TimelineSection } = await import("../TimelineSection");
const messages = await import("../messages");
const { initialEditorState } = await import("../editor-state");

describe("the proportion bar delegates to resolveTimeline", () => {
  test("it renders the domain's windows, not its own division of the weights", () => {
    const state = {
      ...initialEditorState(),
      mode: "variation" as const,
      briefId: "camp",
      duration: [10],
      // Equal weights: a bar doing its own arithmetic would show 5.0s and 5.0s.
      timeline: {
        beats: [
          { key: 1, text: "One", weight: 1 },
          { key: 2, text: "Two", weight: 1 },
        ],
        transition: "fade" as const,
        keyBeat: 1,
      },
    };
    render(<TimelineSection state={state} dispatch={vi.fn()} />);

    // The mocked windows over a 10 s clip: 1.0 s and 9.0 s.
    expect(screen.getAllByText(messages.timelineDwell(9)).length).toBeGreaterThan(0);
    // And not the 5.0s / 5.0s a weight split would produce.
    expect(screen.queryByText(messages.timelineDwell(5))).toBeNull();
  });
});
