#!/usr/bin/env python3
"""Build-only catch samples for the lying families (pond + front wall).

    blender --background --python-exit-code 1 \
        --python tools/render/contact_shadow_lying_samples.py

Reads ``tools/render/build/lying-samples.json`` (from
``frontend/scripts/export-lying-samples.ts``), places the target tile at the
origin and each adjacent caster at its 3D cell offset, aligns each hidden
caster's contact edge to the committed drawn sprite, and writes physical,
contact-AO and combined target-space overlays plus a report under
``tools/render/build/lying-samples/``. Nothing here is committed.
"""
from __future__ import annotations

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

SAMPLES_PATH = RENDER_DIR / "build/lying-samples.json"
OUT_DIR = RENDER_DIR / "build/lying-samples"
TABLE_DIR = (RENDER_DIR / "../../frontend/public/table").resolve()


def projected_center(image: np.ndarray) -> tuple[float, float]:
    return ((image[0] + image[2]) * 0.5, (image[1] + image[3]) * 0.5)


def solve_edge(scene, camera, caster, axis: int, edge: int, expected: float, label: str) -> None:
    """Move one caster along a world axis until a bbox edge reaches expected."""
    eps = 0.02
    for _ in range(3):
        before = projected_bbox(scene, camera, caster)[edge]
        delta = before - expected
        if abs(delta) < 0.12:
            log(f"{label}: aligned at Δ {delta:+.2f} px")
            return
        original = list(caster.location)
        caster.location[axis] += eps
        bpy.context.view_layer.update()
        after = projected_bbox(scene, camera, caster)[edge]
        caster.location = original
        bpy.context.view_layer.update()
        slope = (after - before) / eps
        if abs(slope) < 1e-6:
            die(f"{label}: no projection response on axis {axis}")
        caster.location[axis] -= delta / slope
        bpy.context.view_layer.update()
        log(f"{label}: Δ {delta:+.2f} px -> moved")


def solve_center(scene, camera, caster, axis: int, expected: float, label: str) -> None:
    eps = 0.02
    for _ in range(3):
        before = projected_center(projected_bbox(scene, camera, caster))
        delta = before[0] - expected
        if abs(delta) < 0.12:
            log(f"{label}: centre aligned at Δ {delta:+.2f} px")
            return
        original = list(caster.location)
        caster.location[axis] += eps
        bpy.context.view_layer.update()
        after = projected_center(projected_bbox(scene, camera, caster))
        caster.location = original
        bpy.context.view_layer.update()
        slope = (after[0] - before[0]) / eps
        if abs(slope) < 1e-6:
            die(f"{label}: no centre projection response on axis {axis}")
        caster.location[axis] -= delta / slope
        bpy.context.view_layer.update()
        log(f"{label}: centre Δ {delta:+.2f} px -> moved")


def solve_center_y(scene, camera, caster, axis: int, expected: float, label: str) -> None:
    eps = 0.02
    for _ in range(3):
        before = projected_center(projected_bbox(scene, camera, caster))
        delta = before[1] - expected
        if abs(delta) < 0.12:
            log(f"{label}: centre-Y aligned at Δ {delta:+.2f} px")
            return
        original = list(caster.location)
        caster.location[axis] += eps
        bpy.context.view_layer.update()
        after = projected_center(projected_bbox(scene, camera, caster))
        caster.location = original
        bpy.context.view_layer.update()
        slope = (after[1] - before[1]) / eps
        if abs(slope) < 1e-6:
            die(f"{label}: no centre-Y projection response on axis {axis}")
        caster.location[axis] -= delta / slope
        bpy.context.view_layer.update()
        log(f"{label}: centre-Y Δ {delta:+.2f} px -> moved")


