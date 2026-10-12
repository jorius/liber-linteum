export type ThemePreference = 'system' | 'light' | 'dark';

// 'system' leaves the choice to the prefers-color-scheme media query in
// tokens.css, so OS theme changes apply live without JS listeners.
export function applyTheme(pref: ThemePreference, root: HTMLElement = document.documentElement) {
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = pref;
}
