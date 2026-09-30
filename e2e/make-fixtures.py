#!/usr/bin/env python3
"""Generate PNG fixtures for the E2E test page.

Solid-color PNGs are written with a small hand-rolled PNG encoder.
Video (clip.mp4) and audio (tone.mp3) are generated with the ffmpeg binary
bundled with Playwright (see e2e/run-test.mjs which calls ffmpeg directly).
"""

import struct
import zlib

TEST_DIR = __file__.rsplit("/", 1)[0]


def make_png(path, w, h, rgb):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8-bit RGB
    row = b"\x00" + bytes(rgb) * w
    idat = zlib.compress(row * h, 9)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    make_png(f"{TEST_DIR}/test-page/red.png", 200, 120, (229, 57, 53))
    make_png(f"{TEST_DIR}/test-page/green.png", 200, 120, (67, 160, 71))
    make_png(f"{TEST_DIR}/test-page/blue.png", 200, 120, (30, 136, 229))
    make_png(f"{TEST_DIR}/test-page/lazy1.png", 200, 120, (251, 140, 0))
    make_png(f"{TEST_DIR}/test-page/lazy2.png", 200, 120, (142, 36, 170))
    make_png(f"{TEST_DIR}/test-page/bg-art.png", 400, 200, (55, 71, 79))
    make_png(f"{TEST_DIR}/test-page/video-poster.png", 320, 180, (69, 90, 100))
    make_png(f"{TEST_DIR}/test-page/strict1.png", 200, 120, (0, 121, 107))
    print("png fixtures written")


if __name__ == "__main__":
    main()
