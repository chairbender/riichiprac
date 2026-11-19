#!/usr/bin/env python3
"""Bake the Task 4A decoupled shadow assets of the 2.5D pipeline.

Run inside the pinned Blender:

    ~/.local/opt/blender-4.5.9/blender --background \
        --python tools/render/bake_shadow_assets.py -- --bake

Task 4A of ``2_5d_implementation_plan.md`` separates the table-surface cast
shadows from the blank tile bodies Task 4 baked. Board states change every
move, so a shadow cannot live inside a body sprite: it is drawn from the live
board state (Task 6A) and merges with its neighbours instead of stacking.

  - ``frontend/public/table/shadows/shadow_mat_<bucket>.png``: the shadow one
    tile of that bucket casts onto the mat. The tile is the bucket's
    representative body at its own pose, **grounded on the mat** (a wall
    bucket's representative is a top-tier tile, which rests on the tile below;
    its mat shadow is the base shadow of the stack, so it is dropped onto
    z = 0 and drawn at the bottom tier's anchor). The only geometry in the
    render besides that one body is a flat plane at the mat height, and the
    bake measures the darkening in two passes: the plane with the body hidden,
    then the plane with the body visible to shadow rays but not to the camera.
    ``alpha = 1 - pairLuma / refLuma`` is the fraction of the plane's light the
    tile removes, so drawing black at that alpha multiplies the felt by exactly
    the measured amount. There is no shadow-catcher pass to interpret and no
    look to eyeball: the number in the manifest is the render's own ratio.
  - ``frontend/public/table/shadows/shadow_wall_stack_<seat>.png``: the
    contact shadow a top-tier wall tile throws onto the bottom tile it sits
    on. Same two-pass measurement, masked to the bottom body's silhouette so
    the decal cannot leak onto the felt.
  - ``frontend/public/table/shadows.json``: the manifest. Every mat shadow
    shares its blank's bucket, representative and pixel *anchor* (crop + pivot
    = the pose's projected anchor), records the ground drop and the measured
    peak/mean alpha, support area and centroid, and the decoded-RGBA hash.

The four crevice masks (``ao_seam_{left,right,top,bottom}.png``) are
procedural UV gradients, not renders: ``scripts/bake-shadow-seams.mjs`` writes
them and ``ao_seams.json`` without Blender. Both manifests are gated by
``scripts/check-shadow-assets.mjs``.

Options:
    --dry-run          print the bucket/pose/shadow plan; write nothing
    --bake             render and write the committed assets
    --samples N        override the shadow sample count (tuning only)

The bake uses the spec's default rig variant, the same camera and the same
frame as Task 4: ``table_layout.json`` is that variant's contract, so a shadow
posed elsewhere would not line up with the blanks. Determinism: seed 0, CPU
Cycles, adaptive sampling and OpenImageDenoise exactly as ``configure_render``
pins them; the manifest hashes decoded RGBA because a PNG's container bytes can
differ between runs.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

RENDER_DIR = Path(__file__).resolve().parent
if str(RENDER_DIR) not in sys.path:
    sys.path.insert(0, str(RENDER_DIR))

import bake_board_assets as board  # noqa: E402
import bake_table_reference as reference  # noqa: E402
from bake_shells import die, encode_png, load_rgba, log, render_pass  # noqa: E402

SPEC_PATH = RENDER_DIR / "board-assets-spec.json"
CATCHER_NAME = "shadow-catcher"
SEATS = ("north", "south", "east", "west")
STACK_COLUMN = 8


# --------------------------------------------------------------------------- #
# Small numeric helpers
# --------------------------------------------------------------------------- #
def luma(rgb: np.ndarray) -> np.ndarray:
    return (
        0.2126 * rgb[..., 0].astype(np.float64)
        + 0.7152 * rgb[..., 1].astype(np.float64)
        + 0.0722 * rgb[..., 2].astype(np.float64)
    )


def occlusion_alpha(ref_rgba: np.ndarray, pair_rgba: np.ndarray, floor: float) -> np.ndarray:
    """The fraction of the plane's light the caster removes.

    ``1 - pairLuma / refLuma`` is a pure multiplier, so the published sprite
    (black at that alpha) darkens the felt by exactly the measured amount.
    Values below ``floor`` are sampling noise, not shadow, and are zeroed so a
    sprite's trim is its real extent.
    """
    ref = luma(ref_rgba[..., :3])
    pair = luma(pair_rgba[..., :3])
    alpha = np.clip(1.0 - pair / np.maximum(ref, 1e-4), 0.0, 1.0)
    alpha[alpha < floor] = 0.0
    return alpha


def alpha_extent(alpha: np.ndarray) -> dict:
    """Bounds of every non-zero sample, or a die when the field is empty."""
    rows = np.where(alpha.any(axis=1))[0]
    cols = np.where(alpha.any(axis=0))[0]
    if not rows.size:
        die("shadow bake: an occlusion field rendered fully empty")
    return {
        "left": int(cols[0]),
        "top": int(rows[0]),
        "right": int(cols[-1]),
        "bottom": int(rows[-1]),
    }


def reach_profile(alpha: np.ndarray, bbox: dict, origin: tuple[int, int], label: str) -> str:
    """Diagnostic: how far the field runs past the body bbox at several floors."""
    left = bbox["left"] - origin[0]
    top = bbox["top"] - origin[1]
    right = bbox["right"] - origin[0]
    bottom = bbox["bottom"] - origin[1]
    parts = []
    for floor in (1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0):
        field = np.where(alpha >= floor / 255.0, alpha, 0.0)
        rows = np.where(field.any(axis=1))[0]
        cols = np.where(field.any(axis=0))[0]
        if not rows.size:
            parts.append(f"{int(floor)}:0")
            continue
        reach = max(
            left - int(cols[0]),
            int(cols[-1]) - right,
            top - int(rows[0]),
            int(rows[-1]) - bottom,
        )
        parts.append(f"{int(floor)}:{reach}")
    return f"[reach] {label:<22} " + " ".join(parts)


def quantise(region: np.ndarray) -> np.ndarray:
    """Black RGBA with the occlusion in alpha (grayscale ink, multiply blend)."""
    rgba = np.zeros((*region.shape, 4), dtype=np.float64)
    rgba[..., 3] = region
    return np.clip(np.rint(rgba * 255.0), 0, 255).astype(np.uint8)


def publish_alpha(
    alpha: np.ndarray, offset: tuple[int, int], padding: int, path: Path, label: str
) -> dict:
    """Trim an occlusion field to its extent plus padding, publish it, measure it."""
    extent = alpha_extent(alpha)
    left = extent["left"] - padding
    top = extent["top"] - padding
    right = extent["right"] + padding + 1
    bottom = extent["bottom"] + padding + 1
    height, width = alpha.shape
    if left < 0 or top < 0 or right > width or bottom > height:
        die(
            f"shadow bake: {label} occlusion touches its render region edge; "
            "widen shadows.renderMarginPx and re-bake"
        )
    region = alpha[top:bottom, left:right]
    sprite = quantise(region)
    encode_png(path, sprite)
    support = region > 0.0
    weights = region[support]
    rows, cols = np.where(support)
    return {
        "sprite": sprite,
        "crop": {"left": offset[0] + left, "top": offset[1] + top},
        "offsetInRender": {"left": left, "top": top},
        "extentInSprite": {
            "left": extent["left"] - left,
            "top": extent["top"] - top,
            "right": extent["right"] - left,
            "bottom": extent["bottom"] - top,
        },
        "alpha": {
            "peakAlpha": round(float(region.max()), 4),
            "meanAlpha": round(float(weights.mean()), 4),
            "supportPx": int(support.sum()),
            "centroidInSprite": {
                "x": round(float((cols * weights).sum() / weights.sum()), 3),
                "y": round(float((rows * weights).sum() / weights.sum()), 3),
            },
        },
    }


def projected_bbox(camera: dict, obj, frame_width: int, frame_height: int) -> dict:
    """The object's projected pixel bbox with no margin, clamped to the frame."""
    return board.tile_frame_bbox(camera, obj, frame_width, frame_height, 0)


