import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_TEMPLATES,
  type CreativeTemplate,
} from "@campaignfoundry/CampaignOrchestration";
import { FsTemplateStore } from "../fs-template-store.js";
import {
  getTemplateStore,
  resetTemplateStore,
  setTemplateStore,
} from "../index.js";

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
    expect(templates[1].layers.map((l) => l.id)).toEqual(["image", "html", "logo"]);
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

  test("the store is registered as a lazily-created singleton", () => {
    resetTemplateStore();
    try {
      const first = getTemplateStore();
      expect(first).toBeInstanceOf(FsTemplateStore);
      expect(getTemplateStore()).toBe(first);

      const replacement = new FsTemplateStore();
      setTemplateStore(replacement);
      expect(getTemplateStore()).toBe(replacement);
    } finally {
      resetTemplateStore();
    }
  });

  test("the port is read-only by construction: no write-shaped methods declared", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../template-store.port.ts", import.meta.url)),
      "utf8",
    );
    const declared = Array.from(
      source.matchAll(/^[ \t]*(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)[^;]*;/gm),
      (m) => m[1] as string,
    );

    expect(declared).toEqual(["listTemplates", "findTemplate", "exists"]);
    expect(declared.filter((name) => /create|update|write|save|delete|put|patch/i.test(name))).toEqual(
      [],
    );
  });
});
