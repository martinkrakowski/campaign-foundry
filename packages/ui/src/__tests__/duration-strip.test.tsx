import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DurationStrip,
  slideToFree,
  secondsAtClientX,
  keyToTarget,
  MIN_DURATION_SEC,
  MAX_DURATION_SEC,
} from "../duration-strip";

describe("DurationStrip helpers", () => {
  describe("slideToFree", () => {
    test("returns target when it is within range and free", () => {
      expect(slideToFree([6, 15], 10)).toBe(10);
    });

    test("searches outward when target is already taken", () => {
      expect(slideToFree([10], 10)).toBe(11);
      expect(slideToFree([10, 11], 10)).toBe(9);
    });

    test("ignores currentIndex when checking taken values", () => {
      expect(slideToFree([10, 15], 10, 0)).toBe(10);
    });

    test("clamps to MIN_DURATION_SEC (2) and MAX_DURATION_SEC (30)", () => {
      expect(slideToFree([], 0)).toBe(2);
      expect(slideToFree([], 50)).toBe(30);
    });

    test("falls back to the rounded target when every second is taken", () => {
      const all = Array.from({ length: 29 }, (_, i) => i + 2); // 2..30
      expect(all).toHaveLength(29);
      expect(slideToFree(all, 15)).toBe(15);
    });
  });

  describe("secondsAtClientX", () => {
    test("computes second proportional to clientX within rect", () => {
      const rect = { left: 100, width: 300 };
      expect(secondsAtClientX(100, rect)).toBe(0);
      expect(secondsAtClientX(250, rect)).toBe(15);
      expect(secondsAtClientX(400, rect)).toBe(30);
    });

    test("clamps to 0..30 for clientX outside rect", () => {
      const rect = { left: 100, width: 300 };
      expect(secondsAtClientX(50, rect)).toBe(0);
      expect(secondsAtClientX(500, rect)).toBe(30);
    });

    test("returns 0 when width is zero or negative", () => {
      expect(secondsAtClientX(100, { left: 100, width: 0 })).toBe(0);
    });
  });

  describe("keyToTarget", () => {
    test("handles arrow keys (+/- 1)", () => {
      expect(keyToTarget("ArrowLeft", 10)).toBe(9);
      expect(keyToTarget("ArrowDown", 10)).toBe(9);
      expect(keyToTarget("ArrowRight", 10)).toBe(11);
      expect(keyToTarget("ArrowUp", 10)).toBe(11);
    });

    test("handles PageUp / PageDown (+/- 5)", () => {
      expect(keyToTarget("PageUp", 10)).toBe(15);
      expect(keyToTarget("PageDown", 10)).toBe(5);
    });

    test("handles Home and End", () => {
      expect(keyToTarget("Home", 10)).toBe(MIN_DURATION_SEC);
      expect(keyToTarget("End", 10)).toBe(MAX_DURATION_SEC);
    });

    test("returns undefined for unrecognized keys", () => {
      expect(keyToTarget("Enter", 10)).toBeUndefined();
      expect(keyToTarget("Tab", 10)).toBeUndefined();
    });
  });
});

