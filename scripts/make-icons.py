"""Builds every scoop.md icon from the master artwork in brand/icon-source.png.

Usage: python3 scripts/make-icons.py   (needs Pillow)

Writes the extension toolbar icons (rounded corners, 16-128 px) and the
website's favicon, apple-touch icon and logo image.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "brand" / "icon-source.png"
EXT = ROOT / "extension" / "icons"
SITE = ROOT / "site" / "public"
RADIUS = 0.22  # corner radius as a share of the side, like a macOS app icon


def rounded(img, size):
    big = size * 4  # draw the mask large so the downsampled corners are smooth
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * RADIUS), fill=255)
    out = img.resize((size, size), Image.LANCZOS).convert("RGBA")
    out.putalpha(mask.resize((size, size), Image.LANCZOS))
    return out


def main():
    src = Image.open(SOURCE).convert("RGB")
    EXT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        rounded(src, size).save(EXT / f"icon{size}.png", optimize=True)
    if SITE.exists():
        rounded(src, 32).save(SITE / "favicon.png", optimize=True)
        rounded(src, 192).save(SITE / "icon-192.png", optimize=True)
        rounded(src, 512).save(SITE / "icon-512.png", optimize=True)
        # iOS rounds the corners itself, so the touch icon stays square.
        src.resize((180, 180), Image.LANCZOS).save(SITE / "apple-touch-icon.png", optimize=True)
    print("icons written")


if __name__ == "__main__":
    main()
