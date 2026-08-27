import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SaveMenu } from "../SaveMenu";

const setup = (over: Partial<Parameters<typeof SaveMenu>[0]> = {}) => {
  const onSaveAndApply = vi.fn();
  const onSaveAs = vi.fn();
  render(
    <div>
      <button type="button">outside</button>
      <SaveMenu disabled={false} saving={false} onSaveAndApply={onSaveAndApply} onSaveAs={onSaveAs} {...over} />
    </div>,
  );
  return { onSaveAndApply, onSaveAs, user: userEvent.setup() };
};

describe("SaveMenu", () => {
  test("opens on click, lists both ways to persist, and closes after a choice", async () => {
    const { user, onSaveAndApply, onSaveAs } = setup();
    const trigger = screen.getByRole("button", { name: /^Save$/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("menuitem", { name: /Save & apply/ }));
    expect(onSaveAndApply).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: /Save as/ }));
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

  test("is held back while disabled or saving", async () => {
    const { user } = setup({ disabled: true });
    const trigger = screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement;
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