def align_caster(scene, camera, caster, entry, target, target_shell, caster_shell, caster_record, crop, padding, kind: str) -> None:
    contact = entry["contact"]
    caster_draw = entry["draw"]
    target_draw = entry["_target_draw"]
    advance_w = caster_record["advanceWidth"]
    advance_h = caster_record["advanceHeight"]
    if contact == "up":
        expected = crop[1] + (caster_draw[1] + 2 - target_draw[1])
        solve_edge(scene, camera, caster, 1, 1, expected, f"{entry['shell']}:up")
        expected_cx = crop[0] + (caster_draw[0] + 2 + advance_w * 0.5 - target_draw[0])
        solve_center(scene, camera, caster, 0, expected_cx, f"{entry['shell']}:cx")
    elif contact == "down":
        expected = crop[1] + (caster_draw[1] + 2 + advance_h - target_draw[1])
        solve_edge(scene, camera, caster, 2, 3, expected, f"{entry['shell']}:down")
        expected_cx = crop[0] + (caster_draw[0] + 2 + advance_w * 0.5 - target_draw[0])
        solve_center(scene, camera, caster, 0, expected_cx, f"{entry['shell']}:cx")
    else:
        if contact == "right":
            expected = crop[0] + (caster_draw[0] + 2 + advance_w - target_draw[0])
            solve_edge(scene, camera, caster, 0, 2, expected, f"{entry['shell']}:right")
            expected_cy = crop[1] + (caster_draw[1] + 2 + advance_h * 0.5 - target_draw[1])
            if kind == "wall":
                solve_center_y(scene, camera, caster, 2, expected_cy, f"{entry['shell']}:cy-z")
            else:
                solve_center_y(scene, camera, caster, 1, expected_cy, f"{entry['shell']}:cy-y")
        else:
            expected = crop[0] + (caster_draw[0] + 2 - target_draw[0])
            solve_edge(scene, camera, caster, 0, 0, expected, f"{entry['shell']}:left")
            expected_cy = crop[1] + (caster_draw[1] + 2 + advance_h * 0.5 - target_draw[1])
            if kind == "wall":
                solve_center_y(scene, camera, caster, 2, expected_cy, f"{entry['shell']}:cy-z")
            else:
                solve_center_y(scene, camera, caster, 1, expected_cy, f"{entry['shell']}:cy-y")


