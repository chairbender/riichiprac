#!/usr/bin/env python3
"""Build the rendered-table Blender scene from a JSON spec and bake the Task 1
spike assets: one hand-slot body sprite and one lit face decal.

Everything is constructed procedurally here. There is no hand-modelled or
hand-edited .blend file, and no manual Blender interaction: render.sh rasterises
the face SVG, then runs this script with the pinned Blender build, then
assembles the contact sheet.

    blender --background --python tools/render/build_and_render.py -- \\
        tools/render/scene-spec.json tools/render/spike

Outputs (paths relative to the output directory):
    hand-<i>.body.png        hand-slot body sprite, scene device pixels + shadow
    <code>-<orient>.decal.png lit face decal, inset face + 1 px transparent gutter
    <code>-<orient>.composite.png   body sprite with the decal homography-warped on
    contact-zoom.png         nearest zoom of the composite (review only)
    manifest.json            starter manifest (slot rect, face quad, faceMatrix)

Coordinate conventions: world units are tile units (see the spec); scene pixels
in the manifest are rendered device pixels (CSS size x pixelRatio), origin
top-left, y down. Body sprites are cropped to the slot's projected bounds plus
the shadow gutter, so a slot rect is exactly where the runtime draws the file.
"""

from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Matrix, Vector

