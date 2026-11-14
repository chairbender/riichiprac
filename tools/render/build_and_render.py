#!/usr/bin/env python3
"""Build the rendered-table Blender scene from a JSON spec and bake its assets.

Everything is constructed procedurally here. There is no hand-modelled or
hand-edited .blend file, and no manual Blender interaction: render.sh runs this
script with the pinned Blender build, then validates the batch.

    blender --background --python tools/render/build_and_render.py -- \\
        tools/render/scene-spec.json frontend/public/table table

Two batches share one scene builder:

``table`` (the shipped batch, the default)
    Table background (felt, wall-ring track, hand aprons, compass base, rail),
    one body sprite per hand slot in both poses (face-up and the concealed
    face-down pose), the manifest, and the alignment/geometry checks.

``spike`` (the Task 1 review batch, ``render.sh --spike``)
    The Task 1/1.5 artifacts: one hand-slot body in both poses, the carved face
    decal, the homography composite, and the pixel zoom. No background: it is a
    single-tile study, and its PNGs are lossless so they can be inspected.

Outputs (paths relative to the output directory) in ``table`` mode:

    background.webp          opaque table background, scene CSS pixels
    bodies/<id>.webp         face-up body sprite of a hand slot, device px
    bodies/<id>-back.webp    the same slot face-down (concealed hand)
    manifest.json            scene, background, every slot, checks, budget

Coordinate conventions: world units are tile units (see the spec); scene pixels
in the manifest are rendered device pixels (CSS size x pixelRatio), origin
top-left, y down. Body sprites are cropped to the slot's projected bounds plus
the shadow gutter, so a slot rect is exactly where the runtime draws the file.
World axes: +X is screen right, -Y is toward the human's edge (the camera
stands at -Y looking across the table), +Z is up off the felt.
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


def set_samples(scene: bpy.types.Scene, samples: int, denoise: bool) -> tuple[int, bool]:
    previous = (scene.cycles.samples, scene.cycles.use_denoising)
    scene.cycles.samples = samples
    scene.cycles.use_denoising = denoise
    return previous


# --------------------------------------------------------------------------- #
# Materials
# --------------------------------------------------------------------------- #


def build_materials(spec: dict) -> dict[str, bpy.types.Material]:
    """The table and room materials.

    The tile body is not here: it is one material with an internal white/blue
    split (`build_tile_material`), because the split has to cut through the
    bevel rather than follow whole faces.
    """
    table = spec["table"]

    def plain(name: str, colour: dict, specular: float = 0.5) -> bpy.types.Material:
        material = new_material(name)
        node = principled(material)
        node.inputs["Base Color"].default_value = hex_linear(colour["hex"])
        node.inputs["Roughness"].default_value = colour["roughness"]
        node.inputs["Specular IOR Level"].default_value = specular
        return material

    # Felt is a matte wool cloth: almost no specular. The rail and the compass
    # plate are the only glossy table surfaces.
    return {
        "felt": plain("table-felt", table["surface"], 0.12),
        "apron": plain("table-hand-apron", table["apron"], 0.12),
        "track": plain("table-wall-ring", table["track"], 0.12),
        "trackEdge": plain("table-wall-ring-edge", table["trackEdge"], 0.1),
        "rail": plain("table-rail", table["rail"], 0.45),
        "compassPlate": plain("table-compass-plate", table["compassPlate"], 0.35),
        "room": plain("room-floor", table["room"], 0.1),
    }


def build_world(scene: bpy.types.Scene, spec: dict) -> None:
    world = bpy.data.worlds.new("world")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = hex_linear(spec["world"]["hex"])
    background.inputs["Strength"].default_value = spec["world"]["strength"]
    scene.world = world


# --------------------------------------------------------------------------- #
# Table geometry
# --------------------------------------------------------------------------- #


def table_plan(spec: dict) -> dict:
    """Derived table dimensions in tile units, recorded in the manifest.

    All numbers come from `table.plan`; the derived extents are computed here so
    the rail, the wall-ring track, the aprons, and the manifest can never drift
    apart. Values are tile units (1 unit = the 28 mm tile height), so the table
    reads as a real jansou: a 12.6-unit wall ring (17 stacks of 21 mm tiles) with
    a 3-unit river band and a standing hand row outside it.
    """
    plan = spec["table"]["plan"]
    felt = plan["feltHalfExtent"]
    outer = felt + plan["railWidth"]
    return {
        "feltHalfExtent": felt,
        "railInnerHalfExtent": felt,
        "railOuterHalfExtent": outer,
        "railWidth": plan["railWidth"],
        "railHeight": plan["railHeight"],
        "railDrop": plan["railDrop"],
        "wallRing": dict(plan["wallRing"]),
        "compass": dict(plan["compass"]),
        "handApron": dict(plan["handApron"]),
        "bandHeight": plan.get("bandHeight", 0.002),
    }


def mesh_from_parts(name: str, verts: list, faces: list, material, closed: bool = False):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    if closed:
        import bmesh

        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(mesh)
        bm.free()
    mesh.materials.append(material)
    return new_object(name, mesh)


def quad(name: str, corners: list, z: float, material) -> bpy.types.Object:
    """A flat, upward-facing quad from four (x, y) corners."""
    verts = [(x, y, z) for x, y in corners]
    return mesh_from_parts(name, verts, [(0, 1, 2, 3)], material)


def rect_corners(x0: float, y0: float, x1: float, y1: float) -> list:
    """Counter-clockwise from above, so the quad's normal is +Z."""
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def ring_bands(inner: float, outer: float) -> list:
    """Four non-overlapping rects forming a square ring between two extents."""
    return [
        (-outer, inner, outer, outer),
        (-outer, -outer, outer, -inner),
        (inner, -inner, outer, inner),
        (-outer, -inner, -inner, inner),
    ]


def rotated_corners(corners: list, angle_deg: float) -> list:
    angle = math.radians(angle_deg)
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    return [(x * cos_a - y * sin_a, x * sin_a + y * cos_a) for x, y in corners]


