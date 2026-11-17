#!/usr/bin/env python3
"""Experiment: catch the shadow of an adjacent fan tile on a target tile.

    blender --background --python-exit-code 1 \
        --python tools/render/contact_shadow_experiment.py -- \
        --target shell_hand_slot_11 --caster shell_hand_slot_10 \
        --out tools/render/build/contact-shadow-experiment

This is a **build-only** experiment. It does not touch the committed shells,
decals or manifest.

The committed hand shells are the same eye at the row centre with the tile at
its true row offset: a shell's camera lives at ``lateralOffsetUnits`` from its
tile origin. A target/caster pair is therefore just the target at the origin,
the caster one tile width along the row (the 0.75-unit hand step), and the
target's published shell camera. The caster's committed body is the same
physical tile under the same eye, so the projected contact edge should agree
with the 2D composite.

Two lighting variants are rendered at the target's @1x and @2x framing:

* **physical** — the normal key/world rig; the caster is invisible to camera
  but still casts. The reference is the target alone. The overlay alpha is
  ``(refLuma - pairLuma) / (refLuma - inkLuma)``, so the existing source-over
  ink compositor can use it directly;
* **contact AO** — a separate emission target with a Cycles ambient-occlusion
  node (distance 0.12 units), no key and no world; the caster occludes the AO
  rays. The reference is the target alone; ``a = 1 - pairAO / refAO``.

The sheet's combined variant is ``1 - (1-physical)(1-AO)``.

Outputs (under the experiment directory):
    <pair>-physical-{1x,2x}.png   straight-alpha ink overlays, target space
    <pair>-ao-{1x,2x}.png
    <pair>-combined-{1x,2x}.png
    contact-shadow-experiment.json
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

RENDER_DIR = Path(__file__).resolve().parent
if str(RENDER_DIR) not in sys.path:
    sys.path.insert(0, str(RENDER_DIR))

from bake_shells import (  # noqa: E402
    DEFAULT_SPEC,
    aim_key,
    alpha_bbox,
    blender_args,
    build_lights,
    build_shell_camera,
    build_tile,
    build_world,
    check_blender_version,
    configure_render,
    die,
    encode_png,
    expand_hand_slots,
    hex_srgb,
    load_rgba,
    load_spec,
    log,
    new_material,
    pose_tile,
    render_pass,
    reset_scene,
    resolve_tile_dimensions,
    set_resolution,
    world_bbox_center,
)

INK = hex_srgb("#0b1418")
INK_LUMA = float(0.2126 * INK[0] + 0.7152 * INK[1] + 0.0722 * INK[2])


def shell_by_id(spec: dict, shell_id: str) -> dict:
    for shell in spec["shells"]:
        if shell["id"] == shell_id:
            return shell
    die(f"shell {shell_id} is not in the generated catalogue")
    raise AssertionError


def row_offset(shell: dict) -> float:
    slot = shell.get("handSlot")
    if not slot:
        die(f"{shell['id']} is not a hand slot; this experiment is the hand fan")
    return float(slot["offsetUnits"])


def luma(rgb: np.ndarray) -> np.ndarray:
    return (
        0.2126 * rgb[..., 0].astype(np.float64)
        + 0.7152 * rgb[..., 1].astype(np.float64)
        + 0.0722 * rgb[..., 2].astype(np.float64)
    )


def crop_box(solid, pads: dict, ledge: int = 1) -> tuple[int, int, int, int]:
    """The body texture crop for a render, exactly as bake_shell builds it."""
    x0, y0, x1, y1 = solid
    bx0 = x0 - ledge
    by0 = y0 - ledge
    bx1 = x1 + ledge
    by1 = y1 + ledge
    width = (bx1 - bx0 + 1) + pads["left"] + pads["right"]
    height = (by1 - by0 + 1) + pads["top"] + pads["bottom"]
    return bx0 - pads["left"], by0 - pads["top"], width, height


def crop_image(image: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    x, y, width, height = box
    if x < 0 or y < 0 or x + width > image.shape[1] or y + height > image.shape[0]:
        die(f"crop {box} leaves the render {image.shape[1]}x{image.shape[0]}")
    return image[y : y + height, x : x + width].copy()


def overlay_alpha(reference: np.ndarray, pair: np.ndarray) -> np.ndarray:
    """Straight-alpha source-over ink that reproduces the physical darkening."""
    ref = luma(reference[..., :3])
    pair = luma(pair[..., :3])
    denominator = np.maximum(ref - INK_LUMA, 1e-4)
    alpha = np.clip((ref - pair) / denominator, 0.0, 1.0)
    alpha[reference[..., 3] < 0.5] = 0.0
    alpha[alpha < 0.004] = 0.0
    return alpha


def ao_alpha(reference: np.ndarray, pair: np.ndarray) -> np.ndarray:
    ref = luma(reference[..., :3])
    occluded = luma(pair[..., :3])
    alpha = np.clip(1.0 - occluded / np.maximum(ref, 1e-4), 0.0, 1.0)
    alpha[reference[..., 3] < 0.5] = 0.0
    alpha[alpha < 0.004] = 0.0
    return alpha


def ink_rgba(alpha: np.ndarray) -> np.ndarray:
    rgba = np.zeros((*alpha.shape, 4), dtype=np.float32)
    rgba[..., 0] = INK[0]
    rgba[..., 1] = INK[1]
    rgba[..., 2] = INK[2]
    rgba[..., 3] = alpha
    return rgba


def quantize(rgba: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(rgba * 255.0), 0, 255).astype(np.uint8)


def build_ao_material() -> bpy.types.Material:
    """Emission = ambient occlusion; no lights, so the render is the AO factor."""
    material = new_material("contact-ao-target")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    occlusion = nodes.new("ShaderNodeAmbientOcclusion")
    occlusion.inputs["Distance"].default_value = 0.12
    occlusion.samples = 64
    occlusion.only_local = False
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 1.0
    links.new(occlusion.outputs["Color"], emission.inputs["Color"])
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def main() -> None:
    args = parse_args()
    started = time.time()
    spec = load_spec(DEFAULT_SPEC)
    expand_hand_slots(spec)
    resolve_tile_dimensions(spec)
    check_blender_version(spec)
    target_shell = shell_by_id(spec, args.target)
    caster_shell = shell_by_id(spec, args.caster)
    offset = row_offset(caster_shell) - row_offset(target_shell)
    log(
        f"pair {args.target} <- {args.caster}: row offset {offset:+.4f} world units "
        f"({offset / spec['handSlots']['stepUnits']:+.3f} slots)"
    )

    scene = reset_scene()
    configure_render(scene, spec)
    build_world(scene, spec)
    target = build_tile(scene, spec)
    caster = build_tile(scene, spec)
    lights = build_lights(scene, spec)

    pose_tile(target, target_shell)
    pose_tile(caster, caster_shell)
    caster.location.x += offset
    bpy.context.view_layer.update()

    camera, framing = build_shell_camera(scene, target, target_shell, spec)
    aim_key(lights[0], camera, world_bbox_center(target), spec)
    log(
        f"framing {framing['resolution1x'][0]}x{framing['resolution1x'][1]} @1x, "
        f"{framing['resolution2x'][0]}x{framing['resolution2x'][1]} @2x"
    )

    out_dir = (RENDER_DIR / args.out).resolve() if not Path(args.out).is_absolute() else Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    temp_dir = out_dir / "renders"
    temp_dir.mkdir(parents=True, exist_ok=True)
    pads = spec["bake"]["padding1x"]
    scale_2x = int(spec["bake"]["pixelRatio"])

    physical = {}
    ao = {}
    reference = {}

    # ---- physical key/world pass ------------------------------------------------
    for scale in (1, scale_2x):
        width = framing["resolution1x"][0] * scale
        height = framing["resolution1x"][1] * scale
        set_resolution(scene, width, height)
        caster.hide_render = True
        reference[scale] = render_to(temp_dir / f"{args.target}_{args.caster}_ref_{scale}x.png", scene)
        caster.hide_render = False
        caster.visible_camera = False
        ao_off = render_to(temp_dir / f"{args.target}_{args.caster}_physical_{scale}x.png", scene)
        physical[scale] = ao_off
        caster.visible_camera = True

    # ---- ambient-occlusion pass -------------------------------------------------
    original_material = target.data.materials[0]
    ao_material = build_ao_material()
    target.data.materials[0] = ao_material
    key = lights[0]
    key.hide_render = True
    world_strength = scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
    for scale in (1, scale_2x):
        width = framing["resolution1x"][0] * scale
        height = framing["resolution1x"][1] * scale
        set_resolution(scene, width, height)
        caster.hide_render = True
        reference_ao = render_to(temp_dir / f"{args.target}_{args.caster}_ao_ref_{scale}x.png", scene)
        caster.hide_render = False
        caster.visible_camera = False
        pair_ao = render_to(temp_dir / f"{args.target}_{args.caster}_ao_{scale}x.png", scene)
        caster.visible_camera = True
        ao[scale] = (reference_ao, pair_ao)
    target.data.materials[0] = original_material
    key.hide_render = False
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = world_strength

    # ---- crops and overlays ------------------------------------------------------
    # bake_shell derives the crop from the @1x alpha bbox and scales it for
    # @2x; the 2x alpha threshold is half a pixel tighter, so do not re-derive
    # it or the 2x overlay would drift from the committed body texture.
    solid1 = alpha_bbox(reference[1][..., 3])
    crop1 = crop_box(solid1, pads)
    crop2 = (
        crop1[0] * scale_2x,
        crop1[1] * scale_2x,
        crop1[2] * scale_2x,
        crop1[3] * scale_2x,
    )
    log(
        f"crop @1x {crop1[2]}x{crop1[3]} at {crop1[0]},{crop1[1]}; "
        f"@2x {crop2[2]}x{crop2[3]} at {crop2[0]},{crop2[1]}"
    )

    overlays = {}
    stats = {}
    for scale, crop, ref, pair in (
        (1, crop1, reference[1], physical[1]),
        (scale_2x, crop2, reference[scale_2x], physical[scale_2x]),
    ):
        phys_alpha = overlay_alpha(ref, pair)
        ao_ref, ao_pair = ao[scale]
        ao_a = ao_alpha(ao_ref, ao_pair)
        combined = 1.0 - (1.0 - phys_alpha) * (1.0 - ao_a)
        for name, alpha in (("physical", phys_alpha), ("ao", ao_a), ("combined", combined)):
            rgba = ink_rgba(alpha)
            cropped = crop_image(rgba, crop)
            path = out_dir / f"{args.target}_from_{args.caster}_{name}_{scale}x.png"
            encode_png(path, quantize(cropped))
            overlays[f"{name}_{scale}x"] = str(path.relative_to(RENDER_DIR))
        stats[f"{scale}x"] = overlay_stats(crop_image(phys_alpha, crop), crop_image(ao_a, crop), crop_image(combined, crop))

    # A strong alignment check: the reference crop should be the committed body.
    committed = json.loads((RENDER_DIR / "../../frontend/public/table/shells.json").resolve().read_text())
    shell_record = committed["shells"][args.target]
    check = {
        "targetTexWidth": shell_record["texWidth"],
        "targetTexHeight": shell_record["texHeight"],
        "referenceCropWidth": crop1[2],
        "referenceCropHeight": crop1[3],
        "referenceMatchesCommitted": reference_matches(
            reference[1], crop1, RENDER_DIR / "../../frontend/public/table" / shell_record["textureFile"]
        ),
    }

    report = {
        "generatedBy": "tools/render/contact_shadow_experiment.py",
        "experiment": "target-tile shadow catch from an adjacent hand slot",
        "target": args.target,
        "caster": args.caster,
        "rowOffsetUnits": round(offset, 6),
        "framing": framing,
        "crop1x": {"x": crop1[0], "y": crop1[1], "width": crop1[2], "height": crop1[3]},
        "crop2x": {"x": crop2[0], "y": crop2[1], "width": crop2[2], "height": crop2[3]},
        "ink": "#0b1418",
        "overlays": overlays,
        "stats": stats,
        "check": check,
        "renderSeconds": round(time.time() - started, 1),
    }
    pair_name = f"{args.target}_from_{args.caster}"
    report["pair"] = pair_name
    report_path = out_dir / f"{pair_name}.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    index_path = out_dir / "contact-shadow-experiment.json"
    index = {}
    if index_path.exists():
        try:
            index = json.loads(index_path.read_text())
        except json.JSONDecodeError:
            index = {}
    index.setdefault("pairs", {})
    index["pairs"][pair_name] = str(report_path.relative_to(RENDER_DIR))
    index["generatedBy"] = "tools/render/contact_shadow_experiment.py"
    index_path.write_text(json.dumps(index, indent=2) + "\n")
    log(f"wrote {report_path}")
    log(
        f"stats: peak physical {stats['1x']['physical']['peak']:.3f}, "
        f"AO {stats['1x']['ao']['peak']:.3f}, combined {stats['1x']['combined']['peak']:.3f}; "
        f"{report['renderSeconds']} s"
    )
    log(f"alignment: {check}")


def render_to(path: Path, scene: bpy.types.Scene) -> np.ndarray:
    render_pass(scene, path)
    return load_rgba(path)


def overlay_stats(physical: np.ndarray, ao: np.ndarray, combined: np.ndarray) -> dict:
    result = {}
    for name, alpha in (("physical", physical), ("ao", ao), ("combined", combined)):
        support = alpha > 0.004
        result[name] = {
            "peak": round(float(alpha.max()), 4),
            "mean": round(float(alpha[support].mean()) if support.any() else 0.0, 4),
            "supportPx": int(support.sum()),
            "maxRowStep": round(row_step(alpha), 4),
        }
    return result


def row_step(alpha: np.ndarray) -> float:
    """Worst visible row-to-row alpha step, the artifact this experiment targets."""
    if alpha.shape[0] < 2:
        return 0.0
    steps = np.abs(np.diff(alpha, axis=0))
    both = (alpha[1:] > 0) & (alpha[:-1] > 0)
    if not both.any():
        return 0.0
    return float(steps[both].max())


def reference_matches(reference: np.ndarray, crop: tuple[int, int, int, int], texture_path: Path) -> dict:
    try:
        committed = load_rgba(texture_path)
    except Exception as error:  # noqa: BLE001
        return {"error": str(error)}
    cropped = crop_image(reference, crop)
    if cropped.shape != committed.shape:
        return {
            "sizes": [list(cropped.shape), list(committed.shape)],
            "meanDelta": None,
            "maxDelta": None,
        }
    delta = np.abs(cropped - committed)
    return {
        "meanDelta": round(float(delta.mean()), 5),
        "maxDelta": round(float(delta.max()), 5),
        "alphaMeanDelta": round(float(np.abs(cropped[..., 3] - committed[..., 3]).mean()), 5),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default="shell_hand_slot_11")
    parser.add_argument("--caster", default="shell_hand_slot_10")
    parser.add_argument("--out", default="build/contact-shadow-experiment")
    return parser.parse_args(blender_args(sys.argv))


if __name__ == "__main__":
    main()
