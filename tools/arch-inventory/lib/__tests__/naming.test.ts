import { describe, expect, test } from "vitest";
import {
  DEFAULT_NAMING,
  NamingError,
  entryForFile,
  fileForEntry,
  splitTemplate,
  toPascalCase,
} from "../naming.js";

describe("splitTemplate", () => {
  test("splits a template at {name}", () => {
    expect(splitTemplate("{name}.vo.ts")).toEqual({ prefix: "", suffix: ".vo.ts" });
  });

  test("keeps a non-empty prefix", () => {
    expect(splitTemplate("x-{name}.ts")).toEqual({ prefix: "x-", suffix: ".ts" });
  });

  test("rejects a template without {name}", () => {
    expect(() => splitTemplate("fixed.ts")).toThrow(NamingError);
  });

  test("rejects a template with two placeholders", () => {
    expect(() => splitTemplate("{name}-{name}.ts")).toThrow(NamingError);
  });
});

describe("toPascalCase", () => {
  test("joins kebab words capitalized", () => {
    expect(toPascalCase("advertising-units")).toBe("AdvertisingUnits");
  });

  test("leaves a Pascal identifier alone", () => {
    expect(toPascalCase("CampaignPipelinePort")).toBe("CampaignPipelinePort");
  });

  test("rescues an all-digit stem the way the generator does", () => {
    expect(toPascalCase("2024")).toBe("Stub2024");
  });

  test("rescues a nameless stem", () => {
    expect(toPascalCase("...")).toBe("Stub");
  });
});

describe("fileForEntry", () => {
  test("adds the folder's suffix", () => {
    expect(fileForEntry("MotionKind", DEFAULT_NAMING.valueObject)).toBe("MotionKind.vo.ts");
  });

  test("strips a suffix the entry already carries before re-adding it", () => {
    expect(fileForEntry("CampaignPipeline.in-port.ts", DEFAULT_NAMING.inPort)).toBe(
      "CampaignPipeline.in-port.ts",
    );
  });

  test("PascalCases the entry, exactly like the generator", () => {
    expect(fileForEntry("advertising-units", DEFAULT_NAMING.valueObject)).toBe(
      "AdvertisingUnits.vo.ts",
    );
  });
});

describe("entryForFile", () => {
  test("returns the Pascal stem with the suffix stripped", () => {
    expect(entryForFile("GenerateCampaignUseCase.use-case.ts", DEFAULT_NAMING.useCase)).toBe(
      "GenerateCampaignUseCase",
    );
  });

  test("matches the generator convention for port stubs", () => {
    expect(entryForFile("DemoPipeline.in-port.ts", DEFAULT_NAMING.inPort)).toBe("DemoPipeline");
  });

  test("matches an overridden naming template", () => {
    expect(entryForFile("CampaignPipelinePort.ts", "{name}.ts")).toBe("CampaignPipelinePort");
  });

  test("is undefined for a kebab-case module the generator could never emit", () => {
    expect(entryForFile("advertising-units.ts", "{name}.ts")).toBeUndefined();
  });

  test("is undefined for the barrel", () => {
    expect(entryForFile("index.ts", "{name}.ts")).toBeUndefined();
  });

  test("is undefined for tests and declarations even with a Pascal stem", () => {
    expect(entryForFile("Thing.test.ts", DEFAULT_NAMING.entity)).toBeUndefined();
    expect(entryForFile("Thing.spec.ts", DEFAULT_NAMING.entity)).toBeUndefined();
    expect(entryForFile("Thing.d.ts", DEFAULT_NAMING.entity)).toBeUndefined();
  });

  test("is undefined when the suffix does not belong to this folder", () => {
    expect(entryForFile("PlanCapacity.ts", DEFAULT_NAMING.useCase)).toBeUndefined();
  });
});
