/**
 * The section's element. Sections in the main column carry `id`; the ones placed
 * in the left bar carry `data-section`, because that bar is rendered twice below
 * `lg` — the CSS-hidden desktop sidebar stays mounted while the mobile menu
 * shows the same content — and ids must be unique. Of the copies, prefer the one
 * that is actually laid out; `getElementById` would hand back the hidden one.
 *
 * The laid-out preference falls back to the first candidate rather than to
 * nothing: under happy-dom every element reports zero client rects, so a strict
 * visibility test would make this return `null` for every section in the suite.
 */
function sectionElement(section: string): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(`#${section}, [data-section="${section}"]`),
  );
  return candidates.find((el) => el.getClientRects().length > 0) ?? candidates[0] ?? null;
}

/** Scroll an editor section into view. */
export function revealSection(section: string): void {
  sectionElement(section)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * What a field wrapper's focus should land on. `data-field-key` sits on a
 * wrapper `<div>`, never on the control, so "focus the field" means finding the
 * thing inside it the operator can actually type into.
 */
const FOCUSABLE = "input:not([type='hidden']), select, textarea, [contenteditable='true']";

/**
 * PE1 — bring the first FAILING field inside a section into view and put focus
 * on its control. Returns the key it landed on, or `null` when none was found.
 *
 * **Reading order is the DOM's own order.** `querySelectorAll` returns document
 * order, so nothing here re-derives which field comes first. That is the whole
 * point: `FieldErrors` is a `Record<string, string>` and its key order is
 * whatever the validator happened to append — it coincides with the form's
 * order today only because `validateProducts` walks rows in array order. Sorting
 * the record would encode that coincidence as a rule; asking the DOM cannot, and
 * keeps working for any section whose fields are arranged differently.
 *
 * Returning `null` is a normal outcome, not a failure: a bucket-level error
 * names no field (`errors.products` when there are fewer than the minimum), and
 * a field inside a collapsed disclosure is not in the document to be found. The
 * caller keeps whatever landing point it already established.
 */
export function revealField(section: string, keys: ReadonlySet<string>): string | null {
  const host = sectionElement(section);
  if (host === null || keys.size === 0) return null;
  // The key travels WITH its element rather than being read back off the node at
  // the end: `dataset.fieldKey` is `string | undefined`, and re-reading it would
  // need a `?? null` that can never fire — the filter below has already proved
  // it is a string. The predicate says so in the type instead.
  const failing = Array.from(host.querySelectorAll<HTMLElement>("[data-field-key]"))
    .map((el) => ({ el, key: el.dataset.fieldKey }))
    .filter((found): found is { el: HTMLElement; key: string } => {
      return found.key !== undefined && keys.has(found.key);
    });
  // Same laid-out preference, same fallback, and for the same reason as above.
  const target = failing.find(({ el }) => el.getClientRects().length > 0) ?? failing[0];
  if (target === undefined) return null;
  target.el.scrollIntoView({ behavior: "smooth", block: "center" });
  // Focus the control, not the wrapper. A wrapper with nothing focusable in it
  // must not swallow the handoff — the caller's section focus stands instead,
  // so the refusal never drops focus to `document.body` (H2).
  target.el.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  return target.key;
}
