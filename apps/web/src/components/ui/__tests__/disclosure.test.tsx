import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Disclosure } from "../disclosure";

const open = () => screen.getByRole("button", { name: "Advanced" });

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("Disclosure", () => {
  test("starts closed, and opening it shows the content and says so", async () => {
    const user = userEvent.setup();
    render(
      <Disclosure id="policy" title="Advanced">
        <p>the seed</p>
      </Disclosure>,
    );
    expect(open().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("the seed")).toBeNull();

    await user.click(open());
    expect(open().getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByText("the seed").closest("div") as HTMLElement;
    expect(panel.id).toBe(open().getAttribute("aria-controls"));
  });

  test("remembers that it was opened, per id", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <Disclosure id="policy" title="Advanced">
        <p>the seed</p>
      </Disclosure>,
    );
    await user.click(open());
    unmount();

    render(
      <Disclosure id="policy" title="Advanced">
        <p>the seed</p>
      </Disclosure>,
    );
    expect(open().getAttribute("aria-expanded")).toBe("true");
    // and closing it again forgets, rather than remembering "closed" as a value
    await user.click(open());
    expect(localStorage.getItem("cf:disclosure:policy")).toBeNull();
  });

  test("a different id is remembered separately", async () => {
    const user = userEvent.setup();
    render(
      <Disclosure id="policy" title="Advanced">
        <p>the seed</p>
      </Disclosure>,
    );
    await user.click(open());
    expect(localStorage.getItem("cf:disclosure:policy")).toBe("1");
    expect(localStorage.getItem("cf:disclosure:output")).toBeNull();
  });

  test("no storage at all (the server render) leaves it closed and still toggles", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("localStorage", undefined);
    render(
      <Disclosure id="policy" title="Advanced">
        <p>the seed</p>
      </Disclosure>,
    );
    expect(open().getAttribute("aria-expanded")).toBe("false");
    await user.click(open());
    expect(open().getAttribute("aria-expanded")).toBe("true");
    vi.unstubAllGlobals();
  });

  test("a storage that throws on read leaves it closed rather than breaking the page", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(
      <Disclosure id="policy" title="Advanced">
        <p>the seed</p>
      </Disclosure>,
    );
    expect(open().getAttribute("aria-expanded")).toBe("false");
  });

  test("a storage that throws on write still opens — the choice holds for this render", async () => {
    const user = userEvent.setup();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    render(
      <Disclosure id="policy" title="Advanced">
        <p>the seed</p>
      </Disclosure>,
    );
    await user.click(open());
    expect(open().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("the seed")).toBeTruthy();
  });
});
