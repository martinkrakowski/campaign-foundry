import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlatformCard } from "../platform-card";
import { platformProfile } from "@campaignfoundry/Distribution/platform-profiles";

describe("PlatformCard", () => {
  const profile = platformProfile("instagram-feed")!;

  test("renders profile.label on screen, never the raw id (D7 / D18)", () => {
    render(
      <PlatformCard
        profile={profile}
        selected={false}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("Instagram Feed")).toBeTruthy();
    expect(screen.queryByText("instagram-feed")).toBeNull();
  });

  test("uses raw id as accessible name (aria-label) and handles toggle", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(
      <PlatformCard
        profile={profile}
        selected={false}
        onToggle={onToggle}
      />,
    );

    const button = screen.getByRole("button", { name: "instagram-feed" });
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.className).toContain("border-[1.5px]");
    expect(button.className).toContain("border-border");
    expect(button.className).toContain("bg-surface-2");

    // 44px preview tile at rest
    const tile = button.querySelector("span[aria-hidden='true'].size-11");
    expect(tile?.className).toContain("bg-background");
    expect(tile?.className).toContain("text-text-secondary");

    rerender(
      <PlatformCard
        profile={profile}
        selected={true}
        onToggle={onToggle}
      />,
    );

    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.className).toContain("border-brand-primary");
    expect(button.className).toContain("bg-brand-primary/[0.08]");

    // 44px preview tile inverts when pressed
    expect(tile?.className).toContain("bg-brand-primary");
    expect(tile?.className).toContain("text-white");

    // 22px check badge
    const checkBadge = button.querySelector("span[aria-hidden='true'].size-\\[22px\\]");
    expect(checkBadge).toBeTruthy();
    expect(checkBadge?.className).toContain("animate-check-pop");

    await user.click(button);
    expect(onToggle).toHaveBeenCalledWith("instagram-feed");
  });

  test("renders meta and description when provided", () => {
    render(
      <PlatformCard
        profile={profile}
        selected={false}
        onToggle={vi.fn()}
        meta="1:1 · Still"
        description="Requires still images"
      />,
    );

    expect(screen.getByText("1:1 · Still")).toBeTruthy();
    expect(screen.getByText("Requires still images")).toBeTruthy();
  });

  test("respects disabled prop", () => {
    render(
      <PlatformCard
        profile={profile}
        selected={false}
        onToggle={vi.fn()}
        disabled={true}
      />,
    );

    expect((screen.getByRole("button", { name: "instagram-feed" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
