# Showcase media

The page refers to these files by name. Replacing a file here updates the site with no HTML
change. The `*.poster.webp` files in the repo now are placeholders, drawn by
`site/tools/make-posters.mjs`.

## Slots

| Slug           | Where on the page                    | What the clip shows                                                   | Length |
| -------------- | ------------------------------------ | --------------------------------------------------------------------- | ------ |
| `hero`         | Hero, the large app window           | The Global View on the sample vault: pan, open a card, expand in place | 8–10 s |
| `obsidian`     | Bring your notes, Obsidian card      | Open folder as vault on an Obsidian vault; the tree and notes appear   | 6–8 s  |
| `notion`       | Bring your notes, Notion card        | Import the sample Notion export zip; a database becomes a table        | 6–8 s  |
| `global-view`  | Feature tour, Global View            | Drill into a folder, expand in place, drag a relationship              | 8 s    |
| `editor`       | Feature tour, Editor                 | Live Preview typing, a callout, dragging a block                       | 8 s    |
| `encryption`   | Feature tour, Encryption             | Lock, then unlock with the passphrase                                 | 6 s    |
| `search`       | Feature tour, Search                 | Type a query, add folder and tag filters                               | 6 s    |
| `sample-vault` | Sample vault                         | The Moons of Kessari in the Global View                                | 6–8 s  |

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
- 6–10 s, seamless loop if possible, no audio track at all.
- Crops: the hero window is a little shorter than 16:10 and the Bring your notes cards are a
  wide strip (about 16:7.5); both crop from the top, so keep the action in the upper part of the
  frame for those slots.
- Budget: poster under 150 KB, video under 1.5 MB each (the hero poster counts toward the
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
