import { describe, it, expect } from 'vitest';
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
