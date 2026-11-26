import { describe, test, expect, vi, afterEach } from "vitest";
import {
  CANONICAL_TEMPLATES,
  type BriefTemplate,
  type CreativeTemplate,
} from "@campaignfoundry/CampaignOrchestration";
import { LOCAL_TENANT } from "../tenant.js";
import { setTemplateStore, resetTemplateStore } from "../ports/index.js";
import { PinnedTemplateError, resolvePinnedOrgTemplate } from "../pinned-template.js";

const ORG_ID = "tpl-123e4567-e89b-42d3-a456-426614174000";

const canonical = CANONICAL_TEMPLATES["image-text"];
const stored = (over: Partial<CreativeTemplate> = {}): CreativeTemplate => ({
  ...canonical,
  id: ORG_ID,
  name: "Org Saver's Image & Text",
  ...over,
});
const pinned = (over: Record<string, unknown> = {}): BriefTemplate =>
  ({
    id: ORG_ID,
    version: 1,
    creativeType: "image-text",
    unit: "standard-web",
    layers: canonical.layers,
    ...over,
  }) as BriefTemplate;
const findTemplate = (...results: (CreativeTemplate | undefined)[]) =>
  vi.fn((_id: string, _version?: number) =>
    Promise.resolve(results.length > 0 ? results.shift() : undefined),
  );

describe("resolvePinnedOrgTemplate (RW-22)", () => {
  afterEach(() => resetTemplateStore());

  test("a canonical id resolves with zero store calls", async () => {
    const find = findTemplate(stored());
    setTemplateStore({
      listTemplates: () => Promise.resolve([]),
      findTemplate: find,
      exists: () => Promise.resolve(false),
    });

    await resolvePinnedOrgTemplate(LOCAL_TENANT, {
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: canonical.layers,
    });
    expect(find).not.toHaveBeenCalled();
  });

  test("an org template present at the pinned version resolves, even with edited unit and layers", async () => {
    const stored2: CreativeTemplate = stored();
    setTemplateStore({
      listTemplates: () => Promise.resolve([]),
      findTemplate: vi.fn(() => Promise.resolve(stored2)),
      exists: () => Promise.resolve(true),
    });

    await resolvePinnedOrgTemplate(LOCAL_TENANT, {
      id: ORG_ID,
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [
        { id: "image", kind: "image" },
        { id: "shade", kind: "shade" },
      ],
    });
  });

  test("a missing org template throws PinnedTemplateError naming template.id", async () => {
    const find = findTemplate(undefined);
    setTemplateStore({
      listTemplates: () => Promise.resolve([]),
      findTemplate: find,
      exists: () => Promise.resolve(false),
    });

    await expect(resolvePinnedOrgTemplate(LOCAL_TENANT, pinned())).rejects.toThrow(
      PinnedTemplateError,
    );
    await expect(resolvePinnedOrgTemplate(LOCAL_TENANT, pinned())).rejects.toThrow(
      /unknown template "tpl-123e4567-e89b-42d3-a456-426614174000"/,
    );
  });

  test("a cross-org pin answers the SAME message as a missing one (no existence leak)", async () => {
    const neverFind = findTemplate(undefined);
    setTemplateStore({
      listTemplates: () => Promise.resolve([]),
      findTemplate: neverFind, // org B's store does not carry org A's template
      exists: () => Promise.resolve(false),
    });

    let errMissing: unknown;
    await resolvePinnedOrgTemplate(LOCAL_TENANT, pinned()).catch((e) => (errMissing = e));
    let errCrossOrg: unknown;
    await resolvePinnedOrgTemplate(LOCAL_TENANT, pinned()).catch((e) => (errCrossOrg = e));

    expect(errMissing).toBeInstanceOf(PinnedTemplateError);
    expect(errCrossOrg).toBeInstanceOf(PinnedTemplateError);
    expect((errCrossOrg as Error).message).toBe((errMissing as Error).message);
  });

  test("a version mismatch (store has v1, brief pins v2) throws PinnedTemplateError naming template.id", async () => {
    // the store's exact-match contract: an unknown version is undefined,
    // never a fallback to the version the brief didn't pin
    setTemplateStore({
      listTemplates: () => Promise.resolve([]),
      findTemplate: vi.fn((_id: string, version?: number) =>
        Promise.resolve(version === 1 ? stored({ version: 1 }) : undefined),
      ),
      exists: () => Promise.resolve(false),
    });

    await expect(resolvePinnedOrgTemplate(LOCAL_TENANT, pinned({ version: 2 }))).rejects.toThrow(
      new PinnedTemplateError(
        `Campaign brief field "template.id" references unknown template "${ORG_ID}" (version 2).`,
      ),
    );
  });

  test("a creativeType mismatch throws PinnedTemplateError naming template.id", async () => {
    setTemplateStore({
      listTemplates: () => Promise.resolve([]),
      findTemplate: vi.fn(() => Promise.resolve(stored({ creativeType: "video" }))),
      exists: () => Promise.resolve(true),
    });

    await expect(resolvePinnedOrgTemplate(LOCAL_TENANT, pinned())).rejects.toThrow(
      /"tpl-123e4567-e89b-42d3-a456-426614174000" version 1\) has creativeType "video"/,
    );
  });

  test("a store rejection propagates — it is never folded into a PinnedTemplateError", async () => {
    setTemplateStore({
      listTemplates: () => Promise.resolve([]),
      findTemplate: () => Promise.reject(new Error("store on fire")),
      exists: () => Promise.reject(new Error("unused")),
    });

    let caught: unknown;
    await resolvePinnedOrgTemplate(LOCAL_TENANT, pinned()).catch((e) => (caught = e));
    expect(caught).not.toBeInstanceOf(PinnedTemplateError);
    expect((caught as Error).message).toBe("store on fire");
  });
});