def build_table(spec: dict, materials: dict) -> dict:
    """Felt, wall-ring track, hand aprons, compass base, rail, and room floor.

    These are the static table surfaces the background is rendered from. They
    are also hidden for every body-sprite pass, so a sprite carries only the
    tile and its own contact shadow and composites cleanly over the background.
    """
    plan = table_plan(spec)
    felt_extent = plan["feltHalfExtent"]
    band_z = plan["bandHeight"] + 0.001

    # The felt is both the visible surface and the Cycles shadow catcher used by
    # the body passes; the background pass turns the catcher off.
    felt = quad(
        "felt",
        rect_corners(-felt_extent, -felt_extent, felt_extent, felt_extent),
        0.0,
        materials["felt"],
    )
    felt.is_shadow_catcher = spec["table"]["shadowCatcher"]

    parts = [felt]

    # Wall ring: the track the wall stacks are pushed up through, as three
    # concentric bands (dark edge, track, dark edge) flush on the felt.
    ring = plan["wallRing"]
    inner = ring["innerHalfExtent"]
    outer = ring["outerHalfExtent"]
    edge = ring["edgeWidth"]
    levels = [
        (inner, inner + edge, materials["trackEdge"]),
        (inner + edge, outer - edge, materials["track"]),
        (outer - edge, outer, materials["trackEdge"]),
    ]
    for index, (a, b, material) in enumerate(levels):
        verts: list = []
        faces: list = []
        for rect in ring_bands(a, b):
            start = len(verts)
            verts.extend([(x, y, band_z) for x, y in rect_corners(*rect)])
            faces.append((start, start + 1, start + 2, start + 3))
        parts.append(
            mesh_from_parts(f"wall-ring-{index}", verts, faces, material)
        )

    # Hand aprons: one flat felt pad per seat, just outside the river band, so
    # the standing hand row has a bed and a readable edge on the felt.
    apron = plan["handApron"]
    apron_corners = rect_corners(
        -apron["halfLength"], -apron["outer"], apron["halfLength"], -apron["inner"]
    )
    for seat, angle in (("bottom", 0), ("right", 90), ("top", 180), ("left", 270)):
        parts.append(
            quad(
                f"hand-apron-{seat}",
                rotated_corners(apron_corners, angle),
                band_z,
                materials["apron"],
            )
        )

    # Compass base: the static plate the runtime draws wind, score, and Riichi
    # markers on (the dynamic text is a DOM overlay, never baked).
    compass = plan["compass"]
    half = compass["halfExtent"]
    height = compass["height"]
    plate = mesh_from_parts(
        "compass-base",
        [
            (-half, -half, 0.0),
            (half, -half, 0.0),
            (half, half, 0.0),
            (-half, half, 0.0),
            (-half, -half, height),
            (half, -half, height),
            (half, half, height),
            (-half, half, height),
        ],
        [
            (0, 3, 2, 1),
            (4, 5, 6, 7),
            (0, 1, 5, 4),
            (1, 2, 6, 5),
            (2, 3, 7, 6),
            (3, 0, 4, 7),
        ],
        materials["compassPlate"],
        closed=True,
    )
    bevel = plate.modifiers.new("Bevel", "BEVEL")
    bevel.width = compass["bevel"]
    bevel.segments = 3
    bevel.limit_method = "ANGLE"
    bevel.angle_limit = math.radians(30)
    bevel.harden_normals = True
    parts.append(plate)

    # Rail: a closed wooden ring with a rounded top edge. The near (human-side)
    # outer wall is in frame, which is what frames the table at the bottom.
    rail_inner = plan["railInnerHalfExtent"]
    rail_outer = plan["railOuterHalfExtent"]
    rail_top = plan["railHeight"]
    rail_bottom = -plan["railDrop"]
    i, o = rail_inner, rail_outer
    verts = [
        (-i, -i, rail_top), (i, -i, rail_top), (i, i, rail_top), (-i, i, rail_top),
        (-o, -o, rail_top), (o, -o, rail_top), (o, o, rail_top), (-o, o, rail_top),
        (-i, -i, 0.0), (i, -i, 0.0), (i, i, 0.0), (-i, i, 0.0),
        (-o, -o, rail_bottom), (o, -o, rail_bottom), (o, o, rail_bottom), (-o, o, rail_bottom),
    ]
    faces = []
    for side in range(4):
        nxt = (side + 1) % 4
        faces.append((4 + side, 4 + nxt, nxt, side))            # top ring
        faces.append((side, nxt, 8 + nxt, 8 + side))            # inner wall
        faces.append((12 + side, 12 + nxt, 4 + nxt, 4 + side))  # outer wall
        faces.append((8 + side, 8 + nxt, 12 + nxt, 12 + side))  # bottom ring
    rail = mesh_from_parts("rail", verts, faces, materials["rail"], closed=True)
    rail_bevel = rail.modifiers.new("Bevel", "BEVEL")
    rail_bevel.width = spec["table"]["plan"]["railBevel"]
    rail_bevel.segments = 3
    rail_bevel.limit_method = "ANGLE"
    rail_bevel.angle_limit = math.radians(30)
    rail_bevel.harden_normals = True
    parts.append(rail)

    # Room floor below the rail, so the frame corners outside the table are the
    # dark room rather than the world colour.
    room_extent = rail_outer * 8.0
    room = quad(
        "room-floor",
        rect_corners(-room_extent, -room_extent, room_extent, room_extent),
        rail_bottom,
        materials["room"],
    )
    parts.append(room)

    log(
        f"table: {2 * rail_outer:.2f} units across (rail {plan['railWidth']:g}, "
        f"felt {2 * felt_extent:.2f}), wall ring {2 * outer:.2f} x "
        f"{outer - inner:.2f}, compass {2 * half:.2f}, "
        f"apron {apron['inner']:g}..{apron['outer']:g}"
    )
    return {"felt": felt, "parts": parts, "rail": rail}


def build_melamine(node: bpy.types.ShaderNode, spec: dict, specular: float) -> None:
    """Apply one melamine material description to a Principled BSDF."""
    node.inputs["Base Color"].default_value = hex_linear(spec["hex"])
    node.inputs["Roughness"].default_value = spec["roughness"]
    node.inputs["Specular IOR Level"].default_value = specular
    node.inputs["Coat Weight"].default_value = spec["coat"]
    node.inputs["Coat Roughness"].default_value = spec["coatRoughness"]


