# Spell Checking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Underline misspelled words in the editor and offer suggestions, using local Hunspell dictionaries only. Ship Spanish (Colombia), Spanish and English (US), let the user import more from disk, and allow several to be active at once.

**Architecture:** A new pure-Rust crate, `liber-spell`, wraps the `spellbook` checker and embeds the three bundled dictionaries. Tauri commands check batches of words against the active set (app settings, or the vault's override) plus the vault's word list. A CodeMirror extension tokenises only the prose text nodes of the page's existing parsed model (`parsedFor`) in the viewport, caches the answers and draws wavy underlines. A small `SpellMenu` handles suggestions, Add to dictionary and Ignore.

**Tech Stack:** Rust (`spellbook` 0.4.2, MPL-2.0), Tauri 2 commands, React 19, CodeMirror 6, zustand, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-spellcheck-design.md`

## Engine and dictionary verdict (checked 2026-10-20, primary sources)

- **`spellbook` 0.4.2:**
  - **Release and licence:** released 2026-06-03, licence **MPL-2.0** (in deny.toml's allow list), MSRV 1.70. Repo `helix-editor/spellbook`.
  - **Dependencies:** `hashbrown`, plus `foldhash` behind the default `default-hasher` feature. Pure Rust, no C, so cargo-xwin is fine.
  - **API** (docs.rs): `Dictionary::new(aff: &str, dic: &str) -> Result<Dictionary, ParseDictionaryError>`, `check(&self, &str) -> bool`, `suggest(&self, &str, &mut Vec<String>)`, `add(&mut self, &str)`.
  - **Maturity:** the README calls it alpha. Phonetic suggestions are not implemented, and complex compounding "may work less well".
  - **Throwaway spike** (`$SP/spike-spell`, release build, Apple silicon), loading each `index.aff`/`index.dic` below:

    | | en | es | es-CO |
    |---|---|---|---|
    | load | 5 ms | 8 ms | 6 ms |
    | check | under 50 µs per word | | |
    | suggest | 1–18 ms | | |

    - en: `recieve`→`receive, relieve, reverie`; `colour` is rejected and suggests `color`.
    - es: `cancion`→`canción`; `dámelo`, `dígaselo` and `rápidamente` are accepted.
    - es-CO additionally accepts `parcero`, which es rejects.

  **Verdict: use it.** No fallback suggester is needed.
- **Dictionaries:** taken from **wooorm/dictionaries**, which crawls the upstream sets, normalises them to UTF-8 (`SET UTF-8`) and publishes them on npm.

  | id | npm package | upstream | licence | `index.aff` | `index.dic` |
  |---|---|---|---|---|---|
  | `en_US` | `dictionary-en@4.0.0` | SCOWL, wordlist.aspell.net | `(MIT AND BSD)` | 3.0 KB | 539 KB |
  | `es` | `dictionary-es@4.0.0` | sbosio/rla-es (RLA-ES) | `(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)` | 163 KB | 690 KB |
  | `es_CO` | `dictionary-es-co@2.0.0` | sbosio/rla-es (RLA-ES) | `(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)` | 154 KB | 725 KB |

  The total is ≈ 2.3 MB of text, embedded in the binary. The Spanish licence choice is GPL-3.0, which matches the app's `GPL-3.0-or-later`.

## Global Constraints

- **No network, ever.** P1/NFR-04 holds: no dictionary download, and the zero-network e2e stays green with spelling on.
- **No OS or WebView spell checker.** CodeMirror's `spellcheck="false"` and the existing `spellCheck={false}` fields stay as they are.
- **Dependencies:** new Rust deps must pass `cargo deny check`, and nothing may need a C toolchain (cargo-xwin cross-builds Windows).
- **Bundled ids and names:**
  - `en_US` "English (US)" / "Inglés (EE. UU.)";
  - `es` "Spanish" / "Español";
  - `es_CO` "Spanish (Colombia)" / "Español (Colombia)".
- **Default set** (when the app setting is unset): app language `es` → `["es"]`, otherwise `["en_US"]`.
- **Correctness rule:** a word is correct if **any** active dictionary accepts it, or it is in the vault word list or the session's ignored words.
- **Imports:** each of the `.aff` and `.dic` files is at most **20 MB**, and the pair must parse with `Dictionary::new` before it is accepted.
- **Suggestions:** at most **7** per word. The per-word dictionary order is the active order, duplicates are dropped, and the first suggester wins.
- **Re-check debounce:** **300 ms** after typing. Only the viewport is checked.
- **Main-thread budget:** at most **4 ms** per keystroke on a 10 000-line note.
- **Underline:** wavy, colour `var(--color-danger)`, class `cm-liber-misspelled`.
- **Locales:** every new string is added to both `en.json` and `es.json` (the parity test).
- **Commands:** every new Tauri command is added to `build.rs`, `capabilities/main.json`, the command list in `src-tauri/tests/commands.rs`, `src/ipc/index.ts` and `e2e/ipcMock.ts`, following the favorites pattern.
- **Text files** (`isTextPath`) are not checked. Only pages are.

## Rulings (deviations from the spec, decided here)

1. **The vault word list is stored in `.liber/vault.json`** as `spellingWords: string[]`, not in `.liber/spelling.txt`. It reuses `update_json_object`, which is atomic, compare-and-swap and serialised, so it needs no new file-write path. It is still inside the vault, so encryption §5 holds. *Cost if wrong:* moving one key into a file.
2. **Bundled dictionaries are embedded with `include_str!`,** not shipped as Tauri resources. This means no resource-path plumbing, and tests and cross-builds see the same bytes. *Cost:* the binary grows by about 2.3 MB.
3. **Skipping follows the parsed model, not Lezer.** Only text inside mdast `text` nodes is checked, plus a wikilink's display part. Code, math, HTML, frontmatter, tags, URLs and comments are skipped because they are not `text` nodes. This is the same model Live Preview and the outline already use, and it works the same in Live Preview and Source.
4. **The import picker runs in Rust,** through the `cover_picker` test hook, as `audio_upload` does. No path ever comes from the webview.

## Review Focus

1. **A word next to Markdown syntax:** `**palabra**`, `_word_`, `[texto](url)`, `[[Página|texto]]`. Only the visible word is checked, and its range excludes the marks.
2. **Accents and Unicode:** `canción` written as decomposed `canción` (macOS file names, pasted text). It must be NFC-normalised before checking and before adding.
3. **Apostrophes:** `don't` with ASCII `'` and with the typographic `’`. Both must be accepted by en_US.
4. **Switching vaults or dictionaries:** the cache must not reuse answers from the previous set. A word added in vault A must not stay un-underlined in vault B.
5. **A removed or broken imported dictionary still listed in settings** (its folder deleted by hand). Checking keeps working with the remaining dictionaries, and the Settings row says it couldn't be loaded.

---

## File Structure

| File | Responsibility |
|---|---|
| `crates/liber-spell/Cargo.toml`, `src/lib.rs` | `Speller`: bundled list, lazy loading, check, suggest, import validation |
| `crates/liber-spell/dictionaries/{en_US,es,es_CO}/` | `index.aff`, `index.dic`, `LICENSE`, `SOURCE.md` (package, version, upstream) |
| `crates/liber-vault/src/spelling.rs` | `.liber/vault.json` keys `spelling` (override) and `spellingWords` |
| `apps/desktop/src-tauri/src/settings.rs` | `spellcheck: bool`, `spellDictionaries: Option<Vec<String>>`, `importedDictionaries: Vec<ImportedDictionary>` |
| `apps/desktop/src-tauri/src/spell_commands.rs` | commands and `SpellState` (loaded dictionaries, session ignores) |
| `apps/desktop/src/features/editor/spell.ts` | `wordsToCheck` tokeniser, the CodeMirror spell extension, cache |
| `apps/desktop/src/features/editor/SpellMenu.tsx` | suggestions / Add to dictionary / Ignore menu |
| `apps/desktop/src/stores/spellStore.ts` | enabled flag, active-set key (cache invalidation), menu open state |
| `apps/desktop/src/features/dialogs/SpellingSettings.tsx` | the Settings "Spelling" category and the This-vault control |

---

### Task 1: `liber-spell` crate with the bundled dictionaries

**Files:**
- Create: `crates/liber-spell/Cargo.toml`, `crates/liber-spell/src/lib.rs`, `crates/liber-spell/dictionaries/**`
- Modify: root `Cargo.toml` (workspace member, `spellbook = "=0.4.2"` in workspace deps)
- Test: `crates/liber-spell/tests/speller.rs`

**Interfaces:**
- Produces:
  - `pub const BUNDLED: &[(&str, &str, &str)]`: (id, aff, dic) for `en_US`, `es`, `es_CO`.
  - `pub struct Speller`.
  - `Speller::new() -> Speller`.
  - `Speller::load_bundled(&self, id: &str) -> Result<(), SpellError>`.
  - `Speller::load_files(&self, id: &str, aff: &Path, dic: &Path) -> Result<(), SpellError>`.
  - `Speller::check(&self, active: &[String], extra: &HashSet<String>, words: &[String]) -> Vec<bool>`.
  - `Speller::suggest(&self, active: &[String], word: &str) -> Vec<String>` (≤ 7).
  - `pub fn validate(aff: &Path, dic: &Path) -> Result<(), SpellError>` (20 MB per file, then parses).
  - `pub enum SpellError { TooLarge(PathBuf), Unreadable(PathBuf), Invalid(String), Unknown(String) }`.
  - `Speller` holds `RwLock<HashMap<String, Arc<spellbook::Dictionary>>>`.
  - Unknown or unloaded ids in `active` are skipped, never an error.
  - Words are NFC-normalised before lookup and before comparing with `extra`, using the `unicode-normalization` crate if it is already in the lockfile, else add it (MIT/Apache).

- [ ] **Step 1: Vendor the dictionaries.** Run `npm pack dictionary-en@4.0.0 dictionary-es@4.0.0 dictionary-es-co@2.0.0` in a scratch dir and copy each `index.aff`, `index.dic` and `license` into `dictionaries/<id>/` (as `LICENSE`). Write `SOURCE.md` with the package, version, upstream and licence from the table above.
- [ ] **Step 2: Write the failing tests** in `tests/speller.rs`:

```rust
#[test] fn bundled_dictionaries_parse() { let s = Speller::new(); for (id, _, _) in BUNDLED { s.load_bundled(id).unwrap(); } }
#[test] fn checks_per_language() {
    let s = Speller::new(); for id in ["en_US", "es", "es_CO"] { s.load_bundled(id).unwrap(); }
    let w = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    assert_eq!(s.check(&w(&["en_US"]), &HashSet::new(), &w(&["receive", "recieve", "don't", "don’t"])), [true, false, true, true]);
    assert_eq!(s.check(&w(&["es"]), &HashSet::new(), &w(&["canción", "cancion", "cancio\u{301}n", "parcero"])), [true, false, true, false]);
    assert_eq!(s.check(&w(&["es_CO"]), &HashSet::new(), &w(&["parcero"])), [true]);
}
#[test] fn any_active_dictionary_accepts() { /* active ["es","en_US"]: "canción" and "receive" both true; "recieve" false */ }
#[test] fn extra_words_accept_nfc() { /* extra {"Ioque"}: "Ioque" true; extra {"cancio\u{301}n" normalised}: still true */ }
#[test] fn suggestions_are_capped_and_ordered() { /* active ["es","en_US"], "cancion" → first is "canción", len <= 7, no duplicates */ }
#[test] fn unknown_active_ids_are_skipped() { /* active ["nope","en_US"]: "receive" true */ }
#[test] fn validate_refuses_large_and_broken() { /* 20 MB + 1 byte file → TooLarge; aff "garbage\n" + dic "x" that Dictionary::new rejects → Invalid; a valid pair (copy of en_US) → Ok */ }
```

`don’t` (typographic apostrophe) is accepted as is: en_US's `.aff` has `ICONV 1`, which spellbook applies (confirmed in the spike: `don’t` → true).

- [ ] **Step 3: Run** `cargo test -p liber-spell`. Expected: FAIL to compile (`Speller` is undefined).
- [ ] **Step 4: Implement `lib.rs`** with the interface above. Embed with `include_str!("../dictionaries/en_US/index.aff")` and so on.
- [ ] **Step 5: Run** `cargo test -p liber-spell && cargo deny check`. Expected: all pass, deny ok.
- [ ] **Step 6: Commit** `feat(spell): liber-spell — spellbook with embedded en_US, es and es_CO dictionaries`.

### Task 2: Vault keys for the override and the word list

**Files:**
- Create: `crates/liber-vault/src/spelling.rs`
- Modify: `crates/liber-vault/src/lib.rs` (`mod spelling;`)
- Test: in-module `#[cfg(test)]`, following `favorite.rs`'s test style.

