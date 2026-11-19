#!/usr/bin/env python3
"""Bake the Task 4 static board assets of the 2.5D pipeline.

Run inside the pinned Blender:

    ~/.local/opt/blender-4.5.9/blender --background \
        --python tools/render/bake_board_assets.py -- --bake

Task 4 of ``2_5d_implementation_plan.md``: generate the minimal static 2D
image set the Task 5/6 compositor rebuilds the whole table from.

  - ``frontend/public/table/board_bg.png``: the empty table (mat, rim, centre
    well and room floor) at the layout's 1920 x 1080 reference resolution,
    opaque, with every tile body, decal and hand-shadow helper hidden.
  - ``frontend/public/table/blanks/<bucket>.png``: one cropped RGBA blank tile
    body per bucket in ``table_layout.json``'s ``bucketCatalogue`` (16 buckets:
    5 standing hand, 2 side wall, 3 horizontal wall, 3 flat + 3 flat rotated).
    The body is the catalogue's representative slot, at its own pose, rendered
    alone against a transparent film. No shadow catcher and no floor are
    visible, so alpha carries no external drop shadow; only the tile's own
    bevel self-shading is inside the body. Task 4A derives the cast mat
    shadows and the crevice seam masks separately.
  - ``frontend/public/table/blanks.json``: the sprite manifest. Every blank
    records its size, its alpha crop, the representative slot's exported
    normalized ``anchor``, the pixel ``pivot`` that anchor lands on inside the
    sprite, the slot's ``faceQuad`` in sprite pixels, its depth/scale, and the
    decoded-RGBA sha256.

The sprite frame is ``pixelRatio`` x the 1920 x 1080 layout frame (2x here), so
the runtime either draws @2x or downsamples; every number is in real rendered
pixels, never an upscale. The atlas (``tile_faces.png`` / ``tile_faces.json``)
is a separate resvg pass: ``scripts/bake-tile-faces-atlas.mjs``; this script
only owns the Blender half.

Options:
    --dry-run          print the bucket/representative plan; write nothing
    --bake             render and write the committed assets
    --samples N        override the blank/board sample count (tuning only)

The script always bakes the spec's default rig variant: ``table_layout.json``
is the runtime contract for that variant, and a blank posed at any other
variant's anchor would not match the layout. The script is idempotent at the
decoded-pixel level (seed 0, CPU Cycles), but a PNG's container bytes can differ
between runs, so the manifest hashes decoded RGBA exactly like the shell and
face pipelines do.
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

RENDER_DIR = Path(__file__).resolve().parent
if str(RENDER_DIR) not in sys.path:
    sys.path.insert(0, str(RENDER_DIR))

import bake_table_reference as reference  # noqa: E402
from bake_shells import die, encode_png, load_rgba, log, render_pass  # noqa: E402

REPO_ROOT = RENDER_DIR.parent.parent
SPEC_PATH = RENDER_DIR / "board-assets-spec.json"
TABLE_MESHES = {
    "floor",
    "mat",
    "rim",
    "compass-well-floor",
    "compass-plate",
    "compass-ring",
}

def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        die(f"{path} not found")
    except json.JSONDecodeError as error:
        die(f"{path} is not valid JSON: {error}")


def parse_options(argv: list[str]) -> dict:
    options = {"dryRun": False, "bake": False, "samples": None, "rig": True}
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--dry-run":
            options["dryRun"] = True
        elif arg == "--bake":
            options["bake"] = True
        elif arg == "--samples":
            if index + 1 >= len(argv):
                die("--samples needs a value")
            options["samples"] = int(argv[index + 1])
            index += 1
        else:
            die(f"unknown option {arg}")
        index += 1
    if not options["dryRun"] and not options["bake"]:
        options["dryRun"] = True
    return options


def sha256_rgba(rgba: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(rgba, dtype=np.uint8).tobytes()).hexdigest()


def bytes_of(path: Path) -> int:
    return path.stat().st_size


def alpha_summary(rgba: np.ndarray, threshold: int) -> dict:
    alpha = rgba[:, :, 3]
    opaque = int(np.count_nonzero(alpha == 255))
    partial = int(np.count_nonzero((alpha > 0) & (alpha < 255)))
    body = alpha > threshold
    if not body.any():
        die("alpha summary: sprite is fully transparent")
    rows = np.where(body.any(axis=1))[0]
    cols = np.where(body.any(axis=0))[0]
    return {
        "opaquePixels": opaque,
        "partialAlphaPixels": partial,
        "alphaBBox": {
            "left": int(cols[0]),
            "top": int(rows[0]),
            "right": int(cols[-1]),
            "bottom": int(rows[-1]),
        },
    }


def visible_only(keep: set[str]) -> None:
    """Hide every mesh body except ``keep``; cameras and lights stay."""
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        obj.hide_render = obj.name not in keep
        obj.hide_viewport = obj.name not in keep


def hide_all_but_board() -> None:
    visible_only(TABLE_MESHES)


def hide_all_but_tile(tile_id: str) -> None:
    visible_only({tile_id})


def quad_area(quad: list[dict]) -> float:
    area = 0.0
    for index, point in enumerate(quad):
        following = quad[(index + 1) % len(quad)]
        area += point["x"] * following["y"] - following["x"] * point["y"]
    return area / 2.0


def tile_frame_bbox(camera: dict, tile, frame_width: int, frame_height: int, margin: int) -> dict:
    """The tile's projected pixel bbox, clamped and expanded for the crop margin."""
    xs: list[float] = []
    ys: list[float] = []
    for corner in tile.bound_box:
        point = tile.matrix_world @ Vector(corner)
        px, py = reference.project_point(camera, point)
        xs.append(px)
        ys.append(py)
    left = max(0, int(math.floor(min(xs))) - margin)
    right = min(frame_width, int(math.ceil(max(xs))) + margin)
    top = max(0, int(math.floor(min(ys))) - margin)
    bottom = min(frame_height, int(math.ceil(max(ys))) + margin)
    if right - left < 8 or bottom - top < 8:
        die(f"board assets: {tile.name} projects to an empty {right - left}x{bottom - top} region")
    return {"left": left, "top": top, "right": right, "bottom": bottom}


