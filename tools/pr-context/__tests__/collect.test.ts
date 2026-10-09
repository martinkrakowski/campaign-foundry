import { describe, expect, test } from "vitest";
import { collectBlocks, type CollectedBlock } from "../lib/collect.js";
import type { DiffInfo } from "../lib/diff.js";

function fileEntry(
  path: string,
  calledNames: string[],
  tables: string[] = [],
  ranges: { baseStart: number; baseCount: number }[] = [],
) {
  return {
    path,
    ranges,
    calledNames: new Set(calledNames),
    tableNames: new Set(tables),
  };
}

describe("tier 1 collects the adapter method behind a port method the change calls", () => {
  test("the block has the right path, symbol, why and text", () => {
    const sources = new Map([
      ["packages/repo/src/repo.port.ts", "interface IUserRepo {\n  findById(id: string): void;\n}"],
      [
        "packages/repo/src/repo.ts",
        "class UserRepo implements IUserRepo {\n  findById(id: string) { return this.dbQuery(id); }\n  other() {}\n}",
      ],
      // A class that does NOT implement IUserRepo — must be skipped by tier1
      ["packages/repo/src/unrelated.ts", "class UnrelatedClass { findById() {} }"],
      // A function (not a method) named findById — must be skipped by tier1
      ["packages/repo/src/extra.ts", "function findById() { return 1; }"],
      // Edge-case decls for collectDecls branch coverage
      [
        "packages/repo/src/edge1.ts",
        "export default class { anon() {} }\nabstract class Abs { abstract act(): void; }",
      ],
      [
        "packages/repo/src/edge2.ts",
        "export default function() { return 1; }\nfunction foo(): void;\nfunction foo(): void { return; }\nconst x = 42;",
      ],
    ]);

    const diff: DiffInfo = {
      files: [
        fileEntry("packages/app/src/api.ts", ["findById"]),
        fileEntry("packages/app/src/api2.ts", ["findById"]),
      ],
      calledNames: new Set(["findById"]),
      tableNames: new Set(),
    };

    const blocks = collectBlocks(sources, diff);

    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.tier).toBe(1);
    expect(b.path).toBe("packages/repo/src/repo.ts");
    expect(b.symbol).toBe("UserRepo.findById");
    expect(b.startLine).toBe(2);
    expect(b.endLine).toBe(2);
    expect(b.why).toBe(
      "implements IUserRepo.findById, called from changed lines of packages/app/src/api.ts",
    );
    expect(b.text).toContain("findById");
  });

  test("a non-port interface method is not collected by tier 1", () => {
    const sources = new Map([
      [
        "packages/repo/user.ts",
        "interface NonRepo { findById(id: string): void; }\nclass UserRepo implements NonRepo {\n  findById(id: string) {} \n}",
      ],
    ]);
    const diff: DiffInfo = {
      files: [fileEntry("packages/app/api.ts", ["findById"])],
      calledNames: new Set(["findById"]),
      tableNames: new Set(),
    };
    expect(collectBlocks(sources, diff)).toEqual([]);
  });

  test("a method not named by any changed file is not collected", () => {
    const sources = new Map([
      ["ports/user.port.ts", "interface IUserRepo { findById(id: string): void; }"],
      ["packages/repo/user.ts", "class UserRepo implements IUserRepo { findById(id: string) {} }"],
    ]);
    const diff: DiffInfo = {
      files: [fileEntry("packages/app/api.ts", ["saveUser"])],
      calledNames: new Set(["saveUser"]),
      tableNames: new Set(),
    };
    expect(collectBlocks(sources, diff)).toEqual([]);
  });
});