**Interfaces:**
- Produces, on `impl Vault`:
  - `spelling_dictionaries(&self) -> Option<Vec<String>>`: key `spelling.dictionaries`; absent means use the app's set.
  - `set_spelling_dictionaries(&self, ids: Option<&[String]>) -> Result<()>`: `None` removes the `spelling` key.
  - `spelling_words(&self) -> Vec<String>`: key `spellingWords`, sorted.
  - `add_spelling_word(&self, word: &str) -> Result<()>`: NFC-normalised, deduplicated, kept sorted.
  - `remove_spelling_word(&self, word: &str) -> Result<()>`: an emptied list removes the key.

- [ ] **Step 1: Write the failing tests:**
  - `override_round_trips_and_clears`: set `Some(["es_CO"])`, read it back, set `None`, and the key is gone; other keys in vault.json are untouched.
  - `words_are_sorted_unique_nfc`: add "zeta", "Ioque", decomposed "cancio\u{301}n", and "zeta" again → `["Ioque", "canción", "zeta"]`.
  - `removing_the_last_word_drops_the_key`.
- [ ] **Step 2: Run** `cargo test -p liber-vault spelling`. Expected: FAIL (no such methods).
- [ ] **Step 3: Implement** with `read_json` and `update_json_object`, as `favorite.rs` does.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(vault): spelling override and word list in .liber/vault.json`.

### Task 3: Settings fields and the spell commands

**Files:**
- Create: `apps/desktop/src-tauri/src/spell_commands.rs`
- Modify:
  - `settings.rs`: the fields, the patch, and `field!` lines;
  - `lib.rs`: `manage(SpellState)` and registration;
  - `build.rs`;
  - `capabilities/main.json`;
  - `Cargo.toml` of src-tauri (`liber-spell`);
  - `vault_commands.rs`: clear the session ignores on vault open and close.
- Test: `apps/desktop/src-tauri/tests/commands.rs` (and its command list)

**Interfaces:**
- Consumes: Task 1 `Speller`, `validate`, `BUNDLED`; Task 2 vault methods.
- Produces (Tauri commands, camelCase DTOs):
  - **Dictionaries:**
    - `spell_dictionaries() -> Vec<DictionaryDto { id, name, bundled: bool, available: bool }>`: bundled first, then imported. `available` is false when an imported dictionary's files are missing or don't parse.
    - `spell_import() -> Option<DictionaryDto>`: picks a `.aff` or `.dic` through the cover picker hook (native filter "Hunspell dictionary", `aff`, `dic`) and finds its sibling with the same stem.
      - A missing sibling → `ErrorKind::NotFound` "the .dic next to the .aff is missing".
      - Then `validate`, then copy to `<config>/dictionaries/<id>/index.{aff,dic}`, with id = `user:` + a lowercase slug of the stem, made unique with `-2`, `-3`.
      - Then append `{ id, name: stem }` to `importedDictionaries`.
    - `spell_remove(id: String) -> ()`: imported only (bundled → `NotPermitted`). It deletes the folder, drops the id from settings and from the vault override, and unloads it.
  - **Checking:**
    - `spell_check(words: Vec<String>) -> Vec<bool>`: at most 5000 words (`TooLarge` otherwise). Active set = the vault override, else `spellDictionaries`, else the language default. It loads lazily and passes the vault word list ∪ session ignores as `extra`.
    - `spell_suggest(word: String) -> Vec<String>`.
  - **Word list:**
    - `spell_add_word(word: String) -> ()`: a non-empty word of at most 100 chars, with no whitespace or control characters, else `InvalidInput`.
    - `spell_ignore(word: String) -> ()`: session only.
    - `spell_words() -> Vec<String>`.
    - `spell_remove_word(word: String) -> ()`.
  - **Vault override:** `spell_vault_get() -> Option<Vec<String>>` and `spell_vault_set(ids: Option<Vec<String>>) -> ()`. Ids must be known (bundled or imported), else `InvalidInput`.
  - **Settings (TS):** `spellcheck: boolean` (default `true`), `spellDictionaries: string[] | null` (default `null`), `importedDictionaries: { id: string; name: string }[]` (default `[]`).

- [ ] **Step 1: Write the failing integration tests** in `tests/commands.rs`, using the existing harness `h` and `call`. Add the 11 names to the command list.

```rust
#[test] fn spell_checks_with_the_language_default_then_the_vault_override() {
    // settings language "es" → spell_check(["canción","receive"]) == [true,false];
    // spell_vault_set(["en_US"]) → [false,true]; spell_vault_set(null) → back to [true,false]
}
#[test] fn spell_add_word_and_ignore() {
    // "Ioque" false → spell_add_word → true and vault.json has spellingWords ["Ioque"];
    // spell_ignore("Wayuunaiki") → true; after vault close + reopen → false (session only); spell_add_word("two words") → InvalidInput
}
#[test] fn spell_import_validates_copies_and_removes() {
    // set_cover_picker(Some(|| tmp/"Mine.aff")) with a valid pair (copy of en_US) → id "user:mine", files under <config>/dictionaries/user:mine/;
    // listed with available true; spell_remove → folder gone, id gone from settings; spell_remove("es") → NotPermitted;
    // picker returns an .aff whose .dic is missing → NotFound
}
#[test] fn settings_default_and_patch_spelling_fields() { /* defaults true/null/[]; patch spellDictionaries ["es_CO","en_US"] persists */ }
```

  Use `user-mine` instead if `:` is not valid in a folder name on Windows. The ruling: the id stays `user:mine`, but the folder name uses `-` instead of `:`.
- [ ] **Step 2: Run** `cargo test -p liber-desktop --test commands spell_`. Expected: FAIL (unknown commands).
- [ ] **Step 3: Implement** `spell_commands.rs` with `blocking(...)`, as `favorite_commands.rs` does. `SpellState { speller: liber_spell::Speller, ignores: Mutex<HashSet<String>> }` is managed in `configure`. The settings fields and patch follow `sidebar_width`.
- [ ] **Step 4: Run** `cargo test -p liber-desktop && cargo clippy --workspace --all-targets -- -D warnings`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(spell): spelling settings and commands (check, suggest, import, word list, vault override)`.

