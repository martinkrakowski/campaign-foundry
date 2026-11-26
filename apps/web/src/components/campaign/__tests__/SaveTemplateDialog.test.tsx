import { describe, test, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CANONICAL_TEMPLATES } from "@campaignfoundry/CampaignOrchestration/creative-templates";
import { json } from "@/__tests__/helpers";
import * as templatesApi from "@/lib/templates-api";
import {
  SaveTemplateDialog,
  saveTemplateBlockedReason,
  type SaveTemplateDialogProps,
} from "../SaveTemplateDialog";

/**
 * CFRW22C — the save action's own surface. The dialog is the ONLY place the
 * refusals below can live: the rail button is disabled by the editor's gate, so
 * once the dialog is open the refusals are the dialog's to name — a blank name,
 * a server that refuses, a network that drops — and every one of them must
 * leave the dialog open with the typed answers still in it.
 */

// The dialog's fallback branch (`err instanceof Error ? err.message : FALLBACK`)
// is unreachable through the real API layer: `requestJson` wraps every fetch
// rejection into `TemplatesApiError("Network error", …)`, which is always an
// Error, so a non-Error never reaches the dialog's catch. The fallback is
// therefore reached by rejecting the module call itself with a non-Error; the
// wrapper still delegates to the real implementation, so every other test in
// this file keeps exercising the real fetch path.
vi.mock("@/lib/templates-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/templates-api")>();
  return {
    ...actual,
    saveTemplate: vi.fn(actual.saveTemplate),
    saveTemplateVersion: vi.fn(actual.saveTemplateVersion),
  };
});

const savedRecord = {
  ...CANONICAL_TEMPLATES["image-text"],
  id: "house-promo",
  name: "House promo",
};

/** A 201 that answers the stored record, the shape every success path asserts. */
const mockSave = (body: unknown = { template: savedRecord }, status = 201) =>
  vi.mocked(globalThis.fetch).mockImplementation(() => Promise.resolve(json(body, status)));

const baseProps: SaveTemplateDialogProps = {
  open: true,
  onClose: vi.fn(),
  onSaved: vi.fn(),
  templateId: "house-promo",
  unit: "standard-web",
  creativeType: "image-text",
  layers: CANONICAL_TEMPLATES["image-text"].layers,
  isOwnedOrgTemplate: true,
};

const renderDialog = (over: Partial<SaveTemplateDialogProps> = {}) => {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const view = render(
    <SaveTemplateDialog {...baseProps} {...over} onClose={onClose} onSaved={onSaved} />,
  );
  return { onClose, onSaved, unmount: view.unmount, rerender: view.rerender };
};

const submitWith = async (name: string) => {
  const user = userEvent.setup();
  if (name !== "") await user.type(screen.getByLabelText("Template name"), name);
  await user.click(screen.getByRole("button", { name: "Save template" }));
  return user;
};

const statusText = () => screen.getByRole("status").textContent ?? "";

describe("saveTemplateBlockedReason", () => {
  test("returns reason when no layers or unsaved errors", () => {
    expect(saveTemplateBlockedReason(false, false)).toBe(
      "Add at least one layer before saving as a template.",
    );
    expect(saveTemplateBlockedReason(false, true)).toBe(
      "Add at least one layer before saving as a template.",
    );
    expect(saveTemplateBlockedReason(true, true)).toBe(
      "Fix unsaved validation errors before saving as a template.",
    );
    expect(saveTemplateBlockedReason(true, false)).toBeNull();
  });
});

