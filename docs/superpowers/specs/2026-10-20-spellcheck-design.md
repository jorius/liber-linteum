# Spell checking: design

Status: written from Jose's answers (2026-10-20); plan to follow.

## 0. Intent

Spell checking in the editor, with **full privacy**:

- dictionaries live on the machine;
- nothing is sent anywhere;
- the operating system's spelling service never sees the text either.

The user picks one or more dictionaries.

**Jose decided:**

- Ship three dictionaries: **Spanish (Colombia)**, **Spanish (generic)** and **English (US)**.
- Other dictionaries can be added from disk.
- Several dictionaries can be active at once.

## 1. Goals / non-goals / anti-goals

**Goals**

- Misspelled words get a wavy underline in Live Preview and Source modes.
- Right-click on a misspelled word offers:
  - suggestions;
  - **Add to dictionary**;
  - **Ignore** (for this session).
- More than one dictionary can be active at once. A word is correct if **any** active dictionary accepts it, so mixed Spanish/English notes work.
- An app-wide set of dictionaries, which a vault can override.
- Add any Hunspell dictionary (`.dic` + `.aff`) from disk, and remove dictionaries added this way.

**Non-goals**

- Grammar or style checking.
- Automatic language detection.
- Spell checking in the title, subtitle, search, rename or settings fields. Those stay `spellCheck={false}`.

**Anti-goals**

- Any network request, including downloading dictionaries. P1 still holds.
- Using the WebView's or the OS's spell checker. CodeMirror already sets `spellcheck="false"`, and that stays.
- Typing lag on large notes.
- Words added to a dictionary leaking out of an encrypted vault (see §3).

## 2. Engine and dictionaries

- **Engine.** Use a pure-Rust, Hunspell-compatible checker in a new crate, `liber-spell`.
  - **Candidate:** `spellbook` (the Helix editor project). The plan must verify, from primary sources, its version, licence, Hunspell feature coverage (affixes, compounding as used by the es and en dictionaries), and suggestion support.
  - **Requirements:**
    - pure Rust;
    - passes `cargo deny`, whose allow list includes MPL-2.0;
    - builds with cargo-xwin.
  - **If it can't suggest corrections:** the plan says so and proposes the smallest fallback, such as an edit-distance search over the dictionary's word list.
- **Bundled dictionaries.** Vendored into the repo with their licence files and shipped as Tauri resources:
  - `es_CO`: Spanish (Colombia);
  - `es`: generic Spanish;
  - `en_US`: English (US).
  - **Source:** the LibreOffice / RLA-ES and SCOWL Hunspell sets, or their packaging in wooorm/dictionaries. The plan records the exact source, version and licence. The Spanish set is tri-licensed GPL/LGPL/MPL, which is compatible with the app's GPL-3.0-or-later.
- **Imported dictionaries.**
  - The user picks a `.aff` and its `.dic` (the picker accepts either, finds its sibling, and asks if the sibling is missing).
  - Each file is limited to 20 MB, and the pair must parse before it is accepted.
  - The pair is copied into the app data dir, in `dictionaries/<id>/`. The name comes from the file stem, and the user can rename it.
  - Removing an imported dictionary deletes its copy.
- **Loading.** Only the active dictionaries are loaded, lazily on first use, off the main thread. They are dropped when they're no longer active.

## 3. Words the user adds

- **Add to dictionary** writes the word to the **vault's** word list, `.liber/spelling.txt`: one word per line, NFC-normalised, sorted, deduplicated.
  - **Why the vault, not the app:** an encrypted vault (encryption spec §5) must not leave words derived from its content outside itself. The list therefore lives in the vault and is encrypted with it.
  - **What it costs:** a word added in one vault isn't known in another.
- **Ignore** lasts only for the session, per vault, and is held in memory.
- **Settings → Spelling** shows the vault's word list. Words can be removed from it.

## 4. Settings