### Task 4: The editor extension: tokenise, check, underline

**Files:**
- Create: `apps/desktop/src/features/editor/spell.ts`, `apps/desktop/src/stores/spellStore.ts`
- Modify:
  - `features/editor/Editor.tsx`: a new `spellSlot = new Compartment()` in `createState` only (not `createTextState`), reconfigured when `useSpellStore` `enabled` changes;
  - `features/editor/Editor.module.css` or the `theme` in Editor.tsx: `.cm-liber-misspelled { text-decoration: underline wavy var(--color-danger); text-decoration-skip-ink: none; }`;
  - `src/ipc/index.ts`: wrappers for the Task 3 commands.
- Test: `apps/desktop/src/features/editor/spell.test.ts`

**Interfaces:**
- Consumes: `parsedFor(text, state)` from `pageModel.ts`; the IPC wrappers `spellCheck(words)` and `spellSuggest(word)`.
- Produces:
  - `wordsToCheck(page: ParsedPage, text: string, from: number, to: number): { from: number; to: number; word: string }[]`;
  - `spellcheck(): Extension`;
  - `misspelledAt(state: EditorState, pos: number): { from: number; to: number; word: string } | null`;
  - `clearSpellCache(): void`;
  - `useSpellStore`: `{ enabled: boolean; setKey: number; bump(): void }`. `bump` is called after any change to the dictionaries, the override, the words, an ignore, or the open vault. It clears the cache and re-checks the viewport.
