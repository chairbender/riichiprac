#!/usr/bin/env python3
"""Shell baker for the 2.5D rendered view.

The active architecture is ``2_5d_mahjong_tile_rendering_architecture.md``.
Ninety blank tile **shells** are baked offline (eight base shells, the 14-slot
standing-hand fan, and the 17-slot front/back wall fan on each wall, face-down
and face-up); 2D face glyphs are composited into each shell's ``faceQuad`` at
runtime. There is no table model and no single perspective scene camera: the
grid shells are orthographic, and the walls and the standing hand use an
off-axis perspective camera.

The baker owns:

* the pinned Blender version check;
* the jansou tile proportions and the 0.055 / 6-segment bevel;
* the tile body as **one material** whose white/blue melamine split is gated on
  the object's local Z (ported from the retired 2.5 branch, commit 919e9fd);
* one area key locked to **screen-space** top-left-front plus a weak world fill,
  re-expressed in each shell camera's basis so every projection gets its
  highlights top/left and its shadow bottom/right;
* one camera per shell: orthographic for the grid shells, and an off-axis
  perspective for the side walls, every front/back wall slot and every hand slot
  (no yaw/roll; the lateral offset reveals the near face). The slot offset comes
  from the slot's x and the wall/hand eye distance;
* a **synthetic blob shadow** per shell: the tile's projected table-contact
  footprint, offset slightly down-right and blurred with a separable Gaussian,
  written as translucent black. Blender renders only the tile body; there is no
  catcher pass;
* a **separate body and shadow sprite** per shell: ``<id>.png`` is the tile body
  and ``<id>-shadow.png`` is the blob. The runtime unions every shadow first,
  then draws every body: a shadow can never sit on top of a neighbouring tile
  and overlapping blobs do not double-darken;
* ``frontend/public/table/shells/*.png`` (1x), ``shells/2x/*.png`` (2x) and
  ``frontend/public/table/shells.json``.

Every manifest number is measured from the render (body box from the alpha
channel, ``faceQuad`` from the camera projection) instead of hand-copied.

Usage (normally through ``bake-shells.sh``, which resolves the pinned Blender):

    blender --background --python-exit-code 1 \\
        --python tools/render/bake_shells.py -- --dry-run
    blender --background --python-exit-code 1 \\
        --python tools/render/bake_shells.py -- --bake
    blender --background --python-exit-code 1 \\
        --python tools/render/bake_shells.py -- --bake --verify-determinism
    blender --background --python-exit-code 1 \\
        --python tools/render/bake_shells.py -- --bake --preview --only shell_hand_top_slot_06
    blender --background --python-exit-code 1 \\
        --python tools/render/bake_shells.py -- --audition
    blender --background --python-exit-code 1 \\
        --python tools/render/bake_shells.py -- --audition --verify-determinism

A dry run builds the tile, material and lights, prints the shell plan, and
writes nothing. ``--bake`` renders the 103 shells, writes both scales and the
manifest (body + shadow). ``--preview`` with ``--only`` renders just those shells under
``build/preview/``. ``--shadow-audition`` renders the REF plus the spec's
``shadowAudition`` variants on the flat, wall and hand shells under
``build/review/shadows/``. ``--audition`` renders the standing-hand fan
calibration described by the spec's ``audition`` block at the current base scale into
``tools/render/build/review/`` (textures plus ``shell-candidates.json``) and
never touches the committed shells or ``shells.json``. ``--verify-determinism``
renders everything twice and compares the decoded RGBA, which is the re-render
determinism contract.

The dependency-free check that needs no Blender is:

    node tools/render/scripts/check-shells.mjs
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
import zlib
from pathlib import Path

import bpy
import numpy as np
from mathutils import Euler, Vector

RENDER_DIR = Path(__file__).resolve().parent
SPEC_DIR = RENDER_DIR
DEFAULT_SPEC = SPEC_DIR / "shell-spec.json"

BASE_SHELL_IDS = (
    "shell_flat_upright",
    "shell_flat_sideways",
    "shell_wall_horizontal",
    "shell_wall_horizontal_faceup",
    "shell_wall_side_left",
    "shell_wall_side_left_faceup",
    "shell_wall_side_right",
    "shell_wall_side_right_faceup",
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
    for key in ("blender", "scene", "tile", "lighting", "bake", "shells", "outputs"):
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


def hex_srgb(hex_colour: str) -> np.ndarray:
    value = hex_colour.lstrip("#")
    return np.array([int(value[i : i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=np.float32)


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

    Local Z is the tile's thickness axis in every pose, so the same two-tone
    seam shows on a standing tile (blue top sliver), a face-up tile (white top,
    white side above the blue back) and a face-down wall tile (blue top, white
    side below it).
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


def screen_space_key(spec: dict) -> Vector:
    """The key direction expressed in a front-elevation camera's screen basis.

    Reference camera: looking from -Y toward +Y, so screen right is +X, screen
    up is +Z and "toward the viewer" is -Y. The authored azimuth/elevation is
    decomposed in that basis once; ``aim_key`` then re-expresses the same
    top-left-front direction in whatever camera the shell uses.
    """
    key = spec["lighting"]["key"]
    direction = key_location(key).normalized()
    screen = Vector((direction.x, direction.z, -direction.y))
    roll = math.radians(key.get("rollDeg", 0.0))
    if roll:
        cos_roll, sin_roll = math.cos(roll), math.sin(roll)
        screen = Vector(
            (
                screen.x * cos_roll - screen.y * sin_roll,
                screen.x * sin_roll + screen.y * cos_roll,
                screen.z,
            )
        )
    return screen.normalized()


def camera_basis(camera: bpy.types.Object) -> tuple[Vector, Vector, Vector]:
    matrix = camera.matrix_world.to_3x3()
    right = matrix.col[0].normalized()
    up = matrix.col[1].normalized()
    toward_viewer = matrix.col[2].normalized()
    return right, up, toward_viewer


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
    obj["group"] = "key"
    screen = screen_space_key(spec)
    log(
        f"key: reference azimuth {key['azimuthDeg']}°, elevation {key['elevationDeg']}°, "
        f"screen-space direction ({screen.x:+.3f}, {screen.y:+.3f}, {screen.z:+.3f}), "
        f"{key['distance']} units out, {key['size']}x{key['sizeY']}, {key['energyW']} W"
    )
    return [obj]


def aim_key(light: bpy.types.Object, camera: bpy.types.Object | None, target: Vector, spec: dict) -> None:
    """Re-aim the key in the current camera's screen basis (top-left-front)."""
    key = spec["lighting"]["key"]
    screen = screen_space_key(spec)
    if camera is None:
        right, up, toward_viewer = Vector((1, 0, 0)), Vector((0, 0, 1)), Vector((0, -1, 0))
    else:
        right, up, toward_viewer = camera_basis(camera)
    direction = (right * screen.x + up * screen.y + toward_viewer * screen.z).normalized()
    light.location = target + direction * key["distance"]
    aim(light, target)
    if key.get("rollDeg", 0.0):
        light.rotation_euler.rotate_axis("Z", math.radians(key["rollDeg"]))


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
    render.resolution_percentage = settings.get("resolutionPercentage", 100)
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGBA"
    render.image_settings.color_depth = "8"
    render.image_settings.compression = 15
    view = settings["colorManagement"]
    scene.display_settings.display_device = view["displayDevice"]
    scene.view_settings.view_transform = view["viewTransform"]
    scene.view_settings.look = view["look"]
    scene.view_settings.exposure = view["exposure"]
    scene.view_settings.gamma = view["gamma"]
    log(
        "render: CPU Cycles, "
        f"{settings['samples']} samples, denoise {settings['denoiser']}, "
        f"{view['viewTransform']}/{view['look']}, seed 0"
    )


# --------------------------------------------------------------------------- #
# Tiling, framing and projection
# --------------------------------------------------------------------------- #


def wall_slot_shell_id(wall: str, index: int, face_up: bool) -> str:
    suffix = "_faceup" if face_up else ""
    return f"shell_wall_{wall}_slot_{index:02d}{suffix}"


def hand_slot_shell_id(index: int | None) -> str:
    return "shell_hand_slot_draw" if index is None else f"shell_hand_slot_{index:02d}"


def expand_hand_slots(spec: dict) -> None:
    """Append the per-slot standing-hand shells derived from ``handSlots``.

    The 13 concealed tiles are centred on the player (slot 6 is straight on);
    the drawn tile gets its own slot because it sits past the +0.35 advance gap.
    The camera is the player's eye, so the outer hand tiles show their inner side
    and their vertical face skews, exactly like the wall fan. The tile is never
    rotated: ``rotX 90`` stands it up and ``rotZ 0`` keeps the row upright.
    """
    block = spec.get("handSlots")
    if not block:
        return
    row_count = int(block["rowCount"])
    centre = int(block["centreIndex"])
    step = float(block["stepUnits"])
    elevation = float(block["elevationDeg"])
    distance = float(block["distanceUnits"])
    if row_count < 3 or row_count % 2 == 0:
        die("handSlots.rowCount must be an odd number >= 3")
    if centre != row_count // 2:
        die("handSlots.centreIndex must be the middle row slot")
    slots = [(index, (index - centre) * step, "row") for index in range(row_count)]
    slots.append((None, float(block["drawOffsetUnits"]), "draw"))
    for index, offset, kind in slots:
        angle = math.degrees(math.atan2(abs(offset), distance))
        shell_id = hand_slot_shell_id(index)
        hand_slot = {
            "kind": kind,
            "index": index,
            "offsetUnits": round(offset, 6),
            "lateralOffsetUnits": round(-offset, 6),
            "distanceUnits": distance,
            "angleDeg": round(angle, 3),
            "faceUp": True,
        }
        label = (
            "the drawn tile, after the +0.35 advance gap"
            if kind == "draw"
            else f"slot {index} of {row_count - 1} in the concealed 13-tile row"
        )
        spec["shells"].append(
            {
                "id": shell_id,
                "projection": "hand-slot-perspective",
                "faceRotationDeg": 0,
                "role": (
                    f"standing hand tile, {label}; the camera sits at the player's x, "
                    f"{angle:.1f} deg off the tile's normal"
                ),
                "pose": {
                    "rotateXDeg": 90,
                    "rotateYDeg": 0,
                    "rotateZDeg": 0,
                },
                "camera": {
                    "azimuthDeg": 0,
                    "elevationDeg": elevation,
                    "faceLocalZ": "top",
                    "projection": "perspective",
                    "perspective": {
                        "lateralOffsetUnits": round(-offset, 6),
                        "distanceUnits": distance,
                    },
                },
                "expectProjection": "portrait",
                "handSlot": hand_slot,
            }
        )


