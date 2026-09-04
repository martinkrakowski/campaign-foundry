import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EMPTY_REPORT, json, mockPipelineApi } from "@/__tests__/helpers";
import * as messages from "@/components/campaign/messages";
import { StartFromExistingPicker } from "../StartFromExistingPicker";

const classic = { file: "summer-spark.yaml", brief: { id: "summer-spark", targetRegion: "EU", products: [{ id: "a" }, { id: "b" }] } };
const randomized = {
  file: "winter-wild.yaml",
  brief: {
    id: "winter-wild",
    mode: "variation",
    targetRegion: "DE",
    products: [{ id: "a" }],
    treatments: [{ id: "t1" }, { id: "t2" }, { id: "t3" }],
  },
};

const route = (briefs: unknown[]) =>
  mockPipelineApi({
    result: (url) => (url.includes("/campaigns/briefs") ? json({ briefs }) : json(EMPTY_REPORT)),
  });

beforeEach(() => {
  localStorage.clear();
});

describe("StartFromExistingPicker (W2 / D71)", () => {
  test("lists the store's briefs with the row shape the brief picker derives — id, counts, region", async () => {
    route([classic, randomized]);
    render(<StartFromExistingPicker selectedId={null} onSelect={vi.fn()} />);

    expect(await screen.findByText("summer-spark")).toBeTruthy();
    expect(screen.getByText("winter-wild")).toBeTruthy();
    // treatments absent derives to 1; present derives to its length (BriefPicker's rule).
    expect(screen.getByText(messages.startFromRowMeta(2, 1, "EU"))).toBeTruthy();
    expect(screen.getByText(messages.startFromRowMeta(1, 3, "DE"))).toBeTruthy();
  });

  test("the blank row is the default selection, and choosing it hands back no source", async () => {
    const onSelect = vi.fn();
    route([classic]);
    render(<StartFromExistingPicker selectedId={null} onSelect={onSelect} />);
    const blank = await screen.findByRole("button", { name: messages.startFromExistingBlank });
    expect(blank.getAttribute("aria-pressed")).toBe("true");

    await userEvent.setup().click(blank);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  test("choosing a row hands back the id and the mode its copy inherits", async () => {
    const onSelect = vi.fn();
    route([classic, randomized]);
    render(<StartFromExistingPicker selectedId={null} onSelect={onSelect} />);
    const user = userEvent.setup();

    await user.click(await screen.findByText("summer-spark"));
    // An absent mode field means classic behaviour (the domain's own default).
    expect(onSelect).toHaveBeenCalledWith({ id: "summer-spark", mode: "brief" });
    await user.click(screen.getByText("winter-wild"));
    expect(onSelect).toHaveBeenCalledWith({ id: "winter-wild", mode: "variation" });
  });

  test("the chosen row is the pressed one, and only until another choice", async () => {
    route([classic]);
    const { rerender } = render(<StartFromExistingPicker selectedId="summer-spark" onSelect={vi.fn()} />);
    const row = await screen.findByRole("button", { name: /summer-spark/ });
    const blank = screen.getByRole("button", { name: messages.startFromExistingBlank });
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(blank.getAttribute("aria-pressed")).toBe("false");

    rerender(<StartFromExistingPicker selectedId={null} onSelect={vi.fn()} />);
    expect(row.getAttribute("aria-pressed")).toBe("false");
    expect(blank.getAttribute("aria-pressed")).toBe("true");
  });

  test("an empty store is not an error — it says this create will be the first", async () => {
    route([]);
    render(<StartFromExistingPicker selectedId={null} onSelect={vi.fn()} />);

    expect(await screen.findByText(messages.startFromExistingEmpty)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("a failed list shows the error state, not a misleading empty one", async () => {
    mockPipelineApi({
      result: (url) => (url.includes("/campaigns/briefs") ? json({ error: "fail" }, 500) : json(EMPTY_REPORT)),
    });
    render(<StartFromExistingPicker selectedId={null} onSelect={vi.fn()} />);

    expect(await screen.findByText(messages.startFromExistingError)).toBeTruthy();
  });

  test("the loading state holds the list's place while it reads", async () => {
    let release!: () => void;
    const held = new Promise<Response>((resolve) => {
      release = () => resolve(json({ briefs: [classic] }));
    });
    mockPipelineApi({
      result: (url) => (url.includes("/campaigns/briefs") ? held : json(EMPTY_REPORT)),
    });
    const onSelect = vi.fn();
    render(<StartFromExistingPicker selectedId={null} onSelect={onSelect} />);

    expect(screen.getByText(messages.startFromExistingLoading)).toBeTruthy();
    release();
    expect(await screen.findByText("summer-spark")).toBeTruthy();
  });
});