- How `wordsToCheck` works:
  1. Walk `page.tree` and keep only `text` nodes, plus a `wikiLink` node's display part (after the first `|`, else the target).
  2. Drop ranges inside `page.comments` and frontmatter.
  3. Segment each kept range with `new Intl.Segmenter(undefined, { granularity: 'word' })` and keep segments where `isWordLike`.
  4. Then drop words that contain a digit, words in ALL CAPS of 2 or more letters, and words with an inner capital (`/\p{Ll}\p{Lu}/u`).
- How `spellcheck()` works: a `ViewPlugin`, debounced to 300 ms, over `view.visibleRanges`.
  1. Look up the uncached words in a module `Map<string, boolean>` that `bump` clears.
  2. Send them through one `spellCheck` call.
  3. Dispatch a `StateEffect` with the misspelled ranges and keep them in a `StateField<DecorationSet>`, mapped through changes.

- [ ] **Step 1: Write the failing tests.**

```ts
const cases: [string, string[]][] = [
  ['Una **palabra** mal escrita', ['Una', 'palabra', 'mal', 'escrita']],
  ['see [texto](https://ejemplo.com/ruta) here', ['see', 'texto', 'here']],
  ['[[Página destino|texto visible]] y [[Sola]]', ['texto', 'visible', 'y', 'Sola']],
  ['```js\nconst variabel = 1\n```\nfin', ['fin']],
  ['code `noSeRevisa` and $x^2 + y$ math', ['code', 'and', 'math']],
  ['---\ntitle: Titulo\n---\nCuerpo', ['Cuerpo']],
  ['#etiqueta y texto', ['y', 'texto']],
  ['NASA iPhone v2 camelCase normal', ['normal']],
  ['%% oculto %% visible', ['visible']],
  ["don't don’t", ["don't", 'don’t']],
];
it.each(cases)('wordsToCheck(%j)', (md, words) => {
  expect(wordsToCheck(parsePage(md), md, 0, md.length).map((w) => w.word)).toEqual(words);
});
it('a word range excludes its marks', () => {
  /* '**palabra**' → { from: 2, to: 9 } */
});
it('checks only uncached words, once per debounce, and bump re-checks', () => {
  /* vi.useFakeTimers; mock spellCheck; type twice within 300 ms → one call; bump → cache cleared, next pass calls again */
});
it('underlines misspelled words and maps them through edits', () => {
  /* spellCheck → [false] for "recieve" → one .cm-liber-misspelled over it; insert text before it → the decoration moves */
});
it('does nothing when disabled or for text files', () => {
  /* enabled false → no spellCheck call */
});
```