def main() -> None:
    started = time.time()
    spec = load_spec(DEFAULT_SPEC)
    expand_hand_slots(spec)
    expand_top_hand_slots(spec)
    expand_wall_slots(spec)
    resolve_tile_dimensions(spec)
    check_blender_version(spec)
    samples = json.loads(SAMPLES_PATH.read_text())["samples"]
    committed = json.loads((TABLE_DIR / "shells.json").read_text())["shells"]
    pads = spec["bake"]["padding1x"]
    scale_2x = int(spec["bake"]["pixelRatio"])
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    scene = reset_scene()
    configure_render(scene, spec)
    build_world(scene, spec)
    lights = build_lights(scene, spec)
    key = lights[0]

    report = {"generatedBy": "tools/render/contact_shadow_lying_samples.py", "samples": []}
    for entry in samples:
        sample_started = time.time()
        target_shell_spec = shell_by_id(spec, entry["target"]["shell"])
        target = build_tile(scene, spec)
        pose_tile(target, target_shell_spec)
        casters = []
        caster_records = []
        for caster_entry in entry["casters"]:
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
        sample_id = entry["id"]
        log(f"{sample_id}: framing {framing['resolution1x']} @1x")

        for caster in casters:
            caster.hide_render = True
            caster.visible_camera = True
        set_resolution(scene, framing["resolution1x"][0], framing["resolution1x"][1])
        reference_1x_path = OUT_DIR / "renders" / f"{sample_id}_ref_1x.png"
        reference_1x_path.parent.mkdir(parents=True, exist_ok=True)
        scene.render.filepath = str(reference_1x_path)
        bpy.ops.render.render(write_still=True)
        reference_1x = load_rgba(reference_1x_path)
        solid = alpha_bbox(reference_1x[..., 3])
        crop = crop_box(solid, pads)
        target_record = committed[entry["target"]["shell"]]
        if (crop[2], crop[3]) != (target_record["texWidth"], target_record["texHeight"]):
            die(
                f"{sample_id}: crop {crop[2]}x{crop[3]} is not target texture "
                f"{target_record['texWidth']}x{target_record['texHeight']}"
            )
        for caster, caster_entry, caster_shell_spec in caster_records:
            caster_entry["_target_draw"] = entry["target"]["draw"]
            align_caster(
                scene, camera, caster, caster_entry, target, target_shell_spec,
                caster_shell_spec, committed[caster_entry["shell"]], crop, pads, entry["kind"],
            )

        # physical reference + pair at 1x and 2x
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
            ref_path = OUT_DIR / "renders" / f"{sample_id}_ref_{scale}x.png"
            scene.render.filepath = str(ref_path)
            bpy.ops.render.render(write_still=True)
            reference[scale] = load_rgba(ref_path)
            for caster in casters:
                caster.hide_render = False
                caster.visible_camera = False
            pair_path = OUT_DIR / "renders" / f"{sample_id}_physical_{scale}x.png"
            scene.render.filepath = str(pair_path)
            bpy.ops.render.render(write_still=True)
            physical[scale] = load_rgba(pair_path)
            for caster in casters:
                caster.visible_camera = True

        # contact AO
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
            ref_path = OUT_DIR / "renders" / f"{sample_id}_ao_ref_{scale}x.png"
            scene.render.filepath = str(ref_path)
            bpy.ops.render.render(write_still=True)
            ref = load_rgba(ref_path)
            for caster in casters:
                caster.hide_render = False
                caster.visible_camera = False
            pair_path = OUT_DIR / "renders" / f"{sample_id}_ao_{scale}x.png"
            scene.render.filepath = str(pair_path)
            bpy.ops.render.render(write_still=True)
            pair = load_rgba(pair_path)
            for caster in casters:
                caster.visible_camera = True
            ao[scale] = (ref, pair)
        target.data.materials[0] = original_material
        key.hide_render = False
        scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = world_strength

        crop2 = (crop[0] * scale_2x, crop[1] * scale_2x, crop[2] * scale_2x, crop[3] * scale_2x)
        alignment = reference_matches(reference[1], crop, TABLE_DIR / target_record["textureFile"])
        if alignment.get("meanDelta") != 0 or alignment.get("maxDelta") != 0:
            die(f"{sample_id}: target reference does not match the committed body: {alignment}")
        body_alpha = {
            1: load_rgba(TABLE_DIR / target_record["textureFile"])[..., 3],
            scale_2x: load_rgba(TABLE_DIR / target_record["textureFile2x"])[..., 3],
        }
        overlays = {}
        stats = {}
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
            for name, alpha in (("physical", phys), ("ao", contact), ("combined", combined_crop)):
                rgba = ink_rgba(alpha if name == "combined" else crop_image(alpha, box))
                path = OUT_DIR / f"{sample_id}_{name}_{scale}x.png"
                encode_png(path, quantize(rgba))
                overlays[f"{name}_{scale}x"] = str(path.relative_to(RENDER_DIR))
            support = combined_crop > 0.004
            stats[f"{scale}x"] = {
                "peak": round(float(combined_crop.max()), 4),
                "mean": round(float(combined_crop[support].mean()) if support.any() else 0.0, 4),
                "supportPx": int(support.sum()),
            }

        report["samples"].append(
            {
                "id": sample_id,
                "kind": entry["kind"],
                "target": entry["target"],
                "casters": [{k: v for k, v in c.items() if not k.startswith("_")} for c in entry["casters"]],
                "crop1x": {"x": crop[0], "y": crop[1], "width": crop[2], "height": crop[3]},
                "overlays": overlays,
                "stats": stats,
                "reference": alignment,
                "renderSeconds": round(time.time() - sample_started, 1),
            }
        )
        log(f"{sample_id}: done in {report['samples'][-1]['renderSeconds']} s, peak {stats['1x']['peak']}")
        for caster in casters:
            bpy.data.objects.remove(caster, do_unlink=True)
        bpy.data.objects.remove(target, do_unlink=True)
        bpy.data.objects.remove(camera, do_unlink=True)

    report_path = OUT_DIR / "lying-samples-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    log(f"wrote {report_path}")
    log(f"total {time.time() - started:.1f} s")


if __name__ == "__main__":
    main()
