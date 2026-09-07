import { describe, test, expect } from "vitest";
import { pip } from "../pip";
import { EUR, NA, UK } from "../polygons";

// Points proven against the raw mockup polygons — one known inside, one known
// outside, per polygon under test.
describe("pip", () => {
  test("finds a point inside EUR and refuses one in the sea north of it", () => {
    expect(pip(532, 120, EUR)).toBe(true);
    expect(pip(532, 50, EUR)).toBe(false);
  });

  test("finds a point inside NA and refuses one in the South Atlantic", () => {
    expect(pip(200, 100, NA)).toBe(true);
    expect(pip(200, 300, NA)).toBe(false);
  });

  test("finds a point inside the UK polygon", () => {
    expect(pip(487, 100, UK)).toBe(true);
    expect(pip(510, 100, UK)).toBe(false);
  });
});
