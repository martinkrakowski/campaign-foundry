import { describe, expect, test } from "vitest";
import {
  DEFAULT_NAMING,
  NamingError,
  canonicalEntry,
  entryForFile,
  fileForEntry,
  resolveScope,
  resolveTemplate,
  splitTemplate,
  toPascalCase,
} from "../naming.js";

const SCOPE = "campaignfoundry";

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

describe("resolveScope", () => {
  test("prefers scope over system", () => {
    expect(resolveScope({ scope: "@Campaign Foundry", system: "other" })).toBe("campaign-foundry");
  });

  test("falls back to system when scope is absent", () => {
    expect(resolveScope({ system: "CampaignFoundry" })).toBe("campaignfoundry");
  });

  test("falls back to the default when neither is set", () => {
    expect(resolveScope({})).toBe("generated-project");
  });
});

describe("resolveTemplate", () => {
  test("has no directory prefix for a bare filename template", () => {
    expect(resolveTemplate("{name}.vo.ts", SCOPE)).toEqual({ dirPrefix: "", prefix: "", suffix: ".vo.ts" });
  });

  test("splits a directory component off the leaf", () => {
    expect(resolveTemplate("generated/{name}.ts", SCOPE)).toEqual({
      dirPrefix: "generated/",
      prefix: "",
      suffix: ".ts",
    });
  });

  test("interpolates {scope} before splitting the directory", () => {
    expect(resolveTemplate("{scope}/{name}.adapter.ts", SCOPE)).toEqual({
      dirPrefix: "campaignfoundry/",
      prefix: "",
      suffix: ".adapter.ts",
    });
  });
});

describe("canonicalEntry", () => {
  test("normalises a kebab-case declared entry", () => {
    expect(canonicalEntry("user-repo", "{name}.ts", SCOPE)).toBe("UserRepo");
  });

  test("strips a suffix the entry already carries", () => {
    expect(canonicalEntry("CampaignPipeline.in-port.ts", DEFAULT_NAMING.inPort, SCOPE)).toBe("CampaignPipeline");
  });

  test("never strips a prefix (hexagen's normalizeStubName does not either)", () => {
    expect(canonicalEntry("x-Foo", "x-{name}.ts", SCOPE)).toBe("XFoo");
  });

  test("a bare {name} template leaves the entry's own name alone", () => {
    expect(canonicalEntry("Widget", "{name}", SCOPE)).toBe("Widget");
  });
});

describe("fileForEntry", () => {
  test("adds the folder's suffix", () => {
    expect(fileForEntry("MotionKind", DEFAULT_NAMING.valueObject, SCOPE)).toBe("MotionKind.vo.ts");
  });

  test("strips a suffix the entry already carries before re-adding it", () => {
    expect(fileForEntry("CampaignPipeline.in-port.ts", DEFAULT_NAMING.inPort, SCOPE)).toBe(
      "CampaignPipeline.in-port.ts",
    );
  });

  test("PascalCases the entry, exactly like the generator", () => {
    expect(fileForEntry("advertising-units", DEFAULT_NAMING.valueObject, SCOPE)).toBe("AdvertisingUnits.vo.ts");
  });

  test("resolves a {scope} directory prefix", () => {
    expect(fileForEntry("Widget", "{scope}/{name}.ts", SCOPE)).toBe("campaignfoundry/Widget.ts");
  });

  test("a template with no suffix (bare {name}) keeps every entry's own name", () => {
    // Regression: `entry.slice(0, -0)` degenerates to `slice(0, 0)`, which
    // used to empty every entry into the "Stub" fallback.
    expect(fileForEntry("Widget", "{name}", SCOPE)).toBe("Widget");
    expect(fileForEntry("Widget", "{name}.ts", SCOPE)).toBe("Widget.ts");
  });
});

describe("entryForFile", () => {
  test("returns the Pascal stem with the suffix stripped", () => {
    expect(entryForFile("GenerateCampaignUseCase.use-case.ts", DEFAULT_NAMING.useCase, SCOPE)).toBe(
      "GenerateCampaignUseCase",
    );
  });

  test("matches the generator convention for port stubs", () => {
    expect(entryForFile("DemoPipeline.in-port.ts", DEFAULT_NAMING.inPort, SCOPE)).toBe("DemoPipeline");
  });

  test("matches an overridden naming template", () => {
    expect(entryForFile("CampaignPipelinePort.ts", "{name}.ts", SCOPE)).toBe("CampaignPipelinePort");
  });

  test("is undefined for a kebab-case module the generator could never emit", () => {
    expect(entryForFile("advertising-units.ts", "{name}.ts", SCOPE)).toBeUndefined();
  });

  test("is undefined for the barrel", () => {
    expect(entryForFile("index.ts", "{name}.ts", SCOPE)).toBeUndefined();
  });

  test("is undefined for tests and declarations even with a Pascal stem", () => {
    expect(entryForFile("Thing.test.ts", DEFAULT_NAMING.entity, SCOPE)).toBeUndefined();
    expect(entryForFile("Thing.spec.ts", DEFAULT_NAMING.entity, SCOPE)).toBeUndefined();
    expect(entryForFile("Thing.d.ts", DEFAULT_NAMING.entity, SCOPE)).toBeUndefined();
  });

  test("is undefined when the suffix does not belong to this folder", () => {
    expect(entryForFile("PlanCapacity.ts", DEFAULT_NAMING.useCase, SCOPE)).toBeUndefined();
  });

  test("is undefined when the directory prefix does not match", () => {
    expect(entryForFile("Widget.ts", "{scope}/{name}.ts", SCOPE)).toBeUndefined();
  });

  test("matches a full relative path under a {scope} directory prefix", () => {
    expect(entryForFile("campaignfoundry/Widget.ts", "{scope}/{name}.ts", SCOPE)).toBe("Widget");
  });
});
