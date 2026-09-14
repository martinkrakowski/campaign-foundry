import { describe, test, expect, vi, afterEach } from "vitest";
import { renderHook, act, fireEvent } from "@testing-library/react";
import type { CopyPool } from "@campaignfoundry/CampaignOrchestration";
import { CANONICAL_TEMPLATES } from "@campaignfoundry/CampaignOrchestration/creative-templates";
import {
  initialEditorState,
  blankBrief,
  type EditorAction,
  type EditorState,
} from "../editor-state";
import { useEditorHistory, useHistoryKeys, type EditorHistory } from "../editor-history";

/**
 * VE1 — undo and redo for the brief editor.
 *
 * The contract these tests pin (plan §3 VE1): history lives in the hook and never
 * enters `EditorState` (R6); undo restores draft fields only and carries the server
 * answers — `source`, `pool`, `appliedSnapshot`, `capabilities` — forward (R5); the
 * exclusion set is the real actions (R4); `load`/`discard`/`restore` clear both
 * stacks; consecutive edits to one text field coalesce into one entry.
 */

const pool = (statuses: string[]): CopyPool =>
  ({
    entries: statuses.map((status, i) => ({
      id: `e${i}`,
      text: `t${i}`,
      status,
    })),
  }) as unknown as CopyPool;

const SERVER_KEYS: readonly (keyof EditorState)[] = [
  "source",
  "pool",
  "appliedSnapshot",
  "capabilities",
];

const pick = (state: EditorState, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.map((key) => [key, (state as unknown as Record<string, unknown>)[key]]));

const serverFields = (state: EditorState) => pick(state, SERVER_KEYS);

const draftFields = (state: EditorState) =>
  pick(
    state,
    Object.keys(state).filter((key) => !SERVER_KEYS.includes(key as keyof EditorState)),
  );

const render = () => renderHook(() => useEditorHistory(initialEditorState()));

const send = (
  hook: ReturnType<typeof render>,
  ...actions: EditorAction[]
) => {
  act(() => {
    for (const action of actions) hook.result.current.dispatch(action);
  });
};

describe("useEditorHistory — the state shape stays EditorState", () => {
  test("the present state carries exactly EditorState's keys, never a history wrapper", () => {
    const hook = render();
    send(hook, { type: "patch", patch: { campaignName: "Hel" } });
    act(() => hook.result.current.undo());
    const afterKeys = Object.keys(hook.result.current.state).sort();
    // What the autosave effect hands to `saveDraftToStorage` — the same object —
    // must be exactly what it holds today, or history leaks into localStorage and
    // back through `restore` (R6).
    expect(afterKeys).toEqual(Object.keys(initialEditorState()).sort());
    expect(afterKeys).not.toContain("past");
    expect(afterKeys).not.toContain("future");
  });
});

