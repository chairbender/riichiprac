#!/usr/bin/env python3
"""Bake the full-screen felt raster the 2.5D rendered view is drawn on.

This is the *only* background the rendered view has. There is no table model:
no felt plane in perspective, no rails, aprons, wall-ring track, compass plate
or room floor. The raster is a low-contrast mottled green cloth with a baked
vignette that darkens toward the screen edges, so semi-transparent tile shadows
ground naturally instead of reading as stickers on a flat colour.

Run it with the system Python (no Blender, no third-party packages):

    python3 tools/render/bake_felt.py
    python3 tools/render/bake_felt.py --spec tools/render/felt-spec.json

It is deterministic: the seed, the noise octaves, the vignette curve and the
ordered dither are all in ``felt-spec.json``. Re-baking the same spec reproduces
the same decoded pixels; the PNG container bytes can differ if zlib changes, so
compare decoded pixels, not file hashes.

Runtime fit: the committed raster is stretched to the viewport with
``background-size: 100% 100%`` (see ``runtime`` in the spec). ``cover`` would
scale by the long axis and crop the left/right vignette out of a portrait
phone, so the baked vignette would no longer touch the screen edges. The noise
is isotropic and low-frequency, which is why the non-uniform stretch is safe.

Output: ``frontend/public/table/felt.png``, 8-bit RGB PNG, no alpha.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import time
import zlib
from pathlib import Path

RENDER_DIR = Path(__file__).resolve().parent
DEFAULT_SPEC = RENDER_DIR / "felt-spec.json"


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def die(message: str) -> None:
    print(f"[felt] ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def log(message: str) -> None:
    print(f"[felt] {message}")


def load_spec(path: Path) -> dict:
    try:
        spec = json.loads(path.read_text())
    except FileNotFoundError:
        die(f"spec not found: {path}")
    except json.JSONDecodeError as error:
        die(f"{path} is not valid JSON: {error}")
    for key in (
        "width",
        "height",
        "colorType",
        "seed",
        "baseColor",
        "noise",
        "vignette",
        "dither",
        "output",
    ):
        if key not in spec:
            die(f"{path} is missing {key!r}")
    if spec["colorType"] != "rgb8":
        die(f"unsupported colorType {spec['colorType']!r}; this baker writes rgb8")
    if not spec["noise"]:
        die("the noise list is empty")
    return spec


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    if edge1 == edge0:
        return 1.0 if value >= edge1 else 0.0
    t = max(0.0, min(1.0, (value - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


def hash01(x: int, y: int, seed: int) -> float:
    """Deterministic 2D integer hash in [0, 1] (no NumPy, no OS entropy)."""
    n = (x * 374761393 + y * 668265263 + seed * 1013904223) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    n = (n ^ (n >> 16)) & 0xFFFFFFFF
    return n / 4294967295.0


def value_noise(x: float, y: float, cell: float, seed: int) -> float:
    """Bilinear value noise on a `cell`-pixel lattice, smoothstep-interpolated."""
    gx, gy = x / cell, y / cell
    x0, y0 = math.floor(gx), math.floor(gy)
    fx, fy = smoothstep(0.0, 1.0, gx - x0), smoothstep(0.0, 1.0, gy - y0)
    a = hash01(x0, y0, seed)
    b = hash01(x0 + 1, y0, seed)
    c = hash01(x0, y0 + 1, seed)
    d = hash01(x0 + 1, y0 + 1, seed)
    return (a * (1.0 - fx) + b * fx) * (1.0 - fy) + (c * (1.0 - fx) + d * fx) * fy


def bayer_matrix(order: int) -> list[list[float]]:
    """Normalised Bayer matrix in [-0.5, 0.5), used as ordered dither."""
    if order < 1 or order & (order - 1):
        die("dither.matrix must be a power of two")
    matrix = [[0]]
    size = 1
    while size < order:
        size *= 2
        previous = matrix
        matrix = [[0] * size for _ in range(size)]
        for y in range(size // 2):
            for x in range(size // 2):
                value = 4 * previous[y][x]
                matrix[y][x] = value
                matrix[y][x + size // 2] = value + 2
                matrix[y + size // 2][x] = value + 3
                matrix[y + size // 2][x + size // 2] = value + 1
    scale = order * order
    return [[(value + 0.5) / scale - 0.5 for value in row] for row in matrix]


# --------------------------------------------------------------------------- #
# Raster generation
# --------------------------------------------------------------------------- #


def sample_pixel(
    x: int,
    y: int,
    width: int,
    height: int,
    spec: dict,
    bayer: list[list[float]],
) -> tuple[int, int, int]:
    vignette = spec["vignette"]
    nx = (x + 0.5) / width * 2.0 - 1.0
    ny = (y + 0.5) / height * 2.0 - 1.0
    radius = math.hypot(
        nx * vignette["radiusX"],
        ny * vignette["radiusY"],
    )
    light = 1.0 - vignette["strength"] * smoothstep(
        vignette["innerRadius"],
        vignette["outerRadius"],
        radius,
    )
    # A very gentle pool of light off-centre, so the centre is not a flat disc.
    light += vignette["centerLift"] * (1.0 - min(1.0, radius))

    noise = 0.0
    for index, octave in enumerate(spec["noise"]):
        amplitude = octave["amplitude"]
        cell = octave["cell"]
        noise += (value_noise(x, y, cell, spec["seed"] + index * 17) - 0.5) * amplitude

    order = len(bayer)
    noise += bayer[y % order][x % order] * spec["dither"]["amplitude"]

    channels = []
    for channel in spec["baseColor"]:
        channels.append(int(max(0.0, min(255.0, channel * light + noise + 0.5))))
    return tuple(channels)


def bake_rows(spec: dict) -> list[bytes]:
    width = int(spec["width"])
    height = int(spec["height"])
    bayer = bayer_matrix(int(spec["dither"]["matrix"]))
    rows: list[bytes] = []
    started = time.time()
    for y in range(height):
        row = bytearray()
        for x in range(width):
            row.extend(sample_pixel(x, y, width, height, spec, bayer))
        rows.append(bytes(row))
        if y and y % 256 == 0:
            log(f"row {y}/{height} ({time.time() - started:.1f}s)")
    log(f"generated {width}x{height} in {time.time() - started:.1f}s")
    return rows


def png_bytes(rows: list[bytes], width: int, height: int) -> bytes:
    """Write an 8-bit RGB PNG with the Sub filter on every row (best here)."""
    raw = bytearray()
    bpp = 3
    for row in rows:
        raw.append(1)  # filter: Sub
        for i, value in enumerate(row):
            left = row[i - bpp] if i >= bpp else 0
            raw.append((value - left) & 0xFF)
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = struct.pack(">I", len(data)) + kind + data
        return body + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", compressed)
        + chunk(b"IEND", b"")
    )


# --------------------------------------------------------------------------- #
# Report
# --------------------------------------------------------------------------- #


def channel_stats(rows: list[bytes]) -> dict:
    maximum = 0
    minimum = 255
    clipped = 0
    total = 0
    for row in rows:
        for value in row:
            maximum = max(maximum, value)
            minimum = min(minimum, value)
            if value in (0, 255):
                clipped += 1
        total += len(row)
    return {
        "minChannel": minimum,
        "maxChannel": maximum,
        "clippedPixels": clipped // 3,
        "clippedFraction": clipped / total,
    }


def region_mean(rows: list[bytes], x0: int, y0: int, x1: int, y1: int) -> float:
    total = 0
    count = 0
    for y in range(y0, y1):
        row = rows[y]
        for x in range(x0, x1):
            i = x * 3
            total += 0.2126 * row[i] + 0.7152 * row[i + 1] + 0.0722 * row[i + 2]
            count += 1
    return total / count if count else 0.0


def report(rows: list[bytes], width: int, height: int, size: int) -> dict:
    band_x = max(1, width // 20)
    band_y = max(1, height // 20)
    centre = region_mean(rows, width // 2 - band_x, height // 2 - band_y, width // 2 + band_x, height // 2 + band_y)
    left = region_mean(rows, 0, height // 2 - band_y, band_x, height // 2 + band_y)
    right = region_mean(rows, width - band_x, height // 2 - band_y, width, height // 2 + band_y)
    top = region_mean(rows, width // 2 - band_x, 0, width // 2 + band_x, band_y)
    bottom = region_mean(rows, width // 2 - band_x, height - band_y, width // 2 + band_x, height)
    corners = [
        region_mean(rows, 0, 0, band_x, band_y),
        region_mean(rows, width - band_x, 0, width, band_y),
        region_mean(rows, 0, height - band_y, band_x, height),
        region_mean(rows, width - band_x, height - band_y, width, height),
    ]
    middle_row = region_mean(rows, 0, height // 2 - band_y, width, height // 2 + band_y)
    stats = channel_stats(rows)
    return {
        "width": width,
        "height": height,
        "bytes": size,
        "centreLuma": round(centre, 2),
        "leftEdgeLuma": round(left, 2),
        "rightEdgeLuma": round(right, 2),
        "topEdgeLuma": round(top, 2),
        "bottomEdgeLuma": round(bottom, 2),
        "cornerLuma": [round(value, 2) for value in corners],
        "middleRowLuma": round(middle_row, 2),
        "centreToCornerRatio": round(centre / max(1e-6, sum(corners) / len(corners)), 3),
        "leftRightDeltaPct": round(abs(left - right) / max(1e-6, (left + right) / 2) * 100.0, 3),
        "topBottomDeltaPct": round(abs(top - bottom) / max(1e-6, (top + bottom) / 2) * 100.0, 3),
        **stats,
    }


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, default=DEFAULT_SPEC)
    parser.add_argument("--out", type=Path, help="override the output path")
    args = parser.parse_args(argv)

    spec = load_spec(args.spec)
    width = int(spec["width"])
    height = int(spec["height"])
    out_path = args.out or (args.spec.resolve().parent / spec["output"])
    log(f"spec {args.spec} -> {out_path}")

    rows = bake_rows(spec)
    data = png_bytes(rows, width, height)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(data)

    stats = report(rows, width, height, len(data))
    budget = spec.get("budgets", {}).get("bytes")
    log(
        f"{width}x{height} rgb8 PNG, {len(data)} B"
        + (f" (budget {budget} B)" if budget else "")
    )
    log(
        "luma centre {centreLuma} corners {cornerLuma} ratio {centreToCornerRatio}; "
        "edges L/R {leftEdgeLuma}/{rightEdgeLuma} T/B {topEdgeLuma}/{bottomEdgeLuma} "
        "(symmetry {leftRightDeltaPct}% / {topBottomDeltaPct}%)".format(**stats)
    )
    log("channels {minChannel}..{maxChannel}, clipped {clippedPixels} px".format(**stats))
    if budget and len(data) > budget:
        die(f"{len(data)} B exceeds the felt budget of {budget} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
