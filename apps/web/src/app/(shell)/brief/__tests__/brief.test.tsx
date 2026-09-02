import { describe, test, expect, beforeEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, nextMock } from "@/__tests__/helpers";
import * as messages from "@/components/campaign/messages";
import BriefIndexPage from "../page";
import BriefIdPage from "../[id]/page";
import NewBriefPage from "../new/page";

/**
 * The blank route, as a user meets it. `renderWithRun` supplies the outlet that stands
 * in for the sidebar, so the panels the page publishes are placed exactly once —
 * placing them here as well would make every published control exist twice.
 */
const Editor = () => (
  <>
    <NewBriefPage />
  </>
);

/** Corrected for D35's verb model: Save is the bar's primary, one press; Save as…
 *  lives in the overflow — the old disclosure that hid Save behind Save is gone. */
const saveVia = async (user: ReturnType<typeof userEvent.setup>, item: "Save" | "Save as") => {
  if (item === "Save") {
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    return;
  }
  await user.click(screen.getByText("⋯"));
  await user.click(await screen.findByText(messages.editorSaveAs));
};

const storedBrief = (id: string) => ({
  id,
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("cf:brief-picked", "1");
  // This legacy suite drives the stacked, everything-on-one-page editor; pin the
  // presentation so the W6 default (Guided) does not rearrange its assumptions.
  localStorage.setItem("cf:presentation", "everything");
  // Mock confirm to return true
  globalThis.confirm = vi.fn(() => true);
});

describe("the bare /brief route (D37)", () => {
  test("redirects to the brief last opened", async () => {
    localStorage.setItem("cf:brief", JSON.stringify(storedBrief("camp")));
    renderWithRun(<BriefIndexPage />);
    await vi.waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/brief/camp"));
  });

  test("redirects to the grid when no last-opened brief is recorded", async () => {
    renderWithRun(<BriefIndexPage />);
    await vi.waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/grid"));
  });

  test("redirects to the grid when the record is unreadable", async () => {
    localStorage.setItem("cf:brief", "{ not json");
    renderWithRun(<BriefIndexPage />);
    await vi.waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/grid"));
  });

  test("redirects to the grid when the record is not a brief", async () => {
    localStorage.setItem("cf:brief", JSON.stringify(["not", "a", "brief"]));
    renderWithRun(<BriefIndexPage />);
    await vi.waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/grid"));
  });

  test("redirects to the grid when the last-opened id is malformed", async () => {
    localStorage.setItem("cf:brief", JSON.stringify(storedBrief("Not Safe")));
    renderWithRun(<BriefIndexPage />);
    await vi.waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/grid"));
  });

  test("never renders an editor itself", () => {
    localStorage.setItem("cf:brief", JSON.stringify(storedBrief("camp")));
    renderWithRun(<BriefIndexPage />);
    expect(screen.queryByLabelText("Campaign Name")).toBeNull();
  });
});

describe("the /brief/{id} route (D37)", () => {
  test("hands the route's id to the editor", async () => {
    const page = await BriefIdPage({ params: Promise.resolve({ id: "camp" }) });
    expect((page as React.ReactElement<{ briefId?: string }>).props.briefId).toBe("camp");
  });
});

describe("the blank editor route (/brief/new)", () => {
  test("renders the editor with status chip", async () => {
    const user = userEvent.setup();
    renderWithRun(<Editor />);
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.queryByText("Draft not applied")).toBeNull();

    await user.type(screen.getByLabelText("Campaign Name"), "spark");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  test("has BriefSelector component", () => {
    renderWithRun(<Editor />);
    expect(screen.getByRole("button", { name: /New brief/ })).toBeTruthy();
  });

  test("has mode toggle buttons", () => {
    renderWithRun(<Editor />);
    expect(screen.getByText("Classic")).toBeTruthy();
    expect(screen.getByText("Randomized")).toBeTruthy();
  });

  // Corrected for D35/D40/D61: the verbs are Cancel / Save (menu) / Save as…, with Revert
  // behind the overflow — "Apply to run" is retired and Discard split in two, and the
  // YAML split left the menu entirely (the preview rail owns that view now).
  test("has action bar buttons — Cancel and Save, with Revert behind the overflow", async () => {
    renderWithRun(<Editor />);
    const bar = screen.getByTestId("action-bar");
    // the error strip's chips sit in the bar too; the action buttons are the rest
    // the primary row only: error-strip chips are pills, and the ⋯ overflow's contents
    // are behind a <details> — both are in the bar's DOM but not in the row of verbs.
    const labels = Array.from(bar.querySelectorAll("button"))
      .filter((b) => !b.classList.contains("rounded-full") && !b.closest("details"))
      .map((b) => b.textContent?.trim());
    // D3/D35: the bar carries the status sentence and the two verbs; the YAML split
    // and Revert moved out of the primary row into the ⋯ overflow so the sentence
    // has room.
    expect(labels).toEqual(expect.arrayContaining(["Cancel", "Save"]));
    expect(labels).not.toContain("Apply to run");
    expect(labels).not.toContain("Discard");
    expect(labels).not.toContain("YAML split on");
    // D3: a blank draft is invalid, but the verbs stay pressable so the refusal can
    // be spoken; the menu's own behaviour is covered in ui/__tests__/overflow-menu.test.tsx
    expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("Save as... opens dialog", async () => {
    const user = userEvent.setup();
    renderWithRun(<Editor />);
    // Save as… is disabled while the draft has validation errors, so fill it in first.
    await user.type(screen.getByLabelText("Campaign Name"), "fresh");
    await user.type(screen.getByLabelText("Target Region"), "DE");
    await user.type(screen.getByLabelText("Target Audience"), "a");
    await user.type(screen.getByLabelText("Headline"), "Hi");
    let names = screen.getAllByLabelText("Name");
    if (names.length < 2) {
      await user.click(screen.getByRole("button", { name: "Add product" }));
      names = screen.getAllByLabelText("Name");
    }
    await user.type(names[0], "A");
    await user.type(names[1], "B");
    const logos = screen
      .getAllByLabelText("Logo Path")
      .filter((el) => el.tagName === "INPUT" && el.getAttribute("type") !== "file");
    await user.type(logos[0], "a.png");
    await user.type(logos[1], "b.png");
    // Once the dialog is open, "Save as..." matches both the action-bar button and
    // the dialog heading — query by role so each assertion names the one it means.
    await saveVia(user, "Save as");
    expect(screen.getByRole("dialog", { name: /Save as/ })).toBeTruthy();
    expect(screen.getByLabelText("New brief id")).toBeTruthy();
  });

  test("Escape closes the Save-as dialog", async () => {
    const user = userEvent.setup();
    renderWithRun(<Editor />);
    await saveVia(user, "Save as");
    expect(screen.getByRole("dialog", { name: /Save as/ })).toBeTruthy();
    // It is `aria-modal`, but it was hand-rolled and had no Escape: Cancel was the
    // only way out. It now runs the same focus trap as every other overlay.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /Save as/ })).toBeNull();
  });

  // Corrected for D61: the side-by-side YAML split is retired — the preview rail owns
  // the YAML view now, so the ⋯ menu offers no split toggle at all.
  test("the ⋯ menu no longer offers a YAML split", async () => {
    const user = userEvent.setup();
    renderWithRun(<Editor />);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: /YAML split/ })).toBeNull();
  });
});
