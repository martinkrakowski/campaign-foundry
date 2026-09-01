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
      {/* Something for Tab to land on after the trigger, so the tests can prove
          the menu lets the browser move focus on rather than trapping it. */}
      <button type="button">after</button>
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

  // Keyboard contract (APG menu button). The mouse path — open with focus staying
  // on the trigger — is today's behaviour and stays that way.
  test("opening with the mouse leaves focus on the trigger", async () => {
    const { user } = setup();
    await user.click(trigger());
    expect(document.activeElement).toBe(trigger());
  });

  test("ArrowDown on the trigger opens onto the first item, which is out of the tab order", async () => {
    const { user } = setup();
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
    // Roving focus: Tab is reserved for leaving the menu, so the items are only
    // reachable through the arrow keys.
    expect(screen.getAllByRole("menuitem").map((i) => i.getAttribute("tabindex"))).toEqual(["-1", "-1"]);
  });

  test("ArrowUp on the trigger opens onto the last item", async () => {
    const { user } = setup();
    trigger().focus();
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[1]);
  });

  test("Enter and Space on the trigger open onto the first item", async () => {
    const { user } = setup();
    trigger().focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);

    await user.keyboard("{Escape}");
    trigger().focus();
    await user.keyboard("[Space]");
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
  });

  test("Enter or Space on the trigger of an open menu closes it back onto the trigger", async () => {
    const { user } = setup();
    await user.click(trigger());
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());

    await user.click(trigger());
    await user.keyboard("[Space]");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  test("ArrowDown moves through the items and wraps from the last back to the first", async () => {
    const { user } = setup();
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    const [first, second] = screen.getAllByRole("menuitem");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(second);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(first);
  });

  test("ArrowUp moves back through the items and wraps from the first to the last", async () => {
    const { user } = setup();
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    const last = screen.getAllByRole("menuitem")[1];
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(last);
  });

  test("Home and End jump to the first and last item", async () => {
    const { user } = setup();
    trigger().focus();
    await user.keyboard("{ArrowUp}"); // opens onto the last item
    const [first, last] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(last);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(first);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(last);
  });

  test("Tab closes the menu and lets the browser move focus on", async () => {
    const { user } = setup();
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.queryByRole("menu")).toBeTruthy();
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).toBeNull();
    // Focus must leave the vanishing item. user-event computes the Tab destination
    // from the (now unmounted) item and lands on body; a real browser's default
    // action walks on from the restored trigger to the next control.
    const landed = document.activeElement;
    expect(landed === document.body || landed === screen.getByText("after")).toBe(true);
  });
});
