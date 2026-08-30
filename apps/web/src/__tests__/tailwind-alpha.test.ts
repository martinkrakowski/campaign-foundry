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
