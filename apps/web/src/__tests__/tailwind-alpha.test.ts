import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import type { Config } from 'tailwindcss';
import config from '../../tailwind.config';

async function generateCss(classes: string[], overrideConfig?: Config) {
  const html = classes.map((c) => `<div class="${c}"></div>`).join('\n');

  // Create a config overriding content to only scan our generated HTML
  const tailwindConfig = {
    ...(overrideConfig ?? config),
    content: [{ raw: html, extension: 'html' }],
  };

  const result = await postcss([
    tailwindcss(tailwindConfig),
  ]).process('@tailwind utilities;', {
    from: undefined,
  });

  return result.css;
}

describe('Tailwind Alpha Colors', () => {
  it('generates css rules for token colors with alpha modifiers', async () => {
    const css = await generateCss([
      'bg-error/20',
      'border-error/50',
      'ring-brand-primary/25',
      'hover:bg-border/40'
    ]);

    expect(css).toContain('.bg-error\\/20');
    expect(css).toContain('.border-error\\/50');
    expect(css).toContain('.ring-brand-primary\\/25');
    expect(css).toContain('.hover\\:bg-border\\/40:hover');
  });

  it('generates css rules for brand-primary-hover with and without alpha', async () => {
    const css = await generateCss([
      'bg-brand-primary-hover',
      'bg-brand-primary-hover/50',
    ]);

    expect(css).toContain('.bg-brand-primary-hover');
    expect(css).toContain('.bg-brand-primary-hover\\/50');
  });

  it('does not emit alpha utilities for a bare var() colour', async () => {
    const bareVarConfig: Config = {
      content: [],
      theme: {
        extend: {
          colors: {
            'test-bare': 'var(--color-test-bare)',
          },
        },
      },
    };

    const css = await generateCss(
      ['bg-test-bare/50', 'bg-test-bare'],
      bareVarConfig,
    );

    // Plain utility still emits
    expect(css).toContain('.bg-test-bare');
    // Alpha variant must NOT emit — Tailwind 3.4 drops /NN on a bare var()
    expect(css).not.toContain('.bg-test-bare\\/50');
  });

  // The control-boundary pair: a class that emits nothing looks identical to one that
  // works, so the utilities are compiled here the same way the alpha tokens above are.
  it('generates real declarations for the border-control pair, with and without alpha', async () => {
    const css = await generateCss([
      'border-border-control',
      'border-border-control-hover',
      'hover:border-border-control-hover',
      'border-border-control/50',
    ]);

    expect(css).toContain('.border-border-control');
    expect(css).toContain('--color-border-control');
    expect(css).toContain('.border-border-control-hover');
    expect(css).toContain('--color-border-control-hover');
    expect(css).toContain('.hover\\:border-border-control-hover:hover');
    expect(css).toContain('.border-border-control\\/50');
  });
});

// The other class the kit now writes that a stock Tailwind scale would silently
// substitute: `Eyebrow` uses `tracking-eyebrow`, and a token that never reaches the
// stylesheet leaves the label with the default tracking and no error anywhere.
describe('Tailwind letterSpacing token', () => {
  it('generates a rule for tracking-eyebrow', async () => {
    const css = await generateCss(['tracking-eyebrow']);
    expect(css).toContain('.tracking-eyebrow');
    expect(css).toContain('letter-spacing: 0.08em');
  });
});

