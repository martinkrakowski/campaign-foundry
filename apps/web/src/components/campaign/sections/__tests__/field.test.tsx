import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Fragment } from "react";
import { Field } from "../IdentitySection";
import { CopySection } from "../CopySection";
import { validateCopyWarnings } from "../../validate";
import { LayoutSection } from "../LayoutSection";
import { PolicySection } from "../PolicySection";
import { ProductsSection } from "../ProductsSection";
import { initialEditorState } from "../../editor-state";
import * as messages from "../../messages";

describe("Field — assistive technology describedby and invalid attributes", () => {
  afterEach(() => {
    localStorage.clear();
  });

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

  test("function-children form: attributes reach the spread target and no clone happens", () => {
    let cloneAttempted = false;
    const DummyChild = (props: Record<string, unknown>) => {
      if (props["data-cloned"]) cloneAttempted = true;
      return <div data-testid="wrapper">{props.children as React.ReactNode}</div>;
    };

    render(
      <Field label="Custom Field" hint="Helpful hint" error="Field error">
        {(control) => (
          <DummyChild>
            <input data-testid="spread-target" {...control} />
          </DummyChild>
        )}
      </Field>,
    );

    expect(cloneAttempted).toBe(false);
    const wrapper = screen.getByTestId("wrapper");
    expect(wrapper.hasAttribute("aria-describedby")).toBe(false);
    expect(wrapper.hasAttribute("aria-invalid")).toBe(false);

    const target = screen.getByTestId("spread-target");
    const describedBy = target.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const ids = describedBy!.split(" ");
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0]!)?.textContent).toBe("Helpful hint");
    expect(document.getElementById(ids[1]!)?.textContent).toBe("Field error");
    expect(target.getAttribute("aria-invalid")).toBe("true");
  });

  test("skips a Fragment child and does not pass props to it", () => {
    render(
      <Field label="Fragment Field" hint="Fragment hint">
        <Fragment>
          <input data-testid="fragment-control" />
        </Fragment>
      </Field>,
    );

    const control = screen.getByTestId("fragment-control");
    expect(control.hasAttribute("aria-describedby")).toBe(false);
  });

  test("with a warning only: aria-describedby names the warning element and resolves to warning text; aria-invalid is not set", () => {
    render(
      <Field label="Headline" warning={'Contains prohibited term "guaranteed" — remove before generation.'}>
        <input data-testid="control" />
      </Field>,
    );

    const control = screen.getByTestId("control");
    const describedBy = control.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    const warningEl = document.getElementById(describedBy!);
    expect(warningEl).not.toBeNull();
    expect(warningEl?.textContent).toBe(
      'Contains prohibited term "guaranteed" — remove before generation.',
    );

    expect(control.hasAttribute("aria-invalid")).toBe(false);
  });

  test("with a warning only, function children: the spread target names the warning element; aria-invalid is not set", () => {
    render(
      <Field label="Headline" warning={'Contains prohibited term "miracle" — remove before generation.'}>
        {(control) => <input data-testid="spread-target" {...control} />}
      </Field>,
    );

    const target = screen.getByTestId("spread-target");
    const describedBy = target.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      'Contains prohibited term "miracle" — remove before generation.',
    );
    expect(target.hasAttribute("aria-invalid")).toBe(false);
  });

  test("with hint and warning: aria-describedby names both, hint first; both ids resolve to text", () => {
    render(
      <Field label="Headline" hint="Keep it short" warning={'Contains prohibited term "cure" — remove before generation.'}>
        <input data-testid="control" />
      </Field>,
    );

    const control = screen.getByTestId("control");
    const describedBy = control.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    const ids = describedBy!.split(" ");
    expect(ids).toHaveLength(2);
    const [hintId, warningId] = ids;
    expect(document.getElementById(hintId!)?.textContent).toBe("Keep it short");
    expect(document.getElementById(warningId!)?.textContent).toBe(
      'Contains prohibited term "cure" — remove before generation.',
    );
    expect(control.hasAttribute("aria-invalid")).toBe(false);
  });

  test("with error and warning: the warning is not rendered and not referenced", () => {
    render(
      <Field label="Headline" error="Headline is required" warning={'Contains prohibited term "cure" — remove before generation.'}>
        <input data-testid="control" />
      </Field>,
    );

    const control = screen.getByTestId("control");
    const ids = control.getAttribute("aria-describedby")!.split(" ");
    for (const id of ids) {
      expect(document.getElementById(id)?.textContent).not.toContain("prohibited");
    }
    expect(document.body.textContent).not.toContain("prohibited");
    expect(control.getAttribute("aria-invalid")).toBe("true");
  });

  test("call-site test: CopySection headline input is described by the prohibited-terms warning", () => {
    const state = { ...initialEditorState(), campaignMessage: "Guaranteed results" };
    render(
      <CopySection
        state={state}
        dispatch={vi.fn()}
        errors={{}}
        warnings={validateCopyWarnings(state)}
      />,
    );

    const headline = screen.getByRole("textbox", { name: messages.headlineLabel });
    const describedBy = headline.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    const warningEl = document.getElementById(describedBy!);
    expect(warningEl).not.toBeNull();
    expect(warningEl?.textContent).toBe(messages.prohibitedTerminology("guaranteed"));
    expect(headline.hasAttribute("aria-invalid")).toBe(false);
  });

  test("call-site test: LayoutSection with a hinted Slider and a hinted ChipGroup", () => {
    render(<LayoutSection state={initialEditorState()} dispatch={vi.fn()} errors={{}} />);

    // Hinted Slider: Size
    const sizeSlider = screen.getByRole("slider", { name: "Size" });
    const sliderDescribedBy = sizeSlider.getAttribute("aria-describedby");
    expect(sliderDescribedBy).toBeTruthy();
    const sliderHintEl = document.getElementById(sliderDescribedBy!);
    expect(sliderHintEl).not.toBeNull();
    expect(sliderHintEl?.textContent).toBe(
      "A share of the canvas width, shown as pixels at the previewed ratio",
    );

    // Hinted ChipGroup: Typeface
    const typefaceGroup = screen.getByRole("group", { name: "Typeface options" });
    const groupDescribedBy = typefaceGroup.getAttribute("aria-describedby");
    expect(groupDescribedBy).toBeTruthy();
    const groupHintEl = document.getElementById(groupDescribedBy!);
    expect(groupHintEl).not.toBeNull();
    expect(groupHintEl?.textContent).toBe("From the faces the renderer bundles");
  });

  test("call-site test: PolicySection seed Field with an error", () => {
    localStorage.clear();
    render(
      <PolicySection
        state={{ ...initialEditorState(), mode: "variation" }}
        dispatch={vi.fn()}
        errors={{ seed: "Seed must be positive" }}
      />,
    );

    const advancedBtn = screen.getByRole("button", { name: "Advanced" });
    if (advancedBtn.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(advancedBtn);
    }

    const seedInput = screen.getByRole("spinbutton", { name: "Seed" });
    const describedBy = seedInput.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    const ids = describedBy!.split(" ");
    expect(ids).toHaveLength(2);
    const [hintId, errorId] = ids;
    expect(document.getElementById(hintId!)?.textContent).toBe(
      "Fixes the draw, so the same brief plans the same creatives",
    );
    expect(document.getElementById(errorId!)?.textContent).toBe("Seed must be positive");
    expect(seedInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("call-site test: ProductsSection LogoField with an error", () => {
    render(
      <ProductsSection
        state={initialEditorState()}
        dispatch={vi.fn()}
        errors={{ "product-0-logo": "Logo is required" }}
        onChooseFromBin={vi.fn()}
      />,
    );

    const logoInput = screen.getByLabelText(messages.logoPathAria);
    const describedBy = logoInput.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const errorEl = document.getElementById(describedBy!);
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toBe("Logo is required");
    expect(logoInput.getAttribute("aria-invalid")).toBe("true");
  });
});

