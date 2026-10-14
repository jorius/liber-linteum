# M4b — Feedback round — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer Jose's real-window feedback on M2c–M4. The page text starts about 25% from the top under a compact header band, with the cover as its background. Buttons take the palette. The `[[` list gets a search line, and the ⌘K picker stays on screen. Pasted TIFF, BMP and HEIC images are saved as PNG. NIMW can override Obsidian's attachment folder. Related pages become chips, the Global View gets "Connect cards", and the Dock icon sits inside Apple's grid.

**Architecture:**
- **Shell and header.** The shell moves the page title and subtitle into the top bar (`PageHeading`), and the sidebar names the vault. `Cover` becomes the header band: a render-prop component that draws the cover as a background, while `PageHeader` places its rows on veiled pills.
- **Pickers.** A generic `PickerPopup` uses a pure `placePopup` to stay anchored and inside the window. The Link picker and the Related chips both use it.
- **The only Rust change** is the `overrideObsidian` flag (vault config → session → DTO).

**Tech Stack:**
- React 19 + TS, CodeMirror 6 (`@codemirror/autocomplete` sections), zustand;
- Vitest (jsdom; node env for the CSS and icon guards), Playwright (Chromium + WebKit);
- Rust (`nimw-vault`, `nimw-session`, Tauri commands);
- `sips` and `tauri icon` for the macOS icon.

