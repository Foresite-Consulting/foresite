"""Generate placeholder PWA icons for a theme folder.

These are stand-ins so the manifest is complete. They are NOT the Foresite
logo and must be replaced with icons made from the logo masters before any
public demo. Usage:

    python3 scripts/placeholder-icons.py themes/foresite

Requires Pillow (`pip install pillow`).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SIZES = {"icon-192.png": (192, False), "icon-512.png": (512, False), "icon-maskable-512.png": (512, True)}


def _font(size: int) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def make_icon(size: int, maskable: bool, bg: str, accent: str, fg: str, letter: str) -> Image.Image:
    image = Image.new("RGB", (size, size), bg)
    draw = ImageDraw.Draw(image)
    # Maskable icons keep everything inside the central 80% safe zone.
    inset = int(size * (0.18 if maskable else 0.10))
    draw.rounded_rectangle(
        (inset, inset, size - inset, size - inset), radius=int(size * 0.12), fill=accent
    )
    letter_font = _font(int(size * 0.42))
    draw.text((size / 2, size / 2 - size * 0.04), letter, font=letter_font, fill=fg, anchor="mm")
    label_font = _font(max(10, int(size * 0.075)))
    draw.text(
        (size / 2, size - inset - size * 0.07),
        "PLACEHOLDER",
        font=label_font,
        fill=fg,
        anchor="mm",
    )
    return image


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    theme_dir = Path(argv[1])
    tokens = json.loads((theme_dir / "tokens.json").read_text())
    palette = tokens["palette"]
    light = tokens["semantic"]["light"]

    def colour(ref: str) -> str:
        return ref if ref.startswith("#") else palette[ref]

    bg = colour(light["text-primary"])  # ink
    accent = colour(light["brand"])  # jade
    fg = colour(light["text-primary"])  # ink text on jade, per the brand rule
    name = (tokens.get("client") or {}).get("appName") or "F"
    for file_name, (size, maskable) in SIZES.items():
        make_icon(size, maskable, bg, accent, fg, name[0].upper()).save(theme_dir / file_name, optimize=True)
        print(f"wrote {theme_dir / file_name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
