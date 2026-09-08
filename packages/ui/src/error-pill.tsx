/**
 * The count of things to fix on a section heading or accordion aside. The numeral
 * is the visual; the accessible name spells it out ("1 issue" / "3 issues") so the
 * badge is not a bare digit to a screen reader.
 */
export function ErrorPill({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={`${count} issue${count === 1 ? "" : "s"}`}
      className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-error/20 px-[5px] font-mono text-[10px] font-semibold text-error"
    >
      {count}
    </span>
  );
}
