import { describe, test, expect } from "vitest";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { render, screen } from "@testing-library/react";
import config from "../../../../tailwind.config";
import { StepFooter } from "../StepFooter";
import * as messages from "../messages";

const footer = (over: { readyKey?: number; nudgeKey?: number; onNext?: boolean } = {}) =>
  render(
    <StepFooter
      statusText={messages.statusStepReady}
      {...(over.onNext === false ? {} : { onNext: () => {} })}
      nudgeKey={over.nudgeKey ?? 0}
      readyKey={over.readyKey ?? 0}
    />,
  );

/** The Next button's ring wrapper — the element the ready count is mounted on. */
const ring = () => document.querySelector("footer > div > span");

describe("StepFooter", () => {
  test("an untouched step wears no ring", () => {
    footer({ readyKey: 0 });
    expect(ring()?.className).not.toContain("animate-ready-ring");
  });

  test("the ring is worn once the step has become complete", () => {
    footer({ readyKey: 1 });
    expect(ring()?.className).toContain("animate-ready-ring");
  });

  test("the ring is replayed by a new count, and not by a render that keeps it", () => {
    const { rerender } = footer();
    const plain = ring();
    // A second transition into complete: a remount is what replays the animation.
    rerender(
      <StepFooter statusText={messages.statusStepReady} onNext={() => {}} nudgeKey={0} readyKey={1} />,
    );
    expect(ring()?.className).toContain("animate-ready-ring");
    expect(ring()).not.toBe(plain);

    // The same count again — every render of a step that stays complete — leaves
    // the node alone, so the CSS one-shot is not restarted.
    const rung = ring();
    rerender(
      <StepFooter statusText={messages.statusStepReady} onNext={() => {}} nudgeKey={0} readyKey={1} />,
    );
    expect(ring()).toBe(rung);
  });

  test("the refusal nudge rides the Next label, and only once it has been refused", () => {
    const { rerender } = footer();
    const label = () => screen.getByRole("button", { name: messages.stepNext }).querySelector("span");
    expect(label()?.className).not.toContain("animate-nudge");
    const untouched = label();

    rerender(
      <StepFooter statusText={messages.briefId} onNext={() => {}} nudgeKey={1} readyKey={0} />,
    );
    expect(label()?.className).toContain("animate-nudge");
    // Keyed, so a second refusal is a fresh element that plays the shake again.
    expect(label()).not.toBe(untouched);
  });

  test("the review step has no Next, and nothing to ring", () => {
    footer({ onNext: false, readyKey: 3 });
    expect(screen.queryByRole("button", { name: messages.stepNext })).toBeNull();
    expect(document.querySelector(".animate-ready-ring")).toBeNull();
  });

  test("the swipe hint is painted on coarse pointers only", () => {
    footer();
    const hint = screen.getByText(messages.stepSwipeHint);
    // A mouse cannot swipe, so the sentence is not on screen to promise one. The
    // media query is the whole mechanism — there is no JS pointer sniffing.
    expect(hint.className).toContain("hidden");
    expect(hint.className).toContain("[@media(pointer:coarse)]:block");
  });
});

/** A hint class that emits no CSS would leave the sentence either always hidden or
 *  always shown, and nothing in the suite would notice. */
describe("the swipe hint's utilities emit", () => {
  test("hidden, and the coarse-pointer block that overrides it", async () => {
    const html = `<p class="hidden [@media(pointer:coarse)]:block"></p>`;
    const result = await postcss([
      tailwindcss({ ...config, content: [{ raw: html, extension: "html" }] }),
    ]).process("@tailwind utilities;", { from: undefined });
    // The media rule has to come after `.hidden` in the sheet, or a coarse pointer
    // inherits `display: none` from the very class it is meant to override.
    expect(result.css).toContain(".hidden");
    expect(result.css).toContain("@media(pointer:coarse)");
    expect(result.css.indexOf("@media(pointer:coarse)")).toBeGreaterThan(
      result.css.indexOf(".hidden"),
    );
    expect(result.css).toContain("display: block");
  });
});
