import { describe, expect, test } from "vitest";
import type { Manifest as HexManifest } from "@hexagen-monaco/sync";
import { fromHexagen } from "../manifest.js";
import { PACKAGE_ROOT, checkInventory, type Tree } from "../inventory.js";

const HEX: HexManifest = {
  generator: {
    sync: {
      layers: {
        domain: { folder: "src/domain" },
        application: { folder: "src/application" },
        infrastructure: { folder: "src/infrastructure" },
      },
      stubs: {
        enabled: true,
        naming: { inPort: "{name}.ts", outPort: "{name}.ts", adapter: "{name}.ts" },
      },
    },
  },
  bounded_contexts: [
    {
      name: "Demo",
      layers: {
        domain: {
          entities: ["Widget"],
          value_objects: ["Money"],
          domain_services: [],
        },
        application: {
          use_cases: ["DoThingUseCase"],
          ports: { in: ["DemoPipelinePort"], out: ["StorePort"] },
        },
        infrastructure: { adapters: [] },
      },
    },
  ],
};

const MANIFEST = fromHexagen(HEX);

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

const check = async (t: Tree, manifest = MANIFEST) =>
  checkInventory(manifest, { listDir: listDirOf(t) });

describe("checkInventory", () => {
  test("a matching manifest and tree produce no findings", async () => {
    expect(await check(CLEAN)).toEqual([]);
  });

  test("a declared entry with no module file is stale, per context and list", async () => {
    const t = structuredClone(CLEAN);
    t["packages/Demo/src/domain/entities"] = ["index.ts"];
    const findings = await check(t);
    expect(findings).toEqual([
      { context: "Demo", list: "entities", missing: [], stale: ["Widget"], duplicates: [] },
    ]);
  });

  test("a port module with no declared entry is missing", async () => {
    const t = structuredClone(CLEAN);
    t["packages/Demo/src/application/ports/out"] = ["StorePort.ts", "ExporterPort.ts", "index.ts"];
    const findings = await check(t);
    expect(findings).toEqual([
      { context: "Demo", list: "ports.out", missing: ["ExporterPort"], stale: [], duplicates: [] },
    ]);
  });

  test("an inbound port file with no declared entry is missing too", async () => {
    const t = structuredClone(CLEAN);
    t["packages/Demo/src/application/ports/in"] = ["DemoPipelinePort.ts", "QueryPort.ts"];
    const findings = await check(t);
    expect(findings).toEqual([
      { context: "Demo", list: "ports.in", missing: ["QueryPort"], stale: [], duplicates: [] },
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

  test("a directory that fails for another reason is not silently empty", async () => {
    await expect(
      checkInventory(MANIFEST, {
        listDir: async (dir) => {
          if (dir.endsWith("adapters")) {
            throw Object.assign(new Error(`EACCES: ${dir}`), { code: "EACCES" });
          }
          return [];
        },
      }),
    ).rejects.toThrow(/EACCES/);
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
      { context: "Demo", list: "value_objects", missing: [], stale: ["Money"], duplicates: [] },
      { context: "Demo", list: "use_cases", missing: ["ExtraUseCase"], stale: [], duplicates: [] },
    ]);
  });

  test("a declared entry naming a file the generator would not produce is stale", async () => {
    const m = fromHexagen({
      bounded_contexts: [{ name: "Demo", layers: { domain: { value_objects: ["Currency"] } } }],
    });
    const t = tree({ "packages/Demo/src/domain/value-objects": ["money.vo.ts"] });
    const findings = await checkInventory(m, { listDir: listDirOf(t) });
    expect(findings).toEqual([
      { context: "Demo", list: "value_objects", missing: [], stale: ["Currency"], duplicates: [] },
    ]);
  });

  test("a kebab-case declared entry is normalised to match its PascalCase file", async () => {
    const m = fromHexagen({
      bounded_contexts: [{ name: "Demo", layers: { domain: { value_objects: ["user-repo"] } } }],
    });
    const t = tree({ "packages/Demo/src/domain/value-objects": ["UserRepo.vo.ts"] });
    expect(await checkInventory(m, { listDir: listDirOf(t) })).toEqual([]);
  });

  test("two declared entries that resolve to the same file are duplicates", async () => {
    const m = fromHexagen({
      bounded_contexts: [
        { name: "Demo", layers: { domain: { value_objects: ["Money", "money"] } } },
      ],
    });
    const t = tree({ "packages/Demo/src/domain/value-objects": ["Money.vo.ts"] });
    const findings = await checkInventory(m, { listDir: listDirOf(t) });
    expect(findings).toEqual([
      {
        context: "Demo",
        list: "value_objects",
        missing: [],
        stale: [],
        duplicates: ["Money", "money"],
      },
    ]);
  });

  test("a literal repeat in the same list is a duplicate", async () => {
    const m = fromHexagen({
      generator: { sync: { stubs: { naming: { adapter: "{name}.ts" } } } },
      bounded_contexts: [
        {
          name: "Demo",
          layers: { infrastructure: { adapters: ["NodeThingAdapter", "NodeThingAdapter"] } },
        },
      ],
    });
    const t = tree({ "packages/Demo/src/infrastructure/adapters": ["NodeThingAdapter.ts"] });
    const findings = await checkInventory(m, { listDir: listDirOf(t) });
    expect(findings).toEqual([
      {
        context: "Demo",
        list: "adapters",
        missing: [],
        stale: [],
        duplicates: ["NodeThingAdapter"],
      },
    ]);
  });

  test("a bare {name} naming template does not collapse every entry into one file", async () => {
    const m = fromHexagen({
      generator: { sync: { stubs: { naming: { valueObject: "{name}" } } } },
      bounded_contexts: [
        { name: "Demo", layers: { domain: { value_objects: ["Widget", "Money"] } } },
      ],
    });
    const t = tree({ "packages/Demo/src/domain/value-objects": ["Widget", "Money"] });
    expect(await checkInventory(m, { listDir: listDirOf(t) })).toEqual([]);
  });

  test("a naming template with a directory component is read from that offset, not the list's own folder", async () => {
    const m = fromHexagen({
      generator: { sync: { stubs: { naming: { adapter: "sub/{name}.ts" } } } },
      bounded_contexts: [{ name: "Demo", layers: { infrastructure: { adapters: ["Foo"] } } }],
    });
    const t = tree({ "packages/Demo/src/infrastructure/adapters/sub": ["Foo.ts"] });
    expect(await checkInventory(m, { listDir: listDirOf(t) })).toEqual([]);
  });

  test("PACKAGE_ROOT is the workspaces prefix the manifest declares", () => {
    expect(PACKAGE_ROOT).toBe("packages");
  });
});