- [ ] **Step 2: Run** `pnpm --filter @liber/desktop exec vitest run src/features/editor/spell.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `spell.ts` and `spellStore.ts`, wire `spellSlot` in `Editor.tsx`, and add the IPC wrappers.
- [ ] **Step 4: Run** the same command, then `pnpm --filter @liber/desktop exec vitest run src/features/editor`. Expected: PASS, and the existing editor tests are unchanged.
- [ ] **Step 5: Commit** `feat(editor): spell checking underlines misspelled prose in the viewport (local dictionaries)`.

### Task 5: The spelling menu (suggestions, Add to dictionary, Ignore)

**Files:**
- Create: `apps/desktop/src/features/editor/SpellMenu.tsx`, plus styles that reuse the menu classes `SortMenu` uses
- Modify:
  - `spell.ts`: `EditorView.domEventHandlers({ contextmenu })` opens the menu when `misspelledAt(posAtCoords)` hits; `keymap` `Shift-F10` / `ContextMenu` opens it for the word at the cursor;
  - `Editor.tsx`: render `<SpellMenu />` next to `LinkPicker`;
  - the locales.
- Test: `apps/desktop/src/features/editor/SpellMenu.test.tsx`

**Interfaces:**
- Consumes: `misspelledAt`, `spellSuggest`, `spellAddWord`, `spellIgnore`, `useSpellStore.bump`.
- Produces: `openSpellMenu(view: EditorView, target: { from; to; word }, anchor: { x; y }): void`, set through `setSpellMenuOpener`, as `setLinkPickerOpener` is.
- Copy:
  - en: "No suggestions", "Add to dictionary", "Ignore".
  - es: "Sin sugerencias", "Agregar al diccionario", "Ignorar".
  - The menu's aria-label is "Spelling: {word}" / "Ortografía: {word}".

- [ ] **Step 1: Write the failing tests.**
  - `'lists up to 7 suggestions, then Add to dictionary and Ignore'`: mock `spellSuggest` returns 9 → 7 `menuitem`s plus 2.
  - `'a suggestion replaces the word in one undo step'`: click "receive" → the doc reads "receive"; `undo(view)` → "recieve".
  - `'Add to dictionary calls spell_add_word, bumps, and the underline goes'`.
  - `'Ignore calls spell_ignore and bumps'`.
  - `'Escape closes and returns focus to the editor; arrows move between items'`.
  - `'right-click on a correct word does not open it (the default menu is untouched)'`.
- [ ] **Step 2: Run** `pnpm --filter @liber/desktop exec vitest run src/features/editor/SpellMenu.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** The replacement is one `view.dispatch({ changes, userEvent: 'input.spell' })`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(editor): spelling menu — suggestions, add to dictionary, ignore`.

### Task 6: Settings: the Spelling category and the This-vault override

**Files:**
- Create: `apps/desktop/src/features/dialogs/SpellingSettings.tsx`
- Modify:
  - `SettingsDialog.tsx`: add `'spelling'` to `APP_CATEGORIES` after `'editor'`, a `CategoryIcon` case (reuse an existing icon, e.g. `FormatIcon`), and the `panel('spelling', <SpellingSettings />)`;
  - `VaultSettingsSection.tsx`: a "Spelling" select ("Use the app's dictionaries" / "Choose for this vault") plus the checkbox list when the second is chosen;
  - `stores/settingsStore.ts`: the three fields;
  - the locales: `settings.categories.spelling.title` / `.description`.
- Test: `apps/desktop/src/features/dialogs/SpellingSettings.test.tsx`

**Interfaces:**
- Consumes: the Task 3 commands, `useSpellStore.bump`.
- Produces: nothing new for other tasks.
- **Rows:**
  - "Check spelling" (a checkbox bound to `spellcheck`);
  - "Dictionaries" (a fieldset of checkboxes in `spell_dictionaries()` order, checked = the active app set; imported rows have a Remove button; unavailable rows are disabled and show "Couldn't be loaded");
  - "Add dictionary from disk…" (a button);
  - "Words added in this vault" (a list with a remove button per word; only when a vault is open; empty state "No words yet").
- **Behaviour:** unchecking the last dictionary is allowed and means nothing is checked. Every change calls `bump()`.

- [ ] **Step 1: Write the failing tests.**
  - `'shows the three bundled dictionaries with the language default checked'`: language es → only "Español" checked.
  - `'checking a second dictionary saves spellDictionaries in order and bumps'`.
  - `'import adds a row; Remove deletes it after confirmation'`: reuse `ConfirmDeleteDialog`.
  - `'an unavailable imported dictionary is disabled with its note'`.
  - `'This vault: choosing a custom set calls spell_vault_set; back to app clears it'`.
  - `'the word list removes a word'`.
  - `'Settings search finds "spelling" / "ortografía"'`.
- [ ] **Step 2: Run** `pnpm --filter @liber/desktop exec vitest run src/features/dialogs`. Expected: FAIL.
- [ ] **Step 3: Implement,** with `className="field-control"` on any select (the fields guard test).
- [ ] **Step 4: Run** the same command plus `pnpm check:i18n`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): Spelling category and per-vault dictionaries`.