describe("useEditorHistory — undo restores the draft and carries the server answers", () => {
  test("undo restores the previous draft fields", () => {
    const hook = render();
    const before = draftFields(hook.result.current.state);
    send(hook, { type: "patch", patch: { campaignName: "Hel" } });
    act(() => hook.result.current.undo());
    expect(draftFields(hook.result.current.state)).toEqual(before);
  });

  test("undo leaves source, pool, appliedSnapshot and capabilities at their current values", () => {
    const hook = render();
    const capabilities = { motion: true };
    send(
      hook,
      { type: "setCapabilities", capabilities },
      { type: "loadPool", briefId: "", pool: pool(["approved"]) },
      { type: "apply" },
    );
    const server = serverFields(hook.result.current.state);
    send(hook, { type: "toggleHeadline" });
    const edited = hook.result.current.state;
    act(() => hook.result.current.undo());
    const after = hook.result.current.state;
    // The draft reverted…
    expect(after.variation.headline).not.toBe(edited.variation.headline);
    // …and every server answer is the CURRENT one, not the one from before the edit (R5).
    expect(serverFields(after)).toEqual(server);
  });

  test("a save landing between an edit and its undo leaves source.revision unchanged by the undo", () => {
    const hook = render();
    send(hook, { type: "save", entry: { file: "camp.yaml", revision: "r1" } });
    send(hook, { type: "patch", patch: { campaignName: "A" } });
    send(hook, { type: "save", entry: { file: "camp.yaml", revision: "r2" } });
    const revision = (hook.result.current.state.source as { revision?: string }).revision;
    expect(revision).toBe("r2");
    act(() => hook.result.current.undo());
    const source = hook.result.current.state.source as { kind: string; revision?: string };
    // The edit reverts; the revision the server just handed back does not —
    // undoing it would turn the next conditional save into a conflict.
    expect(hook.result.current.state.campaignName).toBe("");
    expect(source.kind).toBe("file");
    expect(source.revision).toBe("r2");
  });

  test("redo replays the edit and again carries the server answers forward", () => {
    const hook = render();
    const capabilities = { motion: false, reason: "no ffmpeg" };
    send(hook, { type: "setCapabilities", capabilities });
    send(hook, { type: "toggleHeadline" });
    const edited = hook.result.current.state;
    act(() => hook.result.current.undo());
    act(() => hook.result.current.redo());
    const after = hook.result.current.state;
    expect(after.variation.headline).toBe(edited.variation.headline);
    expect(after.capabilities).toEqual(capabilities);
  });
});

describe("useEditorHistory — the exclusion set is real actions (R4)", () => {
  const serverAnswers: [string, EditorAction][] = [
    ["setCapabilities", { type: "setCapabilities", capabilities: { motion: true } }],
    ["loadPool", { type: "loadPool", briefId: "", pool: null }],
    ["apply", { type: "apply" }],
    ["save", { type: "save" }],
  ];

  test.each(serverAnswers)("%s alone creates no undo step", (_name, action) => {
    const hook = render();
    send(hook, action);
    expect(hook.result.current.canUndo).toBe(false);
  });

  test("undo after a run of server answers steps over all of them to the last draft edit", () => {
    const hook = render();
    send(
      hook,
      { type: "toggleHeadline" },
      { type: "apply" },
      { type: "save", entry: { file: "camp.yaml", revision: "r9" } },
      { type: "setCapabilities", capabilities: { motion: true } },
    );
    expect(hook.result.current.canUndo).toBe(true);
    act(() => hook.result.current.undo());
    expect(hook.result.current.canUndo).toBe(false);
    expect(hook.result.current.state.variation.headline).toBe(false);
    // The server answers survive the walk-back.
    expect(hook.result.current.state.capabilities).toEqual({ motion: true });
    expect((hook.result.current.state.source as { revision?: string }).revision).toBe("r9");
    expect(hook.result.current.state.appliedSnapshot).not.toBeNull();
  });

  test("an ignored action that changes nothing does not create an entry", () => {
    const hook = render();
    send(hook, { type: "setMode", mode: "brief" });
    expect(hook.result.current.canUndo).toBe(false);
    expect(hook.result.current.canRedo).toBe(false);
  });
});

describe("useEditorHistory — load, discard and restore clear both stacks", () => {
  const baselines: [string, () => EditorAction][] = [
    ["load", () => ({ type: "load", brief: blankBrief() })],
    ["discard", () => ({ type: "discard" })],
    ["restore", () => ({
      type: "restore",
      state: { ...initialEditorState(), campaignName: "from draft" },
    })],
  ];

  test.each(baselines)("%s replaces the baseline and clears undo AND redo", (_name, make) => {
    const hook = render();
    send(hook, { type: "patch", patch: { campaignName: "A" } });
    act(() => hook.result.current.undo());
    expect(hook.result.current.canRedo).toBe(true);
    send(hook, make());
    expect(hook.result.current.canUndo).toBe(false);
    expect(hook.result.current.canRedo).toBe(false);
  });
});

