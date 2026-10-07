import { describe, test, expect } from "vitest";
import { currentAssetRefs } from "../BriefEditor";
import { initialEditorState, type EditorState } from "@/components/campaign/editor-state";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PATH_A = "assets/inputs/seed/logo-a.png";
const PATH_B = "assets/inputs/seed/plate.png";

describe("currentAssetRefs", () => {
  test("collects each of the four asset-ref fields", () => {
    const state: EditorState = {
      ...initialEditorState(),
      products: [
        { key: 1, id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: ID_A, inputAsset: PATH_B, idTouched: false },
      ],
      timeline: { beats: [{ key: 1, text: "One", weight: 1, background: ID_B }], transition: "fade", keyBeat: 1 },
      audio: { path: PATH_A, rights: { licenceId: "lic-1", source: "library" } } as CampaignBrief["audio"],
    };

    // Four distinct refs: two ids, two paths, all unique, sorted.
    expect(currentAssetRefs(state)).toEqual([ID_A, ID_B, PATH_A, PATH_B].sort());
  });

  test("omits empty strings", () => {
    const state: EditorState = {
      ...initialEditorState(),
      products: [
        { key: 1, id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "", inputAsset: ID_A, idTouched: false },
      ],
      timeline: { beats: [{ key: 1, text: "One", weight: 1, background: "" }], transition: "fade", keyBeat: 1 },
      audio: { path: "", rights: { licenceId: "lic-1", source: "library" } } as CampaignBrief["audio"],
    };

    expect(currentAssetRefs(state)).toEqual([ID_A]);
  });

  test("collapses a repeated ref to one copy", () => {
    const state: EditorState = {
      ...initialEditorState(),
      products: [
        { key: 1, id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: ID_A, inputAsset: "", idTouched: false },
        { key: 2, id: "beta", name: "Beta", primaryColor: "#E0218A", logoPath: ID_A, inputAsset: "", idTouched: false },
      ],
      timeline: { beats: [{ key: 1, text: "One", weight: 1, background: ID_A }], transition: "fade", keyBeat: 1 },
    };

    expect(currentAssetRefs(state)).toEqual([ID_A]);
  });

  test("returns an empty array when no refs are set", () => {
    expect(currentAssetRefs(initialEditorState())).toEqual([]);
  });

  test("a path ref and an id ref are both returned", () => {
    const pathState: EditorState = {
      ...initialEditorState(),
      products: [
        { key: 1, id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: PATH_A, inputAsset: "", idTouched: false },
      ],
    };
    const idState: EditorState = {
      ...initialEditorState(),
      products: [
        { key: 1, id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: ID_A, inputAsset: "", idTouched: false },
      ],
    };
    expect(currentAssetRefs(pathState)).toEqual([PATH_A]);
    expect(currentAssetRefs(idState)).toEqual([ID_A]);
  });
});
