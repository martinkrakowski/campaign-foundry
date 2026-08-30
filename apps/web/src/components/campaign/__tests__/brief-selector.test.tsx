import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BriefSelector } from "../BriefSelector";
import type { BriefEntry } from "@/lib/briefs-api";

const entry = (id: string): BriefEntry =>
  ({ file: `${id}.yaml`, brief: { id }, revision: `rev-${id}` }) as unknown as BriefEntry;

const briefs = [entry("alpha"), entry("beta"), entry("gamma")];

describe("BriefSelector", () => {
  test("shows the current brief's id, or a placeholder when none is loaded", () => {
    const { unmount } = render(
      <BriefSelector briefs={briefs} currentId="beta" onSelect={vi.fn()} onCreateNew={vi.fn()} />,
    );
    expect(screen.getByText("beta")).toBeTruthy();
    unmount();

    render(<BriefSelector briefs={briefs} currentId={undefined} onSelect={vi.fn()} onCreateNew={vi.fn()} />);
    expect(screen.getAllByText("New brief...").length).toBeGreaterThan(0);
  });

  test("the trigger opens and closes the list", async () => {
    const user = userEvent.setup();
    render(<BriefSelector briefs={briefs} currentId="beta" onSelect={vi.fn()} onCreateNew={vi.fn()} />);

    // Once open, "beta" labels both the trigger and its row in the list; the trigger is first.
    const trigger = () => screen.getAllByText("beta")[0];
    expect(screen.queryByPlaceholderText("Search briefs...")).toBeNull();
    await user.click(trigger());
    expect(screen.getByPlaceholderText("Search briefs...")).toBeTruthy();
    await user.click(trigger());
    expect(screen.queryByPlaceholderText("Search briefs...")).toBeNull();
  });

  test("lists every brief and marks the current one", async () => {
    const user = userEvent.setup();
    render(<BriefSelector briefs={briefs} currentId="beta" onSelect={vi.fn()} onCreateNew={vi.fn()} />);
    await user.click(screen.getByText("beta"));

    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("gamma")).toBeTruthy();
    expect(screen.getByText("current")).toBeTruthy();
  });

  test("selecting a brief reports it and closes the list", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<BriefSelector briefs={briefs} currentId="beta" onSelect={onSelect} onCreateNew={vi.fn()} />);
    await user.click(screen.getByText("beta"));
    await user.click(screen.getByText("gamma"));

    expect(onSelect).toHaveBeenCalledWith(briefs[2]);
    expect(screen.queryByPlaceholderText("Search briefs...")).toBeNull();
  });

  test("creating a new brief reports it and closes the list", async () => {
    const user = userEvent.setup();
    const onCreateNew = vi.fn();
    render(<BriefSelector briefs={briefs} currentId="beta" onSelect={vi.fn()} onCreateNew={onCreateNew} />);
    await user.click(screen.getByText("beta"));
    await user.click(screen.getByText("New brief..."));

    expect(onCreateNew).toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("Search briefs...")).toBeNull();
  });

  test("the search box filters case-insensitively and reports when nothing matches", async () => {
    const user = userEvent.setup();
    render(<BriefSelector briefs={briefs} currentId="beta" onSelect={vi.fn()} onCreateNew={vi.fn()} />);
    await user.click(screen.getByText("beta"));

    await user.type(screen.getByPlaceholderText("Search briefs..."), "AL");
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.queryByText("gamma")).toBeNull();

    await user.clear(screen.getByPlaceholderText("Search briefs..."));
    await user.type(screen.getByPlaceholderText("Search briefs..."), "zzz");
    expect(screen.getByText("No briefs found")).toBeTruthy();
  });

  test("the filter field is the kit input, named by the same words as its placeholder", async () => {
    const user = userEvent.setup();
    render(<BriefSelector briefs={briefs} currentId="beta" onSelect={vi.fn()} onCreateNew={vi.fn()} />);
    await user.click(screen.getByText("beta"));

    const field = screen.getByLabelText("Search briefs...");
    // A placeholder is a hint, not a name (DESIGN.md §7), and the kit's input brings
    // the focus halo this field used to hand-roll at a different width.
    expect(field.className).toContain("focus:ring-brand-primary/25");
    expect(field.getAttribute("placeholder")).toBe("Search briefs...");
  });

  test("an empty search shows no not-found message", async () => {
    const user = userEvent.setup();
    render(<BriefSelector briefs={[]} currentId={undefined} onSelect={vi.fn()} onCreateNew={vi.fn()} />);
    await user.click(screen.getAllByText("New brief...")[0]);
    expect(screen.queryByText("No briefs found")).toBeNull();
  });

  test("the search box is cleared after a selection", async () => {
    const user = userEvent.setup();
    render(<BriefSelector briefs={briefs} currentId="beta" onSelect={vi.fn()} onCreateNew={vi.fn()} />);
    await user.click(screen.getByText("beta"));
    await user.type(screen.getByPlaceholderText("Search briefs..."), "alp");
    await user.click(screen.getByText("alpha"));

    await user.click(screen.getByText("beta"));
    expect((screen.getByPlaceholderText("Search briefs...") as HTMLInputElement).value).toBe("");
  });
});