describe("SaveTemplateDialog", () => {
  test("saves, dispatches cf:templates-changed, notifies, and closes on success", async () => {
    mockSave();
    const changed = vi.fn();
    window.addEventListener("cf:templates-changed", changed);
    const { onClose, onSaved } = renderDialog();
    await submitWith("House promo");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe("/api/pipeline/campaigns/templates");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "House promo",
      unit: "standard-web",
      creativeType: "image-text",
      layers: CANONICAL_TEMPLATES["image-text"].layers,
    });
    window.removeEventListener("cf:templates-changed", changed);
  });

  test("refuses blank template name without calling fetch", async () => {
    const { onClose } = renderDialog();
    await submitWith("   ");
    expect(statusText()).toBe("Name the template before saving.");
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("refuses empty layers without calling fetch", async () => {
    const { onClose } = renderDialog({ layers: [] });
    await submitWith("House promo");
    expect(statusText()).toBe("Add at least one layer before saving as a template.");
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("shows server error inline and stays open on 400, 403, 409, and 501", async () => {
    const user = userEvent.setup();
    for (const status of [400, 403, 409, 501] as const) {
      const { onClose, unmount } = renderDialog();
      mockSave({ error: `Refused (${status})` }, status);
      await user.type(screen.getByLabelText("Template name"), "House promo");
      await user.click(screen.getByRole("button", { name: "Save template" }));
      expect(await screen.findByText(`Refused (${status})`)).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
      unmount();
    }
  });

  test("shows network error inline and stays open", async () => {
    const { onClose } = renderDialog();
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("offline"));
    await submitWith("House promo");
    expect(await screen.findByText("Network error")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("shows the fallback message when a rejection carries no message", async () => {
    renderDialog();
    vi.mocked(templatesApi.saveTemplate).mockRejectedValueOnce("not an error");
    await submitWith("House promo");
    expect(await screen.findByText("Could not save template.")).toBeTruthy();
  });

  test("hides Save as new version and calls POST when template is not an owned org template", async () => {
    mockSave();
    const { onClose } = renderDialog({ isOwnedOrgTemplate: false });
    expect(screen.queryByLabelText("Save as new version")).toBeNull();
    await submitWith("House promo");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe("/api/pipeline/campaigns/templates");
    expect(init?.method).toBe("POST");
  });

  test("offers Save as new version and calls POST while it is unchecked", async () => {
    mockSave();
    const { onClose } = renderDialog();
    const checkbox = screen.getByLabelText("Save as new version") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await submitWith("House promo");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe("/api/pipeline/campaigns/templates");
    expect(init?.method).toBe("POST");
  });

  test("a checked Save as new version PUTs to the template's own id", async () => {
    mockSave();
    const { onClose } = renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Template name"), "House promo v2");
    await user.click(screen.getByLabelText("Save as new version"));
    await user.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe("/api/pipeline/campaigns/templates/house-promo");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toMatchObject({ name: "House promo v2" });
  });

  test("ignores duplicate submit while request is in flight", async () => {
    const settle: Array<(res: Response) => void> = [];
    vi.mocked(globalThis.fetch).mockImplementation(
      () => new Promise<Response>((resolve) => settle.push(resolve)),
    );
    const { onClose } = renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Template name"), "House promo");
    const save = screen.getByRole("button", { name: "Save template" });
    // Both clicks inside ONE act: the first click's re-render cannot disable the
    // button before the second lands, so what refuses the duplicate is the
    // synchronous latch itself — not the disabled attribute.
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    expect(settle).toHaveLength(1);
    settle[0](json({ template: savedRecord }, 201));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  test("a reopened dialog is pristine: the typed answers and the refusal are gone", async () => {
    const onClose = vi.fn();
    const view = render(<SaveTemplateDialog {...baseProps} onClose={onClose} />);
    mockSave({ error: "Refused" }, 409);
    await submitWith("House promo");
    expect(await screen.findByText("Refused")).toBeTruthy();
    view.rerender(<SaveTemplateDialog {...baseProps} open={false} onClose={onClose} />);
    view.rerender(<SaveTemplateDialog {...baseProps} onClose={onClose} />);
    expect((screen.getByLabelText("Template name") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("status").textContent ?? "").toBe("");
  });

  test("a closed dialog renders nothing", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("the metadata summary names the creative type and the unit", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Image & text");
    expect(dialog.textContent).toContain("Web & social");
  });
});
