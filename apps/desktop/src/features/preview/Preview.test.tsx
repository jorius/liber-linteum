import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { useUiStore } from '../../stores/uiStore';
import { Preview, RENDER_DEBOUNCE_MS } from './Preview';

/** Vault seen by links_resolve / page_read in these tests. */
const FILES: Record<string, string> = {
  'Notes/Page.md': '',
  'Notes/Sparda.md':
    '# Sparda\n\nA demon knight.\n\n## Weapons\n\nThe sword.\n\n## Family\n\nTwins.\n',
  'Notes/Loop.md': '# Loop\n\n![[Page]]\n',
  'Notes/Nested.md': '# Nested\n\n![[Sparda]]\n',
  'assets/rex cover.png': '',
  'assets/voice.mp3': '',
  'assets/brief.pdf': '',
};

function vault() {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    calls.push([cmd, args]);
    if (cmd === 'links_resolve') {
      return (args.targets as { kind: string; target: string }[]).map(({ kind, target }) => {
        const t = target.replace(/^\//, '');
        if (kind === 'markdown') return t in FILES ? t : null;
        const hit = Object.keys(FILES).find(
          (p) => p === t || p.endsWith(`/${t}`) || p.replace(/\.md$/, '').endsWith(`/${t}`),
        );
        return hit ?? null;
      });
    }
    if (cmd === 'page_read') {
      const text = FILES[args.path as string];
      if (text === undefined) throw { kind: 'notFound', message: String(args.path) };
      return { text, hash: 'h' };
    }
    if (cmd === 'page_get') throw { kind: 'notFound', message: 'x' };
    return null;
  });
  return calls;
}

const show = (text: string, path = 'Notes/Page.md') => render(<Preview text={text} path={path} />);

beforeEach(() => {
  vault();
  useUiStore.setState({ dialog: null });
});
afterEach(() => {
  vi.useRealTimers();
  usePageStore.getState().clear();
  resetEditorStore();
  clearMocks();
});

describe('Preview: every node type (M2a §4)', () => {
  it('renders Markdown, GFM and the Obsidian extensions; frontmatter stays hidden', async () => {
    show(
      [
        '---',
        'subtitle: hidden',
        '---',
        '# Title',
        '',
        'Some *em* **strong** ~~gone~~ ==marked== `code` #idea <span data-color="red">red</span>',
        '',
        '- [x] done',
        '- [ ] todo',
        '',
        '1. one',
        '',
        '> quoted',
        '',
        '> [!warning]- Careful',
        '> folded body',
        '',
        '```js',
        'let x = 1;',
        '```',
        '',
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '::::columns',
        ':::column',
        'left',
        ':::',
        ':::column',
        'right',
        ':::',
        '::::',
        '',
        '---',
        '',
        '<script>alert(1)</script>',
      ].join('\n'),
    );
    expect(screen.queryByText(/subtitle/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toHaveAttribute('id', 'title');
    expect(screen.getByText('em').tagName).toBe('EM');
    expect(screen.getByText('strong').tagName).toBe('STRONG');
    expect(screen.getByText('gone').tagName).toBe('DEL');
    expect(screen.getByText('marked').tagName).toBe('MARK');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getByText('#idea')).toHaveAttribute('data-nimw', 'tag');
    expect(screen.getByText('red')).toHaveAttribute('data-color', 'red');
    const done = screen.getByRole('checkbox', { name: 'done' });
    expect(done).toBeChecked();
    expect(done).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'todo' })).not.toBeChecked();
    expect(screen.getByText('quoted').closest('blockquote')).not.toBeNull();
    const callout = screen.getByText('Careful').closest('details')!;
    expect(callout).toHaveAttribute('data-callout', 'warning');
    expect(callout).not.toHaveAttribute('open');
    // Highlighted (M4b part 2 §2): the code reads whole across its spans.
    expect([...document.querySelectorAll('pre code')].map((c) => c.textContent)).toContain(
      'let x = 1;\n',
    );
    expect(screen.getByRole('table')).toHaveTextContent('12');
    const columns = screen.getByText('left').closest('[data-nimw="columns"]')!;
    expect(within(columns as HTMLElement).getByText('right')).toBeInTheDocument();
    expect(document.querySelector('hr')).not.toBeNull();
    expect(document.body.innerHTML).not.toContain('alert');
  });

  it('marks block elements with their source range (Split scroll sync)', () => {
    show('# A\n\npara\n');
    const p = screen.getByText('para');
    expect(p).toHaveAttribute('data-source-start', '5');
    expect(p).toHaveAttribute('data-source-end', '9');
  });

  it('re-renders on a 150 ms debounce', async () => {
    vi.useFakeTimers();
    const { rerender } = show('first');
    rerender(<Preview text="second" path="Notes/Page.md" />);
    expect(screen.getByText('first')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(RENDER_DEBOUNCE_MS));
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = show(
      '# Title\n\n- [x] done\n\n[[Sparda]] [[Nope]] [site](https://example.org)\n\n![](https://e.com/x.png)\n',
    );
    await screen.findByRole('link', { name: 'Sparda' });
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});

