import { describe, it, expect } from 'vitest';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import config from '../../tailwind.config';

async function generateCss(classes: string[]) {
  const html = classes.map((c) => `<div class="${c}"></div>`).join('\n');
  
  // Create a config overriding content to only scan our generated HTML
  const tailwindConfig = {
    ...config,
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
});