No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-14-m4b-feedback-design.md` (§10 records this plan's amendments).

**How this plan was made:**
- **Replayed on a scratch clone.** Every step was run, in order, on a scratch clone of `feat/m4b-feedback` (`978a56c`). Each task's code is the code that ran, from that task's commit: `0fd7042..21bb25a`.
- **Code shown.** The code steps show the key code (new modules in full where short, the decisive hunks of changes); the rest is in the commit named in each task's last step.
- **The review-focus pins** were written after Task 11 and sit here in the tasks that own their code (Tasks 3, 5, 7, 8 and 11). Two of them found bugs, which are fixed in the same step.
- **Commits.** The pins and these docs were verified, but signing was unavailable at the end of the replay, so their commits are pending, with prepared messages.

## Global Constraints

- **Network:** no network from the app (P1, NFR-04). Every M4b e2e test asserts no request left the machine and no CSP violation.
- **Contrast:** text ≥ 4.5:1:
  - `accent-contrast` on `accent` and `danger-contrast` on `danger` for every palette, mode and derived custom accent (§3);
  - text on the `--color-surface-veil` pills (88% surface) over any cover (§1).
- **Safari 15 floor:**
  - no `color-mix()`; the veil is `rgba()` generated per palette;
  - `:focus-visible` in its own rule (`cssCompat.test.ts`);
  - no API newer than Safari 15.0 in app TypeScript (`jsCompat.test.ts`).
- **Accessibility:**
  - keyboard parity; focus never lands on `<body>` after an action;
  - axe-clean in light and dark;
  - live regions are polite.
- **i18n:** en + es parity (`pnpm check:i18n`), with ICU plurals like the existing strings.
- **Dependencies and files:**
  - no new dependency;
  - `.obsidian/app.json` is never written;
  - only `icon.icns` changes among the platform icons.
- **Tooling:**
  - Vitest with `--maxWorkers=2`; Node 24 first on PATH;
  - Prettier from the repo root (the root `.prettierignore` keeps `e2e/remote.md` untouched);
  - `pnpm gen:palettes` after any palette change.
- **Commits:** signed. Never bypass signing.

## Review Focus

1. **Muted text on a cover pill over a dark or bright cover.** The breadcrumb, Saved and the counts must stay readable on any image. On the 88% veil, muted text fell to about 4.0:1. Pinned (and fixed) in Task 3, Step 8: `palettes.test.ts` › "review focus: text on the veil over any cover".
2. **A page with a very long name.** The title is cut short in the top bar, and Edit · Global view stay whole at 1280 and 900 px. The explorer row had widened the sidebar to about 970 px. Pinned (and fixed) in Task 11, Step 4: `m4b.spec.ts` › "review focus: a very long title…".
3. **Escape while the `[[` query waits out its 80 ms pause.** The list stays closed, and Rust is asked nothing. Pinned in Task 5, Step 6: `linkComplete.test.tsx` › "review focus: Escape while the query waits…".
4. **A paste holding one undecodable image among others.** The rest are saved, in clipboard order, and the toast explains the one that wasn't. Pinned in Task 7, Step 6: `attachments.test.tsx` › "review focus: one undecodable image among others…".
5. **"+ Related page" on a page that's already related.** A toast says so, and nothing is written. Pinned in Task 8, Step 6: `RelatedChips.test.tsx` › "review focus: picking a page that is already related…".

## File Structure

| Path (`apps/desktop/src/` unless noted) | Responsibility |
|---|---|
| `theme/paletteCss.ts`, `theme/tokens.css`, `theme/palettes.css` | `--color-surface-veil`, `--color-danger`, `--color-danger-contrast` |
| `theme/buttons.css` (+ `buttons.test.ts`) | `.btn`, `.btn-sm`, `.btn-primary/-secondary/-danger` |
| `features/shell/{Sidebar,TopBar}.tsx`, `Shell.module.css` | vault name in the sidebar; title/subtitle or "Global view · level" in the top bar |
| `features/page/PageHeading.tsx`, `NoteTitle.tsx` | the top bar's page heading; the band's "Title in the note" |
| `features/page/Cover.tsx`, `PageHeader.tsx`, `ModeToggle.tsx`, `PageView.module.css` | the header band, reposition after a pick, icons |
| `app/icons.tsx` | 14 px icons for the band and the mode switch |
| `crates/nimw-vault/src/{config,vault}.rs`, `crates/nimw-session/src/attachments.rs`, `src-tauri/src/{dto,attachment_commands}.rs`, `ipc/index.ts`, `features/dialogs/VaultSettingsSection.tsx` | `overrideObsidian` |
| `features/editor/linkComplete.ts`, `theme/base.css` | the search line, debounce, announcement |
| `features/editor/placePopup.ts`, `PickerPopup.tsx`, `LinkPicker.tsx` | anchored, clamped, flipping picker |
| `features/editor/attachments.ts` | paste conversion to PNG |
| `features/page/RelatedChips.tsx` | Related chips and "+ Related page" |
| `features/global-view/{gvStore,Toolbar,GlobalView,Canvas}.tsx` | Connect cards |
| `src-tauri/icons/app-icon-macos.svg`, `icon.icns`, `appIcon.test.ts` | the Dock icon |
| `e2e/m4b.spec.ts`, `e2e/m2c.spec.ts`, `playwright.config.ts` | end to end |

**Commands (repo root):**
- `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`.
- Vitest: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 <paths>`.
- E2E: `pnpm build:ui`, then `PLAYWRIGHT_BROWSERS_PATH=<browsers> pnpm --filter @nimw/desktop exec playwright test <spec>`.
- Rust: `cargo test -p <crate> --test <file>`.
- Full gate: lint, typecheck, i18n, vitest, build, fmt, clippy, cargo test, deny, e2e.

---

### Task 1: Buttons from the palette, and the veil token

Spec §3, and §1 (the veil token).

**Files:**
- Modify: `theme/paletteCss.ts`, `theme/tokens.css` (all 3 blocks), `theme/palettes.css` (regenerated), `main.tsx`
- Create: `theme/buttons.css`, `theme/buttons.test.ts`
- Modify (migrate to the shared classes): `features/dialogs/{ConfirmDeleteDialog,LinkDialogs,MoveToDialog,SettingsDialog}.tsx`, `Dialogs.module.css`, `features/global-view/{IndexPickDialog,RelationsDialog,GlobalView}.tsx`, `GlobalView.module.css`, `features/page/PageView.tsx`, `PageView.module.css`
- Test: `theme/palettes.test.ts`, `theme/buttons.test.ts`

**Interfaces:**
- Produces:
  - CSS tokens `--color-surface-veil`, `--color-danger`, `--color-danger-contrast` for every palette and mode;
  - `export const DANGER` in `paletteCss.ts`;
  - global classes `btn btn-primary|btn-secondary|btn-danger [btn-sm]`, used by Tasks 3, 8 and 9.

- [ ] **Step 1: Write the failing tests.** Add to `theme/palettes.test.ts`:

```ts
const BUTTON_TOKENS = ['--color-surface-veil', '--color-danger', '--color-danger-contrast'] as const;

describe('buttons and the header veil (M4b §1, §3)', () => {
  const palettes = [
    ...PALETTES,
    ...['#d1477a', '#2aa198', '#f5d000', '#808080', '#ffffff', '#000000'].map((hex) => ({
      id: 'custom' as const,
      ...derive(hex),
    })),
  ];
  it.each(
    palettes.flatMap((p, i) => (['light', 'dark'] as const).map((m) => [i, p.id, m] as const)),
  )('#%s %s %s: primary and danger buttons are readable; the veil is translucent surface', (i, _id, mode) => {
    const vars = paletteVars(palettes[i], mode);
    expect(contrast(vars['--color-accent-contrast'], vars['--color-accent'])).toBeGreaterThanOrEqual(4.5);
    expect(vars['--color-danger']).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(vars['--color-danger-contrast'], vars['--color-danger'])).toBeGreaterThanOrEqual(4.5);
    expect(vars['--color-surface-veil']).toMatch(/^rgba\(\d+, \d+, \d+, 0\.88\)$/);
  });
  it('the default tokens define them too, in both modes', () => {
    for (const key of BUTTON_TOKENS) expect(tokensCss.split(`${key}:`).length - 1, key).toBe(3);
  });
});
```

Then create `theme/buttons.test.ts` (node environment). It has three tests:
- the rules for `.btn-primary`, `.btn-secondary` and `.btn-danger` use the palette tokens, and `.btn:focus-visible` uses `--color-focus`;
- no `styles.(button|primary|danger)` remains in a non-test `.tsx` under `features/{dialogs,global-view,page}`;
- `main.tsx` imports `./theme/buttons.css`.

The full file is in commit `0fd7042`.

- [ ] **Step 2: Run them to see them fail.**
Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/theme/palettes.test.ts src/theme/buttons.test.ts`
Expected: FAIL. The veil and danger tokens are undefined, `buttons.css` doesn't exist, and the dialogs still use `styles.button`, `styles.primary` and `styles.danger`.

- [ ] **Step 3: Implement.**
1. In `paletteVars`, add the three tokens, plus the `DANGER` constant:

```ts
    // M4b §1, §3: the header band's pills over a cover (translucent surface,
    // no color-mix()), and the danger button, fixed per mode like the manual
    // edge so it reads as "danger" in every palette.
    '--color-surface-veil': alpha(t.surface, 0.88),
    '--color-danger': DANGER[mode].bg,
    '--color-danger-contrast': DANGER[mode].text,
```

```ts
/** Danger buttons (Delete, Remove, Discard): the shared red, text ≥ 4.5:1. */
export const DANGER = {
  light: { bg: '#b42318', text: '#ffffff' },
  dark: { bg: '#ff9d92', text: '#1b1426' },
} as const;
```

2. Add the same defaults to the three blocks of `tokens.css`, then run `pnpm gen:palettes`.
3. Create `theme/buttons.css`:
   - `.btn`: inline-flex, min-height 36 px, `--radius-md`, 600 13.5 px;
   - `.btn-sm`;
   - `.btn-primary`: accent, contrast text, `--color-accent-hover` on hover;
   - `.btn-secondary`: surface, `--color-border-strong` border, accent border on hover;
   - `.btn-danger`: `--color-danger`, `--color-danger-contrast`;
   - `.btn:disabled`: opacity 0.55;
   - a separate `.btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }`.
4. Add `import './theme/buttons.css';` to `main.tsx`.
5. Migrate every dialog or bar action to these classes:

| Class | Buttons |
|---|---|
| `btn-primary` | Save, Create, Done, Rename, Pick |
| `btn-secondary` | Cancel, Close, Not now; the Settings dialog's Close |
| `btn-danger` | Delete, Remove, Discard |

6. Remove `.button`, `.primary` and `.danger` from `Dialogs.module.css`, and `.button` from `PageView.module.css`.
7. The Global View connect bar's Cancel becomes `btn btn-secondary btn-sm`, and the `.connectBar button` rule goes.

- [ ] **Step 4: Run them to see them pass.**
Run: the same command, then `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2`.
Expected: PASS, with no other test changed.

- [ ] **Step 5: Commit.**
`git commit` with the subject "feat(theme): palette buttons — primary (accent), secondary (outlined), danger — and the header veil token (M4b §3)" (replay: `0fd7042`).

---

### Task 2: The sidebar names the vault; the title and subtitle move to the top bar

Spec §1 (sidebar header, top bar).

**Files:**
- Create: `features/page/PageHeading.tsx`, `features/page/NoteTitle.tsx`, `test/pageScreen.tsx`
- Modify:
  - `features/shell/{Sidebar,TopBar}.tsx`, `Shell.module.css`;
  - `features/page/{PageTitle,PageHeader}.tsx` (`PageTitle` exports `stemOf` and no longer renders the note title; `PageHeader`'s `<header>` becomes a `div`), `PageView.module.css` (title 20 px, subtitle 13 px);
  - `features/global-view/Toolbar.tsx` (exports `levelLabel`).
- Test: `features/shell/AppShell.test.tsx`; `features/page/{PageTitle,Cover,PageView}.test.tsx` now render `<PageScreen/>`

**Interfaces:**
- Produces:
  - `PageHeading()` (the page's `PageTitle` and `PageSubtitle` when the page is ready);
  - `NoteTitle({ page })`, `stemOf(path)`;
  - `levelLabel(ref, titles, t): string`;
  - `PageScreen` (test helper: `<header><PageHeading/></header><PageView/>`).

- [ ] **Step 1: Write the failing test.** Add to `AppShell.test.tsx`:

```ts
  it('M4b §1: the sidebar names the vault; the top bar holds the page title and subtitle, the Global View its level', async () => {
    seed();
    fakeDisk(
      { 'Art/rex.md': '---\nsubtitle: Hero redesign\n---\n# Generator Rex\n\nbody\n' },
      { vault_tree: () => nodes, gv_children: () => ({ cards: [], centre: null }), gv_edges: () => [], layout_get: () => ({}) },
    );
    render(<AppShell />);
    const side = screen.getByRole('complementary', { name: 'Files · Digital Brain' });
    expect(side).toHaveTextContent('Digital Brain');
    expect(side).not.toHaveTextContent('Notes In My Way');
    await act(() => openPage('Art/rex.md'));
    const bar = screen.getByRole('banner');
    const title = await within(bar).findByRole('textbox', { name: 'Page title' });
    expect(title).toHaveValue('rex');
    expect(within(bar).getByRole('heading', { level: 1 })).toContainElement(title);
    expect(within(bar).getByRole('textbox', { name: 'Subtitle' })).toHaveValue('Hero redesign');
    const page = screen.getByRole('region', { name: 'Page' });
    expect(within(page).queryByRole('textbox', { name: 'Page title' })).not.toBeInTheDocument();
    await userEvent.click(within(bar).getByRole('button', { name: 'Global view' }));
    expect(await within(bar).findByRole('heading', { level: 1, name: 'Global view · Vault' })).toBeInTheDocument();
    expect(within(bar).queryByRole('textbox', { name: 'Page title' })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it to see it fail.**
Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/features/shell/AppShell.test.tsx`
Expected: FAIL. The sidebar says "Notes In My Way", and the title textbox is not in the banner.

- [ ] **Step 3: Implement.**

```tsx
// features/page/PageHeading.tsx
/** The open page's title and subtitle, in the top bar (M4b §1): both stay
 *  editable in place (M2b §2, M2c §3). Nothing while no page is shown. */
export function PageHeading() {
  const state = usePageStore((s) => s.state);
  const page = usePageStore((s) => s.page);
  const editable = useEditorStore((s) => s.doc !== null && s.path === page?.path);
  if (state !== 'ready' || !page) return null;
  return (
    <>
      <PageTitle page={page} />
      <PageSubtitle page={page} editable={editable} />
    </>
  );
}
```

```tsx
// features/shell/TopBar.tsx
/** "Global view · <level>" while the Global View shows (M4b §1). */
function GvHeading() {
  const { t } = useTranslation();
  const level = useGvStore((s) => s.stack[s.stack.length - 1]);
  const titles = useGvStore((s) => s.titles);
  return (
    <h1 className={styles.screenTitle}>
      {level ? `${t('shell.globalView')} · ` : t('shell.globalView')}
      {level && <span className={styles.screenLevel}>{levelLabel(level, titles, t)}</span>}
    </h1>
  );
}
// …in the bar, replacing the vault name:
<div className={styles.heading}>{current === 'global' ? <GvHeading /> : <PageHeading />}</div>
```

- **Sidebar.** The brand becomes `<div className={styles.brand} title={name}><BrandMark /><span className={styles.brandName}>{name}</span></div>`.
- **`Shell.module.css`:**
  - `.topbar` becomes `display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)`;
  - new `.heading` (min-width 0, column), `.screenTitle` (ellipsized 18 px), `.screenLevel` and `.brandName` (ellipsized);
  - `.vaultName` and the toggle's `margin: auto` go;
  - `.tright` justifies to the end.
- **Note title.** `NoteTitle` renders `page.titleInNote` when `page.title !== stemOf(page.path)`.
- **Tests.** Update the old banner assertion in `AppShell.test.tsx`, and make the page tests render `<PageScreen/>`.

- [ ] **Step 4: Run them to see them pass.**
Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Commit.**
Subject: "feat(shell): the sidebar names the vault; the page title and subtitle move to the top bar (M4b §1)" (replay: `1975581`).

---

### Task 3: The header band; a picked cover opens in reposition mode; icons

Spec §1 (header band), §2.

**Files:**
- Modify:
  - `features/page/Cover.tsx` (rewritten as the band);
  - `features/page/PageHeader.tsx`, `ModeToggle.tsx`, `PageView.module.css`;
  - `app/icons.tsx`;
  - `i18n/locales/{en,es}.json` (`cover.dragHint`);
  - `test/fakeDisk.ts` (`page_get` reports `#tags`);
  - `e2e/m2c.spec.ts`, `playwright.config.ts` (WebKit runs `m4b`).
- Create: `e2e/m4b.spec.ts`
- Test: `features/page/Cover.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`--color-surface-veil`, `btn-*`), Task 2 (`PageScreen`).
- Produces:
  - `Cover({ page, editable, children: (slots: { addCover; controls }) => ReactNode })`, rendering `data-band="plain" | "cover"`;
  - `CoverState` carries `of` (the `cover:` value it was resolved for);
  - icons `ImagePlusIcon`, `SmallImageIcon`, `MoveVerticalIcon`, `TrashIcon`, `CheckIcon`, `SmallCloseIcon`, `PenIcon`, `CodeIcon`, `ColumnsIcon`.

- [ ] **Step 1: Write the failing tests.** Add the describe "the header band (M4b §1, §2)" to `Cover.test.tsx`:

```ts
  it('a new cover opens in reposition mode at once; one Save position writes cover-y', async () => {
    const disk = fakeDisk(
      { 'Rex.md': '# Rex\n' },
      { cover_pick: () => ({ path: 'sky.png', reference: 'sky.png' }), links_resolve: resolveCovers },
    );
    render(<PageScreen />);
    await open('Rex.md');
    await userEvent.click(screen.getByRole('button', { name: 'Add cover' }));
    const slider = await screen.findByRole('slider', { name: 'Cover position' });
    expect(slider).toHaveAttribute('aria-valuenow', '50');
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    await userEvent.click(screen.getByRole('button', { name: 'Save position' }));
    await waitFor(() => expect(disk.files.get('Rex.md')).toBe('---\ncover: sky.png\ncover-y: 60\n---\n# Rex\n'));
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });
```

The describe has four more tests, all in commit `003735c`:
- "Cancel right after a pick keeps the new cover, centred (no cover-y)";
- "with a cover, the image is the band background; breadcrumb, controls, tags and counts sit on it in veiled pills" (`[data-band="cover"]` contains `img[data-cover]`, and the breadcrumb, Tags list and counts sit inside `[class*="pill"]`);
- "without a cover, the band is plain and Add cover sits in its first row";
- "cover actions and the mode switch carry icons beside their labels".

Update the earlier I3 focus tests. "Add cover puts the keyboard on the position slider once the image shows (M4b §2)" and "Change cover keeps focus on Change cover while the new image loads, then on the slider". The "moved elsewhere" test clicks the subtitle with `userEvent`.

Add the e2e `e2e/m4b.spec.ts` › "M4b §1: with a cover, the text starts in the top 35% of the window": `.cm-content`'s top is under 35% of a 900 px viewport, and the top bar holds the title and Edit. In `m2c.spec.ts`, the slider is focused right after Add cover.

- [ ] **Step 2: Run them to see them fail.**
Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/features/page/Cover.test.tsx`
Expected: FAIL. There is no `data-band` and no pills, and Add cover doesn't open the slider.

- [ ] **Step 3: Implement.** The core of `Cover.tsx`:

```tsx
  // A cover just picked opens in reposition mode once its image shows, so it
  // is placed with one Save position (M4b §2). The pick removed `cover-y`.
  const [placeNext, setPlaceNext] = useState<string | null>(null);
  useEffect(() => setPlaceNext(null), [page.path]);
  useEffect(() => {
    // Only once the picked value itself has resolved: before that the state
    // still describes the previous cover (or none).
    if (!placeNext || cover.kind === 'none' || cover.kind === 'loading') return;
    if (cover.of !== placeNext) return;
    setPlaceNext(null);
    if (cover.kind === 'image') {
      fromPick.current = true;
      setDraft(50);
    } else setRefocus('change');
  }, [placeNext, cover]);
  // Focus moves into the slider and back to "Reposition" (never lost). After
  // a pick it goes to the slider unless the user clicked or typed somewhere
  // while the dialog was being answered (WebKit doesn't focus a clicked
  // button, and the explorer may refocus its row, so where focus sits says
  // little about intent).
  useEffect(() => {
    const active = document.activeElement;
    const inBand = !active || active === document.body || !!band.current?.contains(active);
    if (repositioning && (inBand || (fromPick.current && !movedOn.current))) {
      slider.current?.focus();
    } else if (!repositioning && entered.current && inBand) reposition.current?.focus();
    fromPick.current = false;
    entered.current = repositioning;
  }, [repositioning]);
```

`pick()` sets `movedOn` from capturing `pointerdown`/`keydown` listeners while `coverPick` is pending. On success it writes `cover:` (removing `cover-y`) and calls `setPlaceNext(reference)`.

**The band:**
- **Without a cover:** `<div data-band="plain" className={styles.band}>` with the rows.
- **With a cover:** `<div data-band="cover" className={styles.band + ' ' + styles.bandCover}>`, with a `.coverLayer` (the `img` with `object-position: 50% <y>%`, or the slider while repositioning, or the M2c placeholder) under the `.bandRows`.
- **While repositioning:** `.repositioning` hides every row but the controls, and a `cover.dragHint` pill ("Drag the image to place it") shows.
- **Cover actions:** the icon buttons. Add cover, Change and Reposition are `btn btn-secondary btn-sm`; Remove is `btn-danger`; Save position is `btn-primary`; Cancel is `btn-secondary`.

`PageHeader.tsx` renders inside `<Cover page editable>{({ addCover, controls }) => …}`:
- **Row 1:** `.bar`, holding `.where.pill` (back arrow + breadcrumb) and `.controls` (addCover, the Saved status pill, Format, `ModeToggle`).
- **Row 2:** `.bandFoot`, holding `.facts.pill` (tags, "N links · M backlinks", `NoteTitle`), then the cover `controls`.

The band CSS:
- `.band`, `.bandRows`;
- `.bandCover .bandRows { min-height: 132px; justify-content: space-between }`;
- `.bandCover .pill { background: var(--color-surface-veil); border-radius: var(--radius-md); padding: 4px 10px }`;
- `.coverLayer` (absolute, `object-fit: cover`).

`ModeToggle` gets `PenIcon`, `CodeIcon` and `ColumnsIcon` beside its labels. `fakeDisk`'s `page_get` gets `tags: tagsOf(text)`.

- [ ] **Step 4: Run them to see them pass.**
Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2`, then `pnpm build:ui` and `playwright test e2e/m4b.spec.ts e2e/m2c.spec.ts`.
Expected: PASS in Chromium and WebKit. The full e2e gave 126 passed and 8 skipped (opt-in perf).

- [ ] **Step 5: Commit.**
Subject: "feat(page): a compact header band with the cover as its background; covers open in reposition mode; icons (M4b §1, §2)" (replay: `003735c`). Make sure `e2e/remote.md` is unchanged.

- [ ] **Step 6: Review focus 1 — write the pin.** Add to `theme/palettes.test.ts`:

```ts
/** `rgba(r, g, b, a)` over an opaque `#rrggbb`, as `#rrggbb`. */
function over(rgba: string, under: string): string {
  const [r, g, b, a] = rgba.match(/[\d.]+/g)!.map(Number);
  const u = [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16));
  return `#${[r, g, b].map((c, i) => Math.round(c * a + u[i] * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
}

const pageCss = readFileSync(new URL('../features/page/PageView.module.css', import.meta.url), 'utf8');

describe('review focus: text on the veil over any cover (M4b §1)', () => {
  // palettes: as in the M4b §1, §3 describe (built-ins + six derived accents)
  it.each(/* [i, id, mode] for every palette × light/dark */)(
    '#%s %s %s: pill text meets AA on the veil over black and over white', (i, _id, mode) => {
      const vars = paletteVars(palettes[i], mode);
      for (const image of ['#000000', '#ffffff']) {
        const pill = over(vars['--color-surface-veil'], image);
        for (const text of ['--color-text', '--color-text-body'] as const)
          expect(contrast(vars[text], pill), `${text} over ${image}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  it('muted text in a pill is drawn in the body colour (muted alone falls to ~4.0:1)', () => {
    const rule = /\.bandCover \.pill \{([^}]*)\}/.exec(pageCss)?.[1] ?? '';
    expect(rule).toContain('--color-text-muted: var(--color-text-body);');
  });
});
```

- [ ] **Step 7: Run it to see it fail.**
Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/theme/palettes.test.ts -t "review focus"`
Expected: FAIL in "muted text in a pill…", because the rule doesn't redefine the token. A probe with `--color-text-muted` in the loop gave a worst case of **4.01:1** at 88% (body: 6.70, text: 8.79).