describe('Preview: links (M2a §3.4)', () => {
  it('shows resolved, unresolved and external links differently', async () => {
    show('[[Sparda]] [[Nope]] [md](Sparda.md) [site](https://example.org)\n');
    const sparda = await screen.findByRole('link', { name: 'Sparda' });
    await waitFor(() => expect(sparda).toHaveAttribute('data-state', 'resolved'));
    expect(screen.getByRole('link', { name: 'Nope' })).toHaveAttribute('data-state', 'unresolved');
    expect(screen.getByRole('link', { name: 'md' })).toHaveAttribute('data-state', 'resolved');
    const site = screen.getByRole('link', { name: /site/ });
    expect(site).toHaveAttribute('data-nimw', 'external');
    expect(site).not.toHaveAttribute('href', 'https://example.org');
  });

  it('opens resolved pages, offers to create missing ones and confirms external links', async () => {
    show('[[Sparda#Weapons]] [[Nope]] [site](https://example.org)\n');
    const sparda = await screen.findByRole('link', { name: 'Sparda › Weapons' });
    await waitFor(() => expect(sparda).toHaveAttribute('data-state', 'resolved'));
    await userEvent.click(sparda);
    await waitFor(() => expect(usePageStore.getState().path).toBe('Notes/Sparda.md'));
    expect(usePageStore.getState().anchor?.heading).toBe('Weapons');
    await userEvent.click(screen.getByRole('link', { name: 'Nope' }));
    expect(useUiStore.getState().dialog).toEqual({
      type: 'createPage',
      source: 'Notes/Page.md',
      target: 'Nope',
    });
    await userEvent.click(screen.getByRole('link', { name: /site/ }));
    expect(useUiStore.getState().dialog).toEqual({
      type: 'openExternal',
      url: 'https://example.org',
    });
  });
});