describe("tier 2 collects an ownership helper the change calls", () => {
  test("an exported arrow helper and a function helper are both collected", () => {
    const sources = new Map([
      ["packages/repo/auth.ts", "export const assertAllowed = (u: User) => u.role === 'admin';"],
      [
        "packages/repo/ownership.ts",
        "function ownsResource(user: User, res: Resource) { return true; }",
      ],
      // A method named assertAllowed — must be skipped by tier2 (only functions/arrows)
      ["packages/repo/svc.ts", "class Service { assertAllowed() {} }"],
    ]);
    const diff: DiffInfo = {
      files: [fileEntry("packages/app/api.ts", ["assertAllowed", "ownsResource"])],
      calledNames: new Set(["assertAllowed", "ownsResource"]),
      tableNames: new Set(),
    };
    const blocks = collectBlocks(sources, diff);
    expect(blocks).toHaveLength(2);
    const arrow = blocks.find((b) => b.symbol === "assertAllowed")!;
    expect(arrow.tier).toBe(2);
    expect(arrow.path).toBe("packages/repo/auth.ts");
    expect(arrow.why).toBe("helper assertAllowed called from changed lines of packages/app/api.ts");
    const fn = blocks.find((b) => b.symbol === "ownsResource")!;
    expect(fn.tier).toBe(2);
    expect(fn.path).toBe("packages/repo/ownership.ts");
    expect(fn.why).toBe("helper ownsResource called from changed lines of packages/app/api.ts");
  });

  test("a non-exported arrow constant is not collected", () => {
    const sources = new Map([
      ["packages/repo/auth.ts", "const assertAllowed = (u: User) => u.role === 'admin';"],
    ]);
    const diff: DiffInfo = {
      files: [fileEntry("packages/app/api.ts", ["assertAllowed"])],
      calledNames: new Set(["assertAllowed"]),
      tableNames: new Set(),
    };
    expect(collectBlocks(sources, diff)).toEqual([]);
  });

  test("a name that does not match the helper regex is not collected", () => {
    const sources = new Map([
      ["packages/repo/svc.ts", "function validate(input: string) { return true; }"],
    ]);
    const diff: DiffInfo = {
      files: [fileEntry("packages/app/api.ts", ["validate"])],
      calledNames: new Set(["validate"]),
      tableNames: new Set(),
    };
    expect(collectBlocks(sources, diff)).toEqual([]);
  });
});