- [ ] **Step 8: Fix and run.** In `PageView.module.css`:

```css
/* On the veil, muted text would fall to about 4:1 over a dark or bright
   cover: it takes the body colour (M4b review focus). */
.bandCover .pill {
  --color-text-muted: var(--color-text-body);
  background: var(--color-surface-veil);
```

Run the same command. Expected: PASS (`src/theme`: 181 tests).

- [ ] **Step 9: Commit.** Use `$SP/m4b-pending/1-task3-veil-muted.msg` (pending: signing unavailable at the end of the replay).

---

### Task 4: NIMW's attachment place can override Obsidian's

Spec §5.

**Files:**
- Modify:
  - `crates/nimw-vault/src/{config,vault}.rs`, `crates/nimw-session/src/attachments.rs`;
  - `apps/desktop/src-tauri/src/{dto,attachment_commands}.rs`;
  - `ipc/index.ts`, `features/dialogs/VaultSettingsSection.tsx`, `i18n/locales/{en,es}.json`.
- Test:
  - `crates/nimw-vault/tests/attachments.rs`, `crates/nimw-session/tests/attachments.rs` (signature updates);
  - `apps/desktop/src-tauri/tests/commands.rs`;
  - `features/dialogs/SettingsDialog.test.tsx`.

**Interfaces:**
- Produces:
  - **`.nimw/vault.json`:** `attachments.overrideObsidian: bool` (default false);
  - **vault:** `AttachmentConfig.override_obsidian`, `Vault::set_nimw_attachments(mode, path, override_obsidian: Option<bool>)` (`None` keeps the stored flag);
  - **session:** `Session::set_attachment_settings(mode, path, Option<bool>)`, `Session::set_attachment_override(on)`;
  - **DTO (camelCase):** `VaultSettingsDto { attachments, obsidian, overrideObsidian }`, `VaultSettingsPatch { attachments?, overrideObsidian? }`. `overrideObsidian` is **top-level**, not inside `attachments`.

