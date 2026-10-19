// @vitest-environment node
// React Flow's on-canvas attribution badge is hidden (proOptions.
// hideAttribution, which its MIT licence allows); M3a spec §9 / §13.10
// credit it in the README and the app instead, and the licence text must
// ship with copies of it (final review m6).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repo), 'utf8');
const require = createRequire(import.meta.url);
const reactFlow = dirname(require.resolve('@xyflow/react/package.json'));

describe('React Flow credit (M3a §9)', () => {
  it('the README credits React Flow and points to the notices', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/React Flow/);
    expect(readme).toMatch(/THIRD-PARTY-NOTICES\.md/);
  });

  it("THIRD-PARTY-NOTICES.md carries React Flow's MIT notice as published", () => {
    const notices = read('THIRD-PARTY-NOTICES.md');
    const licence = readFileSync(join(reactFlow, 'LICENSE'), 'utf8');
    const copyright = licence.split('\n').find((l) => l.startsWith('Copyright'))!;
    expect(notices).toContain(copyright);
    expect(notices).toContain('@xyflow/react');
    expect(notices).toContain('Permission is hereby granted, free of charge');
  });
});
