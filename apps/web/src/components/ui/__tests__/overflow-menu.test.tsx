import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OverflowMenu } from "../overflow-menu";

const setup = (items?: { label: string; onSelect: () => void }[]) => {
  const onSaveAs = vi.fn();
  const onRevert = vi.fn();
  render(
    <div>
      <button type="button">outside</button>
      <OverflowMenu
        label="More actions"
        items={items ?? [
          { label: "Save as…", onSelect: onSaveAs },
          { label: "Revert", onSelect: onRevert },
        ]}
      />
    </div>,
  );
  return { onSaveAs, onRevert, user: userEvent.setup() };
};

const trigger = () => screen.getByRole("button", { name: "More actions" });

describe("OverflowMenu", () => {
  test("opens on the trigger, lists every item, and a second press closes it", async () => {
    const { user } = setup();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Save as…", "Revert"]);

    await user.click(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // The regression #162 shipped: a bare <details> closed ONLY on its own summary, so
  // every one of these paths left the panel hanging open over the content.
  test("Escape closes it", async () => {
    const { user } = setup();
    await user.click(trigger());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("a press outside closes it; one inside, and any other key, do not", async () => {
    const { user } = setup();
    await user.click(trigger());

    await user.click(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.keyboard("a");
    expect(screen.getByRole("menu")).toBeTruthy();

    await user.click(screen.getByText("outside"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("choosing an item runs it and closes the panel behind it", async () => {
    const { user, onSaveAs, onRevert } = setup();
    await user.click(trigger());
    await user.click(screen.getByRole("menuitem", { name: "Save as…" }));

    expect(onSaveAs).toHaveBeenCalledTimes(1);
    expect(onRevert).not.toHaveBeenCalled();
    // The half-fix trap: Escape and outside-click alone still leave the menu
    // standing over whatever the item just opened.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("the panel is already gone by the time the action runs", async () => {
    // `handleRevert` calls window.confirm, which blocks the thread synchronously —
    // under React's ordinary batching the panel would still be painted behind it.
    let menuWhileActing: HTMLElement | null = null;
    const { user } = setup([
      { label: "Revert", onSelect: () => { menuWhileActing = screen.queryByRole("menu"); } },
    ]);
    await user.click(trigger());
    await user.click(screen.getByRole("menuitem", { name: "Revert" }));
    expect(menuWhileActing).toBeNull();
  });

  test("every deliberate close hands focus back to the trigger", async () => {
    const { user } = setup();
    await user.click(trigger());
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger());

    // The item is unmounted by the very click that activates it, so without the
    // restore the keyboard user who chose it lands on document.body — and a dialog
    // opened from here would capture that vanishing item as its focus-return target.
    await user.click(trigger());
    await user.click(screen.getByRole("menuitem", { name: "Revert" }));
    expect(document.activeElement).toBe(trigger());
  });

  test("a press outside closes without stealing focus back", async () => {
    const { user } = setup();
    await user.click(trigger());
    const outside = screen.getByText("outside");
    await user.click(outside);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  test("aria-controls names the panel only while the panel exists", async () => {
    const { user } = setup();
    expect(trigger().getAttribute("aria-controls")).toBeNull();
    await user.click(trigger());
    expect(trigger().getAttribute("aria-controls")).toBe(screen.getByRole("menu").id);
    await user.keyboard("{Escape}");
    expect(trigger().getAttribute("aria-controls")).toBeNull();
  });

  test("the listeners are torn down with the panel", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const { user } = setup();
    await user.click(trigger());
    await user.keyboard("{Escape}");
    const removed = remove.mock.calls.map((c) => c[0]);
    expect(removed).toContain("pointerdown");
    expect(removed).toContain("keydown");
    remove.mockRestore();
  });
});
