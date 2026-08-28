import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ProductsSection } from "./ProductsSection";
import type { EditorState } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";
import { initialEditorState } from "@/components/campaign/editor-state";

function renderWithErrors(errors: FieldErrors) {
  const state = initialEditorState();
  const dispatch = vi.fn();
  return render(<ProductsSection state={state} dispatch={dispatch} errors={errors} />);
}

describe("ProductsSection", () => {
  test("renders product-0-name error and sets aria-invalid on name input", () => {
    renderWithErrors({ "product-0-name": "Name is required." });
    expect(screen.getByText("Name is required.")).toBeInTheDocument();
    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    expect(nameInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("renders product-0-id error and sets aria-invalid on id input", () => {
    renderWithErrors({ "product-0-id": "ID is required." });
    expect(screen.getByText("ID is required.")).toBeInTheDocument();
    const idInput = screen.getByLabelText("ID") as HTMLInputElement;
    expect(idInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("renders product-0-color error and sets aria-invalid on color input", () => {
    renderWithErrors({ "product-0-color": "Colour is required." });
    expect(screen.getByText("Colour is required.")).toBeInTheDocument();
    const colorInput = screen.getByLabelText("Primary Colour") as HTMLInputElement;
    expect(colorInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("renders product-0-logo error and sets aria-invalid on logo input", () => {
    renderWithErrors({ "product-0-logo": "Logo is required." });
    expect(screen.getByText("Logo is required.")).toBeInTheDocument();
    const logoInput = screen.getByLabelText("Logo Path") as HTMLInputElement;
    expect(logoInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("no id or data-* attribute contains a product key", () => {
    const state = initialEditorState();
    const dispatch = vi.fn();
    const { container } = render(<ProductsSection state={state} dispatch={dispatch} errors={{}} />);
    const elementsWithIds = container.querySelectorAll("[id]");
    const elementsWithData = container.querySelectorAll("[data-testid]");
    const productKeys = state.products.map((p) => p.key.toString());
    elementsWithIds.forEach((el) => {
      const id = el.getAttribute("id")!;
      expect(productKeys.some((key) => id.includes(key))).toBe(false);
    });
    elementsWithData.forEach((el) => {
      const testid = el.getAttribute("data-testid")!;
      expect(productKeys.some((key) => testid.includes(key))).toBe(false);
    });
  });

  test("logo upload input id is referenced by label htmlFor", () => {
    const state = initialEditorState();
    const dispatch = vi.fn();
    const { container } = render(<ProductsSection state={state} dispatch={dispatch} errors={{}} />);
    const fileInput = container.querySelector("input[type=\"file\"]")!;
    const inputId = fileInput.getAttribute("id")!;
    const label = container.querySelector(`label[for="${inputId}"]`);
    expect(label).toBeInTheDocument();
  });

  test("renders identical ids across two independent initial states", () => {
    const state1 = initialEditorState();
    const state2 = initialEditorState();
    const dispatch = vi.fn();
    const { container: c1 } = render(<ProductsSection state={state1} dispatch={dispatch} errors={{}} />);
    const { container: c2 } = render(<ProductsSection state={state2} dispatch={dispatch} errors={{}} />);
    const ids1 = Array.from(c1.querySelectorAll("[id]")).map((el) => el.getAttribute("id"));
    const ids2 = Array.from(c2.querySelectorAll("[id]")).map((el) => el.getAttribute("id"));
    expect(ids1).toEqual(ids2);
  });
});
