import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SaveMenu } from "../SaveMenu";

const setup = (over: Partial<Parameters<typeof SaveMenu>[0]> = {}) => {
  const onSave = vi.fn();
  const onSaveAs = vi.fn();
  render(
    <div>
      <button type="button">outside</button>
      <SaveMenu saving={false} onSave={onSave} onSaveAs={onSaveAs} {...over} />
    </div>,
  );
  return { onSave, onSaveAs, user: userEvent.setup() };
};

describe("SaveMenu", () => {
  test("opens on click, lists both ways to persist, and closes after a choice", async () => {
    const { user, onSave, onSaveAs } = setup();
    const trigger = screen.getByRole("button", { name: /^Save$/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // D35: the items are "Save" and "Save as…" — "Save & apply" is gone, because both
    // items already commit the brief and saying so twice was the confusion.
    await user.click(screen.getByRole("menuitem", { name: /^Save(?!\s*as)/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: /^Save as/ }));
    expect(onSaveAs).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("a second click on the trigger closes it", async () => {
    const { user } = setup();
    const trigger = screen.getByRole("button", { name: /^Save$/ });
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("Escape and a click outside both close it; a click inside does not", async () => {
    const { user } = setup();
    const trigger = screen.getByRole("button", { name: /^Save$/ });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(trigger);
    await user.click(screen.getByRole("menu")); // inside: stays open
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.keyboard("a"); // an unrelated key: stays open
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.click(screen.getByText("outside"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("stays open to an invalid draft — the refusal is the menu item's job (D3)", async () => {
    const { user } = setup({});
    const trigger = screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  test("is held back only while a write is in flight", async () => {
    // while saving the trigger wears a busy label, so find it by its popup role
    const { user } = setup({ saving: true });
    const trigger = screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("aria-haspopup") === "menu") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    await user.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("shows the busy state while saving", () => {
    setup({ saving: true });
    const trigger = screen.getAllByRole("button").find((b) => b.getAttribute("aria-haspopup") === "menu") as HTMLButtonElement;
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(trigger.disabled).toBe(true);
  });
});
