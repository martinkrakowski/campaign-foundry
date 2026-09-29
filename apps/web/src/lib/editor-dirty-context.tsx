"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui";

/**
 * D185 fix round — ONE editor's registration of its draft-write state.
 *
 * Every bug this replaces came from a single mistake: "a draft write is
 * pending" and "a draft write failed" are properties of an EDITOR INSTANCE, and
 * they were published as two shell-wide booleans that every instance assigned
 * as though it were the only writer. A boolean has no owner, so any instance
 * could lower one on another instance's behalf: an unmounted editor's cleanup
 * disarmed a live editor's warning, a settled write reported the whole shell
 * idle, and a deliberate Save left a failure behind that nothing owned.
 *
 * A writer is the unit instead, and it is created per editor instance. Its
 * `outstanding` COUNT is the authority — `beginWrite`/`endWrite` are paired per
 * queued draft PUT, so "this editor has unsaved work on the wire" is a number
 * rather than a flag any caller can lower out from under the next one. The
 * shell's two booleans become the AGGREGATE over live writers, which is what
 * makes one writer's lifecycle unable to touch another's: they share no state,
 * only the sum.
 */
export interface DraftWriteWriter {
  /** A draft PUT is queued on this writer's chain, or is already running. */
  readonly beginWrite: () => void;
  /** That PUT has settled — it landed, or it did not. */
  readonly endWrite: () => void;
  /** Whether the last write this writer dispatched landed. */
  readonly setFailed: (failed: boolean) => void;
  /**
   * This writer's editor is gone. A recorded failure stops being lost work —
   * the screen holding those edits is being torn down — but a write still on
   * the wire is not, so the registration itself outlives the unmount and is
   * taken out by the `endWrite` that retires the last queued PUT.
   */
  readonly release: () => void;
}

interface WriterState {
  readonly outstanding: number;
  readonly failed: boolean;
}

interface EditorDirtyContextValue {
  isDirty: boolean;
  setDirty: (dirty: boolean) => void;
  /**
   * D185 — a draft write is queued on SOME editor's write chain and has not
   * settled yet, and the last one to settle did not land. Both are "unsaved
   * work exists" in a way `isDirty` is not: a clean editor whose autosave is
   * still in flight has the operator's edits nowhere but the wire, and one
   * whose last write failed has them nowhere but the screen.
   *
   * The editors are the only writers, and each writes through its OWN
   * registration; these two are the shell-facing sum of those registrations,
   * which is what the guard reads and never sets.
   */
  hasPendingWrite: boolean;
  hasFailedWrite: boolean;
  registerDraftWriter: () => DraftWriteWriter;
  guardedAction: (action: () => void) => boolean;
  guardedPush: (url: string) => boolean;
}

const EditorDirtyContext = createContext<EditorDirtyContextValue | null>(null);

export function EditorDirtyProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [isDirty, setIsDirty] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [writeWriters, setWriteWriters] = useState<ReadonlyMap<DraftWriteWriter, WriterState>>(
    () => new Map(),
  );

  const setDirty = useCallback((dirty: boolean) => {
    setIsDirty(dirty);
  }, []);

  /**
   * Write one writer's state into the registry, or take it out of it when it
   * has nothing left to represent. Dropping the entry HERE, rather than from
   * a separate teardown path, is what makes the registry self-cleaning: a
   * writer that has settled its last write and holds no failure has no
   * business in it, so nothing downstream has to remember to remove it, and an
   * editor that unmounts mid-write leaves an entry that removes itself.
   */
  const publishWriter = useCallback((writer: DraftWriteWriter, next: WriterState | null) => {
    setWriteWriters((prev) => {
      const current = prev.get(writer);
      if (next === null) {
        if (current === undefined) return prev;
        const map = new Map(prev);
        map.delete(writer);
        return map;
      }
      if (
        current !== undefined &&
        current.outstanding === next.outstanding &&
        current.failed === next.failed
      ) {
        return prev;
      }
      const map = new Map(prev);
      map.set(writer, next);
      return map;
    });
  }, []);

  /**
   * A writer is pure until it writes: registering one touches no state, so an
   * editor that never autosaves a draft — or a test that only reads the flags —
   * costs nothing, and a writer whose editor has already unmounted can still
   * take a fresh registration out of `beginWrite` (the unmount flush below does
   * exactly that) without the release having to be undone first.
   */
  const registerDraftWriter = useCallback((): DraftWriteWriter => {
    const own = { outstanding: 0, failed: false };
    const writer: DraftWriteWriter = {
      beginWrite: () => step(1),
      endWrite: () => step(-1),
      setFailed: (failed) => {
        own.failed = failed;
        publish();
      },
      release: () => {
        own.failed = false;
        publish();
      },
    };
    function step(delta: number) {
      own.outstanding += delta;
      publish();
    }
    function publish() {
      publishWriter(writer, own.outstanding > 0 || own.failed ? { ...own } : null);
    }
    return writer;
  }, [publishWriter]);

  const { hasPendingWrite, hasFailedWrite } = useMemo(() => {
    const writers = Array.from(writeWriters.values());
    return {
      hasPendingWrite: writers.some((w) => w.outstanding > 0),
      hasFailedWrite: writers.some((w) => w.failed),
    };
  }, [writeWriters]);

  const guardedAction = useCallback(
    (action: () => void): boolean => {
      if (isDirty) {
        // Prompt once, never stack (DESIGN.md §5)
        setPendingAction((prev) => prev ?? (() => action()));
        return false;
      }
      action();
      return true;
    },
    [isDirty],
  );

  const guardedPush = useCallback(
    (url: string): boolean => {
      return guardedAction(() => router.push(url));
    },
    [guardedAction, router],
  );

  const handleConfirm = useCallback(() => {
    const action = pendingAction;
    setPendingAction(null);
    action?.();
  }, [pendingAction]);

  const handleClose = useCallback(() => {
    setPendingAction(null);
  }, []);

  // D185 fix round — memoised, so a provider re-render that changes none of
  // the published flags (the confirm dialog opening is the one this app has)
  // does not re-render every consumer through a fresh value object. The flags
  // are read by a `beforeunload` listener and by the nav guard, both of which
  // sit above most of the shell, so the fan-out is the whole tree.
  const value: EditorDirtyContextValue = {
    isDirty,
    setDirty,
    hasPendingWrite,
    hasFailedWrite,
    registerDraftWriter,
    guardedAction,
    guardedPush,
  };

  return (
    <EditorDirtyContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={pendingAction !== null}
        onConfirm={handleConfirm}
        onClose={handleClose}
      />
    </EditorDirtyContext.Provider>
  );
}

export function useEditorDirty() {
  const context = useContext(EditorDirtyContext);
  if (!context) {
    throw new Error("useEditorDirty must be used within an EditorDirtyProvider");
  }
  return context;
}

/**
 * This component instance's one draft-write registration, created lazily and
 * never recreated: a writer that changed identity part-way through its life
 * would orphan the entry it had already put in the registry, and the shell
 * would keep a pending write armed for an editor that no longer exists.
 */
export function useDraftWriteWriter(): DraftWriteWriter {
  const { registerDraftWriter } = useEditorDirty();
  const writerRef = useRef<DraftWriteWriter | null>(null);
  writerRef.current ??= registerDraftWriter();
  return writerRef.current;
}
