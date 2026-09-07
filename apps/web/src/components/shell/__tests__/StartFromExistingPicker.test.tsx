import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EMPTY_REPORT, json, mockPipelineApi } from "@/__tests__/helpers";
import * as messages from "@/components/campaign/messages";
import { modeDisplayName } from "@/components/campaign/display-names";
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
    variation: { axes: { ratio: ["16:9"] } },
  },
};
const unknownRatios = {
  file: "oddbuf.yaml",
  brief: {
    id: "oddbuf",
    mode: "brief",
    targetRegion: "US",
    products: [{ id: "a" }],
    variation: { axes: { ratio: ["4:5"] } },
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

  test("the rail opens with the blank card first, named exactly, and nothing else before it", async () => {
    route([classic]);
    const { container } = render(<StartFromExistingPicker selectedId={null} onSelect={vi.fn()} />);

    const blank = await screen.findByRole("button", { name: messages.startFromExistingBlank });
    const buttons = container.querySelectorAll("button");
    expect(buttons[0]).toBe(blank);
    expect(buttons.length).toBe(2);
  });

  test("each brief card is named by its id alone, carries the mode's display name as its tag", async () => {
    route([classic, randomized]);
    render(<StartFromExistingPicker selectedId={null} onSelect={vi.fn()} />);

    const summer = await screen.findByRole("button", { name: "summer-spark" });
    // A brief with no mode of its own defaults to classic behaviour (the domain's own default).
    expect(within(summer).getByText(modeDisplayName("brief"))).toBeTruthy();
    const winter = screen.getByRole("button", { name: "winter-wild" });
    expect(within(winter).getByText(modeDisplayName("variation"))).toBeTruthy();
  });

  test("the blank card's preview is three dashed empty frames; a brief's shows one frame per known ratio", async () => {
    route([classic, randomized]);
    render(<StartFromExistingPicker selectedId={null} onSelect={vi.fn()} />);

    const blank = await screen.findByRole("button", { name: messages.startFromExistingBlank });
    // happy-dom keeps SVG presentation attributes out of the attribute list, so
    // the dash is counted in the serialised markup instead of via selectors.
    expect((blank.innerHTML.match(/stroke-dasharray/g) ?? []).length).toBe(3);
    // `shrink-0` is `PosterFrame`'s own class; the check badge's svg has none.
    expect(blank.querySelectorAll("svg.shrink-0").length).toBe(3);

    // The brief listed one ratio, so exactly that ratio is drawn.
    const winter = screen.getByRole("button", { name: "winter-wild" });
    expect(winter.querySelectorAll("svg.shrink-0").length).toBe(1);
    expect(within(winter).getByText(messages.startFromRatioCaption(["16:9"]))).toBeTruthy();

    // The brief listed none — the planner's own default, every ratio.
    const summer = screen.getByRole("button", { name: "summer-spark" });
    expect(summer.querySelectorAll("svg.shrink-0").length).toBe(3);
    expect(within(summer).getByText(messages.startFromRatioCaption(["1:1", "9:16", "16:9"]))).toBeTruthy();
  });

  test("a brief whose ratios lie outside the domain falls back to every ratio, not to an empty picture", async () => {
    route([unknownRatios]);
    render(<StartFromExistingPicker selectedId={null} onSelect={vi.fn()} />);

    const odd = await screen.findByRole("button", { name: "oddbuf" });
    expect(odd.querySelectorAll("svg.shrink-0").length).toBe(3);
    expect(within(odd).getByText(messages.startFromRatioCaption(["1:1", "9:16", "16:9"]))).toBeTruthy();
  });

  test("nothing in the rail loops — the only animation class is the exempt check badge (D88/D96)", async () => {
    route([classic]);
    const { container } = render(<StartFromExistingPicker selectedId={null} onSelect={vi.fn()} />);
    await screen.findByRole("button", { name: messages.startFromExistingBlank });

    const animated = container.innerHTML.match(/animate-[a-z-]+/g) ?? [];
    expect(animated.length).toBeGreaterThan(0);
    expect(animated.every((cls) => cls === "animate-check-pop")).toBe(true);
  });

  test("the blank card is the default selection, and choosing it hands back no source", async () => {
    const onSelect = vi.fn();
    route([classic]);
    render(<StartFromExistingPicker selectedId={null} onSelect={onSelect} />);
    const blank = await screen.findByRole("button", { name: messages.startFromExistingBlank });
    expect(blank.getAttribute("aria-pressed")).toBe("true");

    await userEvent.setup().click(blank);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  test("choosing a card hands back the id and the mode its copy inherits", async () => {
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

  test("the chosen card is the pressed one, and only until another choice", async () => {
    route([classic]);
    const { rerender } = render(<StartFromExistingPicker selectedId="summer-spark" onSelect={vi.fn()} />);
    const card = await screen.findByRole("button", { name: /summer-spark/ });
    const blank = screen.getByRole("button", { name: messages.startFromExistingBlank });
    expect(card.getAttribute("aria-pressed")).toBe("true");
    expect(blank.getAttribute("aria-pressed")).toBe("false");

    rerender(<StartFromExistingPicker selectedId={null} onSelect={vi.fn()} />);
    expect(card.getAttribute("aria-pressed")).toBe("false");
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

  test("the loading state holds the rail's place while it reads", async () => {
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
