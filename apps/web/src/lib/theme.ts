/**
 * The theme mechanism (D24 / TOK-25 / TOK-26).
 *
 * Three moving parts, and the order matters:
 *
 * 1. `THEME_BOOT_SCRIPT` — an inline script the root layout emits before any CSS or
 *    content, because the server cannot know the choice: it has no `localStorage`.
 *    Without it the server's dark default paints first and a light-theme user sees a
 *    flash of the wrong theme on every navigation.
 * 2. `applyTheme` — the class on `<html>`. Every token in `styles/tokens.css` hangs off
 *    it, including `color-scheme`, so native controls, scrollbars and form widgets
 *    follow from the same one bit of state.
 * 3. `readStoredTheme` / `storeTheme` — the remembered choice under one key.
 *
 * Storage is treated as absent or blocked by default, not as present: a private window,
 * a disabled store and a full quota are all ordinary, and a theme toggle that throws
 * takes the header down with it. Every access is wrapped, and every failure falls back
 * to the dark default rather than propagating.
 */

/** The two themes, named by the class that is *absent* in `light`. */
export type ThemeName = "light" | "dark";

/** Dark is what the server renders and what a failed read falls back to. */
export const DEFAULT_THEME: ThemeName = "dark";

/** Where the remembered choice lives. Namespaced like every other stored key. */
export const THEME_STORAGE_KEY = "cf:theme";

/** The class that carries the dark palette — see `styles/tokens.css`. */
export const THEME_CLASS = "dark";

/**
 * Reads the remembered theme. An absent or blocked store reads as dark, and a value
 * this app did not write (an older build, a hand-edited key) reads as dark too:
 * anything that is not exactly `"light"` is the default, so no migration is ever needed.
 */
export function readStoredTheme(): ThemeName {
  try {
    // A `try` covers both failure modes at once. An absent global is a `ReferenceError`,
    // which this catches exactly as it catches the `SecurityError` a blocked store throws
    // on access — so there is no second guard to keep in step with this one.
    return localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Remembers the choice. A store that refuses the write is not an error the user sees. */
export function storeTheme(theme: ThemeName): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* quota exceeded, or storage disabled: the choice still holds for this page */
  }
}

/**
 * Puts the theme on `<html>`. Client-only by construction — it is called from an effect
 * and from a click handler, never while rendering — so there is no server guard to
 * write, and therefore no branch that only a server could take.
 */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.classList.toggle(THEME_CLASS, theme === DEFAULT_THEME);
}

/**
 * Applies the remembered theme before the first paint (W3.1).
 *
 * Inlined into the document's `<head>` as text, so it cannot import from this module:
 * the key and the class are interpolated from the constants above, which is the only
 * way a rename here stays honest. It is wrapped for the same reason every other access
 * is — a store that throws on read must leave the server-rendered theme in place, not
 * abort the script and strand the page half-styled.
 */
export const THEME_BOOT_SCRIPT = `try {
  var stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
  document.documentElement.classList.toggle(${JSON.stringify(THEME_CLASS)}, stored !== "light");
} catch (error) {
  /* no stored choice, or a store that will not be read: keep what the server sent */
}`;
