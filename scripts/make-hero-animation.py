"""Builds the home page animation (site/public/hero.json, a Lottie file).

A cursor clicks the scoop.md icon in a browser toolbar, the popup opens, and
the cursor clicks "Copy for your agent", which turns to "Copied". The popup is
the real extension UI (brand/hero/*.png, captured from Chrome); everything else
is drawn as vector shapes.

Usage: python3 scripts/make-hero-animation.py   (needs Pillow)
"""
import base64
import io
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
HERO = ROOT / "brand" / "hero"
OUT = ROOT / "site" / "public" / "hero.json"

FPS, END = 30, 180          # 6 second loop
W, H = 960, 600

# Scene geometry
WIN = (30, 24, 900, 552)    # browser window x, y, w, h
BAR_H = 54
ICON = (WIN[0] + WIN[2] - 42, WIN[1] + BAR_H / 2)      # extension icon centre
POP_W = 300                                             # popup width on screen
POP_X, POP_Y = WIN[0] + WIN[2] - 18 - POP_W, WIN[1] + BAR_H + 8
POP_SRC_W, POP_SRC_H = 600, 748                         # artwork pixels
CSS = POP_W / 360                                       # popup CSS px -> scene px
COPY_BTN = (POP_X + 180 * CSS, POP_Y + 307 * CSS)       # centre of the Copy button
START = (300, 470)

ORANGE = "#ff5e1f"


def rgb(hex_, a=1):
    h = hex_.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)] + [a]


def static(v):
    return {"a": 0, "k": v}


def anim(frames, ease=True):
    """frames: [(t, value)]. Values may be numbers or lists."""
    ks = []
    for i, (t, v) in enumerate(frames):
        v = v if isinstance(v, list) else [v]
        k = {"t": t, "s": v}
        if i < len(frames) - 1:
            k["i"] = {"x": [0.3], "y": [1]} if ease else {"x": [1], "y": [1]}
            k["o"] = {"x": [0.55], "y": [0]} if ease else {"x": [0], "y": [0]}
            if len(v) == 3:
                k["to"], k["ti"] = [0, 0, 0], [0, 0, 0]
        ks.append(k)
    return {"a": 1, "k": ks}


def transform(p=(0, 0), a=(0, 0), s=100, o=100):
    return {
        "o": o if isinstance(o, dict) else static(o),
        "r": static(0),
        "p": p if isinstance(p, dict) else static([p[0], p[1], 0]),
        "a": static([a[0], a[1], 0]),
        "s": s if isinstance(s, dict) else static([s, s, 100]),
    }


def group(items, name="g"):
    return {"ty": "gr", "nm": name, "it": items + [{
        "ty": "tr", "p": static([0, 0]), "a": static([0, 0]), "s": static([100, 100]), "r": static(0), "o": static(100),
    }]}


def rect(x, y, w, h, r=0):
    return {"ty": "rc", "p": static([x + w / 2, y + h / 2]), "s": static([w, h]), "r": static(r)}


def ellipse(cx, cy, d):
    return {"ty": "el", "p": static([cx, cy]), "s": static([d, d])}


def fill(c, a=1):
    return {"ty": "fl", "c": static(rgb(c)), "o": static(a * 100), "r": 1}


def stroke(c, w, a=1):
    return {"ty": "st", "c": static(rgb(c)), "o": static(a * 100), "w": static(w), "lc": 2, "lj": 2}


def path(points, closed=True):
    z = [[0, 0]] * len(points)
    return {"ty": "sh", "ks": static({"i": z, "o": z, "v": points, "c": closed})}


def rounded_rect_path(w, h, r):
    k = 0.5523 * r
    v = [[r, 0], [w - r, 0], [w, r], [w, h - r], [w - r, h], [r, h], [0, h - r], [0, r]]
    # Each corner arc: the point before it carries the out tangent, the point after it the in tangent.
    i = [[-k, 0], [0, 0], [0, -k], [0, 0], [k, 0], [0, 0], [0, k], [0, 0]]
    o = [[0, 0], [k, 0], [0, 0], [0, k], [0, 0], [-k, 0], [0, 0], [0, -k]]
    return {"i": i, "o": o, "v": v, "c": True}


