"""Contact sheet for reviewing frames: `python sheet.py out.png name1 name2 ...`
(from <work>/shots/<name>-s.png, two per row)."""
import sys

import common
from PIL import Image

d = common.SHOTS
out, names = sys.argv[1], sys.argv[2:]
ims = [Image.open(f"{d}/{n}-s.png") for n in names]
rows = (len(ims) + 1) // 2
sheet = Image.new("RGB", (1152 * 2 + 8, 720 * rows + 8 * (rows - 1)), "white")
for i, im in enumerate(ims):
    sheet.paste(im, ((i % 2) * 1160, (i // 2) * 728))
sheet.save(f"{d}/{out}")