- [ ] **Step 1: Write the failing tests.**

```rust
/// M4b §5: NIMW's own setting can override Obsidian's when the user says so;
/// `.obsidian/app.json` is never written.
#[test]
fn m4b_nimw_override_wins_over_obsidian_until_turned_off() {
    let dir = copy_fixture("obsidian-basic"); // app.json: "./assets"
    let app_json = std::fs::read(dir.path().join(".obsidian/app.json")).unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    assert!(!vault.attachment_config().override_obsidian);
    vault.set_nimw_attachments("same", "", Some(true)).unwrap();
    assert_eq!(vault.attachment_policy(), AttachmentPolicy::SameAsNote);
    // Changing the place keeps the override (None leaves the flag as is).
    vault.set_nimw_attachments("folder", "Media", None).unwrap();
    assert!(vault.attachment_config().override_obsidian);
    // Off: Obsidian's applies again; NIMW's choice is kept for next time.
    vault.set_nimw_attachments("folder", "Media", Some(false)).unwrap();
    assert_eq!(vault.attachment_policy(), AttachmentPolicy::Subfolder("assets".into()));
    // …stored place still "folder"/"Media"; app.json bytes unchanged
}
```

Further tests:
- **Commands:** `m4b_vault_settings_override_obsidian_over_ipc`, a real-ACL round trip with `{ overrideObsidian: true }`, an override-only patch, and the M2c round-trip JSON gaining `"overrideObsidian": false`.
- **TS:** `SettingsDialog.test.tsx` › "M4b §5: a switch lets NIMW use its own place; off restores Obsidian's".

- [ ] **Step 2: Run them to see them fail.**
Run: `cargo test -p nimw-vault --test attachments` and `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/features/dialogs/SettingsDialog.test.tsx`
Expected: FAIL to compile (no `override_obsidian`, and `set_nimw_attachments` takes 2 arguments). The TS test fails because the switch doesn't exist.

- [ ] **Step 3: Implement.** Precedence in `vault.rs`:

```rust
        let overrides = nimw.as_ref().is_some_and(|a| a.override_obsidian);
        match nimw.and_then(|a| a.policy()) {
            Some(policy) if overrides => policy,
            ours => obsidian.map(|(_, policy)| policy).or(ours).unwrap_or_default(),
        }
```