def build_tile_material(spec: dict) -> bpy.types.Material:
    """The whole tile body in one material: white face plate, blue backing.

    The colour split is a **shader gate on the object's local Z** at
    `backEdgeFraction` of the thickness, not a per-face material assignment.
    That matters at the corners: the bevel rounds the vertical edges with new
    geometry, and a per-face assignment gives each rounded corner face a single
    material, so the blue side bands stop at the corner instead of wrapping it.
    A shader gate cuts through the bevel geometry at the same depth as the flat
    side faces, so the blue is flush with the white at every point around the
    tile, and `backEdgeFraction` stays a single number in the spec.
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


def build_tile(scene: bpy.types.Scene, spec: dict, materials: dict) -> bpy.types.Object:
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

    The rig is deliberately distant (see rendered-table-plan.md §12 and the
    Task 1 findings): a decal is lit once per orientation and composited onto
    bodies at every slot, so illumination must not vary much across the table.
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
    manifest can never describe a rig the sprites were not baked with. Tasks 3+
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


def camera_record(spec: dict) -> dict:
    camera = spec["camera"]
    position = Vector(camera["position"])
    target = Vector(camera["target"])
    delta = position - target
    horizontal = math.hypot(delta.x, delta.y)
    return {
        "position": camera["position"],
        "target": camera["target"],
        "lensMm": camera["lensMm"],
        "sensorWidthMm": camera["sensorWidthMm"],
        "shiftY": camera["shiftY"],
        "elevationDeg": round(math.degrees(math.atan2(delta.z, horizontal)), 2),
        "distanceUnits": round(delta.length, 3),
    }


# --------------------------------------------------------------------------- #
# Hand slot inventory
# --------------------------------------------------------------------------- #


def hand_slots(spec: dict) -> list[dict]:
    """The human's hand row: 13 concealed slots plus the separated draw.

    The row (including the draw) is centred on `hand.centerX`, and the draw sits
    `drawGap` beyond the last concealed slot, so the runtime can append the
    drawn tile the way `HandDock` already does. Slot ids are stable: `hand-0` …
    `hand-12` for the concealed tiles, `hand-draw` for the drawn one.
    """
    hand = spec["hand"]
    count = hand["concealedCount"]
    spacing = hand["spacing"]
    gap = hand["drawGap"]
    tile_width = spec["tile"]["width"]
    concealed_span = (count - 1) * spacing
    total_width = concealed_span + spacing + gap + tile_width
    first_x = hand["centerX"] - total_width / 2.0 + tile_width / 2.0
    order_base = hand.get("drawOrderBase", 40)

    slots = []
    for index in range(count):
        slots.append(
            {
                "id": f"hand-{index}",
                "seat": hand["seat"],
                "role": "concealed",
                "index": index,
                "pose": hand["pose"],
                "backPose": hand["backPose"],
                "x": first_x + index * spacing,
                "y": hand["y"],
                "orientation": "upright",
                "drawOrder": order_base + index,
            }
        )
    slots.append(
        {
            "id": "hand-draw",
            "seat": hand["seat"],
            "role": "draw",
            "index": count,
            "pose": hand["pose"],
            "backPose": hand["backPose"],
            "x": first_x + concealed_span + spacing + gap,
            "y": hand["y"],
            "orientation": "upright",
            "drawOrder": order_base + count,
        }
    )
    return slots


def pose_matrix(pose: str, slot: dict, spec: dict) -> Matrix:
    """Object matrix for a slot pose.

    Tiles are modelled flat, face up (+Z), symbol top toward +Y. The hand pose
    stands a tile vertically with its face toward the player (-Y) and its foot
    on the table (local +Y becomes world +Z). The back pose turns the same
    standing tile 180° about the vertical axis, so the blue back faces the
    camera: the concealed-hand pose. Both poses occupy the same felt footprint.
    """
    tile = spec["tile"]
    if pose == "hand-upright":
        rotation = Matrix.Rotation(math.radians(90.0), 4, "X")
        location = Vector((slot["x"], slot["y"] + tile["thickness"], tile["height"] / 2.0))
        return Matrix.Translation(location) @ rotation
    if pose == "hand-upright-back":
        rotation = Matrix.Rotation(math.radians(180.0), 4, "Z") @ Matrix.Rotation(
            math.radians(90.0), 4, "X"
        )
        location = Vector((slot["x"], slot["y"], tile["height"] / 2.0))
        return Matrix.Translation(location) @ rotation
    raise ValueError(f"unknown pose {pose!r}")


def apply_pose(obj: bpy.types.Object, slot: dict, spec: dict, pose: str | None = None) -> None:
    obj.matrix_world = pose_matrix(pose or slot["pose"], slot, spec)


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
# Rendering and image IO
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


def save_raster(
    scene: bpy.types.Scene,
    path: Path,
    pixels: np.ndarray,
    file_format: str,
    quality: int,
    colour_mode: str = "RGBA",
) -> int:
    """Write display-referred pixels as PNG/WEBP through the scene's settings.

    The numpy arrays in this pipeline hold final 8-bit display values (they came
    out of a render, or were composited from renders), so this never applies a
    view transform to them: it is the same save path for the review PNGs and the
    shipped WebP sprites.
    """
    height, width = pixels.shape[:2]
    image = bpy.data.images.new(path.stem, width=width, height=height, alpha=True)
    image.pixels = np.flipud(pixels[..., :4]).ravel().tolist()
    settings = scene.render.image_settings
    previous = (settings.file_format, settings.color_mode, settings.quality)
    settings.file_format = file_format
    settings.color_mode = colour_mode
    settings.quality = quality
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save_render(str(path), scene=scene)
    settings.file_format, settings.color_mode, settings.quality = previous
    bpy.data.images.remove(image)
    size = path.stat().st_size
    log(f"wrote {path.name} ({width}x{height}, {size} bytes)")
    return size


def downsample_box(pixels: np.ndarray, factor: int) -> np.ndarray:
    """Box-filter an image down by an integer factor (area average)."""
    if factor <= 1:
        return pixels
    height, width = pixels.shape[:2]
    if height % factor or width % factor:
        die(f"cannot downsample {width}x{height} by {factor}")
    shape = (height // factor, factor, width // factor, factor, pixels.shape[2])
    return pixels.reshape(shape).mean(axis=(1, 3))


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


def composite_supersample(matrix: np.ndarray, override: int | None = None) -> int:
    """Sub-pixel samples per axis when warping the decal onto the body.

    `override` comes from `decals.compositeSupersample`: 1 is a single bilinear
    sample (the Task 1.5 default, which shows a sub-pixel fillet highlight as a
    bright dashed "sparkle"), and any higher number box-filters the pixel. Left
    unset, the value is derived from the homography so the box filter stays just
    past Nyquist; the decal is ~3.75x denser than the face it lands on.
    """
    if override:
        return int(max(1, override))
    forward = math.sqrt(abs(float(np.linalg.det(matrix[:2, :2]))))
    texels_per_pixel = 1.0 / max(forward, 1e-6)
    return int(min(6, max(2, math.ceil(texels_per_pixel * 1.25))))


def warp_onto(
    canvas: np.ndarray,
    decal: np.ndarray,
    matrix: np.ndarray,
    origin: tuple[int, int],
    supersample: int | None = None,
) -> np.ndarray:
    """Warp the decal onto the canvas with a homography and composite it.

    The decal is rendered at 3x CSS while the face it lands on is under 100 CSS
    px, so this is a heavy *minification*. One bilinear sample per output pixel
    skips most texels, and a 1 px specular line inside a fillet then flips on
    and off from pixel to pixel: the fillet reads as dashes or "zebra stripes".
    At `supersample > 1` every output pixel is box-filtered with an N x N grid of
    sub-pixel samples, so the streak resolves as a continuous (if dimmer) line,
    which is what the browser's own image filtering does at runtime.
    """
    inverse = np.linalg.inv(matrix)
    height, width = canvas.shape[:2]
    supersample = composite_supersample(matrix, supersample)

    decal_height, decal_width = decal.shape[:2]
    decal_premultiplied = np.concatenate(
        [decal[..., :3] * decal[..., 3:4], decal[..., 3:4]], axis=-1
    )

    accumulated = np.zeros((height, width, 4), dtype=np.float64)
    for offset_y in range(supersample):
        for offset_x in range(supersample):
            xs, ys = np.meshgrid(
                np.arange(width) + (offset_x + 0.5) / supersample,
                np.arange(height) + (offset_y + 0.5) / supersample,
            )
            src_x, src_y = apply_homography(inverse, xs + origin[0], ys + origin[1])
            inside = (
                (src_x >= 0.0)
                & (src_x <= decal_width)
                & (src_y >= 0.0)
                & (src_y <= decal_height)
            )
            sampled = sample_bilinear(decal_premultiplied, src_x, src_y)
            sampled[~inside] = 0.0
            accumulated += sampled
    accumulated /= supersample * supersample

    alpha = accumulated[..., 3:4]
    straight = np.where(alpha > 0.0, accumulated[..., :3] / np.maximum(alpha, 1e-8), 0.0)
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
# Body sprites and the table background
# --------------------------------------------------------------------------- #


def hide_parts(parts: list, hidden: bool) -> None:
    for part in parts:
        part.hide_render = hidden


def bake_body(
    spec: dict,
    scene: bpy.types.Scene,
    camera: bpy.types.Object,
    tile: bpy.types.Object,
    table: dict,
    slot: dict,
    pose: str,
    out_dir: Path,
    path: Path,
    gutter: int,
) -> dict:
    """Bake one body sprite: the posed tile over its shadow-catcher contact shadow.

    Pass 1 renders the tile alone with transparent film (straight alpha). Pass 2
    renders the felt as a Cycles shadow catcher with the tile invisible to the
    camera but still occluding the lights, which returns the contact shadow as a
    black colour with alpha = shadow coverage. The two are combined here, so a
    sprite composites over the baked background with no runtime shadow layer.

    Every other table part is hidden in both passes: the background already
    carries the rail, track, and apron shading, and a part's shadow must not be
    counted twice.

    Returns the sprite, its device-pixel crop rect, whether the crop hit the
    frame edge, and the tile-only alpha (used by the alignment check).
    """
    apply_pose(tile, slot, spec, pose)
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
    if clipped:
        die(f"slot {slot['id']} body crop {rect} touches the frame edge")

    # Pass 1: the tile alone with transparent film; every table part hidden.
    hide_parts(table["parts"], True)
    body = render_region(scene, out_dir / "_body-pass.png", rect)
    if body.shape[:2] != (y1 - y0, x1 - x0):
        die(f"body render is {body.shape[1]}x{body.shape[0]}, expected {x1 - x0}x{y1 - y0}")

    # Pass 2: only the shadow catcher plus the tile as an occluder. Parts stay
    # hidden so their shadows are not baked into the sprite as well.
    table["felt"].hide_render = False
    tile.visible_camera = False
    shadow = render_region(scene, out_dir / "_shadow-pass.png", rect)
    tile.visible_camera = True
    table["felt"].hide_render = True
    clear_border(scene)
    (out_dir / "_body-pass.png").unlink()
    (out_dir / "_shadow-pass.png").unlink()

    sprite = over(shadow, body)  # tile over its contact shadow
    assets = spec["assets"]
    save_raster(
        scene,
        path,
        sprite,
        assets["body"]["fileFormat"],
        assets["body"]["quality"],
    )
    log(f"body sprite: {path.name} ({x1 - x0}x{y1 - y0})")
    return {
        "sprite": sprite,
        "rect": rect,
        "clipped": clipped,
        "alpha": body[..., 3].copy(),
        "path": path,
    }


def asset_samples(spec: dict) -> int:
    """Samples for the background pass (defaults to the scene's own count)."""
    return int(spec["assets"]["background"].get("samples", spec["scene"]["samples"]))


def bake_background(
    spec: dict,
    scene: bpy.types.Scene,
    tile: bpy.types.Object,
    table: dict,
    out_dir: Path,
    path: Path,
) -> dict:
    """Render the static table from the same fixed camera as the body sprites.

    The felt stops being a shadow catcher and the film becomes opaque, so the
    render is a normal lit table: felt, wall-ring track, hand aprons, compass
    base, rail, and the room floor outside the rail. It is rendered at the scene
    resolution (2x) and box-filtered down to the shipped background size.

    Because body sprites are cropped regions of this same camera, a sprite drawn
    at its manifest rect lands exactly on the background; the alignment check
    verifies that with a rendered tile mask.
    """
    hide_parts(table["parts"], False)
    tile.hide_render = True
    table["felt"].is_shadow_catcher = False
    scene.render.film_transparent = False
    clear_border(scene)

    # The background is a full frame of broad, low-frequency lighting, so it
    # needs far fewer samples than a 160-px body crop with a bevel highlight on
    # it: 64 + OIDN is indistinguishable from the scene's 256 at this exposure
    # and keeps the batch to minutes rather than half an hour.
    samples = asset_samples(spec)
    previous = set_samples(scene, samples, True)

    render_path = out_dir / "_background-render.png"
    started = time.perf_counter()
    render_png(scene, render_path)
    seconds = time.perf_counter() - started
    scene.cycles.samples, scene.cycles.use_denoising = previous
    log(f"background render: {seconds:.1f}s at {samples} samples")

    full = load_rgba(render_path)
    render_path.unlink()
    scene.render.film_transparent = spec["scene"]["filmTransparent"]
    table["felt"].is_shadow_catcher = spec["table"]["shadowCatcher"]
    hide_parts(table["parts"], True)

    asset = spec["assets"]["background"]
    shipped = downsample_box(full, asset.get("downscale", 1))
    size = save_raster(
        scene,
        path,
        shipped,
        asset["fileFormat"],
        asset["quality"],
        colour_mode="RGB",
    )
    return {
        "path": path,
        "pixels": [int(shipped.shape[1]), int(shipped.shape[0])],
        "bytes": size,
        "renderPixels": [int(full.shape[1]), int(full.shape[0])],
        "renderSeconds": round(seconds, 1),
        "renderSamples": samples,
        "stats": channel_stats(shipped),
        "image": shipped,
        "render": full,
    }


def paste(canvas: np.ndarray, sprite: np.ndarray, x: int, y: int) -> np.ndarray:
    """Composite a straight-alpha sprite onto a canvas at a device-pixel origin."""
    height, width = canvas.shape[:2]
    sprite_height, sprite_width = sprite.shape[:2]
    x0 = max(0, x)
    y0 = max(0, y)
    x1 = min(width, x + sprite_width)
    y1 = min(height, y + sprite_height)
    if x1 <= x0 or y1 <= y0:
        return canvas
    source = sprite[y0 - y : y1 - y, x0 - x : x1 - x]
    target = canvas[y0:y1, x0:x1]
    canvas[y0:y1, x0:x1] = over(target, source)
    return canvas


def render_review_composite(
    spec: dict,
    scene: bpy.types.Scene,
    background: np.ndarray,
    records: list,
    pose_key: str,
    path: Path,
) -> Path:
    """Composite the batch over the background exactly as the runtime will.

    This is a review artifact, not a shipped asset: it is the proof that every
    sprite lands where the manifest says, and the picture a human should check
    after a regeneration. It is assembled in device pixels (the manifest's own
    space, so nothing is scaled) and then box-filtered down to the shipped
    background size for viewing.
    """
    canvas = background.copy()
    for record, face, _ in sorted(records, key=lambda item: item[0]["drawOrder"]):
        sprite = face["sprite"] if pose_key == "face" else face["back_sprite"]
        if sprite is None:
            continue
        source = record if pose_key == "face" else record["back"]
        canvas = paste(canvas, sprite, source["x"], source["y"])
    canvas[..., 3] = 1.0
    review = downsample_box(canvas, spec["assets"]["background"].get("downscale", 1))
    save_raster(scene, path, review, "PNG", 100, colour_mode="RGB")
    return path


def render_tile_mask(
    spec: dict,
    scene: bpy.types.Scene,
    tile: bpy.types.Object,
    table: dict,
    slots: list[dict],
    out_dir: Path,
) -> np.ndarray:
    """Render the alpha coverage of every slot's tile in a single frame.

    The sprites are baked one slot at a time, so this is the independent
    reference the per-slot crops are checked against: same camera, same
    resolution, all tiles present at once, one sample with denoising off (alpha
    is geometric coverage, so extra samples buy nothing).
    """
    hide_parts(table["parts"], True)
    scene.render.film_transparent = True
    tile.hide_render = True
    references = []
    for slot in slots:
        # Object copy, not a new object on the same mesh: the bevel and weighted
        # normal modifiers live on the object, and the reference must be the
        # same bevelled silhouette the sprites were baked from.
        holder = tile.copy()
        holder.name = f"ref-{slot['id']}"
        holder.hide_render = False
        holder.visible_camera = True
        bpy.context.scene.collection.objects.link(holder)
        holder.matrix_world = pose_matrix(slot["pose"], slot, spec)
        references.append(holder)
    sync_view_layer()

    previous = set_samples(scene, spec["checks"].get("referenceSamples", 8), False)
    path = out_dir / "_mask-reference.png"
    render_png(scene, path)
    scene.cycles.samples, scene.cycles.use_denoising = previous
    mask = load_rgba(path)[..., 3]
    path.unlink()

    for holder in references:
        bpy.data.objects.remove(holder, do_unlink=True)
    scene.render.film_transparent = spec["scene"]["filmTransparent"]
    return mask


def dilate(mask: np.ndarray, radius: int = 1) -> np.ndarray:
    """Binary dilation with a (2r+1)^2 window, edge-clamped."""
    out = mask.copy()
    for _ in range(radius):
        padded = np.pad(out, 1, mode="edge")
        out = (
            padded[1:-1, 1:-1]
            | padded[:-2, 1:-1]
            | padded[2:, 1:-1]
            | padded[1:-1, :-2]
            | padded[1:-1, 2:]
        )
    return out


def compare_alignment(
    reference: np.ndarray, baked: np.ndarray, records: list, tolerance: float = 0.5
) -> dict:
    """Check the batch against a single render with every slot's tile present.

    `baked` is the per-slot pass-1 alpha of each sprite pasted at its manifest
    rect, i.e. exactly what the runtime will draw. The reference is one frame
    rendered with all the tiles in the scene at once. If a crop or a rect is a
    pixel off, the two silhouettes disagree by a whole pixel; a one-pixel
    dilation on each side absorbs anti-aliasing and denoiser softness, so only a
    real shift fails the check. Adjacent hand tiles overlap slightly in
    projection, which is why the comparison is whole-frame: the baked canvas
    carries the neighbour too, exactly as the scene does.

    Disagreeing pixels are attributed to the slot whose rect contains them, so a
    failure names the sprite to look at.
    """
    reference_solid = reference > 0.5
    baked_solid = baked > 0.5
    missing = baked_solid & ~dilate(reference_solid)
    extra = reference_solid & ~dilate(baked_solid)
    shifted = missing | extra

    union = int((reference_solid | baked_solid).sum())
    soft = int((np.abs(reference - baked) > tolerance).sum())

    rows = []
    total_shifted = 0
    for record, _, slot in records:
        x0, y0 = record["x"], record["y"]
        x1 = x0 + record["width"]
        y1 = y0 + record["height"]
        band = (
            slice(max(0, y0), min(shifted.shape[0], y1)),
            slice(max(0, x0), min(shifted.shape[1], x1)),
        )
        count = int(shifted[band].sum())
        total_shifted += count
        rows.append({"id": slot["id"], "shiftedPixels": count})

    return {
        "method": (
            "every slot's sprite alpha pasted at its manifest rect against one "
            "frame rendered with all tiles present; a one-pixel dilation absorbs "
            "anti-aliasing, so any shifted pixel is a real misalignment"
        ),
        "slots": rows,
        "tilePixels": union,
        "shiftedPixels": total_shifted,
        "softPixels": soft,
        "softPixelFraction": round(soft / max(union, 1), 6),
        "softTolerance": tolerance,
    }


def alpha_centroid(alpha: np.ndarray) -> np.ndarray:
    """Coverage-weighted centre of a tile mask, in pixels."""
    weights = np.clip(alpha.astype(np.float64), 0.0, 1.0)
    total = weights.sum()
    if total <= 0.0:
        return np.array([0.0, 0.0])
    ys, xs = np.indices(weights.shape)
    return np.array([(weights * xs).sum() / total, (weights * ys).sum() / total])


# --------------------------------------------------------------------------- #
# Carved face plate (spike batch)
# --------------------------------------------------------------------------- #


def decal_geometry(spec: dict) -> dict:
    """Decal pixel size and frame size for the canonical face-on rig.

    Known from the spec alone, so the manifest can carry every slot's face quad
    and `faceMatrix` without rendering a decal (Task 3 fills `faces`).
    """
    tile = spec["tile"]
    decals = spec["decals"]
    px_per_unit = decals["renderScale"] * decals["cssFace"][1] / tile["height"]
    inset_w = tile["width"] - 2 * tile["faceInset"]
    inset_h = tile["height"] - 2 * tile["faceInset"]
    padding = decals["paddingPixels"]
    width = round(inset_w * px_per_unit) + 2 * padding
    height = round(inset_h * px_per_unit) + 2 * padding
    return {
        "pixels": [width, height],
        "frameUnits": [width / px_per_unit, height / px_per_unit],
        "pxPerUnit": px_per_unit,
        "paddingPixels": padding,
    }


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
    table: dict,
    out_dir: Path,
) -> tuple[Path, int, int, float, float]:
    """Render the carved, painted, lit face decal (spike batch)."""
    tile_spec = spec["tile"]
    decal_spec = spec["spike"]["decal"]
    rig = spec["decals"]["rigs"][decal_spec["orientation"]]
    geometry = decal_geometry(spec)
    decal_width, decal_height = geometry["pixels"]
    frame_w, frame_h = geometry["frameUnits"]
    px_per_unit = geometry["pxPerUnit"]

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
    hide_parts(table["parts"], True)

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

    decal_path = out_dir / spec["spike"]["outputs"]["decal"].format(
        code=decal_spec["code"], orientation=decal_spec["orientation"]
    )
    render_png(scene, decal_path)
    decal = load_rgba(decal_path)
    if decal.shape[:2] != (decal_height, decal_width):
        die(
            f"decal render is {decal.shape[1]}x{decal.shape[0]}, "
            f"expected {decal_width}x{decal_height}"
        )
    log(f"face decal: {decal_path.name} ({decal_width}x{decal_height})")

    # Restore the scene camera and resolution for the composite.
    scene.camera = camera
    scene.render.resolution_x = round(spec["scene"]["widthCss"] * spec["scene"]["pixelRatio"])
    scene.render.resolution_y = round(spec["scene"]["heightCss"] * spec["scene"]["pixelRatio"])
    return decal_path, decal_width, decal_height, frame_w, frame_h


