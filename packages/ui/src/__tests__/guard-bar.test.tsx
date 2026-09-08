import { describe, test, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GuardBar } from "../guard-bar";

const THREE_WAY = [
  { label: "Keep editing", onAct: vi.fn() },
  { label: "Start over", onAct: vi.fn(), variant: "destructive" as const },
  { label: "Discard and close", onAct: vi.fn(), variant: "secondary" as const },
];

describe("GuardBar", () => {
  test("the question and its detail read as one labelled group", () => {
    render(
      <GuardBar title="Discard this draft?" detail="A named draft and its answers would be dropped." actions={THREE_WAY.map((a) => ({ ...a, onAct: vi.fn() }))} />,
    );
    // the group's accessible name is the question, via its own title
    expect(screen.getByRole("group", { name: "Discard this draft?" })).toBeTruthy();
    expect(screen.getByText("A named draft and its answers would be dropped.")).toBeTruthy();
  });

  test("without a detail only the question remains", () => {
    const { container } = render(<GuardBar title="Discard this draft?" actions={[]} />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  test("each action renders its own button and reports its press — three answers, not a fixed pair", async () => {
    const user = userEvent.setup();
    const keep = vi.fn();
    const startOver = vi.fn();
    const discard = vi.fn();
    render(
      <GuardBar
        title="Discard this draft?"
        actions={[
          { label: "Keep editing", onAct: keep },
          { label: "Start over", onAct: startOver, variant: "destructive" },
          { label: "Discard and close", onAct: discard },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start over" }));
    expect(startOver).toHaveBeenCalledTimes(1);
    expect(keep).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  test("an answer can be styled as the destructive one", () => {
    render(<GuardBar title="Discard this draft?" actions={[{ label: "Discard and close", onAct: vi.fn(), variant: "destructive" }]} />);
    expect(screen.getByRole("button", { name: "Discard and close" }).className).toContain("bg-error");
  });

  test("while busy the actions hold still and the region says so", () => {
    const onAct = vi.fn();
    render(<GuardBar title="Discard this draft?" busy actions={[{ label: "Discard and close", onAct }]} />);
    const group = screen.getByRole("group", { name: "Discard this draft?" });
    expect(group.getAttribute("aria-busy")).toBe("true");
    const button = screen.getByRole("button", { name: "Discard and close" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onAct).not.toHaveBeenCalled();
  });

  test("a single held answer can be held on its own, without holding the region", () => {
    const held = vi.fn();
    const free = vi.fn();
    render(
      <GuardBar
        title="Start over?"
        actions={[
          { label: "Start over", onAct: held, disabled: true },
          { label: "Keep editing", onAct: free },
        ]}
      />,
    );
    expect(screen.getByRole("group", { name: "Start over?" }).getAttribute("aria-busy")).toBeNull();
    expect((screen.getByRole("button", { name: "Start over" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(held).not.toHaveBeenCalled();
  });

  test("an action inside a form does not submit the form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onAct = vi.fn();
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <GuardBar title="Discard this draft?" actions={[{ label: "Discard", onAct }]} />
      </form>,
    );
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("the guard is a region inside its footer, never a second overlay", () => {
    const { container } = render(<GuardBar title="Discard this draft?" actions={THREE_WAY} />);
    // no scrim, no focus trap surface, no fixed positioning — the dialog around it
    // already owns modality; a fixed inset-0 here is the defect this component
    // exists to avoid (D89 / F4).
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    for (const el of Array.from(container.querySelectorAll("*"))) {
      expect(el.className).not.toContain("fixed");
    }
  });
});
