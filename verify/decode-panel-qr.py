"""Rasterize an SVG from DropSluice (single <path> of M x y h w v h h -w z blocks) and decode it."""
import re
import sys

import zxingcpp
from PIL import Image, ImageDraw

S = 8  # pixels per module
QUIET = 4  # modules of quiet zone to add around the drawing


def rasterize(svg_path):
    svg = open(svg_path, encoding="utf-8").read()
    path = re.search(r' d="([^"]+)"', svg)
    if not path:
        raise SystemExit("no <path>")
    blocks = re.findall(
        r"M\s*(-?[\d.]+)\s+(-?[\d.]+)\s*h\s*([\d.]+)\s*v\s*([\d.]+)\s*h\s*-([\d.]+)\s*z",
        path.group(1),
    )
    if not blocks:
        raise SystemExit("no blocks parsed from path")
    unit = float(blocks[0][2])  # one module, in the SVG's own units
    xs = [float(b[0]) / unit for b in blocks]
    ys = [float(b[1]) / unit for b in blocks]
    min_x, min_y = min(xs), min(ys)
    side = int(round(max(xs) - min_x + 1))
    img = Image.new("L", ((side + 2 * QUIET) * S, (side + 2 * QUIET) * S), 255)
    draw = ImageDraw.Draw(img)
    for sx, sy, sw, sh, _neg in blocks:
        x = (float(sx) / unit - min_x + QUIET) * S
        y = (float(sy) / unit - min_y + QUIET) * S
        w = float(sw) / unit * S
        h = float(sh) / unit * S
        draw.rectangle([x, y, x + w - 1e-6, y + h - 1e-6], fill=0)
    sys.stderr.write(f"blocks={len(blocks)} modules={side} unit={unit}\n")
    return img


img = rasterize(sys.argv[1])
if len(sys.argv) > 2 and sys.argv[2] == "--png":
    img.save(svg_png := sys.argv[1].rsplit(".", 1)[0] + ".png")
    print("saved", svg_png)
results = zxingcpp.read_barcodes(img)
if not results:
    raise SystemExit("DECODE FAIL")
for r in results:
    print(r.format.name, r.text)