# --------------------------------------------------------------------------- #
# Manifest checks
# --------------------------------------------------------------------------- #


def check_slots(manifest: dict) -> dict:
    """Fail the batch if a slot rect or a face quad is out of bounds.

    - every body rect must sit fully inside the scene's device-pixel space;
    - every face/decal quad corner must sit inside its own body sprite rect (so
      a decal can never be drawn outside the body it composites onto);
    - every slot must carry an orientation class and a draw order.

    Returns the numbers the manifest records, so the shipped file proves the
    checks ran.
    """
    scene = manifest["scene"]
    width = scene["widthDevicePx"]
    height = scene["heightDevicePx"]
    orientations = {"upright", "flat-upright", "left", "right", "opposite"}
    orders = set()
    face_checks = 0
    for slot in manifest["slots"]:
        bodies = [("body", slot)]
        if slot.get("back"):
            bodies.append(("back", slot["back"]))
        if slot.get("orientation") not in orientations:
            die(f"slot {slot['id']} has unknown orientation {slot.get('orientation')!r}")
        if slot["drawOrder"] in orders:
            die(f"slot {slot['id']} reuses draw order {slot['drawOrder']}")
        orders.add(slot["drawOrder"])
        for label, record in bodies:
            x, y = record["x"], record["y"]
            w, h = record["width"], record["height"]
            if x < 0 or y < 0 or x + w > width or y + h > height:
                die(
                    f"slot {slot['id']} {label} rect "
                    f"({x}, {y}, {w}x{h}) is outside the "
                    f"{width}x{height} scene"
                )
        for corner_x, corner_y in slot.get("faceQuad", []) + slot.get("decalQuad", []):
            if not (
                slot["x"] <= corner_x <= slot["x"] + slot["width"]
                and slot["y"] <= corner_y <= slot["y"] + slot["height"]
            ):
                die(
                    f"slot {slot['id']} face corner ({corner_x}, {corner_y}) is "
                    "outside its body sprite"
                )
        face_checks += 1
    return {
        "slotCount": len(manifest["slots"]),
        "slotRectsInsideScene": True,
        "faceQuadsInsideBodies": True,
        "uniqueDrawOrders": True,
        "faceQuadCount": face_checks,
    }


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def parse_args() -> tuple[Path, Path, str]:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(argv) not in (2, 3):
        die("usage: build_and_render.py -- <scene-spec.json> <out-dir> [table|spike]")
    spec_path = Path(argv[0]).resolve()
    out_dir = Path(argv[1]).resolve()
    mode = argv[2] if len(argv) == 3 else "table"
    if mode not in ("table", "spike"):
        die(f"unknown batch {mode!r}; expected table or spike")
    return spec_path, out_dir, mode


