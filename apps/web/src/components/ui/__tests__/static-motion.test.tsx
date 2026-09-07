import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { PosterFrame } from "../poster-frame";
import { PosterStack } from "../poster-stack";
import { PreviewPanel } from "../preview-panel";
import { ScrubBar } from "../scrub-bar";

/**
 * The static-motion contract (§2.2, D88/D96): the previews that replace the
 * mockup's loops must not animate by any route. `globals-motion.test.ts` can
 * only see `globals.css`; the stock Tailwind `animate-*` utilities live in the
 * framework's own CSS, so this scan reads each rendered className instead.
 */
function classesOf(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("*")).flatMap((element) =>
    typeof element.className === "string" ? element.className.split(/\s+/) : [],
  );
}

describe("no preview component carries an animate- class (D88)", () => {
  for (const [name, element] of [
    ["PosterFrame", <PosterFrame key="pf" ratio="9:16" variant="pB" />],
    ["PosterStack", <PosterStack key="ps" />],
    ["PreviewPanel", <PreviewPanel key="pv" dimmed caption="6 creatives"><span /></PreviewPanel>],
    ["ScrubBar", <ScrubBar key="sb" />],
  ] as const) {
    test(`${name} renders no animate-* class`, () => {
      const { container } = render(element);
      const offenders = classesOf(container).filter((cls) => cls.includes("animate-"));
      expect(offenders).toEqual([]);
    });
  }
});
