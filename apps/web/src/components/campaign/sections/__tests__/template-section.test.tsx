import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { initialEditorState } from "@/components/campaign/editor-state";
import * as messages from "@/components/campaign/messages";
import { TemplateSection } from "../TemplateSection";

describe("TemplateSection — the step the error strip jumps to (D165)", () => {
  test("renders the template's layerLink error, keyed for the touched-field gate", () => {
    const error = messages.layerLinkMisplaced("logo", "Logo", "Image layers");
    render(
      <TemplateSection
        state={initialEditorState()}
        dispatch={vi.fn()}
        errors={{ layerLink: error }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(error);
    expect(alert.getAttribute("data-field-key")).toBe("layerLink");
  });

  test("with no error it says only where the stack went", () => {
    render(<TemplateSection state={initialEditorState()} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByText(messages.templateStackInRail)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
