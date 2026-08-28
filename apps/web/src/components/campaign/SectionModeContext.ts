import { createContext, useContext } from "react";

/**
 * The mode a section is being rendered in, so `SectionShell` can derive its
 * numeral from the ordered list of sections that mode actually shows (D17) —
 * Randomized numbers Output 04, Classic numbers it 05.
 *
 * Defaults to "brief" rather than throwing: the numeral is chrome, and a
 * section rendered on its own (a test, a future preview) must still render.
 * The editor always provides the real mode.
 */
export const SectionModeContext = createContext<"brief" | "variation" | undefined>(undefined);

export function useSectionMode(): "brief" | "variation" {
  return useContext(SectionModeContext) ?? "brief";
}
