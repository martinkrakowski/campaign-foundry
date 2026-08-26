import { describe, test, expect } from "vitest";
import { seedFrom, SeededRandom } from "../SeededRandom.vo.js";

describe("seedFrom", () => {
  test("hashes joined parts with FNV-1a 32-bit", () => {
    expect(seedFrom("a", "1", "0")).toBe(3500709303);
  });

  test("returns the same seed for the same parts", () => {
    expect(seedFrom("a", "1", "0")).toBe(seedFrom("a", "1", "0"));
  });

  test("returns the FNV-1a offset basis when given no parts", () => {
    expect(seedFrom()).toBe(2166136261);
  });

  test("produces different seeds for ['a','1'] and ['a1']", () => {
    expect(seedFrom("a", "1")).not.toBe(seedFrom("a1"));
  });

  test("produces different seeds for ['a','b'] and ['ab']", () => {
    expect(seedFrom("a", "b")).not.toBe(seedFrom("ab"));
  });
});

describe("SeededRandom", () => {
  test("same constructor seed yields an identical next() sequence", () => {
    const a = new SeededRandom(1);
    const b = new SeededRandom(1);
    expect([a.next(), a.next(), a.next(), a.next(), a.next()]).toEqual([
      b.next(),
      b.next(),
      b.next(),
      b.next(),
      b.next(),
    ]);
  });

  test("next() is in [0, 1)", () => {
    const rng = new SeededRandom(42);
    for (let i = 0; i < 100; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  test("nextInt returns an integer in [0, n)", () => {
    const rng = new SeededRandom(7);
    for (let i = 0; i < 50; i++) {
      const x = rng.nextInt(10);
      expect(Number.isInteger(x)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(10);
    }
  });

  test("nextInt rejects n <= 0", () => {
    const rng = new SeededRandom(1);
    expect(() => rng.nextInt(0)).toThrow(/positive integer/);
    expect(() => rng.nextInt(-3)).toThrow(/positive integer/);
  });

  test("nextInt rejects a non-integer n", () => {
    const rng = new SeededRandom(1);
    expect(() => rng.nextInt(1.5)).toThrow(/positive integer/);
    expect(() => rng.nextInt(Number.NaN)).toThrow(/positive integer/);
    expect(() => rng.nextInt(Number.POSITIVE_INFINITY)).toThrow(/positive integer/);
  });

  test("pick returns an element of the list", () => {
    const items = ["x", "y", "z"] as const;
    expect(items).toContain(new SeededRandom(99).pick(items));
  });

  test("pick throws when the list is empty", () => {
    expect(() => new SeededRandom(1).pick([])).toThrow(/empty list/);
  });
});
