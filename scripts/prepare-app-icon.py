#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import struct
import zlib
from pathlib import Path

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def read_png(path: Path) -> tuple[int, int, list[bytearray]]:
    data = path.read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("Input is not a PNG file")

    pos = len(PNG_SIGNATURE)
    idat = []
    width = height = bit_depth = color_type = interlace = None

    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        pos += 4
        chunk_type = data[pos : pos + 4]
        pos += 4
        chunk = data[pos : pos + length]
        pos += length + 4

        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, _, _, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
        elif chunk_type == b"IDAT":
            idat.append(chunk)
        elif chunk_type == b"IEND":
            break

    if bit_depth != 8 or color_type not in (2, 6) or interlace != 0:
        raise ValueError("Only 8-bit non-interlaced RGB/RGBA PNG files are supported")

    channels = 3 if color_type == 2 else 4
    stride = width * channels
    raw = zlib.decompress(b"".join(idat))
    rows: list[bytearray] = []
    previous = bytearray(stride)
    offset = 0

    for _ in range(height):
        filter_type = raw[offset]
        offset += 1
        row = bytearray(raw[offset : offset + stride])
        offset += stride

        if filter_type == 1:
            for i in range(stride):
                row[i] = (row[i] + (row[i - channels] if i >= channels else 0)) & 255
        elif filter_type == 2:
            for i in range(stride):
                row[i] = (row[i] + previous[i]) & 255
        elif filter_type == 3:
            for i in range(stride):
                left = row[i - channels] if i >= channels else 0
                row[i] = (row[i] + ((left + previous[i]) // 2)) & 255
        elif filter_type == 4:
            for i in range(stride):
                left = row[i - channels] if i >= channels else 0
                up = previous[i]
                upper_left = previous[i - channels] if i >= channels else 0
                row[i] = (row[i] + paeth(left, up, upper_left)) & 255
        elif filter_type != 0:
            raise ValueError(f"Unsupported PNG filter type: {filter_type}")

        decoded = row

        if channels == 3:
            rgba = bytearray(width * 4)
            for x in range(width):
                src = x * 3
                dst = x * 4
                rgba[dst : dst + 4] = row[src : src + 3] + b"\xff"
            row = rgba

        rows.append(row)
        previous = decoded

    return width, height, rows


def write_png(path: Path, width: int, height: int, rows: list[bytearray]) -> None:
    def chunk(chunk_type: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(chunk_type + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + chunk_type + payload + struct.pack(">I", crc)

    raw_rows = bytearray()
    for row in rows:
        raw_rows.append(0)
        raw_rows.extend(row)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    payload = (
        PNG_SIGNATURE
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw_rows), 9))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def luma(row: bytearray, x: int) -> int:
    i = x * 4
    return (299 * row[i] + 587 * row[i + 1] + 114 * row[i + 2]) // 1000


def remove_connected_dark_background(
    width: int,
    height: int,
    rows: list[bytearray],
    threshold: int,
) -> tuple[int, int, int, int, int]:
    background = bytearray(width * height)
    queue: collections.deque[tuple[int, int]] = collections.deque()

    def is_dark(x: int, y: int) -> bool:
        return luma(rows[y], x) <= threshold

    def seed(x: int, y: int) -> None:
        idx = y * width + x
        if not background[idx] and is_dark(x, y):
            background[idx] = 1
            queue.append((x, y))

    for x in range(width):
        seed(x, 0)
        seed(x, height - 1)
    for y in range(height):
        seed(0, y)
        seed(width - 1, y)

    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < width and 0 <= ny < height:
                idx = ny * width + nx
                if not background[idx] and is_dark(nx, ny):
                    background[idx] = 1
                    queue.append((nx, ny))

    min_x = width
    min_y = height
    max_x = -1
    max_y = -1
    transparent = 0

    for y, row in enumerate(rows):
        for x in range(width):
            i = x * 4
            if background[y * width + x]:
                row[i : i + 4] = b"\xff\xff\xff\x00"
                transparent += 1
            elif row[i + 3] > 0:
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)

    if max_x < min_x or max_y < min_y:
        raise ValueError("No foreground pixels found")

    return min_x, min_y, max_x, max_y, transparent


def crop_and_square(
    width: int,
    height: int,
    rows: list[bytearray],
    bbox: tuple[int, int, int, int],
    padding: int,
) -> tuple[int, int, list[bytearray], tuple[int, int, int, int]]:
    min_x, min_y, max_x, max_y = bbox
    min_x = max(0, min_x - padding)
    min_y = max(0, min_y - padding)
    max_x = min(width - 1, max_x + padding)
    max_y = min(height - 1, max_y + padding)

    crop_w = max_x - min_x + 1
    crop_h = max_y - min_y + 1
    side = max(crop_w, crop_h)
    out_rows = [bytearray([255, 255, 255, 0]) * side for _ in range(side)]
    paste_x = (side - crop_w) // 2
    paste_y = (side - crop_h) // 2

    for y in range(crop_h):
        src = rows[min_y + y]
        dst = out_rows[paste_y + y]
        dst[paste_x * 4 : (paste_x + crop_w) * 4] = src[min_x * 4 : (max_x + 1) * 4]

    return side, side, out_rows, (min_x, min_y, max_x, max_y)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--threshold", type=int, default=245)
    parser.add_argument("--padding", type=int, default=8)
    args = parser.parse_args()

    width, height, rows = read_png(args.input)
    bbox = remove_connected_dark_background(width, height, rows, args.threshold)
    clean_bbox = bbox[:4]
    out_w, out_h, out_rows, crop_bbox = crop_and_square(
        width, height, rows, clean_bbox, args.padding
    )
    write_png(args.output, out_w, out_h, out_rows)

    print(f"source={width}x{height}")
    print(f"threshold={args.threshold}")
    print(f"foreground_bbox={clean_bbox}")
    print(f"crop_bbox={crop_bbox}")
    print(f"transparent_pixels={bbox[4]}")
    print(f"output={args.output} {out_w}x{out_h}")


if __name__ == "__main__":
    main()
