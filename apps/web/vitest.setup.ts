import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

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
// empty "no run yet" result instead of hitting the network. Tests override as needed.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ halted: false, assets: [], log: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
});

// Unmount any rendered tree and restore mocks so happy-dom/localStorage state never
// leaks between tests.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
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