def configure_subframe(
    scene,
    camera: dict,
    rig: dict,
    bbox: dict,
    frame_width: int,
    frame_height: int,
) -> None:
    """Render only ``bbox`` at the full frame's pixel density.

    Blender's border crop rounds its origin, which makes the pivot ambiguous by
    a pixel. Instead the camera is re-fitted to a sub-frame whose pixel grid is
    proven identical to the full frame's crop: the sensor width scales with the
    sub-frame width (so the focal length in pixels is unchanged) and the lens
    shift moves the full frame's ``(left, top)`` to the sub-frame origin. The
    bake asserts the saved size, and this exact mapping was measured against a
    full-frame render (decoded alpha identical, zero differing pixels).
    """
    width = bbox["right"] - bbox["left"]
    height = bbox["bottom"] - bbox["top"]
    data = scene.camera.data
    data.sensor_width = float(rig["camera"]["sensorWidthMm"]) * width / frame_width
    data.shift_x = (
        camera["shiftX"] * frame_width + bbox["left"] + width / 2 - frame_width / 2
    ) / width
    data.shift_y = (
        camera["shiftY"] * frame_width + frame_height / 2 - bbox["top"] - height / 2
    ) / width
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.use_border = False
    scene.render.use_crop_to_border = False


def main() -> None:
    argv = reference.blender_args()
    options = parse_options(argv)
    spec = read_json(SPEC_PATH)
    source_spec = read_json(RENDER_DIR / spec["sources"]["referenceSpec"])
    layout = read_json((RENDER_DIR / spec["sources"]["layout"]).resolve())

    variant_id, _variant, scene_spec = reference.resolve_variant(source_spec, None)
    rig = scene_spec["rig"]
    layout_resolution = [
        int(layout["referenceResolution"]["width"]),
        int(layout["referenceResolution"]["height"]),
    ]
    if layout_resolution != list(rig["output"]["resolution"]):
        die(
            "board assets: the layout's referenceResolution "
            f"{layout_resolution} is not the rig's {rig['output']['resolution']}"
        )
    if layout.get("variant") != variant_id:
        die(
            f"board assets: table_layout.json was exported for variant "
            f"{layout.get('variant')!r}, but this bake resolves {variant_id!r}"
        )

    catalogue = layout.get("bucketCatalogue") or {}
    if not catalogue:
        die("board assets: table_layout.json has no bucketCatalogue")
    buckets = sorted(catalogue)
    slots = {slot["id"]: slot for slot in layout["slots"]}

    spec_board = spec["board"]
    spec_blanks = spec["blanks"]
    pixel_ratio = int(spec_blanks["pixelRatio"])
    frame_width = int(layout_resolution[0]) * pixel_ratio
    frame_height = int(layout_resolution[1]) * pixel_ratio

    if options["dryRun"]:
        log(f"board assets: variant {variant_id}")
        log(
            f"board: {spec_board['resolution'][0]}x{spec_board['resolution'][1]} -> "
            f"{spec_board['file']}"
        )
        log(
            f"blanks: {len(buckets)} buckets at {pixel_ratio}x "
            f"({frame_width}x{frame_height}) -> {spec_blanks['dir']}"
        )
        for bucket in buckets:
            record = catalogue[bucket]
            slot = slots[record["representative"]]
            log(
                f"  {bucket:<20} {record['family']:<16} "
                f"{record['count']:>3} slots  representative {record['representative']} "
                f"(anchor {slot['anchor']['x']:.4f},{slot['anchor']['y']:.4f})"
            )
        return

    board_path = (RENDER_DIR / spec_board["file"]).resolve()
    blanks_dir = (RENDER_DIR / spec_blanks["dir"]).resolve()
    manifest_path = (RENDER_DIR / spec_blanks["manifest"]).resolve()
    build_root = RENDER_DIR / "build" / "board-assets" / variant_id
    board_path.parent.mkdir(parents=True, exist_ok=True)
    blanks_dir.mkdir(parents=True, exist_ok=True)
    (build_root / "renders").mkdir(parents=True, exist_ok=True)

    scene, _scene_data, _shell_spec = reference.build_scene(scene_spec, options)
    camera_1x = reference.camera_from_candidate(rig["camera"], list(layout_resolution))
    camera_2x = reference.camera_from_candidate(rig["camera"], [frame_width, frame_height])
    reference.build_camera_object(scene, camera_2x)

    # Re-project the representatives the same way Task 3 did and fail if the
    # baked scene has drifted from the committed contract.
    worst_px = 0.0
    for bucket in buckets:
        slot = slots[catalogue[bucket]["representative"]]
        anchor = bpy.data.objects.get(slot["id"])
        if anchor is None:
            die(f"board assets: SlotAnchors has no {slot['id']}")
        px, py = reference.project_point(camera_1x, anchor.matrix_world.translation)
        worst_px = max(
            worst_px,
            abs(px - slot["anchor"]["x"] * layout_resolution[0]),
            abs(py - slot["anchor"]["y"] * layout_resolution[1]),
        )
    if worst_px > 0.5:
        die(
            "board assets: the built scene drifts from table_layout.json by "
            f"{worst_px:.3f} px; re-run bake-table-layout.sh"
        )
    log(f"representatives: {len(buckets)} anchors match the layout within {worst_px:.3f} px")

    samples = options["samples"]
    blanks: dict[str, dict] = {}
    totals = {"blankSprites": 0, "bytes": 0}

    # ------------------------------------------------------------------ board
    scene.render.resolution_x = spec_board["resolution"][0]
    scene.render.resolution_y = spec_board["resolution"][1]
    scene.render.resolution_percentage = 100
    scene.cycles.samples = samples if samples is not None else spec_board["samples"]
    scene.render.film_transparent = bool(spec_board["filmTransparent"])
    scene.render.image_settings.color_mode = "RGBA"
    hide_all_but_board()
    if spec_board.get("showFloor", True):
        floor = bpy.data.objects.get("floor")
        if floor is not None:
            floor.hide_render = False
            floor.hide_viewport = False
    log(
        f"board: rendering {spec_board['resolution'][0]}x{spec_board['resolution'][1]} "
        f"at {scene.cycles.samples} samples, film transparent "
        f"{scene.render.film_transparent}"
    )
    render_pass(scene, board_path)
    board_rgba = np.clip(np.rint(load_rgba(board_path) * 255.0), 0, 255).astype(np.uint8)
    board_height, board_width = board_rgba.shape[:2]
    if [board_width, board_height] != list(spec_board["resolution"]):
        die(
            f"board: wrote {board_width}x{board_height}, expected "
            f"{spec_board['resolution'][0]}x{spec_board['resolution'][1]}"
        )
    expected_alpha = int(spec["checks"]["boardAlpha"])
    if int(board_rgba[:, :, 3].min()) != expected_alpha:
        die(
            "board: film is not opaque "
            f"(min alpha {int(board_rgba[:, :, 3].min())}, expected {expected_alpha})"
        )
    board_record = {
        "textureFile": Path(spec_board["file"]).name,
        "width": board_width,
        "height": board_height,
        "pixelRatio": 1,
        "bytes": bytes_of(board_path),
        "alpha": {"min": int(board_rgba[:, :, 3].min()), "max": int(board_rgba[:, :, 3].max())},
        "sha256": {"decodedRgba": sha256_rgba(board_rgba)},
        "scene": {
            "visible": sorted(TABLE_MESHES),
            "filmTransparent": False,
            "floorVisible": True,
        },
    }
    log(
        f"board: {board_width}x{board_height}, {board_record['bytes']} B, "
        f"opaque, {board_path}"
    )

    # ----------------------------------------------------------------- blanks
    scene.render.resolution_x = frame_width
    scene.render.resolution_y = frame_height
    scene.cycles.samples = samples if samples is not None else spec_blanks["samples"]
    scene.render.film_transparent = True
    scene.render.image_settings.color_mode = "RGBA"
    threshold = int(spec_blanks["alphaThreshold"])
    padding = int(spec_blanks["paddingPx"])

    for bucket in buckets:
        catalogue_record = catalogue[bucket]
        slot = slots[catalogue_record["representative"]]
        anchor = bpy.data.objects[slot["id"]]
        tile_id = anchor.get("tileId")
        if not tile_id:
            die(
                f"board assets: representative {slot['id']} of {bucket} has no body; "
                "Task 4 needs a filled reference tile to pose"
            )
        tile = bpy.data.objects.get(tile_id)
        if tile is None:
            die(f"board assets: representative tile {tile_id} is missing from the scene")
        if tile.type != "MESH":
            die(f"board assets: representative {tile_id} is a {tile.type}, not a mesh")

        hide_all_but_tile(tile_id)
        bbox = tile_frame_bbox(camera_2x, tile, frame_width, frame_height, padding + 16)
        configure_subframe(scene, camera_2x, rig, bbox, frame_width, frame_height)
        from bpy_extras.object_utils import world_to_camera_view

        view = world_to_camera_view(scene, scene.camera, anchor.matrix_world.translation)
        expected_anchor = (
            slot["anchor"]["x"] * frame_width - bbox["left"],
            slot["anchor"]["y"] * frame_height - bbox["top"],
        )
        actual_anchor = (
            view.x * (bbox["right"] - bbox["left"]),
            (1.0 - view.y) * (bbox["bottom"] - bbox["top"]),
        )
        if max(
            abs(actual_anchor[0] - expected_anchor[0]),
            abs(actual_anchor[1] - expected_anchor[1]),
        ) > 0.5:
            die(
                f"blank {bucket}: the sub-frame camera maps the anchor to "
                f"{actual_anchor[0]:.3f},{actual_anchor[1]:.3f}, expected "
                f"{expected_anchor[0]:.3f},{expected_anchor[1]:.3f}"
            )
        render_path = build_root / "renders" / f"{bucket}.png"
        render_pass(scene, render_path)
        rgba = np.clip(np.rint(load_rgba(render_path) * 255.0), 0, 255).astype(np.uint8)
        expected_size = [bbox["bottom"] - bbox["top"], bbox["right"] - bbox["left"]]
        if list(rgba.shape[:2]) != expected_size:
            die(
                f"blank {bucket}: sub-frame wrote {rgba.shape[1]}x{rgba.shape[0]}, "
                f"expected {expected_size[1]}x{expected_size[0]}; the crop origin would be wrong"
            )
        alpha = rgba[:, :, 3]
        body = alpha > threshold
        if not body.any():
            die(f"blank {bucket}: the representative tile rendered no alpha")
        rows = np.where(body.any(axis=1))[0]
        cols = np.where(body.any(axis=0))[0]
        region_left = int(cols[0]) - padding
        region_top = int(rows[0]) - padding
        region_right = int(cols[-1]) + padding + 1
        region_bottom = int(rows[-1]) + padding + 1
        if (
            region_left < 0
            or region_top < 0
            or region_right > expected_size[1]
            or region_bottom > expected_size[0]
        ):
            die(
                f"blank {bucket}: the tile touches its render region edge; widen the "
                "border margin or the sprite would be clipped"
            )
        sprite = rgba[region_top:region_bottom, region_left:region_right]
        left = bbox["left"] + region_left
        top = bbox["top"] + region_top
        sprite_path = blanks_dir / f"{bucket}.png"
        encode_png(sprite_path, sprite)
        summary = alpha_summary(sprite, threshold)

        pivot = {
            "x": round(slot["anchor"]["x"] * frame_width - left, 3),
            "y": round(slot["anchor"]["y"] * frame_height - top, 3),
        }
        sprite_quad = [
            {
                "x": round(slot["anchor"]["x"] * frame_width + corner["x"] * frame_width - left, 3),
                "y": round(slot["anchor"]["y"] * frame_height + corner["y"] * frame_height - top, 3),
            }
            for corner in slot["faceQuad"]
        ]
        area = quad_area(sprite_quad)
        if abs(area) < 1e-6:
            die(f"blank {bucket}: the sprite faceQuad has no area")
        if not (0 <= pivot["x"] < sprite.shape[1] and 0 <= pivot["y"] < sprite.shape[0]):
            die(
                f"blank {bucket}: the anchor pivot {pivot} falls outside the "
                f"{sprite.shape[1]}x{sprite.shape[0]} sprite"
            )

        record = {
            "bucket": bucket,
            "family": catalogue_record["family"],
            "representative": slot["id"],
            "slotCount": catalogue_record["count"],
            "textureFile": f"{Path(spec_blanks['dir']).name}/{bucket}.png",
            "width": int(sprite.shape[1]),
            "height": int(sprite.shape[0]),
            "pixelRatio": pixel_ratio,
            "crop": {"left": left, "top": top},
            "anchor": {
                "x": slot["anchor"]["x"],
                "y": slot["anchor"]["y"],
            },
            "pivot": pivot,
            "depth": slot["depth"],
            "scale": slot["scale"],
            "faceVisible": area > 0,
            "faceQuad": sprite_quad,
            "faceQuadAreaPx": round(area, 2),
            "alpha": summary,
            "bytes": bytes_of(sprite_path),
            "sha256": {"decodedRgba": sha256_rgba(sprite)},
        }
        blanks[bucket] = record
        totals["blankSprites"] += 1
        totals["bytes"] += record["bytes"]
        log(
            f"blank {bucket:<20} {record['width']:>4}x{record['height']:<4} "
            f"pivot {pivot['x']:.1f},{pivot['y']:.1f}  {record['bytes']} B  "
            f"({slot['id']})"
        )

    if totals["blankSprites"] > int(spec["checks"]["maxBlankSprites"]):
        die(
            f"board assets: {totals['blankSprites']} blank sprites exceeds the "
            f"Task 4 acceptance of under {spec['checks']['maxBlankSprites']}"
        )

    manifest = {
        "version": 1,
        "generatedBy": "tools/render/bake_board_assets.py",
        "blender": bpy.app.version_string,
        "rig": layout.get("rig"),
        "variant": variant_id,
        "layout": {
            "file": "table_layout.json",
            "sha256": hashlib.sha256(
                (RENDER_DIR / spec["sources"]["layout"]).resolve().read_bytes()
            ).hexdigest(),
        },
        "referenceResolution": {
            "width": int(layout_resolution[0]),
            "height": int(layout_resolution[1]),
        },
        "pixelRatio": pixel_ratio,
        "frame": {"width": frame_width, "height": frame_height},
        "camera": camera_2x,
        "coordinateSpace": (
            "All sprite numbers are rendered pixels of the pixelRatio-scaled "
            f"{frame_width} x {frame_height} frame whose normalized coordinates are "
            "table_layout.json's 1920 x 1080 contract. Place a blank so that its "
            "pivot pixel lands on anchor * referenceResolution * pixelRatio; "
            "faceQuad is the same slot's TL,TR,BR,BL corners in sprite pixels. "
            "faceVisible is the sign of that projected quad: a face-down wall tile's "
            "published face frame points into the table, so its quad is mirrored on "
            "screen (negative area) and no glyph is mapped onto that blank."
        ),
        "board": board_record,
        "totals": {**totals, "bytesTotalWithBoard": totals["bytes"] + board_record["bytes"]},
        "blanks": blanks,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    log(
        f"blanks: {totals['blankSprites']} sprites, {totals['bytes']} B -> "
        f"{blanks_dir}"
    )
    log(f"board assets: {manifest_path}")
    log("board assets: done — run scripts/check-board-assets.mjs for the gate")


if __name__ == "__main__":
    main()
