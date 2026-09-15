import { describe, expect, test } from "vitest";
import type { Manifest as HexManifest } from "@hexagen-monaco/sync";
import { DEFAULT_NAMING } from "../naming.js";
import { fromHexagen } from "../manifest.js";

describe("fromHexagen", () => {
  test("reads the inventories, the layer folders, the stub naming and the scope", () => {
    const hex: HexManifest = {
      scope: "campaignfoundry",
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
          type: "core",
          layers: {
            domain: {
              entities: ["Widget"],
              value_objects: ["Money"],
              domain_services: [],
            },
            application: {
              use_cases: ["DoThingUseCase"],
              ports: { in: ["DemoPipelinePort"], out: [] },
            },
            infrastructure: { adapters: ["NodeThingAdapter"] },
          },
        },
      ],
    };
    const m = fromHexagen(hex);
    expect(m.scope).toBe("campaignfoundry");
    expect(m.contexts).toHaveLength(1);
    const demo = m.contexts[0]!;
    expect(demo.name).toBe("Demo");
    expect(demo.lists["ports.in"]).toEqual(["DemoPipelinePort"]);
    expect(demo.lists.adapters).toEqual(["NodeThingAdapter"]);
    expect(demo.lists.domain_services).toEqual([]);
    expect(m.folders.application).toBe("src/application");
    expect(demo.naming.inPort).toBe("{name}.ts");
    expect(demo.naming.entity).toBe(DEFAULT_NAMING.entity);
  });

  test("defaults the folders, the naming and the scope when no generator block exists", () => {
    const m = fromHexagen({ bounded_contexts: [{ name: "Demo" }] });
    expect(m.folders).toEqual({
      domain: "src/domain",
      application: "src/application",
      infrastructure: "src/infrastructure",
    });
    expect(m.scope).toBe("generated-project");
    const demo = m.contexts[0]!;
    expect(demo.naming).toEqual(DEFAULT_NAMING);
    expect(demo.lists.entities).toEqual([]);
    expect(demo.lists["ports.out"]).toEqual([]);
  });

  test("defaults to no contexts when bounded_contexts is absent", () => {
    expect(fromHexagen({})).toEqual({
      contexts: [],
      folders: { domain: "src/domain", application: "src/application", infrastructure: "src/infrastructure" },
      scope: "generated-project",
    });
  });

  test("accepts the owned-port object form { name, owner }", () => {
    const m = fromHexagen({
      bounded_contexts: [
        {
          name: "Demo",
          layers: {
            application: {
              ports: {
                in: [{ name: "DemoPipelinePort", owner: "Demo" }],
                out: ["LegacyStorePort"],
              },
            },
          },
        },
      ],
    });
    expect(m.contexts[0]!.lists["ports.in"]).toEqual(["DemoPipelinePort"]);
    expect(m.contexts[0]!.lists["ports.out"]).toEqual(["LegacyStorePort"]);
  });

  test("a context's own generator.stubs.naming overrides the manifest-wide naming", () => {
    const m = fromHexagen({
      generator: { sync: { stubs: { naming: { adapter: "{name}.ts" } } } },
      bounded_contexts: [
        { name: "Global" },
        { name: "Local", generator: { stubs: { naming: { adapter: "{name}.custom.ts" } } } },
      ],
    });
    expect(m.contexts[0]!.naming.adapter).toBe("{name}.ts");
    expect(m.contexts[1]!.naming.adapter).toBe("{name}.custom.ts");
    // Kinds the context does not override still fall through to the global naming.
    expect(m.contexts[1]!.naming.inPort).toBe(DEFAULT_NAMING.inPort);
  });

  test("rejects a stub naming template without {name}, naming the context and the kind", () => {
    expect(() =>
      fromHexagen({
        generator: { sync: { stubs: { naming: { inPort: "fixed.ts" } } } },
        bounded_contexts: [{ name: "Demo" }],
      }),
    ).toThrow(/Demo.*inPort/s);
  });

  test("an empty configured folder falls back to the default, not a leading double slash", () => {
    const m = fromHexagen({
      generator: { sync: { layers: { domain: { folder: "" } } } },
      bounded_contexts: [],
    });
    expect(m.folders.domain).toBe("src/domain");
  });
});
