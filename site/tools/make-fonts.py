"""Builds the site's self-hosted WOFF2 subsets from the @fontsource packages.

Usage (Python with `fonttools` and `brotli`, e.g. a throwaway venv):
    python -m venv /tmp/fontvenv && /tmp/fontvenv/bin/pip install fonttools brotli
    /tmp/fontvenv/bin/python site/tools/make-fonts.py

Run `pnpm install` first: the sources are the fontsource packages the desktop
app already depends on (apps/desktop/node_modules/@fontsource). The output is
committed, so the site itself has no build step.
"""

from pathlib import Path
import shutil

from fontTools import subset

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'apps/desktop/node_modules/@fontsource'
OUT = ROOT / 'site/fonts'

# Basic Latin, Latin-1 (all Spanish letters, ¿ ¡ · ©) and typographic punctuation.
# No arrows on purpose: the design uses none.
UNICODES = (
    'U+0020-007E,U+00A0-00FF,U+2009,U+2013-2014,U+2018-2019,U+201C-201D,'
    'U+2022,U+2026,U+202F,U+2212'
)

FONTS = [
    # (fontsource package, weight, layout features kept)
    ('plus-jakarta-sans', 300, 'kern,liga'),
    ('plus-jakarta-sans', 400, 'kern,liga'),
    ('plus-jakarta-sans', 600, 'kern,liga'),
    # Mono: no code ligatures (calt) — they are most of the file and the site never needs them.
    ('jetbrains-mono', 500, ''),
    ('jetbrains-mono', 600, ''),
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for family, weight, features in FONTS:
        src = SRC / family / 'files' / f'{family}-latin-{weight}-normal.woff2'
        dst = OUT / f'{family}-{weight}.woff2'
        args = [
            str(src),
            f'--unicodes={UNICODES}',
            f'--layout-features={features}',
            '--flavor=woff2',
            '--no-hinting',
            '--desubroutinize',
            f'--output-file={dst}',
        ]
        subset.main(args)
        print(f'{dst.relative_to(ROOT)}: {dst.stat().st_size} bytes')
    for family in sorted({f for f, _, _ in FONTS}):
        shutil.copyfile(SRC / family / 'LICENSE', OUT / f'{family}-OFL.txt')


if __name__ == '__main__':
    main()
