"use client";

import { useEffect, useState, type ReactNode } from "react";
import { IconButton } from "./icon-button";
import { themeToDark, themeToLight } from "@/components/campaign/messages";
import {
  DEFAULT_THEME,
  applyTheme,
  readStoredTheme,
  storeTheme,
  type ThemeName,
} from "@/lib/theme";

/**
 * The header's theme switch (W3.1 / SHELL-08 / TOK-25).
 *
 * The name states the **action**, not the state — *"Switch to the light theme"* while
 * dark — so it is a plain button and deliberately carries no `aria-pressed`: a screen
 * reader already says which theme is coming, and a pressed state on a control whose
 * label changes would report the same fact twice, in two directions.
 *
 * The first render is always the dark default, and the remembered theme is adopted on
 * mount rather than in the initialiser. The server has no storage, so reading it during
 * render would produce one tree on the server and a different one here and React would
 * tear the header down to reconcile them; the pre-paint script has already corrected
 * the class by the time this mounts, so the two agree on what is painted. `Disclosure`
 * is the same shape, for the same reason.
 */
export function ThemeToggle(): ReactNode {
  const [theme, setTheme] = useState<ThemeName>(DEFAULT_THEME);

  useEffect(() => {
    const stored = readStoredTheme();
    setTheme(stored);
    // Not redundant with the boot script: a mount without that script — a test, a
    // story, a future route that forgets it — still lands on the stored theme.
    applyTheme(stored);
  }, []);

  const next = theme === DEFAULT_THEME ? "light" : "dark";

  return (
    <IconButton
      label={theme === DEFAULT_THEME ? themeToLight : themeToDark}
      onClick={() => {
        setTheme(next);
        applyTheme(next);
        storeTheme(next);
      }}
    >
      {theme === DEFAULT_THEME ? (
        // A sun: the control offers the light theme, which is what the name says.
        <svg
          className="size-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          focusable="false"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        // A moon: the dark theme is what a click would bring back.
        <svg
          className="size-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          focusable="false"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </IconButton>
  );
}
