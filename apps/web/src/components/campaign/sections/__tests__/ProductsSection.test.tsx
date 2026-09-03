import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProductsSection } from "../ProductsSection";
import { initialEditorState } from "../../editor-state";
import type { FieldErrors } from "../../validate";

function renderWithErrors(errors: FieldErrors) {
  const state = initialEditorState();
  const dispatch = vi.fn();
  const onChooseFromBin = vi.fn();
  render(<ProductsSection state={state} dispatch={dispatch} errors={errors} onChooseFromBin={onChooseFromBin} />);
  return { dispatch, onChooseFromBin };
}

describe("ProductsSection", () => {
  test("the heading renders through Eyebrow as an h3 on the token", () => {
    renderWithErrors({});
    const heading = screen.getByRole("heading", { name: "Products (1)", level: 3 });
    expect(heading.className).toContain("tracking-eyebrow");
    expect(heading.className).not.toContain("tracking-widest");
  });

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

  test("choosing from the bin publishes the product key whose logo the bin would fill", async () => {
    const user = userEvent.setup();
    const state = initialEditorState();
    const dispatch = vi.fn();
    const onChooseFromBin = vi.fn();

    // M7: the drawer itself is hoisted to BriefEditor's root (the transformed step
    // card traps `fixed` descendants), so this section keeps the trigger only — its
    // contract is the request it publishes, carrying the product's key.
    render(<ProductsSection state={state} dispatch={dispatch} errors={{}} onChooseFromBin={onChooseFromBin} />);

    const chooseBtn = screen.getAllByRole("button", { name: "Choose from bin" })[0];
    await user.click(chooseBtn);
    expect(onChooseFromBin).toHaveBeenCalledWith(state.products[0].key);
    // No drawer inside the section: the bin is the editor's, not the card's.
    expect(screen.queryByRole("dialog", { name: "Asset Bin" })).toBeNull();
  });
});
