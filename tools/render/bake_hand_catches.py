#!/usr/bin/env python3
"""Bake the production target-space 3D contact catches for the human hand.

    blender --background --python-exit-code 1 \
        --python tools/render/bake_hand_catches.py -- \
        --out build/hand-catches

This is the production form of ``contact_shadow_experiment.py``. For every
covered hand slot it renders the target with its adjacent caster at the
published target camera, captures the physical key/world shadow and a contact
AO term, combines them, and writes a **target-space** overlay at the target
shell's texture size/anchor:

    frontend/public/table/overlays/catches/<target>_from_<caster>.png
    frontend/public/table/overlays/catches/2x/<target>_from_<caster>.png

The fragment at ``build/hand-catches.json`` is turned into the committed
``frontend/public/table/catches.json`` by
``tools/render/scripts/commit-catches.mjs``.

Each pair's target reference crop is compared with the committed target body;
it must be byte-identical, otherwise the pair scene/camera/crop is wrong and the
bake fails.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import bpy
import numpy as np

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
    load_rgba,
    load_spec,
    log,
    pose_tile,
    reset_scene,
    resolve_tile_dimensions,
    set_resolution,
    world_bbox_center,
)
from contact_shadow_experiment import (  # noqa: E402
    ao_alpha,
    build_ao_material,
    crop_box,
    crop_image,
    ink_rgba,
    overlay_alpha,
    quantize,
    reference_matches,
    row_offset,
    shell_by_id,
)

PAIRS = [
    ("shell_hand_slot_00", "shell_hand_slot_01"),
    ("shell_hand_slot_01", "shell_hand_slot_02"),
    ("shell_hand_slot_02", "shell_hand_slot_03"),
    ("shell_hand_slot_03", "shell_hand_slot_04"),
    ("shell_hand_slot_04", "shell_hand_slot_05"),
    ("shell_hand_slot_05", "shell_hand_slot_06"),
    ("shell_hand_slot_07", "shell_hand_slot_06"),
    ("shell_hand_slot_08", "shell_hand_slot_07"),
    ("shell_hand_slot_09", "shell_hand_slot_08"),
    ("shell_hand_slot_10", "shell_hand_slot_09"),
    ("shell_hand_slot_11", "shell_hand_slot_10"),
    ("shell_hand_slot_12", "shell_hand_slot_11"),
]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    args = parse_args()
    started = time.time()
    spec = load_spec(DEFAULT_SPEC)
    expand_hand_slots(spec)
    resolve_tile_dimensions(spec)
    check_blender_version(spec)
    committed = json.loads(
        (RENDER_DIR / "../../frontend/public/table/shells.json").resolve().read_text()
    )["shells"]
    table_dir = (RENDER_DIR / "../../frontend/public/table").resolve()

    scene = reset_scene()
    configure_render(scene, spec)
    build_world(scene, spec)
    target = build_tile(scene, spec)
    caster = build_tile(scene, spec)
    lights = build_lights(scene, spec)
    key = lights[0]
    pads = spec["bake"]["padding1x"]
    scale_2x = int(spec["bake"]["pixelRatio"])
    ao_material = build_ao_material()

    catches = {}
    for target_id, caster_id in PAIRS:
        pair_started = time.time()
        target_shell = shell_by_id(spec, target_id)
        caster_shell = shell_by_id(spec, caster_id)
        offset = row_offset(caster_shell) - row_offset(target_shell)
        pose_tile(target, target_shell)
        pose_tile(caster, caster_shell)
        caster.location.x += offset
        bpy.context.view_layer.update()

        camera, framing = build_shell_camera(scene, target, target_shell, spec)
        aim_key(key, camera, world_bbox_center(target), spec)
        pair_tag = f"{target_id}_from_{caster_id}"
        log(
            f"{pair_tag}: offset {offset:+.4f}, "
            f"{framing['resolution1x'][0]}x{framing['resolution1x'][1]} @1x"
        )

        physical = {}
        ao = {}
        reference = {}
        for scale in (1, scale_2x):
            set_resolution(
                scene,
                framing["resolution1x"][0] * scale,
                framing["resolution1x"][1] * scale,
            )
            caster.hide_render = True
            caster.visible_camera = True
            reference[scale] = render_to(args.out, pair_tag, "ref", scale, scene)
            caster.hide_render = False
            caster.visible_camera = False
            physical[scale] = render_to(args.out, pair_tag, "physical", scale, scene)
            caster.visible_camera = True

        original_material = target.data.materials[0]
        target.data.materials[0] = ao_material
        key.hide_render = True
        world_strength = scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value
        scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
        for scale in (1, scale_2x):
            set_resolution(
                scene,
                framing["resolution1x"][0] * scale,
                framing["resolution1x"][1] * scale,
            )
            caster.hide_render = True
            caster.visible_camera = True
            ao_ref = render_to(args.out, pair_tag, "ao_ref", scale, scene)
            caster.hide_render = False
            caster.visible_camera = False
            ao_pair = render_to(args.out, pair_tag, "ao", scale, scene)
            caster.visible_camera = True
            ao[scale] = (ao_ref, ao_pair)
        target.data.materials[0] = original_material
        key.hide_render = False
        scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = world_strength

        solid1 = alpha_bbox(reference[1][..., 3])
        crop1 = crop_box(solid1, pads)
        crop2 = (
            crop1[0] * scale_2x,
            crop1[1] * scale_2x,
            crop1[2] * scale_2x,
            crop1[3] * scale_2x,
        )
        target_record = committed[target_id]
        if (crop1[2], crop1[3]) != (target_record["texWidth"], target_record["texHeight"]):
            die(
                f"{pair_tag}: crop {crop1[2]}x{crop1[3]} is not the target texture "
                f"{target_record['texWidth']}x{target_record['texHeight']}"
            )
        alignment = reference_matches(
            reference[1],
            crop1,
            table_dir / target_record["textureFile"],
        )
        if alignment.get("meanDelta") != 0 or alignment.get("maxDelta") != 0:
            die(f"{pair_tag}: target reference does not match the committed body: {alignment}")

        body_alpha = {
            1: load_rgba(table_dir / target_record["textureFile"])[..., 3],
            scale_2x: load_rgba(table_dir / target_record["textureFile2x"])[..., 3],
        }
        assets = {}
        for scale, crop, ref, pair in (
            (1, crop1, reference[1], physical[1]),
            (scale_2x, crop2, reference[scale_2x], physical[scale_2x]),
        ):
            phys = overlay_alpha(ref, pair)
            ao_ref, ao_pair = ao[scale]
            contact = ao_alpha(ao_ref, ao_pair)
            combined = 1.0 - (1.0 - phys) * (1.0 - contact)
            # The catch is drawn on the target body; the committed body's
            # alpha is the authority, so the antialiased edge cannot leak.
            combined_crop = crop_image(combined, crop)
            combined_crop[body_alpha[scale] < 0.5] = 0.0
            rgba = ink_rgba(combined_crop)
            quantized = quantize(rgba)
            name = f"{pair_tag}.png" if scale == 1 else f"2x/{pair_tag}.png"
            path = table_dir / "overlays" / "catches" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            data = encode_png(path, quantized)
            assets[scale] = {
                "path": path,
                "data": data,
                "rgba": quantized,
                "alpha": combined_crop,
            }

        support = assets[1]["alpha"] > 0.004
        catches[f"{target_id}:{caster_id}"] = {
            "target": target_id,
            "caster": caster_id,
            "textureFile": f"overlays/catches/{pair_tag}.png",
            "textureFile2x": f"overlays/catches/2x/{pair_tag}.png",
            "texWidth": crop1[2],
            "texHeight": crop1[3],
            "peakAlpha": round(float(assets[1]["alpha"].max()), 4),
            "meanAlpha": round(float(assets[1]["alpha"][support].mean()) if support.any() else 0.0, 4),
            "supportPx": int(support.sum()),
            "sha256": {
                "decodedRgba1x": sha256(assets[1]["rgba"].tobytes()),
                "decodedRgba2x": sha256(assets[scale_2x]["rgba"].tobytes()),
            },
            "bytes1x": len(assets[1]["data"]),
            "bytes2x": len(assets[scale_2x]["data"]),
            "reference": alignment,
            "renderSeconds": round(time.time() - pair_started, 1),
        }
        log(
            f"{pair_tag}: peak {catches[f'{target_id}:{caster_id}']['peakAlpha']:.3f}, "
            f"mean {catches[f'{target_id}:{caster_id}']['meanAlpha']:.3f}, "
            f"{catches[f'{target_id}:{caster_id}']['renderSeconds']} s"
        )
        bpy.data.objects.remove(camera, do_unlink=True)

    out = (RENDER_DIR / args.out).resolve() if not Path(args.out).is_absolute() else Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    fragment = {
        "version": 1,
        "generatedBy": "tools/render/bake_hand_catches.py",
        "model": "target-space-3d-catch",
        "combination": "physical+ao",
        "catches": catches,
    }
    fragment_path = out / "hand-catches.json"
    fragment_path.write_text(json.dumps(fragment, indent=2) + "\n")
    log(f"wrote {fragment_path}")
    log(f"total {len(catches)} catches in {time.time() - started:.1f} s")


def render_to(out: str, pair_tag: str, tag: str, scale: int, scene: bpy.types.Scene) -> np.ndarray:
    base = Path(out)
    if not base.is_absolute():
        base = RENDER_DIR / base
    path = base / "renders" / f"{pair_tag}_{tag}_{scale}x.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    return load_rgba(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="build/hand-catches")
    return parser.parse_args(blender_args(sys.argv))


if __name__ == "__main__":
    main()
