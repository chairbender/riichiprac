#!/usr/bin/env python3
"""Shell baker for the 2.5D rendered view: Phase 0 skeleton.

The active architecture is ``2_5d_mahjong_tile_rendering_architecture.md``.
Six blank tile **shells** are baked offline; 2D face glyphs are composited into
each shell's ``faceQuad`` at runtime. There is no table model and no single
perspective scene camera.

This file is the entry point Phase 1 extends. Phase 0 deliberately does **not**
bake the six shells. It owns the reusable pieces and makes the toolchain
runnable end to end:

* the pinned Blender version check;
* the jansou tile proportions and the 0.055 / 6-segment bevel;
* the tile body as **one material** whose white/blue melamine split is gated on
  the object's local Z (ported from the retired 2.5 branch, commit 919e9fd);
* the locked top-left key plus weak ambient fill;
* the canonical six-shell catalogue and the output paths for
  ``frontend/public/table/shells/`` and ``frontend/public/table/shells.json``.

Usage (normally through ``bake-shells.sh``, which resolves the pinned Blender):

    blender --background --python-exit-code 1 \\
        --python tools/render/bake_shells.py -- --dry-run

A dry run builds the tile, material and lights, prints the shell plan, and
writes nothing. ``--bake`` is reserved for Phase 1 and fails loudly until
``bakeImplemented`` is true in ``shell-spec.json``.

The dependency-free check that needs no Blender is:

    node tools/render/scripts/check-shells.mjs
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

RENDER_DIR = Path(__file__).resolve().parent
SPEC_DIR = RENDER_DIR
DEFAULT_SPEC = SPEC_DIR / "shell-spec.json"

CANONICAL_SHELL_IDS = (
    "shell_hand_standing",
    "shell_flat_upright",
    "shell_flat_sideways",
    "shell_wall_horizontal",
    "shell_wall_side_left",
    "shell_wall_side_right",
)


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def die(message: str) -> None:
    print(f"[shells] ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def log(message: str) -> None:
    print(f"[shells] {message}")


def blender_args(argv: list[str]) -> list[str]:
    """Arguments after the ``--`` Blender separator, if there is one."""
    if "--" in argv:
        return argv[argv.index("--") + 1 :]
    return argv[1:]


def load_spec(path: Path) -> dict:
    try:
        spec = json.loads(path.read_text())
    except FileNotFoundError:
        die(f"spec not found: {path}")
    except json.JSONDecodeError as error:
        die(f"{path} is not valid JSON: {error}")
    for key in ("blender", "scene", "tile", "lighting", "shells", "outputs"):
        if key not in spec:
            die(f"{path} is missing {key!r}")
    return spec


def check_blender_version(spec: dict) -> str:
    actual = bpy.app.version_string
    required = spec["blender"]["requiredVersion"]
    log(f"Blender {actual} (required {required})")
    if not actual.startswith(required):
        die(f"Blender {required} is required, found {actual}")
    return actual


def srgb_to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def hex_linear(hex_colour: str) -> tuple[float, float, float, float]:
    value = hex_colour.lstrip("#")
    channels = [int(value[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]
    return (
        srgb_to_linear(channels[0]),
        srgb_to_linear(channels[1]),
        srgb_to_linear(channels[2]),
        1.0,
    )


def new_object(name: str, data: bpy.types.ID) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def new_material(name: str) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    return material


def principled(material: bpy.types.Material) -> bpy.types.ShaderNode:
    return material.node_tree.nodes["Principled BSDF"]


def aim(obj: bpy.types.Object, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def reset_scene() -> bpy.types.Scene:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


# --------------------------------------------------------------------------- #
# Tile geometry and materials (ported from the retired 2.5 branch, 919e9fd)
# --------------------------------------------------------------------------- #


def resolve_tile_dimensions(spec: dict) -> dict:
    """Derive the box from the jansou ratio so no hand-copied number drifts."""
    tile = spec["tile"]
    proportions = tile["proportionsMm"]
    height = tile["heightUnits"]
    tile["height"] = height
    tile["width"] = height * proportions["width"] / proportions["height"]
    tile["thickness"] = height * proportions["thickness"] / proportions["height"]
    log(
        "tile: "
        f"{tile['height']:.5f} h x {tile['width']:.5f} w x "
        f"{tile['thickness']:.5f} t units "
        f"(ratio {proportions['height']:g} x {proportions['width']:g} x "
        f"{proportions['thickness']:g} mm), bevel {tile['bevel']['width']:g} / "
        f"{tile['bevel']['segments']} segments"
    )
    return tile


def build_melamine(node: bpy.types.ShaderNode, material: dict, specular: float) -> None:
    """Apply one melamine material description to a Principled BSDF."""
    node.inputs["Base Color"].default_value = hex_linear(material["hex"])
    node.inputs["Roughness"].default_value = material["roughness"]
    node.inputs["Specular IOR Level"].default_value = specular
    node.inputs["Coat Weight"].default_value = material["coat"]
    node.inputs["Coat Roughness"].default_value = material["coatRoughness"]


def build_tile_material(spec: dict) -> bpy.types.Material:
    """The whole tile body in one material: white face plate, blue backing.

    The colour split is a **shader gate on the object's local Z** at
    ``backEdgeFraction`` of the thickness, not a per-face material assignment.
    That matters at the corners: the bevel rounds the vertical edges with new
    geometry, and a per-face assignment gives each rounded corner face a single
    material, so the blue side bands stop at the corner instead of wrapping it.
    A shader gate cuts through the bevel at the same depth as the flat side
    faces, so the blue is flush with the white all the way around.
    """
    tile = spec["tile"]
    cut_z = tile["backEdgeFraction"] * tile["thickness"]
    material = new_material("tile-body")
    nodes = material.node_tree.nodes
    links = material.node_tree.links

    white = nodes["Principled BSDF"]
    build_melamine(white, tile["materials"]["face"], 0.5)
    blue = nodes.new("ShaderNodeBsdfPrincipled")
    build_melamine(blue, tile["materials"]["backing"], 0.45)

    coordinates = nodes.new("ShaderNodeTexCoord")
    separate = nodes.new("ShaderNodeSeparateXYZ")
    links.new(coordinates.outputs["Object"], separate.inputs["Vector"])
    gate = nodes.new("ShaderNodeMath")
    gate.operation = "GREATER_THAN"
    gate.inputs[1].default_value = cut_z
    links.new(separate.outputs["Z"], gate.inputs[0])

    mix = nodes.new("ShaderNodeMixShader")
    links.new(gate.outputs[0], mix.inputs["Fac"])
    links.new(blue.outputs["BSDF"], mix.inputs[1])
    links.new(white.outputs["BSDF"], mix.inputs[2])
    links.new(mix.outputs["Shader"], nodes["Material Output"].inputs["Surface"])
    return material


def build_tile(scene: bpy.types.Scene, spec: dict) -> bpy.types.Object:
    """The reusable bevelled tile slab: white plate + blue backing."""
    import bmesh

    tile = spec["tile"]
    width = tile["width"]
    height = tile["height"]
    thickness = tile["thickness"]
    bevel = tile["bevel"]

    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for vert in bm.verts:
        vert.co = Vector(
            (vert.co.x * width, vert.co.y * height, (vert.co.z + 0.5) * thickness)
        )
    bm.normal_update()

    mesh = bpy.data.meshes.new("tile-body")
    bm.to_mesh(mesh)
    bm.free()
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    mesh.materials.append(build_tile_material(spec))

    obj = new_object("tile", mesh)
    modifier = obj.modifiers.new("Bevel", "BEVEL")
    modifier.width = bevel["width"]
    modifier.segments = bevel["segments"]
    modifier.limit_method = "ANGLE"
    modifier.angle_limit = math.radians(bevel["angleLimitDegrees"])
    modifier.harden_normals = bevel["hardenNormals"]
    modifier.miter_outer = "MITER_ARC"

    weighted = obj.modifiers.new("WeightedNormal", "WEIGHTED_NORMAL")
    weighted.keep_sharp = True
    weighted.mode = "FACE_AREA_WITH_ANGLE"
    return obj


# --------------------------------------------------------------------------- #
# Lighting and scene setup
# --------------------------------------------------------------------------- #


def build_world(scene: bpy.types.Scene, spec: dict) -> None:
    world = bpy.data.worlds.new("world")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = hex_linear(spec["lighting"]["world"]["hex"])
    background.inputs["Strength"].default_value = spec["lighting"]["world"]["strength"]
    scene.world = world


def key_location(key: dict) -> Vector:
    """Spherical placement: azimuth 0 fronts -Y, 90 is +X, elevation up."""
    azimuth = math.radians(key["azimuthDeg"])
    elevation = math.radians(key["elevationDeg"])
    distance = key["distance"]
    return Vector(
        (
            distance * math.cos(elevation) * math.sin(azimuth),
            -distance * math.cos(elevation) * math.cos(azimuth),
            distance * math.sin(elevation),
        )
    )


def build_lights(scene: bpy.types.Scene, spec: dict) -> list[bpy.types.Object]:
    """One locked top-left key plus the weak world fill from ``build_world``."""
    key = spec["lighting"]["key"]
    data = bpy.data.lights.new("key", type=key["type"])
    data.shape = "RECTANGLE"
    data.size = key["size"]
    data.size_y = key["sizeY"]
    data.energy = key["energyW"]
    data.color = hex_linear(key["hex"])[:3]
    obj = new_object("key", data)
    obj.location = key_location(key)
    aim(obj, Vector((0.0, 0.0, 0.0)))
    obj.rotation_euler.rotate_axis("Z", math.radians(key.get("rollDeg", 0.0)))
    obj["group"] = "key"
    log(
        f"key: azimuth {key['azimuthDeg']}°, elevation {key['elevationDeg']}°, "
        f"{key['distance']} units out, {key['size']}x{key['sizeY']}, "
        f"{key['energyW']} W"
    )
    return [obj]


def configure_render(scene: bpy.types.Scene, spec: dict) -> None:
    """Pin the renderer to CPU Cycles and AgX, as the determinism rule requires."""
    render = scene.render
    settings = spec["scene"]
    render.engine = settings["engine"]
    scene.cycles.device = settings["device"]
    scene.cycles.samples = settings["samples"]
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.cycles.use_adaptive_sampling = settings["useAdaptiveSampling"]
    scene.cycles.adaptive_threshold = settings["adaptiveThreshold"]
    scene.cycles.use_denoising = settings["denoise"]
    scene.cycles.denoiser = settings["denoiser"]
    render.film_transparent = settings["filmTransparent"]
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGBA"
    render.image_settings.color_depth = "8"
    view = settings["colorManagement"]
    scene.display_settings.display_device = view["displayDevice"]
    scene.view_settings.view_transform = view["viewTransform"]
    scene.view_settings.look = view["look"]
    scene.view_settings.exposure = view["exposure"]
    scene.view_settings.gamma = view["gamma"]
    log(
        "render: CPU Cycles, "
        f"{settings['samples']} samples, denoise {settings['denoiser']}, "
        f"{view['viewTransform']}/{view['look']}"
    )


# --------------------------------------------------------------------------- #
# Shell plan / Phase 1 extension points
# --------------------------------------------------------------------------- #


def validate_shell_catalogue(spec: dict) -> None:
    ids = [shell["id"] for shell in spec["shells"]]
    if len(ids) != len(set(ids)):
        die("the shell catalogue has duplicate ids")
    missing = [shell_id for shell_id in CANONICAL_SHELL_IDS if shell_id not in ids]
    extra = [shell_id for shell_id in ids if shell_id not in CANONICAL_SHELL_IDS]
    if missing or extra:
        die(
            "the shell catalogue must be exactly the six canonical shells; "
            f"missing {missing}, unexpected {extra}"
        )
    for shell in spec["shells"]:
        for key in ("id", "projection", "faceRotationDeg", "role"):
            if key not in shell:
                die(f"shell {shell.get('id', '?')} is missing {key!r}")


def build_shell_camera(scene: bpy.types.Scene, shell: dict) -> bpy.types.Object:
    """Phase 1: an orthographic/oblique camera per shell projection.

    Section 3 of the architecture fixes the rule: every shell is orthographic,
    and the side walls shear the mesh or camera along a fixed cabinet angle.
    The per-shell canvas, anchor, advance and ``faceQuad`` numbers are Phase 1
    decisions and are measured from the render, not guessed here.
    """
    die(
        f"shell cameras are Phase 1 work; {shell['id']} has projection "
        f"{shell['projection']!r} and no camera yet"
    )


def bake_shell(
    scene: bpy.types.Scene,
    tile: bpy.types.Object,
    shell: dict,
    spec: dict,
    output_dir: Path,
) -> dict:
    """Phase 1: pose/render one shell, measure it, and return its manifest record."""
    die(
        "the shell render loop is Phase 1 work; Phase 0 ships the mesh, materials, "
        "lighting, catalogue and output paths only"
    )


def shell_plan(spec: dict) -> None:
    log(f"shell plan ({len(spec['shells'])} canonical shells, nothing rendered):")
    for shell in spec["shells"]:
        log(
            f"  {shell['id']}: {shell['projection']}, "
            f"face rotation {shell['faceRotationDeg']}° — {shell['role']}"
        )
    outputs = spec["outputs"]
    log(f"output dir: {outputs['shellDir']}")
    log(f"manifest:   {outputs['manifest']}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, default=DEFAULT_SPEC)
    parser.add_argument(
        "--bake",
        action="store_true",
        help="render the six shells (Phase 1; fails until implemented)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="build the tile/material/lights, print the plan, write nothing",
    )
    args = parser.parse_args(blender_args(argv))

    spec = load_spec(args.spec)
    check_blender_version(spec)
    validate_shell_catalogue(spec)
    resolve_tile_dimensions(spec)

    scene = reset_scene()
    configure_render(scene, spec)
    build_world(scene, spec)
    tile = build_tile(scene, spec)
    build_lights(scene, spec)

    log(
        f"tile body built: {len(tile.data.polygons)} polygons, "
        f"material {tile.data.materials[0].name!r}, "
        f"modifiers {[modifier.type for modifier in tile.modifiers]}"
    )
    shell_plan(spec)

    if args.dry_run or not args.bake:
        log("dry run: no shells written; Phase 1 owns the bake")
        return 0
    if not spec.get("bakeImplemented"):
        die(
            "bakeImplemented is false: Phase 0 must not bake the six shells. "
            "Phase 1 implements build_shell_camera/bake_shell and flips this flag."
        )

    output_dir = (args.spec.resolve().parent / spec["outputs"]["shellDir"]).resolve()
    manifest_path = (args.spec.resolve().parent / spec["outputs"]["manifest"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    records = {}
    for shell in spec["shells"]:
        camera = build_shell_camera(scene, shell)
        records[shell["id"]] = {
            "faceRotationDeg": shell["faceRotationDeg"],
            **bake_shell(scene, tile, shell, spec, output_dir),
        }
        bpy.data.objects.remove(camera, do_unlink=True)
    manifest = {
        "version": 1,
        "generatedBy": "tools/render/bake_shells.py",
        "pixelRatio": spec["scene"].get("pixelRatio"),
        "shells": records,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    log(f"wrote {len(records)} shells to {output_dir} and {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
