# Implementation Plan: Extensible Composition & Layout Engine

> **RETIRED 2026-09-10** — see `2026-09-10_reconciliation.md` §3 and
> `2026-09-10_review-of-the-sept8-composition-plans.md`. Its built half shipped as
> `BriefTemplate`, D128 z-order, `LAYER_DRAWERS` and boundary validation; its unbuilt half is
> L10/L11; its remaining novelties are forbidden (`zIndex` vs D128) or colliding (a second kind
> vocabulary). The visual-builder idea survives as a note on L10. Do not implement.

**Date:** 2026-09-08
**Context:** The current composition engine (`NodeCanvasCompositor`) hardcodes layout layers (Background -> Shade -> Headline -> Logo). To meet market expectations for video generation and varied ad units, we must support dynamic, multi-asset composition.
**Architectural Goal:** Evolve the `CreativeGeneration` domain to be driven by a JSON-Schema Layout Descriptor, enabling user-defined templates without backend code changes.

---

## 1. Architectural Strategy

We will replace the hardcoded layout logic in the infrastructure adapter with a schema-driven rendering engine. The `CreativeGeneration` domain remains intact, but the input it provides to its rendering ports becomes richer.

### 1.1 The Layout Descriptor Schema

*   **Domain (`domain/`)**: Introduce `LayoutDescriptor` and `LayoutElement` entities.
    *   *Rule:* A layout is a pure description of spatial elements and their initial state (Z-index, bounds, opacity).
*   **Infrastructure (`infrastructure/`)**: Update `NodeCanvasCompositor` to iterate through the `LayoutDescriptor` array and paint elements dynamically based on their type (`image`, `text`, `shape`, `gradient`).

---

## 2. Layout Schema Definition

The core schema that will power all composition:

```json
{
  "id": "template_id",
  "name": "Social Display Standard",
  "dimensions": { "width": 1080, "height": 1080 },
  "layers": [
    {
      "id": "bg_layer",
      "type": "image",
      "source": "$background",
      "zIndex": 0,
      "blendMode": "normal"
    },
    {
      "id": "shade_layer",
      "type": "gradient",
      "colors": ["rgba(0,0,0,0)", "rgba(0,0,0,0.7)"],
      "direction": "to-bottom",
      "zIndex": 1
    },
    {
      "id": "headline_layer",
      "type": "text",
      "content": "$headline",
      "font": "Inter-Bold",
      "color": "#FFFFFF",
      "position": { "x": 50, "y": 80, "anchor": "center" },
      "zIndex": 2
    },
    {
      "id": "logo_layer",
      "type": "image",
      "source": "$logo",
      "position": { "x": 90, "y": 10, "anchor": "top-right" },
      "scale": 0.16,
      "zIndex": 3
    }
  ]
}
```

### 2.1 Default Element Types
*   `text`: Supports wrapping, dynamic variables (`$headline`), font, color.
*   `image`: Supports local files, S3 URLs, or dynamic references (`$logo`, `$background`).
*   `shape` / `gradient`: Basic geometric overlays and darkening shades for text legibility.

---

## 3. Suggested Features (Phased Rollout)

### Phase 1: Engine Migration (Backend First)
*   **Schema Parser:** Implement the layout schema validation and parsing in the `CreativeGeneration` domain.
*   **Refactor NodeCanvasCompositor:** Re-write the rendering loop to paint layers sequentially based on the `layers` array.
*   **Backward Compatibility:** Create an auto-migration script that converts legacy hardcoded requests into the new `LayoutDescriptor` format before rendering.

### Phase 2: Visual Layout Builder (UI)
*   **Template Editor Workspace:** Introduce a new screen in `apps/web` where users can construct templates visually.
*   **Drag-and-Drop:** Allow users to drag text boxes, image placeholders, and shapes onto a canvas.
*   **Schema Serialization:** The UI builder serializes the visual layout directly into the JSON `LayoutDescriptor` and saves it via the API.

---

## 4. Implementation Plan (Step-by-Step)

### Step 1: Define Domain Models
1.  Add `LayoutDescriptor` types and validation (e.g., Zod schemas) to `packages/shared` or `packages/CreativeGeneration`.
2.  Ensure types account for dynamic content bindings (the `$` prefix convention).

### Step 2: Refactor the Compositor Adapter
1.  Update `NodeCanvasCompositor.render()` to accept `LayoutDescriptor`.
2.  Implement mapping logic for text bounding, image scaling, and layer blending based on schema properties.
3.  Write unit tests to verify Z-order and blending rules apply correctly.

### Step 3: API & Brief Integration
1.  Update `CampaignBrief` to support a `template` or `layout` field pointing to a saved descriptor.
2.  Ensure the generation orchestrator merges the brief's dynamic content (the generated copy and images) into the template before sending it to the compositor.

### Step 4: UI Visual Builder (Phase 2)
1.  Build a standard Canvas or DOM-based WYSIWYG editor in `apps/web`.
2.  Provide a property panel for adjusting text styles, colors, and coordinates.
3.  Hook into `DraftCampaignService` to save templates alongside briefs.

---

## 5. Risks & Mitigation

*   **Risk:** Performance degradation if templates are highly complex or contain too many layers.
    *   **Mitigation:** Enforce strict limits on layer counts and max image resolutions during schema validation.
*   **Risk:** Typography layout in Canvas doesn't exactly match the DOM-based UI builder.
    *   **Mitigation:** Abstract typography calculations into a shared utility package that both the frontend (UI preview) and backend (Canvas) use for measuring text bounds.
