import { describe, expect, test } from "vitest";
import {
  byIdThenVersion,
  decodeTemplateCursor,
  encodeTemplateCursor,
} from "../template-store.port.js";

describe("decodeTemplateCursor", () => {
  test("round-trips the position encodeTemplateCursor wrote", () => {
    const decoded = decodeTemplateCursor(encodeTemplateCursor({ id: "org-banner", version: 2 }));
    expect(decoded).toEqual({ id: "org-banner", version: 2 });
  });

  test("refuses JSON that parses to a non-object: a number, a string, and null", () => {
    // `123`, `"x"` and `null` are all valid JSON, so each survives the
    // base64url and JSON.parse steps — the object check is what refuses
    // them, and it must refuse with InvalidTemplateCursorError, not crash
    // or coerce.
    const cursors = [
      Buffer.from("123", "utf8").toString("base64url"),
      Buffer.from('"x"', "utf8").toString("base64url"),
      Buffer.from("null", "utf8").toString("base64url"),
    ];
    for (const cursor of cursors) {
      expect(() => decodeTemplateCursor(cursor)).toThrowError(/Invalid template cursor/);
    }
  });

  test("refuses a boolean and an array the same way", () => {
    const cursors = [
      Buffer.from("true", "utf8").toString("base64url"),
      Buffer.from('["org-banner",2]', "utf8").toString("base64url"),
    ];
    for (const cursor of cursors) {
      expect(() => decodeTemplateCursor(cursor)).toThrowError(/Invalid template cursor/);
    }
  });
});

describe("byIdThenVersion", () => {
  test("orders by id then version", () => {
    const items: Array<{ readonly id: string; readonly version: number }> = [
      { id: "b", version: 1 },
      { id: "a", version: 2 },
      { id: "a", version: 1 },
    ];
    const sorted = [...items].sort(byIdThenVersion);
    expect(sorted.map((t) => `${t.id}:${t.version}`)).toEqual(["a:1", "a:2", "b:1"]);
  });
});
