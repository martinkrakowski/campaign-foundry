import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionBlock } from "../section-block";

describe("SectionBlock", () => {
  test("the heading labels the section and the numeral, title and badge ride in it", () => {
    render(
      <SectionBlock numeral="01" title="Targeting" badge={<span data-testid="badge">2</span>}>
        <p>fields</p>
      </SectionBlock>,
    );
    const section = document.querySelector("section") as HTMLElement;
    const heading = document.getElementById(section.getAttribute("aria-labelledby") as string) as HTMLElement;
    expect(heading).toBeTruthy();
    expect(heading.textContent).toContain("Targeting");
    // the numeral is the ordering, decorative — the title carries the meaning
    expect(heading.textContent).toContain("01");
    expect(heading.querySelector("span[aria-hidden='true']")?.textContent).toBe("01");
    expect(heading.contains(screen.getByTestId("badge"))).toBe(true);
    expect(section.contains(screen.getByText("fields"))).toBe(true);
  });

  test("the heading defaults to the third level, so it never fights a dialog's own h2", () => {
    render(
      <SectionBlock numeral="02" title="Start from">
        <p>fields</p>
      </SectionBlock>,
    );
    expect(screen.getByRole("heading", { name: "Start from" }).tagName).toBe("H3");
  });

  test("a heading level of 2 renders an h2 where the surface owns the outline", () => {
    render(
      <SectionBlock numeral="01" title="Targeting" headingLevel={2}>
        <p>fields</p>
      </SectionBlock>,
    );
    expect(screen.getByRole("heading", { name: "Targeting" }).tagName).toBe("H2");
  });

  test("the hint reads under the heading when the surface gives one", () => {
    render(
      <SectionBlock numeral="01" title="Targeting" hint="Who is this for?">
        <p>fields</p>
      </SectionBlock>,
    );
    expect(screen.getByText("Who is this for?").tagName).toBe("P");
  });

  test("without the optional slots only the heading and the fields remain", () => {
    const { container } = render(
      <SectionBlock numeral="03" title="Mode">
        <p>fields</p>
      </SectionBlock>,
    );
    // no hint paragraph; the heading carries only the numeral and the title, no badge
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("h2, h3")?.children).toHaveLength(2);
  });
});
