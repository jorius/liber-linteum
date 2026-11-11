# Focus mode — design

Date: 2026-11-11. Status: draft for the maintainer's review.

## 1. Intent

A distraction-free way to write, modelled on VS Code's Zen mode: one command turns the window into
just the words of the page, and the same command (or Escape twice) brings everything back. It is
on the roadmap ("Planned") and in the product spec as a candidate for writers.

The maintainer's words, in order: "something similar to the Zen mode from VS Code"; "only text,
hide everything else, only live preview available"; "word count, read time and saved status must
be shown"; "stay in focus mode on the new page but allow the user going back easily".

## 2. Goals, non-goals, anti-goals

**Goals**
- Full screen, with only the page's body text, in Live Preview, centred.
- A quiet strip that always shows words · read time (or the selection count), the saved status,
  and a way back along the link trail.
- Links, the quick switcher and search keep you in Focus mode on the new page.
- Leaving restores exactly what was there before: sidebar, panels, editor mode, full-screen state.

**Non-goals**
- **No paragraph dimming.** The roadmap line promised "the paragraph you're on in focus"; the
  maintainer dropped it. The site and README wording change to match (§7).
- No typewriter scrolling, no ambient sounds, no word-count goals, no settings for what Focus mode
  hides.
- Not remembered across restarts: the app always starts out of Focus mode.
- The single-file window (`SingleFileApp`) does not get Focus mode in this round (builder's call
  below; it has its own layout and no trail).

**Anti-goals** (it works but is still a failure if…)
- The user's saved `editorMode` setting is changed. Focus mode forces Live Preview *while on*; it
  never writes the setting.
- Leaving Focus mode drops the user out of full screen they had chosen themselves before entering.
- Text, selection, undo history or scroll position are lost on entering or leaving.
- A single Escape (meant to close find, a picker, a popup or the spell menu) throws the user out.

## 3. What is hidden, what stays

Hidden while Focus mode is on (main window, open vault):
- The custom title bar and its menus (Windows/Linux); on macOS full screen already hides the
  native menu bar.
- The sidebar and its reopen button, the floating Edit / Global view / Search button
  (`ActionButton`), the Outline panel, the formatting toolbar, line numbers.
- The whole page header (`PageHeader`): cover (top or side), page icon, title, subtitle,
  breadcrumb, related chips, mode toggle, width menu, the header's word count, cursor position and
  save status.
- `OriginalsBanner` and other non-essential bands. **Kept**: anything that protects the user's text —
  `UnwritableNotice`, the orphaned-page banner with "Save as new page", `ArchivedBanner`, the
  conflict toast, dialogs (Unsaved, etc.), toasts, and `RecorderBar` while a recording is live.

Stays:
- The editor (`Editor`) in **Live Preview**, at the page's own width setting (Readable by default,
  which is already a centred column). The builder's call: keep the page's width as is rather than
  a fixed Focus width.
- The **focus strip** (§4).

