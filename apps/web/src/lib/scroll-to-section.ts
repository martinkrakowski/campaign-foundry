/**
 * Scroll an editor section into view. Sections in the main column carry `id`; the
 * ones placed in the left bar carry `data-section`, because that bar is rendered
 * twice below `lg` — the CSS-hidden desktop sidebar stays mounted while the mobile
 * menu shows the same content — and ids must be unique. Of the copies, prefer the
 * one that is actually laid out; `getElementById` would hand back the hidden one.
 */
export function revealSection(section: string): void {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(`#${section}, [data-section="${section}"]`),
  );
  const target = candidates.find((el) => el.getClientRects().length > 0) ?? candidates[0];
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}