def expected_hand_slot_ids(spec: dict) -> list[str]:
    block = spec.get("handSlots")
    if not block:
        return []
    return [hand_slot_shell_id(index) for index in range(int(block["rowCount"]))] + [
        hand_slot_shell_id(None)
    ]


def top_hand_slot_shell_id(index: int) -> str:
    return f"shell_hand_top_slot_{index:02d}"


def expand_top_hand_slots(spec: dict) -> None:
    """Append the top player's standing face-down hand shells.

    The top hand is the human hand turned around: the tiles stand upright
    (rotX 90) with the face away (rotZ 180), so the human sees the blue back.
    The camera is the human's eye at the top-hand distance; the row is a 13-slot
    fan with the centre straight on. The shells are bare.
    """
    block = spec.get("topHand")
    if not block:
        return
    row_count = int(block["rowCount"])
    centre = int(block["centreIndex"])
    step = float(block["stepUnits"])
    elevation = float(block["elevationDeg"])
    distance = float(block["distanceUnits"])
    if row_count < 3 or row_count % 2 == 0:
        die("topHand.rowCount must be an odd number >= 3")
    if centre != row_count // 2:
        die("topHand.centreIndex must be the middle row slot")
    for index in range(row_count):
        offset = (index - centre) * step
        angle = math.degrees(math.atan2(abs(offset), distance))
        shell_id = top_hand_slot_shell_id(index)
        top_slot = {
            "kind": "top",
            "index": index,
            "offsetUnits": round(offset, 6),
            "lateralOffsetUnits": round(-offset, 6),
            "distanceUnits": distance,
            "angleDeg": round(angle, 3),
            "faceUp": False,
        }
        spec["shells"].append(
            {
                "id": shell_id,
                "projection": "top-hand-slot-perspective",
                "faceRotationDeg": 0,
                "role": (
                    f"top player's concealed hand tile, slot {index} of {row_count - 1}; "
                    f"standing upright with the blue back to the human, {angle:.1f} deg off "
                    "the tile's normal"
                ),
                "pose": {
                    "rotateXDeg": 90,
                    "rotateYDeg": 0,
                    "rotateZDeg": 180,
                },
                "camera": {
                    "azimuthDeg": 0,
                    "elevationDeg": elevation,
                    "faceLocalZ": "bottom",
                    "projection": "perspective",
                    "perspective": {
                        "lateralOffsetUnits": round(-offset, 6),
                        "distanceUnits": distance,
                    },
                },
                "expectProjection": "portrait",
                "topHandSlot": top_slot,
            }
        )


def expected_top_hand_slot_ids(spec: dict) -> list[str]:
    block = spec.get("topHand")
    if not block:
        return []
    return [top_hand_slot_shell_id(index) for index in range(int(block["rowCount"]))]


def expand_wall_slots(spec: dict) -> None:
    """Append the per-slot front/back wall shells derived from ``wallSlots``.

    A front/back wall is not one shell: the tile straight in front of the human
    is seen end-on, and the outer slots are seen from the human's eye, so each
    slot carries its own lateral camera offset. The face-down and face-up dora
    shells share the slot geometry. The block stays small and the ids are
    deterministic, so the spec cannot drift from the manifest id list.
    """
    block = spec.get("wallSlots")
    if not block:
        return
    count = int(block["count"])
    centre = int(block["centreIndex"])
    step = float(block["stepUnits"])
    elevation = float(block["elevationDeg"])
    if count < 3 or count % 2 == 0:
        die("wallSlots.count must be an odd number >= 3")
    if centre != count // 2:
        die("wallSlots.centreIndex must be the middle slot")
    for wall_name, wall in block["walls"].items():
        distance = float(wall["distanceUnits"])
        for face_up in (False, True):
            for index in range(count):
                offset = (index - centre) * step
                angle = math.degrees(math.atan2(abs(offset), distance))
                shell_id = wall_slot_shell_id(wall_name, index, face_up)
                wall_slot = {
                    "wall": wall_name,
                    "index": index,
                    "offsetUnits": round(offset, 6),
                    "lateralOffsetUnits": round(-offset, 6),
                    "distanceUnits": distance,
                    "angleDeg": round(angle, 3),
                    "faceUp": face_up,
                }
                wall_label = "front (bottom, human-side)" if wall_name == "front" else "back (top)"
                role = (
                    f"{'face-up dora-indicator' if face_up else 'face-down'} tile of the "
                    f"{wall_label} wall, slot {index} of {count}; the camera sits at the "
                    f"human's eye, {angle:.1f} deg off the tile's normal"
                )
                if face_up:
                    role += (
                        "; its glyph is rotated 180 deg on the back wall"
                        if int(wall.get("faceRotationDeg", 0)) == 180
                        else ""
                    )
                spec["shells"].append(
                    {
                        "id": shell_id,
                        "projection": "slot-perspective",
                        "faceRotationDeg": int(wall.get("faceRotationDeg", 0)) if face_up else 0,
                        "role": role,
                        "pose": {
                            "rotateXDeg": 0 if face_up else 180,
                            "rotateYDeg": 0,
                            "rotateZDeg": 0,
                        },
                        "camera": {
                            "azimuthDeg": 0,
                            "elevationDeg": elevation,
                            "faceLocalZ": "top" if face_up else "bottom",
                            "projection": "perspective",
                            "perspective": {
                                "lateralOffsetUnits": round(-offset, 6),
                                "distanceUnits": distance,
                            },
                        },
                        "expectProjection": "portrait",
                        "wallSlot": wall_slot,
                    }
                )


def expected_wall_slot_ids(spec: dict) -> list[str]:
    block = spec.get("wallSlots")
    if not block:
        return []
    ids = []
    for wall_name in block["walls"]:
        for face_up in (False, True):
            for index in range(int(block["count"])):
                ids.append(wall_slot_shell_id(wall_name, index, face_up))
    return ids


def validate_shell_catalogue(spec: dict) -> None:
    ids = [shell["id"] for shell in spec["shells"]]
    if len(ids) != len(set(ids)):
        die("the shell catalogue has duplicate ids")
    expected = (
        list(BASE_SHELL_IDS)
        + expected_hand_slot_ids(spec)
        + expected_top_hand_slot_ids(spec)
        + expected_wall_slot_ids(spec)
    )
    missing = [shell_id for shell_id in expected if shell_id not in ids]
    extra = [shell_id for shell_id in ids if shell_id not in expected]
    if missing or extra or ids != expected:
        die(
            "the shell catalogue must be exactly the base shells followed by the generated "
            f"wall slots; missing {missing}, unexpected {extra}"
        )
    for shell in spec["shells"]:
        for key in ("id", "projection", "faceRotationDeg", "role", "pose", "camera"):
            if key not in shell:
                die(f"shell {shell.get('id', '?')} is missing {key!r}")
        for key in ("azimuthDeg", "elevationDeg", "faceLocalZ"):
            if key not in shell["camera"]:
                die(f"shell {shell['id']} camera is missing {key!r}")
        if shell["camera"]["faceLocalZ"] not in ("top", "bottom"):
            die(f"shell {shell['id']} camera.faceLocalZ must be 'top' or 'bottom'")
        for key in ("rotateXDeg", "rotateYDeg", "rotateZDeg"):
            shell["pose"].setdefault(key, 0.0)
    if spec["bake"]["pixelRatio"] < 1:
        die("bake.pixelRatio must be >= 1")


def tile_world_corners(tile: bpy.types.Object) -> list[Vector]:
    return [tile.matrix_world @ Vector(corner) for corner in tile.bound_box]


def world_bbox_center(tile: bpy.types.Object) -> Vector:
    corners = tile_world_corners(tile)
    low = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    high = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return (low + high) * 0.5


def pose_tile(tile: bpy.types.Object, shell: dict) -> None:
    """Rotate the tile into place and drop it onto the table plane (z=0)."""
    pose = shell["pose"]
    rotation = Euler(
        (
            math.radians(pose["rotateXDeg"]),
            math.radians(pose["rotateYDeg"]),
            math.radians(pose["rotateZDeg"]),
        ),
        "XYZ",
    )
    tile.rotation_euler = rotation
    matrix = rotation.to_matrix()
    local_min_z = min((matrix @ Vector(corner)).z for corner in tile.bound_box)
    tile.location = Vector((0.0, 0.0, -local_min_z))
    bpy.context.view_layer.update()


def set_resolution(scene: bpy.types.Scene, width: int, height: int) -> None:
    scene.render.resolution_x = int(width)
    scene.render.resolution_y = int(height)
    scene.render.resolution_percentage = 100


def place_camera(camera: bpy.types.Object, target: Vector, azimuth_deg: float, elevation_deg: float) -> None:
    azimuth = math.radians(azimuth_deg)
    elevation = math.radians(elevation_deg)
    direction = Vector(
        (
            math.cos(elevation) * math.sin(azimuth),
            -math.cos(elevation) * math.cos(azimuth),
            math.sin(elevation),
        )
    )
    camera.location = target + direction * 10.0
    aim(camera, target)
    bpy.context.view_layer.update()