`set_nimw_attachments` writes `overrideObsidian` only when it is given or was already present (`kept`). In the session:

```rust
    pub fn set_attachment_settings(&self, mode: &str, path: &str, override_obsidian: Option<bool>) -> Result<()> {
        let config = self.vault.attachment_config();
        let overrides = override_obsidian.unwrap_or(config.override_obsidian);
        let same_place = mode == config.mode && path.trim().trim_matches('/') == config.path;
        if config.obsidian.is_some() && !overrides && !same_place {
            // refused, as in M2c: Obsidian's setting applies
        }
        self.vault.set_nimw_attachments(mode, path, override_obsidian)?;
        // …
    }
    pub fn set_attachment_override(&self, on: bool) -> Result<()> {
        let config = self.vault.attachment_config();
        self.set_attachment_settings(&config.mode, &config.path, Some(on))
    }
```

In `vault_settings_set_impl`, a patch with `attachments` passes `patch.override_obsidian` along; a patch without it calls `set_attachment_override` when the flag is given.

In `VaultSettingsSection`:
- `own` state;
- `toggleOwn(on)` sends `{ attachments: { mode, path }, overrideObsidian: true }`, or `{ overrideObsidian: false }`;
- `locked = obsidian !== null && !own`;
- when Obsidian has a setting, the hint `vault.obsidianSet` ("Obsidian puts new attachments in {value} ({place}).") and a checkbox `vault.override` ("Use a different place in Notes In My Way") show;
- `vault.obsidianHint` gains "…, or use a different place here."

- [ ] **Step 4: Run them to see them pass.**
Run: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, and the vitest file.
Expected: PASS.

- [ ] **Step 5: Commit.**
Subject: "feat(attachments): NIMW can use its own place for new attachments over Obsidian's setting (M4b §5)" (replay: `0c60c8f`).

---

### Task 5: The `[[` list's search line; one query per pause

Spec §4 (autocomplete).

**Files:**
- Modify: `features/editor/linkComplete.ts`, `theme/base.css` (`.nimw-sr-only`), `i18n/locales/{en,es}.json` (`linkComplete.*`)
- Test: `features/editor/linkComplete.test.tsx`

**Interfaces:**
- Produces:
  - `SUGGEST_DEBOUNCE_MS = 80`;
  - the header `div.cm-nimw-search` (aria-hidden), holding `.cm-nimw-search-text` and `.cm-nimw-search-count`;
  - the live region `[data-nimw-complete-status][role=status]`.

- [ ] **Step 1: Write the failing tests.** Add the describe "the search line and debounce (M4b §4)" with three tests:
- "the list opens with what was typed and how many pages match";
- "with nothing typed yet it says to type to filter";
- "typing quickly asks Rust once, for the last text (80 ms debounce)":

```ts
    const v = editor('See [[');
    act(() => { startCompletion(v); });
    for (const ch of ['g', 'e', 'n']) {
      act(() => v.dispatch({ changes: { from: v.state.doc.length, insert: ch }, selection: { anchor: v.state.doc.length + 1 }, userEvent: 'input.type' }));
      await act(() => new Promise((r) => setTimeout(r, 20)));
    }
    await vi.waitFor(() => expect(document.querySelector('.cm-nimw-search')).toHaveTextContent('gen'));
    expect(queries).toEqual(['gen']);
```

- [ ] **Step 2: Run them to see them fail.**
Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/features/editor/linkComplete.test.tsx`
Expected: FAIL. There is no `.cm-nimw-search`, and queries are `['g','ge','gen']`.

- [ ] **Step 3: Implement.** In the file source:

```ts
    await pause(SUGGEST_DEBOUNCE_MS);
    if (context.aborted) return null;
    // …link_suggest…
    const section = searchSection(q.query, res.value.length);
    return { from: q.from, options: res.value.map((s) => ({ ...fileOption(s, q), section })), filter: false };
```

The heading source does the same, with `searchSection(q.query, found.length)`. `searchSection` returns a `CompletionSection` whose `header()` builds the line (magnifier SVG, "Search: {query}" or "Type to filter", and "{count} matches"). It calls `announce()` with `linkComplete.matchesFor` or `linkComplete.matches`, which writes to a single polite `role=status` region with the `.nimw-sr-only` class. The theme makes the header `position: sticky; top: 0`.

Strings (en):
- `"search": "Search: {query}"`;
- `"typeToFilter": "Type to filter"`;
- `"matches": "{count, plural, one {# match} other {# matches}}"`;
- `"matchesFor": "{count, plural, one {# match} other {# matches}} for “{query}”"`.

Spanish follows the same ICU shape.

- [ ] **Step 4: Run them to see them pass.**
Run: the same command, then `pnpm check:i18n`.
Expected: PASS. With 0 matches, CodeMirror shows no list, so there is no search line (§10).

- [ ] **Step 5: Commit.**
Subject: "feat(editor): the [[ list opens with a search line and asks Rust once per pause (M4b §4)" (replay: `8c9f6f6`).

- [ ] **Step 6: Review focus 3 — write the pin.** Add to `linkComplete.test.tsx` (import `closeCompletion` and `completionStatus`):

```ts
  it('review focus: Escape while the query waits leaves the list closed and asks Rust nothing', async () => {
    const queries: string[] = [];
    mockIPC((cmd, args) => {
      if (cmd === 'link_suggest') queries.push((args as { query: string }).query);
      return [REX];
    });
    const v = editor('See [[');
    act(() => { startCompletion(v); });
    act(() => v.dispatch({ changes: { from: v.state.doc.length, insert: 'g' }, selection: { anchor: v.state.doc.length + 1 }, userEvent: 'input.type' }));
    act(() => { closeCompletion(v); });
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(completionStatus(v.state)).toBeNull();
    expect(document.querySelector('.cm-tooltip-autocomplete')).toBeNull();
    expect(queries).toEqual([]);
  });
```

- [ ] **Step 7: Run it.**
Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/features/editor/linkComplete.test.tsx -t "review focus"`
Expected: PASS. This is a pin: the `context.aborted` check after the pause already holds it.

- [ ] **Step 8: Commit.** Use `$SP/m4b-pending/2-task5-escape-debounce.msg` (pending).

---

### Task 6: The Link picker follows the text and stays inside the window

Spec §4 (⌘K picker).

**Files:**
- Create: `features/editor/placePopup.ts`, `placePopup.test.ts`, `features/editor/PickerPopup.tsx`
- Modify: `features/editor/LinkPicker.tsx` (rebuilt on `PickerPopup`)
- Test: `features/editor/LinkPicker.test.tsx`

**Interfaces:**
- Produces:
  - `placePopup(anchor: Anchor, size, viewport): { top; left; above }`, with `Anchor { top; bottom; left }`, GAP 6, MARGIN 8;
  - `PickerPopup({ source, anchor: () => Anchor | null, allowUrl, label, placeholder, onPick, onClose(refocus) })`, `type PickerOption = { kind: 'url'; url } | { kind: 'page'; page }`. Task 8 reuses it.

- [ ] **Step 1: Write the failing tests.**
- `placePopup.test.ts`: "opens under the line, aligned with it", "flips above the line when there is no room below", "keeps inside the window at the right edge", "stays clamped to the nearest edge when the line scrolls out of view", "a window too short for either side gets the larger side, clamped".
- `LinkPicker.test.tsx`:

