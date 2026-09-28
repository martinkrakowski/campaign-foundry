import { describe, expect, test } from "vitest";
import { rowHash } from "../rows.js";

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
    expect(rowHash(plan, "PT-5b1")).toBe(rowHash(plan, "PT-5b1"));
    const longer = `${plan}\n| **PT-5a2** | A longer id sharing the prefix. |`;
    expect(rowHash(longer, "PT-5a")).toBe(rowHash(plan, "PT-5a"));
  });

  test("a decision row hashes by the same rule as a lane row", () => {
    expect(rowHash(plan, "D177")).toMatch(/^[0-9a-f]{64}$/);
    const edited = plan.replace("Create is a server call.", "Create is a client call.");
    expect(rowHash(edited, "D177")).not.toBe(rowHash(plan, "D177"));
  });
});
