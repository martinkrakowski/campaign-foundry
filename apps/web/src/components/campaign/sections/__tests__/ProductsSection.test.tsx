import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProductsSection } from "../ProductsSection";
import { initialEditorState } from "../../editor-state";
import type { FieldErrors } from "../../validate";

function renderWithErrors(errors: FieldErrors) {
  const state = initialEditorState();
  const dispatch = vi.fn();
  return render(<ProductsSection state={state} dispatch={dispatch} errors={errors} />);
}

describe("ProductsSection", () => {
  test("renders product-0-name error and sets aria-invalid on name input", () => {
    renderWithErrors({ "product-0-name": "Name is required." });
    expect(screen.getByText("Name is required.")).toBeTruthy();
    const nameInput = screen.getAllByLabelText("Name")[0] as HTMLInputElement;
    expect(nameInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("renders product-0-id error and sets aria-invalid on id input", () => {
    renderWithErrors({ "product-0-id": "ID is required." });
    expect(screen.getByText("ID is required.")).toBeTruthy();
    const idInput = screen.getAllByLabelText("ID")[0] as HTMLInputElement;
    expect(idInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("renders product-0-color error and sets aria-invalid on color input", () => {
    renderWithErrors({ "product-0-color": "Colour is required." });
    expect(screen.getByText("Colour is required.")).toBeTruthy();
    const colorInput = screen.getAllByLabelText("Primary Colour")[0] as HTMLInputElement;
    expect(colorInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("renders product-0-logo error and sets aria-invalid on logo input", () => {
    renderWithErrors({ "product-0-logo": "Logo is required." });
    expect(screen.getByText("Logo is required.")).toBeTruthy();
    const logoInput = screen.getAllByLabelText("Logo Path")[0] as HTMLInputElement;
    expect(logoInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("the hidden logo file input answers to its aria-label, not a product key", () => {
    renderWithErrors({});
    const input = screen.getAllByLabelText("Upload product logo")[0] as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.className).toContain("hidden");
  });
});