```ts
  it('re-anchors when the editor scrolls or the window resizes, and stays in the window', async () => {
    await mount('Hello there\n', 0, 5);
    let line = { top: 100, bottom: 120, left: 200 };
    const spy = vi.spyOn(viewOf(), 'coordsAtPos').mockImplementation(() => ({ ...line, right: line.left }));
    pressModK();
    const box = () => screen.getByRole('combobox', { name: 'Link to…' }).closest('div')!;
    await waitFor(() => expect(box().style.top).toBe('126px'));
    expect(box().style.left).toBe('200px');
    line = { top: 40, bottom: 60, left: 200 };
    act(() => { viewOf().scrollDOM.dispatchEvent(new Event('scroll')); });
    await waitFor(() => expect(box().style.top).toBe('66px'));
    line = { top: -500, bottom: -480, left: 200 };
    act(() => { window.dispatchEvent(new Event('resize')); });
    await waitFor(() => expect(box().style.top).toBe('8px'));
    spy.mockRestore();
  });
```

- [ ] **Step 2: Run them to see them fail.**
Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/features/editor/placePopup.test.ts src/features/editor/LinkPicker.test.tsx`
Expected: FAIL. `./placePopup` doesn't resolve, and the picker doesn't move.

- [ ] **Step 3: Implement.**

```ts
// placePopup.ts
export function placePopup(anchor: Anchor, size: { width: number; height: number }, viewport: { width: number; height: number }) {
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - size.height;
  const roomBelow = viewport.height - MARGIN - below;
  const roomAbove = anchor.top - GAP - MARGIN;
  let top: number;
  let flipped = false;
  if (size.height <= roomBelow || roomBelow >= roomAbove) top = below;
  else { top = above; flipped = true; }
  return {
    top: clamp(top, MARGIN, Math.max(MARGIN, viewport.height - MARGIN - size.height)),
    left: clamp(anchor.left, MARGIN, Math.max(MARGIN, viewport.width - MARGIN - size.width)),
    above: flipped,
  };
}
```

`PickerPopup`:
- `reposition()` calls `placePopup(anchor(), box size, window size)`;
- it runs in a layout effect on mount and whenever the options or the query change;
- it also runs on `window` `scroll` (capture) and `resize`;
- it renders `<div className={styles.linkPicker} style={place}>` holding the combobox and the "Pages" listbox (max 8 pages; the URL first when `allowUrl`).

`LinkPicker` passes `anchor = () => view.coordsAtPos(view.state.selection.main.from)`, and keeps the M2c insert logic.

- [ ] **Step 4: Run them to see them pass.**
Run: the same command, then the full vitest.
Expected: PASS.

- [ ] **Step 5: Commit.**
Subject: "fix(editor): the Link picker follows the text while it scrolls and stays inside the window (M4b §4)" (replay: `2a63c3e`).

---

### Task 7: Pasted TIFF, BMP or HEIC images are saved as PNG

Spec §4 (paste).

**Files:**
- Modify: `features/editor/attachments.ts`, `i18n/locales/{en,es}.json` (`attach.cantPaste`)
- Test: `features/editor/attachments.test.tsx`

**Interfaces:**
- Produces: `toPng(blob): Promise<Blob | null>`; the paste handler accepts `convertible(type)` (image/* that isn't stored and isn't SVG).

- [ ] **Step 1: Write the failing tests.** Add the describe "pasting other image types (M4b §4)". A `decoder(ok)` helper stubs `createImageBitmap`, `HTMLCanvasElement.getContext` and `toBlob` (jsdom can't decode). It has three tests:
- "a TIFF (Preview, Photos) is converted to PNG before it is saved": the saved bytes are the decoder's PNG, and the doc is `![[shot.png]]x\n`;
- "an image the webview can't decode says so and saves nothing";
- "SVG is left to the editor's own paste (never decoded or saved)".

- [ ] **Step 2: Run them to see them fail.**
Run: `pnpm --filter @nimw/desktop exec vitest run --maxWorkers=2 src/features/editor/attachments.test.tsx`
Expected: FAIL. `image/tiff` isn't taken by the paste handler.

- [ ] **Step 3: Implement.**

```ts
const convertible = (type: string) =>
  type.startsWith('image/') && !PASTE_TYPES[type] && type !== 'image/svg+xml';

export async function toPng(image: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(image);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'));
  } catch {
    return null;
  }
}
// pasteImages: for each file in order —
//   const file = PASTE_TYPES[pasted.type] ? pasted : await toPng(pasted);
//   if (!file) { toast attach.cantPaste; continue; }
//   name = pastedName(now, PASTE_TYPES[pasted.type] ? pasted.type : 'image/png')
// the handler: files = data.files filtered by PASTE_TYPES[f.type] || convertible(f.type)
```

The string `attach.cantPaste` is "This image can't be pasted. Save it as PNG or JPEG first."

- [ ] **Step 4: Run them to see them pass.**
Expected: PASS.

- [ ] **Step 5: Commit.**
Subject: "feat(editor): pasted TIFF, BMP or HEIC images are saved as PNG (M4b §4)" (replay: `ea553bc`).

- [ ] **Step 6: Review focus 4 — write the pin.** Add before the SVG test:

```ts
  it('review focus: one undecodable image among others: the rest are saved, in order', async () => {
    decoder(false);
    const saved: number[][] = [];
    fakeDisk({ 'P.md': 'x\n' }, {
      attachment_paste: (bytes) => {
        saved.push([...(bytes as unknown as Uint8Array)]);
        const link = saved.length === 1 ? 'one.png' : 'two.jpg';
        return { path: `attachments/${link}`, link, copied: true };
      },
    });
    await mount('P.md');
    paste([
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
      new File([new Uint8Array([2])], 'odd.heic', { type: 'image/heic' }),
      new File([new Uint8Array([3])], 'b.jpg', { type: 'image/jpeg' }),
    ]);
    await vi.waitFor(() => expect(viewOf().state.doc.toString()).toBe('![[one.png]]\n![[two.jpg]]x\n'));
    expect(saved).toEqual([[1], [3]]);
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('This image can’t be pasted. Save it as PNG or JPEG first.');
  });
```

- [ ] **Step 7: Run it.**
Run: `… vitest run … src/features/editor/attachments.test.tsx -t "review focus"`
Expected: PASS. This is a pin; the loop is sequential and skips the failure.

- [ ] **Step 8: Commit.** Use `$SP/m4b-pending/3-task7-mixed-paste.msg` (pending).

---

### Task 8: Related pages as chips in the header band

Spec §6 (Related chips).

**Files:**
- Create: `features/page/RelatedChips.tsx`, `RelatedChips.test.tsx`
- Modify: `features/page/PageHeader.tsx` (chips in the facts row, before `NoteTitle`), `PageView.module.css` (`.related*`), `i18n/locales/{en,es}.json` (`page.related*`, `page.alreadyRelated`)

**Interfaces:**
- Consumes:
  - `relationsOf(page)`, `relate(source, target): RelateResult`, `removeRelation(r)` from `stores/relations.ts` (M3b);
  - `PickerPopup` (Task 6).
- Produces: `RelatedChips({ page, editable })`.

- [ ] **Step 1: Write the failing tests.** `RelatedChips.test.tsx`, describe "Related chips in the header band (M4b §6)":
- "lists the page's own relationships; a chip opens its page; directed ones show →": `C →` with title `rival`; clicking `B` opens `B.md`;
- "× removes a relationship from the frontmatter";
- "+ Related page picks a page and relates it": typing `bet`, then the option Beta, gives `---\nrelated:\n  - "[[Beta]]"\n---\n# A\n`;
- "an unresolved target shows muted, not clickable; no axe violations".

- [ ] **Step 2: Run them to see them fail.**
Expected: FAIL. `./RelatedChips` doesn't resolve.

- [ ] **Step 3: Implement.** The component, in commit `8cfb4d3`:
- **The list:** `<ul aria-label="Related pages">`, one `<li>` per relation:
  - a resolved one is a `button.relatedOpen` labelled with the file name (`→` appended when directed, the label as `title`);
  - an unresolved one is a muted `span` titled "Not found";
  - with `editable`, a `×` `button.relatedRemove` labelled "Remove the relationship to {name}".