describe("tier 3 collects a caller one hop out of a changed function", () => {
  test("the block has the right path, symbol, why and text", () => {
    const sources = new Map([
      ["packages/app/api.ts", "function getUsers() { return db.findMany(); }"],
      ["packages/repo/loader.ts", "function loadUsers() { return getUsers(); }"],
    ]);
    const diff: DiffInfo = {
      files: [
        fileEntry(
          "packages/app/api.ts",
          ["getUsers", "findMany"],
          [],
          [{ baseStart: 1, baseCount: 1 }],
        ),
      ],
      calledNames: new Set(["getUsers", "findMany"]),
      tableNames: new Set(),
    };
    const blocks = collectBlocks(sources, diff);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.tier).toBe(3);
    expect(b.path).toBe("packages/repo/loader.ts");
    expect(b.symbol).toBe("loadUsers");
    expect(b.why).toBe("calls getUsers, which this change edits in packages/app/api.ts");
    expect(b.text).toContain("getUsers");
  });

  test("callers with equal body length sort by path then start line", () => {
    const sources = new Map([
      ["packages/app/api.ts", "function getUsers() { return 1; }"],
      ["packages/repo/c2.ts", "function callerC() { getUsers(); }"],
      [
        "packages/repo/c1.ts",
        "function callerA() { getUsers(); }\nfunction callerB() { getUsers(); }",
      ],
    ]);
    const diff: DiffInfo = {
      files: [fileEntry("packages/app/api.ts", [], [], [{ baseStart: 1, baseCount: 1 }])],
      calledNames: new Set(),
      tableNames: new Set(),
    };
    const blocks = collectBlocks(sources, diff);
    const tier3 = blocks.filter((b) => b.tier === 3);
    expect(tier3.length).toBe(3);
    const paths = tier3.map((b) => `${b.path}:${b.startLine}`);
    expect(paths).toEqual([
      "packages/repo/c1.ts:1",
      "packages/repo/c1.ts:2",
      "packages/repo/c2.ts:1",
    ]);
  });

  test("callers with different body lengths sort by body length first", () => {
    const sources = new Map([
      ["packages/app/api.ts", "function getUsers() { return 1; }"],
      ["packages/repo/a.ts", "function short() { return getUsers(); }"],
      ["packages/repo/b.ts", "function longName() { const x = 1; return getUsers(); }"],
    ]);
    const diff: DiffInfo = {
      files: [fileEntry("packages/app/api.ts", [], [], [{ baseStart: 1, baseCount: 1 }])],
      calledNames: new Set(),
      tableNames: new Set(),
    };
    const blocks = collectBlocks(sources, diff);
    const tier3 = blocks.filter((b) => b.tier === 3);
    expect(tier3).toHaveLength(2);
    // short has smaller bodyText → listed first (both reached is 0, path tie-break a.ts < b.ts)
    expect(tier3[0]?.symbol).toBe("short");
    expect(tier3[1]?.symbol).toBe("longName");
  });

  test("callers from four files with equal body length sort by path", () => {
    const sources = new Map([
      ["packages/app/api.ts", "function getUsers() { return 1; }"],
      ["packages/repo/b.ts", "function callB() { getUsers(); }"],
      ["packages/repo/a.ts", "function callA() { getUsers(); }"],
      ["packages/repo/d.ts", "function callD() { getUsers(); }"],
      ["packages/repo/c.ts", "function callC() { getUsers(); }"],
    ]);
    const diff: DiffInfo = {
      files: [fileEntry("packages/app/api.ts", [], [], [{ baseStart: 1, baseCount: 1 }])],
      calledNames: new Set(),
      tableNames: new Set(),
    };
    const blocks = collectBlocks(sources, diff);
    const tier3 = blocks.filter((b) => b.tier === 3);
    expect(tier3).toHaveLength(4);
    expect(tier3.map((b) => b.symbol)).toEqual(["callA", "callB", "callC", "callD"]);
  });

  test("a method caller is rendered with ClassName.method symbol", () => {
    const sources = new Map([
      ["packages/app/api.ts", "function getUsers() { return 1; }"],
      ["packages/repo/loader.ts", "class Loader { call() { return getUsers(); } }"],
    ]);
    const diff: DiffInfo = {
      files: [fileEntry("packages/app/api.ts", ["getUsers"], [], [{ baseStart: 1, baseCount: 1 }])],
      calledNames: new Set(["getUsers"]),
      tableNames: new Set(),
    };
    const blocks = collectBlocks(sources, diff);
    const tier3 = blocks.filter((b) => b.tier === 3);
    expect(tier3).toHaveLength(1);
    expect(tier3[0]?.symbol).toBe("Loader.call");
  });
});

describe("tier 4 collects an unchanged writer of the same table in a changed file", () => {
  test("the block has the right path, symbol, why and text", () => {
    const sources = new Map([
      [
        "packages/repo/audit.ts",
        'function writeAudit(user) { db.insertInto("audit_log"); return; }\n' +
          "function changedFn() { return 1; }\n" +
          'function alsoWritesAudit() { db.insertInto("audit_log"); return; }\n' +
          "function unrelated() { return 2; }",
      ],
      [
        "apps/api/server/lib/db/migrations/0001_audit.sql",
        "CREATE TABLE audit_log (\n  id SERIAL\n);",
      ],
    ]);
    const diff: DiffInfo = {
      files: [
        fileEntry(
          "packages/repo/audit.ts",
          ["writeAudit"],
          ["audit_log"],
          [{ baseStart: 2, baseCount: 1 }],
        ),
      ],
      calledNames: new Set(["writeAudit"]),
      tableNames: new Set(["audit_log"]),
    };
    const blocks = collectBlocks(sources, diff);
    const tier4 = blocks.filter((b) => b.tier === 4);
    expect(tier4).toHaveLength(2);
    const writeBlock = tier4.find((b) => b.symbol === "writeAudit")!;
    expect(writeBlock.tier).toBe(4);
    expect(writeBlock.path).toBe("packages/repo/audit.ts");
    expect(writeBlock.why).toBe(
      "unchanged in packages/repo/audit.ts, also touches table audit_log",
    );
    expect(writeBlock.text).toContain("writeAudit");
    const alsoBlock = tier4.find((b) => b.symbol === "alsoWritesAudit")!;
    expect(alsoBlock.tier).toBe(4);
  });
});

