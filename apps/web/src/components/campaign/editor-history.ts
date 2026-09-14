import { useCallback, useEffect, useRef, useReducer } from "react";
import {
  editorReducer,
  type EditorAction,
  type EditorState,
} from "./editor-state";
import { isTypingTarget } from "@/lib/use-step-navigation";

/**
 * VE1 — undo and redo for the brief editor.
 *
 * The history lives HERE, never in `EditorState` (R6): `BriefEditor` persists the
 * whole state to localStorage and diffs it against a stored draft, so a
 * `{past, present, future}` state would leak history into storage and back through
 * `restore`. The hook wraps the exported, clamping `editorReducer` and hands the
 * present `EditorState` to the caller — the exact object today's persistence and
 * diffing already see.
 */

/**
 * Actions that never enter the history as an undo step. The first four are server
 * answers: a capability verdict, a pool read, an apply receipt, a save receipt.
 * The last three replace the baseline and are handled separately — they also
 * clear both stacks.
 */
const SERVER_ANSWER_TYPES = [
  "setCapabilities",
  "loadPool",
  "apply",
  "save",
] as const;

/** Actions that replace the draft wholesale: a new baseline, so history is moot. */
const BASELINE_TYPES = ["load", "discard", "restore"] as const;

function phaseOf(
  action: EditorAction,
): "baseline" | "server" | "edit" {
  const type = action.type;
  if ((BASELINE_TYPES as readonly string[]).includes(type)) return "baseline";
  if ((SERVER_ANSWER_TYPES as readonly string[]).includes(type)) return "server";
  return "edit";
}

/**
 * The coalescing key for a keystroke-driven action: consecutive edits carrying the
 * same key collapse into ONE history entry, so typing a word is one undo step and
 * the entry reverts the whole run. `patch` can name several fields at once, and
 * `setProduct`/`setTreatment` carry a patch too — the identity is the field set,
 * sorted so a re-arrival in another order cannot split the run. Every other
 * action (a toggle, an add, a remove) is its own entry, and returns null: null
 * never matches a previous key, so it also ENDS any run in progress.
 *
 * `setPool` is deliberately in the undoable set (null key): it writes
 * `variation.headline`, which is a draft field, so dropping the headline axis
 * because the pool lost its approved copy is an edit a user must be able to step
 * back over. The `pool` value itself is a server answer and carries forward on
 * undo, like the other three.
 */
function coalesceKeyOf(action: EditorAction): string | null {
  switch (action.type) {
    case "patch":
      return `patch:${Object.keys(action.patch).sort().join(",")}`;
    case "setProduct":
      return `setProduct:${action.key}:${Object.keys(action.patch).sort().join(",")}`;
    case "setTreatment":
      return `setTreatment:${action.index}:${Object.keys(action.patch).sort().join(",")}`;
    case "setBeatText":
      return `setBeatText:${action.index}`;
    case "setVariation":
      return `setVariation:${action.field}`;
    default:
      return null;
  }
}

/**
 * The server answers an undo must NOT revert (R5): `source` (the file identity and
 * the revision the next conditional save is guarded by), the copy pool, the apply
 * snapshot and the capabilities verdict. A step back through history restores the
 * draft around them, so an undo can never turn the next save into a conflict.
 */
function carryServerFields(target: EditorState, current: EditorState): EditorState {
  const carried = { ...target } as Record<string, unknown>;
  for (const key of ["source", "pool", "appliedSnapshot", "capabilities"] as const) {
    carried[key] = current[key];
  }
  return carried as unknown as EditorState;
}

interface HistoryState {
  readonly past: EditorState[];
  readonly present: EditorState;
  readonly future: EditorState[];
  /**
   * The coalescing key of the last draft edit, or null when the next edit must
   * open a new entry. A server answer leaves it standing — it changed no draft
   * field, so a verdict landing mid-word must not split the word into two undo
   * steps. A baseline replace, an undo or a redo resets it.
   */
  readonly lastKey: string | null;
}

type HistoryMsg =
  | { readonly kind: "action"; readonly action: EditorAction }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" };

function historyReducer(history: HistoryState, msg: HistoryMsg): HistoryState {
  if (msg.kind === "undo") {
    const previous = history.past[history.past.length - 1];
    if (previous === undefined) return history;
    return {
      past: history.past.slice(0, -1),
      present: carryServerFields(previous, history.present),
      future: [history.present, ...history.future],
      lastKey: null,
    };
  }
  if (msg.kind === "redo") {
    const next = history.future[0];
    if (next === undefined) return history;
    return {
      past: [...history.past, history.present],
      present: carryServerFields(next, history.present),
      future: history.future.slice(1),
      lastKey: null,
    };
  }
  const { action } = msg;
  const phase = phaseOf(action);
  if (phase === "baseline") {
    // A new baseline: the old draft's history describes a draft that is gone.
    return {
      past: [],
      present: editorReducer(history.present, action),
      future: [],
      lastKey: null,
    };
  }
  const present = editorReducer(history.present, action);
  if (present === history.present) return history;
  if (phase === "server") {
    // A server answer updates the present in place: no entry, and the redo
    // branch is not invalidated either — nothing about it was edited.
    return { ...history, present };
  }
  const key = coalesceKeyOf(action);
  const coalesced = key !== null && key === history.lastKey;
  return {
    past: coalesced ? history.past : [...history.past, history.present],
    present,
    future: [],
    lastKey: key,
  };
}

export interface EditorHistory {
  /** The present draft — a plain `EditorState`, exactly what persistence and diffing saw before VE1. */
  readonly state: EditorState;
  /** Drop-in for `useReducer`'s dispatch: classifies and forwards the action. */
  readonly dispatch: (action: EditorAction) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export function useEditorHistory(initial: EditorState): EditorHistory {
  const [history, send] = useReducer(
    historyReducer,
    initial,
    (seed): HistoryState => ({ past: [], present: seed, future: [], lastKey: null }),
  );
  const dispatch = useCallback(
    (action: EditorAction) => send({ kind: "action", action }),
    [],
  );
  const undo = useCallback(() => send({ kind: "undo" }), []);
  const redo = useCallback(() => send({ kind: "redo" }), []);
  return {
    state: history.present,
    dispatch,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}

/**
 * ⌘Z / ⇧⌘Z on macOS, Ctrl elsewhere — one listener keyed on either modifier,
 * because a platform sniff would only ever be a branch no test on this machine
 * can flip. Ignored while the keystroke lands inside a native text field: the
 * field has its own undo and owns the chord there (the same `isTypingTarget`
 * the step walk defers to). An empty stack is a no-op inside the reducer, so
 * the shortcut needs no guard of its own. While a modal dialog is open the page
 * behind it is inert, so the chord is ignored whenever one is in the document —
 * not only when it lands inside the dialog.
 */
export function useHistoryKeys(
  history: Pick<EditorHistory, "undo" | "redo">,
): void {
  const actions = useRef(history);
  actions.current = history;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.altKey) return;
      if (event.key.toLowerCase() !== "z") return;
      if (isTypingTarget(event.target)) return;
      // An open modal makes the page behind it inert: ⌘Z must not reach through
      // the scrim and undo the draft underneath — wherever the chord lands. Checking
      // only the event target missed a chord on the document body (focus drops there
      // after a click on the scrim). Every modal in the app renders only while open
      // and carries `aria-modal="true"` (dialog shell, command bar, model selector,
      // mobile menu, grid preview), so its presence in the document is the signal.
      // `role="dialog"` alone is not: a non-modal dialog would switch undo off.
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      if (event.shiftKey) {
        actions.current.redo();
      } else {
        actions.current.undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