def expand(bbox: dict, margin: int, frame_width: int, frame_height: int) -> dict:
    return {
        "left": max(0, bbox["left"] - margin),
        "top": max(0, bbox["top"] - margin),
        "right": min(frame_width, bbox["right"] + margin),
        "bottom": min(frame_height, bbox["bottom"] + margin),
    }


def configure_pass(scene, camera: dict, rig: dict, bbox: dict, samples: int) -> None:
    """Pin the sub-frame, the sample count and the film for one shadow render.

    Adaptive sampling is off for the shadow passes: the ref and pair renders are
    divided against each other, and a per-pixel sample count would leave the two
    with different noise, which shows up as a low-frequency halo in the ratio.
    A fixed count with the scene's fixed seed makes the two integrators sample
    identically, so only the tile's own contribution survives the division.
    """
    board.configure_subframe(scene, camera, rig, bbox, *camera["resolution"])
    scene.render.resolution_percentage = 100
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = False
    scene.render.film_transparent = True
    scene.render.image_settings.color_mode = "RGBA"


def anchor_pixels(scene, camera: dict, bbox: dict, world_point: Vector, label: str) -> dict:
    """Project the pose's anchor into sub-frame pixels and prove it with Blender."""
    from bpy_extras.object_utils import world_to_camera_view

    expected = reference.project_point(camera, world_point)
    view = world_to_camera_view(scene, scene.camera, world_point)
    actual = (
        view.x * (bbox["right"] - bbox["left"]),
        (1.0 - view.y) * (bbox["bottom"] - bbox["top"]),
    )
    if (
        max(
            abs(actual[0] - (expected[0] - bbox["left"])),
            abs(actual[1] - (expected[1] - bbox["top"])),
        )
        > 0.5
    ):
        die(
            f"shadow bake: {label} sub-frame maps the anchor to "
            f"{actual[0]:.3f},{actual[1]:.3f}, expected "
            f"{expected[0] - bbox['left']:.3f},{expected[1] - bbox['top']:.3f}"
        )
    return {"x": expected[0] - bbox["left"], "y": expected[1] - bbox["top"]}


