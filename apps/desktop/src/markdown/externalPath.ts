// Link targets that may name a file outside the vault (M4b part 3 §9). The
// app only asks; Rust (`links_external`) decides what each one is and
// whether it may be shown, against the same rules as the index.

/** A drive (`D:\…`, `D:/…`), a UNC share (`\\server\…`) or a `file:` URL. */
export function isFileTarget(target: string): boolean {
  const t = target.trim();
  return /^file:/i.test(t) || /^[a-z]:[\\/]/i.test(t) || t.startsWith('\\\\');
}

/** A wiki target (`[[…]]`, `![[…]]`) that may be outside the vault: a file
 *  target, an absolute `/…` path (the vault root first) or one relative to the
 *  page (`./`, `../`). Bare names never are. */
export function looksExternal(target: string): boolean {
  const t = target.trim();
  return isFileTarget(t) || t.startsWith('/') || t.startsWith('./') || t.startsWith('../');
}

/** The computer a network path is on (`\\server\…` → `server`, `/net/host/…`
 *  → `host`), as Rust's `network_server` reads it; `''` when it names none. */
export function networkServer(path: string): string {
  const unc = /^\\\\(?:\?\\UNC\\)?([^\\/]+)/i.exec(path);
  if (unc) return unc[1];
  const net = /^\/net\/([^/]+)/i.exec(path);
  return net ? net[1] : '';
}

/** Where the vault file `path` is on disk, with the OS's separators. */
export function diskPathOf(root: string, path: string, windows: boolean): string {
  const sep = windows ? '\\' : '/';
  const base = root.endsWith(sep) ? root.slice(0, -1) : root;
  return `${base}${sep}${path.split('/').join(sep)}`;
}

/** Whether this is Windows (WebView2), for paths shown to the user. */
export const onWindows = (): boolean => /Windows/i.test(navigator.userAgent);