def main() -> None:
    spec_path, out_dir, mode = parse_args()
    spec = json.loads(spec_path.read_text())
    # The parameter tuner writes a preview spec and expects the spike batch.
    if spec.get("preview"):
        mode = "spike"
    out_dir.mkdir(parents=True, exist_ok=True)

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
    table = build_table(spec, materials)
    tile = build_tile(scene, spec, materials)
    hide_parts(table["parts"], True)

    assets = spec["assets"]
    gutter = assets["shadowGutterDevicePx"]
    if mode == "spike":
        # The review batch keeps its lossless PNGs so bevel, alpha, and the decal
        # seam can be inspected; only the shipped batch is lossy WebP.
        assets["body"]["fileFormat"] = "PNG"
        assets["body"]["quality"] = 100
    body_format = assets["body"]["fileFormat"]
    body_ext = "webp" if body_format == "WEBP" else body_format.lower()
    slots = hand_slots(spec)
    preview = spec.get("preview", {})
    if mode == "spike":
        spike_slot_id = spec["spike"]["slotId"]
        slots = [slot for slot in slots if slot["id"] == spike_slot_id]
        if not slots:
            die(f"spike.slotId {spike_slot_id!r} is not a hand slot")

    log(f"batch {mode}: {len(slots)} hand slot(s) -> {out_dir}")

    # ---- body sprites ---------------------------------------------------- #
    records = []
    first_matrix = None
    # The tuner's decal-only preview needs nothing but the decal itself.
    bake_slots = [] if preview.get("decalOnly") else slots
    for slot in bake_slots:
        face_path = out_dir / spec["outputs"]["body"].format(id=slot["id"], ext=body_ext)
        face = bake_body(
            spec, scene, camera, tile, table, slot, slot["pose"], out_dir, face_path, gutter
        )
        x0, y0, x1, y1 = face["rect"]
        record = {
            "id": slot["id"],
            "seat": slot["seat"],
            "role": slot["role"],
            "index": slot["index"],
            "pose": slot["pose"],
            "orientation": slot["orientation"],
            "drawOrder": slot["drawOrder"],
            "body": str(face_path.relative_to(out_dir)),
            "x": x0,
            "y": y0,
            "width": x1 - x0,
            "height": y1 - y0,
            "shadowGutterPx": gutter,
        }

        back_record = None
        face["back_sprite"] = None
        if not preview.get("decalOnly") and not preview.get("skipBack"):
            back_path = out_dir / spec["outputs"]["body"].format(
                id=f"{slot['id']}-back", ext=body_ext
            )
            back = bake_body(
                spec,
                scene,
                camera,
                tile,
                table,
                slot,
                slot["backPose"],
                out_dir,
                back_path,
                gutter,
            )
            bx0, by0, bx1, by1 = back["rect"]
            face["back_sprite"] = back["sprite"]
            back_record = {
                "pose": slot["backPose"],
                "body": str(back_path.relative_to(out_dir)),
                "x": bx0,
                "y": by0,
                "width": bx1 - bx0,
                "height": by1 - by0,
            }

        # ---- face projection --------------------------------------------- #
        decal = decal_geometry(spec)
        frame_w, frame_h = decal["frameUnits"]
        apply_pose(tile, slot, spec)
        sync_view_layer()
        face_quad = [
            project(scene, camera, tile.matrix_world @ corner) for corner in face_corners(spec)
        ]
        decal_quad = [
            project(scene, camera, tile.matrix_world @ corner)
            for corner in face_corners(spec, (frame_w / 2.0, frame_h / 2.0))
        ]
        src = np.array(
            [
                [0, 0],
                [decal["pixels"][0], 0],
                [decal["pixels"][0], decal["pixels"][1]],
                [0, decal["pixels"][1]],
            ],
            dtype=np.float64,
        )
        dst = np.array(decal_quad, dtype=np.float64)
        matrix = quad_homography(src, dst)
        check_x, check_y = apply_homography(matrix, src[:, 0], src[:, 1])
        if not np.allclose(np.stack([check_x, check_y], axis=1), dst, atol=1e-6):
            die(f"slot {slot['id']}: face homography misses the decal quad")

        record.update(
            {
                "faceQuad": [[round(px, 3), round(py, 3)] for px, py in face_quad],
                "decalQuad": [[round(px, 3), round(py, 3)] for px, py in decal_quad],
                "faceMatrix": css_matrix3d(matrix),
                "back": back_record,
                "measurements": {
                    "faceHeightPx": round(abs(face_quad[3][1] - face_quad[0][1]), 2),
                    "faceWidthPx": round(
                        (abs(face_quad[1][0] - face_quad[0][0])
                         + abs(face_quad[2][0] - face_quad[3][0])) / 2.0,
                        2,
                    ),
                },
            }
        )
        if first_matrix is None:
            first_matrix = matrix
        records.append((record, face, slot))

    # ---- alignment check ------------------------------------------------- #
    mask_check = None
    if not preview.get("decalOnly"):
        # Paste every sprite's tile alpha at its manifest rect, exactly as the
        # runtime will, then compare the whole frame against a render of all the
        # tiles at once.
        baked_alpha = np.zeros((render_height, render_width), dtype=np.float32)
        for record, face, _ in sorted(records, key=lambda item: item[0]["drawOrder"]):
            x0, y0 = record["x"], record["y"]
            x1 = x0 + record["width"]
            y1 = y0 + record["height"]
            baked_alpha[y0:y1, x0:x1] = np.maximum(
                baked_alpha[y0:y1, x0:x1], face["alpha"]
            )
        reference = render_tile_mask(
            spec, scene, tile, table, [slot for _, _, slot in records], out_dir
        )
        mask_check = compare_alignment(reference, baked_alpha, records)
        if spec["checks"].get("dumpAlignment"):
            dump = RENDER_DIR / "build" / "align"
            dump.mkdir(parents=True, exist_ok=True)
            stack = np.concatenate([reference, baked_alpha], axis=1)
            save_rgba(
                dump / "mask.png",
                np.stack([stack, stack, stack, np.ones_like(stack)], axis=-1),
            )
        log(
            "tile alignment: "
            f"{mask_check['shiftedPixels']} shifted px of "
            f"{mask_check['tilePixels']} tile px, "
            f"soft-edge {mask_check['softPixelFraction']:.4%}"
        )
        if mask_check["shiftedPixels"] > 0:
            worst = sorted(
                mask_check["slots"], key=lambda row: -row["shiftedPixels"]
            )[:3]
            die(
                "baked body sprites do not line up with the rendered scene: "
                f"{mask_check['shiftedPixels']} pixels disagree by a full pixel "
                f"(worst slots: {worst})"
            )
        if mask_check["softPixelFraction"] > spec["checks"]["maxMaskMismatchFraction"]:
            die(
                "baked body sprites differ from the rendered scene: "
                f"{mask_check['softPixelFraction']:.4%} of tile pixels"
            )

    # ---- background ------------------------------------------------------ #
    background = None
    if mode == "table":
        background = bake_background(
            spec,
            scene,
            tile,
            table,
            out_dir,
            out_dir / spec["outputs"]["background"].format(ext=assets["background"]["fileFormat"].lower()),
        )
        review_dir = RENDER_DIR / "build" / "review"
        render_review_composite(
            spec, scene, background["render"], records, "face", review_dir / "hand-face-up.png"
        )
        render_review_composite(
            spec, scene, background["render"], records, "back", review_dir / "hand-face-down.png"
        )
        log(f"review composite: {review_dir}")

    # ---- decal and composite (spike batch) ------------------------------- #
    face_entries: dict = {}
    measurements: dict = {}
    if mode == "spike":
        decal_spec = spec["spike"]["decal"]
        top = spec["tile"]["thickness"]
        decal_started = time.perf_counter()
        decal_path, decal_width, decal_height, frame_w, frame_h = bake_decal(
            spec, scene, camera, tile, table, out_dir
        )
        decal_seconds = time.perf_counter() - decal_started
        log(f"decal bake: {decal_seconds:.1f}s")
        if preview.get("decalOnly"):
            log("preview: decal only, skipping composite/manifest")
            return
        decal = load_rgba(decal_path)
        face_entries = {decal_spec["code"]: {decal_spec["orientation"]: decal_path.name}}

        record, face, slot = records[0]
        matrix = quad_homography(
            np.array(
                [
                    [0, 0],
                    [decal_width, 0],
                    [decal_width, decal_height],
                    [0, decal_height],
                ],
                dtype=np.float64,
            ),
            np.array(record["decalQuad"], dtype=np.float64),
        )
        first_matrix = matrix
        supersample = composite_supersample(matrix, spec["decals"].get("compositeSupersample"))
        log(
            f"composite: {supersample}x{supersample} samples per pixel"
            + (" (point-sampled: sub-pixel highlights sparkle)" if supersample == 1 else "")
        )
        composite = warp_onto(
            face["sprite"], decal, matrix, (record["x"], record["y"]), supersample
        )
        composite_path = out_dir / spec["spike"]["outputs"]["composite"].format(
            code=decal_spec["code"], orientation=decal_spec["orientation"]
        )
        save_rgba(composite_path, composite)
        log(f"composite: {composite_path.name}")

        # Pixel-perfect (nearest) review zoom, generated here so the sheet does
        # not rely on the SVG rasteriser honouring image-rendering="pixelated".
        zoom = spec["spike"]["zoom"]
        zoom_crop = composite[
            zoom["y"] : zoom["y"] + zoom["height"], zoom["x"] : zoom["x"] + zoom["width"]
        ]
        zoom_image = np.repeat(np.repeat(zoom_crop, zoom["scale"], axis=0), zoom["scale"], axis=1)
        zoom_path = out_dir / spec["spike"]["outputs"]["zoom"]
        save_rgba(zoom_path, zoom_image)
        log(f"zoom: {zoom_path.name} ({zoom_image.shape[1]}x{zoom_image.shape[0]})")

        # ---- measurements ------------------------------------------------ #
        sprite = face["sprite"]
        face_centre_x = (record["faceQuad"][0][0] + record["faceQuad"][1][0]) / 2.0 - record["x"]
        sliver = measure_blue_sliver(sprite, round(face_centre_x))
        top_front = project(
            scene, camera, tile.matrix_world @ Vector((0.0, spec["tile"]["height"] / 2.0, top))
        )
        top_back = project(
            scene,
            camera,
            tile.matrix_world @ Vector((0.0, spec["tile"]["height"] / 2.0, 0.0)),
        )
        edge_px = abs(top_front[1] - top_back[1])
        face_height_px = record["measurements"]["faceHeightPx"]
        body_stats = channel_stats(sprite)
        decal_stats = channel_stats(decal)
        measurements = {
            "faceHeightPx": face_height_px,
            "topEdgeProjectedPx": round(edge_px, 2),
            "blueSliverExpectedPx": round(edge_px * spec["tile"]["backEdgeFraction"], 2),
            "blueSliverMeasuredPx": sliver["bluePx"],
            "bodyMaxChannel": body_stats["maxChannel"],
            "bodyClippedPixels": body_stats["clippedPixels"],
            "decalMaxChannel": decal_stats["maxChannel"],
            "decalClippedPixels": decal_stats["clippedPixels"],
            "decalBakeSeconds": round(decal_seconds, 1),
        }
        log(
            "blue sliver: "
            f"{sliver['bluePx']} device px measured, "
            f"{measurements['blueSliverExpectedPx']} px expected "
            f"of a {round(edge_px, 2)} px top edge, on a {face_height_px} px face"
        )
        log(
            f"rig: {spec.get('lightRig')} · "
            f"body peak {body_stats['maxChannel']}/255 ({body_stats['clippedPixels']} clipped) · "
            f"decal peak {decal_stats['maxChannel']}/255 ({decal_stats['clippedPixels']} clipped)"
        )

    # ---- manifest -------------------------------------------------------- #
    decal = decal_geometry(spec)
    body_bytes = sum(
        (out_dir / record["body"]).stat().st_size for record, _, _ in records
    ) + sum(
        (out_dir / record["back"]["body"]).stat().st_size
        for record, _, _ in records
        if record.get("back")
    )
    manifest = {
        "version": 2,
        "generatedBy": "tools/render/build_and_render.py",
        "spec": spec_path.name,
        "blender": blender_version,
        "units": "device px, origin top-left, y down; divide by pixelRatio for CSS",
        "pixelRatio": spec["scene"]["pixelRatio"],
        "tile": {
            "proportionsMm": spec["tile"]["proportionsMm"],
            "units": {
                "height": round(spec["tile"]["height"], 5),
                "width": round(spec["tile"]["width"], 5),
                "thickness": round(spec["tile"]["thickness"], 5),
            },
            "material": spec["tile"]["materials"]["face"]["material"],
            "backEdgeFraction": spec["tile"]["backEdgeFraction"],
            "faceInset": spec["tile"]["faceInset"],
        },
        "scene": {
            "width": spec["scene"]["widthCss"],
            "height": spec["scene"]["heightCss"],
            "widthDevicePx": render_width,
            "heightDevicePx": render_height,
            "camera": "fixed",
        },
        "camera": camera_record(spec),
        "table": {
            "plan": table_plan(spec),
            "seats": ["bottom", "right", "top", "left"],
            "handRow": {
                "seat": spec["hand"]["seat"],
                "y": spec["hand"]["y"],
                "slotIds": [slot["id"] for slot in hand_slots(spec)],
            },
        },
        "facePixels": [
            round(spec["decals"]["cssFace"][0] * 2),
            round(spec["decals"]["cssFace"][1] * 2),
        ],
        "background": (
            spec["outputs"]["background"].format(ext=assets["background"]["fileFormat"].lower())
            if background
            else None
        ),
        "backgroundPixels": background["pixels"] if background else None,
        "rig": rig_record(spec),
        "decals": {
            "pixels": decal["pixels"],
            "frameUnits": decal["frameUnits"],
            "paddingPixels": decal["paddingPixels"],
            "renderedAtScale": spec["decals"]["renderScale"],
            "compositeSupersample": composite_supersample(
                first_matrix if first_matrix is not None else np.eye(3),
                spec["decals"].get("compositeSupersample"),
            ),
            "carve": {
                "depthUnits": round(
                    spec["decals"]["carve"]["depthFractionOfThickness"]
                    * spec["tile"]["thickness"],
                    5,
                ),
                "depthFractionOfThickness": spec["decals"]["carve"]["depthFractionOfThickness"],
                "blurUnits": spec["decals"]["carve"]["blurUnits"],
                "transitionUnits": spec["decals"]["carve"]["transitionUnits"],
                "profile": spec["decals"]["carve"]["profile"],
                "paintEdge": spec["decals"]["carve"]["paintEdge"],
                "occlusionDistance": spec["decals"]["carve"]["occlusionDistance"],
                "occlusionStrength": spec["decals"]["carve"]["occlusionStrength"],
                "grid": [
                    max(2, round(decal["pixels"][0] * spec["decals"]["carve"]["gridScale"])),
                    max(2, round(decal["pixels"][1] * spec["decals"]["carve"]["gridScale"])),
                ],
            },
            "note": (
                "faceMatrix maps the decal image's full pixel rect (top-left "
                "origin, y down) onto decalQuad."
            ),
        },
        "slots": [record for record, _, _ in records],
        "faces": face_entries,
        "assets": {
            "bodyFormat": body_format,
            "bodyQuality": assets["body"]["quality"] if mode == "table" else 100,
            "bodyBytes": body_bytes,
            "backgroundFormat": assets["background"]["fileFormat"] if background else None,
            "backgroundQuality": assets["background"]["quality"] if background else None,
            "backgroundSamples": background["renderSamples"] if background else None,
            "backgroundBytes": background["bytes"] if background else None,
            "totalBytes": body_bytes + (background["bytes"] if background else 0),
            "budgetBytes": assets["budgetBytes"],
        },
        "checks": {},
        "measurements": measurements,
    }
    manifest["checks"] = check_slots(manifest)
    if mask_check:
        manifest["checks"]["alignment"] = mask_check

    budget = assets["budgetBytes"]
    if manifest["assets"]["totalBytes"] > budget["total"]:
        die(
            f"assets are {manifest['assets']['totalBytes']} bytes, "
            f"over the {budget['total']} byte budget"
        )
    if manifest["assets"]["bodyBytes"] > budget["bodies"]:
        die(
            f"body sprites are {manifest['assets']['bodyBytes']} bytes, "
            f"over the {budget['bodies']} byte budget"
        )
    if background and background["bytes"] > budget["background"]:
        die(
            f"background is {background['bytes']} bytes, "
            f"over the {budget['background']} byte budget"
        )

    manifest_path = out_dir / spec["outputs"]["manifest"]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    log(f"manifest: {manifest_path.name}")
    log(
        f"assets: bodies {body_bytes} B, background "
        f"{background['bytes'] if background else 0} B, "
        f"total {manifest['assets']['totalBytes']} B "
        f"(budget {budget['total']} B)"
    )


if __name__ == "__main__":
    main()
