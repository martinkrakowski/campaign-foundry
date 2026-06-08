import { render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import type { Mock } from "vitest";
import { RunProvider } from "@/lib/run-context";

/** Render a UI tree wrapped in the shared RunProvider. */
export const renderWithRun = (ui: ReactElement) => render(createElement(RunProvider, null, ui));

interface NextControls {
  nav: { pathname: string };
  router: Record<string, Mock>;
  redirect: Mock;
}

/** The controllable next/navigation mocks exposed by vitest.setup.ts. */
export const nextMock = (): NextControls =>
  (globalThis as unknown as { __next: NextControls }).__next;