- **Adding:** `button.relatedAdd` ("+ Related page", aria-label "Add a related page", `aria-expanded`) opens `PickerPopup` anchored to it (`allowUrl={false}`).
- **On pick:** `relate(page.path, o.page.path)`; `'exists'` shows the toast `page.alreadyRelated`; then reload.
- **On remove:** `removeRelation(r)`, then reload.
- **Re-reading:** relations are re-read whenever `page` changes.

- [ ] **Step 4: Run them to see them pass.**
Expected: PASS (vitest: 956 tests, 90 files).

- [ ] **Step 5: Commit.**
Subject: "feat(page): related pages as chips in the header band, with + Related page (M4b §6)" (replay: `8cfb4d3`).

- [ ] **Step 6: Review focus 5 — write the pin.**

```ts
  it('review focus: picking a page that is already related says so and writes nothing', async () => {
    const before = '---\nrelated:\n  - "[[Beta]]"\n---\n# A\n';
    const disk = fakeDisk({ 'A.md': before, 'Beta.md': '# Beta\n' }, backend(['A.md', 'Beta.md']));
    render(<PageScreen />);
    await open('A.md');
    await waitFor(() => expect(within(related()).getAllByRole('listitem')).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'Add a related page' }));
    await userEvent.type(screen.getByRole('combobox', { name: 'Related page' }), 'bet');
    await userEvent.click(await screen.findByRole('option', { name: /Beta/ }));
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.message)).toContain('Already related to Beta'));
    expect(disk.files.get('A.md')).toBe(before);
    expect(disk.calls.some(([c]) => c === 'page_write')).toBe(false);
    expect(within(related()).getAllByRole('listitem')).toHaveLength(1);
  });
```

- [ ] **Step 7: Run it.** Expected: PASS (a pin).

- [ ] **Step 8: Commit.** Use `$SP/m4b-pending/4-task8-already-related.msg` (pending).

---

### Task 9: Connect cards in the Global View toolbar

Spec §6 (Global View toolbar).

**Files:**
- Modify:
  - `features/global-view/gvStore.ts`, `Toolbar.tsx`, `GlobalView.tsx`, `Canvas.tsx`;
  - `GlobalView.module.css` (`.connect`, `.connectHint`);
  - `i18n/locales/{en,es}.json` (`gv.relations.connectCards`, `pickSource`, `dragHint`).
- Test: `features/global-view/Connect.test.tsx`

**Interfaces:**
- Produces:
  - `connectPick: boolean`, `startConnectPick()`;
  - `cancelConnect()` clears `connectFrom` and `connectPick`;
  - the toolbar button carries `data-gv-connect`.

- [ ] **Step 1: Write the failing tests.** Add the describe "Connect cards from the toolbar (M4b §6)":

```ts
  it('asks for the card to connect from, then the card to connect it to', async () => {
    render(<GlobalView />);
    await settled();
    const button = screen.getByRole('button', { name: 'Connect cards' });
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    const bar = screen.getByRole('status', { name: 'Connecting' });
    expect(bar).toHaveTextContent('Click the card to connect from');
    expect(bar).toHaveTextContent('or drag from a card’s link handle');
    fireEvent.click(await press('A.md'));
    await waitFor(() => expect(bar).toHaveTextContent('Pick the card to connect: A → ?'));
    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }]);
    fireEvent.click(await press('B.md'));
    await waitFor(() => expect(disk.files.get('A.md')).toBe('---\nrelated:\n  - "[[B]]"\n---\n# A\n'));
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });
```

There are two more tests:
- "Escape, or pressing the button again, leaves it": afterwards a card click drills in as usual;
- "a folder without an index note keeps it waiting; Cancel goes back to the button": the `Delta` folder gives the noIndex toast, the bar still asks for the source, and Cancel focuses the button.

- [ ] **Step 2: Run them to see them fail.**
Run: `… vitest run … src/features/global-view/Connect.test.tsx`
Expected: FAIL with `Unable to find an accessible element with the role "button" and name "Connect cards"`.

- [ ] **Step 3: Implement.** In `gvStore.ts`:

```ts
    open: async (card) => {
      if (get().connectFrom) return get().completeConnect(card);
      // Connect cards: this card is the one to connect from (M4b §6).
      // A folder without an index note can't be picked: the mode stays on.
      if (get().connectPick) {
        get().startConnect(card);
        if (get().connectFrom) set({ connectPick: false });
        return;
      }
      // …
    },
    startConnectPick: () => set({ connectPick: true, connectFrom: null }),
    cancelConnect: () => set({ connectFrom: null, connectPick: false }),
```

Elsewhere:
- **`back`, `modeChanged` and `reset`** also clear `connectPick`; `up()` cancels when either flag is set.
- **Toolbar:** a `button.connect` with `data-gv-connect` and `aria-pressed={connectPick || connectFrom !== null}`, showing `<LinkIcon/>` and "Connect cards". Clicking it toggles `startConnectPick()` / `cancelConnect()`.
- **GlobalView:**
  - the bar shows while `connecting`;
  - the status `aria-label` is "Connecting";
  - while picking, the text is `pickSource` plus `<span className={styles.connectHint}>{dragHint}</span>` ("(or drag from a card's link handle)");
  - `leaveConnect` and `onKeyDown` handle `connectPick`;
  - Cancel from the bar focuses the source card, or `[data-gv-connect]` while no card was picked yet.
- **Canvas:** a first click in pick mode counts as `connecting`, so a slow double click doesn't open the editor.

- [ ] **Step 4: Run them to see them pass.**
Expected: PASS (`Connect.test.tsx`: 24 tests; vitest: 959 tests, 90 files).

- [ ] **Step 5: Commit.**
Subject: "feat(global-view): Connect cards in the toolbar picks the source card, then the other" (replay: `06ab011`).

---

### Task 10: The macOS Dock icon inside Apple's grid

Spec §7.

**Files:**
- Create: `apps/desktop/src-tauri/icons/app-icon-macos.svg`, `src/appIcon.test.ts`
- Modify: `apps/desktop/src-tauri/icons/icon.icns` (regenerated; the other icons are unchanged)

- [ ] **Step 1: Write the failing test.** Create `src/appIcon.test.ts` (node environment, `describe.runIf(process.platform === 'darwin')`):
1. It runs `sips -s format png <icon.icns> --out <tmpdir>/icon.png`, which gives the 1024 representation.
2. It decodes the PNG with `node:zlib` and the PNG filters (it asserts 8-bit RGBA, not interlaced).
3. It asserts:
   - the four corners and the outer 64 px across the middle row and column have alpha 0;
   - (104, 512), (919, 512), (512, 104), (512, 919) and the centre have alpha 255;
   - (95, 512), (928, 512), (512, 95), (512, 928) and (110, 110) have alpha < 128 (the square is 824 px with rounded corners).

The full file is in commit `d77dff1`.

- [ ] **Step 2: Run it to see it fail.**
Run: `… vitest run src/appIcon.test.ts`
Expected: FAIL with `expected 255 to be +0`: the old icon is drawn edge to edge.

- [ ] **Step 3: Implement.** `app-icon-macos.svg` (1024 canvas): the shadow is seven rects of `fill-opacity 0.035` (`sips`/CoreSVG draws no SVG filters), then the square and the artwork:

```svg
  <rect x="100" y="100" width="824" height="824" rx="184" fill="#f4eff8"/>
  <g transform="translate(100 100) scale(20.6) translate(2 2) scale(0.9)">
    <!-- app-icon.svg's artwork, unchanged -->
  </g>
```

