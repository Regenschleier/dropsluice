"""
把 /qr.svg 真正栅格化再用扫码库读回来 —— 验证 toSvg 画出来的图形能被真实扫码器识别。

用法：先让服务跑起来，然后
    python verify/qr-svg-decode.py http://127.0.0.1:18888
"""
import io
import json
import sys
import urllib.request

import zxingcpp
from PIL import Image

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18888"
SCALE = 8


def fetch(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return r.read().decode("utf-8")


def svg_to_image(svg: str) -> Image.Image:
    """只认我们自己的 toSvg 输出：白色底 rect + 一条由小方块拼成的黑色 path。

    path 里每个模块长这样：M{x} {y}h{w}v{h}h-{w}z
    """
    import re

    vb = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg)
    if not vb:
        raise SystemExit("SVG 里没有 viewBox")
    total = int(float(vb.group(1)))
    if total <= 0:
        raise SystemExit("viewBox 尺寸不对")

    boxes = []
    for d in re.findall(r'<path[^>]*\bd="([^"]+)"', svg):
        for m in re.finditer(r'M([\d.]+) ([\d.]+)h([\d.]+)v([\d.]+)h-([\d.]+)z', d):
            x, y, w, h = (float(m.group(i)) for i in range(1, 5))
            boxes.append((x, y, w, h))
    if not boxes:
        # 兼容直接画成 rect 的实现
        for tag in re.findall(r"<rect\b[^>]*>", svg):
            def attr(name):
                m = re.search(name + r'="([^"]+)"', tag)
                return float(m.group(1)) if m else None

            fill = (re.search(r'fill="([^"]+)"', tag) or [None, "black"])[1]
            if fill in ("white", "#fff", "#ffffff", "none"):
                continue
            w, h = attr("width"), attr("height")
            if w is None or h is None:
                continue
            boxes.append((attr("x") or 0, attr("y") or 0, w, h))
    if not boxes:
        raise SystemExit("SVG 里找不到图形")

    img = Image.new("L", (total, total), 255)
    px = img.load()
    drawn = 0
    for x, y, w, h in boxes:
        for yy in range(int(round(y)), int(round(y + h))):
            for xx in range(int(round(x)), int(round(x + w))):
                if 0 <= xx < total and 0 <= yy < total:
                    px[xx, yy] = 0
                    drawn += 1
    print(f"画出 {len(boxes)} 块、{drawn} 个像素")
    return img.resize((total * SCALE, total * SCALE), Image.NEAREST)


def main():
    # 配对窗口平时是关着的（配完就关），先开一个
    req = urllib.request.Request(BASE + "/api/pairing/open", method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        opened = json.loads(r.read().decode("utf-8"))
    print(f"配对窗口: code={opened.get('code')} url={opened.get('url')}")

    svg = fetch(BASE + "/qr.svg")
    print(f"qr.svg: {len(svg)} 字节")
    img = svg_to_image(svg)
    print(f"栅格化: {img.size[0]}x{img.size[1]}")

    results = zxingcpp.read_barcodes(img)
    if not results:
        raise SystemExit("❌ 扫码器读不出 /qr.svg")
    for r in results:
        print(f"✅ 解出文本: {r.text}")
        print(f"   格式: {r.format}")

    info = urllib.request.urlopen(BASE + "/api/pairing", timeout=10)
    d = json.loads(info.read().decode("utf-8"))
    expected = d["url"]
    got = results[0].text
    if got != expected:
        raise SystemExit(f"❌ 二维码内容与配对 URL 不一致\n  期望 {expected}\n  实际 {got}")
    print("✅ 内容与 /api/pairing 的 url 完全一致")


if __name__ == "__main__":
    main()
