import { describe, test, expect } from "vitest";
import { useState, type ReactNode } from "react";
import { render, act, fireEvent, screen } from "@testing-library/react";
import { PlayheadHost } from "../BriefEditor";
import type { PlayheadState } from "../PreviewDock";

/**
 * CC5 — the playhead's owner, on its own.
 *
 * The lane's cost criterion (the plan's §4 acceptance (b)) is not "it looks
 * smooth": a second that moves on every pointermove must not re-render the
 * editor's step form. `BriefEditor` has no memo boundary of its own —
 * `renderStepCard` builds the form inline and no section is `memo`-wrapped — so
 * the mechanism that makes this true is the one asserted here: the main column
 * reaches this component as an ELEMENT (`children`), so when a scrub re-renders
 * the host, React sees `oldProps === newProps` for that child and skips the
 * subtree. `brief-editor.playhead.test.tsx` pins the same property through the
 * real editor; this file pins the mechanism in isolation, where a failure names
 * its own cause.
 */

/** Counts its own renders, so "did this subtree re-render" is a number. */
function Counter({ label, onRender }: { label: string; onRender: () => void }): ReactNode {
  onRender();
  return <span data-testid={label} />;
}

describe("PlayheadHost — the element-identity bailout (CC5, plan §4 (b))", () => {
  test("a scrub re-renders the rail slot and NOT the children element", () => {
    let mainRenders = 0;
    let railRenders = 0;
    let live: PlayheadState | undefined;

    render(
      <PlayheadHost
        durationSec={6}
        rail={(playhead) => {
          live = playhead;
          return <Counter label="rail" onRender={() => (railRenders += 1)} />;
        }}
      >
        <Counter label="main" onRender={() => (mainRenders += 1)} />
      </PlayheadHost>,
    );

    expect(mainRenders).toBe(1);
    expect(railRenders).toBe(1);

    // One pointermove's worth of live value.
    act(() => live!.onScrubLive(2));
    expect(live!.scrubSec).toBe(2);
    // The rail must redraw — the thumb and the diamond follow the live second.
    expect(railRenders).toBe(2);
    // The main column must not. This is the whole cost criterion.
    expect(mainRenders).toBe(1);

    // A whole drag, not one event: the property has to hold per frame.
    act(() => {
      live!.onScrubLive(3);
    });
    act(() => {
      live!.onScrubLive(4);
    });
    act(() => {
      live!.onScrubLive(5);
    });
    expect(railRenders).toBe(5);
    expect(mainRenders).toBe(1);

    // A commit is a state change too, and must not wake the form either.
    act(() => live!.onScrubCommit(5));
    expect(mainRenders).toBe(1);
  });

  test("both callbacks are referentially stable across a scrub", () => {
    let live: PlayheadState | undefined;
    const seen: PlayheadState[] = [];
    render(
      <PlayheadHost
        durationSec={6}
        rail={(playhead) => {
          live = playhead;
          seen.push(playhead);
          return null;
        }}
      >
        {null}
      </PlayheadHost>,
    );
    act(() => live!.onScrubLive(1));
    act(() => live!.onScrubCommit(2));

    expect(seen.length).toBe(3);
    // A fresh function per render would allocate a new prop on every keystroke and
    // defeat the `memo` boundary CC1/CC2 built, through a new component (plan §5).
    expect(seen[1].onScrubLive).toBe(seen[0].onScrubLive);
    expect(seen[2].onScrubLive).toBe(seen[0].onScrubLive);
    expect(seen[1].onScrubCommit).toBe(seen[0].onScrubCommit);
    expect(seen[2].onScrubCommit).toBe(seen[0].onScrubCommit);
  });

  test("a commit moves BOTH seconds, so the thumb does not jump back", () => {
    let live: PlayheadState | undefined;
    render(
      <PlayheadHost
        durationSec={6}
        rail={(playhead) => {
          live = playhead;
          return null;
        }}
      >
        {null}
      </PlayheadHost>,
    );
    act(() => live!.onScrubLive(4));
    expect(live!.scrubSec).toBe(4);
    expect(live!.committedSec).toBe(0);

    // A ±1 s nudge or a ruler click commits a second the thumb never visited.
    act(() => live!.onScrubCommit(2));
    expect(live!.committedSec).toBe(2);
    expect(live!.scrubSec).toBe(2);
  });
});

describe("PlayheadHost — the clamp lives with the owner", () => {
  /** The duration axis, as a control a test can shorten the way the editor does. */
  function Shrinkable(): ReactNode {
    const [durationSec, setDurationSec] = useState(10);
    return (
      <PlayheadHost
        durationSec={durationSec}
        rail={(playhead) => (
          <>
            <output data-testid="live">{playhead.scrubSec}</output>
            <output data-testid="committed">{playhead.committedSec}</output>
            <button type="button" onClick={() => playhead.onScrubCommit(9)}>
              commit 9
            </button>
            <button type="button" onClick={() => setDurationSec(5)}>
              shorten
            </button>
          </>
        )}
      >
        {null}
      </PlayheadHost>
    );
  }

  test("a shortened duration axis re-clamps a second already committed past its end", () => {
    render(<Shrinkable />);
    fireEvent.click(screen.getByRole("button", { name: "commit 9" }));
    expect(screen.getByTestId("committed").textContent).toBe("9");

    fireEvent.click(screen.getByRole("button", { name: "shorten" }));
    // Not 9: `usePreviewFrame` would ask the route for a frame past the end of
    // the clip, and the route refuses `atSec > durationSec` with a 400 — the
    // preview would fall back to the placeholder for a brief that draws fine.
    expect(screen.getByTestId("committed").textContent).toBe("5");
    expect(screen.getByTestId("live").textContent).toBe("5");
  });

  test("a duration axis of zero clamps to zero rather than inverting the range", () => {
    let live: PlayheadState | undefined;
    render(
      <PlayheadHost
        durationSec={0}
        rail={(playhead) => {
          live = playhead;
          return null;
        }}
      >
        {null}
      </PlayheadHost>,
    );
    act(() => live!.onScrubCommit(4));
    // `Math.max(0, durationSec)` is what keeps the ceiling from falling below the
    // floor: without it a negative axis would clamp UP to a negative second.
    expect(live!.committedSec).toBe(0);
    expect(live!.scrubSec).toBe(0);
  });

  test("a negative second is clamped to the start of the clip", () => {
    let live: PlayheadState | undefined;
    render(
      <PlayheadHost
        durationSec={6}
        rail={(playhead) => {
          live = playhead;
          return null;
        }}
      >
        {null}
      </PlayheadHost>,
    );
    act(() => live!.onScrubLive(-3));
    expect(live!.scrubSec).toBe(0);
  });
});
