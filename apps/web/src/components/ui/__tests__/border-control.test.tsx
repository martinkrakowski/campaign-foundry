import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderWithRun } from "@/__tests__/helpers";
import { Button } from "../button";
import { Input } from "../input";
import { Stepper } from "../stepper";
import { ChipGroup } from "../chip-group";
import { SwatchChip } from "../swatch-chip";
import { SwatchPicker } from "../swatch-picker";
import { AxisCard } from "../axis-card";
import { PreviewCard } from "../preview-card";
import { PlatformCard } from "../platform-card";
import { SwitchRow } from "../switch-row";
import { ModelSelector } from "../../shell/ModelSelector";
import { platformProfile } from "@campaignfoundry/Distribution/platform-profiles";

/**
 * The control-boundary token (WCAG 1.4.11): a control whose fill differs from its
 * ground by ~1.05:1 is identified only by its hairline, so that hairline must be
 * `border-border-control` (≥ 3:1 on every ground), not `border-border`. jsdom applies
 * no CSS, so the class list is the only observable — and the exact token, split from
 * the class string, because `border-border` is a substring of `border-border-control`
 * and a substring assertion could never catch a regression back to the faint token.
 */
const classes = (el: Element): readonly string[] => el.className.split(/\s+/);

describe("control boundaries carry border-control", () => {
  test("Input — a bg-background field inside a surface panel", () => {
    render(<Input placeholder="name" />);
    const el = screen.getByPlaceholderText("name");
    expect(classes(el)).toContain("border-border-control");
    expect(classes(el)).not.toContain("border-border");
  });

  test("Button secondary — its border, while the hover fill job stays border-hover", () => {
    render(<Button variant="secondary">Go</Button>);
    const b = screen.getByRole("button", { name: "Go" });
    expect(classes(b)).toContain("border-border-control");
    expect(classes(b)).toContain("hover:bg-border-hover");
  });

  test("Stepper — the − / + buttons and the spinbutton readout", () => {
    render(<Stepper aria-label="Distance" value="2" min={0} max={5} onChange={vi.fn()} />);
    expect(classes(screen.getByRole("button", { name: "Decrease Distance" }))).toContain("border-border-control");
    expect(classes(screen.getByRole("button", { name: "Increase Distance" }))).toContain("border-border-control");
    expect(classes(screen.getByRole("spinbutton", { name: "Distance" }))).toContain("border-border-control");
  });

  test("Stepper — invalid keeps the error arm and takes no control token", () => {
    render(<Stepper aria-label="Distance" value="2" min={0} max={5} onChange={vi.fn()} invalid />);
    const readout = screen.getByRole("spinbutton", { name: "Distance" });
    expect(classes(readout)).toContain("border-error");
    expect(classes(readout)).not.toContain("border-border-control");
  });

  test("ChipGroup — the option chips, the Other chip, and their hovers", () => {
    const onToggle = render(
      <ChipGroup
        label="Region"
        options={["nordics"]}
        value=""
        onChange={vi.fn()}
        allowOther
        otherLabel="Other…"
        otherInputLabel="Custom region"
      />,
    );
    const chip = screen.getByRole("button", { name: "nordics" });
    expect(classes(chip)).toContain("border-border-control");
    expect(classes(chip)).toContain("hover:border-border-control-hover");
    const other = screen.getByRole("button", { name: "Other…" });
    expect(classes(other)).toContain("border-border-control");
    expect(classes(other)).toContain("hover:border-border-control-hover");
    onToggle.unmount();

    // The selected chip takes the brand border instead.
    render(<ChipGroup label="Region" options={["nordics"]} value="nordics" onChange={vi.fn()} />);
    expect(classes(screen.getByRole("button", { name: "nordics" }))).toContain("border-brand-primary");
  });

  test("SwatchChip — the button; the colour dot's rim stays decorative border", () => {
    render(<SwatchChip value={0.1} selected={false} baseColor="#ff0000" onToggle={vi.fn()} />);
    const chip = screen.getByRole("button", { name: "0.1" });
    expect(classes(chip)).toContain("border-border-control");
    const dot = chip.querySelector("span[aria-hidden='true']") as HTMLElement;
    expect(classes(dot)).toContain("border-border");
    expect(classes(dot)).not.toContain("border-border-control");
  });

  test("SwatchPicker — the swatch buttons with their hover, and the custom-colour button", () => {
    render(<SwatchPicker value="" onChange={vi.fn()} label="Brand colour" />);
    const swatch = screen.getByRole("button", { name: "#1473E6" });
    expect(classes(swatch)).toContain("border-border-control");
    expect(classes(swatch)).toContain("hover:border-border-control-hover");
    const custom = screen.getByRole("button", { name: "Brand colour custom colour" });
    expect(classes(custom)).toContain("border-border-control");
  });

  test("AxisCard — the unselected card and its hover", () => {
    render(
      <AxisCard value="headline-top" selected={false} onToggle={vi.fn()}>
        <svg />
      </AxisCard>,
    );
    const card = screen.getByRole("button", { name: "headline-top" });
    expect(classes(card)).toContain("border-border-control");
    expect(classes(card)).toContain("hover:border-border-control-hover");
  });

  test("PreviewCard — the unselected card and its hover", () => {
    render(
      <PreviewCard value="procedural" selected={false} meta="A pattern" onToggle={vi.fn()}>
        <svg />
      </PreviewCard>,
    );
    const card = screen.getByRole("button", { name: "procedural" });
    expect(classes(card)).toContain("border-border-control");
    expect(classes(card)).toContain("hover:border-border-control-hover");
  });

  test("PlatformCard — the unselected card and its hover", () => {
    render(
      <PlatformCard profile={platformProfile("instagram-feed")!} selected={false} onToggle={vi.fn()} />,
    );
    const card = screen.getByRole("button", { name: "instagram-feed" });
    expect(classes(card)).toContain("border-border-control");
    expect(classes(card)).toContain("hover:border-border-control-hover");
  });

  test("SwitchRow — the off rail; the checked rail keeps the brand border", () => {
    const off = render(<SwitchRow label="Vary the headline" checked={false} onToggle={vi.fn()} />);
    expect(classes(screen.getByRole("switch", { name: "Vary the headline" }))).toContain("border-border-control");
    off.unmount();

    render(<SwitchRow label="Vary the tone" checked onToggle={vi.fn()} />);
    const on = screen.getByRole("switch", { name: "Vary the tone" });
    expect(classes(on)).toContain("border-brand-primary");
    expect(classes(on)).not.toContain("border-border-control");
  });

  test("ModelSelector — the trigger button only", () => {
    renderWithRun(<ModelSelector />);
    const trigger = screen.getByTitle("Change image model");
    expect(classes(trigger)).toContain("border-border-control");
    expect(classes(trigger)).toContain("hover:border-border-control-hover");
  });
});
