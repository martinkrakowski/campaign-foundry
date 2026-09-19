import { describe, test, expect, vi, afterEach } from "vitest";
import { revealField, revealSection } from "../scroll-to-section";

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
    const [first, second] = mount(
      '<section data-section="policy"></section><section data-section="policy"></section>',
    );
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

describe("revealField (PE1)", () => {
  /** Three product rows, in the order the operator reads them. */
  const threeRows = () =>
    mount(
      '<section id="products">' +
        '<div data-field-key="product-0-name"><input id="c0n" /></div>' +
        '<div data-field-key="product-0-id"><input id="c0i" /></div>' +
        '<div data-field-key="product-1-id"><input id="c1i" /></div>' +
        '<div data-field-key="product-2-id"><input id="c2i" /></div>' +
        "</section>",
    );

  test("lands on the failing field and focuses its control, not the wrapper", () => {
    threeRows();
    const wrapper = document.querySelector<HTMLElement>('[data-field-key="product-1-id"]')!;
    wrapper.scrollIntoView = vi.fn();
    expect(revealField("products", new Set(["product-1-id"]))).toBe("product-1-id");
    expect(wrapper.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    // The wrapper is a div and cannot take focus; the input inside it can.
    expect(document.activeElement?.id).toBe("c1i");
  });

  /**
   * The claim that makes this function worth having. `FieldErrors` is a
   * `Record` and a `Set` built from it carries the validator's append order,
   * not the form's — so the keys are handed over "wrong" on purpose here. An
   * implementation that read the first key it was given lands on row 2; reading
   * order says row 0.
   */
  test("picks the first field in DOCUMENT order, not the first key it was handed", () => {
    threeRows();
    const keys = new Set(["product-2-id", "product-0-id"]);
    expect([...keys][0]).toBe("product-2-id");
    expect(revealField("products", keys)).toBe("product-0-id");
    expect(document.activeElement?.id).toBe("c0i");
  });

  test("an error naming no rendered field returns null and moves nothing", () => {
    threeRows();
    expect(revealField("products", new Set(["products"]))).toBeNull();
    expect(document.activeElement?.id).not.toBe("c0i");
  });

  test("no keys at all is null — a valid draft never searches", () => {
    threeRows();
    expect(revealField("products", new Set())).toBeNull();
  });

  test("a missing section is a no-op, exactly as revealSection is", () => {
    mount("<div></div>");
    expect(revealField("nowhere", new Set(["product-0-id"]))).toBeNull();
  });

  test("a wrapper with nothing focusable still scrolls and must not steal focus", () => {
    const [, keep] = mount(
      '<input id="keep" /><section id="products">' +
        '<div data-field-key="product-0-logo"><p>no control here</p></div>' +
        "</section>",
    );
    const anchor = document.getElementById("keep") as HTMLInputElement;
    anchor.focus();
    const wrapper = document.querySelector<HTMLElement>('[data-field-key="product-0-logo"]')!;
    wrapper.scrollIntoView = vi.fn();
    expect(revealField("products", new Set(["product-0-logo"]))).toBe("product-0-logo");
    expect(wrapper.scrollIntoView).toHaveBeenCalled();
    // H2: focus must never end up on `document.body`. Nothing focusable inside
    // the wrapper means the caller's handoff stands, untouched.
    expect(document.activeElement).toBe(anchor);
    expect(keep).toBeDefined();
  });

  test("of two laid-out copies of a field, prefers the one the browser shows", () => {
    mount(
      '<aside><section data-section="products">' +
        '<div data-field-key="product-0-id"><input id="hiddenInput" /></div>' +
        "</section></aside>" +
        '<div role="dialog"><section data-section="products">' +
        '<div data-field-key="product-0-id"><input id="shownInput" /></div>' +
        "</section></div>",
    );
    const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-section]"));
    notLaidOut(sections[0]!);
    laidOut(sections[1]!);
    for (const w of document.querySelectorAll<HTMLElement>("[data-field-key]")) {
      w.scrollIntoView = vi.fn();
    }
    expect(revealField("products", new Set(["product-0-id"]))).toBe("product-0-id");
    expect(document.activeElement?.id).toBe("shownInput");
  });
});
