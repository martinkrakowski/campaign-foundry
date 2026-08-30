import { describe, test, expect, vi, afterEach } from "vitest";
import { revealSection } from "../scroll-to-section";

const mount = (html: string) => {
  document.body.innerHTML = html;
  return Array.from(document.body.querySelectorAll<HTMLElement>("[data-section], [id]"));
};
// happy-dom does no layout, so say explicitly which copy the browser would have laid out
const laidOut = (el: HTMLElement) => {
  el.getClientRects = () => [{}] as unknown as DOMRectList;
};
const notLaidOut = (el: HTMLElement) => {
  el.getClientRects = () => [] as unknown as DOMRectList;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("revealSection", () => {
  test("scrolls a column section by id", () => {
    const [el] = mount('<section id="identity"></section>');
    el.scrollIntoView = vi.fn();
    revealSection("identity");
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  test("of two bar copies, scrolls the one that is laid out — not the hidden desktop one", () => {
    const [hidden, visible] = mount(
      '<aside class="hidden"><section data-section="output"></section></aside>' +
        '<div role="dialog"><section data-section="output"></section></div>',
    );
    hidden.scrollIntoView = vi.fn();
    visible.scrollIntoView = vi.fn();
    notLaidOut(hidden);
    laidOut(visible);
    revealSection("output");
    expect(visible.scrollIntoView).toHaveBeenCalled();
    expect(hidden.scrollIntoView).not.toHaveBeenCalled();
  });

  test("falls back to the first copy when layout says nothing (test DOM, print)", () => {
    const [first, second] = mount('<section data-section="policy"></section><section data-section="policy"></section>');
    first.scrollIntoView = vi.fn();
    second.scrollIntoView = vi.fn();
    notLaidOut(first);
    notLaidOut(second);
    revealSection("policy");
    expect(first.scrollIntoView).toHaveBeenCalled();
  });

  test("a missing section is a no-op", () => {
    mount("<div></div>");
    expect(() => revealSection("nowhere")).not.toThrow();
  });
});
