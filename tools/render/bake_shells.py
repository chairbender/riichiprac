#!/usr/bin/env python3
"""Shell baker for the 2.5D rendered view.

The active architecture is ``2_5d_mahjong_tile_rendering_architecture.md``.
Six blank tile **shells** are baked offline; 2D face glyphs are composited into
each shell's ``faceQuad`` at runtime. There is no table model and no single
perspective scene camera: every shell is its own orthographic projection.

The baker owns:

* the pinned Blender version check;
* the jansou tile proportions and the 0.055 / 6-segment bevel;
* the tile body as **one material** whose white/blue melamine split is gated on
  the object's local Z (ported from the retired 2.5 branch, commit 919e9fd);
* one area key locked to **screen-space** top-left-front plus a weak world fill,
  re-expressed in each shell camera's basis so every projection gets its
  highlights top/left and its shadow bottom/right;
* one orthographic camera per shell (front elevation, near-top-down, fixed
  oblique cabinet for the side walls);
* a Cycles shadow-catcher pass under the mesh whose alpha is clamped to the
  declared 3-4 px right/bottom margin and normalised to the spec's shadow
  strength, plus a 1-2 px top/left ambient-occlusion fringe;
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

A dry run builds the tile, material and lights, prints the shell plan, and
writes nothing. ``--bake`` renders the six shells, writes both scales and the
manifest. ``--verify-determinism`` renders every shell twice and compares the
decoded RGBA, which is the re-render determinism contract.

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


def build_shadow_catcher(scene: bpy.types.Scene, spec: dict) -> bpy.types.Object:
    """The shadow-catcher plane directly under the mesh, per the architecture."""
    bpy.ops.mesh.primitive_plane_add(size=12.0, location=(0.0, 0.0, 0.0))
    plane = bpy.context.object
    plane.name = "shadow-catcher"
    plane.is_shadow_catcher = bool(spec["bake"]["shadowCatcher"])
    plane.visible_shadow = True
    return plane


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
    """Rotate the tile into place and drop it onto the shadow-catcher plane."""
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


def render_pass(scene: bpy.types.Scene, path: Path, catcher: bpy.types.Object, visible: bool) -> None:
    catcher.hide_render = not visible
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


def smoothstep(value: np.ndarray) -> np.ndarray:
    clipped = np.clip(value, 0.0, 1.0)
    return clipped * clipped * (3.0 - 2.0 * clipped)


def padded_falloff(beyond_x: np.ndarray, pad_x: int, beyond_y: np.ndarray, pad_y: int) -> np.ndarray:
    """2D falloff over the padded margin: 1 at the body edge, 0 on the padded corner.

    Both axes contribute, so the shadow tapers at the bottom-right corner of the
    margin instead of running at full strength into the texture border.
    """
    distance_x = np.maximum(0, beyond_x)
    distance_y = np.maximum(0, beyond_y)
    t = np.maximum(distance_x / max(1, pad_x), distance_y / max(1, pad_y))
    active = (distance_x > 0) | (distance_y > 0)
    return np.where(active, 1.0 - smoothstep(t), 0.0)


def box_blur(field: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return field
    total = np.zeros_like(field)
    count = 0
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            total += np.roll(np.roll(field, dy, axis=0), dx, axis=1)
            count += 1
    return total / count


def outside_distance(mask: np.ndarray, band: int) -> np.ndarray:
    """8-neighbour distance in px from the outside of ``mask``, up to ``band``."""
    distance = np.where(mask, 0.0, np.inf)
    current = mask.copy()
    for step in range(1, band + 1):
        grown = current.copy()
        grown[1:, :] |= current[:-1, :]
        grown[:-1, :] |= current[1:, :]
        grown[:, 1:] |= current[:, :-1]
        grown[:, :-1] |= current[:, 1:]
        grown[1:, 1:] |= current[:-1, :-1]
        grown[1:, :-1] |= current[:-1, 1:]
        grown[:-1, 1:] |= current[1:, :-1]
        grown[:-1, :-1] |= current[1:, 1:]
        distance[grown & ~current] = float(step)
        current = grown
    return distance


def compose_shell(
    tile: np.ndarray,
    catcher: np.ndarray,
    pads_1x: dict,
    spec: dict,
    scale: int,
) -> tuple[np.ndarray, tuple[int, int, int, int], dict]:
    """Composite the tile over a clamped contact shadow and an AO fringe.

    The declared body box is the alpha >= 0.5 silhouette grown by
    ``edgeLedgePx`` so the tile's own anti-aliased contact edge is body, not
    margin. Without that ledge a 0.4-alpha silhouette pixel would be
    indistinguishable from a 0.33-alpha shadow pixel and the 3-4 px / 1-2 px
    padding contract could not be measured from the exported PNG.
    """
    bake = spec["bake"]
    height, width = tile.shape[:2]
    alpha = tile[..., 3]
    solid = alpha_bbox(alpha)
    ledge = int(bake.get("edgeLedgePx", 1)) * scale
    x0, y0, x1, y1 = (
        solid[0] - ledge,
        solid[1] - ledge,
        solid[2] + ledge,
        solid[3] + ledge,
    )
    if x0 < 0 or y0 < 0 or x1 >= width or y1 >= height:
        die("the tile silhouette touches the render frame; raise bake.frameMarginPx2x")
    ys, xs = np.mgrid[0:height, 0:width]

    outside = alpha < 0.5
    right = pads_1x["right"] * scale
    bottom = pads_1x["bottom"] * scale
    left = pads_1x["left"] * scale
    top = pads_1x["top"] * scale

    beyond_right = np.maximum(0, xs - x1)
    beyond_bottom = np.maximum(0, ys - y1)
    beyond_left = np.maximum(0, x0 - xs)
    beyond_top = np.maximum(0, y0 - ys)

    shadow_window = padded_falloff(beyond_right, right, beyond_bottom, bottom)
    shadow_window = np.where(outside, shadow_window, 0.0)

    physical = catcher[..., 3] * shadow_window
    blur = int(bake["shadow"].get("blurPx2x", 0)) * scale
    physical = box_blur(physical, blur) * shadow_window
    physical = np.where(outside, physical, 0.0)
    peak = float(physical.max())
    if peak < 0.02:
        die("the shadow catcher contributed no usable shadow (check the key and the catcher plane)")
    physical /= peak
    floor = float(bake["shadow"]["contactFloor"]) * shadow_window
    shape = np.maximum(physical, floor)

    # Normalise each padded side separately: the overhang must peak at
    # shadow.peakAlpha on the right and on the bottom even when the catcher
    # shadow is weaker below (a standing tile's felt shadow is nearly edge-on).
    right_band = shape * (xs > x1)
    bottom_band = shape * (ys > y1)
    right_peak = float(right_band.max())
    bottom_peak = float(bottom_band.max())
    if right_peak <= 0.0 or bottom_peak <= 0.0:
        die("the shadow has no support on the right/bottom padded side")
    shadow_shape = np.maximum(right_band / right_peak, bottom_band / bottom_peak)
    shadow_alpha = shadow_shape * float(bake["shadow"]["peakAlpha"])

    ao_window = padded_falloff(beyond_left, left, beyond_top, top)
    band = max(left, top)
    ring = 1.0 - smoothstep((outside_distance(~outside, band) - 1.0) / max(1.0, band))
    ao = np.where(outside, ao_window * ring, 0.0)
    left_band = ao * (xs < x0)
    top_band = ao * (ys < y0)
    left_peak = float(left_band.max())
    top_peak = float(top_band.max())
    if left_peak <= 0.0 or top_peak <= 0.0:
        die("the ambient-occlusion fringe has no support on the top/left padded side")
    ao_shape = np.maximum(left_band / left_peak, top_band / top_peak)
    ao_alpha = ao_shape * float(bake["ambientOcclusion"]["peakAlpha"])

    tile_alpha = alpha
    tile_rgb = tile[..., :3]
    shadow_rgb = hex_srgb(bake["shadow"]["colorHex"])
    ao_rgb = hex_srgb(bake["ambientOcclusion"]["colorHex"])

    out_alpha = (
        tile_alpha
        + (1.0 - tile_alpha) * shadow_alpha
        + (1.0 - tile_alpha) * (1.0 - shadow_alpha) * ao_alpha
    )
    premultiplied = (
        tile_rgb * tile_alpha[..., None]
        + shadow_rgb * (shadow_alpha * (1.0 - tile_alpha))[..., None]
        + ao_rgb * (ao_alpha * (1.0 - tile_alpha) * (1.0 - shadow_alpha))[..., None]
    )
    rgb = premultiplied / np.maximum(out_alpha, 1e-6)[..., None]
    composed = np.concatenate([rgb, out_alpha[..., None]], axis=2)

    stats = {
        "bodyBBox1x": [x0, y0, x1 - x0 + 1, y1 - y0 + 1],
        "solidInset1x": [solid[0] - x0, solid[1] - y0, x1 - solid[2], y1 - solid[3]],
        "shadowCatcherPeak": round(peak, 4),
        "shadowPeakAlpha": round(float(shadow_alpha.max()), 4),
        "aoPeakAlpha": round(float(ao_alpha.max()), 4),
    }
    return composed, (x0, y0, x1, y1), stats


def alpha_profile(rgba: np.ndarray, bbox: tuple[int, int, int, int], pads: dict) -> dict:
    """Measured nonzero-alpha extent, peak and mass per padded side (@1x px).

    Extents are measured over each half-space (corners included, because a
    directional shadow really does reach furthest diagonally). Peaks and mass
    are measured over the non-corner band of each side so the top/left
    ambient-occlusion fringe is not confused with the bottom/right drop shadow.
    """
    x0, y0, x1, y1 = bbox
    alpha = rgba[..., 3].astype(np.float64) / 255.0
    height, width = alpha.shape
    ys, xs = np.mgrid[0:height, 0:width]
    outside = alpha < 0.5
    visible = (alpha > 2.0 / 255.0) & outside

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
        mask = cores[side] & outside
        peak[side] = round(float(alpha[mask].max()), 4) if mask.any() else 0.0
        mass[side] = round(float(alpha[mask].sum()), 3)
    return {
        "extentPx": extent,
        "peakAlpha": peak,
        "mass": mass,
        "padding": dict(pads),
    }


def edge_samples(rgba: np.ndarray, bbox: tuple[int, int, int, int]) -> dict:
    """Mean RGB of the top and bottom body edges: the two-tone resin seam."""
    x0, y0, x1, y1 = bbox
    left = x0 + (x1 - x0) * 3 // 10
    right = x0 + (x1 - x0) * 7 // 10
    top = rgba[y0 : y0 + 2, left:right, :3].reshape(-1, 3).mean(axis=0)
    bottom = rgba[y1 - 1 : y1 + 1, left:right, :3].reshape(-1, 3).mean(axis=0)
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


def bake_shell(
    scene: bpy.types.Scene,
    tile: bpy.types.Object,
    shell: dict,
    spec: dict,
    camera: bpy.types.Object,
    framing: dict,
    catcher: bpy.types.Object,
    output_dir: Path,
    output_dir_2x: Path,
    temp_dir: Path,
    record_hashes: bool = True,
) -> dict:
    """Pose/render one shell at @1x and @2x, measure it, write both textures."""
    bake = spec["bake"]
    scale_2x = int(bake["pixelRatio"])
    pads = bake["padding1x"]

    renders = {}
    for scale in (1, scale_2x):
        width = framing["resolution1x"][0] * scale
        height = framing["resolution1x"][1] * scale
        set_resolution(scene, width, height)
        tag = f"{scale}x"
        tile_path = temp_dir / f"{shell['id']}_{tag}_tile.png"
        catcher_path = temp_dir / f"{shell['id']}_{tag}_catcher.png"
        render_pass(scene, tile_path, catcher, False)
        render_pass(scene, catcher_path, catcher, True)
        tile_rgba = load_rgba(tile_path)
        catcher_rgba = load_rgba(catcher_path)
        composed, bbox, stats = compose_shell(tile_rgba, catcher_rgba, pads, spec, scale)
        renders[scale] = {
            "composed": composed,
            "bbox": bbox,
            "stats": stats,
            "size": (width, height),
        }

    base = renders[1]
    bx0, by0, bx1, by1 = base["bbox"]
    advance_width = bx1 - bx0 + 1
    advance_height = by1 - by0 + 1
    crop_x = bx0 - pads["left"]
    crop_y = by0 - pads["top"]
    texture_width = advance_width + pads["left"] + pads["right"]
    texture_height = advance_height + pads["top"] + pads["bottom"]
    texture_1x = quantize(frame_fade(crop(base["composed"], crop_x, crop_y, texture_width, texture_height), 1.0))

    big = renders[scale_2x]
    texture_2x = quantize(
        frame_fade(
            crop(
                big["composed"],
                crop_x * scale_2x,
                crop_y * scale_2x,
                texture_width * scale_2x,
                texture_height * scale_2x,
            ),
            float(scale_2x),
        )
    )

    # faceQuad is measured on the @1x frame so it lands in the @1x texture's
    # coordinate space, which is the manifest's coordinate space.
    set_resolution(scene, framing["resolution1x"][0], framing["resolution1x"][1])
    quad = [
        [round(x - crop_x, 2), round(y - crop_y, 2)]
        for x, y in face_quad(scene, camera, tile, shell, spec)
    ]

    texture_name = f"{shell['id']}.png"
    encode_png(output_dir / texture_name, texture_1x)
    encode_png(output_dir_2x / texture_name, texture_2x)

    centre_x = sum(point[0] for point in quad) / 4.0
    centre_y = sum(point[1] for point in quad) / 4.0
    sample_x = int(round(centre_x))
    sample_y = int(round(centre_y))
    sample = texture_1x[
        max(0, sample_y - 1) : sample_y + 2, max(0, sample_x - 1) : sample_x + 2, :3
    ]
    face_sample = [int(round(value)) for value in sample.reshape(-1, 3).mean(axis=0)]

    profile = alpha_profile(
        texture_1x,
        (
            pads["left"],
            pads["top"],
            texture_width - pads["right"] - 1,
            texture_height - pads["bottom"] - 1,
        ),
        pads,
    )
    record = {
        "textureFile": f"shells/{texture_name}",
        "textureFile2x": f"shells/2x/{texture_name}",
        "texWidth": int(texture_width),
        "texHeight": int(texture_height),
        "anchorX": int(pads["left"]),
        "anchorY": int(pads["top"]),
        "advanceWidth": int(advance_width),
        "advanceHeight": int(advance_height),
        "padding": dict(pads),
        "faceRotationDeg": shell["faceRotationDeg"],
        "faceQuad": quad,
        "faceQuadOrder": "face-local [top-left, top-right, bottom-right, bottom-left]",
        "gridStepPx": grid_steps(quad, spec),
        "projection": shell["projection"],
        "pose": dict(shell["pose"]),
        "camera": {
            "azimuthDeg": shell["camera"]["azimuthDeg"],
            "elevationDeg": shell["camera"]["elevationDeg"],
            "orthoScale": framing["orthoScale"],
            "pixelsPerUnit2x": framing["pixelsPerUnit2x"],
            "resolution1x": framing["resolution1x"],
            "resolution2x": framing["resolution2x"],
        },
        "measured": {
            "alphaExtent1x": profile["extentPx"],
            "alphaPeak1x": profile["peakAlpha"],
            "alphaMass1x": profile["mass"],
            "shadowCatcherPeak": base["stats"]["shadowCatcherPeak"],
            "solidInset1x": base["stats"]["solidInset1x"],
            "faceSampleRgb": face_sample,
            "edgeSamplesRgb": edge_samples(
                texture_1x,
                (
                    pads["left"],
                    pads["top"],
                    texture_width - pads["right"] - 1,
                    texture_height - pads["bottom"] - 1,
                ),
            ),
            "bytes1x": int((output_dir / texture_name).stat().st_size),
            "bytes2x": int((output_dir_2x / texture_name).stat().st_size),
        },
    }
    if record_hashes:
        record["sha256"] = {
            "decodedRgba1x": rgba_sha256(texture_1x),
            "decodedRgba2x": rgba_sha256(texture_2x),
        }
    log(
        f"{shell['id']}: {texture_width}x{texture_height} @1x "
        f"(advance {advance_width}x{advance_height}, anchor {pads['left']},{pads['top']}), "
        f"extent L{profile['extentPx']['left']}/T{profile['extentPx']['top']}/"
        f"R{profile['extentPx']['right']}/B{profile['extentPx']['bottom']}, "
        f"quad {quad[0]}..{quad[2]}"
    )
    return record


def grid_steps(quad: list[list[float]], spec: dict) -> dict:
    """Per-tile step along the tile's own width/height axes, in @1x px.

    ``advanceWidth/Height`` is the sprite's opaque *box* (it includes the 1 px
    anti-aliased ledge and the baked thickness extrusion). A tight pond row or
    wall run must step by the physical tile axis instead, so this projects the
    full tile width/height from the inset ``faceQuad``.
    """
    tile_spec = spec["tile"]
    inset = tile_spec["faceInset"]
    face_width = tile_spec["width"] - 2 * inset
    face_height = tile_spec["height"] - 2 * inset
    width_axis = [quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]]
    height_axis = [quad[0][0] - quad[3][0], quad[0][1] - quad[3][1]]
    width_axis = [value * tile_spec["width"] / face_width for value in width_axis]
    height_axis = [value * tile_spec["height"] / face_height for value in height_axis]

    def orient(axis: list[float]) -> list[float]:
        # A screen-space layout wants one tile to the right and one tile down.
        # Face-down shells are flipped 180° about X (their local +Y projects
        # upward) and the sideways shell is rotated 90°, so orient whichever
        # component dominates: horizontal axes point right, vertical axes point
        # down. The glyph's own orientation stays faceRotationDeg's job.
        if abs(axis[1]) >= abs(axis[0]):
            return [-axis[0], -axis[1]] if axis[1] < 0 else axis
        return [-axis[0], -axis[1]] if axis[0] < 0 else axis

    width_axis = orient(width_axis)
    height_axis = orient(height_axis)

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
        help="render the six shells at 1x and 2x, measure them and write shells.json",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="build the tile/material/lights, print the plan, write nothing",
    )
    parser.add_argument(
        "--verify-determinism",
        action="store_true",
        help="with --bake, render every shell a second time and compare decoded RGBA",
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
    check_blender_version(spec)
    validate_shell_catalogue(spec)
    resolve_tile_dimensions(spec)

    scene = reset_scene()
    configure_render(scene, spec)
    build_world(scene, spec)
    tile = build_tile(scene, spec)
    lights = build_lights(scene, spec)
    catcher = build_shadow_catcher(scene, spec)
    outputs = resolve_outputs(args.spec, spec)

    log(
        f"tile body built: {len(tile.data.polygons)} polygons, "
        f"material {tile.data.materials[0].name!r}, "
        f"modifiers {[modifier.type for modifier in tile.modifiers]}"
    )
    shell_plan(spec)

    if args.dry_run or not args.bake:
        log("dry run: no shells written")
        return 0
    if not spec.get("bakeImplemented"):
        die(
            "bakeImplemented is false: implement build_shell_camera/bake_shell and "
            "flip this flag in shell-spec.json before baking."
        )

    outputs["shellDir"].mkdir(parents=True, exist_ok=True)
    outputs["shell2xDir"].mkdir(parents=True, exist_ok=True)
    outputs["intermediateDir"].mkdir(parents=True, exist_ok=True)

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
            catcher,
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
                catcher,
                repeat_dir,
                repeat_2x,
                outputs["intermediateDir"],
            )
            record = records[shell["id"]]
            same = repeat["sha256"] == record["sha256"]
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
        "rig": {
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
            "shadow": {
                "peakAlpha": bake["shadow"]["peakAlpha"],
                "colorHex": bake["shadow"]["colorHex"],
                "contactFloor": bake["shadow"]["contactFloor"],
                "source": "Cycles shadow-catcher alpha, clamped to padding.right/bottom",
            },
            "ambientOcclusion": {
                "peakAlpha": bake["ambientOcclusion"]["peakAlpha"],
                "colorHex": bake["ambientOcclusion"]["colorHex"],
                "source": "analytic fringe bounded by padding.top/left",
            },
            "determinism": (
                "CPU Cycles, fixed seed 0, fixed adaptive threshold and OIDN. Each texture records "
                "the sha256 of its decoded RGBA; re-baking the same spec must reproduce it "
                "(bake_shells.py --bake --verify-determinism renders each shell twice)."
            ),
            "shellRigs": rigs,
        },
        "shells": records,
    }
    outputs["manifest"].write_text(json.dumps(manifest, indent=2) + "\n")
    log(f"wrote {len(records)} shells to {outputs['shellDir']} (+2x) and {outputs['manifest']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
