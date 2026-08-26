import { describe, test, expect, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, mockPipelineApi, nextMock, renderWithRun } from "@/__tests__/helpers";
import BriefPage from "../page";

beforeEach(() => {
  localStorage.setItem("cf:brief-picked", "1");
  // Mock confirm to return true
  globalThis.confirm = vi.fn(() => true);
});

describe("BriefPage E1 Features", () => {
  test("renders the editor with status chip", () => {
    renderWithRun(<BriefPage />);
    expect(screen.getByText("Draft not applied")).toBeTruthy();
  });

  test("has BriefSelector component", () => {
    renderWithRun(<BriefPage />);
    expect(screen.getByRole("button", { name: /New brief/ })).toBeTruthy();
  });

  test("has mode toggle buttons", () => {
    renderWithRun(<BriefPage />);
    expect(screen.getByText("Classic")).toBeTruthy();
    expect(screen.getByText("Randomized")).toBeTruthy();
  });

  test("has action bar buttons", () => {
    renderWithRun(<BriefPage />);
    expect(screen.getByText("Apply to run")).toBeTruthy();
    expect(screen.getByText("Save & apply")).toBeTruthy();
    expect(screen.getByText("Save as...")).toBeTruthy();
    expect(screen.getByText("Discard")).toBeTruthy();
  });

  test("Save as... opens dialog", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    await user.click(screen.getByText("Save as..."));
    expect(screen.getByText("Save as...")).toBeTruthy();
    expect(screen.getByLabelText("New brief id")).toBeTruthy();
  });

  test("YAML split toggle", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    await user.click(screen.getByText("YAML split on"));
    expect(screen.getByText("YAML split off")).toBeTruthy();
  });
});
