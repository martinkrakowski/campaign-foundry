import { useReducer } from "react";
import { editorReducer, type EditorAction, type EditorState } from "./editor-state";

export interface EditorHistory {
  readonly state: EditorState;
  readonly dispatch: (action: EditorAction) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export function useEditorHistory(initial: EditorState): EditorHistory {
  const [state, dispatch] = useReducer(editorReducer, initial);
  return {
    state,
    dispatch,
    undo: () => {},
    redo: () => {},
    canUndo: false,
    canRedo: false,
  };
}

export function useHistoryKeys(
  _history: Pick<EditorHistory, "undo" | "redo">,
): void {
  // stub
}
