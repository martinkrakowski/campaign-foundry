import { describe, expect, test } from "vitest";
import { discoverRisk } from "../risk.js";

const highPlan = [
  "| Lane | Risk | Delivers |",
  "|---|---|---|",
  "| **HX1-route-segments-reserved** | **high** | Split the reserved list. |",
].join("\n");

const normalPlan = [
  "| Lane | Risk | Delivers |",
  "|---|---|---|",
  "| **HX4-pre-pr-review-gate** | normal | Plan rows carry a risk tier. |",
].join("\n");

const noRiskColumnPlan = [
  "| Lane | Delivers |",
  "|---|---|",
  "| **PT-5a** | The campaign id, exposed and resolvable. |",
].join("\n");

interface Fixture {
  readonly [path: string]: string;
}

const ioOver = (files: Fixture) => ({
  readdir: async (dir: string): Promise<readonly string[]> => {
    const prefix = `${dir}/`;
    return Object.keys(files)
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length));
  },
  readFile: async (path: string): Promise<string> => {
    const text = files[path];
    if (text === undefined) throw new Error(`ENOENT: ${path}`);
    return text;
  },
});

describe("discoverRisk", () => {
  test("finds the lane's row in the one plan that names it", async () => {
    const io = ioOver({ "docs/planning/a.md": highPlan });
    expect(await discoverRisk("HX1-route-segments-reserved", "docs/planning", io)).toBe("high");
  });

  test("a normal row reads normal", async () => {
    const io = ioOver({ "docs/planning/a.md": normalPlan });
    expect(await discoverRisk("HX4-pre-pr-review-gate", "docs/planning", io)).toBe("normal");
  });

  test("a lane found in no plan counts as normal", async () => {
    const io = ioOver({ "docs/planning/a.md": highPlan });
    expect(await discoverRisk("HX9-nonexistent", "docs/planning", io)).toBe("normal");
  });

  test("a plan without a Risk column parses as normal, as in the platform plan", async () => {
    const io = ioOver({ "docs/planning/a.md": noRiskColumnPlan });
    expect(await discoverRisk("PT-5a", "docs/planning", io)).toBe("normal");
  });

  test("files are tried in sorted order, and the first unambiguous match wins", async () => {
    const io = ioOver({
      "docs/planning/b-later.md": highPlan,
      "docs/planning/a-earlier.md": normalPlan.replace(
        "HX4-pre-pr-review-gate",
        "HX1-route-segments-reserved",
      ),
    });
    // a-earlier.md sorts first and names HX1 as normal; b-later.md (high) must lose.
    expect(await discoverRisk("HX1-route-segments-reserved", "docs/planning", io)).toBe("normal");
  });

  test("a plan whose row is ambiguous (0 or 2+ matches) is skipped, not thrown", async () => {
    const duplicated = `${highPlan}\n| **HX1-route-segments-reserved** | normal | A duplicate row. |`;
    const io = ioOver({
      "docs/planning/a-ambiguous.md": duplicated,
      "docs/planning/b-clear.md": highPlan,
    });
    expect(await discoverRisk("HX1-route-segments-reserved", "docs/planning", io)).toBe("high");
  });

  test("non-.md files under the directory are never read", async () => {
    const io = {
      readdir: async (): Promise<readonly string[]> => ["notes.txt", "a.md"],
      readFile: async (path: string): Promise<string> => {
        if (path.endsWith("notes.txt")) throw new Error("must not read non-markdown files");
        return highPlan;
      },
    };
    expect(await discoverRisk("HX1-route-segments-reserved", "docs/planning", io)).toBe("high");
  });

  test("an unreadable planning directory counts as normal", async () => {
    const io = {
      readdir: async (): Promise<readonly string[]> => {
        throw new Error("ENOENT: no such directory");
      },
      readFile: async (): Promise<string> => {
        throw new Error("unreachable");
      },
    };
    expect(await discoverRisk("HX1-route-segments-reserved", "docs/planning", io)).toBe("normal");
  });

  test("a file that cannot be read is skipped in favour of the next", async () => {
    const io = {
      readdir: async (): Promise<readonly string[]> => ["broken.md", "a.md"],
      readFile: async (path: string): Promise<string> => {
        if (path.endsWith("broken.md")) throw new Error("EACCES");
        return highPlan;
      },
    };
    expect(await discoverRisk("HX1-route-segments-reserved", "docs/planning", io)).toBe("high");
  });
});
