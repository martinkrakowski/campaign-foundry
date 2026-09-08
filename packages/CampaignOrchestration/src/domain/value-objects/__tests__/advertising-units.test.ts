import { describe, test, expect } from "vitest";
import {
  ADVERTISING_UNITS,
  DEFAULT_ADVERTISING_UNIT,
  type AdvertisingUnit,
} from "../advertising-units.js";

describe("advertising units (D119, §1 F7)", () => {
  test("the vocabulary has exactly one member today: standard-web", () => {
    expect(ADVERTISING_UNITS).toEqual(["standard-web"]);
  });

  test("the default is a member of the vocabulary", () => {
    expect((ADVERTISING_UNITS as readonly string[]).includes(DEFAULT_ADVERTISING_UNIT)).toBe(true);
    expect(DEFAULT_ADVERTISING_UNIT).toBe("standard-web");
  });

  test("the union is compile-locked", () => {
    const units: readonly AdvertisingUnit[] = ADVERTISING_UNITS;
    expect(units).toHaveLength(1);
    const _unit: AdvertisingUnit = "standard-web";
    expect(_unit).toBe("standard-web");
  });
});
