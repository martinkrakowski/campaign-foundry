import { describe, test, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import { initialEditorState } from "@/components/campaign/editor-state";
import * as messages from "../messages";

/**
 * CC3's second acceptance criterion, made falsifiable: **the rail's offers come
 * from the derivations.** *"A test that changes what `addableKinds` returns
 * changes what the rail offers. If the rail hard-codes the list, this test
 * cannot fail."*
 *
 * Asserting `offered === addableKinds(state)` would NOT establish that. A test
 * that compares a surface against the very dependency the surface calls passes
 * whether or not the call is real — the repository has been burned by exactly
 * that shape before. So this file replaces the derivations with answers the
 * domain would never give (`shade` offered on a template that holds one;
 * `image` removable when it is a required kind) and asserts the rail says so.
 * A second copy of the compatibility table anywhere between `derive.ts` and the
 * rendered control — in `layerStackProps`, in `LayerStack`, or a sanity filter
 * over either — makes these assertions fail.
 *
 * The mock is whole-module and therefore whole-file, which is why this lives
 * beside `layer-stack.test.tsx` rather than inside it: that file needs the real
 * derivations for every other proof it carries.
 */
vi.mock("@/components/campaign/derive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/campaign/derive")>();
  return {
    ...actual,
    // `shade` is at its cap on the canonical image-text template, and
    // `no-such-kind` is not in the vocabulary at all — neither could be reached
    // by any state the real table would accept.
    addableKinds: () => ["shade", "no-such-kind"],
    // The real answer's exact COMPLEMENT: every layer the domain protects is
    // offered for removal and every layer it frees is not. No state can produce
    // that, and it is spelled as a derivation rather than a literal list so the
    // D121 scanner (`derive.test.ts`) does not read a deliberately-wrong mock
    // as a second copy of the vocabulary.
    removableLayerIds: (state: Parameters<typeof actual.removableLayerIds>[0]) => {
      const real = actual.removableLayerIds(state);
      return state.template.layers.map((layer) => layer.id).filter((id) => !real.includes(id));
    },
    // Only the top layer may be switched; the real answer offers three.
    toggleableLayerIds: () => ["logo"],
    // A single direction, on one index — the real table answers per layer.
    layerMoveDirections: (_state: unknown, index: number) => (index === 0 ? ["up"] : []),
  };
});

const { LayerStack } = await import("../LayerStack");
const { layerStackProps } = await import("../layer-stack-props");

const addGroup = () => within(screen.getByRole("group", { name: messages.templateAddLabel }));
const list = () => within(screen.getByRole("list", { name: messages.templateListLabel }));

function Stack() {
  const [picked, setPicked] = useState<string | null>(null);
  const props = layerStackProps(initialEditorState());
  return (
    <LayerStack {...props} dispatch={vi.fn()} selectedLayerId={picked} onSelectLayer={setPicked} />
  );
}

describe("LayerStack — the offers are read from the derivations, never re-decided (CC3, D124)", () => {
  test("the add group is exactly what addableKinds answered, including a kind the domain would refuse", () => {
    render(<Stack />);
    expect(
      addGroup()
        .getAllByRole("button")
        .map((control) => control.getAttribute("aria-label")),
    ).toEqual(["shade", "no-such-kind"]);
    // The kind the real table offers here — `image`, the unbounded one — is
    // absent, because the derivation no longer names it. A hard-coded offer
    // would still be showing it.
    expect(addGroup().queryByRole("button", { name: "image" })).toBeNull();
  });

  test("the remove controls are exactly what removableLayerIds answered, required kinds included", () => {
    render(<Stack />);
    // Both of the type's REQUIRED kinds now carry a remove control, which no
    // real state can produce: the rail did not second-guess the answer.
    for (const [id, name] of [
      ["image", "Image"],
      ["static-text", "Static text"],
    ]) {
      expect(
        list().getByRole("button", {
          name: id,
          description: messages.templateRemoveDescription(name),
        }),
      ).toBeTruthy();
    }
    // And the layers the real derivation calls removable no longer are.
    for (const [id, name] of [
      ["shade", "Shade"],
      ["accent", "Accent"],
      ["logo", "Logo"],
    ]) {
      expect(
        list().queryByRole("button", {
          name: id,
          description: messages.templateRemoveDescription(name),
        }),
      ).toBeNull();
    }
    // The "why" sentence follows the same answer rather than a list of its own:
    // the kinds with no remove control are the ones it names.
    expect(
      screen.getByText(messages.templateRequiredNote(["Shade", "Accent", "Logo"])),
    ).toBeTruthy();
  });

  test("the toggle and the move controls follow their derivations too", () => {
    render(<Stack />);
    // One toggle, on the one layer `toggleableLayerIds` named.
    expect(
      list().getByRole("button", {
        name: "logo",
        description: messages.templateDisableDescription("Logo"),
      }),
    ).toBeTruthy();
    expect(
      list().queryByRole("button", {
        name: "shade",
        description: messages.templateDisableDescription("Shade"),
      }),
    ).toBeNull();
    // One move control, in the one direction `layerMoveDirections` allowed for
    // index 0 — where the real table allows none (moving `image` up would put
    // `shade` below it, which "shade directly above image" forbids).
    expect(
      list().getByRole("button", {
        name: "image",
        description: messages.templateMoveUpDescription("Image"),
      }),
    ).toBeTruthy();
    expect(
      list().queryByRole("button", {
        name: "accent",
        description: messages.templateMoveUpDescription("Accent"),
      }),
    ).toBeNull();
  });
});