Text files (`TextView`) and images (`ImageView`) opened while focused **stay in Focus mode**
(settled in review, Claude's call): their own header chrome is hidden the same way.
- Text files: the strip shows ←, their word count and their save status (TextView already has both).
- Images: the strip shows ← only; there is nothing to count or save.
- No automatic exit for any file type, so navigation never runs the leave/restore path.
- The Live Preview override applies only where an `Editor` is shown; TextView keeps its own view.

## 4. The focus strip

A single row fixed at the bottom of the screen, centred under the text column:

`←  ·  1,234 words · 6 min  ·  Saved`

- **←** is the existing `BackArrow` (shows only when the trail has somewhere to go; its tooltip
  names the page). Mod+[ / Mod+] keep working as now.
- **Words · read time** is the existing `WordCount` component — same text, selection count and
  character tooltip.
- **Saved status**: today it is an inline `<span role="status" data-status>` duplicated in
  `PageHeader`, `TextView` and `SingleFileApp`. Extract it into one `SaveStatus` component used by
  all three and by the strip (Claude's call), keeping every state it shows today (`saved`,
  `saving`, `retrying`, `notSaved`, `unsaved`, and any `copying` variant), with its `aria-label`.
  Existing tests for those three views must keep passing unchanged.
- Faint by default; full opacity while the pointer is near the bottom edge or the keyboard is in
  the strip. Never hidden completely, so the save status is always readable. It must not cover the
  last line of text (the editor gets bottom padding equal to the strip's height).
- Reuse the components; do not fork them. If they need a variant class for the strip, add a prop.

## 5. Getting in and out

**Enter** from any of:
- **View → Focus mode** (custom title bar menu in `features/titlebar/menus.ts`, and the native
  macOS menu in `src-tauri/src/menu.rs`), placed next to Full screen, as a checked item. On macOS
  that is a new `CheckMenuItem` beside the `PredefinedMenuItem::fullscreen`, emitting a menu event
  and with its check synced the way the existing toggle items (sidebar, outline) are.
- A shortcut: **Alt+Mod+Z** (Z for Zen). VS Code's Mod+K Z cannot be used: Mod+K is already
  "insert link" in the editor. Add it to the shortcuts list (`features/dialogs/shortcuts.ts`).
- Available only in the main window with a vault open. Entering from the Global View or the Bin
  switches to the editor screen first; with no page open, it is disabled.

**On entering:**
1. Remember the current full-screen state; if not full screen, go full screen.
2. Show the editor in Live Preview (an override passed to `Editor`, not a settings write).
3. Hide everything in §3; move the keyboard into the editor, keeping selection and scroll.
4. Announce "Focus mode on. Press Escape twice to leave." through the existing live-region
   announcer (`features/editor/announce.ts`).

**If full screen fails** (an error from Tauri, or a Linux window manager that ignores it): Focus
mode still turns on inside the window, and leaving does not touch full screen (Claude's call).

**Leave** with any of: Escape pressed twice within ~500 ms (only when no popup, picker, find bar,
menu or dialog consumed the first Escape), the same shortcut, or the menu item.
- Detecting "consumed": a capture-phase listener plus checks of `defaultPrevented` and open
  overlays. Where an overlay (CodeMirror search panel, autocomplete, spell menu, pickers, search
  dialog) doesn't mark its Escape, modifying it to do so is allowed (Claude's call). Each overlay
  gets a test that one Escape closes it and does **not** leave Focus mode.

**On leaving:** show everything again; the editor returns to the saved `editorMode`; leave full
screen only if Focus mode was the one that entered it. Keep the page, selection and scroll. You
stay on the editor screen even if you entered from the Global View or the Bin (Claude's call;
no pre-focus screen is remembered).

If the user exits full screen on their own (F11, the native full-screen item, the macOS green
button) while focused, Focus mode ends too. Listen for the window's full-screen change, and ignore
changes until Focus mode's own enter/leave call has settled (macOS animates the transition and
fires resizes mid-way).

## 6. Moving around while focused

- Clicking a wiki/Markdown link, the quick switcher, search results, Mod+[ / Mod+]: open the target
  and stay in Focus mode. The new page is text only, in Live Preview.
- Search (Mod+Shift+F) and the quick switcher open their existing overlays above the focused page;
  they do not leave Focus mode.
- Commands that need hidden UI (Mod+\ sidebar, Mod+2 Global View, the toolbar/outline toggles)
  leave Focus mode first, then do their job. Builder's call; the alternative of ignoring them was
  judged more confusing.

## 7. Wording to update

- `site/index.html` and `site/js/i18n.js` (English and Spanish): `roadmap.focus.body` drops the
  paragraph-in-focus clause, e.g. "Hide everything but the text: no sidebar, no toolbar, just the
  words, the word count and whether it's saved." When this ships, the roadmap entry moves from
  Planned to done as the site does for other shipped items.
- `README.md` roadmap paragraph: unchanged until it ships, then remove "focus mode" from the list.
- App strings in `src/i18n/locales/en.json` and `es.json`: the menu item, the announcement, the
  shortcut label.

## 8. Constraints

- State lives in `uiStore` (session only, not `settingsStore`).
- Full screen goes through Tauri. The current `window_toggle_fullscreen` command returns nothing,
  so the builder adds a way to read the state (e.g. `window_is_fullscreen`, next to the existing
  `window_is_maximized`) or a set-with-value command.
- The editor stays mounted (as it already does across screens) so text and undo survive.
- Must work on macOS (WKWebView), Windows (WebView2) and Linux, and be covered by Playwright
  (chromium + webkit) like the other shell features, plus vitest unit tests for the store and the
  double-Escape rule.
- Accessibility: the strip's controls are reachable by Tab; the mode change is announced; reduced
  motion means no fade transitions.

## 9. Left to the builder

- Exact strip styling and fade timing, within the existing theme tokens.
- How the "hide" is done (a `data-focus` attribute on the shell with CSS, or conditional
  rendering), as long as the editor is not remounted.
- The precise double-Escape window and how "consumed by a popup" is detected.

## 10. Calls Claude made (for the maintainer to check)

- Shortcut **Alt+Mod+Z**, because Mod+K is taken by "insert link".
- Text files and images stay in Focus mode; images show only ← in the strip.
- `SaveStatus` gets extracted into one shared component.
- If full screen fails, Focus mode still works inside the window.
- Existing overlays may be changed so their Escape never counts toward leaving.
- Leaving always lands on the editor, never back on the Global View or the Bin.
- Mod+\, Mod+2 and the toolbar/outline toggles leave Focus mode and then do their job.
- Page width follows the page's own setting; no special Focus width.
- No Focus mode in the single-file window this round.
