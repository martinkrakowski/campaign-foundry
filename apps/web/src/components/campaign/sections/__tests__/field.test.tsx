import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field } from "../IdentitySection";

describe("Field — assistive technology describedby and invalid attributes", () => {
  test("with a hint only: aria-describedby names the hint element and resolves to hint text; aria-invalid is not set", () => {
    render(
      <Field label="Campaign Name" hint="Choose a memorable name">
        <input data-testid="control" />
      </Field>,
    );

    const control = screen.getByTestId("control");
    const describedBy = control.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    const hintEl = document.getElementById(describedBy!);
    expect(hintEl).not.toBeNull();
    expect(hintEl?.textContent).toBe("Choose a memorable name");

    expect(control.hasAttribute("aria-invalid")).toBe(false);
  });

  test("with an error only: aria-describedby names the error element and resolves to error text; aria-invalid is true", () => {
    render(
      <Field label="Campaign Name" error="Campaign name is required">
        <input data-testid="control" />
      </Field>,
    );

    const control = screen.getByTestId("control");
    const describedBy = control.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    const errorEl = document.getElementById(describedBy!);
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toBe("Campaign name is required");

    expect(control.getAttribute("aria-invalid")).toBe("true");
  });

  test("with both hint and error: aria-describedby names both in that order; both ids resolve to text; aria-invalid is true", () => {
    render(
      <Field label="Campaign Name" hint="Choose a memorable name" error="Campaign name is required">
        <input data-testid="control" />
      </Field>,
    );

    const control = screen.getByTestId("control");
    const describedBy = control.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    const ids = describedBy!.split(" ");
    expect(ids).toHaveLength(2);
    const [hintId, errorId] = ids;

    const hintEl = document.getElementById(hintId!);
    const errorEl = document.getElementById(errorId!);

    expect(hintEl).not.toBeNull();
    expect(hintEl?.textContent).toBe("Choose a memorable name");

    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toBe("Campaign name is required");

    expect(describedBy).toBe(`${hintId} ${errorId}`);
    expect(control.getAttribute("aria-invalid")).toBe("true");
  });

  test("with neither hint nor error: no aria-describedby attribute and no aria-invalid attribute", () => {
    render(
      <Field label="Campaign Name">
        <input data-testid="control" />
      </Field>,
    );

    const control = screen.getByTestId("control");
    expect(control.hasAttribute("aria-describedby")).toBe(false);
    expect(control.hasAttribute("aria-invalid")).toBe(false);
  });

  test("both wrapper variants behave the same: as='div' links hint and error and sets aria-invalid", () => {
    const { unmount } = render(
      <Field as="div" label="Target Region" hint="Region hint" error="Region required">
        <input data-testid="control-div" />
      </Field>,
    );

    const control = screen.getByTestId("control-div");
    const describedBy = control.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    const ids = describedBy!.split(" ");
    expect(ids).toHaveLength(2);
    const [hintId, errorId] = ids;

    expect(document.getElementById(hintId!)?.textContent).toBe("Region hint");
    expect(document.getElementById(errorId!)?.textContent).toBe("Region required");
    expect(control.getAttribute("aria-invalid")).toBe("true");

    unmount();

    // Also verify as="div" with neither hint nor error has no attributes
    render(
      <Field as="div" label="Target Region">
        <input data-testid="control-div-clean" />
      </Field>,
    );
    const cleanControl = screen.getByTestId("control-div-clean");
    expect(cleanControl.hasAttribute("aria-describedby")).toBe(false);
    expect(cleanControl.hasAttribute("aria-invalid")).toBe(false);
  });

  test("multiple children: attaches attributes to the first control child and does not break sibling children", () => {
    render(
      <Field label="Campaign Name" hint="Brief id readout" error="Brief id invalid">
        <input data-testid="primary-control" />
        <div data-testid="secondary-wrapper">
          <button type="button" data-testid="copy-btn">
            Copy
          </button>
        </div>
      </Field>,
    );

    const primaryControl = screen.getByTestId("primary-control");
    const describedBy = primaryControl.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    const ids = describedBy!.split(" ");
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0]!)?.textContent).toBe("Brief id readout");
    expect(document.getElementById(ids[1]!)?.textContent).toBe("Brief id invalid");
    expect(primaryControl.getAttribute("aria-invalid")).toBe("true");

    const secondaryWrapper = screen.getByTestId("secondary-wrapper");
    expect(secondaryWrapper.hasAttribute("aria-describedby")).toBe(false);
    expect(secondaryWrapper.hasAttribute("aria-invalid")).toBe(false);
    expect(screen.getByTestId("copy-btn")).toBeTruthy();
  });

  test("preserves existing aria-describedby on the child control by appending field ids", () => {
    render(
      <Field label="Custom" hint="Field hint">
        <input data-testid="control" aria-describedby="external-desc" />
      </Field>,
    );

    const control = screen.getByTestId("control");
    const describedBy = control.getAttribute("aria-describedby");
    expect(describedBy).toContain("external-desc");
    const ids = describedBy!.split(" ");
    expect(ids[0]).toBe("external-desc");
    expect(document.getElementById(ids[1]!)?.textContent).toBe("Field hint");
  });

  test("works with native select and other control elements", () => {
    render(
      <Field label="Layout" error="Select a layout">
        <select data-testid="select-control">
          <option value="hero">Hero</option>
        </select>
      </Field>,
    );

    const select = screen.getByTestId("select-control");
    const describedBy = select.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe("Select a layout");
    expect(select.getAttribute("aria-invalid")).toBe("true");
  });

  test("handles non-element children without error", () => {
    const { container } = render(<Field label="Plain">Static content</Field>);
    expect(container.textContent).toContain("Plain");
    expect(container.textContent).toContain("Static content");
  });
});