describe("tier 5 collects the sibling adapter's method of the same name", () => {
  test("the block has the right path, symbol, why and text", () => {
    const sources = new Map([
      ["packages/repo/types.ts", "interface IRepo { save(data: string): void; }"],
      [
        "packages/app/repo.ts",
        "class Repo implements IRepo {\n  save(data: string) { return data; }\n}\n" +
          "function changedFn() { return 1; }",
      ],
      [
        "packages/repo/other.ts",
        'class OtherRepo implements IRepo {\n  save(data: string) { return "other"; }\n}',
      ],
    ]);
    const diff: DiffInfo = {
      files: [
        fileEntry(
          "packages/app/repo.ts",
          ["save"],
          [],
          [
            { baseStart: 2, baseCount: 1 },
            { baseStart: 4, baseCount: 1 },
          ],
        ),
      ],
      calledNames: new Set(["save"]),
      tableNames: new Set(),
    };
    const blocks = collectBlocks(sources, diff);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.tier).toBe(5);
    expect(b.path).toBe("packages/repo/other.ts");
    expect(b.symbol).toBe("OtherRepo.save");
    expect(b.why).toBe("sibling of Repo.save (both implement IRepo)");
    expect(b.text).toContain("save");
  });
});

describe("tier 5 skips non-matching siblings", () => {
  test("classes implementing the wrong interface, with wrong name, or non-methods are skipped", () => {
    const sources = new Map([
      ["packages/repo/types.ts", "interface IRepo { save(d: string): void; load(): void; }"],
      [
        "packages/app/repo.ts",
        "class Repo implements IRepo, UnknownIFace {\n  save(d: string) {}\n  load() {}\n  extra() {}\n}\nfunction helperFn() {}",
      ],
      ["packages/repo/noimpl.ts", "class NoImpl { save() {} }"],
      ["packages/repo/diffname.ts", "class DifferentName implements IRepo { load() {} }"],
      ["packages/repo/same.ts", "class SameName implements IRepo { save() {} }"],
    ]);
    const diff: DiffInfo = {
      files: [fileEntry("packages/app/repo.ts", ["save"], [], [{ baseStart: 2, baseCount: 5 }])],
      calledNames: new Set(["save"]),
      tableNames: new Set(),
    };
    const blocks = collectBlocks(sources, diff);
    const tier5 = blocks.filter((b) => b.tier === 5);
    expect(tier5).toHaveLength(2);
    expect(tier5.find((b) => b.symbol === "SameName.save")).toBeDefined();
    expect(tier5.find((b) => b.symbol === "DifferentName.load")).toBeDefined();
  });
});

