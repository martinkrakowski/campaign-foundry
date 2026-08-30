import type { Config } from "tailwindcss";

/**
 * Tailwind config that *extends* the default palette with project tokens rather
 * than replacing it — every stock Tailwind class keeps working, and the `brand`
 * / token scales below resolve to the CSS custom properties in
 * src/styles/tokens.css, so Tailwind and raw CSS stay in sync.
 *
 * darkMode is "class" (the root layout adds `dark` to <html>). See DESIGN.md.
 */
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "color-mix(in srgb, var(--color-brand-primary) calc(<alpha-value> * 100%), transparent)",
          primary: "color-mix(in srgb, var(--color-brand-primary) calc(<alpha-value> * 100%), transparent)",
          "primary-hover": "color-mix(in srgb, var(--color-brand-primary-hover) calc(<alpha-value> * 100%), transparent)",
          secondary: "color-mix(in srgb, var(--color-brand-secondary) calc(<alpha-value> * 100%), transparent)",
          tint: "color-mix(in srgb, var(--color-brand-tint) calc(<alpha-value> * 100%), transparent)",
          "on-tint": "color-mix(in srgb, var(--color-brand-on-tint) calc(<alpha-value> * 100%), transparent)",
        },
        background: "color-mix(in srgb, var(--color-background) calc(<alpha-value> * 100%), transparent)",
        surface: "color-mix(in srgb, var(--color-surface) calc(<alpha-value> * 100%), transparent)",
        "surface-2": "color-mix(in srgb, var(--color-surface-2) calc(<alpha-value> * 100%), transparent)",
        border: "color-mix(in srgb, var(--color-border) calc(<alpha-value> * 100%), transparent)",
        "border-hover": "color-mix(in srgb, var(--color-border-hover) calc(<alpha-value> * 100%), transparent)",
        "text-primary": "color-mix(in srgb, var(--color-text-primary) calc(<alpha-value> * 100%), transparent)",
        "text-secondary": "color-mix(in srgb, var(--color-text-secondary) calc(<alpha-value> * 100%), transparent)",
        "text-muted": "color-mix(in srgb, var(--color-text-muted) calc(<alpha-value> * 100%), transparent)",
        "text-emphasis": "color-mix(in srgb, var(--color-text-emphasis) calc(<alpha-value> * 100%), transparent)",
        success: "color-mix(in srgb, var(--color-success) calc(<alpha-value> * 100%), transparent)",
        warning: "color-mix(in srgb, var(--color-warning) calc(<alpha-value> * 100%), transparent)",
        error: "color-mix(in srgb, var(--color-error) calc(<alpha-value> * 100%), transparent)",
        info: "color-mix(in srgb, var(--color-info) calc(<alpha-value> * 100%), transparent)",
        modified: "color-mix(in srgb, var(--color-modified) calc(<alpha-value> * 100%), transparent)",
        scrim: "color-mix(in srgb, var(--color-scrim) calc(<alpha-value> * 100%), transparent)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      letterSpacing: {
        // The mono-uppercase group label (DESIGN.md §2, `Eyebrow`). A token rather
        // than Tailwind's `tracking-widest` so the whole eyebrow family retunes from
        // one value.
        eyebrow: "0.08em",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        "2xl": "var(--shadow-2xl)",
      },
      transitionDuration: {
        fast: "var(--duration-fast)",
        normal: "var(--duration-normal)",
        preview: "var(--duration-preview)",
      },
    },
  },
  plugins: [],
};

export default config;