def project_pixels(scene: bpy.types.Scene, camera: bpy.types.Object, points: list[Vector]) -> list[tuple[float, float]]:
    """World points -> pixel coordinates (top-left origin) for the render frame."""
    from bpy_extras.object_utils import world_to_camera_view

    width = scene.render.resolution_x
    height = scene.render.resolution_y
    result = []
    for point in points:
        co = world_to_camera_view(scene, camera, point)
        result.append((co.x * width, (1.0 - co.y) * height))
    return result


def projected_bbox(scene: bpy.types.Scene, camera: bpy.types.Object, tile: bpy.types.Object) -> tuple[float, float, float, float]:
    points = project_pixels(scene, camera, tile_world_corners(tile))
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return min(xs), min(ys), max(xs), max(ys)


def tile_axes_px(
    scene: bpy.types.Scene,
    camera: bpy.types.Object,
    tile: bpy.types.Object,
    shell: dict,
    spec: dict,
) -> tuple[list[float], list[float]]:
    """Projected full-tile width/height axes through the face centre.

    For an orthographic camera this equals the old inset-face derivation grown
    back to the full tile. For the perspective side walls the two long edges have
    different lengths, so the *centre line* is the representative layout step.
    """
    tile_spec = spec["tile"]
    z = tile_spec["thickness"] if shell["camera"]["faceLocalZ"] == "top" else 0.0
    matrix = tile.matrix_world
    centre = matrix @ Vector((0.0, 0.0, z))
    width_world = matrix.to_3x3() @ Vector((tile_spec["width"], 0.0, 0.0))
    height_world = matrix.to_3x3() @ Vector((0.0, tile_spec["height"], 0.0))
    p0, px, py = project_pixels(scene, camera, [centre, centre + width_world, centre + height_world])
    return (
        [px[0] - p0[0], px[1] - p0[1]],
        [py[0] - p0[0], py[1] - p0[1]],
    )