describe("tier 6 collects the CREATE TABLE statement for a table the change names", () => {
  test("the block has the right path, symbol, why and text", () => {
    const sources = new Map([
      [
        "apps/api/server/lib/db/migrations/0001_org.sql",
        "CREATE TABLE orders (\n  id SERIAL PRIMARY KEY,\n  name TEXT\n);",
      ],
      ["packages/app/api.ts", "function updateStatus(id) { return id; }"],
    ]);
    const diff: DiffInfo = {
      files: [
        fileEntry("packages/app/api.ts", [], ["orders"], [{ baseStart: 1, baseCount: 1 }]),
        fileEntry("packages/app/api2.ts", [], ["orders"], [{ baseStart: 1, baseCount: 1 }]),
      ],
      calledNames: new Set(),
      tableNames: new Set(["orders"]),
    };
    const blocks = collectBlocks(sources, diff);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.tier).toBe(6);
    expect(b.path).toBe("apps/api/server/lib/db/migrations/0001_org.sql");
    expect(b.symbol).toBe("orders");
    expect(b.why).toBe("table orders is named in the change");
    expect(b.text).toContain("CREATE TABLE");
    expect(b.startLine).toBe(1);
    expect(b.endLine).toBe(4);
  });

  test("a table name not in the migrations yields no block", () => {
    const sources = new Map([
      [
        "apps/api/server/lib/db/migrations/0001_org.sql",
        "CREATE TABLE orders (\n  id SERIAL\n);\n",
      ],
    ]);
    const diff: DiffInfo = {
      files: [
        fileEntry("packages/app/api.ts", [], ["nonexistent"], [{ baseStart: 1, baseCount: 1 }]),
      ],
      calledNames: new Set(),
      tableNames: new Set(["nonexistent"]),
    };
    expect(collectBlocks(sources, diff)).toEqual([]);
  });

  test("CREATE TABLE without a closing ); yields no block", () => {
    const sources = new Map([
      ["apps/api/server/lib/db/migrations/0001_org.sql", "CREATE TABLE broken (\n  id SERIAL\n"],
    ]);
    const diff: DiffInfo = {
      files: [fileEntry("packages/app/api.ts", [], ["broken"], [{ baseStart: 1, baseCount: 1 }])],
      calledNames: new Set(),
      tableNames: new Set(["broken"]),
    };
    expect(collectBlocks(sources, diff)).toEqual([]);
  });
});

