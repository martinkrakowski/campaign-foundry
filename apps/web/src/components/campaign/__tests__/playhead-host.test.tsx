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
 * `renderStepCard` builds the form inline and no section is `memo`-wrapped.
 *
 * **RS2 changed the mechanism that makes this true, and this file says how.**
 * This component used to take the editor's main column as `children` and rely on
 * React's element-identity bailout to skip it during a scrub, which is what the
 * first test below asserted. The rail is a shell column now, published through
 * `useEditorPanels`, so this component is mounted inside the rail's own aside and
 * the form is not in its subtree at all. **What stops being true:** "the main
 * column is an element prop of the playhead's owner and bails out per frame."
 * **What replaces it:** the form cannot re-render for a scrub because it is not
 * under the owner — a stronger form of the same property, and the reason
 * `children` is gone rather than kept for tests. The measurement did not move:
 * `brief-editor.playhead.test.tsx` counts the form's renders across a five-frame
 * drag through the editor that ships and expects zero, and
 * `rail-in-shell.test.tsx` re-proves it in the published shape.
 *
 * What this file still owns is the other half — that the rail slot IS re-invoked
 * per frame (a bail that froze the thumb would satisfy "the form did not
 * re-render" perfectly), and the identity contract the `memo`-wrapped dock
 * depends on.
 */

/** Counts its own renders, so "did this subtree re-render" is a number. */
function Counter({ label, onRender }: { label: string; onRender: () => void }): ReactNode {
  onRender();
  return <span data-testid={label} />;
}

describe("PlayheadHost — the rail redraws per frame (CC5, plan §4 (b))", () => {
  test("a scrub re-invokes the rail slot once per frame, and a commit too", () => {
    let railRenders = 0;
    let live: PlayheadState | undefined;

    render(
      <PlayheadHost
        durationSec={6}
        rail={(playhead) => {
          live = playhead;
          return <Counter label="rail" onRender={() => (railRenders += 1)} />;
        }}
      />,
    );

    expect(railRenders).toBe(1);

    // One pointermove's worth of live value.
    act(() => live!.onScrubLive(2));
    expect(live!.scrubSec).toBe(2);
    // The rail must redraw — the thumb and the diamond follow the live second.
    // This is the liveness half: without it, "nothing else re-rendered" would be
    // satisfied by a surface that had stopped following the drag.
    expect(railRenders).toBe(2);

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

    // A commit is a state change too, and the surfaces follow it as well.
    act(() => live!.onScrubCommit(4));
    expect(live!.committedSec).toBe(4);
    expect(railRenders).toBe(6);
  });

  test("a re-render that changes no second hands the surfaces the SAME playhead object", () => {
    /**
     * `PreviewDock` is `memo`-wrapped and takes the whole object as one prop, so
     * a fresh literal per render fails its shallow compare on every keystroke —
     * re-opening the RE-RENDER half of CC1/CC2's contract while the fetch-count
     * proofs stay green (usePreviewFrame has a content key of its own) and the
     * tape stays green too (it is handed primitives, not this object).
     */
    const seen: PlayheadState[] = [];
    function Outer(): ReactNode {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setTick(tick + 1)}>
            unrelated
          </button>
          <PlayheadHost
            durationSec={6}
            rail={(playhead) => {
              seen.push(playhead);
              return null;
            }}
          />
        </>
      );
    }
    render(<Outer />);
    // Index-free: the clamp effect's same-value write costs one extra render
    // pass at mount. What matters is the object across the edit, not how many
    // times the slot was invoked.
    const atMount = seen.length;
    const before = seen[atMount - 1];
    fireEvent.click(screen.getByRole("button", { name: "unrelated" }));
    expect(seen.length).toBeGreaterThan(atMount);
    expect(seen[seen.length - 1]).toBe(before);

    // And a scrub DOES hand a new one — the sibling proof that the memo is not
    // simply frozen. A stale object here would leave the thumb where it was.
    act(() => before.onScrubLive(3));
    const after = seen[seen.length - 1];
    expect(after).not.toBe(before);
    expect(after.scrubSec).toBe(3);
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
      />,
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
      />,
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
            <button type="button" onClick={() => setDurationSec(10)}>
              lengthen
            </button>
          </>
        )}
      />
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

  test("a LENGTHENED axis does not revive the second the shrink clamped away", () => {
    // Clamping only on read leaves state and view out of step, and the divergence
    // is not harmless: the untouched 9 reappears when the axis grows back, so the
    // playhead jumps to a second the operator last chose two axis changes ago and
    // the preview fetches that frame — with no gesture anywhere in between.
    render(<Shrinkable />);
    fireEvent.click(screen.getByRole("button", { name: "commit 9" }));
    expect(screen.getByTestId("committed").textContent).toBe("9");

    fireEvent.click(screen.getByRole("button", { name: "shorten" }));
    expect(screen.getByTestId("committed").textContent).toBe("5");

    fireEvent.click(screen.getByRole("button", { name: "lengthen" }));
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
      />,
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
      />,
    );
    act(() => live!.onScrubLive(-3));
    expect(live!.scrubSec).toBe(0);
  });
});
