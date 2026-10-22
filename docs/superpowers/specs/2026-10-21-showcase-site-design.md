# Showcase site — design

> **Status:** mocks approved by Jose (2026-10-21) · **Mock:** `docs/design/showcase/mock-v2.html` (open it in a browser; green and blue labels are review notes, not design)
> **Why:** Liber Linteum gets its own page, linked from Jose's personal site as a project, the way *None Shall Pass* is (`jorius.github.io/none-shall-pass/`). It shows the app, lets people download it and the sample vault, and asks for support. It must practise what the app preaches: private, fast, no third parties.

## 1. Goals, non-goals, anti-goals

- **Goals:** explain the app in one screen; show every major feature with moving pictures; make downloading obvious for the visitor's OS; highlight that Obsidian vaults open as they are and Notion workspaces import locally; offer the sample vault; credit the authors; take donations.
- **Non-goals:** a blog, docs site, changelog, or account of any kind.
- **Anti-goals:** any third-party request (analytics, web fonts, CDNs, embeds, trackers): the page must make **zero requests outside its own origin**, and say so. Heavy page weight from GIFs. Copyrighted film imagery.

## 2. Where it lives (Claude's call, not objected to)

- Source in this repo at **`site/`**: plain HTML, CSS and a little vanilla JavaScript. **No build step, no framework, no npm dependencies at runtime.**
- Published by GitHub Pages at **`https://jorius.github.io/liber-linteum/`** (a project page under Jose's user site), by a workflow that deploys `site/` with `actions/deploy-pages`. Pages from a private repo needs a paid plan, so it goes live when Jose makes the repo public. All URLs inside the site are relative, so the `/liber-linteum/` prefix works.
- Jose's personal site (`jorius.github.io` repo) gets a project card (`src/content/projects/liber-linteum.json`, `draft: true` until public) linking repo and live page. That repo has its own conventions (`CLAUDE.md` there: npm, capitalised-verb commit subjects, **no Co-Authored-By lines**).

## 3. Look (approved: "open desert, by day")

Exactly the approved mock's structure and palette. Sand gradient `#f3e6c9 → #e9d3a6 → #d9b67c`, dune bands `#cf9f5d` / `#b97f3f`, ink `#2a1c10`, secondary ink `#5b4128`, spice `#9c4a17`, paper `#fbf5e8`. Wide, light, upper-case display type with large letter-spacing; monospace small caps for kickers. Changes approved in round 2:

1. **The title draws itself** on load: "LIBER" then "LINTEUM" are traced as outlines, then filled with ink (about 3 s in total, eased, once). It must be smooth, and drawn from real glyph outlines (SVG paths generated from the site's own font file, committed), not from a system font. With `prefers-reduced-motion`, the title appears filled at once.
2. **The sun sits at the far left, behind the title.** The product window on the right is large (it's the hero's main visual).
3. **Download buttons carry a monochrome OS glyph:** a primary button for the visitor's OS (Linux, Windows or macOS, detected in the page), plus outlined buttons for the other two. **No arrows anywhere** (no →, ↗, ⬇ characters): links are underlined text, icons are glyphs.
4. **Monochrome line icons** (stroke = `currentColor`) everywhere, no emoji.
5. **"Bring your notes" section**, second after "What it is": Obsidian (opens as it is, nothing converted, both apps share the folder) and Notion (export as Markdown & CSV, imported on your machine, nothing uploaded; databases become tables plus a note per row), each with its own looping video, and a dark strip: "Your notes move from a service you rent to a folder you own", pointing to the sample Notion export.
6. **Feature tour uses looping videos, not GIFs:** silent MP4 (H.264) with a WebM (VP9/AV1) source, 1440p or 2× of the displayed size, 6–10 s, `autoplay muted loop playsinline`, a poster image, a visible pause/play button, and only the visible video playing (IntersectionObserver). With reduced motion, show the poster with a play button instead.
7. **Credits:** "An idea by José Meza, built by Jose Ríos." in the Support section and the footer.

## 4. Sections, top to bottom

Top bar (name, section links, EN/ES switch, GitHub) · Hero · What it is (3 points) · Bring your notes · Feature tour (Global View, Editor, Encryption *Beta*, Search; then 8 small cards: quick notes, voice clips, colours and themes, Trash & Archive, spell check, single files, English/Español, the same menus on every OS) · Privacy (dark band, "What it will never do": no cloud, no accounts, no telemetry; how it's enforced) · Download (three platform cards: files, SHA-256, VirusTotal link; an honest "not code-signed yet" note with how to get past each OS's warning) · Sample vault (*The Moons of Kessari*: what's in it, download) · Roadmap (added 2026-10-21, approved by Jose: kicker "What's next", `#roadmap`; three cards marked *Planned*, no dates: version history, slash menu, focus mode; then an invitation to suggest ideas in GitHub issues) · Support ("Free, and staying that way", donate buttons, credits) · Footer (licence, source, React Flow credit, credits, link back to `jorius.github.io`).

Copy is the mock's, polished; Spanish translation of all of it (natural Latin-American Spanish).

## 5. Behaviour

- **Language:** English and Spanish, chosen from `navigator.languages` on first visit, switchable in the top bar, remembered in `localStorage` (a convenience only; the page works without it). Text lives in one dictionary file; the HTML carries keys.
- **Downloads and checksums** come from a same-origin `release.json` (version, per-file name, size, SHA-256, VirusTotal URL) that the release workflow writes next to the page. Buttons link to GitHub release assets with stable names (`releases/latest/download/…`). Without `release.json` (before the first release), the download section says releases are coming and links to the repo.
- **Donate:** GitHub Sponsors and Ko-fi buttons, configured in one place; until Jose has the accounts, the URLs are placeholders flagged in the config and the buttons are hidden behind that flag (see `docs/research/2026-10-21-donation-platforms.md`).
- **No JavaScript needed to read the page**; JS only adds the language switch, OS detection, release data, the title animation and video control.
- **Security headers via `<meta http-equiv="Content-Security-Policy">`:** `default-src 'self'`, no inline script, no third-party origins.

## 6. Media

- Real screenshots and videos of the app showing the sample vault, captured at high resolution in light mode (dark-mode variants are a later nicety). Until they exist, the site ships tasteful placeholders of the right aspect ratio, and the capture work fills `site/media/` without HTML changes (stable file names listed in `site/media/README.md`).
- Fonts: self-hosted WOFF2 subsets from OFL families already used by the app (`@fontsource/*` in `apps/desktop/node_modules`), with their licences in `site/fonts/`.

## 7. Quality bar

- Lighthouse-level hygiene by hand: semantic landmarks, one `h1`, alt text, focus styles, AA contrast, works at 360 px wide (no horizontal scroll), keyboard reachable.
- A Playwright test that loads the page, asserts **zero requests to any other origin**, checks both languages render with no missing keys, the OS button logic, reduced-motion behaviour, and axe has no violations.
- Total transfer for the first screen under ~300 KB excluding videos; videos lazy-load.

## 8. Left to the builder

Exact copy polish, the SVG icon set, the font choice among the bundled OFL families for display and body (it should read like the mock: a wide, light geometric display face), the video player's exact controls, and the deploy workflow details.
