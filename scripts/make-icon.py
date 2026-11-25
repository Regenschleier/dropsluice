"""生成 DropSluice 的 Windows 图标（.ico，多尺寸）。

为什么手画：仓库里只有插件用的 SVG，Windows 的 exe 图标要 ICO（内含多个位图尺寸），
用 Pillow 直接画比拉 cairosvg 之类的依赖省事。

用法：python scripts/make-icon.py
输出：build/assets/dropsluice.ico
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build" / "assets" / "dropsluice.ico"

BG = (47, 111, 237, 255)   # #2F6FED
FG = (255, 255, 255, 255)

SIZES = [16, 24, 32, 48, 64, 128, 256]


def draw_icon(size: int) -> Image.Image:
    # 4 倍超采样再缩回去，得到干净的边角
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = s * 0.22
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG)

    # 手机：圆角矩形描边
    pw, ph = s * 0.40, s * 0.62
    px, py = (s - pw) / 2, (s - ph) / 2
    stroke = max(1, int(s * 0.055))
    d.rounded_rectangle(
        [px, py, px + pw, py + ph],
        radius=s * 0.075,
        outline=FG,
        width=stroke,
    )

    # 向下箭头：竖杆 + 三角
    cx = s / 2
    top = py + ph * 0.20
    stem_w = s * 0.075
    stem_h = ph * 0.26
    d.rounded_rectangle(
        [cx - stem_w / 2, top, cx + stem_w / 2, top + stem_h],
        radius=stem_w / 2,
        fill=FG,
    )
    head_w = s * 0.30
    head_h = ph * 0.20
    ay = top + stem_h
    d.polygon(
        [(cx - head_w / 2, ay), (cx + head_w / 2, ay), (cx, ay + head_h)],
        fill=FG,
    )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    images = [draw_icon(s) for s in SIZES]
    images[-1].save(
        OUT,
        format="ICO",
        sizes=[(s, s) for s in SIZES],
        append_images=images[:-1],
    )
    print(f"已生成 {OUT}（{OUT.stat().st_size} 字节，尺寸 {SIZES}）")


if __name__ == "__main__":
    main()