Then, from the repo root, with `<tmp>` a new absolute folder:

```bash
sips -s format png apps/desktop/src-tauri/icons/app-icon-macos.svg -o <tmp>/icon.png
pnpm -F @nimw/desktop tauri icon <tmp>/icon.png -o <tmp>/out
cp <tmp>/out/icon.icns apps/desktop/src-tauri/icons/icon.icns
```

The same steps are in the SVG's comment (written without `--`, which XML comments forbid).

- [ ] **Step 4: Run it to see it pass.**
Expected: PASS (vitest: 960 tests, 91 files). Check by eye: rendered beside the old icon on grey, the new one sits smaller, like other apps' icons.

- [ ] **Step 5: Commit.**
Subject: "feat(icons): the macOS Dock icon sits inside Apple's icon grid" (replay: `d77dff1`).

---

### Task 11: End to end in Chromium and WebKit; zero network

Spec §8 (E2E).

**Files:**
- Modify: `e2e/m4b.spec.ts`; `features/page/RelatedChips.tsx` (+ test), fixed after the e2e found the bug; `features/shell/Shell.module.css` (review focus 2)
- Test: `e2e/m4b.spec.ts` (Add cover → reposition stays in `m2c.spec.ts`, from Task 3)

- [ ] **Step 1: Write the e2e tests.** In `m4b.spec.ts`:
- **Helpers:** a `watchNetwork` (a request is local only for 127.0.0.1, `data:` or `nimw-asset`; others are aborted), and `stayedLocal(page, outside)`, which asserts no outside requests and no CSP violations. Every test ends with it.
- **Fixture:** `PAGES` adds `Long.md` (120 numbered lines).
- **Tests:**
  - "M4b §1: the title and subtitle are edited in the top bar": a rename gives `__nimwRenames` = `[{ from: 'B.md', to: 'Beta notes.md' }]`, and the subtitle Enter writes `subtitle: Second thoughts`;
  - "M4b §4: the ⌘K picker follows the text as it scrolls, and stays in the window": select "Line 8", ⌘K, then wheel 200 and wheel 6000 (the box stays inside the 8 px margins and the input keeps focus);
  - "M4b §6: a Related chip is added through the picker, opens its page, and is removed": scope the options to the "Pages" listbox (the format select has options too); Back returns to A;
  - "M4b §6: Connect cards picks the card to connect from, then the other": Alpha, then Long, gives `related:\n  - "[[Long]]"` and one manual edge.

- [ ] **Step 2: Run them.**
Run: `pnpm build:ui && PLAYWRIGHT_BROWSERS_PATH=<browsers> pnpm --filter @nimw/desktop exec playwright test e2e/m4b.spec.ts`
Expected: FAIL in both engines with a timeout on `getByRole('button', { name: 'Back to A' })`. A chip opened its page as a direct navigation, which resets the trail.

- [ ] **Step 3: Fix, then run.**
1. In `RelatedChips.tsx`: `onClick={() => void openPage(r.path!, null, 'link')}` (followed like a link: the back arrow returns here).
2. In the first `RelatedChips.test.tsx` test, add `expect(useTrailStore.getState().back).toEqual([{ path: 'A.md', heading: null }])`, and reset the trail store in `beforeEach`.
3. Run the vitest file. Expected: FAIL before the change (`expected [] to deeply equal [ { path: 'A.md', heading: null } ]`), PASS after.
4. Re-run the e2e. Expected: `10 passed` (5 tests × 2 engines).
5. Commit, with the subject "fix(page): a Related chip is followed like a link, so the back arrow returns" (replay: `963298f`).
6. Then commit the e2e, with the subject "test(e2e): M4b in Chromium and WebKit — top-bar title and subtitle, the ⌘K picker after scrolling, Related chips, Connect cards, zero network" (replay: `21bb25a`).

Full gate at `21bb25a`:
- vitest: 960 tests, 91 files;
- e2e: 134 passed;
- lint, typecheck, i18n, fmt, clippy, cargo test and deny: clean.

- [ ] **Step 4: Review focus 2 — write the pin.**
1. Add the long page to `PAGES`: ``[`${'A very long page name '.repeat(6).trim()}.md`]: '# Wordy\n\nText.\n'``.
2. Add, for 1280 and 900 px wide windows:

```ts
for (const width of [1280, 900]) {
  test(`review focus: a very long title is cut short in the top bar at ${width} px; Edit · Global view stay whole`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const name = 'A very long page name '.repeat(6).trim();
    const outside = await open(page, name);
    const bar = page.getByRole('banner');
    const title = (await bar.getByRole('textbox', { name: 'Page title' }).boundingBox())!;
    const edit = (await bar.getByRole('button', { name: 'Edit' }).boundingBox())!;
    const gv = (await bar.getByRole('button', { name: 'Global view' }).boundingBox())!;
    expect(title.x + title.width).toBeLessThanOrEqual(edit.x);
    expect(gv.x + gv.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await stayedLocal(page, outside);
  });
}
```

3. The ⌘K test now asserts the picker stays *attached* to its line, not that it moved by a fixed amount. With a taller list (the long page's option), it opens flipped above, and after the scroll it sits below:

```ts
  const attached = async () => {
    const [p, l] = [await box(), (await line.boundingBox())!];
    return Math.abs(p.y - (l.y + l.height)) < 12 || Math.abs(p.y + p.height - l.y) < 12;
  };
  await expect.poll(attached).toBe(true);
  const before = (await line.boundingBox())!.y;
  await page.mouse.move(1180, 700);
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => (await line.boundingBox())!.y).toBeLessThan(before - 100);
  await expect.poll(attached).toBe(true);
```

- [ ] **Step 5: Run it to see it fail.**
Expected: FAIL in both engines: `expect(gv.x + gv.width).toBeLessThanOrEqual(900)`, received `1177.7`. The explorer row's automatic minimum width widened the sidebar to about 970 px. This bug dates from M1.

- [ ] **Step 6: Fix and run.** In `Shell.module.css`:

```css
.side {
  flex: 0 0 270px;
  /* A long page or folder name is cut short in its row; it never widens the
     sidebar (M4b review focus). */
  min-width: 0;
```

Run: `pnpm build:ui && playwright test e2e/m4b.spec.ts --repeat-each=2`. Expected: `28 passed`.

- [ ] **Step 7: Commit.** Use `$SP/m4b-pending/5-task11-long-name-sidebar.msg` (pending).

Full gate with the five pins (run by the coordinator): vitest 992 tests, e2e 138 passed, all checks clean.

---

## Self-review

- **Spec coverage:**

| Spec | Tasks |
|---|---|
| §1 | Tasks 2 and 3, plus review focus 1 and 2 |
| §2 | Task 3 |
| §3 | Task 1 |
| §4 | Tasks 5, 6 and 7. The screenshot item is the hand-off's (no code). |
| §5 | Task 4 |
| §6 | Tasks 8 and 9 |
| §7 | Task 10 |
| §8 | Each task's tests and Task 11. Add cover → reposition is in `m2c.spec.ts`; zero network is in every M4b e2e test. |
| §9 | Untouched |

  Deviations are recorded in spec §10.
- **Placeholders:** none. The code steps show the key code, and the rest is named by commit.
- **Type consistency:** these names are used the same way across tasks:
  - `Anchor`, `placePopup`, `PickerPopup`, `PickerOption`;
  - `CoverState.of`;
  - `connectPick`, `startConnectPick`, `cancelConnect`;
  - `overrideObsidian` / `override_obsidian`;
  - `SUGGEST_DEBOUNCE_MS`;
  - `--color-surface-veil`, `--color-danger(-contrast)`.
- **Review Focus:** five pins, each with its test in the owning task (3, 11, 5, 7, 8). Two of them found bugs, fixed in the same task.