// #173: ModelSelector's row boundary moved to `divide-border-control`. `divide-*`
// colours inherit from `borderColor` → `colors`, where border-control is defined —
// but this repo's founding lesson is that a class which compiles to nothing looks
// identical to one that works, so the inheritance is proven, not assumed.
describe('divide-border-control (the ModelSelector row boundary)', () => {
  it('emits a real rule with the border-control token', async () => {
    const css = await generateCss(['divide-border-control']);
    expect(css).toContain('--color-border-control');
    expect(css).toMatch(/divide-border-control[^{]*>[^{]*\{/);
  });
});

// R7 §6 question 1: the preview rail's visibility is a CONTAINER query on the editor
// row, not a viewport breakpoint. Tailwind 3.4 has no container-query variants built
// in, but its arbitrary variants accept any at-rule — this proves the variant the
// rail ships actually emits a real `@container` rule, since a class that compiles to
// nothing would look identical to one that works.
describe('Tailwind container query variant (the preview rail)', () => {
  it('emits a real @container rule for the rail visibility variant', async () => {
    const css = await generateCss(['[@container(min-width:56rem)]:flex']);
    expect(css).toContain('@container(min-width:56rem)');
    expect(css).toContain('display: flex');
  });

  it('emits container-type for the row that hosts the query', async () => {
    const css = await generateCss(['[container-type:inline-size]']);
    expect(css).toContain('container-type: inline-size');
  });
});

// A class-string assertion cannot tell a generated utility from a dead one.
// `/18` is not on Tailwind's default opacity scale, so it emits nothing
// (DESIGN.md:83). Walk the component tree and compile every color-alpha class
// it actually writes — G1's four files were the original net; every later lane
// is in scope the same way. Text scan only; no parser.
//
// The capture must end the class token. Without a boundary, `bg-red-500/50foo`
// is captured as `bg-red-500/50` — a valid class that compiles — while the
// real token in the source emits nothing. `(?![\w-])` refuses a match that
// continues as a token; the same after the `]` of the bracket form.
const COMPONENTS_DIR = join(__dirname, '../components');
const COLOR_ALPHA =
  /\b((?:fill|stroke|bg|text|border|ring|divide)-[a-z0-9-]+\/(?:\d+|\[[^\]]+\])(?![\w-]))/g;

// The same stem without the boundary. Used only to find a match whose next
// source character is still a token char — a trailing typo the bounded regex
// would skip, which is how the guard used to be walked past. Next-char, not a
// `[\w-]+` group: that group backtracks into the opacity digits (`/80` → `/8`+`0`).
const COLOR_ALPHA_STEM =
  /\b((?:fill|stroke|bg|text|border|ring|divide)-[a-z0-9-]+\/(?:\d+|\[[^\]]+\]))/g;

// Off-scale alphas outside G2 that this lane does not fix. The list may only
// shrink — a stale entry is permission for a class that was already converted
// to bracket form (kit-boundaries.test.ts). Empty: the scan found none.
const OFF_SCALE_ALLOWLIST: Record<string, string> = {};

function listComponentSources(dir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      names.push(...listComponentSources(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      names.push(full);
    }
  }
  return names;
}

function componentAlphaClasses(): string[] {
  const found = new Set<string>();
  for (const file of listComponentSources(COMPONENTS_DIR)) {
    const source = readFileSync(file, 'utf-8');
    for (const match of source.matchAll(COLOR_ALPHA)) {
      found.add(match[1]);
    }
  }
  return [...found];
}

function componentAlphaTrailingTypos(): string[] {
  const found: string[] = [];
  for (const file of listComponentSources(COMPONENTS_DIR)) {
    const source = readFileSync(file, 'utf-8');
    for (const match of source.matchAll(COLOR_ALPHA_STEM)) {
      const end = (match.index ?? 0) + match[0].length;
      const next = source[end];
      if (next !== undefined && /[\w-]/.test(next)) {
        const extra = source.slice(end).match(/^[\w-]+/)?.[0] ?? '';
        found.push(match[1] + extra);
      }
    }
  }
  return found;
}

function selectorOf(cls: string): string {
  return `.${cls.replace(/[^-_a-zA-Z0-9]/g, (ch) => `\\${ch}`)}`;
}

describe('component color-alpha utilities actually emit (DESIGN.md:83)', () => {
  it('emits a real rule for every color-alpha class the component tree uses', async () => {
    const trailing = componentAlphaTrailingTypos();
    expect(
      trailing,
      `trailing junk after an alpha class compiles the valid prefix and emits nothing for the real token: ${trailing.join(', ')}`,
    ).toEqual([]);
    const classes = componentAlphaClasses().filter((cls) => !(cls in OFF_SCALE_ALLOWLIST));
    expect(classes.length).toBeGreaterThan(0);
    const css = await generateCss(classes);
    for (const cls of classes) {
      expect(css, `${cls} emits nothing — off-scale alphas need bracket form (e.g. /18 is not a scale key)`).toContain(
        selectorOf(cls),
      );
    }
  });

  it('every off-scale allowlist entry still matches a class the tree still writes, each with a reason', () => {
    const classes = new Set(componentAlphaClasses());
    for (const [cls, reason] of Object.entries(OFF_SCALE_ALLOWLIST)) {
      expect(reason.trim().length, `${cls} must carry a one-line reason`).toBeGreaterThan(0);
      expect(
        classes.has(cls),
        `${cls} is no longer written — remove its allowlist entry (the list may only shrink)`,
      ).toBe(true);
    }
  });
});
