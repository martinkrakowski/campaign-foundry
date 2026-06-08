import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount any React tree rendered in a test so happy-dom state never leaks
// between tests (RTL doesn't auto-clean outside its own globals integration).
afterEach(() => {
  cleanup();
});
