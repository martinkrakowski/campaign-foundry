import { describe, test, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, mockPipelineApi, nextMock, renderWithRun } from "@/__tests__/helpers";
import BriefPage from "../page";

beforeEach(() => localStorage.setItem("cf:brief-picked", "1"));

describe("BriefPage", () => {
  test("renders the current brief's fields", () => {
    renderWithRun(<BriefPage />);
    expect(screen.getByDisplayValue("summer-hydration-2026")).toBeTruthy();
    expect(screen.getByText(/Products \(2\)/)).toBeTruthy();
  });

  test("edits a field", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    const region = screen.getByDisplayValue("DE");
    await user.clear(region);
    await user.type(region, "US");
    expect(screen.getByDisplayValue("US")).toBeTruthy();
  });

  test("adds and removes a product", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    await user.click(screen.getByText("Add product"));
    expect(screen.getByText(/Products \(3\)/)).toBeTruthy();
    await user.click(screen.getAllByText("Remove")[0]);
    expect(screen.getByText(/Products \(2\)/)).toBeTruthy();
  });

  test("flags an invalid id and disables saving", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    const id = screen.getByDisplayValue("summer-hydration-2026");
    await user.clear(id);
    await user.type(id, "Bad Id");
    expect(screen.getByText(/Lowercase letters, digits and hyphens/)).toBeTruthy();
    expect((screen.getByText("Save brief") as HTMLButtonElement).disabled).toBe(true);
  });

  test("edits every field type and clears the localized message on save", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    for (const [current, next] of [
      ["Urban outdoor enthusiasts, 25-40", "New audience"],
      ["Stay wild. Stay hydrated.", "New message"],
      ["Hydra Bottle", "Renamed"],
      ["hydra-bottle", "renamed-id"],
      ["#1473E6", "#000000"],
      ["assets/inputs/hydra-logo.png", "assets/inputs/x.png"],
    ] as const) {
      const field = screen.getByDisplayValue(current);
      await user.clear(field);
      await user.type(field, next);
    }
    const localized = screen.getByDisplayValue("Bleib wild. Bleib hydriert.");
    await user.clear(localized); // empty → saved as undefined
    await user.click(screen.getByText("Save brief"));
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
  });

  test("saves a valid brief and navigates to the grid", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    await user.click(screen.getByText("Save brief"));
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
  });

  test("cancel navigates back", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    await user.click(screen.getByText("Cancel"));
    expect(nextMock().router.back).toHaveBeenCalled();
  });

  test("Save to briefs/ offers Replace on 409 then writes the file", async () => {
    const user = userEvent.setup();
    const urls: string[] = [];
    mockPipelineApi({
      post: (url, init) => {
        urls.push(url);
        const body = JSON.parse(String(init.body)) as { id: string };
        if (url.includes("replace=1")) return json({ file: `${body.id}.yaml`, brief: body }, 201);
        return json({ error: `Brief "${body.id}" already exists.` }, 409);
      },
    });
    renderWithRun(<BriefPage />);
    await user.click(screen.getByText("Save to briefs/"));
    expect(await screen.findByText(/already exists/)).toBeTruthy();
    await user.click(screen.getByText("Replace"));
    expect(await screen.findByText(/Saved to briefs\/summer-hydration-2026.yaml/)).toBeTruthy();
    expect(urls.some((u) => u.includes("replace=1"))).toBe(true);
  });

  test("Save as… posts the in-memory copy under a new id and selects it", async () => {
    const user = userEvent.setup();
    mockPipelineApi({
      post: (url, init) => {
        expect(url).not.toContain("/duplicate");
        const body = JSON.parse(String(init.body)) as { id: string; campaignMessage: string };
        return json({ file: `${body.id}.yaml`, brief: body }, 201);
      },
    });
    renderWithRun(<BriefPage />);
    await user.clear(screen.getByDisplayValue("Bleib wild. Bleib hydriert."));
    await user.click(screen.getByText("Save as…"));
    await user.click(screen.getByText("Save copy")); // empty id → validation message
    expect(await screen.findByText(/path-safe slug/)).toBeTruthy();
    await user.type(screen.getByLabelText("Save as new id"), "Bad Id");
    expect(screen.getByText(/Lowercase letters, digits and hyphens only/)).toBeTruthy();
    await user.clear(screen.getByLabelText("Save as new id"));
    await user.type(screen.getByLabelText("Save as new id"), "camp-copy");
    await user.click(screen.getByText("Save copy"));
    expect(await screen.findByText(/Saved to briefs\/camp-copy.yaml/)).toBeTruthy();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("cf:brief") ?? "{}").id).toBe("camp-copy"));
  });

  test("Save as… can be cancelled and a non-409 persist error is shown", async () => {
    const user = userEvent.setup();
    mockPipelineApi({
      post: () => json({ error: "disk full" }, 500),
    });
    renderWithRun(<BriefPage />);
    await user.click(screen.getByText("Save as…"));
    await user.click(screen.getAllByText("Cancel")[0]);
    expect(screen.queryByLabelText("Save as new id")).toBeNull();
    await user.click(screen.getByText("Save to briefs/"));
    expect(await screen.findByText("disk full")).toBeTruthy();
  });
});