describe('Preview: embeds (M2a §4, §1.1)', () => {
  it('images with the size syntax, through nimw-asset:, lazy', async () => {
    show('![[rex cover.png|300]]\n');
    const img = await screen.findByRole('img', { name: 'rex cover.png' });
    expect(img).toHaveAttribute('src', 'nimw-asset://localhost/assets/rex%20cover.png');
    expect(img).toHaveAttribute('width', '300');
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('audio gets native controls', async () => {
    show('![[voice.mp3]]\n');
    await waitFor(() =>
      expect(document.querySelector('audio')).toHaveAttribute(
        'src',
        'nimw-asset://localhost/assets/voice.mp3',
      ),
    );
    expect(document.querySelector('audio')).toHaveAttribute('controls');
  });

  it('notes are transcluded with a title and "Open"; a heading embeds its section only', async () => {
    show('![[Sparda#Weapons]]\n');
    const embed = await screen.findByRole('region', { name: 'Sparda › Weapons' });
    expect(await within(embed).findByText('The sword.')).toBeInTheDocument();
    expect(within(embed).queryByText('Twins.')).not.toBeInTheDocument();
    await userEvent.click(within(embed).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(usePageStore.getState().path).toBe('Notes/Sparda.md'));
  });

  it('nested embeds become link cards; a page embedding itself says so', async () => {
    show('![[Nested]]\n\n![[Page]]\n');
    const nested = await screen.findByRole('region', { name: 'Nested' });
    expect(await within(nested).findByRole('link', { name: 'Sparda' })).toBeInTheDocument();
    expect(within(nested).queryByText('A demon knight.')).not.toBeInTheDocument();
    expect(await screen.findByText('Embedded note refers back to this page')).toBeInTheDocument();
  });

  it('missing targets get a "Not found" card with "Create page"; other files a file card', async () => {
    show('![[Ghost]]\n\n![[brief.pdf]]\n');
    expect(await screen.findByText('Not found: Ghost')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create page' }));
    expect(useUiStore.getState().dialog).toMatchObject({ type: 'createPage', target: 'Ghost' });
    await userEvent.click(await screen.findByRole('button', { name: 'Open in default app' }));
    expect(useUiStore.getState().dialog).toEqual({ type: 'openFile', path: 'assets/brief.pdf' });
  });

  it('remote media never load: a privacy placeholder instead (P1)', () => {
    show('![cat](https://e.com/cat.png)\n\n<img src="http://e.com/a.png">\n');
    expect(screen.getAllByText('Remote image blocked (privacy)')).toHaveLength(2);
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('Preview: task checkboxes (feedback 2026-10-13)', () => {
  it('are clickable when the pane can edit the page, and report the list item offset', async () => {
    const toggled: number[] = [];
    render(
      <Preview
        text={'- [ ] a\n- [x] b\n'}
        path="Notes/Page.md"
        onToggleTask={(at) => toggled.push(at)}
      />,
    );
    const b = await screen.findByRole('checkbox', { name: 'b' });
    expect(b).toBeEnabled();
    expect(b).toBeChecked();
    await userEvent.click(b);
    expect(toggled).toEqual([8]);
  });

  it('stay read-only without an editor, and inside note embeds', async () => {
    FILES['Notes/Tasks.md'] = '# Tasks\n\n- [ ] inner\n';
    try {
      render(
        <Preview
          text={'- [ ] mine\n\n![[Tasks]]\n'}
          path="Notes/Page.md"
          onToggleTask={() => undefined}
        />,
      );
      expect(await screen.findByRole('checkbox', { name: 'inner' })).toBeDisabled();
      expect(screen.getByRole('checkbox', { name: 'mine' })).toBeEnabled();
      show('- [ ] alone\n');
      expect(await screen.findByRole('checkbox', { name: 'alone' })).toBeDisabled();
    } finally {
      delete FILES['Notes/Tasks.md'];
    }
  });
});

describe('malformed percent-encoding and render errors (I4)', () => {
  it('raw-HTML links with a bare % render instead of blanking the app', () => {
    show('<a href="#100%">hundred</a> and <a href="B.md#50%">half</a>\n');
    expect(screen.getByText('hundred')).toBeTruthy();
    expect(screen.getByText('half')).toBeTruthy();
  });
});

describe('callout titles (I7)', () => {
  it('render their links and formatting in the title', async () => {
    show('> [!tip]- **Bold** [[Sparda|knight]]\n> body\n');
    const summary = screen.getByText('Bold').closest('summary')!;
    expect(screen.getByText('Bold').tagName).toBe('STRONG');
    expect(within(summary as HTMLElement).getByText('knight')).toHaveAttribute(
      'data-nimw',
      'wikilink',
    );
    expect(screen.getByText('body').closest('summary')).toBeNull();
  });
});

describe('heading anchors (M2c §6.2)', () => {
  it('a link-safe heading from [[Page#…]] completion scrolls to its heading', async () => {
    const scrolled: string[] = [];
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: Element) {
        scrolled.push(this.textContent ?? '');
      },
    });
    usePageStore.setState({ anchor: { heading: 'Pipes and carets', nonce: 1 } });
    show('# Top\n\n## Pipes | and ^carets\n\nbody\n');
    await waitFor(() => expect(scrolled).toEqual(['Pipes | and ^carets']));
  });
});

describe('Preview: code blocks (M4b part 2 §2)', () => {
  it('a fenced block is highlighted by its language and shows its label', async () => {
    show('```js\nconst answer = 42; // why\n```\n\n```\nplain\n```\n');
    const keyword = await screen.findByText('const');
    expect(keyword).toHaveClass('hljs-keyword');
    expect(screen.getByText('42')).toHaveClass('hljs-number');
    expect(screen.getByText('// why')).toHaveClass('hljs-comment');
    // Unknown or missing languages stay plain text.
    expect(screen.getByText('plain').querySelector('[class^="hljs"]')).toBeNull();
    expect(screen.getByText('JavaScript')).toBeInTheDocument();
  });

  it('an unknown language is shown as written and not highlighted', async () => {
    show('```klingon\nqapla\n```\n');
    expect(await screen.findByText('qapla')).not.toHaveClass(/hljs/);
    expect(screen.getByText('klingon')).toBeInTheDocument();
  });
});