layers = []


def layer(name, shapes=None, ks=None, ty=4, **extra):
    lay = {"ddd": 0, "ind": len(layers) + 1, "ty": ty, "nm": name, "sr": 1, "ks": ks or transform(),
           "ao": 0, "ip": 0, "op": END, "st": 0, "bm": 0}
    if shapes is not None:
        lay["shapes"] = shapes
    lay.update(extra)
    layers.append(lay)
    return lay


def jpeg_asset(asset_id, path_, size):
    im = Image.open(path_).convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=86, optimize=True, progressive=True)
    return {"id": asset_id, "w": size[0], "h": size[1], "u": "", "e": 1,
            "p": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()}


def png_asset(asset_id, path_, px):
    im = Image.open(path_).convert("RGBA").resize((px, px), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return {"id": asset_id, "w": px, "h": px, "u": "", "e": 1,
            "p": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()}


def build():
    x, y, w, h = WIN
    assets = [
        jpeg_asset("ready", HERO / "popup-ready.png", (POP_SRC_W, POP_SRC_H)),
        jpeg_asset("copied", HERO / "popup-copied.png", (POP_SRC_W, POP_SRC_H)),
        png_asset("icon", ROOT / "extension" / "icons" / "icon128.png", 64),
    ]

    # Timeline (frames)
    t_click1, t_open, t_click2, t_swap, t_leave, t_close = 30, 38, 92, 95, 138, 150
    pop_scale = POP_W / POP_SRC_W * 100
    pop_in = anim([(t_open, [pop_scale * 0.94] * 2 + [100]), (t_open + 10, [pop_scale] * 2 + [100]),
                   (t_close, [pop_scale] * 2 + [100]), (t_close + 10, [pop_scale * 0.96] * 2 + [100])])
    pop_alpha = anim([(t_open, 0), (t_open + 8, 100), (t_close, 100), (t_close + 10, 0)])
    pop_tf = lambda o: transform(p=(POP_X + POP_W, POP_Y), a=(POP_SRC_W, 0), s=pop_in, o=o)
    pop_mask = [{"inv": False, "mode": "a", "pt": static(rounded_rect_path(POP_SRC_W, POP_SRC_H, 20)),
                 "o": static(100), "x": static(0), "nm": "corners"}]

    # Top of the stack first.
    cx, cy = START
    cursor_pos = anim([
        (0, [cx, cy, 0]), (t_click1 - 4, [ICON[0], ICON[1], 0]),
        (t_open + 14, [ICON[0], ICON[1], 0]), (t_click2 - 4, [COPY_BTN[0], COPY_BTN[1], 0]),
        (t_leave, [COPY_BTN[0], COPY_BTN[1], 0]), (t_leave + 22, [COPY_BTN[0] + 70, COPY_BTN[1] + 150, 0]),
        (END - 12, [COPY_BTN[0] + 70, COPY_BTN[1] + 150, 0]), (END, [cx, cy, 0]),
    ])
    up, down = [100, 100, 100], [82, 82, 100]
    cursor_scale = anim([(t_click1 - 4, up), (t_click1, down), (t_click1 + 5, up),
                         (t_click2 - 4, up), (t_click2, down), (t_click2 + 5, up)])
    arrow = [[0, 0], [0, 23], [5.6, 17.6], [9.4, 26.2], [13.2, 24.6], [9.5, 16.2], [17, 16.2]]
    layer("cursor", [group([path(arrow), stroke("#1d1712", 1.6), fill("#ffffff")], "arrow")],
          transform(p=cursor_pos, s=cursor_scale))

    def ripple(name, cxy, t):
        layer(name, [group([ellipse(0, 0, 22), stroke(ORANGE, 2.5)], "ring")],
              transform(p=(cxy[0], cxy[1]), s=anim([(t, [20, 20, 100]), (t + 14, [260, 260, 100])]),
                        o=anim([(t, 0), (t + 1, 90), (t + 14, 0)])))

    ripple("ripple-icon", ICON, t_click1)
    ripple("ripple-copy", COPY_BTN, t_click2)

    layer("popup-copied", ks=pop_tf(anim([(t_swap - 1, 0), (t_swap, 100), (t_close, 100), (t_close + 10, 0)], ease=False)),
          ty=2, refId="copied", hasMask=True, masksProperties=pop_mask)
    layer("popup-ready", ks=pop_tf(pop_alpha), ty=2, refId="ready", hasMask=True, masksProperties=pop_mask)
    layer("popup-shadow", [group([rect(POP_X - 2, POP_Y + 6, POP_W + 4, POP_SRC_H * POP_W / POP_SRC_W + 4, 14), fill("#1d1712")], "shadow")],
          transform(o=anim([(t_open, 0), (t_open + 8, 14), (t_close, 14), (t_close + 10, 0)])))

    # Extension icon, highlighted while its popup is open.
    layer("icon-ring", [group([rect(ICON[0] - 17, ICON[1] - 17, 34, 34, 8), fill(ORANGE, 0.14)], "ring")],
          transform(o=anim([(t_click1, 0), (t_click1 + 4, 100), (t_close, 100), (t_close + 8, 0)])))
    layer("icon", ks=transform(p=(ICON[0], ICON[1]), a=(32, 32), s=40), ty=2, refId="icon")

    # Browser window and a docs page.
    page = [
        group([rect(x + 70, y + 110, 260, 22, 4), fill("#1d1712")], "title"),
        group([rect(x + 70, y + 148, 470, 10, 5), fill("#e3dbd4")], "line1"),
        group([rect(x + 70, y + 168, 430, 10, 5), fill("#e3dbd4")], "line2"),
        group([rect(x + 70, y + 188, 380, 10, 5), fill("#e3dbd4")], "line3"),
        group([rect(x + 70, y + 222, 180, 14, 4), fill("#45392f")], "h2"),
        # In a shape layer, earlier groups draw on top: text lines before the block behind them.
        group([rect(x + 92, y + 272, 150, 8, 4), fill(ORANGE)], "code1"),
        group([rect(x + 92, y + 292, 300, 8, 4), fill("#a8988b")], "code2"),
        group([rect(x + 92, y + 312, 240, 8, 4), fill("#a8988b")], "code3"),
        group([rect(x + 92, y + 332, 120, 8, 4), fill("#a8988b")], "code4"),
        group([rect(x + 70, y + 250, 450, 110, 10), fill("#1b1410")], "code"),
        group([rect(x + 70, y + 384, 460, 10, 5), fill("#e3dbd4")], "line4"),
        group([rect(x + 70, y + 404, 410, 10, 5), fill("#e3dbd4")], "line5"),
        group([rect(x + 70, y + 424, 300, 10, 5), fill("#e3dbd4")], "line6"),
    ]
    chrome = [
        group([ellipse(x + 26, y + BAR_H / 2, 12), fill("#ff5f57")], "close"),
        group([ellipse(x + 46, y + BAR_H / 2, 12), fill("#febc2e")], "min"),
        group([ellipse(x + 66, y + BAR_H / 2, 12), fill("#28c840")], "max"),
        group([ellipse(x + 116, y + BAR_H / 2, 9), fill("#a8988b")], "lock"),
        group([rect(x + 132, y + 23, 190, 8, 4), fill("#d9cbc0")], "url"),
        group([rect(x + 96, y + 13, w - 196, 28, 14), fill("#ffffff")], "address"),
        group([rect(x, y, w, BAR_H, 0), fill("#f3eee9")], "toolbar"),
    ]
    window = [group([rect(x, y, w, h, 14), stroke("#e3dbd4", 1.5), fill("#ffffff")], "window")]
    layer("page", page)
    layer("browser", chrome + window)

    return {"v": "5.7.4", "fr": FPS, "ip": 0, "op": END, "w": W, "h": H, "nm": "scoop.md hero",
            "ddd": 0, "assets": assets, "layers": layers}


if __name__ == "__main__":
    data = build()
    OUT.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")