### Task 7: End to end, zero network and performance

**Files:**
- Create: `apps/desktop/e2e/spell.spec.ts`
- Modify:
  - `e2e/ipcMock.ts`: the spell commands, backed by a tiny in-mock word list (`receive`, `canción`, `texto`…), where "recieve" is wrong with suggestion `["receive"]`, plus the vault word list in the mock vault.json;
  - `e2e/zero-network.spec.ts`: one more case with `settings: { spellcheck: true }` in Live Preview;
  - `e2e/m4-perf.spec.ts`: add a spelling-on run to the existing probe;
  - `playwright.config.ts`: add `spell.spec.ts` to the WebKit project's `testMatch`.
- Test: the files above.

- [ ] **Step 1: Write the failing e2e tests** in `spell.spec.ts`:
  - `'a misspelled word is underlined; code is not'`: the page is "recieve\n\n```\nrecieve\n```" → exactly one `.cm-liber-misspelled`.
  - `'right-click → a suggestion replaces it'`.
  - `'Add to dictionary removes the underline and survives a reload'`.
  - `'spelling off: nothing underlined'`.
  - `'the spelling menu and settings are axe-clean'` (light and dark).
- [ ] **Step 2: Run** `PLAYWRIGHT_BROWSERS_PATH=$SP/pw-browsers pnpm --filter @liber/desktop exec playwright test spell zero-network`. Expected: the new spell tests FAIL, because the mock lacks the commands.
- [ ] **Step 3: Add the mock commands and config,** and fix whatever the runs show.
- [ ] **Step 4: Run** the same command, and once, `LIBER_PERF=1 … playwright test m4-perf`. Expected: PASS, with the spelling-on worst frame within the probe's existing bound. Record the numbers in the probe's reference comment.
- [ ] **Step 5: Run the full gate** `$SP/check.sh all <worktree>`. Expected: ALL-OK.
- [ ] **Step 6: Commit** `test(spell): e2e, zero-network and perf coverage for spell checking`.

