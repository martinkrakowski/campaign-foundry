import { describe, test, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { EditorDirtyProvider } from "../editor-dirty-context";
import { useGuardedNavigation } from "../use-guarded-navigation";

describe("useGuardedNavigation", () => {
  test("exposes isDirty, guardedPush, and guardedAction from EditorDirtyProvider", () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(EditorDirtyProvider, null, children);

    const { result } = renderHook(() => useGuardedNavigation(), { wrapper });
    expect(result.current.isDirty).toBe(false);
    expect(typeof result.current.guardedPush).toBe("function");
    expect(typeof result.current.guardedAction).toBe("function");

    act(() => {
      const ok = result.current.guardedPush("/path");
      expect(ok).toBe(true);
    });
  });
});