def build_perspective_camera(
    scene: bpy.types.Scene,
    tile: bpy.types.Object,
    shell: dict,
    spec: dict,
) -> tuple[bpy.types.Object, dict]:
    """An off-axis perspective camera for a wall shell.

    The camera has no yaw and no roll: it sits ``lateralOffsetUnits`` to the side
    of the tile and looks along the wall's inward normal, pitched down by the
    shell elevation. That keeps the tile's long edges parallel to the table edge
    on screen (a perspective camera looking along the normal preserves lines of
    constant depth) while the lateral offset reveals the near end face. The lens
    and the lens shift are solved so the projected body long axis is the spec's
    target and the tile is centred in the frame.
    """
    camera_values = shell["camera"]
    perspective = camera_values["perspective"]
    elevation = math.radians(camera_values["elevationDeg"])
    lateral = float(perspective["lateralOffsetUnits"])
    distance = float(perspective["distanceUnits"])

    data = bpy.data.cameras.new(f"camera-{shell['id']}")
    data.type = "PERSP"
    data.sensor_fit = "HORIZONTAL"
    data.sensor_width = 36.0
    data.lens = 50.0
    data.shift_x = 0.0
    data.shift_y = 0.0
    camera = new_object(f"camera-{shell['id']}", data)
    scene.camera = camera
    camera.rotation_euler = Euler((math.radians(90.0) - elevation, 0.0, 0.0), "XYZ")
    camera.location = Vector((lateral, -distance, distance * math.tan(elevation)))
    bpy.context.view_layer.update()

    bake = spec["bake"]
    margin = int(bake["frameMarginPx2x"])
    target = float(bake["targetLongAxisPx1x"]) * bake["pixelRatio"]

    set_resolution(scene, 512, 512)
    probe = projected_bbox(scene, camera, tile)
    probe_width = probe[2] - probe[0]
    probe_height = probe[3] - probe[1]
    aspect = probe_width / max(1e-9, probe_height)
    if aspect >= 1.0:
        width_2x = int(math.ceil(target)) + 2 * margin
        height_2x = int(math.ceil(target / aspect)) + 2 * margin
    else:
        height_2x = int(math.ceil(target)) + 2 * margin
        width_2x = int(math.ceil(target * aspect)) + 2 * margin
    width_2x += width_2x % 2
    height_2x += height_2x % 2
    set_resolution(scene, width_2x, height_2x)

    # 1. Solve the lens so the projected long axis is the target size.
    for _ in range(6):
        bbox = projected_bbox(scene, camera, tile)
        long_px = max(bbox[2] - bbox[0], bbox[3] - bbox[1])
        if long_px <= 0:
            die(f"{shell['id']}: the perspective camera sees no tile")
        scale = target / long_px
        if abs(scale - 1.0) < 0.002:
            break
        data.lens *= scale
        bpy.context.view_layer.update()

    # 2. Solve the lens shift so the bbox is centred (shift_x moves the image
    #    left, shift_y moves it down; measured rather than assumed).
    for _ in range(4):
        bbox = projected_bbox(scene, camera, tile)
        centre_x = (bbox[0] + bbox[2]) * 0.5 / width_2x
        centre_y = (bbox[1] + bbox[3]) * 0.5 / height_2x
        data.shift_x += 0.05
        bpy.context.view_layer.update()
        moved = projected_bbox(scene, camera, tile)
        moved_x = (moved[0] + moved[2]) * 0.5 / width_2x
        data.shift_x -= 0.05
        data.shift_y += 0.05
        bpy.context.view_layer.update()
        moved = projected_bbox(scene, camera, tile)
        moved_y = (moved[1] + moved[3]) * 0.5 / height_2x
        data.shift_y -= 0.05
        bpy.context.view_layer.update()
        derivative_x = (moved_x - centre_x) / 0.05
        derivative_y = (moved_y - centre_y) / 0.05
        if abs(derivative_x) < 1e-6 or abs(derivative_y) < 1e-6:
            die(f"{shell['id']}: could not solve the perspective lens shift")
        data.shift_x += (0.5 - centre_x) / derivative_x
        data.shift_y += (0.5 - centre_y) / derivative_y
        bpy.context.view_layer.update()

    # 3. Verify the framed tile: the long axis is the target and the body (plus
    #    the shadow margin) is inside the frame.
    bbox = projected_bbox(scene, camera, tile)
    long_px = max(bbox[2] - bbox[0], bbox[3] - bbox[1])
    if abs(long_px - target) > 1.5:
        die(
            f"{shell['id']}: perspective framing long axis {long_px:.2f} px "
            f"is not the {target:.0f} px target"
        )
    if bbox[0] < 2 or bbox[1] < 2 or bbox[2] > width_2x - 2 or bbox[3] > height_2x - 2:
        die(f"{shell['id']}: perspective framing leaves the render frame: {bbox}")

    # Equivalent scale for the manifest (the tile-axis scale at the centre).
    set_resolution(scene, width_2x // 2, height_2x // 2)
    width_axis, height_axis = tile_axes_px(scene, camera, tile, shell, spec)
    tile_spec = spec["tile"]
    ppu_1x = max(
        math.hypot(*width_axis) / tile_spec["width"],
        math.hypot(*height_axis) / tile_spec["height"],
    )
    return camera, {
        "projection": "perspective",
        "lensMm": round(float(data.lens), 4),
        "shiftX": round(float(data.shift_x), 6),
        "shiftY": round(float(data.shift_y), 6),
        "lateralOffsetUnits": lateral,
        "distanceUnits": distance,
        "pixelsPerUnit2x": round(ppu_1x * bake["pixelRatio"], 6),
        "resolution2x": [width_2x, height_2x],
        "resolution1x": [width_2x // 2, height_2x // 2],
    }


def build_shell_camera(
    scene: bpy.types.Scene,
    tile: bpy.types.Object,
    shell: dict,
    spec: dict,
) -> tuple[bpy.types.Object, dict]:
    """Build the orthographic camera and the two render resolutions for a shell.

    The camera is framed so the projected tile silhouette is centred and its
    long axis measures ``targetLongAxisPx1x`` CSS px at @1x (twice that at @2x),
    which keeps apparent scale identical across projections.
    """
    if shell["camera"].get("projection") == "perspective" and "perspective" in shell["camera"]:
        return build_perspective_camera(scene, tile, shell, spec)

    camera_data = bpy.data.cameras.new(f"camera-{shell['id']}")
    camera_data.type = "ORTHO"
    camera_data.sensor_fit = "AUTO"
    camera = new_object(f"camera-{shell['id']}", camera_data)
    scene.camera = camera

    camera_values = shell["camera"]
    azimuth = camera_values["azimuthDeg"]
    elevation = camera_values["elevationDeg"]

    # Reference pass: square frame, 1 world unit across, to measure the
    # projected silhouette in world units and find its centre.
    set_resolution(scene, 512, 512)
    camera_data.ortho_scale = 1.0
    target = world_bbox_center(tile)
    place_camera(camera, target, azimuth, elevation)
    projected = project_pixels(scene, camera, tile_world_corners(tile))
    xs = [p[0] for p in projected]
    ys = [p[1] for p in projected]
    world_per_px = 1.0 / 512.0
    width_units = (max(xs) - min(xs)) * world_per_px
    height_units = (max(ys) - min(ys)) * world_per_px
    centre_x = ((min(xs) + max(xs)) * 0.5 - 256.0) * world_per_px
    centre_y = ((min(ys) + max(ys)) * 0.5 - 256.0) * world_per_px
    right, up, _ = camera_basis(camera)
    target = target + right * centre_x - up * centre_y
    place_camera(camera, target, azimuth, elevation)

    bake = spec["bake"]
    margin = int(bake["frameMarginPx2x"])
    long_px = float(bake["targetLongAxisPx1x"]) * bake["pixelRatio"]
    ppu = long_px / max(width_units, height_units)
    width_2x = int(math.ceil(width_units * ppu)) + 2 * margin
    height_2x = int(math.ceil(height_units * ppu)) + 2 * margin
    # Keep both axes even so the @1x frame is exactly half the @2x frame.
    width_2x += width_2x % 2
    height_2x += height_2x % 2
    camera_data.ortho_scale = max(width_2x, height_2x) / ppu

    return camera, {
        "projectionWidthUnits": round(width_units, 6),
        "projectionHeightUnits": round(height_units, 6),
        "pixelsPerUnit2x": round(ppu, 6),
        "orthoScale": round(float(camera_data.ortho_scale), 6),
        "resolution2x": [width_2x, height_2x],
        "resolution1x": [width_2x // 2, height_2x // 2],
    }


def face_quad(
    scene: bpy.types.Scene,
    camera: bpy.types.Object,
    tile: bpy.types.Object,
    shell: dict,
    spec: dict,
) -> list[list[float]]:
    """The visible face plate inset by ``faceInset``, in render pixels.

    Local +Z is the tile's face plate. The visible face is local z = thickness
    for a face-up standing/flat shell and local z = 0 for a face-down wall
    shell. Inset by the bevel width so a runtime glyph never spills onto the
    rounded shoulder.
    """
    tile_spec = spec["tile"]
    inset = tile_spec["faceInset"]
    half_x = tile_spec["width"] * 0.5 - inset
    half_y = tile_spec["height"] * 0.5 - inset
    z = tile_spec["thickness"] if shell["camera"]["faceLocalZ"] == "top" else 0.0
    local = [
        Vector((-half_x, half_y, z)),
        Vector((half_x, half_y, z)),
        Vector((half_x, -half_y, z)),
        Vector((-half_x, -half_y, z)),
    ]
    world = [tile.matrix_world @ point for point in local]
    projected = project_pixels(scene, camera, world)
    # Local order, i.e. the face's own [top-left, top-right, bottom-right,
    # bottom-left], so a glyph's "up" follows the tile's local +Y. A strongly
    # sheared cabinet projection makes a screen-space min(x+y) ordering flip
    # corners, which would rotate the glyph by 180°. faceRotationDeg is the
    # only thing that rotates the glyph.
    return [[round(x, 2), round(y, 2)] for x, y in projected]


# --------------------------------------------------------------------------- #
# Render, decode, compose
# --------------------------------------------------------------------------- #


def render_pass(scene: bpy.types.Scene, path: Path) -> None:
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def load_rgba(path: Path) -> np.ndarray:
    """Decode a saved render into a top-down float RGBA array in [0, 1].

    Blender exposes an 8-bit sRGB PNG's bytes unchanged through
    ``Image.pixels`` (verified against a raw zlib decode), and PNG alpha is
    straight, so this is exactly what the JS checker sees.
    """
    image = bpy.data.images.load(str(path), check_existing=False)
    try:
        width, height = image.size
        data = np.array(image.pixels[:], dtype=np.float32).reshape(height, width, 4)
    finally:
        bpy.data.images.remove(image)
    return data[::-1].copy()


def encode_png(path: Path, rgba: np.ndarray) -> bytes:
    """Encode uint8 RGBA with filter 0 so decoded pixels are unambiguous."""
    height, width, channels = rgba.shape
    if channels != 4:
        die(f"{path}: expected RGBA, got {channels} channels")
    raw = bytearray()
    for row in range(height):
        raw.append(0)
        raw.extend(rgba[row].tobytes())

    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    data = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def alpha_bbox(alpha: np.ndarray, threshold: float = 0.5) -> tuple[int, int, int, int]:
    mask = alpha >= threshold
    if not mask.any():
        die("the render has no opaque tile pixels")
    ys, xs = np.nonzero(mask)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def gaussian_blur(field: np.ndarray, sigma: float) -> np.ndarray:
    """Separable Gaussian blur of a float field, zero-padded at the border."""
    if sigma <= 0:
        return field
    radius = max(1, int(math.ceil(3.0 * sigma)))
    offsets = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-0.5 * (offsets / sigma) ** 2)
    kernel /= kernel.sum()
    height, width = field.shape
    padded = np.pad(field, ((radius, radius), (radius, radius)), mode="constant")
    rows = np.zeros((height, width + 2 * radius), dtype=np.float64)
    for index, weight in enumerate(kernel):
        rows += weight * padded[index : index + height, :]
    out = np.zeros((height, width), dtype=np.float64)
    for index, weight in enumerate(kernel):
        out += weight * rows[:, index : index + width]
    return out


def contact_footprint_px(
    scene: bpy.types.Scene,
    camera: bpy.types.Object,
    tile: bpy.types.Object,
    spec: dict,
) -> list[tuple[float, float]]:
    """Project the tile's table-contact footprint to pixels.

    ``pose_tile`` drops the tile onto z=0, so its local bottom face rests on the
    table. Flattening those four corners back onto the table plane and projecting
    them gives the area the shadow originates from: a full parallelogram for a
    flat pond tile, and a thin bottom-edge capsule for a standing wall tile.
    """
    # Use the actual lowest corners, not the local z=0 face: a standing tile
    # rests on an edge (two corners), so its footprint is the base rectangle,
    # while a flat tile rests on its whole back face (four corners).
    corners = [tile.matrix_world @ Vector(corner) for corner in tile.bound_box]
    lowest = min(point.z for point in corners)
    on_table = [point for point in corners if abs(point.z - lowest) <= 1e-4]
    return project_pixels(scene, camera, [Vector((p.x, p.y, 0.0)) for p in on_table])


def blob_shadow(
    width: int,
    height: int,
    contact_px: list[tuple[float, float]],
    shadow: dict,
    scale: int,
    body_centre_px: tuple[float, float],
    body_half_px: tuple[float, float],
) -> tuple[np.ndarray, bool]:
    """A soft translucent ellipse under the tile's table-contact footprint.

    A lying tile (the contact footprint is comparable to the body box) gets an
    ellipse covering the body box, so the fringe surrounds the tile instead of
    leaving a light gap where the projected thickness shifts the contact face.
    A standing or tilted tile keeps a capsule at its base.
    """
    points = np.array(contact_px, dtype=np.float64) * scale
    centre = points.mean(axis=0)
    centred = points - centre
    minimum = float(shadow["minHalfWidthPx1x"]) * scale
    if np.allclose(centred, 0.0):
        axes = np.eye(2)
        major = minimum
        minor = minimum
    else:
        # Principal axes of the projected footprint. A standing tile's footprint
        # is a line, so the minor semi-axis is clamped to keep a capsule shape.
        eigenvalues, eigenvectors = np.linalg.eigh(np.cov(centred.T))
        axes = eigenvectors[:, np.argsort(eigenvalues)[::-1]]
        major = float(np.max(np.abs(centred @ axes[:, 0])))
        minor = float(np.max(np.abs(centred @ axes[:, 1])))
    offset = np.array(shadow["offsetPx1x"], dtype=np.float64) * scale
    body_half = np.array(body_half_px, dtype=np.float64) * scale
    lying = minor >= 0.5 * float(np.min(body_half))
    if lying:
        centre = np.array(body_centre_px, dtype=np.float64) * scale + offset
        half = body_half * float(shadow["footprintScale"])
    else:
        centre = centre + offset
        spread = float(shadow["spreadPx1x"]) * scale
        half = np.array([max(major + spread, minimum), max(minor + spread, minimum)])

    ys, xs = np.mgrid[0:height, 0:width].astype(np.float64) + 0.5
    dx = xs - centre[0]
    dy = ys - centre[1]
    u = dx * axes[0, 0] + dy * axes[1, 0]
    v = dx * axes[0, 1] + dy * axes[1, 1]
    mask = ((u / half[0]) ** 2 + (v / half[1]) ** 2 <= 1.0).astype(np.float64)
    alpha = np.clip(
        gaussian_blur(mask, float(shadow["sigmaPx1x"]) * scale)
        * float(shadow["coreAlpha"]),
        0.0,
        1.0,
    )
    rgb = np.broadcast_to(hex_srgb(shadow["colorHex"]), (height, width, 3))
    return np.concatenate([rgb, alpha[..., None]], axis=2), bool(lying)


def alpha_profile(rgba: np.ndarray, bbox: tuple[int, int, int, int], pads: dict) -> dict:
    """Measured nonzero-alpha extent, peak and mass per padded side (@1x px).

    Extents are measured over each half-space (corners included, because a soft
    blob really does reach furthest diagonally). Peaks and mass are measured over
    the non-corner band of each side so a corner does not dominate the edge.
    """
    x0, y0, x1, y1 = bbox
    alpha = rgba[..., 3].astype(np.float64) / 255.0
    height, width = alpha.shape
    ys, xs = np.mgrid[0:height, 0:width]
    # The exported sprite is only the shadow, so no pixel is "inside a tile";
    # the body box already restricts every band to the margin.
    visible = alpha > 2.0 / 255.0

    bands = {
        "right": visible & (xs > x1),
        "bottom": visible & (ys > y1),
        "left": visible & (xs < x0),
        "top": visible & (ys < y0),
    }
    cores = {
        "right": (ys >= y0) & (ys <= y1) & (xs > x1),
        "left": (ys >= y0) & (ys <= y1) & (xs < x0),
        "bottom": (xs >= x0) & (xs <= x1) & (ys > y1),
        "top": (xs >= x0) & (xs <= x1) & (ys < y0),
    }
    extent = {
        "left": int(x0 - xs[bands["left"]].min()) if bands["left"].any() else 0,
        "top": int(y0 - ys[bands["top"]].min()) if bands["top"].any() else 0,
        "right": int(xs[bands["right"]].max() - x1) if bands["right"].any() else 0,
        "bottom": int(ys[bands["bottom"]].max() - y1) if bands["bottom"].any() else 0,
    }
    peak = {}
    mass = {}
    for side in ("left", "top", "right", "bottom"):
        mask = cores[side]
        peak[side] = round(float(alpha[mask].max()), 4) if mask.any() else 0.0
        mass[side] = round(float(alpha[mask].sum()), 3)
    return {
        "extentPx": extent,
        "peakAlpha": peak,
        "mass": mass,
        "padding": dict(pads),
    }


def edge_samples(rgba: np.ndarray, bbox: tuple[int, int, int, int]) -> dict:
    """Mean RGB of the top and bottom *silhouette* edges: the two-tone seam.

    The leaned side-wall and sideways shells are parallelograms, so the top and
    bottom rows of the body bounding box can run outside the opaque body in the
    middle columns. This walks each column to its first and last opaque pixel
    and samples one pixel inside, which is the edge for every projection.
    """
    x0, y0, x1, y1 = bbox
    alpha = rgba[..., 3]
    left = x0 + (x1 - x0) * 3 // 10
    right = x0 + (x1 - x0) * 7 // 10
    tops = []
    bottoms = []
    for x in range(left, right):
        column = alpha[y0 : y1 + 1, x]
        opaque = np.nonzero(column >= 250)[0]
        if not len(opaque):
            continue
        top_y = y0 + int(opaque[0])
        bottom_y = y0 + int(opaque[-1])
        tops.append(rgba[min(top_y + 1, y1), x, :3])
        bottoms.append(rgba[max(bottom_y - 1, y0), x, :3])
    if not tops or not bottoms:
        die("the texture has no opaque edge samples")
    top = np.array(tops, dtype=np.float64).mean(axis=0)
    bottom = np.array(bottoms, dtype=np.float64).mean(axis=0)
    return {
        "top": [int(round(value)) for value in top],
        "bottom": [int(round(value)) for value in bottom],
    }


def frame_fade(rgba: np.ndarray, ramp_px: float = 1.0) -> np.ndarray:
    """Fade alpha to zero at the outer texture ring.

    The shadow/AO contract leaves no room for a shadow that runs off the top or
    left because the body sits only 1-2 px from those edges. This 1 px ramp
    guarantees the exported sprite never clips at its own border (the check
    asserts the outer ring is transparent) without touching the body.
    """
    height, width = rgba.shape[:2]
    ys, xs = np.mgrid[0:height, 0:width]
    edge = np.minimum(
        np.minimum(xs, width - 1 - xs),
        np.minimum(ys, height - 1 - ys),
    ).astype(np.float64)
    mask = np.clip(edge / max(0.001, ramp_px), 0.0, 1.0)
    out = rgba.copy()
    out[..., 3] *= mask
    return out


def crop(rgba: np.ndarray, x: int, y: int, width: int, height: int) -> np.ndarray:
    if x < 0 or y < 0 or x + width > rgba.shape[1] or y + height > rgba.shape[0]:
        die(f"crop window {x},{y} {width}x{height} leaves the render {rgba.shape[1]}x{rgba.shape[0]}")
    return rgba[y : y + height, x : x + width]


def quantize(rgba: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(rgba * 255.0), 0, 255).astype(np.uint8)


def rgba_sha256(rgba: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(rgba).tobytes()).hexdigest()


# --------------------------------------------------------------------------- #
# Shell bake
# --------------------------------------------------------------------------- #


def same_decoded_rgba(repeat: dict, record: dict) -> bool:
    """Both the body and the shadow sprite must reproduce exactly."""
    return (
        repeat.get("sha256") == record.get("sha256")
        and repeat.get("shadowSha256") == record.get("shadowSha256")
    )


def bake_shell(
    scene: bpy.types.Scene,
    tile: bpy.types.Object,
    shell: dict,
    spec: dict,
    camera: bpy.types.Object,
    framing: dict,
    output_dir: Path,
    output_dir_2x: Path,
    temp_dir: Path,
    record_hashes: bool = True,
) -> dict:
    """Pose/render one shell at @1x and @2x, measure it, write both textures."""
    bake = spec["bake"]
    scale_2x = int(bake["pixelRatio"])
    body_pads = bake["padding1x"]
    shadow = bake["shadow"]
    shadow_pads = shadow["padding1x"]
    ledge = int(bake.get("edgeLedgePx", 1))

    # The contact footprint is measured on the @1x frame; the @2x blob is the
    # same footprint scaled by the pixel ratio.
    set_resolution(scene, framing["resolution1x"][0], framing["resolution1x"][1])
    contact_px = contact_footprint_px(scene, camera, tile, spec)

    renders = {}
    for scale in (1, scale_2x):
        width = framing["resolution1x"][0] * scale
        height = framing["resolution1x"][1] * scale
        set_resolution(scene, width, height)
        tag = f"{scale}x"
        tile_path = temp_dir / f"{shell['id']}_{tag}_tile.png"
        render_pass(scene, tile_path)
        tile_rgba = load_rgba(tile_path)
        solid = alpha_bbox(tile_rgba[..., 3])
        bbox = (
            solid[0] - ledge * scale,
            solid[1] - ledge * scale,
            solid[2] + ledge * scale,
            solid[3] + ledge * scale,
        )
        if bbox[0] < 0 or bbox[1] < 0 or bbox[2] >= width or bbox[3] >= height:
            die("the tile silhouette touches the render frame; raise bake.frameMarginPx2x")
        renders[scale] = {"body": tile_rgba, "bbox": bbox, "size": (width, height)}

    base = renders[1]
    bx0, by0, bx1, by1 = base["bbox"]
    advance_width = bx1 - bx0 + 1
    advance_height = by1 - by0 + 1

    body_crop_x = bx0 - body_pads["left"]
    body_crop_y = by0 - body_pads["top"]
    body_width = advance_width + body_pads["left"] + body_pads["right"]
    body_height = advance_height + body_pads["top"] + body_pads["bottom"]
    if (
        body_crop_x < 0
        or body_crop_y < 0
        or body_crop_x + body_width > base["size"][0]
        or body_crop_y + body_height > base["size"][1]
    ):
        die("the body padding leaves the render frame; raise bake.frameMarginPx2x")

    shadow_crop_x = bx0 - shadow_pads["left"]
    shadow_crop_y = by0 - shadow_pads["top"]
    shadow_width = advance_width + shadow_pads["left"] + shadow_pads["right"]
    shadow_height = advance_height + shadow_pads["top"] + shadow_pads["bottom"]
    contact_local = [(x - shadow_crop_x, y - shadow_crop_y) for x, y in contact_px]
    body_centre = (
        shadow_pads["left"] + advance_width * 0.5,
        shadow_pads["top"] + advance_height * 0.5,
    )
    body_half = (advance_width * 0.5, advance_height * 0.5)

    body_1x = quantize(
        frame_fade(
            crop(base["body"], body_crop_x, body_crop_y, body_width, body_height),
            1.0,
        )
    )
    shadow_1x_rgba, lying = blob_shadow(
        shadow_width,
        shadow_height,
        contact_local,
        shadow,
        1,
        body_centre,
        body_half,
    )
    shadow_1x = quantize(frame_fade(shadow_1x_rgba, 1.0))

    big = renders[scale_2x]
    body_2x = quantize(
        frame_fade(
            crop(
                big["body"],
                body_crop_x * scale_2x,
                body_crop_y * scale_2x,
                body_width * scale_2x,
                body_height * scale_2x,
            ),
            float(scale_2x),
        )
    )
    shadow_2x_rgba, _ = blob_shadow(
        shadow_width * scale_2x,
        shadow_height * scale_2x,
        contact_local,
        shadow,
        scale_2x,
        body_centre,
        body_half,
    )
    shadow_2x = quantize(frame_fade(shadow_2x_rgba, float(scale_2x)))

    # faceQuad is measured on the @1x frame so it lands in the @1x texture's
    # coordinate space, which is the manifest's coordinate space.
    set_resolution(scene, framing["resolution1x"][0], framing["resolution1x"][1])
    quad = [
        [round(x - body_crop_x, 2), round(y - body_crop_y, 2)]
        for x, y in face_quad(scene, camera, tile, shell, spec)
    ]

    # A wall is a stack of two tiles. The upper tier sits one tile thickness
    # higher, so its body top-left is the lower tier's plus this projected
    # thickness vector (straight up on screen). It is published per shell so the
    # layout never has to re-derive it from the camera.
    width_axis, height_axis = tile_axes_px(scene, camera, tile, shell, spec)

    stack_step = None
    if "wall" in shell["id"]:
        centre = world_bbox_center(tile)
        low = project_pixels(scene, camera, [centre])[0]
        high = project_pixels(
            scene,
            camera,
            [centre + Vector((0.0, 0.0, spec["tile"]["thickness"]))],
        )[0]
        stack_step = [round(high[0] - low[0], 2), round(high[1] - low[1], 2)]

    texture_name = f"{shell['id']}.png"
    shadow_name = f"{shell['id']}-shadow.png"
    encode_png(output_dir / texture_name, body_1x)
    encode_png(output_dir_2x / texture_name, body_2x)
    encode_png(output_dir / shadow_name, shadow_1x)
    encode_png(output_dir_2x / shadow_name, shadow_2x)

    centre_x = sum(point[0] for point in quad) / 4.0
    centre_y = sum(point[1] for point in quad) / 4.0
    sample_x = int(round(centre_x))
    sample_y = int(round(centre_y))
    sample = body_1x[
        max(0, sample_y - 1) : sample_y + 2, max(0, sample_x - 1) : sample_x + 2, :3
    ]
    face_sample = [int(round(value)) for value in sample.reshape(-1, 3).mean(axis=0)]

    solid_body = alpha_bbox(body_1x[..., 3], 128)
    shadow_body_box = (
        shadow_pads["left"],
        shadow_pads["top"],
        shadow_pads["left"] + advance_width - 1,
        shadow_pads["top"] + advance_height - 1,
    )
    profile = alpha_profile(shadow_1x, shadow_body_box, shadow_pads)

    record = {
        "textureFile": f"shells/{texture_name}",
        "textureFile2x": f"shells/2x/{texture_name}",
        "shadowTextureFile": f"shells/{shadow_name}",
        "shadowTextureFile2x": f"shells/2x/{shadow_name}",
        "shadowTexWidth": int(shadow_width),
        "shadowTexHeight": int(shadow_height),
        "shadowAnchorX": int(shadow_pads["left"]),
        "shadowAnchorY": int(shadow_pads["top"]),
        "shadowOffsetPx": [0, 0],
        "shadowPadding": dict(shadow_pads),
        "texWidth": int(body_width),
        "texHeight": int(body_height),
        "anchorX": int(body_pads["left"]),
        "anchorY": int(body_pads["top"]),
        "advanceWidth": int(advance_width),
        "advanceHeight": int(advance_height),
        "padding": dict(body_pads),
        "shadowBlob": {
            "model": shadow["model"],
            "shape": shadow["shape"],
            "sigmaPx1x": shadow["sigmaPx1x"],
            "coreAlpha": shadow["coreAlpha"],
            "offsetPx1x": list(shadow["offsetPx1x"]),
            "colorHex": shadow["colorHex"],
            "lying": lying,
        },
        "faceRotationDeg": shell["faceRotationDeg"],
        "faceQuad": quad,
        "faceQuadOrder": "face-local [top-left, top-right, bottom-right, bottom-left]",
        "gridStepPx": grid_steps_from_axes(width_axis, height_axis),
        **(
            {
                "stackCount": int(spec["tile"]["stack"]["count"]),
                "stackStepPx": stack_step,
                "stackStepNote": (
                    "Add this to the lower tier's body top-left to place the upper tier of the same wall "
                    "column. It is the projected tile thickness, so it points straight up."
                ),
            }
            if stack_step is not None
            else {}
        ),
        "projection": shell["projection"],
        "faceUp": shell["camera"]["faceLocalZ"] == "top",
        **(
            {"wallSlot": dict(shell["wallSlot"])}
            if "wallSlot" in shell
            else {}
        ),
        **(
            {"handSlot": dict(shell["handSlot"])}
            if "handSlot" in shell
            else {}
        ),
        **(
            {"topHandSlot": dict(shell["topHandSlot"])}
            if "topHandSlot" in shell
            else {}
        ),
        "pose": dict(shell["pose"]),
        "camera": {
            "azimuthDeg": shell["camera"]["azimuthDeg"],
            "elevationDeg": shell["camera"]["elevationDeg"],
            "faceLocalZ": shell["camera"]["faceLocalZ"],
            "projection": framing.get("projection", "orthographic"),
            **(
                {
                    "lensMm": framing["lensMm"],
                    "shiftX": framing["shiftX"],
                    "shiftY": framing["shiftY"],
                    "lateralOffsetUnits": framing["lateralOffsetUnits"],
                    "distanceUnits": framing["distanceUnits"],
                }
                if framing.get("projection") == "perspective"
                else {"orthoScale": framing["orthoScale"]}
            ),
            "pixelsPerUnit2x": framing["pixelsPerUnit2x"],
            "resolution1x": framing["resolution1x"],
            "resolution2x": framing["resolution2x"],
        },
        "measured": {
            "alphaExtent1x": profile["extentPx"],
            "alphaPeak1x": profile["peakAlpha"],
            "alphaMass1x": profile["mass"],
            "shadowMaxAlpha": round(float(shadow_1x[..., 3].max()) / 255.0, 4),
            "contactQuadPx": [[round(x, 2), round(y, 2)] for x, y in contact_local],
            "solidInset1x": [
                solid_body[0] - body_pads["left"],
                solid_body[1] - body_pads["top"],
                body_pads["left"] + advance_width - 1 - solid_body[2],
                body_pads["top"] + advance_height - 1 - solid_body[3],
            ],
            "faceSampleRgb": face_sample,
            "edgeSamplesRgb": edge_samples(
                body_1x,
                (
                    body_pads["left"],
                    body_pads["top"],
                    body_width - body_pads["right"] - 1,
                    body_height - body_pads["bottom"] - 1,
                ),
            ),
            "bytes1x": int((output_dir / texture_name).stat().st_size)
            + int((output_dir / shadow_name).stat().st_size),
            "bytes2x": int((output_dir_2x / texture_name).stat().st_size)
            + int((output_dir_2x / shadow_name).stat().st_size),
        },
    }
    if record_hashes:
        record["sha256"] = {
            "decodedRgba1x": rgba_sha256(body_1x),
            "decodedRgba2x": rgba_sha256(body_2x),
        }
        record["shadowSha256"] = {
            "decodedRgba1x": rgba_sha256(shadow_1x),
            "decodedRgba2x": rgba_sha256(shadow_2x),
        }
    log(
        f"{shell['id']}: body {body_width}x{body_height} + shadow "
        f"{shadow_width}x{shadow_height} @1x, "
        f"(advance {advance_width}x{advance_height}, anchor {body_pads['left']},{body_pads['top']}), "
        f"blob extent L{profile['extentPx']['left']}/T{profile['extentPx']['top']}/"
        f"R{profile['extentPx']['right']}/B{profile['extentPx']['bottom']}, "
        f"quad {quad[0]}..{quad[2]}"
    )
    return record


def grid_steps_from_axes(width_axis: list[float], height_axis: list[float]) -> dict:
    """Per-tile step along the tile's own width/height axes, in @1x px.

    ``advanceWidth/Height`` is the sprite's opaque *box* (it includes the 1 px
    anti-aliased ledge and the baked thickness extrusion). A tight pond row or
    wall run must step by the physical tile axis instead. The axes are projected
    through the face centre, so the perspective wall shells publish the centre
    line (the midline of the near/far edges) rather than one edge.
    """

    def orient(axis: list[float]) -> list[float]:
        # A screen-space layout wants one tile to the right and one tile down.
        # Face-down shells are flipped 180° about X (their local +Y projects
        # upward) and the sideways shell is rotated 90°, so orient whichever
        # component dominates: horizontal axes point right, vertical axes point
        # down. The glyph's own orientation stays faceRotationDeg's job.
        if abs(axis[1]) >= abs(axis[0]):
            return [-axis[0], -axis[1]] if axis[1] < 0 else axis
        return [-axis[0], -axis[1]] if axis[0] < 0 else axis

    width_axis = orient(list(width_axis))
    height_axis = orient(list(height_axis))

    def nice(value: float) -> float:
        return 0.0 if abs(value) < 5e-9 else round(value, 2)

    return {
        "x": [nice(width_axis[0]), nice(width_axis[1])],
        "y": [nice(height_axis[0]), nice(height_axis[1])],
    }


def expected_aspect(shell: dict, advance_width: int, advance_height: int) -> None:
    expected = shell.get("expectProjection")
    if expected == "portrait" and advance_height <= advance_width:
        die(
            f"{shell['id']} should project portrait, got {advance_width}x{advance_height}; "
            "check pose.rotateZDeg"
        )
    if expected == "landscape" and advance_width <= advance_height:
        die(
            f"{shell['id']} should project landscape, got {advance_width}x{advance_height}; "
            "check pose.rotateZDeg"
        )


def shell_plan(spec: dict) -> None:
    log(f"shell plan ({len(spec['shells'])} canonical shells):")
    for shell in spec["shells"]:
        camera = shell["camera"]
        log(
            f"  {shell['id']}: {shell['projection']}, "
            f"camera az {camera['azimuthDeg']}° / el {camera['elevationDeg']}°, "
            f"face rotation {shell['faceRotationDeg']}° — {shell['role']}"
        )
    outputs = spec["outputs"]
    log(f"output dir: {outputs['shellDir']} (+ {outputs['shell2xDir']})")
    log(f"manifest:   {outputs['manifest']}")


def build_rig_metadata(spec: dict, rigs: dict) -> dict:
    """The audit trail shared by shells.json and the candidate manifest."""
    bake = spec["bake"]
    return {
        "blender": bpy.app.version_string,
        "engine": spec["scene"]["engine"],
        "device": spec["scene"]["device"],
        "samples": spec["scene"]["samples"],
        "adaptiveThreshold": spec["scene"]["adaptiveThreshold"],
        "denoiser": spec["scene"]["denoiser"],
        "seed": 0,
        "colorManagement": spec["scene"]["colorManagement"],
        "key": {
            "type": spec["lighting"]["key"]["type"],
            "referenceAzimuthDeg": spec["lighting"]["key"]["azimuthDeg"],
            "referenceElevationDeg": spec["lighting"]["key"]["elevationDeg"],
            "screenDirection": [round(v, 4) for v in screen_space_key(spec)],
            "distance": spec["lighting"]["key"]["distance"],
            "size": spec["lighting"]["key"]["size"],
            "sizeY": spec["lighting"]["key"]["sizeY"],
            "energyW": spec["lighting"]["key"]["energyW"],
            "hex": spec["lighting"]["key"]["hex"],
        },
        "world": spec["lighting"]["world"],
        "targetLongAxisPx1x": bake["targetLongAxisPx1x"],
        "shadowContract": bake.get("shadowContract"),
        "stack": spec["tile"].get("stack"),
        "baseScale": {
            "previousTargetLongAxisPx1x": bake["baseScale"]["previousTargetLongAxisPx1x"],
            "note": bake["baseScale"]["note"],
        },
        "shadow": {
            "model": bake["shadow"]["model"],
            "shape": bake["shadow"]["shape"],
            "sigmaPx1x": bake["shadow"]["sigmaPx1x"],
            "coreAlpha": bake["shadow"]["coreAlpha"],
            "offsetPx1x": list(bake["shadow"]["offsetPx1x"]),
            "colorHex": bake["shadow"]["colorHex"],
            "source": "synthetic Gaussian blob from the projected table-contact footprint",
        },
        "determinism": (
            "CPU Cycles, fixed seed 0, fixed adaptive threshold and OIDN. Each texture records "
            "the sha256 of its decoded RGBA; re-baking the same spec must reproduce it "
            "(bake_shells.py --bake --verify-determinism renders each shell twice; "
            "--audition --verify-determinism does the same for every candidate)."
        ),
        "shellRigs": rigs,
    }


def validate_audition(spec: dict) -> None:
    """Validate the candidate matrix before a single pixel is rendered."""
    audition = spec.get("audition")
    if not isinstance(audition, dict):
        die("shell-spec.json has no audition block")
    for key in ("outputDir", "sheetDir", "manifest", "shells"):
        if key not in audition:
            die(f"audition is missing {key!r}")
    ids = list(audition["shells"])
    if not ids:
        die("audition.shells is empty")
    catalogue = {shell["id"] for shell in spec["shells"]}
    extra = [shell_id for shell_id in ids if shell_id not in catalogue]
    if extra:
        die(f"audition names shells outside the catalogue: {extra}")
    for base_id, entry in audition["shells"].items():
        candidates = entry.get("candidates")
        if not isinstance(candidates, list) or not (3 <= len(candidates) <= 5):
            die(f"audition {base_id} needs 3-5 candidates, got {len(candidates) if isinstance(candidates, list) else 'none'}")
        seen = set()
        for candidate in candidates:
            for key in ("candidateId", "label", "pose", "camera"):
                if key not in candidate:
                    die(f"audition {base_id} candidate {candidate.get('candidateId', '?')} is missing {key!r}")
            candidate_id = candidate["candidateId"]
            if candidate_id in seen:
                die(f"audition {base_id} has duplicate candidate id {candidate_id!r}")
            seen.add(candidate_id)
            for key in ("azimuthDeg", "elevationDeg", "faceLocalZ"):
                if key not in candidate["camera"]:
                    die(f"audition {base_id}/{candidate_id} camera is missing {key!r}")
            if candidate["camera"]["faceLocalZ"] not in ("top", "bottom"):
                die(f"audition {base_id}/{candidate_id} camera.faceLocalZ must be 'top' or 'bottom'")
            if not (-90.0 <= float(candidate["camera"]["elevationDeg"]) <= 90.0):
                die(f"audition {base_id}/{candidate_id} elevation must be -90..90")
            for key in ("rotateXDeg", "rotateYDeg", "rotateZDeg"):
                candidate["pose"].setdefault(key, 0.0)


def audition_shell(base: dict, candidate: dict) -> dict:
    """A throwaway shell record for one candidate; the catalogue is never mutated."""
    return {
        "id": f"{base['id']}--{candidate['candidateId']}",
        "sourceShellId": base["id"],
        "projection": base["projection"],
        "faceRotationDeg": candidate.get("faceRotationDeg", base["faceRotationDeg"]),
        "role": f"Phase 1b audition candidate {candidate['candidateId']} for {base['id']}",
        "pose": dict(candidate["pose"]),
        "camera": dict(candidate["camera"]),
        "expectProjection": candidate.get("expectProjection", base.get("expectProjection")),
    }


def face_quad_size(quad: list[list[float]]) -> dict:
    """The projected face plate's pixel width/height: the foreshortening read."""
    width = math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1])
    height = math.hypot(quad[2][0] - quad[1][0], quad[2][1] - quad[1][1])
    return {
        "width": round(width, 2),
        "height": round(height, 2),
        "aspect": round(width / height, 3) if height else 0.0,
    }


