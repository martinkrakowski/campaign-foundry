import { afterEach, beforeEach, vi } from "vitest";
import { configure } from "@testing-library/dom";
import { cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { mockPipelineApi } from "@/__tests__/helpers";

// @testing-library's default asyncUtilTimeout is 1000ms, which is not enough headroom
// for files like brief-editor.test.tsx (298 waitFor calls) when the full 183-file suite
// runs in parallel. This is a ceiling on how long a waitFor may poll, not a delay, so
// raising it costs nothing when async updates resolve quickly. Do not "tidy" this away
// as an arbitrary number.
//
// 3000, not 5000: it must stay safely below Vitest's 5000ms testTimeout, because
// grid.test.tsx's `await screen.findByText("IMAGEN").catch(() => undefined)` grace wait
// intentionally burns the full asyncUtilTimeout when the pill never renders. At 5000
// that wait collides with the runner's own 5s test budget and the test is killed with
// "Test timed out in 5000ms"; 3000 leaves ~2s of headroom for the rest of that test
// under full-suite parallel load.
configure({ asyncUtilTimeout: 3000 });

// happy-dom v20 refuses to initialize localStorage without a file path, so swap in a
// simple in-memory implementation (the run state persistence the app relies on).
const memoryStorage = ((): Storage => {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
  };
})();
Object.defineProperty(globalThis, "localStorage", { value: memoryStorage, configurable: true });

// Default benign fetch so RunProvider's mount effects (restore-run) resolve to an
// empty "no run yet" result instead of hitting the network. POST generate returns
// 202 { jobId } and the job GET completes immediately so UI execute() still works.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch");
  mockPipelineApi();
});

// Unmount any rendered tree and restore mocks so happy-dom/localStorage state never
// leaks between tests.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  // `restoreAllMocks` does not touch a plain `vi.fn()`, so the router mocks below keep
  // their call history for the whole file — and an assertion like
  // `expect(router.replace).toHaveBeenCalledWith("/brief")` then passes on a call some
  // earlier test made. Clear them so each test asserts its own navigation.
  for (const fn of Object.values(router)) fn.mockClear();
  redirect.mockClear();
  nav.pathname = "/grid";
});

// Next's client navigation hooks need a router context that doesn't exist under
// happy-dom. Mock them with controllable state, exposed on globalThis for tests.
const nav = vi.hoisted(() => ({ pathname: "/grid" }));
const router = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
}));
const redirect = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => router,
  redirect,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    replace: _replace,
    scroll: _scroll,
    shallow: _shallow,
    ...rest
  }: { href?: string; children?: ReactNode; [key: string]: unknown }) =>
    createElement("a", { href: typeof href === "string" ? href : "#", ...rest }, children),
}));

interface NextTestControls {
  nav: { pathname: string };
  router: Record<string, ReturnType<typeof vi.fn>>;
  redirect: ReturnType<typeof vi.fn>;
}
(globalThis as unknown as { __next: NextTestControls }).__next = { nav, router, redirect };