describe("collect blocks", () => {
  test("a block inside a changed hunk is not collected", () => {
    const sources = new Map([
      ["ports/user.port.ts", "interface IUserRepo { findById(id: string): void; }"],
      [
        "packages/repo/user.ts",
        "class UserRepo implements IUserRepo {\n  findById(id: string) {}\n}",
      ],
    ]);
    const diff: DiffInfo = {
      files: [
        fileEntry("packages/app/api.ts", ["findById"]),
        fileEntry("packages/repo/user.ts", [], [], [{ baseStart: 2, baseCount: 1 }]),
      ],
      calledNames: new Set(["findById"]),
      tableNames: new Set(),
    };
    expect(collectBlocks(sources, diff)).toEqual([]);
  });

  test("a body longer than 120 lines is cut and says so", () => {
    const body = Array.from({ length: 120 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const sources = new Map([["packages/repo/helper.ts", `function ownsResource() {\n${body}\n}`]]);
    const diff: DiffInfo = {
      files: [fileEntry("packages/app/api.ts", ["ownsResource"])],
      calledNames: new Set(["ownsResource"]),
      tableNames: new Set(),
    };
    const blocks = collectBlocks(sources, diff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toContain("// … cut at 120 lines");
    expect(blocks[0]?.text).not.toContain("v119");
  });

  test("the same inputs give a byte-identical result", () => {
    const sources = new Map([
      ["ports/user.port.ts", "interface IRepo { save(data: string): void; }"],
      [
        "packages/repo/repo.ts",
        "class Repo implements IRepo {\n  save(data: string) { return data; }\n}",
      ],
    ]);
    const diff: DiffInfo = {
      files: [fileEntry("packages/app/api.ts", ["save"])],
      calledNames: new Set(["save"]),
      tableNames: new Set(),
    };
    const a = collectBlocks(sources, diff);
    const b = collectBlocks(sources, diff);
    expect(a).toEqual(b);
  });

  test("blocks with the same reach sort by path then start line", () => {
    const sources = new Map([
      ["packages/repo/a.ts", "export const ownsA = () => 1;\nexport const ownsB = () => 2;"],
      ["packages/repo/b.ts", "export const ownsA = () => 1;\nexport const ownsB = () => 2;"],
    ]);
    const diff: DiffInfo = {
      files: [
        fileEntry("packages/app/api.ts", ["ownsA"]),
        fileEntry("packages/app/b.api.ts", ["ownsB"]),
      ],
      calledNames: new Set(["ownsA", "ownsB"]),
      tableNames: new Set(),
    };
    const blocks = collectBlocks(sources, diff);
    expect(blocks).toHaveLength(4);
    // Same reach (1), sorted by path then start line:
    // a.ts line 1 (ownsA), a.ts line 2 (ownsB), b.ts line 1 (ownsA), b.ts line 2 (ownsB)
    expect(blocks[0]?.path).toBe("packages/repo/a.ts");
    expect(blocks[0]?.startLine).toBe(1);
    expect(blocks[1]?.path).toBe("packages/repo/a.ts");
    expect(blocks[1]?.startLine).toBe(2);
    expect(blocks[2]?.path).toBe("packages/repo/b.ts");
    expect(blocks[2]?.startLine).toBe(1);
    expect(blocks[3]?.path).toBe("packages/repo/b.ts");
    expect(blocks[3]?.startLine).toBe(2);
  });
});

describe("a declaration with no body is skipped and the rest is still collected", () => {
  test("a declare function with no body does not break collection", () => {
    const sources = new Map([
      ["packages/repo/src/decl.ts", "declare function resolveOwner(id: string): string;"],
      ["packages/repo/src/impl.ts", "function resolveOwner(id: string) { return id; }"],
    ]);
    const diff: DiffInfo = {
      files: [fileEntry("packages/app/api.ts", ["resolveOwner"])],
      calledNames: new Set(["resolveOwner"]),
      tableNames: new Set(),
    };
    const blocks = collectBlocks(sources, diff);
    // resolveOwner in impl.ts is collected (tier 2); the declare is skipped
    expect(blocks.some((b) => b.symbol === "resolveOwner")).toBe(true);
  });
});

describe("table name filtering", () => {
  test("a word after from in a comment is not treated as a table", () => {
    const sources = new Map([
      ["packages/repo/src/audit.ts", "function logUser() { /* from the db */ return; }"],
    ]);
    const diff: DiffInfo = {
      files: [
        fileEntry("packages/repo/src/audit.ts", [], ["the"], [{ baseStart: 1, baseCount: 1 }]),
      ],
      calledNames: new Set(),
      tableNames: new Set(["the"]),
    };
    expect(collectBlocks(sources, diff)).toEqual([]);
  });

  test("a table the base migrations create is still treated as a table", () => {
    const sources = new Map([
      [
        "packages/app/src/api.ts",
        'function writeOrder(o) { db.insertInto("orders"); return o; }\n' +
          "function changedFn() { return 1; }",
      ],
      ["apps/api/server/lib/db/migrations/0001.sql", "CREATE TABLE orders (\n  id SERIAL\n);"],
      ["apps/api/server/lib/db/migrations/0002.sql", "CREATE TABLE products (\n  id SERIAL\n);"],
    ]);
    const diff: DiffInfo = {
      files: [
        fileEntry("packages/app/src/api.ts", [], ["orders"], [{ baseStart: 2, baseCount: 1 }]),
      ],
      calledNames: new Set(),
      tableNames: new Set(["orders"]),
    };
    const blocks = collectBlocks(sources, diff);
    const tier6 = blocks.filter((b) => b.tier === 6);
    expect(tier6).toHaveLength(1);
    expect(tier6[0]?.symbol).toBe("orders");
    expect(tier6[0]?.path).toBe("apps/api/server/lib/db/migrations/0001.sql");
  });
});
