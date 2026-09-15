import { describe, expect, test } from "vitest";
import { parseManifest } from "../manifest.js";
import { PACKAGE_ROOT, checkInventory, type Tree } from "../inventory.js";

const MANIFEST = parseManifest(`
generator:
  sync:
    layers:
      domain: { folder: src/domain, subfolders: [entities, value-objects] }
      application: { folder: src/application, subfolders: [use-cases, ports/in, ports/out] }
      infrastructure: { folder: src/infrastructure, subfolders: [adapters] }
    stubs:
      enabled: true
      naming:
        inPort: "{name}.ts"
        outPort: "{name}.ts"
        adapter: "{name}.ts"
bounded_contexts:
  - name: Demo
    layers:
      domain:
        entities: [Widget]
        value_objects: [Money]
        domain_services: []
      application:
        use_cases: [DoThingUseCase]
        ports:
          in: [DemoPipelinePort]
          out: [StorePort]
      infrastructure:
        adapters: []
`);

const tree = (t: Tree) => t;

/** A tree that matches the manifest exactly, barrel files included. */
const CLEAN = tree({
  "packages/Demo/src/domain/entities": ["Widget.ts", "index.ts"],
  "packages/Demo/src/domain/value-objects": ["Money.vo.ts", "money-data.ts", "index.ts"],
  "packages/Demo/src/domain/services": [],
  "packages/Demo/src/application/use-cases": [
    "DoThingUseCase.use-case.ts",
    "SupportHelper.ts",
    "index.ts",
  ],
  "packages/Demo/src/application/ports/in": ["DemoPipelinePort.ts", "index.ts"],
  "packages/Demo/src/application/ports/out": ["StorePort.ts", "index.ts"],
  "packages/Demo/src/infrastructure/adapters": ["index.ts"],
});

const listDirOf =
  (t: Tree) =>
  async (dir: string): Promise<readonly string[]> => {
    const entries = t[dir];
    if (entries === undefined) {
      throw Object.assign(new Error(`ENOENT: no such directory, ${dir}`), { code: "ENOENT" });
    }
    return entries;
  };

const check = async (t: Tree) => checkInventory(MANIFEST, { listDir: listDirOf(t) });

describe("checkInventory", () => {
  test("a matching manifest and tree produce no findings", async () => {
    expect(await check(CLEAN)).toEqual([]);
  });

  test("a declared entry with no module file is stale, per context and list", async () => {
    const t = structuredClone(CLEAN);
    t["packages/Demo/src/domain/entities"] = ["index.ts"];
    const findings = await check(t);
    expect(findings).toEqual([
      { context: "Demo", list: "entities", missing: [], stale: ["Widget"] },
    ]);
  });

  test("a port module with no declared entry is missing", async () => {
    const t = structuredClone(CLEAN);
    t["packages/Demo/src/application/ports/out"] = ["StorePort.ts", "ExporterPort.ts", "index.ts"];
    const findings = await check(t);
    expect(findings).toEqual([
      { context: "Demo", list: "ports.out", missing: ["ExporterPort"], stale: [] },
    ]);
  });

  test("an inbound port file with no declared entry is missing too", async () => {
    const t = structuredClone(CLEAN);
    t["packages/Demo/src/application/ports/in"] = ["DemoPipelinePort.ts", "QueryPort.ts"];
    const findings = await check(t);
    expect(findings).toEqual([
      { context: "Demo", list: "ports.in", missing: ["QueryPort"], stale: [] },
    ]);
  });

  test("the generator cannot emit kebab-case modules, so they are not drift", async () => {
    const t = structuredClone(CLEAN);
    t["packages/Demo/src/domain/value-objects"] = ["Money.vo.ts", "currency-codes.ts"];
    t["packages/Demo/src/infrastructure/adapters"] = ["canvas-util.ts"];
    expect(await check(t)).toEqual([]);
  });

  test("a use-case folder file without the .use-case suffix is not a module", async () => {
    const t = structuredClone(CLEAN);
    t["packages/Demo/src/application/use-cases"] = [
      "DoThingUseCase.use-case.ts",
      "PlanCapacity.ts",
    ];
    expect(await check(t)).toEqual([]);
  });

  test("a folder that does not exist on disk holds no undeclared modules", async () => {
    const t = structuredClone(CLEAN);
    delete t["packages/Demo/src/domain/services"];
    delete t["packages/Demo/src/infrastructure/adapters"];
    expect(await check(t)).toEqual([]);
  });

  test("missing and stale findings carry the context and list they belong to", async () => {
    const t = structuredClone(CLEAN);
    t["packages/Demo/src/domain/value-objects"] = ["index.ts"];
    t["packages/Demo/src/application/use-cases"] = [
      "DoThingUseCase.use-case.ts",
      "ExtraUseCase.use-case.ts",
    ];
    const findings = await check(t);
    expect(findings).toEqual([
      { context: "Demo", list: "value_objects", missing: [], stale: ["Money"] },
      { context: "Demo", list: "use_cases", missing: ["ExtraUseCase"], stale: [] },
    ]);
  });

  test("a declared entry naming a file the generator would not produce is stale", async () => {
    const m = parseManifest("bounded_contexts:\n  - name: Demo\n    layers:\n      domain:\n        value_objects: [Currency]\n");
    const t = tree({ "packages/Demo/src/domain/value-objects": ["money.vo.ts"] });
    const findings = await checkInventory(m, { listDir: listDirOf(t) });
    expect(findings).toEqual([
      { context: "Demo", list: "value_objects", missing: [], stale: ["Currency"] },
    ]);
  });

  test("PACKAGE_ROOT is the workspaces prefix the manifest declares", () => {
    expect(PACKAGE_ROOT).toBe("packages");
  });
});
