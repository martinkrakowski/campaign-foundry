import { describe, test, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_THEME,
  THEME_BOOT_SCRIPT,
  THEME_CLASS,
  THEME_STORAGE_KEY,
  applyTheme,
  readStoredTheme,
  storeTheme,
} from "../theme";

// Every test leaves the document as the server renders it. happy-dom keeps one
// documentElement for the whole file, so a test that forgets this hands the next one a
// light theme it did not ask for.
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.add(THEME_CLASS);
});

describe("the remembered theme", () => {
  test("a store that has never been written answers the dark default", () => {
    expect(readStoredTheme()).toBe(DEFAULT_THEME);
  });

  test("a stored choice round-trips", () => {
    storeTheme("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(readStoredTheme()).toBe("light");

    storeTheme("dark");
    expect(readStoredTheme()).toBe("dark");
  });

  test("a value this app did not write answers dark, so no migration is ever needed", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "midnight");
    expect(readStoredTheme()).toBe("dark");
  });

  test("a store that throws on read answers dark and does not throw", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => readStoredTheme()).not.toThrow();
    expect(readStoredTheme()).toBe("dark");
  });

  test("no storage at all — the server, a private window — answers dark", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readStoredTheme()).toBe("dark");
  });

  test("a store that refuses the write is not an error the user sees", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => storeTheme("light")).not.toThrow();
  });
});

describe("applyTheme", () => {
  test("dark puts the class on <html> and light takes it back off", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains(THEME_CLASS)).toBe(true);

    applyTheme("light");
    expect(document.documentElement.classList.contains(THEME_CLASS)).toBe(false);

    applyTheme("dark");
    expect(document.documentElement.classList.contains(THEME_CLASS)).toBe(true);
  });
});

describe("the pre-paint boot script", () => {
  /** Runs the shipped script against a store holding `stored`, and reports the class. */
  const run = (getItem: () => string | null): boolean => {
    document.documentElement.classList.add(THEME_CLASS);
    const ran = new Function("localStorage", `${THEME_BOOT_SCRIPT}`)({ getItem });
    expect(ran).toBeUndefined();
    return document.documentElement.classList.contains(THEME_CLASS);
  };

  test("no stored choice keeps the class the server sent", () => {
    expect(run(() => null)).toBe(true);
  });

  test("a stored light theme takes the class off before the first paint", () => {
    expect(run(() => "light")).toBe(false);
  });

  test("a stored dark theme leaves the class in place", () => {
    expect(run(() => "dark")).toBe(true);
  });

  test("a value this app did not write is not read as light", () => {
    expect(run(() => "midnight")).toBe(true);
  });

  test("a store that throws on read leaves the server's theme in place", () => {
    expect(
      run(() => {
        throw new Error("blocked");
      }),
    ).toBe(true);
  });

  test("it names the key and the class this module exports, not copies of them", () => {
    // The script is text: nothing links it to the constants but this assertion. A rename
    // that forgot it would ship a boot script reading a key no one writes.
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(THEME_CLASS));
  });
});