describe("useEditorHistory — setPool is a draft edit, so it is undoable", () => {
  test("undoing setPool reverts variation.headline while pool itself carries forward", () => {
    const hook = render();
    send(hook, { type: "toggleHeadline" });
    expect(hook.result.current.state.variation.headline).toBe(true);
    const landed = pool(["pending"]);
    send(hook, { type: "setPool", briefId: "", pool: landed });
    // The action dropped the axis (no approved headlines) — a draft change.
    expect(hook.result.current.state.variation.headline).toBe(false);
    expect(hook.result.current.canUndo).toBe(true);
    act(() => hook.result.current.undo());
    expect(hook.result.current.state.variation.headline).toBe(true);
    // `pool` is a server answer: carried forward, not reverted.
    expect(hook.result.current.state.pool).toBe(landed);
  });
});

describe("useEditorHistory — the layer toggle is an ordinary undoable edit (L9, VE1)", () => {
  test("undo after a toggle restores the layer list it replaced, exactly", () => {
    const hook = render();
    const before = hook.result.current.state.template.layers;
    send(hook, { type: "setLayerEnabled", id: "shade", enabled: false });
    expect(
      hook.result.current.state.template.layers.find(
        (layer) => layer.id === "shade",
      )?.enabled,
    ).toBe(false);
    act(() => hook.result.current.undo());
    // `toStrictEqual`, so an `enabled: undefined` left behind by the toggle
    // would fail here — undo must restore the layer objects, not their shape.
    expect(hook.result.current.state.template.layers).toStrictEqual(before);
    act(() => hook.result.current.redo());
    expect(
      hook.result.current.state.template.layers.find(
        (layer) => layer.id === "shade",
      )?.enabled,
    ).toBe(false);
  });

  test("a refused toggle leaves nothing to undo", () => {
    const hook = render();
    // The last enabled instance of a required kind (MP-D4): the reducer's
    // no-op is not an edit, so the stack stays empty.
    send(hook, { type: "setLayerEnabled", id: "image", enabled: false });
    expect(hook.result.current.canUndo).toBe(false);
  });
});

describe("useEditorHistory — an html element edit is an ordinary undoable edit (HL5a, VE1)", () => {
  // The canonical `image-html` template's own layer list: image, html, logo.
  // No campaign type seeds it, so the pinned id is spelled out.
  const CANONICAL = CANONICAL_TEMPLATES["image-html"];
  const renderHtml = () =>
    renderHook(() =>
      useEditorHistory({
        ...initialEditorState(),
        template: {
          id: "canonical-image-html",
          version: CANONICAL.version,
          creativeType: CANONICAL.creativeType,
          unit: CANONICAL.unit,
          layers: CANONICAL.layers,
        },
      }),
    );

  test("undo after adding an element restores the template the add replaced, exactly", () => {
    const hook = renderHtml();
    const before = hook.result.current.state.template;
    send(hook, { type: "addHtmlElement", layerId: "html", kind: "text" });
    expect(
      hook.result.current.state.template.layers.find(
        (layer) => layer.id === "html",
      )?.elements,
    ).toHaveLength(1);
    act(() => hook.result.current.undo());
    // `toStrictEqual`, so an `elements: undefined` the add might have left
    // behind would fail here — undo restores the layer objects, not their shape.
    expect(hook.result.current.state.template).toStrictEqual(before);
    act(() => hook.result.current.redo());
    expect(
      hook.result.current.state.template.layers.find(
        (layer) => layer.id === "html",
      )?.elements,
    ).toHaveLength(1);
  });

  test("a refused element edit leaves nothing to undo", () => {
    const hook = renderHtml();
    // A layer that is not of kind `html` carries no elements, so the action is
    // a no-op — an edit that never happened is not an undo step.
    send(hook, { type: "addHtmlElement", layerId: "logo", kind: "text" });
    expect(hook.result.current.canUndo).toBe(false);
  });
});

