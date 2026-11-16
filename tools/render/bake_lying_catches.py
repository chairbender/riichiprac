#!/usr/bin/env python3
"""Produce the lying-family (pond/meld) target-space 3D catches.

    blender --background --python-exit-code 1 \
        --python tools/render/bake_lying_catches.py

Reads tools/render/build/lying-catch-jobs.json (from
`frontend/scripts/export-lying-catches.ts`), renders each target with its
primary casters, aligns the hidden casters to the drawn sprites, and writes the
committed combined physical + contact-AO overlays:

    frontend/public/table/overlays/lying/<id>.png
    frontend/public/table/overlays/lying/2x/<id>.png
    build/lying-catches.json   (fragment for commit-lying-catches.mjs)
"""
from __future__ import annotations

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
    expand_wall_slots,
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
    shell_by_id,
)
from contact_shadow_lying_samples import align_caster  # noqa: E402

JOBS_PATH = RENDER_DIR / "build/lying-catch-jobs.json"
OUT_DIR = RENDER_DIR / "build/lying-catches"
TABLE_DIR = (RENDER_DIR / "../../frontend/public/table").resolve()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    started = time.time()
    spec = load_spec(DEFAULT_SPEC)
    expand_hand_slots(spec)
    expand_top_hand_slots(spec)
    expand_wall_slots(spec)
    resolve_tile_dimensions(spec)
    check_blender_version(spec)
    jobs = json.loads(JOBS_PATH.read_text())["jobs"]
    committed = json.loads((TABLE_DIR / "shells.json").read_text())["shells"]
    pads = spec["bake"]["padding1x"]
    scale_2x = int(spec["bake"]["pixelRatio"])
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for sub in ("", "2x"):
        (TABLE_DIR / "overlays/lying" / sub).mkdir(parents=True, exist_ok=True)

    scene = reset_scene()
    configure_render(scene, spec)
    build_world(scene, spec)
    lights = build_lights(scene, spec)
    key = lights[0]

    records = {}
    for job in jobs:
        job_started = time.time()
        target_shell_spec = shell_by_id(spec, job["target"])
        target = build_tile(scene, spec)
        pose_tile(target, target_shell_spec)
        casters = []
        caster_records = []
        for caster_entry in job["casters"]:
            caster_shell_spec = shell_by_id(spec, caster_entry["shell"])
            caster = build_tile(scene, spec)
            pose_tile(caster, caster_shell_spec)
            offset = caster_entry["offset3D"]
            caster.location.x += offset[0]
            caster.location.y += offset[1]
            caster.location.z += offset[2]
            casters.append(caster)
            caster_records.append((caster, caster_entry, caster_shell_spec))
        bpy.context.view_layer.update()

        camera, framing = build_shell_camera(scene, target, target_shell_spec, spec)
        aim_key(key, camera, world_bbox_center(target), spec)
        target_draw = job["targetDraw"]
        for caster, caster_entry, _ in caster_records:
            caster_entry["_target_draw"] = target_draw
            caster_entry["contact"] = caster_entry["side"]

        for caster in casters:
            caster.hide_render = True
            caster.visible_camera = True
        set_resolution(scene, framing["resolution1x"][0], framing["resolution1x"][1])
        ref_path = OUT_DIR / "renders" / f"{job['id']}_ref_1x.png"
        ref_path.parent.mkdir(parents=True, exist_ok=True)
        scene.render.filepath = str(ref_path)
        bpy.ops.render.render(write_still=True)
        reference_1x = load_rgba(ref_path)
        solid = alpha_bbox(reference_1x[..., 3])
        crop = crop_box(solid, pads)
        target_record = committed[job["target"]]
        if (crop[2], crop[3]) != (target_record["texWidth"], target_record["texHeight"]):
            die(
                f"{job['id']}: crop {crop[2]}x{crop[3]} is not target texture "
                f"{target_record['texWidth']}x{target_record['texHeight']}"
            )
        for caster, caster_entry, caster_shell_spec in caster_records:
            align_caster(
                scene, camera, caster, caster_entry, target, target_shell_spec,
                caster_shell_spec, committed[caster_entry["shell"]], crop, pads, job["kind"],
            )

        physical = {}
        reference = {}
        for scale in (1, scale_2x):
            set_resolution(
                scene,
                framing["resolution1x"][0] * scale,
                framing["resolution1x"][1] * scale,
            )
            for caster in casters:
                caster.hide_render = True
                caster.visible_camera = True
            ref_path = OUT_DIR / "renders" / f"{job['id']}_ref_{scale}x.png"
            scene.render.filepath = str(ref_path)
            bpy.ops.render.render(write_still=True)
            reference[scale] = load_rgba(ref_path)
            for caster in casters:
                caster.hide_render = False
                caster.visible_camera = False
            pair_path = OUT_DIR / "renders" / f"{job['id']}_physical_{scale}x.png"
            scene.render.filepath = str(pair_path)
            bpy.ops.render.render(write_still=True)
            physical[scale] = load_rgba(pair_path)
            for caster in casters:
                caster.visible_camera = True

        original_material = target.data.materials[0]
        ao_material = build_ao_material()
        target.data.materials[0] = ao_material
        key.hide_render = True
        world_strength = scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value
        scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
        ao = {}
        for scale in (1, scale_2x):
            set_resolution(
                scene,
                framing["resolution1x"][0] * scale,
                framing["resolution1x"][1] * scale,
            )
            for caster in casters:
                caster.hide_render = True
                caster.visible_camera = True
            ref_path = OUT_DIR / "renders" / f"{job['id']}_ao_ref_{scale}x.png"
            scene.render.filepath = str(ref_path)
            bpy.ops.render.render(write_still=True)
            ao_ref = load_rgba(ref_path)
            for caster in casters:
                caster.hide_render = False
                caster.visible_camera = False
            pair_path = OUT_DIR / "renders" / f"{job['id']}_ao_{scale}x.png"
            scene.render.filepath = str(pair_path)
            bpy.ops.render.render(write_still=True)
            ao_pair = load_rgba(pair_path)
            for caster in casters:
                caster.visible_camera = True
            ao[scale] = (ao_ref, ao_pair)
        target.data.materials[0] = original_material
        key.hide_render = False
        scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = world_strength

        crop2 = (crop[0] * scale_2x, crop[1] * scale_2x, crop[2] * scale_2x, crop[3] * scale_2x)
        alignment = reference_matches(reference[1], crop, TABLE_DIR / target_record["textureFile"])
        if alignment.get("meanDelta") != 0 or alignment.get("maxDelta") != 0:
            die(f"{job['id']}: target reference does not match the committed body: {alignment}")
        body_alpha = {
            1: load_rgba(TABLE_DIR / target_record["textureFile"])[..., 3],
            scale_2x: load_rgba(TABLE_DIR / target_record["textureFile2x"])[..., 3],
        }
        assets = {}
        for scale, box, ref, pair in (
            (1, crop, reference[1], physical[1]),
            (scale_2x, crop2, reference[scale_2x], physical[scale_2x]),
        ):
            phys = overlay_alpha(ref, pair)
            ao_ref, ao_pair = ao[scale]
            contact = ao_alpha(ao_ref, ao_pair)
            combined = 1.0 - (1.0 - phys) * (1.0 - contact)
            combined_crop = crop_image(combined, box)
            combined_crop[body_alpha[scale] < 0.5] = 0.0
            rgba = quantize(ink_rgba(combined_crop))
            name = f"{job['id']}.png" if scale == 1 else f"2x/{job['id']}.png"
            path = TABLE_DIR / "overlays/lying" / name
            data = encode_png(path, rgba)
            assets[scale] = {"path": path, "data": data, "rgba": rgba, "alpha": combined_crop}

        support = assets[1]["alpha"] > 0.004
        records[job["signature"]] = {
            "id": job["id"],
            "target": job["target"],
            "zoneSide": job["zoneSide"],
            "signature": job["signature"],
            "casters": [
                {
                    "shell": c["shell"],
                    "side": c["side"],
                    "dx": c["draw"][0] - target_draw[0],
                    "dy": c["draw"][1] - target_draw[1],
                }
                for c in job["casters"]
            ],
            "textureFile": f"overlays/lying/{job['id']}.png",
            "textureFile2x": f"overlays/lying/2x/{job['id']}.png",
            "texWidth": crop[2],
            "texHeight": crop[3],
            "peakAlpha": round(float(assets[1]["alpha"].max()), 4),
            "meanAlpha": round(float(assets[1]["alpha"][support].mean()) if support.any() else 0.0, 4),
            "supportPx": int(support.sum()),
            "sha256": {
                "decodedRgba1x": sha256(assets[1]["rgba"].tobytes()),
                "decodedRgba2x": sha256(assets[scale_2x]["rgba"].tobytes()),
            },
            "bytes1x": len(assets[1]["data"]),
            "bytes2x": len(assets[scale_2x]["data"]),
        }
        log(
            f"{job['id']} {job['target']} {job['zoneSide']} peak "
            f"{records[job['signature']]['peakAlpha']:.3f} "
            f"mean {records[job['signature']]['meanAlpha']:.3f} "
            f"{round(time.time() - job_started, 1)} s"
        )
        for caster in casters:
            bpy.data.objects.remove(caster, do_unlink=True)
        bpy.data.objects.remove(target, do_unlink=True)
        bpy.data.objects.remove(camera, do_unlink=True)

    fragment = {
        "version": 1,
        "generatedBy": "tools/render/bake_lying_catches.py",
        "model": "target-space-3d-catch",
        "combination": "physical+ao",
        "catches": records,
    }
    fragment_path = OUT_DIR / "lying-catches.json"
    fragment_path.write_text(json.dumps(fragment, indent=2) + "\n")
    log(f"wrote {fragment_path}, {len(records)} catches, {time.time() - started:.1f} s")


if __name__ == "__main__":
    main()
