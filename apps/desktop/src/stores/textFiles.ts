// Plain-text and code files the app opens in its text view (M4b part 2 §6).
// The same names as `nimw_session::is_text_path`; the content (UTF-8, no NUL
// bytes, at most 2 MB) is checked by `text_read`, which answers `notAText`.

const EXTENSIONS = new Set(
  (
    'txt text log csv tsv json jsonc yaml yml toml ini cfg conf xml html htm css scss less js ' +
    'mjs cjs ts tsx jsx py rb rs go java kt c h cpp hpp cs swift sh bash zsh fish ps1 sql lua ' +
    'php r dart vue svelte'
  ).split(' '),
);
const NAMES = new Set(['Dockerfile', 'Makefile', '.gitignore', '.editorconfig']);

export function isTextPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (NAMES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  return dot > 0 && EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
