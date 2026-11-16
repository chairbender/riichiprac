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
    expand_top_hand_slots,
    load_rgba,
    load_spec,
    log,
    pose_tile,
    project_pixels,
    projected_bbox,
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
    shell_by_id,
)

JOBS = []


def add_row_jobs(prefix: str) -> None:
    """The 12 covered slots of a 13-slot fan, caster one slot inward."""
    for index in range(13):
        if index == 6:
            continue
        caster = index + 1 if index < 6 else index - 1
        JOBS.append(
            {
                "target": f"{prefix}{index:02d}",
                "caster": f"{prefix}{caster:02d}",
                "offset": None,
            }
        )


add_row_jobs("shell_hand_slot_")
add_row_jobs("shell_hand_top_slot_")
# The side hands reuse one shell down a row. The caster is the next tile
# towards the viewer; the row runs along world Y. The sign is verified against
# the committed gridStepPx in the loop.
JOBS.append({"target": "shell_hand_side_left", "caster": "shell_hand_side_left", "offset": [0.0, -0.75, 0.0]})
JOBS.append({"target": "shell_hand_side_right", "caster": "shell_hand_side_right", "offset": [0.0, -0.75, 0.0]})


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    args = parse_args()
    started = time.time()
    spec = load_spec(DEFAULT_SPEC)
    expand_hand_slots(spec)
    expand_top_hand_slots(spec)
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

    fixture = json.loads((RENDER_DIR / "overlay-zones.json").read_text())
    fixture_zones = {zone["id"]: zone for zone in fixture["zones"]}

    catches = {}
    selected = [job for job in JOBS if not args.only or job["target"] in args.only]
    if args.only:
        log(f"development bake: only {[job['target'] for job in selected]}")
    for job in selected:
        target_id = job["target"]
        caster_id = job["caster"]
        pair_started = time.time()
        target_shell = shell_by_id(spec, target_id)
        caster_shell = shell_by_id(spec, caster_id)
        pose_tile(target, target_shell)
        pose_tile(caster, caster_shell)
        if job["offset"] is None:
            target_slot = target_shell.get("handSlot") or target_shell.get("topHandSlot")
            caster_slot = caster_shell.get("handSlot") or caster_shell.get("topHandSlot")
            if not target_slot or not caster_slot:
                die(f"{target_id}/{caster_id}: no fan slot metadata")
            offset = [
                float(caster_slot["offsetUnits"]) - float(target_slot["offsetUnits"]),
                0.0,
                0.0,
            ]
        else:
            offset = list(job["offset"])
        caster.location.x += offset[0]
        caster.location.y += offset[1]
        caster.location.z += offset[2]
        bpy.context.view_layer.update()

        camera, framing = build_shell_camera(scene, target, target_shell, spec)
        aim_key(key, camera, world_bbox_center(target), spec)
        if target_id.startswith("shell_hand_side_"):
            # Verify that the chosen row direction projects the caster down the
            # screen like the committed gridStepPx; flip it if the camera basis
            # says otherwise.
            set_resolution(scene, framing["resolution1x"][0], framing["resolution1x"][1])
            projected = project_pixels(
                scene,
                camera,
                [world_bbox_center(target), world_bbox_center(caster)],
            )
            step = (
                projected[1][0] - projected[0][0],
                projected[1][1] - projected[0][1],
            )
            expected = committed[target_id]["gridStepPx"]["x"]
            log(f"{target_id}: side-hand projected step {step}, committed step {expected}")
            if (step[1] >= 0) != (expected[1] >= 0):
                caster.location.y -= 2.0 * offset[1]
                offset[1] = -offset[1]
                bpy.context.view_layer.update()
                log(f"{target_id}: flipped the side-hand row sign to {offset[1]:+0.2f}")
        pair_tag = f"{target_id}_from_{caster_id}"
        log(
            f"{pair_tag}: offset {offset[0]:+.4f},{offset[1]:+.4f},{offset[2]:+.4f}, "
            f"{framing['resolution1x'][0]}x{framing['resolution1x'][1]} @1x"
        )
        if args.probe:
            if target_id.startswith("shell_hand_top_slot_"):
                zone_id = "hand-top"
            elif target_id.startswith("shell_hand_side_left"):
                zone_id = "hand-left"
            elif target_id.startswith("shell_hand_side_right"):
                zone_id = "hand-right"
            else:
                zone_id = "hand-bottom"
            zone = fixture_zones[zone_id]
            if target_id.startswith("shell_hand_side_"):
                layout_target = zone["bodies"][5]
                layout_caster = zone["bodies"][6]
            else:
                layout_target = next(body for body in zone["bodies"] if body["shell"] == target_id)
                layout_caster = next(body for body in zone["bodies"] if body["shell"] == caster_id)
            set_resolution(scene, framing["resolution1x"][0], framing["resolution1x"][1])
            projected_target = projected_bbox(scene, camera, target)
            projected_caster = projected_bbox(scene, camera, caster)
            layout_target_left = layout_target["drawX"] + 2
            layout_caster_left = layout_caster["drawX"] + 2
            offset_px = projected_target[0] - layout_target_left
            expected_left = layout_caster_left + offset_px
            expected_right = expected_left + committed[caster_id]["advanceWidth"]
            log(
                f"PROBE {pair_tag}: projected caster L/R "
                f"{projected_caster[0]:.2f}/{projected_caster[2]:.2f}, "
                f"layout caster L/R {expected_left:.2f}/{expected_right:.2f}, "
                f"ΔL {projected_caster[0] - expected_left:+.2f} "
                f"ΔR {projected_caster[2] - expected_right:+.2f}"
            )
            bpy.data.objects.remove(camera, do_unlink=True)
            continue

        physical = {}
        ao = {}
        reference = {}
        set_resolution(scene, framing["resolution1x"][0], framing["resolution1x"][1])
        caster.hide_render = True
        caster.visible_camera = True
        reference[1] = render_to(args.out, pair_tag, "ref", 1, scene)
        solid1 = alpha_bbox(reference[1][..., 3])
        crop1 = crop_box(solid1, pads)
        target_record = committed[target_id]
        if (crop1[2], crop1[3]) != (target_record["texWidth"], target_record["texHeight"]):
            die(
                f"{pair_tag}: crop {crop1[2]}x{crop1[3]} is not the target texture "
                f"{target_record['texWidth']}x{target_record['texHeight']}"
            )

        # The committed caster sprite is normalised for its own camera; under
        # this target camera its projected contact edge can sit inside the drawn
        # body, leaving an unshadowed sliver on the target's visible side. Move
        # the (hidden) caster so its contact edge lands on the drawn caster edge.
        if target_id.startswith("shell_hand_top_slot_"):
            zone_id = "hand-top"
        elif target_id.startswith("shell_hand_side_left"):
            zone_id = "hand-left"
        elif target_id.startswith("shell_hand_side_right"):
            zone_id = "hand-right"
        else:
            zone_id = "hand-bottom"
        zone = fixture_zones[zone_id]
        side_job = target_id.startswith("shell_hand_side_")
        if side_job:
            # The side row reuses one shell, so the zone has 13 identical
            # shells; use a representative adjacent pair for the row step.
            layout_target = zone["bodies"][5]
            layout_caster = zone["bodies"][6]
        else:
            layout_target = next(body for body in zone["bodies"] if body["shell"] == target_id)
            layout_caster = next(body for body in zone["bodies"] if body["shell"] == caster_id)
        contact = "up" if side_job else ("right" if layout_caster["drawX"] < layout_target["drawX"] else "left")
        for iteration in range(3):
            projected = projected_bbox(scene, camera, caster)
            if contact == "up":
                expected = crop1[1] + (layout_caster["drawY"] + 2 - layout_target["drawY"])
                delta = projected[1] - expected
                ppu = max(1.0, abs(layout_caster["drawY"] - layout_target["drawY"]) / 0.75)
                caster.location.y += delta / ppu
            else:
                edge = layout_caster["drawX"] + 2 + (
                    committed[caster_id]["advanceWidth"] if contact == "right" else 0
                )
                expected = crop1[0] + (edge - layout_target["drawX"])
                projected_edge = projected[2] if contact == "right" else projected[0]
                delta = projected_edge - expected
                ppu = max(1.0, abs(layout_caster["drawX"] - layout_target["drawX"]) / 0.75)
                caster.location.x += (expected - projected_edge) / ppu
            bpy.context.view_layer.update()
            log(
                f"{pair_tag}: caster align {contact} iter {iteration}: "
                f"Δ {delta:+.3f} px"
            )
            if abs(delta) < 0.15:
                break

        caster.hide_render = False
        caster.visible_camera = False
        physical[1] = render_to(args.out, pair_tag, "physical", 1, scene)
        caster.visible_camera = True
        set_resolution(scene, framing["resolution1x"][0] * scale_2x, framing["resolution1x"][1] * scale_2x)
        caster.hide_render = True
        reference[scale_2x] = render_to(args.out, pair_tag, "ref", scale_2x, scene)
        caster.hide_render = False
        caster.visible_camera = False
        physical[scale_2x] = render_to(args.out, pair_tag, "physical", scale_2x, scene)
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

        crop2 = (
            crop1[0] * scale_2x,
            crop1[1] * scale_2x,
            crop1[2] * scale_2x,
            crop1[3] * scale_2x,
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
    parser.add_argument("--only", action="append", default=[], help="development: bake one target")
    parser.add_argument("--probe", action="store_true", help="development: log caster alignment, no renders")
    return parser.parse_args(blender_args(sys.argv))


if __name__ == "__main__":
    main()