def ground_drop(obj) -> float:
    """How far the body's lowest point sits above the mat."""
    bpy.context.view_layer.update()
    return max(0.0, min((obj.matrix_world @ Vector(corner)).z for corner in obj.bound_box))


def build_catcher(scene, mat_spec: dict):
    """A flat plane at the mat's height: the only lit surface the shadows land on."""
    material = reference.make_material(
        "shadow-catcher", mat_spec["hex"], mat_spec["roughness"], 0.2
    )
    plane = reference.add_grid_mesh(
        CATCHER_NAME, float(mat_spec["sizeUnits"]) / 2.0, float(mat_spec["zUnits"]), material
    )
    plane.hide_render = True
    plane.hide_viewport = True
    return plane


def show_catcher(scene):
    catcher = bpy.data.objects[CATCHER_NAME]
    catcher.hide_render = False
    catcher.hide_viewport = False
    return catcher


# --------------------------------------------------------------------------- #
# Bake passes
# --------------------------------------------------------------------------- #
def bake_mat_shadows(
    scene,
    camera: dict,
    rig: dict,
    layout: dict,
    spec: dict,
    source_spec: dict,
    frame: tuple[int, int],
    out_dir: Path,
    work: Path,
) -> dict:
    shadow_spec = spec["shadows"]
    catalogue = layout["bucketCatalogue"]
    slots = {slot["id"]: slot for slot in layout["slots"]}
    blanks = json.loads((RENDER_DIR / spec["blanks"]["manifest"]).resolve().read_text())
    frame_width, frame_height = frame
    margin = int(shadow_spec["renderMarginPx"])
    floor = float(shadow_spec["noiseFloor"]) / 255.0
    padding = int(shadow_spec["paddingPx"])
    tier_step = float(source_spec["table"]["wall"]["tierStepUnits"])
    samples = int(shadow_spec["matSamples"])

    records: dict[str, dict] = {}
    for bucket in sorted(catalogue):
        entry = catalogue[bucket]
        slot = slots[entry["representative"]]
        blank = blanks["blanks"][bucket]
        anchor = bpy.data.objects[slot["id"]]
        tile_id = anchor.get("tileId")
        if not tile_id:
            die(f"shadow bake: representative {slot['id']} of {bucket} has no body")
        body = bpy.data.objects.get(tile_id)
        if body is None or body.type != "MESH":
            die(f"shadow bake: representative tile {tile_id} of {bucket} is missing")

        original_matrix = body.matrix_world.copy()
        drop = ground_drop(body)
        if slot["zone"] == "wall" and int(slot["row"]) == 1:
            if abs(drop - tier_step) > 1e-3:
                die(
                    f"shadow bake: {slot['id']} is a top-tier wall tile but sits "
                    f"{drop:.4f} units up, not the spec's {tier_step} tier step"
                )
        elif drop > 1e-3:
            die(f"shadow bake: {slot['id']} rests on the mat but sits {drop:.4f} units up")
        if drop > 0.0:
            body.matrix_world = Matrix.Translation(Vector((0.0, 0.0, -drop))) @ body.matrix_world
        centre = anchor.matrix_world.translation - Vector((0.0, 0.0, drop))
        # The rig's v13 hand cheat hides the south-hand bodies from shadow rays
        # and draws a fake decal instead. Task 4A's mat shadow is the physical
        # one, so the body casts again for this pass only.
        original_shadow_visibility = body.visible_shadow
        body.visible_shadow = True

        try:
            bpy.context.view_layer.update()
            body_bbox = projected_bbox(camera, body, frame_width, frame_height)
            bbox = expand(body_bbox, margin, frame_width, frame_height)
            board.visible_only({tile_id, CATCHER_NAME})
            show_catcher(scene)
            configure_pass(scene, camera, rig, bbox, samples)

            ref_path = work / "mat" / f"{bucket}-ref.png"
            pair_path = work / "mat" / f"{bucket}-pair.png"
            ref_path.parent.mkdir(parents=True, exist_ok=True)
            body.hide_render = True
            body.visible_camera = True
            render_pass(scene, ref_path)
            body.hide_render = False
            body.visible_camera = False
            render_pass(scene, pair_path)
            pivot = anchor_pixels(scene, camera, bbox, centre, bucket)
        finally:
            body.visible_camera = True
            body.visible_shadow = original_shadow_visibility
            body.matrix_world = original_matrix
            bpy.context.view_layer.update()

        alpha = occlusion_alpha(load_rgba(ref_path), load_rgba(pair_path), floor)
        log(reach_profile(alpha, body_bbox, (bbox["left"], bbox["top"]), bucket))
        placement = publish_alpha(
            alpha, (bbox["left"], bbox["top"]), padding, out_dir / f"shadow_mat_{bucket}.png", bucket
        )
        sprite = placement["sprite"]
        height, width = sprite.shape[:2]
        sprite_pivot = {
            "x": round(pivot["x"] - placement["offsetInRender"]["left"], 3),
            "y": round(pivot["y"] - placement["offsetInRender"]["top"], 3),
        }
        if not (0 <= sprite_pivot["x"] < width and 0 <= sprite_pivot["y"] < height):
            die(f"shadow bake: {bucket} pivot {sprite_pivot} falls outside its sprite")
        alpha_stats = placement["alpha"]
        centroid = {
            "x": round(alpha_stats["centroidInSprite"]["x"] - sprite_pivot["x"], 3),
            "y": round(alpha_stats["centroidInSprite"]["y"] - sprite_pivot["y"], 3),
        }
        alpha_stats.pop("centroidInSprite")
        alpha_stats["centroidFromPivot"] = centroid
        records[bucket] = {
            "bucket": bucket,
            "family": entry["family"],
            "representative": slot["id"],
            "slotCount": entry["count"],
            "blank": {
                "textureFile": blank["textureFile"],
                "anchor": blank["anchor"],
                "pivot": blank["pivot"],
            },
            "textureFile": f"{Path(shadow_spec['dir']).name}/shadow_mat_{bucket}.png",
            "width": int(width),
            "height": int(height),
            "pixelRatio": int(spec["blanks"]["pixelRatio"]),
            "crop": placement["crop"],
            "pivot": sprite_pivot,
            "anchor": {
                "x": round((bbox["left"] + pivot["x"]) / frame_width, 6),
                "y": round((bbox["top"] + pivot["y"]) / frame_height, 6),
            },
            "grounded": drop > 0.0,
            "groundDropUnits": round(drop, 6),
            "bodyBBox": body_bbox,
            "alpha": alpha_stats,
            "bytes": (out_dir / f"shadow_mat_{bucket}.png").stat().st_size,
            "sha256": {"decodedRgba": board.sha256_rgba(sprite)},
        }
        log(
            f"shadow mat {bucket:<20} {width:>4}x{height:<4} "
            f"pivot {pivot['x']:.1f},{pivot['y']:.1f}  "
            f"peak {alpha_stats['peakAlpha']:.3f}  support {alpha_stats['supportPx']:>5}  "
            f"drop {drop:.3f}  {records[bucket]['bytes']} B"
        )
    return records


