import { describe, expect, test } from "vitest";
import {
  assertObjectKey,
  objectKeyProblem,
  ObjectExistsError,
  OBJECT_KEY_PATTERN,
} from "../ObjectStorePort.js";

describe("OBJECT_KEY_PATTERN", () => {
  test("accepts the shapes a render key is built from", () => {
    for (const key of [
      "a",
      "campaigns/018f0c2a-1111-4222-8333-444444444444/renders/hero.png",
      "org/018f0c2a-1111-4222-8333-444444444444/cache/tile-01.webp",
      "campaigns/x/renders/",
      "A-Z.a_z-0/9",
    ]) {
      expect(OBJECT_KEY_PATTERN.test(key)).toBe(true);
      expect(() => assertObjectKey(key)).not.toThrow();
    }
  });
});

describe("objectKeyProblem", () => {
  test("refuses an empty key, so list and deletePrefix cannot name the whole store", () => {
    expect(objectKeyProblem("")).toBe(
      `a key must be non-empty and match ${OBJECT_KEY_PATTERN.source}`,
    );
  });

  test("refuses a character outside the pattern", () => {
    for (const key of ["a b", "a?b", "a#b", "a\\b", "a\nb", "aéb", "a&b", "a%2Fb"]) {
      expect(objectKeyProblem(key)).toBe(
        `a key must be non-empty and match ${OBJECT_KEY_PATTERN.source}`,
      );
    }
  });

  test("refuses an absolute key", () => {
    expect(objectKeyProblem("/renders/hero.png")).toBe("a key must be relative, not absolute");
  });

  test("refuses an empty segment", () => {
    expect(objectKeyProblem("campaigns//hero.png")).toBe("a key must not contain an empty segment");
  });

  test("refuses a . or .. segment, and names which one it was", () => {
    expect(objectKeyProblem("campaigns/./hero.png")).toBe('a key must not contain a "." segment');
    expect(objectKeyProblem("campaigns/../hero.png")).toBe('a key must not contain a ".." segment');
    expect(objectKeyProblem("..")).toBe('a key must not contain a ".." segment');
  });

  test("allows a name that merely contains dots, which is not traversal", () => {
    expect(objectKeyProblem("campaigns/..hidden/hero.png")).toBeUndefined();
    expect(objectKeyProblem("campaigns/.hidden/hero.png")).toBeUndefined();
    expect(objectKeyProblem("campaigns/a..b/hero.png")).toBeUndefined();
  });
});

describe("assertObjectKey", () => {
  test("throws an error naming the rule, and never the key", () => {
    // A key is the one string that reaches this guard from outside, so a
    // rejected one must not be echoed into whatever logged the throw.
    const key = "campaigns/../../etc/shadow?token=MARKER-SECRET-7f3a";
    expect(() => assertObjectKey(key)).toThrow(/^Refusing an object key: /);
    try {
      assertObjectKey(key);
      expect.unreachable("assertObjectKey should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("MARKER-SECRET-7f3a");
      expect(message).not.toContain("shadow");
    }
  });
});

describe("ObjectExistsError", () => {
  test("names the taken key and identifies itself", () => {
    const error = new ObjectExistsError("campaigns/c1/renders/hero.png");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ObjectExistsError");
    expect(error.key).toBe("campaigns/c1/renders/hero.png");
    expect(error.message).toContain("campaigns/c1/renders/hero.png");
  });
});