- **A new Settings category, "Spelling"** (app level):
  - **Check spelling:** on by default.
  - **Dictionaries:** a list of checkboxes. The three bundled dictionaries come first, then imported ones, each with Remove.
  - **Add dictionary from disk…**
  - **Default selection:** the dictionary matching the app language. English selects `en_US`; Spanish selects `es`, the generic Spanish (_my call_: `es` covers every region, and Jose can switch to `es_CO`).
- **"This vault"** gains a "Spelling" control with two choices: "Use the app's dictionaries", or a custom set (the same checkbox list). The choice is stored in `.liber/vault.json` as `spelling: { dictionaries: [ids] } | absent`.

## 5. What gets checked

**Tokenising.** Words are split with `Intl.Segmenter` (word granularity, `isWordLike`). Apostrophes and hyphens inside a word follow the segmenter.

**Skipped, decided from the Markdown syntax tree:**

- fenced and indented code, and inline code;
- URLs, link destinations, autolinks, and wikilink targets (the display text after `|` is checked);
- HTML;
- frontmatter;
- math;
- `#tags`;
- footnote labels.

**Skipped by shape:**

- words containing digits;
- words in ALL CAPS of 2 or more letters (acronyms);
- words with inner capitals, like `camelCase` or `iPhone`.

**Scope.** Only the visible ranges (CodeMirror's viewport) are checked. Results are cached per word for each set of active dictionaries plus the vault word list, and the cache is cleared when that set changes. Typing re-checks the touched words after a 300 ms debounce.

**Calls.** IPC calls are batched as `spell_check(words: string[]) -> boolean[]` (deduplicated) and `spell_suggest(word: string) -> string[]` (at most 7).

**Performance budget.** At most 4 ms of main-thread time per keystroke on a 10 000-line note. The existing editor perf tests also gain a spelling-on case.

## 6. UI details

- **The underline** is wavy, uses `--color-danger`, and works in all palettes and in dark mode. The underline carries no `aria-invalid`. A screen reader user can still use the context menu, which is reachable with Shift+F10 / the context-menu key on the word under the cursor.
- **The menu** shows suggestions at the top (clicking one replaces the word, as one undo step), then a separator, then Add to dictionary and Ignore. On a correct word the existing editor menu is unchanged.
- **Live Preview** checks the rendered text the same way. Hidden syntax is never underlined.

## 7. Testing

- **Rust:**
  - the bundled dictionaries load;
  - known words are accepted and known misspellings rejected, in each language (for example "cancion"→"canción", "recieve"→"receive");
  - with several dictionaries active, a word passes if any one accepts it;
  - an imported pair is validated, and a too-big or unparseable file is refused;
  - the vault word list is read and written atomically.
- **Vitest:**
  - the tokeniser and the skip rules: a table of Markdown snippets with the words expected to be checked;
  - the cache and its invalidation;
  - the debounce;
  - the menu actions.
- **e2e (Chromium and WebKit):**
  - a misspelled word is underlined;
  - a suggestion replaces it;
  - Add to dictionary removes the underline, including after a reload;
  - code is never underlined;
  - with spelling off, nothing is underlined;
  - axe passes.
- **No-network assertion:** extend the existing zero-network-requests test to cover a spelling session.

## 8. As built: the builder's rulings (2026-10-20)

Each ruling ends with what it costs if it turns out wrong.

**Storage and packaging**

1. **Added words live in `.liber/vault.json`** under `spellingWords`, not in a separate `.liber/spelling.txt`. This reuses the existing atomic, compare-and-swap JSON update, and the words still live inside the vault, so encryption §5 holds. The words are NFC-normalised, sorted and unique. _Cost if wrong:_ moving one key into its own file.
2. **The dictionaries are compiled into the binary** with `include_str!`; they are not Tauri resources. They are `dictionary-en@4.0.0`, `dictionary-es@4.0.0` and `dictionary-es-co@2.0.0` from wooorm/dictionaries, with their licence and source in `crates/liber-spell/dictionaries/*/`. The Spanish sets are used under GPL-3.0. _Cost:_ the binary grows by about 2.3 MB.
3. **The engine is `spellbook` 0.4.2** (MPL-2.0, pure Rust). Suggestions work, so no fallback suggester was needed.
4. **Imported dictionaries get the id `user:<slug>`** and live in `<config>/dictionaries/user-<slug>/`, because `:` isn't valid in Windows folder names. The import picker runs in Rust through the cover-picker test hook, so no path ever comes from the webview. _Cost if wrong:_ a rename.
5. **A deleted dictionary reports `available: false`.** If an imported dictionary's files are deleted by hand, it says so even while it is still loaded in memory. _Cost:_ none.

**Commands** 6. **`spell_check` and `spell_suggest` take the UI's resolved language (`lang`).** Rust can't detect the OS locale, and `language` is unset when the app follows the OS. The language picks the default dictionary only when none is chosen: Spanish gives `es`, anything else gives `en_US`. _Cost if wrong:_ one parameter to drop later. 7. **There is a new error kind, `invalidInput`,** covering a bad word or an unknown dictionary id. _Cost:_ one enum variant. 8. **Ignored words last for the session of one open vault.** Reopening the same vault starts a new session, so they clear without needing hooks into open and close. _Cost:_ none. 9. **The settings patch can set `spellDictionaries` but can't clear it back to `null`,** because the UI always writes an explicit list. _Cost if wrong:_ a "reset to default" button would need a double option.

**Editor** 10. **What counts as a word follows the parsed page model.** Only `text` nodes and a wikilink's shown text are checked, so code, math, HTML, frontmatter, tags, URLs (autolinks included) and comments are skipped. _Cost:_ none. 11. **Single-file windows don't check spelling.** They have no vault to keep added words in, and their capability has no spell commands. _Cost if wrong:_ add the commands to the file-window capability and decide where added words go. 12. **The 4 ms keystroke budget is met by design.** A keystroke only resets the 300 ms timer. The check after a pause adds at most about 9 ms to the worst frame, once, on a 200 KB note. The probe in `e2e/m4-perf.spec.ts` measured the worst frame at 18–22 ms with spelling off and 19–30 ms with it on. _Cost if wrong:_ rework the visible-range scan.

**Settings UI** 13. **Removing an imported dictionary asks inside its row,** "Remove X? [Remove] [Cancel]", not in a dialog. A dialog would sit inside the Settings dialog. _Cost if wrong:_ swap in a dialog. 14. **Quick checkbox clicks build on each other.** A local draft holds the newest set, so a second click doesn't undo the first before it has saved. _Cost:_ none.

**Deferred**

- A line that starts with a `%%` comment parses as an indented code block. The parser replaces comments with spaces, so the rest of that line ends up indented. This is pre-existing behaviour, not caused by spelling.

## 9. Final review fixes (2026-10-20)

From the fresh-context review of round 3b plus spell checking, fixed test-first on `fix/r3-final`:

- **No dictionary (#2).** With no usable dictionary active (none ticked, or only imported ones whose files are gone), nothing is flagged. Settings → Spelling says "No dictionary selected — spelling is not checked" ("Ningún diccionario seleccionado: no se revisa la ortografía").
- **Stale answers (#3).** A check answered after the dictionaries changed is dropped; the bump already scheduled a fresh one.
- **Licences (#4).** `THIRD-PARTY-NOTICES.md` credits spellbook (MPL-2.0) and the three dictionaries with their sources, versions and licences. The licence texts ship in the app's resources under `licenses/`. A test fails if a bundled dictionary's `LICENSE` isn't both named and bundled.
- **Case forms (#7).** An added word also matches its Title and ALL-CAPS forms, as Hunspell does for its own words: `liber` accepts `Liber` and `LIBER`. Mixed case such as `lIber` still matches only itself.
- **Language change (#8).** Changing the UI language bumps the spell key, so answers are re-checked against the new language's default dictionary.
- **Menu placement (#11).** The spelling menu is placed with `placePopup`, so it stays inside the window, and Tab closes it and gives focus back to the editor.
- **Caching (#12).** A vault's spelling settings are cached until `.liber/vault.json` changes (keyed on its mtime and size), and also dropped after this app writes them. An imported dictionary that fails to load isn't read again until its files' modification times change, or it is removed and re-imported.
