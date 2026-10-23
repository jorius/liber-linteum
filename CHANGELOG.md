# Changelog

What changed in each release of Liber Linteum. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-10-23

### Added

- **Update existing attachment links.** Settings → This Vault now says how many
  attachment links use a format other than "Link format for new attachments" and
  offers to update them. They are rewritten exactly as new ones would be
  (`![[x.png]]`, `![[Assets/x.png]]`, `![[../Assets/x.png]]` or
  `![](file:///…/x.png)`). Sizes, aliases and `#…` are kept, archived pages are
  left alone, and a page is only rewritten when every link still finds the same
  file.

### Fixed

- **Pasting an image on Linux.** Images copied to the clipboard (a screenshot,
  "Copy image" in a browser) can be pasted into a page on Ubuntu and other Linux
  systems. WebKitGTK gave the page an empty paste, so nothing happened.
- **Live Preview shows images inside a paragraph.** An image on the line after a
  list item, or after text, now renders instead of showing `![[…]]`.
- **Live Preview shows colour labels.** `<span data-color="…">` and
  `<span data-bg="…">` render in their colour; the tags show only on the
  cursor's line.
- **Menus highlight the item the arrow keys reach.** The spelling menu, the
  vault menu and the other menus moved with the arrow keys but showed no
  highlight on Linux. The pointer now moves the same highlight.

## [0.1.0] - 2026-10-22

The first release: private notes that stay on your machine, as plain Markdown
files in a folder you own, with a canvas that shows how they connect and no
network requests at all.

### Added

- Global View: projects, folders and pages as cards, linked by what they
  reference.
- Live Preview editor with callouts, toggles, columns, code highlighting, KaTeX
  maths, Mermaid diagrams, tables, covers and icons.
- Atoms: every page broken into its parts.
- Obsidian vaults open as they are; Notion exports can be imported.
- Search across the vault, filtered by tag, folder or link.
- Voice clips recorded into a note.
- Encrypted vaults (beta), with a passphrase and a recovery key.
- Quick notes, find and replace, go to line, palettes in light and dark, Trash
  and Archive, offline spell check in English and Spanish, a home page per
  vault.

[Unreleased]: https://github.com/jorius/liber-linteum/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/jorius/liber-linteum/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jorius/liber-linteum/releases/tag/v0.1.0
