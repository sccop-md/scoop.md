"""Draws the scoop.md toolbar icons: an ice-cream scoop on a cone.

Usage: python3 scripts/make-icons.py   (needs Pillow; writes extension/icons/)
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
BG = (24, 24, 27, 255)        # zinc-900
SCOOP = (244, 114, 182, 255)  # pink-400
SHINE = (251, 207, 232, 255)  # pink-200
CONE = (245, 158, 11, 255)    # amber-500
WAFFLE = (180, 83, 9, 255)    # amber-700
S = 512                       # drawn large, then downsampled


def draw():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=112, fill=BG)
    # Cone: a downward triangle under the scoop.
    top, tip = 268, 462
    cone = [(150, top), (362, top), (256, tip)]
    d.polygon(cone, fill=CONE)
    for i in range(1, 4):  # waffle lines, only visible at larger sizes
        y = top + i * (tip - top) / 4
        half = (362 - 150) / 2 * (1 - i / 4)
        d.line([(256 - half, y), (256 + half, y)], fill=WAFFLE, width=10)
    # Scoop: a ball with a scalloped rim over the cone.
    d.ellipse([122, 70, 390, 318], fill=SCOOP)
    for cx in (152, 204, 256, 308, 360):
        d.ellipse([cx - 34, 262, cx + 34, 318], fill=SCOOP)
    d.ellipse([176, 116, 232, 162], fill=SHINE)
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    big = draw()
    for size in (16, 32, 48, 128):
        big.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png", optimize=True)
        print(f"wrote {OUT / f'icon{size}.png'}")


if __name__ == "__main__":
    main()
