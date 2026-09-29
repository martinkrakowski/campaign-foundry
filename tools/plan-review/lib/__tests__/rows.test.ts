import { describe, expect, test } from "vitest";
import { asHashRecord, rowHash, rowRisk } from "../rows.js";

const plan = [
  "# The plan",
  "",
  "| Lane | Delivers |",
  "|---|---|",
  "| **PT-5a** | The campaign id, exposed and resolvable (D168, D178, D179). |",
  "| **PT-5b1** | Every campaign-addressed route accepts the id or the slug (D178). |",
  "",
  "## 2. Decisions",
  "",
  "| id | Decision |",
  "|---|---|",
  "| **D177** | Create is a server call. |",
  "| **D178** | Routes and links carry ids; slugs display only. |",
].join("\n");

describe("rowHash", () => {
  test("a whitespace-only reflow of a row keeps its hash", () => {
    const reflowed = plan.replace(
      "| **PT-5a** | The campaign id, exposed and resolvable (D168, D178, D179). |",
      "| **PT-5a** |  The  campaign id,   exposed and resolvable (D168, D178, D179).  |",
    );
    expect(rowHash(reflowed, "PT-5a")).toBe(rowHash(plan, "PT-5a"));
  });

  test("a one-word change to the row gives a different hash", () => {
    const edited = plan.replace("exposed and resolvable", "hidden and unresolvable");
    expect(rowHash(edited, "PT-5a")).not.toBe(rowHash(plan, "PT-5a"));
  });

  test("the normalisation itself is the fingerprint: trim, then collapse whitespace runs", () => {
    const row = "  | **PT-5a** |  The   campaign id.  |  \n";
    expect(rowHash(row, "PT-5a")).toBe(rowHash("| **PT-5a** | The campaign id. |", "PT-5a"));
  });

  test("a row whose text carries a pipe inside backticks still matches and hashes whole", () => {
    const row = "| **PT-5b1** | The route reads `getPoolStore(scope) | withPools` first. |";
    expect(() => rowHash(row, "PT-5b1")).not.toThrow();
    const reflowed = row.replace(
      "`getPoolStore(scope) | withPools`",
      "`getPoolStore(scope)  |  withPools`",
    );
    expect(rowHash(reflowed, "PT-5b1")).toBe(rowHash(row, "PT-5b1"));
  });

  test("zero matches is an error naming the id and the count", () => {
    expect(() => rowHash(plan, "PT-9")).toThrow(/PT-9/);
    expect(() => rowHash(plan, "PT-9")).toThrow(/found 0/);
  });

  test("a row mentioned twice is an error naming the id and the count", () => {
    const duplicated = `${plan}\n| **PT-5a** | A second row with the same first cell. |`;
    expect(() => rowHash(duplicated, "PT-5a")).toThrow(/found 2/);
  });

  test("an id that is a prefix of another id's cell matches only its own row", () => {
    const longer = `${plan}\n| **PT-5a2** | A longer id sharing the prefix. |`;
    expect(rowHash(longer, "PT-5a")).toBe(rowHash(plan, "PT-5a"));
  });

  test("a decision row hashes by the same rule as a lane row", () => {
    expect(rowHash(plan, "D177")).toMatch(/^[0-9a-f]{64}$/);
    const edited = plan.replace("Create is a server call.", "Create is a client call.");
    expect(rowHash(edited, "D177")).not.toBe(rowHash(plan, "D177"));
  });
});

describe("rowRisk", () => {
  const risked = [
    "| Lane | Risk | Delivers |",
    "|---|---|---|",
    "| **HX1** | **high** | Split the reserved list. |",
    "| **HX4** | normal | Plan rows carry a risk tier. |",
  ].join("\n");

  test("a bolded **high** second cell is high", () => {
    expect(rowRisk(risked, "HX1")).toBe("high");
  });

  test("the literal word normal is normal", () => {
    expect(rowRisk(risked, "HX4")).toBe("normal");
  });

  test("a table with no Risk column defaults to normal, as in the platform plan", () => {
    expect(rowRisk(plan, "PT-5a")).toBe("normal");
  });

  test("an unbolded high is not the marker — it defaults to normal", () => {
    const unbolded = "| **HX1** | high | Split the reserved list. |";
    expect(rowRisk(unbolded, "HX1")).toBe("normal");
  });

  test("a pipe inside backticks in the second cell still defaults to normal, not high", () => {
    const row = "| **PT-5b1** | The route reads `getPoolStore(scope) | withPools` first. |";
    expect(rowRisk(row, "PT-5b1")).toBe("normal");
  });

  test("zero or ambiguous matches throws, same as rowHash", () => {
    expect(() => rowRisk(plan, "PT-9")).toThrow(/found 0/);
    const duplicated = `${risked}\n| **HX1** | **high** | A second row with the same id. |`;
    expect(() => rowRisk(duplicated, "HX1")).toThrow(/found 2/);
  });
});

describe("asHashRecord", () => {
  test("a map whose every value is a string is accepted verbatim", () => {
    expect(asHashRecord({ "PT-5a": "aa", D177: "bb" })).toEqual({ "PT-5a": "aa", D177: "bb" });
  });

  test("an empty map is a valid, empty record", () => {
    expect(asHashRecord({})).toEqual({});
  });

  test("a non-object, an array, a null, or a map with a non-string value is refused", () => {
    expect(asHashRecord("rows")).toBeUndefined();
    expect(asHashRecord(["aa"])).toBeUndefined();
    expect(asHashRecord(null)).toBeUndefined();
    expect(asHashRecord({ "PT-5a": 7 })).toBeUndefined();
  });
});
