# Showcase media

The page refers to these files by name. Replacing a file here updates the site with no HTML
change. The `*.poster.webp` files in the repo now are placeholders, drawn by
`site/tools/make-posters.mjs`.

## Slots

Every clip can be opened large: a click on it (or its Enlarge button) shows it in a lightbox
with the player's controls, so a longer clip is fine; the visitor can scrub through it.

| Slug           | Where on the page                         | What the clip shows                                                                                                                   | Length  |
| -------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `hero`         | Hero, the large app window                | The Global View: a folder expanded in place, a drill-down, a page's atoms, then a quick edit in Live Preview                          | ~20 s   |
| `obsidian`     | Bring your notes, Obsidian card           | Choosing Open an Obsidian vault, then the vault as Obsidian left it: callouts, embeds, wikilinks and its attachment setting            | 8–15 s  |
| `notion`       | Bring your notes, Notion card             | Importing the sample Notion export: pages, nested pages and a database as a table                                                     | 8–15 s  |
| `global-view`  | Feature tour 1, Global View               | Cards expanding in place to show a folder's pages; a drill-down; a relationship dragged from card to card                             | 8–15 s  |
| `atoms`        | Feature tour 2, Atoms                     | Right-click a card, See atoms: the page's sections and blocks as a tree of small cards; click one to jump to it in the page           | 8–15 s  |
| `editor`       | Feature tour 3, Editor                    | A page written in Live Preview, with a callout; switching to source and back                                                          | 8–15 s  |
| `maths`        | Feature tour 4, Maths & diagrams          | Split view: a LaTeX formula and a Mermaid diagram as source on the left, rendered on the right, updating as you type                   | 8–15 s  |
| `drag-drop`    | Feature tour 5, Drag and drop             | A block dragged by its handle to a new place in a page, then a page dragged into a folder in the sidebar                              | 8–15 s  |
| `voice`        | Feature tour 6, Voice clips               | A voice clip recorded into a page, then played inline                                                                                 | 8–15 s  |
| `search`       | Feature tour 7, Search                    | Searching the vault, narrowing by a tag, then opening a result at the match                                                           | 8–15 s  |
| `encryption`   | Feature tour 8, Encryption                | Encrypting a vault from start to end: Encrypt, an optional readable copy, passphrase, recovery key, confirming two groups, lock, unlock | ~35 s   |
| `sample-vault` | Sample vault                              | The Moons of Kessari in the Global View: factions, places and people as cards                                                          | 8–15 s  |

## Files per slot

For each slug:

- `<slug>.poster.webp`: the still. Shown before the video plays, with reduced motion, without
  JavaScript, and until the video exists. **Required.**
- `<slug>.webm`: VP9 or AV1, silent. Listed first, so browsers that can play it use it.
- `<slug>.mp4`: H.264, silent, `+faststart`. The fallback (Safari).

## Format

- Light mode, the sample vault, the app window only (no desktop around it).
- 16:10, captured at **2304×1440** (1440p) or at least 2× the largest displayed size; posters
  the same size as the video's first frame.
- The lengths in the table above; a seamless loop if possible, no audio track at all.
- The hero and the feature tour show the whole 16:10 frame (the hero clip is the app window,
  its own title bar included; the page draws no menu bar over it). Only the Bring your notes
  cards crop, to a wide strip (about 16:7.5) from the top, so keep the action in the upper part
  of the frame for `obsidian` and `notion`. The lightbox always shows the whole frame.
- Budget: poster under 150 KB, video about 1.5 MB per 10 s (the hero poster counts toward the
  ~300 KB first screen).

Example encodes from a lossless capture `in.mov`:

```sh
ffmpeg -i in.mov -an -vf scale=2304:-2 -c:v libvpx-vp9 -b:v 0 -crf 36 -row-mt 1 hero.webm
ffmpeg -i in.mov -an -vf scale=2304:-2 -c:v libx264 -crf 24 -preset slow -pix_fmt yuv420p -movflags +faststart hero.mp4
ffmpeg -i in.mov -frames:v 1 -vf scale=2304:-2 -c:v libwebp -quality 80 hero.poster.webp
```

## Turning the videos on

The page only asks for a video once its slug is listed in `videos` in `site/js/config.js`, so it
never requests a file that isn't there yet. After adding `<slug>.webm` and `<slug>.mp4`, add the
slug to that list.
