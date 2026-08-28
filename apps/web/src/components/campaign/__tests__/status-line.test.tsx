import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusLine } from "../StatusLine";
import { initialEditorState } from "../editor-state";
import * as messages from "../messages";

const blank = () => initialEditorState("variation");

describe("StatusLine", () => {
  test("a fresh brief is told what to fill, not what is wrong", () => {
    render(<StatusLine state={blank()} attempted={false} onScrollToSection={vi.fn()} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(messages.statusNewBrief().lead);
  });

  test("its section names are links that scroll", async () => {
    const user = userEvent.setup();
    const onScroll = vi.fn();
    render(<StatusLine state={blank()} attempted={false} onScrollToSection={onScroll} />);
    const link = screen.getAllByRole("button")[0];
    await user.click(link);
    expect(onScroll).toHaveBeenCalledWith(link.textContent?.toLowerCase());
  });

  test("a failed write outranks everything else, and drops the links", () => {
    render(
      <StatusLine state={blank()} attempted={false} persistError="Could not save — try Save again." onScrollToSection={vi.fn()} />,
    );
    expect(screen.getByRole("status").textContent).toBe("Could not save — try Save again.");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  test("applied-but-unrunnable says so as information, with no links", () => {
    render(
      <StatusLine state={blank()} attempted={false} applyRefusal="anything" onScrollToSection={vi.fn()} />,
    );
    expect(screen.getByRole("status").textContent).toBe(messages.statusApplyRefusal);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