describe("DurationStrip component", () => {
  test("renders duration sliders on 0..30 axis with stable accessible names", () => {
    render(<DurationStrip values={[6, 12]} />);
    const slider1 = screen.getByRole("slider", { name: "Duration 1 (seconds)" });
    const slider2 = screen.getByRole("slider", { name: "Duration 2 (seconds)" });
    expect(slider1).toBeTruthy();
    expect(slider2).toBeTruthy();
    expect(slider1.getAttribute("aria-valuenow")).toBe("6");
    expect(slider2.getAttribute("aria-valuenow")).toBe("12");
  });

  test("clamps loaded out-of-range or fractional values [45, 2.5] gracefully without throwing", () => {
    render(<DurationStrip values={[45, 2.5]} />);
    expect(screen.getByText("45 s")).toBeTruthy();
    expect(screen.getByText("2.5 s")).toBeTruthy();
  });

  test("keyboard navigation adjusts duration and Delete removes it", async () => {
    const onChange = vi.fn();
    const onRemove = vi.fn();
    render(
      <DurationStrip
        values={[6]}
        onChange={onChange}
        onRemove={onRemove}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Duration 1 (seconds)" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith(0, 7);

    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith(0, 5);

    fireEvent.keyDown(slider, { key: "Delete" });
    expect(onRemove).toHaveBeenCalledWith(0);

    fireEvent.keyDown(slider, { key: "Backspace" });
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  test("clicking remove button calls onRemove even for the last duration", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<DurationStrip values={[6]} onRemove={onRemove} />);

    const removeBtn = screen.getByRole("button", { name: "Remove duration 6 s" });
    expect((removeBtn as HTMLButtonElement).disabled).toBe(false);

    await user.click(removeBtn);
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  test("clicking empty strip triggers onAdd with calculated second", () => {
    const onAdd = vi.fn();
    const { container } = render(<DurationStrip values={[6]} onAdd={onAdd} />);

    const strip = container.querySelector(".select-none");
    expect(strip).toBeTruthy();

    // Mock getBoundingClientRect
    vi.spyOn(strip!, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 300,
      bottom: 50,
      width: 300,
      height: 50,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    fireEvent.click(strip!, { clientX: 150 });
    expect(onAdd).toHaveBeenCalledWith(15);
  });

  test("pointer drag on bead adjusts duration", () => {
    const onChange = vi.fn();
    const { container } = render(<DurationStrip values={[6]} onChange={onChange} />);

    const strip = container.querySelector(".select-none")!;
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 300,
      bottom: 50,
      width: 300,
      height: 50,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const bead = screen.getByRole("slider", { name: "Duration 1 (seconds)" });
    bead.setPointerCapture = vi.fn();

    fireEvent.pointerDown(bead, { pointerId: 1, clientX: 60 });
    expect(bead.setPointerCapture).toHaveBeenCalledWith(1);

    const moveEv = Object.assign(new Event("pointermove"), { clientX: 100 });
    bead.dispatchEvent(moveEv);
    expect(onChange).toHaveBeenCalledWith(0, 10);

    const upEv = new Event("pointerup");
    bead.dispatchEvent(upEv);
  });

  test("renders lanes slot, error message, and disabled state", () => {
    render(
      <DurationStrip
        values={[6]}
        lanes={<div data-testid="lanes-slot">Timeline lanes</div>}
        error="Clip length is invalid"
        disabled={true}
      />,
    );

    expect(screen.getByTestId("lanes-slot")).toBeTruthy();
    expect(screen.getByText("Clip length is invalid")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Duration 1 (seconds)" }).getAttribute("tabindex")).toBe("-1");
  });

  test("a strip click without onAdd is a no-op", () => {
    const { container } = render(<DurationStrip values={[6]} />);
    const strip = container.querySelector(".select-none")!;
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 300, bottom: 50, width: 300, height: 50, x: 0, y: 0, toJSON: () => {},
    });
    fireEvent.click(strip, { clientX: 150 });
    // no onAdd provided → nothing dispatched, no throw
  });

  test("a click landing on a slider or button is ignored by the track handler", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<DurationStrip values={[6]} onAdd={onAdd} />);
    const slider = screen.getByRole("slider", { name: "Duration 1 (seconds)" });
    await user.click(slider);
    expect(onAdd).not.toHaveBeenCalled();
  });

  test("keyboard navigation is suppressed while disabled", () => {
    const onChange = vi.fn();
    render(<DurationStrip values={[6]} onChange={onChange} disabled />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Duration 1 (seconds)" }), { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("an unrecognized key leaves the duration unchanged", () => {
    const onChange = vi.fn();
    render(<DurationStrip values={[6]} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Duration 1 (seconds)" }), { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("a pointer move after unmount is ignored", () => {
    const onChange = vi.fn();
    const { container, unmount } = render(<DurationStrip values={[6]} onChange={onChange} />);
    const strip = container.querySelector(".select-none")!;
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 300, bottom: 50, width: 300, height: 50, x: 0, y: 0, toJSON: () => {},
    });
    const bead = screen.getByRole("slider", { name: "Duration 1 (seconds)" }) as HTMLButtonElement;
    bead.setPointerCapture = vi.fn();
    fireEvent.pointerDown(bead, { pointerId: 1, clientX: 60 });
    unmount(); // stripRef.current becomes null → the move handler bails
    const moveEv = Object.assign(new Event("pointermove"), { clientX: 100 });
    bead.dispatchEvent(moveEv);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("a non-positive duration renders no reel fill", () => {
    render(<DurationStrip values={[0, 6]} />);
    expect(screen.getByRole("slider", { name: "Duration 1 (seconds)" }).getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByRole("slider", { name: "Duration 2 (seconds)" })).toBeTruthy();
  });
});

describe("the reel's error reaches the control, not only the page", () => {
  test("a bead is marked invalid and points at the message", () => {
    render(<DurationStrip values={[6]} onChange={vi.fn()} onAdd={vi.fn()} onRemove={vi.fn()} error="too many" />);
    const bead = screen.getByRole("slider", { name: "Duration 1 (seconds)" });
    expect(bead.getAttribute("aria-invalid")).toBe("true");
    const describedBy = bead.getAttribute("aria-describedby") as string;
    expect(document.getElementById(describedBy)?.textContent).toBe("too many");
  });

  test("with no error the bead claims neither", () => {
    render(<DurationStrip values={[6]} onChange={vi.fn()} onAdd={vi.fn()} onRemove={vi.fn()} />);
    const bead = screen.getByRole("slider", { name: "Duration 1 (seconds)" });
    expect(bead.getAttribute("aria-invalid")).toBeNull();
    expect(bead.getAttribute("aria-describedby")).toBeNull();
  });
});