RENDER_DIR = Path(__file__).resolve().parent


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def die(message: str) -> None:
    print(f"[render] ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def log(message: str) -> None:
    print(f"[render] {message}")


def check_blender_version(spec: dict) -> str:
    actual = bpy.app.version_string
    required = spec["blender"]["requiredVersion"]
    log(f"Blender {actual} (required {required})")
    if not actual.startswith(required):
        die(f"Blender {required} is required, found {actual}")
    return actual


def resolve_tile_dimensions(spec: dict) -> dict:
    """Derive the tile box from the jansou proportions.

    The spec owns the real-world ratio (28 x 21 x 16.5 mm, height x width x
    thickness) and one world height; width and thickness are computed so no
    hand-copied number can drift from the ratio.
    """
    tile = spec["tile"]
    proportions = tile["proportionsMm"]
    height = tile["heightUnits"]
    tile["height"] = height
    tile["width"] = height * proportions["width"] / proportions["height"]
    tile["thickness"] = height * proportions["thickness"] / proportions["height"]
    log(
        "tile: "
        f"{tile['height']:.5f} h x {tile['width']:.5f} w x {tile['thickness']:.5f} t units "
        f"(ratio {proportions['height']:g} x {proportions['width']:g} x "
        f"{proportions['thickness']:g} mm)"
    )
    return tile


def srgb_to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def hex_rgba(hex_colour: str) -> tuple[float, float, float, float]:
    value = hex_colour.lstrip("#")
    channels = [int(value[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]
    return (*channels, 1.0)


def hex_linear(hex_colour: str) -> tuple[float, float, float, float]:
    r, g, b, _ = hex_rgba(hex_colour)
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), 1.0)


def reset_scene() -> bpy.types.Scene:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


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


def aim(obj: bpy.types.Object, target) -> None:
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def sync_view_layer() -> None:
    """Flush object transforms; world_to_camera_view reads matrix_world."""
    bpy.context.view_layer.update()


# --------------------------------------------------------------------------- #
# Render configuration
# --------------------------------------------------------------------------- #


def configure_render(scene: bpy.types.Scene, spec: dict) -> None:
    render = scene.render
    cycle = spec["scene"]
    render.engine = cycle["engine"]
    scene.cycles.device = cycle["device"]
    scene.cycles.samples = cycle["samples"]
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.cycles.use_adaptive_sampling = cycle["useAdaptiveSampling"]
    scene.cycles.adaptive_threshold = cycle["adaptiveThreshold"]
    scene.cycles.use_denoising = cycle["denoise"]
    scene.cycles.denoiser = cycle["denoiser"]
    render.film_transparent = cycle["filmTransparent"]
    render.resolution_x = round(cycle["widthCss"] * cycle["pixelRatio"])
    render.resolution_y = round(cycle["heightCss"] * cycle["pixelRatio"])
    render.resolution_percentage = 100
    render.pixel_aspect_x = 1.0
    render.pixel_aspect_y = 1.0
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGBA"
    render.image_settings.color_depth = "8"
    render.image_settings.compression = 15
    render.use_persistent_data = True

    view = cycle["colorManagement"]
    scene.display_settings.display_device = view["displayDevice"]
    scene.view_settings.view_transform = view["viewTransform"]
    look = view["look"]
    try:
        scene.view_settings.look = look
    except TypeError:
        die(f"colour-management look {look!r} is not available in this Blender")
    scene.view_settings.exposure = view["exposure"]
    scene.view_settings.gamma = view["gamma"]

    log(
        "render: "
        f"{render.resolution_x}x{render.resolution_y} "
        f"{scene.cycles.samples} samples, denoise {scene.cycles.denoiser}, "
        f"{scene.view_settings.view_transform}/{scene.view_settings.look}"
    )


# --------------------------------------------------------------------------- #
# Materials
# --------------------------------------------------------------------------- #


def build_materials(spec: dict) -> dict[str, bpy.types.Material]:
    tile = spec["tile"]["materials"]

    # Jansou tiles are white melamine with a coloured melamine backing: an
    # opaque, hard thermoset with a glossy surface and a painted, engraved
    # symbol. The face colour is an off-white/ivory tone, not actual ivory.
    face = new_material("tile-face-melamine")
    bsdf = principled(face)
    bsdf.inputs["Base Color"].default_value = hex_linear(tile["face"]["hex"])
    bsdf.inputs["Roughness"].default_value = tile["face"]["roughness"]
    bsdf.inputs["Specular IOR Level"].default_value = 0.5
    bsdf.inputs["Coat Weight"].default_value = tile["face"]["coat"]
    bsdf.inputs["Coat Roughness"].default_value = tile["face"]["coatRoughness"]

    backing = new_material("tile-backing-melamine")
    bsdf = principled(backing)
    bsdf.inputs["Base Color"].default_value = hex_linear(tile["backing"]["hex"])
    bsdf.inputs["Roughness"].default_value = tile["backing"]["roughness"]
    bsdf.inputs["Specular IOR Level"].default_value = 0.45
    bsdf.inputs["Coat Weight"].default_value = tile["backing"]["coat"]
    bsdf.inputs["Coat Roughness"].default_value = tile["backing"]["coatRoughness"]

    felt = new_material("table-felt")
    bsdf = principled(felt)
    bsdf.inputs["Base Color"].default_value = hex_linear(spec["table"]["surface"]["hex"])
    bsdf.inputs["Roughness"].default_value = spec["table"]["surface"]["roughness"]

    return {"face": face, "backing": backing, "felt": felt}


def build_world(scene: bpy.types.Scene, spec: dict) -> None:
    world = bpy.data.worlds.new("world")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = hex_linear(spec["world"]["hex"])
    background.inputs["Strength"].default_value = spec["world"]["strength"]
    scene.world = world


# --------------------------------------------------------------------------- #
# Scene objects
# --------------------------------------------------------------------------- #


def build_table(scene: bpy.types.Scene, spec: dict, materials: dict) -> bpy.types.Object:
    size = spec["table"]["size"] / 2.0
    mesh = bpy.data.meshes.new("table")
    mesh.from_pydata(
        [(-size, -size, 0), (size, -size, 0), (size, size, 0), (-size, size, 0)],
        [],
        [(0, 1, 2, 3)],
    )
    mesh.update()
    mesh.materials.append(materials["felt"])
    # The felt is only an occluder for the shadow pass; the sprite keeps its alpha.
    obj = new_object("table", mesh)
    obj.is_shadow_catcher = spec["table"]["shadowCatcher"]
    return obj


def build_tile(scene: bpy.types.Scene, spec: dict, materials: dict) -> bpy.types.Object:
    import bmesh

    tile = spec["tile"]
    width = tile["width"]
    height = tile["height"]
    thickness = tile["thickness"]
    bevel = tile["bevel"]
    back_frac = tile["backEdgeFraction"]

    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for vert in bm.verts:
        vert.co = Vector(
            (vert.co.x * width, vert.co.y * height, (vert.co.z + 0.5) * thickness)
        )

    # Split the body on the plane the blue backing wraps to: the rear band of
    # every side edge becomes blue, and the front band stays white melamine.
    cut_z = back_frac * thickness
    bmesh.ops.bisect_plane(
        bm,
        geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
        dist=1e-6,
        plane_co=(0.0, 0.0, cut_z),
        plane_no=(0.0, 0.0, 1.0),
    )
    bm.normal_update()

    # The tile is a white melamine face plate on a solid blue melamine backing:
    # the back face and the rear band of *every* side edge are blue, so the
    # colour wraps the whole perimeter, not just the top edge.
    for face in bm.faces:
        centre = face.calc_center_median()
        is_side = abs(face.normal.z) < 0.5
        is_blue = face.normal.z < -0.5 or (is_side and centre.z < cut_z - 1e-5)
        face.material_index = 1 if is_blue else 0

    mesh = bpy.data.meshes.new("tile-body")
    bm.to_mesh(mesh)
    bm.free()
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    mesh.materials.append(materials["face"])
    mesh.materials.append(materials["backing"])

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


def build_camera(scene: bpy.types.Scene, spec: dict) -> bpy.types.Object:
    camera = spec["camera"]
    data = bpy.data.cameras.new("camera")
    data.type = "PERSP"
    data.lens = camera["lensMm"]
    data.sensor_width = camera["sensorWidthMm"]
    data.sensor_fit = camera["sensorFit"]
    data.shift_x = camera["shiftX"]
    data.shift_y = camera["shiftY"]
    data.clip_start = camera["clipStart"]
    data.clip_end = camera["clipEnd"]
    obj = new_object("camera", data)
    obj.location = Vector(camera["position"])
    aim(obj, camera["target"])
    scene.camera = obj
    return obj


def active_lights(spec: dict) -> list[dict]:
    """The lights actually built: the selected preset's enabled entries.

    The spec carries both rigs so the tuner can compare them without editing
    anything: `studio` is Task 1's single softbox key, `parlor` is the strip
    rig. `lightRig` names the active preset; `enabled: false` parks a tube
    without deleting its numbers. A spec with a plain `lights` list (Task 1
    format) still works.
    """
    presets = spec.get("lightPresets")
    if not presets:
        return [entry for entry in spec["lights"] if entry.get("enabled", True)]
    name = spec.get("lightRig")
    if name not in presets:
        die(f"lightRig {name!r} is not one of {sorted(presets)}")
    return [entry for entry in presets[name]["lights"] if entry.get("enabled", True)]


def build_lights(scene: bpy.types.Scene, spec: dict) -> None:
    """Place the area rig from spherical coordinates around each target.

    azimuth 0 points at the player (front, -Y), 90 is +X (right), 180 is +Y
    (behind) and 270 is -X (left); elevation is degrees above the horizontal.
    That makes "light from above the tile" a single number and keeps the tuner's
    direction sliders meaningful.

    `rollDeg` then turns the rectangle about its own aim axis (local Z), so a
    long thin tube can lie along X (0) or stand along Y (90) without moving the
    aim or the target. That is the whole strip-light trick: length shapes the
    streak, width shapes its cross-section, roll picks which strokes catch it.
    """
    lights = active_lights(spec)
    if not lights:
        die("the active light rig is empty")
    log(
        f"rig {spec.get('lightRig', 'lights')}: "
        + ", ".join(
            f"{entry['id']} ({entry['size']:g}x{entry['sizeY']:g}, "
            f"{entry['elevationDeg']:g}°, roll {entry.get('rollDeg', 0):g}°, "
            f"{entry['energyW'] / 1000:g} kW)"
            for entry in lights
        )
    )
    for entry in lights:
        data = bpy.data.lights.new(entry["id"], "AREA")
        data.shape = "RECTANGLE"
        data.size = entry["size"]
        data.size_y = entry["sizeY"]
        data.energy = entry["energyW"]
        data.color = hex_linear(entry["hex"])[:3]
        target = Vector(entry["target"])
        azimuth = math.radians(entry["azimuthDeg"])
        elevation = math.radians(entry["elevationDeg"])
        direction = Vector(
            (
                math.sin(azimuth) * math.cos(elevation),
                -math.cos(azimuth) * math.cos(elevation),
                math.sin(elevation),
            )
        )
        obj = new_object(entry["id"], data)
        obj.location = target + direction * entry["distance"]
        aim(obj, target)
        roll = entry.get("rollDeg", 0.0)
        if roll:
            # Post-multiply: the rotation is about the light's own aim axis.
            obj.matrix_world = obj.matrix_world @ Matrix.Rotation(math.radians(roll), 4, "Z")
        obj["group"] = entry.get("group", "key")


def rig_record(spec: dict) -> dict:
    """The active rig as it was built, for the manifest.

    Recorded from the same resolved list `build_lights` consumes, so the
    manifest can never describe a rig the sprites were not baked with. Task 2/3
    read this instead of assuming light positions.
    """
    return {
        "preset": spec.get("lightRig"),
        "convention": (
            "azimuth 0 front (-Y), 90 +X, 180 behind, 270 -X; elevation above "
            "horizontal; roll about the light's aim axis in degrees"
        ),
        "lights": [
            {
                "id": entry["id"],
                "group": entry.get("group", "key"),
                "target": entry["target"],
                "azimuthDeg": entry["azimuthDeg"],
                "elevationDeg": entry["elevationDeg"],
                "distance": entry["distance"],
                "size": entry["size"],
                "sizeY": entry["sizeY"],
                "rollDeg": entry.get("rollDeg", 0.0),
                "energyW": entry["energyW"],
                "hex": entry["hex"],
            }
            for entry in active_lights(spec)
        ],
        "world": {"hex": spec["world"]["hex"], "strength": spec["world"]["strength"]},
    }


# --------------------------------------------------------------------------- #
# Poses and projection
# --------------------------------------------------------------------------- #


def hand_slots(spec: dict) -> list[dict]:
    hand = spec["hand"]
    count = hand["count"]
    spacing = hand["spacing"]
    slots = []
    for index in range(count):
        x = hand["centerX"] + (index - (count - 1) / 2.0) * spacing
        slots.append(
            {
                "id": f"hand-{index}",
                "index": index,
                "pose": hand["pose"],
                "x": x,
                "y": hand["y"],
                "orientation": "upright",
                "drawOrder": 10,
            }
        )
    return slots


def pose_matrix(pose: str, slot: dict, spec: dict) -> Matrix:
    """Object matrix for a slot pose.

    Tiles are modelled flat, face up (+Z), symbol top toward +Y. The hand pose
    stands a tile vertically with its face toward the player (-Y) and its foot
    on the table (local +Y becomes world +Z).
    """
    tile = spec["tile"]
    if pose == "hand-upright":
        rotation = Matrix.Rotation(math.radians(90.0), 4, "X")
        location = Vector((slot["x"], slot["y"] + tile["thickness"], tile["height"] / 2.0))
        return Matrix.Translation(location) @ rotation
    if pose == "hand-upright-back":
        # Same standing tile turned 180 degrees about the vertical axis, so the
        # blue back faces the player's camera (concealed hand pose).
        rotation = Matrix.Rotation(math.radians(180.0), 4, "Z") @ Matrix.Rotation(
            math.radians(90.0), 4, "X"
        )
        location = Vector((slot["x"], slot["y"], tile["height"] / 2.0))
        return Matrix.Translation(location) @ rotation
    raise ValueError(f"unknown pose {pose!r}")


def apply_pose(obj: bpy.types.Object, slot: dict, spec: dict) -> None:
    obj.matrix_world = pose_matrix(slot["pose"], slot, spec)


def project(scene: bpy.types.Scene, camera: bpy.types.Object, point) -> tuple[float, float]:
    co = world_to_camera_view(scene, camera, Vector(point))
    width = scene.render.resolution_x
    height = scene.render.resolution_y
    return (co.x * width, (1.0 - co.y) * height)


def tile_corners(spec: dict) -> list[Vector]:
    tile = spec["tile"]
    half_w = tile["width"] / 2.0
    half_h = tile["height"] / 2.0
    top = tile["thickness"]
    return [
        Vector((sx * half_w, sy * half_h, sz))
        for sz in (0.0, top)
        for sy in (-1, 1)
        for sx in (-1, 1)
    ]


def face_corners(spec: dict, half_extent: tuple[float, float] | None = None) -> list[Vector]:
    """Corners of the inset face rect (or a larger frame) in tile-local space.

    Order is screen top-left, top-right, bottom-right, bottom-left for the
    upright hand pose: symbol top is local +Y.
    """
    tile = spec["tile"]
    if half_extent is None:
        half_extent = (
            tile["width"] / 2.0 - tile["faceInset"],
            tile["height"] / 2.0 - tile["faceInset"],
        )
    hx, hy = half_extent
    top = tile["thickness"]
    return [
        Vector((-hx, hy, top)),
        Vector((hx, hy, top)),
        Vector((hx, -hy, top)),
        Vector((-hx, -hy, top)),
    ]


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #


def render_png(scene: bpy.types.Scene, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def load_rgba(path: Path) -> np.ndarray:
    image = bpy.data.images.load(str(path))
    width, height = image.size
    pixels = np.array(image.pixels[:], dtype=np.float32).reshape(height, width, 4)
    bpy.data.images.remove(image)
    return np.flipud(pixels)  # Blender rows are bottom-up; use top-down.


def save_rgba(path: Path, pixels: np.ndarray) -> None:
    height, width = pixels.shape[:2]
    image = bpy.data.images.new(path.stem, width=width, height=height, alpha=True)
    image.pixels = np.flipud(pixels).ravel().tolist()
    image.filepath_raw = str(path)
    image.file_format = "PNG"
    image.save()
    bpy.data.images.remove(image)


def crop_border(scene: bpy.types.Scene, rect: tuple[int, int, int, int]) -> None:
    """Restrict rendering to a pixel rect, keeping full-frame pixel alignment.

    Blender quantises a cropped border to whole pixels inconsistently (float32
    rounding at the edges), so the border is rendered in place at full
    resolution and the exact rect is sliced out of the result instead.
    """
    x0, y0, x1, y1 = rect
    width = scene.render.resolution_x
    height = scene.render.resolution_y
    render = scene.render
    render.use_border = True
    render.use_crop_to_border = False
    render.border_min_x = x0 / width
    render.border_max_x = x1 / width
    render.border_min_y = (height - y1) / height
    render.border_max_y = (height - y0) / height


def render_region(
    scene: bpy.types.Scene, path: Path, rect: tuple[int, int, int, int]
) -> np.ndarray:
    crop_border(scene, rect)
    render_png(scene, path)
    full = load_rgba(path)
    x0, y0, x1, y1 = rect
    return full[y0:y1, x0:x1].copy()


def clear_border(scene: bpy.types.Scene) -> None:
    scene.render.use_border = False
    scene.render.use_crop_to_border = False


def bake_body(
    spec: dict,
    scene: bpy.types.Scene,
    camera: bpy.types.Object,
    tile: bpy.types.Object,
    table: bpy.types.Object,
    slot: dict,
    out_dir: Path,
    path: Path,
    gutter: int,
) -> tuple[np.ndarray, tuple[int, int, int, int], bool]:
    """Bake one body sprite: the posed tile over its shadow-catcher contact shadow.

    Returns the sprite, its device-pixel crop rect, and whether the crop hit the
    frame edge (which would clip the shadow).
    """
    apply_pose(tile, slot, spec)
    sync_view_layer()

    projected = [
        project(scene, camera, tile.matrix_world @ corner) for corner in tile_corners(spec)
    ]
    xs = [point[0] for point in projected]
    ys = [point[1] for point in projected]
    render_width = scene.render.resolution_x
    render_height = scene.render.resolution_y
    x0 = max(0, math.floor(min(xs) - gutter))
    y0 = max(0, math.floor(min(ys) - gutter))
    x1 = min(render_width, math.ceil(max(xs) + gutter))
    y1 = min(render_height, math.ceil(max(ys) + gutter))
    rect = (x0, y0, x1, y1)
    clipped = x0 == 0 or y0 == 0 or x1 == render_width or y1 == render_height

    # Pass 1: the tile alone with transparent film.
    table.hide_render = True
    body = render_region(scene, out_dir / "_body-pass.png", rect)
    if body.shape[:2] != (y1 - y0, x1 - x0):
        die(f"body render is {body.shape[1]}x{body.shape[0]}, expected {x1 - x0}x{y1 - y0}")

    # Pass 2: the contact shadow. The tile is invisible to the camera but still
    # occludes the key lights, so the shadow catcher returns shadow as alpha.
    table.hide_render = False
    tile.visible_camera = False
    shadow = render_region(scene, out_dir / "_shadow-pass.png", rect)
    tile.visible_camera = True
    clear_border(scene)
    (out_dir / "_body-pass.png").unlink()
    (out_dir / "_shadow-pass.png").unlink()

    sprite = over(shadow, body)  # tile over its contact shadow
    save_rgba(path, sprite)
    log(f"body sprite: {path} ({x1 - x0}x{y1 - y0}), clipped={clipped}")
    return sprite, rect, clipped


# --------------------------------------------------------------------------- #
# Homography and compositing
# --------------------------------------------------------------------------- #


def quad_homography(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    rows = []
    for (x, y), (target_x, target_y) in zip(src, dst):
        rows.append([x, y, 1, 0, 0, 0, -target_x * x, -target_x * y, -target_x])
        rows.append([0, 0, 0, x, y, 1, -target_y * x, -target_y * y, -target_y])
    _, _, vh = np.linalg.svd(np.asarray(rows, dtype=np.float64))
    matrix = vh[-1].reshape(3, 3)
    return matrix / matrix[2, 2]


def apply_homography(matrix: np.ndarray, x: np.ndarray, y: np.ndarray) -> tuple:
    denom = matrix[2, 0] * x + matrix[2, 1] * y + matrix[2, 2]
    out_x = (matrix[0, 0] * x + matrix[0, 1] * y + matrix[0, 2]) / denom
    out_y = (matrix[1, 0] * x + matrix[1, 1] * y + matrix[1, 2]) / denom
    return out_x, out_y


def css_matrix3d(matrix: np.ndarray) -> str:
    """CSS matrix3d for a pixel-space homography (local top-left origin, y down)."""
    a, b, c = matrix[0]
    d, e, f = matrix[1]
    g, h, i = matrix[2]
    values = [a, d, 0.0, g, b, e, 0.0, h, 0.0, 0.0, 1.0, 0.0, c, f, 0.0, i]
    return "matrix3d(" + ", ".join(f"{value:.9g}" for value in values) + ")"


def sample_bilinear(premultiplied: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    height, width = premultiplied.shape[:2]
    xs = np.clip(xs, 0.0, width - 1.001)
    ys = np.clip(ys, 0.0, height - 1.001)
    x0 = np.floor(xs).astype(np.int32)
    y0 = np.floor(ys).astype(np.int32)
    x1 = np.minimum(x0 + 1, width - 1)
    y1 = np.minimum(y0 + 1, height - 1)
    fx = (xs - x0)[..., None]
    fy = (ys - y0)[..., None]
    return (
        premultiplied[y0, x0] * (1 - fx) * (1 - fy)
        + premultiplied[y0, x1] * fx * (1 - fy)
        + premultiplied[y1, x0] * (1 - fx) * fy
        + premultiplied[y1, x1] * fx * fy
    )


def over(dst: np.ndarray, src: np.ndarray) -> np.ndarray:
    """Straight-alpha 'over' on RGBA float images."""
    src_alpha = src[..., 3:4]
    out_alpha = src_alpha + dst[..., 3:4] * (1.0 - src_alpha)
    safe = np.where(out_alpha > 0, out_alpha, 1.0)
    out_rgb = (src[..., :3] * src_alpha + dst[..., :3] * dst[..., 3:4] * (1.0 - src_alpha)) / safe
    return np.concatenate([out_rgb, out_alpha], axis=-1)


def warp_onto(
    canvas: np.ndarray,
    decal: np.ndarray,
    matrix: np.ndarray,
    origin: tuple[int, int],
) -> np.ndarray:
    """Warp the decal onto the canvas with a homography and composite it."""
    inverse = np.linalg.inv(matrix)
    height, width = canvas.shape[:2]
    decal_height, decal_width = decal.shape[:2]

    decal_premultiplied = np.concatenate(
        [decal[..., :3] * decal[..., 3:4], decal[..., 3:4]], axis=-1
    )

    xs, ys = np.meshgrid(
        np.arange(width) + 0.5, np.arange(height) + 0.5
    )
    abs_x = xs + origin[0]
    abs_y = ys + origin[1]
    src_x, src_y = apply_homography(inverse, abs_x, abs_y)
    inside = (
        (src_x >= 0.0)
        & (src_x <= decal_width)
        & (src_y >= 0.0)
        & (src_y <= decal_height)
    )
    sampled = sample_bilinear(decal_premultiplied, src_x, src_y)
    sampled[~inside] = 0.0
    alpha = sampled[..., 3:4]
    straight = np.where(alpha > 0.0, sampled[..., :3] / np.maximum(alpha, 1e-8), 0.0)
    return over(canvas, np.concatenate([straight, alpha], axis=-1))


# --------------------------------------------------------------------------- #
# Measurements
# --------------------------------------------------------------------------- #


def measure_blue_sliver(sprite: np.ndarray, column: int) -> dict:
    """Measure the blue backing along the top edge of a standing tile."""
    height, width = sprite.shape[:2]
    column = max(0, min(width - 1, column))
    alpha = sprite[:, column, 3]
    opaque_rows = np.nonzero(alpha > 0.5)[0]
    if len(opaque_rows) == 0:
        return {"bluePx": 0, "topEdgePx": 0}
    top = int(opaque_rows[0])

    rgb = sprite[top:, column, :3]
    is_blue = (rgb[:, 2] > rgb[:, 0] + 0.02) & (rgb[:, 2] > rgb[:, 1] + 0.01)
    run = 0
    for value in is_blue:
        if not value:
            break
        run += 1
    return {"bluePx": run, "topRow": top}


def channel_stats(sprite: np.ndarray, alpha_floor: float = 0.5) -> dict:
    """Peak stored value and clipped-pixel count over an opaque sprite.

    `load_rgba` hands back the stored 8-bit values as 0..1 without converting to
    linear, so a channel at 1.0 is a clipped byte. "No clipping" then becomes a
    number in the manifest instead of an eyeball judgement.
    """
    opaque = sprite[..., 3] >= alpha_floor
    rgb = sprite[..., :3][opaque]
    if rgb.size == 0:
        return {"maxChannel": 0, "clippedPixels": 0, "opaquePixels": 0}
    peak = float(rgb.max()) * 255.0
    clipped = int((rgb >= 254.5 / 255.0).any(axis=1).sum())
    return {
        "maxChannel": round(peak, 1),
        "clippedPixels": clipped,
        "opaquePixels": int(opaque.sum()),
    }


# --------------------------------------------------------------------------- #
# Carved face plate
# --------------------------------------------------------------------------- #


def blur2d(array: np.ndarray, sigma: float) -> np.ndarray:
    """Separable Gaussian blur; the carve wall is a smooth ramp of the mask."""
    radius = max(1, int(round(sigma * 3)))
    offsets = np.arange(-radius, radius + 1, dtype=np.float32)
    kernel = np.exp(-(offsets**2) / (2.0 * sigma * sigma))
    kernel /= kernel.sum()
    result = array.astype(np.float32)
    for axis in (0, 1):
        padding = [(0, 0), (0, 0)]
        padding[axis] = (radius, radius)
        padded = np.pad(result, padding)
        accumulated = np.zeros_like(result)
        count = result.shape[axis]
        for index, weight in enumerate(kernel):
            window = [slice(None), slice(None)]
            window[axis] = slice(index, index + count)
            accumulated += weight * padded[tuple(window)]
        result = accumulated
    return result


def _inverse_erf_table() -> tuple[np.ndarray, np.ndarray]:
    x = np.linspace(-0.9999, 0.9999, 20001)
    f = np.array([math.erf(value) for value in x], dtype=np.float64)
    return f, x


_ERF_VALUES, _ERFINV_VALUES = _inverse_erf_table()


def alpha_to_distance(alpha: np.ndarray, sigma_px: float) -> np.ndarray:
    """Approximate signed distance (pixels, positive inside) from a blurred mask.

    A straight edge blurred by a Gaussian has alpha = 0.5 (1 + erf(d / (sigma *
    sqrt(2)))), so inverting the erf recovers d. That gives the carve an explicit
    distance coordinate instead of a normalised alpha, which is what lets the
    transition width be a parameter. The estimate saturates around 3 sigma inside,
    so a transition wider than ~4 sigma needs a larger blur.
    """
    value = np.clip(2.0 * alpha - 1.0, -0.9999, 0.9999)
    return (
        np.interp(value, _ERF_VALUES, _ERFINV_VALUES)
        * sigma_px
        * math.sqrt(2.0)
    )


def bilinear2d(array: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    height, width = array.shape
    xs = np.clip(xs, 0.0, width - 1.001)
    ys = np.clip(ys, 0.0, height - 1.001)
    x0 = np.floor(xs).astype(np.int32)
    y0 = np.floor(ys).astype(np.int32)
    x1 = np.minimum(x0 + 1, width - 1)
    y1 = np.minimum(y0 + 1, height - 1)
    fx = xs - x0
    fy = ys - y0
    return (
        array[y0, x0] * (1 - fx) * (1 - fy)
        + array[y0, x1] * fx * (1 - fy)
        + array[y1, x0] * (1 - fx) * fy
        + array[y1, x1] * fx * fy
    )


def bezier_profile(
    u: np.ndarray, top_spread: float, bottom_spread: float
) -> np.ndarray:
    """Groove height profile as a cubic Bézier, with an edge control at each end.

    The curve runs from the lip (0, 0) to the floor (1, 1) with control points
    (top_spread, 0) and (1 - bottom_spread, 1). The x tangents at the two ends
    are what spread the fillets: larger `top_spread` keeps the surface flat
    longer before it drops into the well, larger `bottom_spread` keeps it flat
    longer before it bottoms out. The two params are independent, so the lip and
    the wall-to-floor shoulder can be shaped separately. 0 gives a straight
    diagonal (no fillet), 1 gives the widest ease.
    """
    ts = np.linspace(0.0, 1.0, 1025)
    one_minus = 1.0 - ts
    xs = (
        3.0 * one_minus * one_minus * ts * top_spread
        + 3.0 * one_minus * ts * ts * (1.0 - bottom_spread)
        + ts * ts * ts
    )
    ys = ts * ts * (3.0 - 2.0 * ts)
    # Guard the interpolation against a flat spot (x' can touch 0 at t = 0.5).
    xs = np.maximum.accumulate(xs) + np.arange(ts.size) * 1e-12
    return np.interp(np.clip(u, 0.0, 1.0), xs, ys)


def build_carved_face(
    spec: dict,
    material: bpy.types.Material,
    field: np.ndarray,
    half_w: float,
    half_h: float,
    top: float,
    uv_rect: tuple[float, float, float, float],
    decal_pixels: tuple[int, int],
) -> bpy.types.Object:
    """Subdivided face plate with the painted symbol physically recessed.

    `field` is the 0..1 distance across the carve transition (0 at the lip, 1 at
    the floor). It is remapped through a cubic Bézier so the two fillets are
    shaped independently. UVs stay a planar top-down projection, so the paint
    reaches up the wall as it would on a filled engraving.
    """
    carve = spec["decals"]["carve"]
    depth = carve["depthFractionOfThickness"] * spec["tile"]["thickness"]
    columns = max(2, round(decal_pixels[0] * carve["gridScale"]))
    rows = max(2, round(decal_pixels[1] * carve["gridScale"]))
    u0, v0, u1, v1 = uv_rect

    grid_x = np.linspace(-half_w, half_w, columns, dtype=np.float64)
    grid_y = np.linspace(half_h, -half_h, rows, dtype=np.float64)
    u = np.linspace(u0, u1, columns)
    v = np.linspace(v1, v0, rows)  # row 0 is the top of the face (v = v1)
    uu, vv = np.meshgrid(u, v)

    field_height, field_width = field.shape
    sampled = bilinear2d(
        field, uu * (field_width - 1), (1.0 - vv) * (field_height - 1)
    )
    profile = carve["profile"]
    height = bezier_profile(
        sampled, profile["topSpread"], profile["bottomSpread"]
    )
    z = top - depth * height

    xx, yy = np.meshgrid(grid_x, grid_y)
    verts = np.stack([xx.ravel(), yy.ravel(), z.ravel()], axis=1)

    indices = np.arange(rows * columns).reshape(rows, columns)
    faces = np.stack(
        [
            indices[:-1, :-1].ravel(),
            indices[1:, :-1].ravel(),
            indices[1:, 1:].ravel(),
            indices[:-1, 1:].ravel(),
        ],
        axis=1,
    )

    mesh = bpy.data.meshes.new("face-plane")
    mesh.from_pydata(verts.tolist(), [], faces.tolist())
    mesh.update()
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    mesh.materials.append(material)

    uv_layer = mesh.uv_layers.new(name="UVMap")
    uv_top_left = np.stack([uu[:-1, :-1].ravel(), vv[:-1, :-1].ravel()], axis=1)
    uv_bottom_left = np.stack([uu[1:, :-1].ravel(), vv[1:, :-1].ravel()], axis=1)
    uv_bottom_right = np.stack([uu[1:, 1:].ravel(), vv[1:, 1:].ravel()], axis=1)
    uv_top_right = np.stack([uu[:-1, 1:].ravel(), vv[:-1, 1:].ravel()], axis=1)
    uvs = np.concatenate(
        [uv_top_left, uv_bottom_left, uv_bottom_right, uv_top_right], axis=1
    )
    uv_layer.data.foreach_set("uv", uvs.ravel().tolist())

    return new_object("face-plane", mesh)


def bake_decal(
    spec: dict,
    scene: bpy.types.Scene,
    camera: bpy.types.Object,
    tile: bpy.types.Object,
    table: bpy.types.Object,
    out_dir: Path,
) -> tuple[Path, int, int, float, float]:
    """Render the carved, painted, lit face decal for the spike orientation."""
    tile_spec = spec["tile"]
    decal_spec = spec["spike"]["decal"]
    rig = spec["decals"]["rigs"][decal_spec["orientation"]]
    px_per_unit = (
        spec["decals"]["renderScale"] * spec["decals"]["cssFace"][1] / tile_spec["height"]
    )
    inset_w = tile_spec["width"] - 2 * tile_spec["faceInset"]
    inset_h = tile_spec["height"] - 2 * tile_spec["faceInset"]
    padding = spec["decals"]["paddingPixels"]
    decal_width = round(inset_w * px_per_unit) + 2 * padding
    decal_height = round(inset_h * px_per_unit) + 2 * padding
    frame_w = decal_width / px_per_unit
    frame_h = decal_height / px_per_unit

    texture_width = round(spec["decals"]["cssFace"][0] * spec["decals"]["renderScale"])
    texture_height = round(spec["decals"]["cssFace"][1] * spec["decals"]["renderScale"])
    symbol_texture = (
        RENDER_DIR
        / "build"
        / "faces"
        / f"{decal_spec['code']}-symbol-{texture_width}x{texture_height}.png"
    )
    if not symbol_texture.exists():
        die(f"{symbol_texture} is missing; run scripts/rasterize-face.mjs first")

    tile.hide_render = True
    table.hide_render = True

    decal_material = new_material("face-decal")
    nodes = decal_material.node_tree.nodes
    links = decal_material.node_tree.links
    face_spec = tile_spec["materials"]["face"]
    paint_spec = tile_spec["materials"]["paint"]

    # Flat melamine face: the same base colour as the body's face underlay, so
    # the decal edge is invisible and the bevel ring stays the body's job.
    face_bsdf = principled(decal_material)
    face_bsdf.inputs["Roughness"].default_value = face_spec["roughness"]
    face_bsdf.inputs["Specular IOR Level"].default_value = 0.5
    face_bsdf.inputs["Coat Weight"].default_value = face_spec["coat"]
    face_bsdf.inputs["Coat Roughness"].default_value = face_spec["coatRoughness"]

    # Cavity occlusion. A groove floor has the same normal as the face, so its
    # diffuse response is identical and a wide stroke would read as flat paint.
    # The AO node darkens the inside of the carve where the walls block the
    # environment, which is what makes the wide areas look sunk in.
    ambient = nodes.new("ShaderNodeAmbientOcclusion")
    ambient.inputs["Distance"].default_value = spec["decals"]["carve"]["occlusionDistance"]
    occlusion_strength = spec["decals"]["carve"]["occlusionStrength"]
    ambient.samples = spec["decals"]["carve"]["occlusionSamples"]
    ambient.only_local = True

    face_colour = nodes.new("ShaderNodeRGB")
    face_colour.outputs["Color"].default_value = hex_linear(face_spec["hex"])
    face_ao = nodes.new("ShaderNodeMixRGB")
    face_ao.blend_type = "MULTIPLY"
    face_ao.inputs["Fac"].default_value = occlusion_strength
    links.new(face_colour.outputs["Color"], face_ao.inputs[1])
    links.new(ambient.outputs["Color"], face_ao.inputs[2])
    links.new(face_ao.outputs["Color"], face_bsdf.inputs["Base Color"])

    # Engraved paint: the symbol-only SVG supplies both the colour and the mask.
    # Glossy, so the bottom fillet catches a specular line.
    symbol_image = bpy.data.images.load(str(symbol_texture))
    symbol_image.colorspace_settings.name = "sRGB"
    symbol_node = nodes.new("ShaderNodeTexImage")
    symbol_node.image = symbol_image
    symbol_node.interpolation = "Linear"

    # Carve field: an explicit distance across the transition (0 at the lip, 1
    # at the floor). The transition width is a real parameter now, so the
    # curvature can be pushed as far into the flat bottom as wanted. The same
    # field drives the paint boundary, which is why the paint edge moves.
    carve = spec["decals"]["carve"]
    raw_mask = load_rgba(symbol_texture)[..., 3]
    sigma_px = carve["blurUnits"] * px_per_unit
    alpha = blur2d(raw_mask, sigma_px)
    distance_px = alpha_to_distance(alpha, sigma_px)
    transition_px = carve["transitionUnits"] * px_per_unit
    field = np.clip(distance_px / transition_px, 0.0, 1.0)
    field_path = (
        RENDER_DIR
        / "build"
        / "faces"
        / f"{decal_spec['code']}-field-{texture_width}x{texture_height}.png"
    )
    save_rgba(
        field_path,
        np.stack([field, field, field, np.ones_like(field)], axis=-1),
    )
    field_image = bpy.data.images.load(str(field_path))
    field_image.colorspace_settings.name = "Non-Color"

    paint_bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    paint_base = nodes.new("ShaderNodeMixRGB")
    paint_base.blend_type = "MULTIPLY"
    paint_base.inputs["Fac"].default_value = occlusion_strength
    links.new(symbol_node.outputs["Color"], paint_base.inputs[1])
    links.new(ambient.outputs["Color"], paint_base.inputs[2])
    links.new(paint_base.outputs["Color"], paint_bsdf.inputs["Base Color"])
    paint_bsdf.inputs["Roughness"].default_value = paint_spec["roughness"]
    paint_bsdf.inputs["Specular IOR Level"].default_value = 0.5
    paint_bsdf.inputs["Coat Weight"].default_value = paint_spec["coat"]
    paint_bsdf.inputs["Coat Roughness"].default_value = paint_spec["coatRoughness"]

    # The paint boundary sits `paintEdge` into the transition, so a ring of bare
    # melamine remains on the bevel. Because the gate reads the distance field
    # rather than the hard symbol alpha, the control actually moves the edge.
    paint_gate = nodes.new("ShaderNodeMapRange")
    paint_edge = carve["paintEdge"]
    paint_gate.inputs["From Min"].default_value = paint_edge - 0.02
    paint_gate.inputs["From Max"].default_value = paint_edge + 0.02
    paint_gate.inputs["To Min"].default_value = 0.0
    paint_gate.inputs["To Max"].default_value = 1.0
    paint_gate.clamp = True
    field_node = nodes.new("ShaderNodeTexImage")
    field_node.image = field_image
    field_node.interpolation = "Linear"
    field_channel = nodes.new("ShaderNodeSeparateColor")
    links.new(field_node.outputs["Color"], field_channel.inputs["Color"])
    links.new(field_channel.outputs["Red"], paint_gate.inputs["Value"])

    paint_mix = nodes.new("ShaderNodeMixShader")
    links.new(paint_gate.outputs["Result"], paint_mix.inputs["Fac"])
    links.new(face_bsdf.outputs["BSDF"], paint_mix.inputs[1])
    links.new(paint_bsdf.outputs["BSDF"], paint_mix.inputs[2])
    output_node = nodes["Material Output"]
    links.new(paint_mix.outputs["Shader"], output_node.inputs["Surface"])

    half_w = tile_spec["width"] / 2.0 - tile_spec["faceInset"]
    half_h = tile_spec["height"] / 2.0 - tile_spec["faceInset"]
    u0 = tile_spec["faceInset"] / tile_spec["width"]
    u1 = 1.0 - u0
    v0 = tile_spec["faceInset"] / tile_spec["height"]
    v1 = 1.0 - v0
    top = tile_spec["thickness"]

    carve_mask = field
    decal_plane = build_carved_face(
        spec,
        decal_material,
        carve_mask,
        half_w,
        half_h,
        top,
        (u0, v0, u1, v1),
        (decal_width, decal_height),
    )

    rig_slot = {"x": 0.0, "y": rig["slotY"]}
    decal_plane.matrix_world = pose_matrix("hand-upright", rig_slot, spec)
    sync_view_layer()

    ortho = bpy.data.cameras.new("decal-camera")
    ortho.type = "ORTHO"
    ortho.ortho_scale = frame_h
    ortho.clip_start = 0.1
    ortho.clip_end = 100.0
    ortho_obj = new_object("decal-camera", ortho)
    ortho_obj.location = (
        0.0,
        rig["slotY"] - rig["cameraDistance"],
        tile_spec["height"] / 2.0,
    )
    aim(ortho_obj, (0.0, rig["slotY"], tile_spec["height"] / 2.0))
    scene.camera = ortho_obj
    sync_view_layer()
    scene.render.resolution_x = decal_width
    scene.render.resolution_y = decal_height
    clear_border(scene)

    decal_path = out_dir / spec["outputs"]["decal"].format(
        code=decal_spec["code"], orientation=decal_spec["orientation"]
    )
    render_png(scene, decal_path)
    decal = load_rgba(decal_path)
    if decal.shape[:2] != (decal_height, decal_width):
        die(
            f"decal render is {decal.shape[1]}x{decal.shape[0]}, "
            f"expected {decal_width}x{decal_height}"
        )
    log(f"face decal: {decal_path} ({decal_width}x{decal_height})")
    return decal_path, decal_width, decal_height, frame_w, frame_h


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(argv) != 2:
        die("usage: build_and_render.py -- <scene-spec.json> <out-dir>")
    spec_path = Path(argv[0]).resolve()
    out_dir = Path(argv[1]).resolve()
    spec = json.loads(spec_path.read_text())

    blender_version = check_blender_version(spec)
    resolve_tile_dimensions(spec)
    scene = reset_scene()
    configure_render(scene, spec)
    render_width = scene.render.resolution_x
    render_height = scene.render.resolution_y
    materials = build_materials(spec)
    build_world(scene, spec)
    camera = build_camera(scene, spec)
    build_lights(scene, spec)
    table = build_table(scene, spec, materials)
    tile = build_tile(scene, spec, materials)

    # ---- body sprite ----------------------------------------------------- #
    preview_only = bool(spec.get("preview", {}).get("decalOnly"))
    slots = hand_slots(spec)
    spike_index = spec["spike"]["slotIndex"]
    if not 0 <= spike_index < len(slots):
        die(f"spike.slotIndex {spike_index} is outside the {len(slots)} hand slots")
    slot = slots[spike_index]
    gutter = spec["spike"]["shadowGutterDevicePx"]
    if not preview_only:
        body_path = out_dir / spec["outputs"]["body"].format(index=slot["index"])
        body_with_shadow, tile_rect, clipped = bake_body(
            spec, scene, camera, tile, table, slot, out_dir, body_path, gutter
        )
        x0, y0, x1, y1 = tile_rect

        # Diagnostic only: the same slot face-down, to prove the blue backing
        # wraps the whole body. Real face-down/concealed body poses are baked
        # with the slot inventory (Task 2) and consumed by Tasks 5 and 11.
        # The tuner's full-tile preview skips it.
        if not spec.get("preview", {}).get("skipBack"):
            back_slot = dict(slot, pose="hand-upright-back")
            back_path = out_dir / spec["outputs"]["back"].format(index=slot["index"])
            bake_body(spec, scene, camera, tile, table, back_slot, out_dir, back_path, gutter)

    # ---- face decal ------------------------------------------------------ #
    tile_spec = spec["tile"]
    decal_spec = spec["spike"]["decal"]
    padding = spec["decals"]["paddingPixels"]
    top = tile_spec["thickness"]
    decal_started = time.perf_counter()
    decal_path, decal_width, decal_height, frame_w, frame_h = bake_decal(
        spec, scene, camera, tile, table, out_dir
    )
    decal_seconds = time.perf_counter() - decal_started
    log(f"decal bake: {decal_seconds:.1f}s")
    if preview_only:
        log("preview: decal only, skipping body/composite/manifest")
        return
    decal = load_rgba(decal_path)

    # ---- projection records --------------------------------------------- #
    scene.camera = camera
    scene.render.resolution_x = render_width
    scene.render.resolution_y = render_height
    apply_pose(tile, slot, spec)  # the diagnostic back bake left the tile flipped
    sync_view_layer()
    face_quad = [
        project(scene, camera, tile.matrix_world @ corner) for corner in face_corners(spec)
    ]
    decal_quad = [
        project(scene, camera, tile.matrix_world @ corner)
        for corner in face_corners(spec, (frame_w / 2.0, frame_h / 2.0))
    ]

    src = np.array(
        [[0, 0], [decal_width, 0], [decal_width, decal_height], [0, decal_height]],
        dtype=np.float64,
    )
    dst = np.array(decal_quad, dtype=np.float64)
    matrix = quad_homography(src, dst)
    check_x, check_y = apply_homography(matrix, src[:, 0], src[:, 1])
    if not np.allclose(np.stack([check_x, check_y], axis=1), dst, atol=1e-6):
        die("face homography does not map the decal rect onto the face quad")

    # ---- composite panel ------------------------------------------------- #
    composite = warp_onto(body_with_shadow, decal, matrix, (x0, y0))
    composite_path = out_dir / spec["outputs"]["composite"].format(
        code=decal_spec["code"], orientation=decal_spec["orientation"]
    )
    save_rgba(composite_path, composite)
    log(f"composite: {composite_path}")

    # Pixel-perfect (nearest) review zoom, generated here so the sheet does not
    # rely on the SVG rasteriser honouring image-rendering="pixelated".
    zoom = spec["spike"]["zoom"]
    zoom_crop = composite[zoom["y"] : zoom["y"] + zoom["height"], zoom["x"] : zoom["x"] + zoom["width"]]
    zoom_image = np.repeat(np.repeat(zoom_crop, zoom["scale"], axis=0), zoom["scale"], axis=1)
    zoom_path = out_dir / spec["outputs"]["zoom"]
    save_rgba(zoom_path, zoom_image)
    log(f"zoom: {zoom_path} ({zoom_image.shape[1]}x{zoom_image.shape[0]})")

    # ---- measurements and manifest -------------------------------------- #
    face_centre_x = (face_quad[0][0] + face_quad[1][0]) / 2.0 - x0
    sliver = measure_blue_sliver(body_with_shadow, round(face_centre_x))
    top_front = project(
        scene, camera, tile.matrix_world @ Vector((0.0, tile_spec["height"] / 2.0, top))
    )
    top_back = project(
        scene,
        camera,
        tile.matrix_world
        @ Vector((0.0, tile_spec["height"] / 2.0, 0.0)),
    )
    edge_px = abs(top_front[1] - top_back[1])
    face_height_px = abs(face_quad[3][1] - face_quad[0][1])
    body_stats = channel_stats(body_with_shadow)
    decal_stats = channel_stats(decal)

    manifest = {
        "version": 1,
        "generatedBy": "tools/render/build_and_render.py",
        "spec": spec_path.name,
        "blender": blender_version,
        "units": "device px, origin top-left, y down; divide by pixelRatio for CSS",
        "pixelRatio": spec["scene"]["pixelRatio"],
        "tile": {
            "proportionsMm": tile_spec["proportionsMm"],
            "units": {
                "height": round(tile_spec["height"], 5),
                "width": round(tile_spec["width"], 5),
                "thickness": round(tile_spec["thickness"], 5),
            },
            "material": tile_spec["materials"]["face"]["material"],
            "backEdgeFraction": tile_spec["backEdgeFraction"],
        },
        "scene": {
            "width": spec["scene"]["widthCss"],
            "height": spec["scene"]["heightCss"],
            "widthDevicePx": render_width,
            "heightDevicePx": render_height,
            "camera": "fixed",
        },
        "facePixels": [
            round(spec["decals"]["cssFace"][0] * 2),
            round(spec["decals"]["cssFace"][1] * 2),
        ],
        "background": None,
        "rig": rig_record(spec),
        "decals": {
            "pixels": [decal_width, decal_height],
            "paddingPixels": padding,
            "frameUnits": [frame_w, frame_h],
            "renderedAtScale": spec["decals"]["renderScale"],
            "carve": {
                "depthUnits": round(
                    spec["decals"]["carve"]["depthFractionOfThickness"]
                    * tile_spec["thickness"],
                    5,
                ),
                "depthFractionOfThickness": spec["decals"]["carve"][
                    "depthFractionOfThickness"
                ],
                "blurUnits": spec["decals"]["carve"]["blurUnits"],
                "transitionUnits": spec["decals"]["carve"]["transitionUnits"],
                "profile": spec["decals"]["carve"]["profile"],
                "paintEdge": spec["decals"]["carve"]["paintEdge"],
                "occlusionDistance": spec["decals"]["carve"]["occlusionDistance"],
                "occlusionStrength": spec["decals"]["carve"]["occlusionStrength"],
                "grid": [
                    max(2, round(decal_width * spec["decals"]["carve"]["gridScale"])),
                    max(2, round(decal_height * spec["decals"]["carve"]["gridScale"])),
                ],
            },
            "note": "faceMatrix maps the decal image's full pixel rect (top-left origin, y down) onto decalQuad.",
        },
        "slots": [
            {
                "id": slot["id"],
                "pose": slot["pose"],
                "body": body_path.name,
                "x": x0,
                "y": y0,
                "width": x1 - x0,
                "height": y1 - y0,
                "faceQuad": [[round(px, 3), round(py, 3)] for px, py in face_quad],
                "decalQuad": [[round(px, 3), round(py, 3)] for px, py in decal_quad],
                "faceMatrix": css_matrix3d(matrix),
                "orientation": slot["orientation"],
                "drawOrder": slot["drawOrder"],
                "shadowGutterPx": gutter,
                "clipped": clipped,
            }
        ],
        "faces": {
            decal_spec["code"]: {decal_spec["orientation"]: decal_path.name},
        },
        "measurements": {
            "faceHeightPx": round(face_height_px, 2),
            "topEdgeProjectedPx": round(edge_px, 2),
            "blueSliverExpectedPx": round(edge_px * tile_spec["backEdgeFraction"], 2),
            "blueSliverMeasuredPx": sliver["bluePx"],
            "bodyMaxChannel": body_stats["maxChannel"],
            "bodyClippedPixels": body_stats["clippedPixels"],
            "decalMaxChannel": decal_stats["maxChannel"],
            "decalClippedPixels": decal_stats["clippedPixels"],
            "decalBakeSeconds": round(decal_seconds, 1),
        },
    }
    manifest_path = out_dir / spec["outputs"]["manifest"]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    log(f"manifest: {manifest_path}")
    log(
        "blue sliver: "
        f"{sliver['bluePx']} device px measured, "
        f"{round(edge_px * tile_spec['backEdgeFraction'], 2)} px expected "
        f"of a {round(edge_px, 2)} px top edge, on a {round(face_height_px, 2)} px face"
    )
    log(
        f"rig: {manifest['rig']['preset']} · "
        f"body peak {body_stats['maxChannel']}/255 ({body_stats['clippedPixels']} clipped) · "
        f"decal peak {decal_stats['maxChannel']}/255 ({decal_stats['clippedPixels']} clipped)"
    )


if __name__ == "__main__":
    main()
