import { describe, test, expect } from "vitest";
import { seedFrom, SeededRandom } from "../SeededRandom.vo.js";

describe("seedFrom", () => {
  test("hashes joined parts with FNV-1a 32-bit (golden)", () => {
    expect(seedFrom("a", "1", "0")).toBe(3500709303);
  });

  test("returns the FNV-1a offset basis when given no parts", () => {
    expect(seedFrom()).toBe(2166136261);
  });

  test("separates parts, so ['a','1'] and ['a1'] differ", () => {
    expect(seedFrom("a", "1")).not.toBe(seedFrom("a1"));
  });
});

describe("SeededRandom", () => {
  test("next() matches the reference mulberry32 sequence for a seedFrom seed (golden)", () => {
    const rng = new SeededRandom(seedFrom("brief", "0", "0"));
    expect([rng.next(), rng.next(), rng.next(), rng.next(), rng.next()]).toEqual([
      0.5561327980831265, 0.28702879324555397, 0.9595100681763142, 0.2781091055367142,
      0.8674063538201153,
    ]);
  });

  test("next() matches the reference for seed 1 (golden)", () => {
    const rng = new SeededRandom(1);
    expect([rng.next(), rng.next(), rng.next()]).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
    ]);
  });

  test("state stays int32, so the sequence still matches the reference after 5M draws", () => {
    // Without the `| 0` wrap the accumulator passes 2^53 near draw 4.9M and
    // diverges from every other mulberry32; this golden is the 5,000,000th draw.
    const rng = new SeededRandom(0xffffffff);
    let last = 0;
    for (let i = 0; i < 5_000_000; i++) last = rng.next();
    expect(last).toBe(0.8975354691501707);
  });

  test("next() is in [0, 1)", () => {
    const rng = new SeededRandom(42);
    for (let i = 0; i < 100; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  test("constructor rejects seeds outside [0, 2^32) or non-integers", () => {
    expect(() => new SeededRandom(-1)).toThrow(/seed must be an integer/);
    expect(() => new SeededRandom(2 ** 32)).toThrow(/seed must be an integer/);
    expect(() => new SeededRandom(1.5)).toThrow(/seed must be an integer/);
    expect(() => new SeededRandom(Number.NaN)).toThrow(/seed must be an integer/);
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

  test("pick is driven by the sequence (golden element for seed 99)", () => {
    expect(new SeededRandom(99).pick(["x", "y", "z"])).toBe("x");
  });

  test("pick throws when the list is empty", () => {
    expect(() => new SeededRandom(1).pick([])).toThrow(/empty list/);
  });
});
