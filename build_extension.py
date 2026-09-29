#!/usr/bin/env python3
"""Generate Universal Media Downloader extension icons.

Draws a download-arrow-inside-circle glyph in the project's blue accent
color at every size the manifest requires, then packages the extension
into extension/universal-media-downloader.zip.
"""

import math
import os
import shutil
import struct
import subprocess
import tempfile
import zlib

SIZES = [16, 48, 128]
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")

# Brand colors
FILL = (47, 129, 247)      # #2F81F7 blue
RING = (230, 237, 243)     # #E6EDF3 light gray
BG = (13, 17, 23)          # #0D1117 dark


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(size):
    """Render the icon into a size x size RGBA byte buffer."""
    c = size / 2.0
    r_outer = size * 0.48
    r_inner = size * 0.38
    px = bytearray()

    # Arrow geometry (relative units, sized to the icon)
    shaft_w = 0.16 * size
    head_w = 0.60 * size
    head_h = 0.30 * size
    shaft_top = -0.52 * r_inner
    shaft_bot = 0.10 * r_inner
    head_top = shaft_bot
    head_bot = 0.44 * r_inner

    for y in range(size):
        for x in range(size):
            dx = x + 0.5 - c
            dy = y + 0.5 - c
            d = math.hypot(dx, dy)

            # Anti-aliased circle fill
            alpha_ring = max(0.0, min(1.0, r_outer - d + 0.5))
            alpha_inner = max(0.0, min(1.0, d - r_inner + 0.5))
            in_disc = min(alpha_ring, 1.0)
            ring_px = min(in_disc, alpha_inner)  # disc minus inner hole

            # Arrow glyph (centered, pointing down)
            arrow = False
            if shaft_top <= dy <= shaft_bot and abs(dx) <= shaft_w / 2:
                arrow = True
            if head_top <= dy <= head_bot:
                t = (dy - head_top) / max(head_bot - head_top, 1e-6)
                if abs(dx) <= (head_w / 2) * (1 - t) + shaft_w / 2 * t:
                    arrow = True

            if arrow and in_disc > 0:
                col = RING
                a = in_disc
            elif ring_px > 0:
                col = FILL
                a = ring_px
            else:
                col = BG
                a = 0.0

            px.extend([col[0], col[1], col[2], round(a * 255)])
    return bytes(px)


def write_png(path, size, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    rows = b"".join(b"\x00" + raw[y * size * 4 : (y + 1) * size * 4] for y in range(size))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for s in SIZES:
        write_png(os.path.join(OUT_DIR, f"icon{s}.png"), s, render(s))
        print(f"icon{s}.png written")

    # Package the extension. The repo root IS the extension (so GitHub's
    # "Download ZIP" -> extract -> load unpacked works out of the box), but
    # the distributed ZIP gets a single universal-media-downloader/ top-level
    # folder so extraction always yields exactly the folder Chrome expects.
    root = os.path.dirname(os.path.abspath(__file__))
    zip_path = os.path.join(root, "universal-media-downloader.zip")
    if os.path.exists(zip_path):
        os.remove(zip_path)

    files = [
        "manifest.json",
        "popup.html",
        "popup.css",
        "popup.js",
        "background.js",
        "icons/icon16.png",
        "icons/icon48.png",
        "icons/icon128.png",
    ]
    for f in files:
        if not os.path.exists(os.path.join(root, f)):
            raise SystemExit(f"missing required extension file: {f}")

    staging = tempfile.mkdtemp(prefix="umd-pkg-")
    try:
        pkg = os.path.join(staging, "universal-media-downloader")
        os.makedirs(pkg)
        for f in files:
            dst = os.path.join(pkg, f)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(os.path.join(root, f), dst)
        subprocess.run(
            ["zip", "-r", "-X", zip_path, "universal-media-downloader"],
            cwd=staging,
            check=True,
            stdout=subprocess.DEVNULL,
        )
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    print(f"packaged: {zip_path} (contains universal-media-downloader/ at root)")


if __name__ == "__main__":
    main()
