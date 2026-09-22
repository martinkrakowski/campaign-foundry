import { describe, test, expect } from "vitest";
import {
  CANONICAL_TEMPLATES,
  type CreativeTemplateLayer,
} from "@campaignfoundry/CampaignOrchestration/creative-templates";
import type { BriefTemplate } from "@campaignfoundry/CampaignOrchestration/brief-template";
import {
  canonicalTemplate,
  editorReducer,
  initialEditorState,
  type EditorState,
} from "../editor-state";

/**
 * D160 — `setLayerLink`: linkability as a property on a layer, never a new
 * layer kind. The action mirrors `setLayerProps`' shape (locate by id, no-op
 * the same state object, write through `canonicalLayer`) and `withEnabled`'s
 * delete-on-write mechanics, with the OPPOSITE polarity: absence means not a
 * click target, so ticking the box writes `link: true` and unticking deletes
 * the key — the editor never carries `link: false`.
 */

const CANONICAL = CANONICAL_TEMPLATES["image-text"];

const template = (layers: readonly CreativeTemplateLayer[] = CANONICAL.layers): BriefTemplate => ({
  id: "canonical-image-text",
  version: CANONICAL.version,
  creativeType: CANONICAL.creativeType,
  unit: CANONICAL.unit,
  layers,
});

const stateWith = (layers: readonly CreativeTemplateLayer[] = CANONICAL.layers): EditorState => ({
  ...initialEditorState(),
  template: template(layers),
});

const layer = (state: EditorState, id: string): CreativeTemplateLayer =>
  state.template.layers.find((candidate) => candidate.id === id)!;

describe("setLayerLink — locating the layer and honouring no-ops (the setLayerProps shape)", () => {
  test("a layer id that names no row is a no-op — the same state object", () => {
    const before = stateWith();
    const next = editorReducer(before, { type: "setLayerLink", layerId: "nope", link: true });
    expect(next).toBe(before);
  });

  test("a layer already carrying link: true asked for link: true again is a no-op", () => {
    const set = editorReducer(stateWith(), {
      type: "setLayerLink",
      layerId: "image",
      link: true,
    });
    const again = editorReducer(set, { type: "setLayerLink", layerId: "image", link: true });
    expect(again).toBe(set);
  });

  test("link: false on a layer whose key is already absent is a no-op — absence says it", () => {
    const before = stateWith();
    const next = editorReducer(before, { type: "setLayerLink", layerId: "image", link: false });
    expect(next).toBe(before);
  });
});

describe("setLayerLink — the write, its delete, and the fields beside them", () => {
  test("ticking the box writes link: true and changes no other field", () => {
    const withProps: CreativeTemplateLayer = { id: "image", kind: "image", props: { alt: "x" } };
    const next = editorReducer(stateWith([withProps, ...CANONICAL.layers.slice(1)]), {
      type: "setLayerLink",
      layerId: "image",
      link: true,
    });
    const image = layer(next, "image");
    expect(image.link).toBe(true);
    expect(image.props).toEqual({ alt: "x" });
    expect(image.id).toBe("image");
    expect(image.kind).toBe("image");
  });

  test("unticking the box DELETES the key rather than writing link: false", () => {
    const linked: CreativeTemplateLayer = { id: "image", kind: "image", link: true };
    const next = editorReducer(stateWith([linked, ...CANONICAL.layers.slice(1)]), {
      type: "setLayerLink",
      layerId: "image",
      link: false,
    });
    expect(Object.keys(layer(next, "image"))).not.toContain("link");
  });

  test("a loaded link: false asked for false still runs the write: the key is dropped", () => {
    // A server brief may arrive spelling `link: false` and (bypassing the load
    // normaliser) `enabled: true` too. That spelled `false` is NOT the
    // canonical absence the no-op guards on, so the dispatch must run the
    // write — `withLink(false)` deletes the key and `canonicalLayer` drops
    // `enabled: true` — cleaning the whole layer, not only the field it
    // touched.
    const loaded: CreativeTemplateLayer = {
      id: "image",
      kind: "image",
      enabled: true,
      link: false,
    };
    const before = stateWith([loaded, ...CANONICAL.layers.slice(1)]);
    const next = editorReducer(before, {
      type: "setLayerLink",
      layerId: "image",
      link: false,
    });
    expect(next).not.toBe(before);
    const image = layer(next, "image");
    expect(Object.keys(image)).not.toContain("link");
    expect(Object.keys(image)).not.toContain("enabled");
  });
});

describe("canonicalLayer — link joins the dropped-defaults list (D160, X16's rule)", () => {
  test("a layer carrying link: false comes back WITHOUT the key", () => {
    const spelled: CreativeTemplateLayer = { id: "image", kind: "image", link: false };
    const canonical = canonicalTemplate(template([spelled, ...CANONICAL.layers.slice(1)]));
    const image = canonical.layers[0]!;
    expect(Object.keys(image)).not.toContain("link");
    expect(image).not.toBe(spelled);
  });

  test("a layer carrying link: true keeps it", () => {
    const linked: CreativeTemplateLayer = { id: "image", kind: "image", link: true };
    const canonical = canonicalTemplate(template([linked, ...CANONICAL.layers.slice(1)]));
    expect(canonical.layers[0]).toBe(linked);
  });

  test("a layer with no droppable default returns the SAME layer reference", () => {
    const plain = CANONICAL.layers[0]!;
    const source = template(CANONICAL.layers);
    const canonical = canonicalTemplate(source);
    expect(canonical.layers[0]).toBe(plain);
    expect(canonical).toBe(source);
  });
});