describe("useEditorHistory — coalescing", () => {
  test("typing a word is one undo step (patch)", () => {
    const hook = render();
    send(
      hook,
      { type: "patch", patch: { campaignName: "H" } },
      { type: "patch", patch: { campaignName: "Ho" } },
      { type: "patch", patch: { campaignName: "How" } },
    );
    act(() => hook.result.current.undo());
    expect(hook.result.current.state.campaignName).toBe("");
    expect(hook.result.current.canUndo).toBe(false);
  });

  test("edits to different fields are separate entries", () => {
    const hook = render();
    send(
      hook,
      { type: "patch", patch: { campaignName: "A" } },
      { type: "patch", patch: { targetRegion: "DE" } },
    );
    act(() => hook.result.current.undo());
    expect(hook.result.current.state.targetRegion).toBe("");
    expect(hook.result.current.state.campaignName).toBe("A");
  });

  test("an interleaved action ends the coalesced run", () => {
    const hook = render();
    send(
      hook,
      { type: "patch", patch: { campaignName: "A" } },
      { type: "toggleHeadline" },
      { type: "patch", patch: { campaignName: "AB" } },
    );
    act(() => hook.result.current.undo());
    // Only the last typing run reverts; the headline toggle stands.
    expect(hook.result.current.state.campaignName).toBe("A");
    expect(hook.result.current.state.variation.headline).toBe(true);
  });

  test("consecutive beat text edits to one beat coalesce", () => {
    const hook = render();
    send(
      hook,
      { type: "addBeat" },
      { type: "setBeatText", index: 0, text: "O" },
      { type: "setBeatText", index: 0, text: "Op" },
      { type: "setBeatText", index: 0, text: "Open" },
    );
    act(() => hook.result.current.undo());
    expect(hook.result.current.state.timeline.beats[0].text).toBe("");
    // The add itself was its own entry — the beat is still there.
    expect(hook.result.current.state.timeline.beats).toHaveLength(1);
  });

  test("consecutive product name edits coalesce", () => {
    const hook = render();
    send(
      hook,
      { type: "setProduct", key: 1, patch: { name: "A" } },
      { type: "setProduct", key: 1, patch: { name: "Al" } },
    );
    act(() => hook.result.current.undo());
    expect(hook.result.current.state.products[0].name).toBe("");
  });

  test("consecutive treatment edits coalesce", () => {
    const hook = render();
    send(
      hook,
      { type: "addTreatment" },
      { type: "setTreatment", index: 0, patch: { id: "t" } },
      { type: "setTreatment", index: 0, patch: { id: "tr" } },
    );
    act(() => hook.result.current.undo());
    expect(hook.result.current.state.treatments[0].id).toBe("");
  });

  test("consecutive variation field edits coalesce", () => {
    const hook = render();
    send(
      hook,
      { type: "setVariation", field: "seed", value: "1" },
      { type: "setVariation", field: "seed", value: "12" },
    );
    act(() => hook.result.current.undo());
    expect(hook.result.current.state.variation.seed).toBe("");
  });
});

describe("useEditorHistory — the stacks", () => {
  test("undo and redo on empty stacks are no-ops", () => {
    const hook = render();
    const before = hook.result.current.state;
    act(() => hook.result.current.undo());
    expect(hook.result.current.state).toBe(before);
    act(() => hook.result.current.redo());
    expect(hook.result.current.state).toBe(before);
  });

  test("a new edit after an undo discards the redo branch", () => {
    const hook = render();
    send(hook, { type: "patch", patch: { campaignName: "A" } });
    send(hook, { type: "patch", patch: { targetRegion: "DE" } });
    act(() => hook.result.current.undo());
    expect(hook.result.current.canRedo).toBe(true);
    send(hook, { type: "toggleHeadline" });
    expect(hook.result.current.canRedo).toBe(false);
  });

  test("canUndo and canRedo report the stacks", () => {
    const hook = render();
    expect(hook.result.current.canUndo).toBe(false);
    expect(hook.result.current.canRedo).toBe(false);
    send(hook, { type: "toggleHeadline" });
    expect(hook.result.current.canUndo).toBe(true);
    expect(hook.result.current.canRedo).toBe(false);
    act(() => hook.result.current.undo());
    expect(hook.result.current.canUndo).toBe(false);
    expect(hook.result.current.canRedo).toBe(true);
  });
});

