"""Draw the ASound logo (same geometry as branding/asound-logo.svg) into PNG and ICO files for the exe."""

import math
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "branding")
BLUE, ORANGE, WHITE = (0, 33, 165, 255), (250, 70, 22, 255), (255, 255, 255, 255)
S = 4  # supersampling: draw at 2048 px, then shrink


def p(x, y):
    return (x * S, y * S)


def thick_line(d, pts, width, color):
    w = width * S
    d.line([p(*a) for a in pts], fill=color, width=int(w), joint="curve")
    for x, y in (pts[0], pts[-1]):
        r = w / 2
        d.ellipse([x * S - r, y * S - r, x * S + r, y * S + r], fill=color)


def arc(d, cx, cy, r, a0, a1, width, color):
    # a0..a1 in degrees, y axis pointing down (as in SVG)
    steps = 40
    pts = [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / steps)), cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / steps))) for i in range(steps + 1)]
    thick_line(d, pts, width, color)


def draw():
    img = Image.new("RGBA", (512 * S, 512 * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, 512 * S - 1, 512 * S - 1], radius=116 * S, fill=BLUE)
    # antennas, balls and signal arcs (white)
    thick_line(d, [(146, 262), (146, 130)], 26, WHITE)
    thick_line(d, [(366, 262), (366, 130)], 26, WHITE)
    for cx in (146, 366):
        r = 19 * S
        d.ellipse([cx * S - r, 108 * S - r, cx * S + r, 108 * S + r], fill=WHITE)
    arc(d, 366, 108, 40, -75, -15, 13, WHITE)
    arc(d, 366, 108, 66, -75, -15, 13, WHITE)
    arc(d, 146, 108, 40, -105, -165, 13, WHITE)
    arc(d, 146, 108, 66, -105, -165, 13, WHITE)
    # the orange A / H
    thick_line(d, [(146, 430), (146, 262), (256, 122), (366, 262), (366, 430)], 46, ORANGE)
    # the sound-wave crossbar
    for x, y, hgt in ((178, 323, 40), (212, 299, 88), (246, 279, 128), (280, 299, 88), (314, 323, 40)):
        d.rounded_rectangle([x * S, y * S, (x + 20) * S, (y + hgt) * S], radius=10 * S, fill=WHITE)
    return img


if __name__ == "__main__":
    big = draw().resize((1024, 1024), Image.LANCZOS)
    big.save(os.path.join(OUT, "asound-1024.png"))
    big.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "asound-256.png"))
    big.save(os.path.join(OUT, "asound.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("icons written to branding/")
    # web app / phone icons: the rounded tile, and full-bleed versions (Android masks, iOS rounds by itself)
    web = os.path.join(ROOT, "app", "img")
    for size in (192, 512):
        big.resize((size, size), Image.LANCZOS).save(os.path.join(web, f"icon-{size}.png"))
    full = Image.new("RGBA", (1024, 1024), BLUE)
    full.alpha_composite(big.resize((820, 820), Image.LANCZOS), (102, 102))  # keep the glyph inside the 80% safe zone
    full.resize((512, 512), Image.LANCZOS).save(os.path.join(web, "icon-maskable-512.png"))
    full.convert("RGB").resize((180, 180), Image.LANCZOS).save(os.path.join(web, "apple-touch-icon.png"))
    print("icons written to app/img/")
