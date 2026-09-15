import { describe, expect, test } from "vitest";
import { parseManifest } from "../manifest.js";

const FULL = `
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
    type: core
    layers:
      domain:
        entities: [Widget]
        value_objects: [Money]
        domain_services: []
      application:
        use_cases: [DoThingUseCase]
        ports:
          in: [DemoPipelinePort]
          out: []
      infrastructure:
        adapters: [NodeThingAdapter]
`;

describe("parseManifest", () => {
  test("reads the inventories, the layer folders and the stub naming", () => {
    const m = parseManifest(FULL);
    expect(m.contexts).toHaveLength(1);
    const demo = m.contexts[0]!;
    expect(demo.name).toBe("Demo");
    expect(demo.lists["ports.in"]).toEqual(["DemoPipelinePort"]);
    expect(demo.lists.adapters).toEqual(["NodeThingAdapter"]);
    expect(demo.lists.domain_services).toEqual([]);
    expect(m.folders.application).toBe("src/application");
    expect(m.naming.inPort).toBe("{name}.ts");
    expect(m.naming.entity).toBeUndefined();
  });

  test("defaults the folders and leaves the naming empty when no generator block exists", () => {
    const m = parseManifest("bounded_contexts:\n  - name: Demo\n");
    expect(m.folders).toEqual({
      domain: "src/domain",
      application: "src/application",
      infrastructure: "src/infrastructure",
    });
    expect(m.naming).toEqual({});
    const demo = m.contexts[0]!;
    expect(demo.lists.entities).toEqual([]);
    expect(demo.lists["ports.out"]).toEqual([]);
  });

  test("keeps a YAML anchor/alias graph intact", () => {
    const m = parseManifest(
      "apps:\n  - name: web\n    depends_on: &ctxs [Demo]\nbounded_contexts:\n  - name: Demo\n",
    );
    expect(m.contexts[0]!.name).toBe("Demo");
  });

  test("rejects a document that is not an object", () => {
    expect(() => parseManifest("- one\n- two\n")).toThrow(/bounded_contexts/);
  });

  test("rejects a bounded context without a name", () => {
    expect(() => parseManifest("bounded_contexts:\n  - type: core\n")).toThrow(/Demo|name/);
  });

  test("rejects a context list that is not an array of strings", () => {
    expect(() =>
      parseManifest("bounded_contexts:\n  - name: Demo\n    layers:\n      domain:\n        entities: [12]\n"),
    ).toThrow(/entities/);
  });

  test("rejects a stub-naming template without {name}", () => {
    expect(() =>
      parseManifest(
        "generator:\n  sync:\n    stubs:\n      naming:\n        inPort: fixed.ts\nbounded_contexts: []\n",
      ),
    ).toThrow(/inPort/);
  });

  test("surfaces invalid YAML as a manifest error", () => {
    expect(() => parseManifest("bounded_contexts: [oops")).toThrow(/YAML/i);
  });
});
