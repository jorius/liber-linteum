// @vitest-environment node
// M4b §3: buttons take their colours from the palette — primary (accent),
// secondary (outlined), danger — through shared classes, so dialogs and bars
// can't drift back to module-local, all-white buttons.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = new URL('..', import.meta.url).pathname;
const css = readFileSync(new URL('./buttons.css', import.meta.url), 'utf8');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return files(path);
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [path] : [];
  });
}

describe('palette buttons (M4b §3)', () => {
  it('define primary, secondary and danger from the palette tokens', () => {
    const rule = (sel: string) => new RegExp(`\\.${sel}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    expect(rule('btn-primary')).toContain('var(--color-accent)');
    expect(rule('btn-primary')).toContain('var(--color-accent-contrast)');
    expect(rule('btn-secondary')).toContain('var(--color-border-strong)');
    expect(rule('btn-danger')).toContain('var(--color-danger)');
    expect(rule('btn-danger')).toContain('var(--color-danger-contrast)');
    expect(css).toMatch(/\.btn:focus-visible\s*\{[^}]*var\(--color-focus\)/);
  });

  it('dialogs and bars use them, not module-local button classes', () => {
    const offenders = files(join(src, 'features'))
      .filter((f) => /\/(dialogs|global-view|page)\//.test(f))
      .flatMap((f) =>
        [...readFileSync(f, 'utf8').matchAll(/styles\.(button|primary|danger)\b/g)].map(
          (m) => `${f.slice(src.length)}: styles.${m[1]}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('is loaded with the app', () => {
    expect(readFileSync(join(src, 'main.tsx'), 'utf8')).toContain("import './theme/buttons.css';");
  });
});
