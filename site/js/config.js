// Everything the site owner may want to change without touching the HTML.

export const config = {
  repo: 'https://github.com/jorius/liber-linteum',

  // Installers and the sample vault are GitHub release assets with stable names; the release
  // workflow writes release.json (see release.example.json) next to index.html.
  releaseJson: 'release.json',
  assetBase: 'https://github.com/jorius/liber-linteum/releases/latest/download/',

  // Donations (docs/research/2026-10-21-donation-platforms.md). The buttons stay hidden until
  // `enabled` is true; the URLs below are placeholders until the accounts exist.
  donate: {
    enabled: false,
    github: 'https://github.com/sponsors/jorius',
    kofi: 'https://ko-fi.com/REPLACE-ME',
  },

  // Looping clips present in media/ (see media/README.md). A slot not listed here shows its
  // poster only, so the page never asks for a video that isn't there yet. Example:
  //   videos: ['hero', 'obsidian', 'notion', 'global-view', 'editor', 'encryption', 'search', 'sample-vault'],
  videos: [],
};