def bake_wall_stack(
    scene,
    camera: dict,
    rig: dict,
    layout: dict,
    spec: dict,
    frame: tuple[int, int],
    out_dir: Path,
    work: Path,
) -> dict:
    shadow_spec = spec["shadows"]
    slots = {slot["id"]: slot for slot in layout["slots"]}
    blanks = json.loads((RENDER_DIR / spec["blanks"]["manifest"]).resolve().read_text())
    frame_width, frame_height = frame
    margin = int(shadow_spec["renderMarginPx"])
    floor = float(shadow_spec["noiseFloor"]) / 255.0
    padding = int(shadow_spec["paddingPx"])
    samples = int(shadow_spec["stackSamples"])

    records: dict[str, dict] = {}
    for seat in SEATS:
        low_id = f"wall_{seat}_{STACK_COLUMN:02d}_0"
        high_id = f"wall_{seat}_{STACK_COLUMN:02d}_1"
        low_anchor = bpy.data.objects.get(low_id)
        high_anchor = bpy.data.objects.get(high_id)
        if low_anchor is None or high_anchor is None:
            die(f"shadow bake: the {seat} wall stack anchors {low_id}/{high_id} are not in the scene")
        low = bpy.data.objects.get(low_anchor.get("tileId"))
        high = bpy.data.objects.get(high_anchor.get("tileId"))
        if low is None or high is None or low.type != "MESH" or high.type != "MESH":
            die(f"shadow bake: the {seat} wall stack bodies {low_id}/{high_id} are not in the scene")
        slot = slots[low_id]
        blank = blanks["blanks"][slot["bucket"]]

        bpy.context.view_layer.update()
        body_bbox = projected_bbox(camera, low, frame_width, frame_height)
        bbox = expand(body_bbox, margin, frame_width, frame_height)
        # No catcher plane here: the surface the shadow lands on is layer_0's
        # own top face, so pass A is the body alone and the ratio measures the
        # light layer_1 takes away from it.
        board.visible_only({low.name})
        configure_pass(scene, camera, rig, bbox, samples)

        ref_path = work / "stack" / f"{seat}-ref.png"
        pair_path = work / "stack" / f"{seat}-pair.png"
        ref_path.parent.mkdir(parents=True, exist_ok=True)
        low.hide_render = False
        low.visible_camera = True
        high.hide_render = True
        render_pass(scene, ref_path)
        high.hide_render = False
        high.visible_camera = False
        render_pass(scene, pair_path)
        high.visible_camera = True
        pivot = anchor_pixels(
            scene, camera, bbox, low_anchor.matrix_world.translation, f"{seat} stack"
        )

        ref_rgba = load_rgba(ref_path)
        alpha = occlusion_alpha(ref_rgba, load_rgba(pair_path), floor)
        # Only the bottom body can show the contact shadow; the felt around it
        # belongs to the mat pass, not to this decal.
        alpha[ref_rgba[..., 3] < 0.5] = 0.0
        name = f"shadow_wall_stack_{seat}.png"
        placement = publish_alpha(
            alpha, (bbox["left"], bbox["top"]), padding, out_dir / name, f"{seat} stack"
        )
        sprite = placement["sprite"]
        height, width = sprite.shape[:2]
        sprite_pivot = {
            "x": round(pivot["x"] - placement["offsetInRender"]["left"], 3),
            "y": round(pivot["y"] - placement["offsetInRender"]["top"], 3),
        }
        if not (0 <= sprite_pivot["x"] < width and 0 <= sprite_pivot["y"] < height):
            die(f"shadow bake: {seat} stack pivot {sprite_pivot} falls outside its sprite")
        alpha_stats = placement["alpha"]
        alpha_stats["centroidFromPivot"] = {
            "x": round(alpha_stats["centroidInSprite"]["x"] - sprite_pivot["x"], 3),
            "y": round(alpha_stats["centroidInSprite"]["y"] - sprite_pivot["y"], 3),
        }
        alpha_stats.pop("centroidInSprite")
        records[seat] = {
            "seat": seat,
            "layer0": low_id,
            "layer1": high_id,
            "bucket": slot["bucket"],
            "blank": {
                "textureFile": blank["textureFile"],
                "anchor": blank["anchor"],
                "pivot": blank["pivot"],
            },
            "textureFile": f"{Path(shadow_spec['dir']).name}/{name}",
            "width": int(width),
            "height": int(height),
            "pixelRatio": int(spec["blanks"]["pixelRatio"]),
            "crop": placement["crop"],
            "pivot": sprite_pivot,
            "anchor": {
                "x": round((bbox["left"] + pivot["x"]) / frame_width, 6),
                "y": round((bbox["top"] + pivot["y"]) / frame_height, 6),
            },
            "bodyBBox": body_bbox,
            "alpha": alpha_stats,
            "bytes": (out_dir / name).stat().st_size,
            "sha256": {"decodedRgba": board.sha256_rgba(sprite)},
        }
        np.save(work / "stack" / f"{seat}-alpha.npy", alpha.astype(np.float32))
        log(
            f"shadow stack {seat:<6} {width:>4}x{height:<4} pivot "
            f"{pivot['x']:.1f},{pivot['y']:.1f}  peak {alpha_stats['peakAlpha']:.3f}  "
            f"support {alpha_stats['supportPx']:>4}  {records[seat]['bytes']} B"
        )
    return records