def bake_audition(
    spec: dict,
    args: argparse.Namespace,
    scene: bpy.types.Scene,
    tile: bpy.types.Object,
    lights: list[bpy.types.Object],
    outputs: dict,
) -> int:
    """Render every candidate at the new base scale and write the review manifest."""
    audition = spec["audition"]
    review_dir = (RENDER_DIR / audition["sheetDir"]).resolve()
    candidate_dir = (RENDER_DIR / audition["outputDir"]).resolve()
    manifest_path = (RENDER_DIR / audition["manifest"]).resolve()
    texture_dir_1x = candidate_dir / "1x"
    texture_dir_2x = candidate_dir / "2x"
    temp_dir = outputs["intermediateDir"] / "audition"
    for directory in (review_dir, texture_dir_1x, texture_dir_2x, temp_dir):
        directory.mkdir(parents=True, exist_ok=True)

    bake = spec["bake"]
    long_axis = bake["targetLongAxisPx1x"]
    previous = bake["baseScale"]["previousTargetLongAxisPx1x"]
    log(
        f"audition: base long axis {long_axis} px @1x / "
        f"{long_axis * bake['pixelRatio']} px @2x (Phase 1 was {previous} px @1x)"
    )

    catalogue = {shell["id"]: shell for shell in spec["shells"]}
    audition_ids = [shell_id for shell_id in audition["shells"] if shell_id in catalogue]
    base_ids = [shell_id for shell_id in audition_ids if not args.only or shell_id in args.only]
    if args.only:
        log(f"development audition: only {base_ids} (candidate manifest will be partial)")
    recorded: dict[str, list[dict]] = {}
    rigs: dict[str, dict] = {}
    total_bytes = 0

    for base_id in base_ids:
        base_shell = catalogue[base_id]
        entry = audition["shells"][base_id]
        log(f"{base_id}: {len(entry['candidates'])} candidates")
        records = []
        for candidate in entry["candidates"]:
            shell = audition_shell(base_shell, candidate)
            pose_tile(tile, shell)
            camera, framing = build_shell_camera(scene, tile, shell, spec)
            aim_key(lights[0], camera, world_bbox_center(tile), spec)
            record = bake_shell(
                scene,
                tile,
                shell,
                spec,
                camera,
                framing,
                texture_dir_1x,
                texture_dir_2x,
                temp_dir,
            )
            expected_aspect(shell, record["advanceWidth"], record["advanceHeight"])
            quad_size = face_quad_size(record["faceQuad"])
            record["textureFile"] = f"candidates/1x/{shell['id']}.png"
            record["textureFile2x"] = f"candidates/2x/{shell['id']}.png"
            record["shadowTextureFile"] = f"candidates/1x/{shell['id']}-shadow.png"
            record["shadowTextureFile2x"] = f"candidates/2x/{shell['id']}-shadow.png"
            record["candidate"] = {
                "candidateId": candidate["candidateId"],
                "label": candidate["label"],
                "note": candidate.get("note"),
                "sourceShellId": base_id,
            }
            record["measured"]["faceQuadPx"] = quad_size
            total_bytes += record["measured"]["bytes1x"] + record["measured"]["bytes2x"]
            log(
                f"  {candidate['candidateId']} {candidate['label']}: "
                f"tex {record['texWidth']}x{record['texHeight']}, "
                f"advance {record['advanceWidth']}x{record['advanceHeight']}, "
                f"face {quad_size['width']:.1f}x{quad_size['height']:.1f} "
                f"(aspect {quad_size['aspect']:.2f}), "
                f"{record['measured']['bytes1x']}+{record['measured']['bytes2x']} B"
            )
            records.append(record)
            rigs[shell["id"]] = framing
            bpy.data.objects.remove(camera, do_unlink=True)
        recorded[base_id] = records

    if args.verify_determinism:
        log("determinism: rendering every candidate a second time")
        repeat_1x = temp_dir / "repeat-1x"
        repeat_2x = temp_dir / "repeat-2x"
        repeat_1x.mkdir(parents=True, exist_ok=True)
        repeat_2x.mkdir(parents=True, exist_ok=True)
        for base_id in base_ids:
            base_shell = catalogue[base_id]
            for candidate, record in zip(audition["shells"][base_id]["candidates"], recorded[base_id]):
                shell = audition_shell(base_shell, candidate)
                pose_tile(tile, shell)
                camera, framing = build_shell_camera(scene, tile, shell, spec)
                aim_key(lights[0], camera, world_bbox_center(tile), spec)
                repeat = bake_shell(
                    scene,
                    tile,
                    shell,
                    spec,
                    camera,
                    framing,
                    repeat_1x,
                    repeat_2x,
                    temp_dir,
                )
                same = same_decoded_rgba(repeat, record)
                log(
                    f"determinism {shell['id']}: "
                    f"{'identical decoded RGBA' if same else 'DIFFERS'} "
                    f"({record['sha256']['decodedRgba1x'][:16]} vs {repeat['sha256']['decodedRgba1x'][:16]})"
                )
                if not same:
                    die(f"{shell['id']} is not deterministic across renders")
                bpy.data.objects.remove(camera, do_unlink=True)

    manifest = {
        "version": 1,
        "generatedBy": "tools/render/bake_shells.py --audition",
        "partial": bool(args.only),
        "status": audition["status"],
        "deliverable": audition["deliverable"],
        "coordinateSpace": (
            "Exactly the shells.json contract: anchorX/anchorY, advanceWidth/advanceHeight, "
            "padding and faceQuad are CSS px of the @1x texture with a top-left origin; the @2x "
            "texture is pixelRatio times that. These candidates are proposals, not the committed "
            "catalogue."
        ),
        "base": {
            "targetLongAxisPx1x": long_axis,
            "targetLongAxisPx2x": long_axis * int(bake["pixelRatio"]),
            "previousTargetLongAxisPx1x": previous,
            "pixelRatio": int(bake["pixelRatio"]),
        },
        "padding1x": dict(bake["padding1x"]),
        "pixelRatio": int(bake["pixelRatio"]),
        "rig": build_rig_metadata(spec, rigs),
        "shells": {
            base_id: {
                "question": audition["shells"][base_id].get("question"),
                "reference": {
                    "source": "frontend/public/table/shells.json",
                    "shellId": base_id,
                    "textureFile": f"shells/{base_id}.png",
                    "pose": dict(catalogue[base_id]["pose"]),
                    "camera": {
                        "azimuthDeg": catalogue[base_id]["camera"]["azimuthDeg"],
                        "elevationDeg": catalogue[base_id]["camera"]["elevationDeg"],
                    },
                },
                "candidates": records,
            }
            for base_id, records in recorded.items()
        },
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    log(
        f"wrote {sum(len(r) for r in recorded.values())} candidate shells, "
        f"{total_bytes} B of textures, to {candidate_dir} and {manifest_path}"
    )
    return 0


def bake_shadow_audition(
    spec: dict,
    args: argparse.Namespace,
    scene: bpy.types.Scene,
    tile: bpy.types.Object,
    lights: list[bpy.types.Object],
    outputs: dict,
) -> int:
    """Render the shadow strength/shape/falloff candidates on fixed shells."""
    block = spec["shadowAudition"]
    base_dir = (RENDER_DIR / block["outputDir"]).resolve()
    sheet_dir = (RENDER_DIR / block["sheetDir"]).resolve()
    manifest_path = (RENDER_DIR / block["manifest"]).resolve()
    temp_dir = outputs["intermediateDir"] / "shadow-audition"
    for directory in (base_dir, sheet_dir, temp_dir):
        directory.mkdir(parents=True, exist_ok=True)

    catalogue = {shell["id"]: shell for shell in spec["shells"]}
    missing = [shell_id for shell_id in block["shells"] if shell_id not in catalogue]
    if missing:
        die(f"shadowAudition names shells outside the catalogue: {missing}")
    variants = [
        {
            "id": "REF",
            "label": "REF COMMITTED",
            "note": "the committed shadow",
            "shadow": dict(spec["bake"]["shadow"]),
        }
    ] + list(block["variants"])
    recorded = []
    for variant in variants:
        variant_id = variant["id"]
        v_shadow = {**spec["bake"]["shadow"], **variant.get("shadow", {})}
        v_bake = {**spec["bake"], "shadow": v_shadow}
        v_spec = {**spec, "bake": v_bake}
        shells = {}
        log(
            f"shadow {variant_id}: sigma {v_shadow['sigmaPx1x']} px, "
            f"core {v_shadow['coreAlpha']}, offset {v_shadow['offsetPx1x']}, "
            f"pad {v_shadow['padding1x']['right']}"
        )
        for shell_id in block["shells"]:
            shell = catalogue[shell_id]
            out_1x = base_dir / variant_id / "1x"
            out_2x = base_dir / variant_id / "2x"
            pose_tile(tile, shell)
            camera, framing = build_shell_camera(scene, tile, shell, v_spec)
            aim_key(lights[0], camera, world_bbox_center(tile), v_spec)
            record = bake_shell(
                scene,
                tile,
                shell,
                v_spec,
                camera,
                framing,
                out_1x,
                out_2x,
                temp_dir,
            )
            expected_aspect(shell, record["advanceWidth"], record["advanceHeight"])
            record["textureFile"] = f"shadows/{variant_id}/1x/{shell_id}.png"
            record["textureFile2x"] = f"shadows/{variant_id}/2x/{shell_id}.png"
            record["shadowTextureFile"] = f"shadows/{variant_id}/1x/{shell_id}-shadow.png"
            record["shadowTextureFile2x"] = f"shadows/{variant_id}/2x/{shell_id}-shadow.png"
            record["shadowVariant"] = {
                "id": variant_id,
                "label": variant["label"],
                "shadow": dict(v_shadow),
            }
            shells[shell_id] = record
            bpy.data.objects.remove(camera, do_unlink=True)
        recorded.append(
            {
                "id": variant_id,
                "label": variant["label"],
                "note": variant.get("note"),
                "shadow": dict(v_shadow),
                "shells": shells,
            }
        )

    manifest = {
        "version": 1,
        "generatedBy": "tools/render/bake_shells.py --shadow-audition",
        "status": block["status"],
        "deliverable": block["deliverable"],
        "pixelRatio": int(spec["bake"]["pixelRatio"]),
        "base": {
            "targetLongAxisPx1x": spec["bake"]["targetLongAxisPx1x"],
            "targetLongAxisPx2x": spec["bake"]["targetLongAxisPx1x"] * int(spec["bake"]["pixelRatio"]),
        },
        "variants": recorded,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    log(
        f"wrote {len(recorded) * len(block['shells'])} shadow variants to {base_dir} and {manifest_path}"
    )
    return 0


def resolve_outputs(spec_path: Path, spec: dict) -> dict:
    root = spec_path.resolve().parent
    return {
        "shellDir": (root / spec["outputs"]["shellDir"]).resolve(),
        "shell2xDir": (root / spec["outputs"]["shell2xDir"]).resolve(),
        "manifest": (root / spec["outputs"]["manifest"]).resolve(),
        "intermediateDir": (root / spec["outputs"]["intermediateDir"]).resolve(),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, default=DEFAULT_SPEC)
    parser.add_argument(
        "--bake",
        action="store_true",
        help="render the catalogue at 1x and 2x, measure it and write shells.json",
    )
    parser.add_argument(
        "--audition",
        action="store_true",
        help="render the candidate matrix under build/review/; never touches the committed shells",
    )
    parser.add_argument(
        "--shadow-audition",
        action="store_true",
        help="render the blob sigma/core-alpha/offset candidates under build/review/shadows/",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="build the tile/material/lights, print the plan, write nothing",
    )
    parser.add_argument(
        "--preview",
        action="store_true",
        help="with --bake, write under build/preview/ instead of the committed assets",
    )
    parser.add_argument(
        "--verify-determinism",
        action="store_true",
        help="with --bake/--audition, render everything a second time and compare decoded RGBA",
    )
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        metavar="SHELL_ID",
        help="development aid: bake only the named shell(s), leaving shells.json incomplete",
    )
    args = parser.parse_args(blender_args(argv))

    spec = load_spec(args.spec)
    expand_hand_slots(spec)
    expand_top_hand_slots(spec)
    expand_wall_slots(spec)
    check_blender_version(spec)
    validate_shell_catalogue(spec)
    if args.audition:
        validate_audition(spec)
    resolve_tile_dimensions(spec)

    scene = reset_scene()
    configure_render(scene, spec)
    build_world(scene, spec)
    tile = build_tile(scene, spec)
    lights = build_lights(scene, spec)
    outputs = resolve_outputs(args.spec, spec)
    if args.preview:
        preview = RENDER_DIR / "build" / "preview"
        outputs = {
            "shellDir": preview / "shells",
            "shell2xDir": preview / "shells" / "2x",
            "manifest": preview / "shells.json",
            "intermediateDir": preview / "intermediate",
        }

    log(
        f"tile body built: {len(tile.data.polygons)} polygons, "
        f"material {tile.data.materials[0].name!r}, "
        f"modifiers {[modifier.type for modifier in tile.modifiers]}"
    )
    shell_plan(spec)

    if args.dry_run or not (args.bake or args.audition or args.shadow_audition):
        log("dry run: no shells written")
        return 0
    if args.bake and args.audition:
        die("--bake and --audition are separate runs; pick one")
    if args.shadow_audition and (args.bake or args.audition):
        die("--shadow-audition is its own mode; do not combine it with --bake/--audition")
    if not spec.get("bakeImplemented"):
        die(
            "bakeImplemented is false: implement build_shell_camera/bake_shell and "
            "flip this flag in shell-spec.json before baking."
        )

    outputs["shellDir"].mkdir(parents=True, exist_ok=True)
    outputs["shell2xDir"].mkdir(parents=True, exist_ok=True)
    outputs["intermediateDir"].mkdir(parents=True, exist_ok=True)

    if args.shadow_audition:
        return bake_shadow_audition(spec, args, scene, tile, lights, outputs)
    if args.audition:
        return bake_audition(spec, args, scene, tile, lights, outputs)

    records = {}
    rigs = {}
    selected = [shell for shell in spec["shells"] if not args.only or shell["id"] in args.only]
    if args.only:
        log(f"development bake: only {[shell['id'] for shell in selected]} (manifest will be partial)")
    for shell in selected:
        pose_tile(tile, shell)
        camera, framing = build_shell_camera(scene, tile, shell, spec)
        aim_key(lights[0], camera, world_bbox_center(tile), spec)
        record = bake_shell(
            scene,
            tile,
            shell,
            spec,
            camera,
            framing,
            outputs["shellDir"],
            outputs["shell2xDir"],
            outputs["intermediateDir"],
        )
        expected_aspect(shell, record["advanceWidth"], record["advanceHeight"])
        records[shell["id"]] = record
        rigs[shell["id"]] = framing
        bpy.data.objects.remove(camera, do_unlink=True)

    if args.verify_determinism:
        log("determinism: rendering every shell a second time")
        for shell in selected:
            pose_tile(tile, shell)
            camera, framing = build_shell_camera(scene, tile, shell, spec)
            aim_key(lights[0], camera, world_bbox_center(tile), spec)
            repeat_dir = outputs["intermediateDir"] / "repeat"
            repeat_2x = outputs["intermediateDir"] / "repeat-2x"
            repeat_dir.mkdir(parents=True, exist_ok=True)
            repeat_2x.mkdir(parents=True, exist_ok=True)
            repeat = bake_shell(
                scene,
                tile,
                shell,
                spec,
                camera,
                framing,
                repeat_dir,
                repeat_2x,
                outputs["intermediateDir"],
            )
            record = records[shell["id"]]
            same = same_decoded_rgba(repeat, record)
            log(
                f"determinism {shell['id']}: "
                f"{'identical decoded RGBA' if same else 'DIFFERS'} "
                f"({record['sha256']['decodedRgba2x'][:16]} vs {repeat['sha256']['decodedRgba2x'][:16]})"
            )
            if not same:
                die(f"{shell['id']} is not deterministic across renders")
            bpy.data.objects.remove(camera, do_unlink=True)

    bake = spec["bake"]
    manifest = {
        "version": 1,
        "generatedBy": "tools/render/bake_shells.py",
        "pixelRatio": int(bake["pixelRatio"]),
        "coordinateSpace": (
            "anchorX/anchorY, advanceWidth/advanceHeight, padding and faceQuad are CSS px of "
            "the @1x texture, with a top-left origin. textureFile2x is the same shell at "
            "pixelRatio times the resolution; divide its pixels by pixelRatio to get the same "
            "coordinates."
        ),
        "rig": build_rig_metadata(spec, rigs),
        "shells": records,
    }
    outputs["manifest"].write_text(json.dumps(manifest, indent=2) + "\n")
    log(f"wrote {len(records)} shells to {outputs['shellDir']} (+2x) and {outputs['manifest']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
