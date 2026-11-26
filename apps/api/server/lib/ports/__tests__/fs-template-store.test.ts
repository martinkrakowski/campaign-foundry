import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_TEMPLATES,
  type CreativeTemplate,
  TemplateWriteUnsupportedError,
} from "@campaignfoundry/CampaignOrchestration";
import { FsTemplateStore } from "../fs-template-store.js";
import { getTemplateStore, resetTemplateStore, setTemplateStore } from "../index.js";

import { LOCAL_TENANT } from "../../tenant.js";
describe("FsTemplateStore", () => {
  test("listTemplates returns the three canonical seeds with layers in declared order", async () => {
    const store = new FsTemplateStore();
    const templates = await store.listTemplates();

    expect(templates.map((t) => t.id)).toEqual([
      "canonical-image-text",
      "canonical-image-html",
      "canonical-video",
    ]);

    // Pinned literally so a reorder in CANONICAL_TEMPLATES fails here:
    // array position is z-order, bottom first (D128).
    expect(templates[0].layers.map((l) => l.id)).toEqual([
      "image",
      "shade",
      "accent",
      "static-text",
      "logo",
    ]);
    expect(templates[1].layers.map((l) => l.id)).toEqual([
      "image",
      "shade",
      "accent",
      "static-text",
      "logo",
    ]);
    expect(templates[2].layers.map((l) => l.id)).toEqual([
      "video",
      "shade",
      "animated-text",
      "logo",
    ]);
  });

  test("findTemplate without a version returns the highest version present", async () => {
    const v1 = CANONICAL_TEMPLATES["image-text"];
    const v2: CreativeTemplate = { ...v1, version: 2 };
    const v3: CreativeTemplate = { ...v1, version: 3 };
    const store = new FsTemplateStore([v1, v3, v2]);

    const found = await store.findTemplate("canonical-image-text");
    expect(found?.version).toBe(3);
  });

  test("findTemplate with an exact version returns that version", async () => {
    const v1 = CANONICAL_TEMPLATES["image-text"];
    const v3: CreativeTemplate = { ...v1, version: 3 };
    const store = new FsTemplateStore([v1, v3]);

    expect((await store.findTemplate("canonical-image-text", 1))?.version).toBe(1);
    expect((await store.findTemplate("canonical-image-text", 3))?.version).toBe(3);
  });

  test("findTemplate with an unknown version returns undefined, never the highest", async () => {
    const store = new FsTemplateStore();

    expect(await store.findTemplate("canonical-image-text", 99)).toBeUndefined();
  });

  test("findTemplate with an unknown id returns undefined", async () => {
    const store = new FsTemplateStore();

    expect(await store.findTemplate("no-such-template")).toBeUndefined();
    expect(await store.findTemplate("no-such-template", 1)).toBeUndefined();
  });

  test("exists agrees with findTemplate for known id, unknown id, known version, unknown version", async () => {
    const store = new FsTemplateStore();
    const cases: ReadonlyArray<readonly [string, number | undefined]> = [
      ["canonical-image-text", undefined],
      ["no-such-template", undefined],
      ["canonical-image-text", 1],
      ["canonical-image-text", 99],
    ];

    for (const [id, version] of cases) {
      const found = await store.findTemplate(id, version);
      expect(await store.exists(id, version)).toBe(found !== undefined);
    }

    expect(await store.exists("canonical-image-text")).toBe(true);
    expect(await store.exists("no-such-template")).toBe(false);
    expect(await store.exists("canonical-image-text", 1)).toBe(true);
    expect(await store.exists("canonical-image-text", 99)).toBe(false);
  });

  test("a returned template is frozen: mutating it throws and a second read still sees the original", async () => {
    const store = new FsTemplateStore();
    const template = await store.findTemplate("canonical-image-text");
    expect(template).toBeDefined();

    // The template object, its layers array, and each layer are all frozen,
    // so a mutation throws in strict mode and is impossible in TypeScript.
    const mutable = template as unknown as { name: string; layers: unknown[] };
    expect(() => {
      mutable.name = "mutated";
    }).toThrow();
    expect(() => {
      mutable.layers.push({ id: "sneaky" });
    }).toThrow();
    const firstLayer = template?.layers[0] as unknown as { id: string };
    expect(() => {
      firstLayer.id = "overwritten";
    }).toThrow();

    const second = await store.findTemplate("canonical-image-text");
    expect(second?.layers.map((l) => l.id)).toEqual([
      "image",
      "shade",
      "accent",
      "static-text",
      "logo",
    ]);
  });

  test("constructing with two records sharing an id and version throws, naming both", () => {
    const v1a = CANONICAL_TEMPLATES["image-text"];
    const v1b = { ...v1a, name: "same id, same version" };

    expect(() => new FsTemplateStore([v1a, v1b])).toThrow(
      'Duplicate template record for ("canonical-image-text", version 1).',
    );
  });

  test("the store is registered as a lazily-created singleton", async () => {
    resetTemplateStore();
    try {
      const first = getTemplateStore(LOCAL_TENANT);
      // Read behaviour, not object identity: the registry wraps any store
      // lacking saveTemplate, so the FsTemplateStore is reachable only
      // through the read methods its wrapper delegates.
      expect(await first.listTemplates()).toEqual(Object.values(CANONICAL_TEMPLATES));
      expect(await first.exists("canonical-video")).toBe(true);
      await expect(first.saveTemplate(CANONICAL_TEMPLATES.video, "u")).rejects.toBeInstanceOf(
        TemplateWriteUnsupportedError,
      );
      expect(getTemplateStore(LOCAL_TENANT)).toBe(first);

      const replacement = new FsTemplateStore();
      setTemplateStore(replacement);
      const overridden = getTemplateStore(LOCAL_TENANT);
      expect(overridden).not.toBe(first);
      expect(await overridden.listTemplates()).toEqual(Object.values(CANONICAL_TEMPLATES));
      await expect(overridden.saveTemplate(CANONICAL_TEMPLATES.video, "u")).rejects.toBeInstanceOf(
        TemplateWriteUnsupportedError,
      );
    } finally {
      resetTemplateStore();
    }
  });

  test("the registry's fs-backed store is wrapped so saveTemplate throws TemplateWriteUnsupportedError", async () => {
    resetTemplateStore();
    try {
      const store = getTemplateStore(LOCAL_TENANT);
      // Read behaviour, not identity: the wrapped store still serves the
      // canonical library, but its saveTemplate refuses.
      expect(await store.listTemplates()).toEqual(Object.values(CANONICAL_TEMPLATES));
      await expect(
        store.saveTemplate(CANONICAL_TEMPLATES["image-text"], "u"),
      ).rejects.toBeInstanceOf(TemplateWriteUnsupportedError);
    } finally {
      resetTemplateStore();
    }
  });

  test("the TemplateStorePort interface is read-only by construction: no write-shaped methods declared", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../template-store.port.ts", import.meta.url)),
      "utf8",
    );
    // Scope the scan to the TemplateStorePort interface block: the file also
    // declares WritableTemplateStorePort (RW-22), which carries saveTemplate.
    const block = source.slice(
      source.indexOf("export interface TemplateStorePort"),
      source.indexOf("export interface WritableTemplateStorePort"),
    );
    const declared = Array.from(
      block.matchAll(/^[ \t]*(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)[^;]*;/gm),
      (m) => m[1] as string,
    );
    expect(declared).toEqual(["listTemplates", "findTemplate", "exists"]);
    expect(declared.filter((name) => /create|save|put|delete|write/i.test(name))).toEqual([]);
  });
});