---

## Self-review (done)

- **Spec coverage:**
  - §1 goals → Tasks 4–6.
  - §2 engine and dictionaries → Task 1, with the verdict above.
  - §3 words → Tasks 2, 3 and 5 (Ruling 1: stored in vault.json).
  - §4 settings → Tasks 3 and 6.
  - §5 tokenising, skip rules, viewport, cache, IPC and budget → Tasks 3, 4 and 7 (Ruling 3: the parsed model).
  - §6 UI → Tasks 4 and 5 (underline, menu, keyboard).
  - §7 testing → Tasks 1–7.
  - The non-goals (title and other fields) stay `spellCheck={false}`; nothing touches them.
- **Types:** `Speller::check(active, extra, words)` is used only by Task 3. The IPC names `spellCheck`, `spellSuggest`, `spellAddWord`, `spellIgnore`, `spellDictionaries`, `spellImport`, `spellRemove`, `spellWords`, `spellRemoveWord`, `spellVaultGet` and `spellVaultSet` are the camelCase forms of the Task 3 commands.
- **Review Focus coverage:**
  - Review Focus 1 → the Task 4 marks and link cases.
  - Review Focus 2 → the Task 1 and Task 2 NFC tests.
  - Review Focus 3 → the Task 1 apostrophe test and the Task 4 `don’t` case.
  - Review Focus 4 → the Task 4 `bump` test; `bump` is also called on vault open and close (Task 3 Step 3 clears the ignores, and the vault store's open and close call `bump`; add that call in `vaultStore` open/close in Task 4 Step 3).
  - Review Focus 5 → the Task 3 `available:false` test and the Task 6 unavailable-row test.