def seat_agreement(records: dict, work: Path, frame: tuple[int, int]) -> dict:
    """How much the seats' stack decals differ, in frame coordinates.

    A single published sprite is only honest when the seats agree, so the bake
    measures it: each seat's occlusion field is placed at its frame-space crop
    origin and compared with the north one, max |difference| over the union.
    """
    if len(records) < 2:
        return {"compared": 0}
    frame_width, frame_height = frame
    fields = {}
    for seat, record in records.items():
        alpha = np.load(work / "stack" / f"{seat}-alpha.npy")
        canvas = np.zeros((frame_height, frame_width), dtype=np.float32)
        left = record["crop"]["left"]
        top = record["crop"]["top"]
        height, width = alpha.shape
        canvas[top : top + height, left : left + width] = alpha
        fields[seat] = canvas
    base_seat = "north"
    base = fields[base_seat]
    worst = {}
    for seat, canvas in fields.items():
        if seat == base_seat:
            continue
        worst[seat] = round(float(np.abs(canvas - base).max()), 4)
    return {
        "compared": len(worst),
        "reference": base_seat,
        "maxAlphaDifference": worst,
        "worst": max(worst.values()),
    }


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
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


def main() -> None:
    argv = reference.blender_args()
    options = parse_options(argv)
    spec = board.read_json(SPEC_PATH)
    source_spec = board.read_json(RENDER_DIR / spec["sources"]["referenceSpec"])
    layout = board.read_json((RENDER_DIR / spec["sources"]["layout"]).resolve())
    shadow_spec = spec["shadows"]

    variant_id, _variant, scene_spec = reference.resolve_variant(source_spec, None)
    rig = scene_spec["rig"]
    layout_resolution = [
        int(layout["referenceResolution"]["width"]),
        int(layout["referenceResolution"]["height"]),
    ]
    if layout_resolution != list(rig["output"]["resolution"]):
        die(
            "shadow bake: the layout's referenceResolution "
            f"{layout_resolution} is not the rig's {rig['output']['resolution']}"
        )
    if layout.get("variant") != variant_id:
        die(
            "shadow bake: table_layout.json was exported for variant "
            f"{layout.get('variant')!r}, but this bake resolves {variant_id!r}"
        )
    pixel_ratio = int(spec["blanks"]["pixelRatio"])
    frame = (layout_resolution[0] * pixel_ratio, layout_resolution[1] * pixel_ratio)

    catalogue = layout.get("bucketCatalogue") or {}
    if not catalogue:
        die("shadow bake: table_layout.json has no bucketCatalogue")
    slots = {slot["id"]: slot for slot in layout["slots"]}

    if options["dryRun"]:
        log(f"shadow bake: variant {variant_id}, {pixel_ratio}x frame {frame[0]}x{frame[1]}")
        log(
            f"mat shadows: {len(catalogue)} buckets -> {shadow_spec['dir']} "
            f"at {shadow_spec['matSamples']} samples, margin {shadow_spec['renderMarginPx']} px"
        )
        for bucket in sorted(catalogue):
            entry = catalogue[bucket]
            slot = slots[entry["representative"]]
            grounded = slot["zone"] == "wall" and int(slot["row"]) == 1
            log(
                f"  {bucket:<20} {entry['family']:<16} {slot['id']:<20} "
                f"{'grounded from tier 1' if grounded else 'rests on the mat'}"
            )
        log(
            f"wall stacks: {len(SEATS)} seats at column {STACK_COLUMN:02d}, "
            f"{shadow_spec['stackSamples']} samples"
        )
        return

    out_dir = (RENDER_DIR / shadow_spec["dir"]).resolve()
    manifest_path = (RENDER_DIR / shadow_spec["manifest"]).resolve()
    build_root = RENDER_DIR / "build" / "board-assets" / variant_id / "shadows"
    out_dir.mkdir(parents=True, exist_ok=True)
    build_root.mkdir(parents=True, exist_ok=True)

    scene, _scene_data, _shell_spec = reference.build_scene(scene_spec, options)
    camera_2x = reference.camera_from_candidate(rig["camera"], list(frame))
    reference.build_camera_object(scene, camera_2x)
    build_catcher(scene, shadow_spec["matPlane"])

    mats = bake_mat_shadows(
        scene, camera_2x, rig, layout, spec, source_spec, frame, out_dir, build_root
    )
    stacks = bake_wall_stack(
        scene, camera_2x, rig, layout, spec, frame, out_dir, build_root
    )
    agreement = seat_agreement(stacks, build_root, frame)

    manifest = {
        "version": 1,
        "generatedBy": "tools/render/bake_shadow_assets.py",
        "blender": bpy.app.version_string,
        "task": "4A",
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
        "frame": {"width": frame[0], "height": frame[1]},
        "camera": camera_2x,
        "composite": {
            "model": "multiply",
            "note": (
                "Every sprite is black (0,0,0) with the measured occlusion in alpha. "
                "alpha = 1 - shadowedLuma / litLuma on a plane at the mat height, so "
                "source-over black reproduces the physical darkening: dest * (1 - alpha). "
                "Draw the mat pass into an offscreen buffer with MAX alpha and composite "
                "it once (Task 6A pass 1), never with straight-over alpha."
            ),
        },
        "coordinateSpace": (
            "Rendered pixels of the pixelRatio-scaled frame, like blanks.json. Draw a "
            "sprite so its pivot pixel lands on anchor * referenceResolution * pixelRatio; "
            "for a blank and its mat shadow that is the same point, so the two share one "
            "draw position. A grounded wall shadow is drawn at its stack's BOTTOM tier "
            "anchor (groundDropUnits below the representative's own anchor): draw it once "
            "per stack, at layer 0, never at layer 1."
        ),
        "wallStack": {
            "canonical": "north",
            "column": STACK_COLUMN,
            "perSeat": True,
            "seatAgreement": agreement,
            "note": (
                "The plan named one shadow_wall_stack.png. The baked decals are "
                "NOT interchangeable across seats: aligning them by their frame-space "
                "origin still leaves a max alpha difference of "
                f"{agreement.get('worst')} because a wall run's tiles face a "
                "different way, so the projected footprint and the contact band "
                "differ. Each seat therefore publishes its own decal and the runtime "
                "draws a stack's decal at the layer-0 anchor of that seat. The "
                "measured disagreement is recorded in seatAgreement rather than "
                "assumed."
            ),
            "seats": stacks,
        },
        "matShadows": mats,
        "totals": {
            "matShadows": len(mats),
            "wallStacks": len(stacks),
            "bytes": sum(r["bytes"] for r in mats.values())
            + sum(r["bytes"] for r in stacks.values()),
        },
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    log(f"shadow bake: {len(mats)} mat shadows, {len(stacks)} stack decals -> {out_dir}")
    log(f"shadow bake: manifest {manifest_path}")
    log(f"shadow bake: seat agreement {agreement}")
    log("shadow bake: done — run scripts/bake-shadow-seams.mjs and scripts/check-shadow-assets.mjs")


if __name__ == "__main__":
    main()