describe("useHistoryKeys", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const mount = (history: Pick<EditorHistory, "undo" | "redo">) =>
    renderHook(() => useHistoryKeys(history));

  const press = (init: {
    key?: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  }) => {
    act(() => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true, ...init });
    });
  };

  test("Cmd+Z undoes", () => {
    const history = { undo: vi.fn(), redo: vi.fn() };
    mount(history);
    press({});
    expect(history.undo).toHaveBeenCalledTimes(1);
  });

  test("Ctrl+Z undoes on Windows and Linux", () => {
    const history = { undo: vi.fn(), redo: vi.fn() };
    mount(history);
    press({ metaKey: false, ctrlKey: true });
    expect(history.undo).toHaveBeenCalledTimes(1);
  });

  test("Shift+Cmd+Z redoes", () => {
    const history = { undo: vi.fn(), redo: vi.fn() };
    mount(history);
    press({ shiftKey: true, key: "Z" });
    expect(history.redo).toHaveBeenCalledTimes(1);
  });

  test("Shift+Ctrl+Z redoes", () => {
    const history = { undo: vi.fn(), redo: vi.fn() };
    mount(history);
    press({ metaKey: false, ctrlKey: true, shiftKey: true });
    expect(history.redo).toHaveBeenCalledTimes(1);
  });

  test("a plain Z is left alone", () => {
    const history = { undo: vi.fn(), redo: vi.fn() };
    mount(history);
    press({ metaKey: false });
    expect(history.undo).not.toHaveBeenCalled();
  });

  test("other Cmd chords are left alone", () => {
    const history = { undo: vi.fn(), redo: vi.fn() };
    mount(history);
    press({ key: "a" });
    press({ altKey: true });
    expect(history.undo).not.toHaveBeenCalled();
    expect(history.redo).not.toHaveBeenCalled();
  });

  test("a keydown already prevented is left alone", () => {
    const history = { undo: vi.fn(), redo: vi.fn() };
    mount(history);
    act(() => {
      const event = new KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      event.preventDefault();
      window.dispatchEvent(event);
    });
    expect(history.undo).not.toHaveBeenCalled();
  });

  test("⌘Z inside a text field is left to the field's own undo", () => {
    const history = { undo: vi.fn(), redo: vi.fn() };
    mount(history);
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      fireEvent.keyDown(input, { key: "z", metaKey: true });
    });
    expect(history.undo).not.toHaveBeenCalled();
    expect(history.redo).not.toHaveBeenCalled();
  });

  test("⌘Z from a control inside an open modal dialog is left alone", () => {
    const history = { undo: vi.fn(), redo: vi.fn() };
    mount(history);
    // The shared dialog shell's shape (packages/ui dialog-shell.tsx): a
    // `role="dialog"` with `aria-modal="true"`. Focus on its button is the dialog's,
    // and ⌘Z there must not reach through the scrim to the draft behind it.
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const button = document.createElement("button");
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    act(() => {
      fireEvent.keyDown(button, { key: "z", metaKey: true });
    });
    expect(history.undo).not.toHaveBeenCalled();
    expect(history.redo).not.toHaveBeenCalled();
  });

  test("the shortcut prevents the browser default and stops after unmount", () => {
    const history = { undo: vi.fn(), redo: vi.fn() };
    const { unmount } = mount(history);
    const event = new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(history.undo).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    unmount();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(history.undo).toHaveBeenCalledTimes(1);
  });
});
