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
    bodies/hand-<n>.webp     an n-tile concealed row as one body sprite
    bodies/hand-<n>-back.webp      the same row in the concealed (blue) pose
    bodies/hand-<n>-draw.webp      the row plus the separated drawn tile
    bodies/hand-<n>-draw-back.webp its concealed pose
    manifest.json            scene, background, every layout, checks, budget

Bodies are *groups*: every tile of a layout is baked as one sprite and the
per-slot face decals composite on top of it, so the row's cast shadow, the
inter-tile occlusion, and the shadow each tile throws on its neighbour are all
in one render and the sprite can never clip an individual tile's shadow. Because
the draw is in the same bake as the row, no two sprites ever represent the same
shadow: the drawn tile's tail and the row's tail meet in the gap exactly as the
renderer makes them. Sprites are cropped to their measured shadow contour plus a
transparent taper (alpha > the configured threshold + the taper width), never to
a fixed gutter.

Coordinate conventions: world units are tile units (see the spec); scene pixels
in the manifest are rendered device pixels (CSS size x pixelRatio), origin
top-left, y down. A body's rect is exactly where the runtime draws the file.
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
    # Every surface a tile's cast shadow can land on is a shadow catcher during
    # the body passes. The room floor is not: it is outside the rail, out of
    # frame, and nothing baked ever lands on it.
    catchers = [part for part in parts if part is not room]
    return {
        "felt": felt,
        "parts": parts,
        "catchers": catchers,
        "rail": rail,
        "room": room,
    }


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


def active_lights(spec: dict, preset: str | None = None) -> list[dict]:
    """The lights actually built for one rig: the preset's enabled entries.

    The spec carries both rigs so either can be selected without editing
    numbers: `studio` is the traditional key + fill + rim, `parlor` is the strip
    rig. `preset` selects one; without it, `lightRig` is the scene's own rig.
    `enabled: false` parks an entry without deleting its numbers. A spec with a
    plain `lights` list (Task 1 format) still works.
    """
    presets = spec.get("lightPresets")
    if not presets:
        return [entry for entry in spec["lights"] if entry.get("enabled", True)]
    name = preset or spec.get("lightRig")
    if name not in presets:
        die(f"light rig {name!r} is not one of {sorted(presets)}")
    return [entry for entry in presets[name]["lights"] if entry.get("enabled", True)]


def clear_lights(scene: bpy.types.Scene) -> None:
    for obj in list(scene.objects):
        if obj.type == "LIGHT":
            bpy.data.objects.remove(obj, do_unlink=True)


def build_lights(scene: bpy.types.Scene, spec: dict, preset: str | None = None) -> None:
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
    lights = active_lights(spec, preset)
    if not lights:
        die("the active light rig is empty")
    log(
        f"rig {preset or spec.get('lightRig', 'lights')}: "
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


def rig_record(spec: dict, preset: str | None = None) -> dict:
    """One rig as it was built, for the manifest.

    Recorded from the same resolved list `build_lights` consumes, so the
    manifest can never describe a rig the sprites were not baked with. Tasks 3+
    read this instead of assuming light positions. `preset` names the rig; the
    scene's own rig is the default.
    """
    return {
        "preset": preset or spec.get("lightRig"),
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
            for entry in active_lights(spec, preset)
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
# Hand layout inventory
# --------------------------------------------------------------------------- #


def resolve_row_spacing(spec: dict) -> float:
    """The concealed row's pitch in tile units.

    `hand.spacing` is either ``"touch"`` (the tile width, so the row closes up
    into the Tenhou-style solid block and the bevel grooves are all that
    separates the tiles) or an explicit pitch. Resolved once here so the row
    model and the manifest can never disagree.
    """
    spacing = spec["hand"]["spacing"]
    if spacing == "touch":
        return float(spec["tile"]["width"])
    return float(spacing)


def hand_row_slots(spec: dict, count: int, include_draw: bool = False) -> list[dict]:
    """The concealed slots of a row of `count` tiles, plus its draw slot.

    The concealed row is centred on `hand.centerX` and pitched at the resolved
    row spacing, so **the row occupies the same place for every layout and for
    either draw state**: drawing a tile never shifts the row, and the layouts
    with and without the draw share the group body and every slot quad. The draw
    sits `hand.drawGap` past the row's right end, so its shadow never reaches
    the row.

    Ids are stable: `hand-0` … `hand-{count-1}` for the concealed tiles and
    `hand-draw` for the drawn one.
    """
    hand = spec["hand"]
    spacing = resolve_row_spacing(spec)
    y = hand["y"]
    first_x = hand["centerX"] - (count - 1) * spacing / 2.0
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
                "y": y,
                "orientation": "upright",
                "drawOrder": order_base + index,
            }
        )
    if include_draw:
        slots.append(
            {
                "id": "hand-draw",
                "seat": hand["seat"],
                "role": "draw",
                "index": count,
                "pose": hand["pose"],
                "backPose": hand["backPose"],
                "x": first_x + count * spacing + hand["drawGap"],
                "y": y,
                "orientation": "upright",
                "drawOrder": order_base + count,
            }
        )
    return slots


def hand_layouts(spec: dict) -> list[dict]:
    """Every shipped hand layout: each concealed count, with and without the draw.

    A kan removes three concealed tiles like a meld, so the human's row is
    13 / 10 / 7 / 4 / 1 tiles. Each length is shipped both ways, because the
    runtime picks a layout from (concealed count, draw present) and never
    re-deals or re-centres when a tile is drawn or discarded.
    """
    hand = spec["hand"]
    layouts = []
    for count in hand["concealedCounts"]:
        for has_draw in (False, True):
            layouts.append(
                {
                    "id": f"hand-{count}" + ("-draw" if has_draw else ""),
                    "seat": hand["seat"],
                    "count": count,
                    "hasDraw": has_draw,
                    "orientation": "upright",
                    "slots": hand_row_slots(spec, count, has_draw),
                }
            )
    return layouts


def layout_groups(layout: dict) -> tuple[list[dict], dict | None]:
    """Split a layout into its concealed group slots and its draw slot."""
    concealed = [slot for slot in layout["slots"] if slot["role"] == "concealed"]
    draw = next((slot for slot in layout["slots"] if slot["role"] == "draw"), None)
    return concealed, draw


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


def measure_blue_backing(sprite: np.ndarray) -> dict:
    """Whether the blue backing is one connected band around the tile.

    The blue is the rear `backEdgeFraction` of the thickness, so on a standing
    tile it shows as a band along the top edge and a band down the visible side,
    and the two must meet at the corner. A per-face material split left each
    rounded corner with a single material, which cut the band into two; a shader
    split on the thickness axis keeps it one surface. This measures that: the
    blue pixels of the opaque sprite, 4-connected, ignoring specks.
    """
    rgb = sprite[..., :3]
    opaque = sprite[..., 3] > 0.5
    blue = opaque & (rgb[..., 2] > rgb[..., 0] + 0.02) & (rgb[..., 2] > rgb[..., 1] + 0.01)
    height, width = blue.shape
    seen = np.zeros_like(blue)
    components = []
    for y in range(height):
        row = blue[y]
        for x in np.nonzero(row & ~seen[y])[0]:
            if seen[y, x]:
                continue
            stack = [(int(y), int(x))]
            seen[y, x] = True
            size = 0
            px: list[int] = []
            py: list[int] = []
            while stack:
                cy, cx = stack.pop()
                size += 1
                px.append(cx)
                py.append(cy)
                for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                    if 0 <= ny < height and 0 <= nx < width and blue[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if size >= 40:
                components.append((size, (min(px), min(py), max(px), max(py))))
    components.sort(reverse=True)
    return {
        "bluePixels": int(blue.sum()),
        "blueComponents": len(components),
        "components": [
            {"pixels": size, "bbox": list(box)} for size, box in components[:4]
        ],
        "note": (
            "4-connected blue regions of the opaque sprite, specks under 40 px "
            "ignored; the backing must be one band wrapping the top edge into "
            "the side"
        ),
    }


def measure_side_band(sprite: np.ndarray) -> dict:
    """Width of the blue band down the visible side edge, in device px.

    The backing is the rear `backEdgeFraction` of the thickness, so the side
    band's width is a physical quantity (~0.18 units, ~18 px) and it must reach
    the silhouette edge rather than stopping at a bevel.
    """
    rgb = sprite[..., :3]
    opaque = sprite[..., 3] > 0.5
    blue = opaque & (rgb[..., 2] > rgb[..., 0] + 0.02) & (rgb[..., 2] > rgb[..., 1] + 0.01)
    rows = np.nonzero(opaque.any(axis=1))[0]
    if not len(rows):
        return {"sideBandPx": 0}
    row = int((rows[0] + rows[-1]) / 2)
    columns = np.nonzero(opaque[row])[0]
    if not len(columns):
        return {"sideBandPx": 0}
    run = 0
    for x in range(columns[-1], columns[0] - 1, -1):
        if blue[row, x]:
            run += 1
        elif run:
            break
    return {"sideBandPx": run, "row": row, "rightEdge": int(columns[-1])}


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


def set_shadow_catchers(spec: dict, table: dict, enabled: bool) -> None:
    """Switch the whole table between 'static surface' and 'shadow catcher'.

    During a body pass every table surface a tile's shadow can land on catches
    that shadow: felt, apron, wall-ring track, compass plate, and rail. The rail
    matters because a hand or river tile at a far seat throws its shadow onto
    it, and a shadow is only correct in screen space if the surface it lands on
    is the one being composited over.

    The catchers do **not** cast (``visible_shadow = False``): the rail's own
    shadow on the felt is already baked into the background, so letting the
    static table cast during the catcher pass would darken it twice. Only the
    tiles cast, because only their shadow is new.

    When disabled, the parts go back to the static configuration: hidden for the
    body passes (the background carries their shading) and only the felt a
    shadow catcher, which is the state the old per-slot passes expect.
    """
    for part in table["catchers"]:
        part.hide_render = not enabled
        part.is_shadow_catcher = enabled
        part.visible_shadow = not enabled
    if not enabled:
        table["felt"].is_shadow_catcher = spec["table"]["shadowCatcher"]


def projected_bounds(
    scene: bpy.types.Scene,
    camera: bpy.types.Object,
    spec: dict,
    slots: list[dict],
    pose: str,
) -> tuple[float, float, float, float]:
    """Device-pixel bounds of the posed tiles, without any shadow."""
    points = []
    for slot in slots:
        matrix = pose_matrix(pose, slot, spec)
        points.extend(project(scene, camera, matrix @ corner) for corner in tile_corners(spec))
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return (min(xs), min(ys), max(xs), max(ys))


def shadow_contour(alpha: np.ndarray, threshold: float) -> tuple:
    """Measured extent of the shadow in an alpha image, as a half-open bbox.

    The contour is the region where the composited alpha exceeds `threshold`.
    Nothing is smoothed or despeckled: the render region carries a guard band
    around the search area, so a border render's stray corner value sits
    outside the measured area and cannot drag the crop out to the sample edge,
    while a real 3 % shadow pixel inside the pad still counts.
    """
    mask = alpha > threshold
    if not mask.any():
        die(f"shadow contour is empty at threshold {threshold}")
    rows = np.nonzero(mask.any(axis=1))[0]
    cols = np.nonzero(mask.any(axis=0))[0]
    return (int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1)


def edge_ring_max(alpha: np.ndarray, rect: tuple, region: tuple) -> tuple:
    """Largest alpha on a rect's own boundary, and where it is.

    The crop is the measured contour plus a transparent margin, so the largest
    alpha on its edge is the proof that the sprite does not end on a visible
    shadow boundary. Its position is reported so a failure can name the edge.
    """
    x0, y0, x1, y1 = rect
    rx0, ry0, _, _ = region
    rows = slice(y0 - ry0, y1 - ry0)
    cols = slice(x0 - rx0, x1 - rx0)
    edges = {
        "left": alpha[rows, x0 - rx0],
        "right": alpha[rows, x1 - 1 - rx0],
        "top": alpha[y0 - ry0, cols],
        "bottom": alpha[y1 - 1 - ry0, cols],
    }
    best_side = "left"
    best_index = 0
    best_value = -1.0
    for side, values in edges.items():
        index = int(np.argmax(values))
        value = float(values[index])
        if value > best_value:
            best_side, best_index, best_value = side, index, value
    if best_side in ("left", "right"):
        position = [int(x0 if best_side == "left" else x1 - 1), int(y0 + best_index)]
    else:
        position = [int(x0 + best_index), int(y0 if best_side == "top" else y1 - 1)]
    return best_value, best_side, position


def bake_group(
    spec: dict,
    scene: bpy.types.Scene,
    camera: bpy.types.Object,
    tile: bpy.types.Object,
    table: dict,
    slots: list[dict],
    pose: str,
    out_dir: Path,
    path: Path,
    label: str,
) -> dict:
    """Bake one group body: posed tiles over their shared shadow.

    The group is every tile of a layout baked *together* — the concealed row and,
    when the layout has one, the drawn tile — so the pass carries inter-tile
    occlusion, the shadow each tile throws on its neighbour, and one continuous
    cast shadow for the whole block, none of which a per-tile body can carry. A
    separate draw body would have to overlay its shadow tail on the row's in the
    gap; one bake per layout means no two sprites ever represent the same shadow.
    Faces are flat decals composited at runtime and cast or receive nothing, so
    leaving them out changes neither pass.

    Pass 1 renders the tiles alone with transparent film (straight alpha). Pass 2
    renders the whole table as different Cycles shadow catchers with the tiles
    invisible to the camera but still occluding the lights, so a shadow that
    lands on the apron, the track, or the rail is correct where the camera sees
    it.

    The sprite is cropped from the **measured shadow contour**: the region where
    the composited alpha passes `hand.shadow.alphaThreshold`, plus
    `hand.shadow.cropMarginDevicePx`. The outer `hand.shadow.taperDevicePx` of
    that margin is faded to zero on shadow-only pixels, because the shadow's
    alpha only asymptotes to zero and a bare contour crop would end on a visible
    ~2 % step where the shadow is longest. A region with a generous search pad is
    rendered and, if the contour reaches any edge of that search area that is not
    the scene's own edge, the bake fails: a crop that ends inside the scene must
    end on transparent felt, never on a shadow boundary.

    Returns the sprite, its device-pixel crop rect, the rendered search region,
    the tile-only alpha (for the alignment check), and the measured shadow
    numbers the manifest records.
    """
    shadow_spec = spec["hand"]["shadow"]
    pad = int(shadow_spec["searchPadDevicePx"])
    guard = int(shadow_spec["guardDevicePx"])
    threshold = float(shadow_spec["alphaThreshold"])
    crop_margin = int(shadow_spec["cropMarginDevicePx"])
    taper = int(shadow_spec.get("taperDevicePx", 0))
    alpha_scale = float(shadow_spec.get("alphaScale", 1.0))
    render_width = scene.render.resolution_x
    render_height = scene.render.resolution_y

    tile.hide_render = True
    holders = []
    for slot in slots:
        # Object copy, not a second object on the same mesh: the bevel and
        # weighted-normal modifiers live on the object, and every tile in the
        # group must be the same bevelled body the single-tile bake used.
        holder = tile.copy()
        holder.name = f"group-{label}-{slot['id']}"
        holder.hide_render = False
        holder.visible_camera = True
        holder.visible_shadow = True
        bpy.context.scene.collection.objects.link(holder)
        holder.matrix_world = pose_matrix(pose, slot, spec)
        holders.append(holder)
    sync_view_layer()

    bx0, by0, bx1, by1 = projected_bounds(scene, camera, spec, slots, pose)
    # The search area is where the shadow contour is measured; the render region
    # adds room for the crop margin (the contour plus the transparent taper) and
    # the guard band, so a border render's stray edge value can never sit inside
    # the measured or cropped area.
    reach = pad + crop_margin + guard
    search = (
        max(0, math.floor(bx0 - pad)),
        max(0, math.floor(by0 - pad)),
        min(render_width, math.ceil(bx1 + pad)),
        min(render_height, math.ceil(by1 + pad)),
    )
    region = (
        max(0, math.floor(bx0 - reach)),
        max(0, math.floor(by0 - reach)),
        min(render_width, math.ceil(bx1 + reach)),
        min(render_height, math.ceil(by1 + reach)),
    )
    scene_edges = {
        "left": search[0] == 0,
        "top": search[1] == 0,
        "right": search[2] == render_width,
        "bottom": search[3] == render_height,
    }

    # Pass 1: the tiles alone with transparent film; every table part hidden.
    hide_parts(table["parts"], True)
    body = render_region(scene, out_dir / "_body-pass.png", region)
    if body.shape[:2] != (region[3] - region[1], region[2] - region[0]):
        die(
            f"{label} body render is {body.shape[1]}x{body.shape[0]}, expected "
            f"{region[2] - region[0]}x{region[3] - region[1]}"
        )

    # Pass 2: the table catches the tiles' shadow; the tiles themselves are
    # invisible to the camera but still occlude the lights.
    set_shadow_catchers(spec, table, True)
    for holder in holders:
        holder.visible_camera = False
    shadow = render_region(scene, out_dir / "_shadow-pass.png", region)
    for holder in holders:
        holder.visible_camera = True
    set_shadow_catchers(spec, table, False)
    clear_border(scene)
    (out_dir / "_body-pass.png").unlink()
    (out_dir / "_shadow-pass.png").unlink()

    if alpha_scale != 1.0:
        # The render is physically correct; a lighter weight is a look
        # decision, so it is an explicit spec knob rather than a light tweak.
        shadow = shadow.copy()
        shadow[..., 3] = np.clip(shadow[..., 3] * alpha_scale, 0.0, 1.0)
    soften = int(shadow_spec.get("softenDevicePx", 0))
    if soften > 0:
        # A strip light 56 units away throws a narrow penumbra, so the cast
        # shadow's outer boundary is a ~10 px ramp at up to 20 % depth and reads
        # as a cut where it is longest. Soften the shadow *outside* the tiles
        # only: the contact shadow at the tile's foot keeps its crisp edge, so
        # the row stays grounded, while the outer boundary fades over ~2 sigma.
        shadow_alpha = shadow[..., 3]
        blurred = blur2d(shadow_alpha, float(soften))
        contact = blur2d(
            dilate(body[..., 3] > 0.01, radius=max(2, 3 * soften)).astype(np.float32),
            float(soften),
        )
        contact = np.clip(contact, 0.0, 1.0)
        shadow[..., 3] = shadow_alpha * contact + blurred * (1.0 - contact)
    sprite_full = over(shadow, body)  # tiles over their shared shadow
    alpha = sprite_full[..., 3]

    # Measured contour, measured inside the search area.
    sx0, sy0, sx1, sy1 = search
    local = alpha[sy0 - region[1] : sy1 - region[1], sx0 - region[0] : sx1 - region[0]]
    cx0, cy0, cx1, cy1 = shadow_contour(local, threshold)
    contour = (cx0 + sx0, cy0 + sy0, cx1 + sx0, cy1 + sy0)
    touches = {
        "left": contour[0] == sx0,
        "top": contour[1] == sy0,
        "right": contour[2] == sx1,
        "bottom": contour[3] == sy1,
    }
    for side, touches_edge in touches.items():
        if touches_edge and not scene_edges[side]:
            die(
                f"{label}: shadow contour reaches the {side} edge of the "
                f"{pad} px search pad; raise hand.shadow.searchPadDevicePx"
            )
    scene_edge_clips = sorted(side for side, hit in touches.items() if hit)

    # The crop must contain the measured shadow *and* the whole tile
    # silhouette: a tile's anti-aliased top edge can carry less than the shadow
    # threshold, so a contour-only crop would shave a pixel off the body itself.
    crop = (
        max(0, min(contour[0], math.floor(bx0)) - crop_margin),
        max(0, min(contour[1], math.floor(by0)) - crop_margin),
        min(render_width, max(contour[2], math.ceil(bx1)) + crop_margin),
        min(render_height, max(contour[3], math.ceil(by1)) + crop_margin),
    )
    sprite = sprite_full[
        crop[1] - region[1] : crop[3] - region[1], crop[0] - region[0] : crop[2] - region[0]
    ].copy()

    # Taper the shadow to exactly zero at the sprite boundary. The shadow's alpha
    # only asymptotes to zero, so a crop taken a few pixels past the contour still
    # ends on a ~2 % alpha edge, which shows as a straight cut where the shadow is
    # longest. The taper is applied to shadow-only pixels; the tiles themselves
    # stay fully opaque, so no tile edge is ever faded.
    if taper > 0:
        height, width = sprite.shape[:2]
        ramp_x = np.minimum(np.arange(width), width - 1 - np.arange(width))
        ramp_y = np.minimum(np.arange(height), height - 1 - np.arange(height))
        ramp = np.minimum(ramp_x[None, :], ramp_y[:, None])
        fade = np.clip(ramp / float(taper + 1), 0.0, 1.0)
        body_crop = body[
            crop[1] - region[1] : crop[3] - region[1],
            crop[0] - region[0] : crop[2] - region[0],
            3,
        ]
        solid = body_crop > 0.002
        sprite[..., 3] = sprite[..., 3] * np.where(solid, 1.0, fade)
    sprite_edge = edge_ring_max(sprite[..., 3], (0, 0, sprite.shape[1], sprite.shape[0]), (0, 0, 0, 0))

    assets = spec["assets"]
    size = save_raster(
        scene,
        path,
        sprite,
        assets["body"]["fileFormat"],
        assets["body"]["quality"],
    )
    crop_edge, crop_edge_side, crop_edge_px = edge_ring_max(alpha, crop, region)
    log(
        f"group body: {path.name} ({crop[2] - crop[0]}x{crop[3] - crop[1]}, "
        f"{len(slots)} tile(s), contour {contour}, taper {taper} px, "
        f"soften {soften} px, edge alpha {sprite_edge[0]:.4f}, {size} B"
        + (f", scene-edge clip {scene_edge_clips}" if scene_edge_clips else "")
        + ")"
    )

    for holder in holders:
        bpy.data.objects.remove(holder, do_unlink=True)

    return {
        "sprite": sprite,
        "rect": crop,
        "region": region,
        "alpha": body[..., 3].copy(),
        "bytes": size,
        "path": path,
        "shadow": {
            "alphaThreshold": threshold,
            "cropMarginPx": crop_margin,
            "taperPx": taper,
            "softenPx": soften,
            "contour": list(contour),
            "reach": {
                "left": round(bx0 - contour[0], 1) + 0.0,
                "top": round(by0 - contour[1], 1) + 0.0,
                "right": round(contour[2] - bx1, 1) + 0.0,
                "bottom": round(contour[3] - by1, 1) + 0.0,
            },
            "maxAlphaAtCropEdge": round(crop_edge, 4),
            "maxAlphaAtCropEdgeSide": crop_edge_side,
            "maxAlphaAtCropEdgePx": crop_edge_px,
            "visibleAlphaAtSpriteEdge": round(sprite_edge[0], 4),
            "sceneEdgeClips": scene_edge_clips,
        },
        "tileBounds": [round(value, 2) for value in (bx0, by0, bx1, by1)],
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
    samples: int | None = None,
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
    samples = samples if samples is not None else asset_samples(spec)
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
    baked: list[dict],
    pose_key: str,
    path: Path,
) -> Path:
    """Composite one layout over the background exactly as the runtime will.

    This is a review artifact, not a shipped asset: it is the proof that every
    body lands where the manifest says, and the picture a human should check
    after a regeneration. `baked` is the layout's body records in paint order
    (the group first, then the draw). It is assembled in device pixels (the
    manifest's own space, so nothing is scaled) and then box-filtered down to the
    shipped background size for viewing.
    """
    canvas = background.copy()
    for record in baked:
        sprite = record["sprite"] if pose_key == "face" else record["back_sprite"]
        if sprite is None:
            continue
        rect = record["rect"] if pose_key == "face" else record["back_rect"]
        canvas = paste(canvas, sprite, rect[0], rect[1])
    canvas[..., 3] = 1.0
    review = downsample_box(canvas, spec["assets"]["background"].get("downscale", 1))
    save_raster(scene, path, review, "PNG", 100, colour_mode="RGB")
    return path


def render_layout_mask(
    spec: dict,
    scene: bpy.types.Scene,
    tile: bpy.types.Object,
    table: dict,
    layout: dict,
    region: tuple,
    out_dir: Path,
) -> np.ndarray:
    """Render the alpha coverage of every tile of one layout in a single frame.

    The group bodies are baked from several tiles at once, so this is the
    independent reference the baked group and draw sprites are checked against:
    same camera, same resolution, every slot of *that layout* present at once
    (a layout without the draw must not see one), denoising off (alpha is
    geometric coverage, so extra samples buy nothing).
    """
    hide_parts(table["parts"], True)
    scene.render.film_transparent = True
    tile.hide_render = True
    references = []
    for slot in layout["slots"]:
        # Object copy, not a new object on the same mesh: the bevel and weighted
        # normal modifiers live on the object, and the reference must be the
        # same bevelled silhouette the sprites were baked from.
        holder = tile.copy()
        holder.name = f"ref-{layout['id']}-{slot['id']}"
        holder.hide_render = False
        holder.visible_camera = True
        bpy.context.scene.collection.objects.link(holder)
        holder.matrix_world = pose_matrix(slot["pose"], slot, spec)
        references.append(holder)
    sync_view_layer()

    previous = set_samples(scene, spec["checks"].get("referenceSamples", 8), False)
    reference = render_region(scene, out_dir / "_mask-reference.png", region)
    scene.cycles.samples, scene.cycles.use_denoising = previous
    clear_border(scene)
    (out_dir / "_mask-reference.png").unlink()

    for holder in references:
        bpy.data.objects.remove(holder, do_unlink=True)
    scene.render.film_transparent = spec["scene"]["filmTransparent"]
    return reference[..., 3].copy()


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
    reference: np.ndarray, baked: np.ndarray, parts: list, tolerance: float = 0.5
) -> dict:
    """Check one layout against a single render with every tile present.

    `baked` is the pass-1 alpha of the layout's body sprites pasted at their
    manifest rects, i.e. exactly what the runtime will draw. The reference is one
    frame rendered with all of that layout's tiles in the scene at once. If a
    crop or a rect is a pixel off, the two silhouettes disagree by a whole pixel;
    a one-pixel dilation on each side absorbs anti-aliasing and denoiser
    softness, so only a real shift fails the check. Adjacent hand tiles abut in
    projection, which is why the comparison is whole-layout: the baked canvas
    carries the neighbour too, exactly as the scene does.

    Disagreeing pixels are attributed to the body whose rect contains them, so a
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
    for part in parts:
        x0, y0, x1, y1 = part["rect"]
        band = (
            slice(max(0, y0), min(shifted.shape[0], y1)),
            slice(max(0, x0), min(shifted.shape[1], x1)),
        )
        count = int(shifted[band].sum())
        total_shifted += count
        rows.append({"body": part["label"], "shiftedPixels": count})

    return {
        "method": (
            "each body sprite's tile alpha pasted at its manifest rect against "
            "one frame rendered with all of that layout's tiles present; a "
            "one-pixel dilation absorbs anti-aliasing, so any shifted pixel is a "
            "real misalignment"
        ),
        "bodies": rows,
        "tilePixels": union,
        "shiftedPixels": total_shifted,
        "softPixels": soft,
        "softPixelFraction": round(soft / max(union, 1), 6),
        "softTolerance": tolerance,
    }


def layout_alignment(
    spec: dict,
    scene: bpy.types.Scene,
    camera: bpy.types.Object,
    tile: bpy.types.Object,
    table: dict,
    layout: dict,
    baked: list[dict],
    out_dir: Path,
) -> dict:
    """Bake-vs-reference alignment for one layout, over the union of its bodies."""
    x0 = min(record["region"][0] for record in baked)
    y0 = min(record["region"][1] for record in baked)
    x1 = max(record["region"][2] for record in baked)
    y1 = max(record["region"][3] for record in baked)
    region = (x0, y0, x1, y1)

    baked_alpha = np.zeros((y1 - y0, x1 - x0), dtype=np.float32)
    parts = []
    for record in baked:
        rx0, ry0, rx1, ry1 = record["region"]
        alpha = record["alpha"]
        if alpha.shape[:2] != (ry1 - ry0, rx1 - rx0):
            die(
                f"{layout['id']}: {record['label']} alpha is "
                f"{alpha.shape[1]}x{alpha.shape[0]}, expected {rx1 - rx0}x{ry1 - ry0}"
            )
        band = baked_alpha[ry0 - y0 : ry1 - y0, rx0 - x0 : rx1 - x0]
        baked_alpha[ry0 - y0 : ry1 - y0, rx0 - x0 : rx1 - x0] = np.maximum(band, alpha)
        parts.append({"label": record["label"], "rect": record["region"]})

    reference = render_layout_mask(spec, scene, tile, table, layout, region, out_dir)
    if reference.shape[:2] != baked_alpha.shape[:2]:
        die(
            f"{layout['id']}: reference is {reference.shape[1]}x{reference.shape[0]}, "
            f"expected {baked_alpha.shape[1]}x{baked_alpha.shape[0]}"
        )
    result = compare_alignment(reference, baked_alpha, parts)
    result["layout"] = layout["id"]
    result["region"] = list(region)
    return result


# --------------------------------------------------------------------------- #
# Slot geometry and seam measurement
# --------------------------------------------------------------------------- #


def slot_geometry(
    spec: dict, scene: bpy.types.Scene, camera: bpy.types.Object, slot: dict
) -> dict:
    """Face quad, decal quad, homography, tile rect and measurements for a slot.

    Geometry only: no render, no sprite. The quads and the `faceMatrix` are a
    function of the spec and the camera, so every layout can publish them without
    baking anything, and a decal is positioned exactly as it was per-slot.
    """
    decal = decal_geometry(spec)
    frame_w, frame_h = decal["frameUnits"]
    matrix_world = pose_matrix(slot["pose"], slot, spec)
    face_quad = [
        project(scene, camera, matrix_world @ corner) for corner in face_corners(spec)
    ]
    decal_quad = [
        project(scene, camera, matrix_world @ corner)
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

    bounds = projected_bounds(scene, camera, spec, [slot], slot["pose"])
    return {
        "x": math.floor(bounds[0]),
        "y": math.floor(bounds[1]),
        "width": math.ceil(bounds[2]) - math.floor(bounds[0]),
        "height": math.ceil(bounds[3]) - math.floor(bounds[1]),
        "faceQuad": [[round(px, 3), round(py, 3)] for px, py in face_quad],
        "decalQuad": [[round(px, 3), round(py, 3)] for px, py in decal_quad],
        "faceMatrix": css_matrix3d(matrix),
        "measurements": {
            "faceHeightPx": round(abs(face_quad[3][1] - face_quad[0][1]), 2),
            "faceWidthPx": round(
                (abs(face_quad[1][0] - face_quad[0][0])
                 + abs(face_quad[2][0] - face_quad[3][0])) / 2.0,
                2,
            ),
        },
    }


def slot_record(
    spec: dict, scene: bpy.types.Scene, camera: bpy.types.Object, slot: dict
) -> dict:
    """A manifest slot: identity, its tile rect, and its decal geometry."""
    geometry = slot_geometry(spec, scene, camera, slot)
    return {
        "id": slot["id"],
        "index": slot["index"],
        "role": slot["role"],
        "orientation": slot["orientation"],
        "drawOrder": slot["drawOrder"],
        "x": geometry["x"],
        "y": geometry["y"],
        "width": geometry["width"],
        "height": geometry["height"],
        "faceQuad": geometry["faceQuad"],
        "decalQuad": geometry["decalQuad"],
        "faceMatrix": geometry["faceMatrix"],
        "measurements": geometry["measurements"],
    }


def seam_contrast(
    sprite: np.ndarray,
    rect: tuple,
    spec: dict,
    scene: bpy.types.Scene,
    camera: bpy.types.Object,
    slots: list[dict],
) -> dict:
    """Measure how strongly the bevel grooves separate the row's faces.

    The concealed row abuts, so the only delineation between two tiles is the
    bevel groove they form (there is no gap and so no inter-tile shadow). That
    makes "the grooves still delineate the tiles" something to measure: take a
    horizontal scan through the faces, and at every interior seam compare the
    darkest pixel of the groove with the face luminance 20 px to its left.

    Returns the per-seam dip as a fraction of the face luminance, so a flat
    block (dip ~0) fails on a number rather than an opinion, and a readable
    groove reports one.
    """
    if len(slots) < 2:
        return {"seams": 0}
    centres = []
    for slot in slots:
        matrix = pose_matrix(slot["pose"], slot, spec)
        face_centre = matrix @ Vector((0.0, 0.0, spec["tile"]["thickness"]))
        centres.append(project(scene, camera, face_centre))
    row = int(round((centres[0][1] + centres[-1][1]) / 2.0)) - rect[1]
    row = max(0, min(sprite.shape[0] - 1, row))
    luminance = sprite[row, :, :3].mean(axis=1)
    dips = []
    for left, right in zip(centres, centres[1:]):
        seam = int(round((left[0] + right[0]) / 2.0)) - rect[0]
        reference_x = seam - 20
        if seam < 6 or seam > sprite.shape[1] - 6 or reference_x < 0:
            continue
        face = float(np.median(luminance[reference_x - 6 : reference_x + 6]))
        groove = float(luminance[seam - 4 : seam + 5].min())
        if face <= 0.0:
            continue
        dips.append(1.0 - groove / face)
    if not dips:
        return {"seams": 0}
    return {
        "seams": len(dips),
        "dipMedian": round(float(np.median(dips)), 4),
        "dipMin": round(float(np.min(dips)), 4),
        "dipMax": round(float(np.max(dips)), 4),
        "note": "1 - groove luminance / face luminance on a face-centre scan",
    }


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
    """Render the carved, painted, lit face decal (spike batch).

    The symbol is lit by the **decal rig** (`decals.lightRig`, the parlor
    strips), not the scene's key + fill: the streaks inside the engraving are a
    look the decal needs, while the table's own shadow wants a broad soft key.
    The scene lights are rebuilt around the decal pass and restored afterwards.
    """
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

    decal_rig = spec["decals"].get("lightRig")
    if decal_rig:
        clear_lights(scene)
        build_lights(scene, spec, decal_rig)

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

    # Restore the scene camera, resolution, and the scene's own light rig.
    scene.camera = camera
    scene.render.resolution_x = round(spec["scene"]["widthCss"] * spec["scene"]["pixelRatio"])
    scene.render.resolution_y = round(spec["scene"]["heightCss"] * spec["scene"]["pixelRatio"])
    if decal_rig:
        clear_lights(scene)
        build_lights(scene, spec)
    return decal_path, decal_width, decal_height, frame_w, frame_h


# --------------------------------------------------------------------------- #
# Manifest checks
# --------------------------------------------------------------------------- #


# --------------------------------------------------------------------------- #
# Manifest checks
# --------------------------------------------------------------------------- #

ORIENTATIONS = {"upright", "flat-upright", "left", "right", "opposite"}


def rect_bounds(record: dict) -> tuple:
    """(x0, y0, x1, y1) of a body/slot rect record."""
    return (
        record["x"],
        record["y"],
        record["x"] + record["width"],
        record["y"] + record["height"],
    )


def inside_bounds(bounds: tuple, x: float, y: float, tolerance: float = 0.5) -> bool:
    return (
        bounds[0] - tolerance <= x <= bounds[2] + tolerance
        and bounds[1] - tolerance <= y <= bounds[3] + tolerance
    )


def check_layouts(manifest: dict) -> dict:
    """Fail the batch if a layout's rects or decal quads are out of bounds.

    - every body rect (each layout's body and its back pose) sits inside the
      scene's device-pixel space;
    - every slot's face and decal quad sits inside the body that renders it, and
      so does the slot's own tile rect (so a decal can never be drawn outside the
      sprite it composites onto, and the sprite always contains its tiles);
    - every slot carries a known orientation class, and draw orders are unique
      within a layout.

    Returns the numbers the manifest records, so the shipped file proves the
    checks ran.
    """
    scene = manifest["scene"]
    width = scene["widthDevicePx"]
    height = scene["heightDevicePx"]
    quads = 0
    slot_count = 0
    for layout in manifest["layouts"]:
        orders = set()
        bodies = [("body", layout["body"])]
        if layout["body"].get("back"):
            bodies.append(("body-back", layout["body"]["back"]))
        scene_rect = (0, 0, width, height)
        for label, record in bodies:
            if not inside_bounds(scene_rect, record["x"], record["y"]) or not (
                inside_bounds(scene_rect, record["x"] + record["width"], record["y"] + record["height"])
            ):
                die(
                    f"layout {layout['id']} {label} rect "
                    f"({record['x']}, {record['y']}, {record['width']}x{record['height']}) "
                    f"is outside the {width}x{height} scene"
                )
        body_bounds = rect_bounds(layout["body"])
        for slot in layout["slots"]:
            slot_count += 1
            if slot["orientation"] not in ORIENTATIONS:
                die(
                    f"layout {layout['id']} slot {slot['id']} has unknown orientation "
                    f"{slot['orientation']!r}"
                )
            if slot["drawOrder"] in orders:
                die(
                    f"layout {layout['id']} slot {slot['id']} reuses draw order "
                    f"{slot['drawOrder']}"
                )
            orders.add(slot["drawOrder"])
            for corner_x, corner_y in slot["faceQuad"] + slot["decalQuad"]:
                if not inside_bounds(body_bounds, corner_x, corner_y):
                    die(
                        f"layout {layout['id']} slot {slot['id']} face corner "
                        f"({corner_x}, {corner_y}) is outside its body rect {body_bounds}"
                    )
            for corner in (
                (slot["x"], slot["y"]),
                (slot["x"] + slot["width"], slot["y"] + slot["height"]),
            ):
                if not inside_bounds(body_bounds, corner[0], corner[1]):
                    die(
                        f"layout {layout['id']} slot {slot['id']} tile rect "
                        f"({slot['x']}, {slot['y']}, {slot['width']}x{slot['height']}) "
                        f"is outside its body rect {body_bounds}"
                    )
            quads += 1
    return {
        "layoutCount": len(manifest["layouts"]),
        "slotCount": slot_count,
        "layoutBodiesInsideScene": True,
        "slotQuadsInsideGroup": True,
        "slotRectsInsideGroup": True,
        "uniqueDrawOrders": True,
        "quadCount": quads,
    }


def check_slots(manifest: dict) -> dict:
    """Fail the review (spike) batch if a slot rect or a face quad is out of bounds."""
    scene = manifest["scene"]
    width = scene["widthDevicePx"]
    height = scene["heightDevicePx"]
    orders = set()
    for slot in manifest["slots"]:
        bodies = [("body", slot)]
        if slot.get("back"):
            bodies.append(("back", slot["back"]))
        if slot.get("orientation") not in ORIENTATIONS:
            die(f"slot {slot['id']} has unknown orientation {slot.get('orientation')!r}")
        if slot["drawOrder"] in orders:
            die(f"slot {slot['id']} reuses draw order {slot['drawOrder']}")
        orders.add(slot["drawOrder"])
        for label, record in bodies:
            x, y = record["x"], record["y"]
            w, h = record["width"], record["height"]
            if x < 0 or y < 0 or x + w > width or y + h > height:
                die(
                    f"slot {slot['id']} {label} rect ({x}, {y}, {w}x{h}) is outside "
                    f"the {width}x{height} scene"
                )
        bounds = rect_bounds(slot)
        for corner_x, corner_y in slot.get("faceQuad", []) + slot.get("decalQuad", []):
            if not inside_bounds(bounds, corner_x, corner_y):
                die(
                    f"slot {slot['id']} face corner ({corner_x}, {corner_y}) is "
                    "outside its body sprite"
                )
    return {
        "slotCount": len(manifest["slots"]),
        "slotRectsInsideScene": True,
        "faceQuadsInsideBodies": True,
        "uniqueDrawOrders": True,
    }


def prune_bodies(out_dir: Path, keep: set[Path]) -> list[str]:
    """Delete body sprites this batch did not write.

    A shipped batch must not leave stale sprites behind: the validator sums the
    whole `bodies/` directory against the budget, and a leftover from an earlier
    bake would be counted (and could be served) even though no layout references
    it.
    """
    removed = []
    bodies = out_dir / "bodies"
    if not bodies.is_dir():
        return removed
    keep = {path.resolve() for path in keep}
    for path in sorted(bodies.iterdir()):
        if path.is_file() and path.resolve() not in keep:
            removed.append(path.name)
            path.unlink()
    return removed


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def parse_args() -> tuple[Path, Path, str]:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(argv) not in (2, 3):
        die("usage: build_and_render.py -- <scene-spec.json> <out-dir> [full|single|spike]")
    spec_path = Path(argv[0]).resolve()
    out_dir = Path(argv[1]).resolve()
    mode = argv[2] if len(argv) == 3 else "full"
    if mode not in ("full", "single", "spike"):
        die(f"unknown batch {mode!r}; expected full, single, or spike")
    return spec_path, out_dir, mode


def body_path(spec: dict, out_dir: Path, name: str, ext: str) -> Path:
    return out_dir / spec["outputs"]["body"].format(id=name, ext=ext)


def body_entry(
    out_dir: Path, face: dict, back: dict, pose: str, back_pose: str, draw_order: int
) -> dict:
    """A manifest body: its sprite, where it is drawn, and its concealed pose."""
    def rect(record: dict) -> dict:
        return {
            "body": str(record["path"].relative_to(out_dir)),
            "x": record["rect"][0],
            "y": record["rect"][1],
            "width": record["rect"][2] - record["rect"][0],
            "height": record["rect"][3] - record["rect"][1],
        }

    entry = {"pose": pose, "drawOrder": draw_order, "shadow": face["shadow"]}
    entry.update(rect(face))
    entry["back"] = {
        "pose": back_pose,
        "shadow": back["shadow"],
        **rect(back),
    }
    return entry


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
    tile.hide_render = True
    hide_parts(table["parts"], True)

    assets = spec["assets"]
    if mode == "spike":
        # The review batch keeps its lossless PNGs so bevel, alpha, and the decal
        # seam can be inspected; only the shipped batch is lossy WebP.
        assets["body"]["fileFormat"] = "PNG"
        assets["body"]["quality"] = 100
    body_format = assets["body"]["fileFormat"]
    body_ext = "webp" if body_format == "WEBP" else body_format.lower()
    preview = spec.get("preview", {})
    hand = spec["hand"]
    counts = hand["concealedCounts"]
    layouts = hand_layouts(spec)
    log(
        f"hand row: {', '.join(str(count) for count in counts)} concealed, spacing "
        f"{resolve_row_spacing(spec):.5f} units "
        f"({'touch' if isinstance(hand['spacing'], str) else 'explicit'}), draw gap "
        f"{hand['drawGap']} units, shadow crop {hand['shadow']['alphaThreshold']:.1%} "
        f"+{hand['shadow']['cropMarginDevicePx']} px"
    )

    layouts_records = []
    alignments = []
    measurements = {}
    face_entries: dict = {}
    background = None
    body_bytes = 0
    written_bodies: set[Path] = set()

    if mode == "single":
        # ---- single-tile debug batch -------------------------------------- #
        # One tile on the felt with its shadow, in both poses, plus the table.
        # This is the fast iteration loop while the tile's geometry and the
        # table's light rig are being reviewed; it writes to a gitignored build
        # directory and never touches the shipped batch.
        # The left end of the longest row, so the camera sees the tile's right
        # side and both top corners: that is where the blue backing meets the
        # white plate across the bevel.
        slot = hand_row_slots(spec, counts[0])[0]
        log(
            f"batch single: one tile at x={slot['x']:g}, y={slot['y']:g} -> {out_dir} "
            f"({spec['scene']['samples']} samples, background "
            f"{spec.get('single', {}).get('backgroundSamples', asset_samples(spec))})"
        )
        face = bake_group(
            spec, scene, camera, tile, table, [slot], slot["pose"], out_dir,
            body_path(spec, out_dir, "tile", body_ext), label="tile",
        )
        back = bake_group(
            spec, scene, camera, tile, table, [slot], slot["backPose"], out_dir,
            body_path(spec, out_dir, "tile-back", body_ext), label="tile-back",
        )
        body_bytes += face["bytes"] + back["bytes"]
        written_bodies.update({face["path"], back["path"]})

        record = slot_record(spec, scene, camera, slot)
        record["body"] = str(face["path"].relative_to(out_dir))
        record["shadow"] = face["shadow"]
        record["back"] = {
            "pose": slot["backPose"],
            "body": str(back["path"].relative_to(out_dir)),
            "x": back["rect"][0],
            "y": back["rect"][1],
            "width": back["rect"][2] - back["rect"][0],
            "height": back["rect"][3] - back["rect"][1],
            "shadow": back["shadow"],
        }
        # Measure the *encoded* sprites, i.e. what ships, not the float buffer.
        decoded_face = load_rgba(face["path"])
        decoded_back = load_rgba(back["path"])
        face_centre_x = int(
            (record["decalQuad"][0][0] + record["decalQuad"][1][0]) / 2.0 - face["rect"][0]
        )
        record["tileBounds"] = face["tileBounds"]
        record["x"] = face["rect"][0]
        record["y"] = face["rect"][1]
        record["width"] = face["rect"][2] - face["rect"][0]
        record["height"] = face["rect"][3] - face["rect"][1]
        measurements = {
            "bodyPeak": channel_stats(face["sprite"])["maxChannel"],
            "bodyClipped": channel_stats(face["sprite"])["clippedPixels"],
            "backPeak": channel_stats(back["sprite"])["maxChannel"],
            "backClipped": channel_stats(back["sprite"])["clippedPixels"],
            "faceHeightPx": record["measurements"]["faceHeightPx"],
            "faceWidthPx": record["measurements"]["faceWidthPx"],
            "blueBackingFaceUp": measure_blue_backing(decoded_face),
            "blueBackingConcealed": measure_blue_backing(decoded_back),
            "blueTopBandPx": measure_blue_sliver(decoded_face, face_centre_x)["bluePx"],
            "blueSideBandPx": measure_side_band(decoded_face)["sideBandPx"],
        }
        log(
            "blue backing (face-up, from the shipped file): "
            f"{measurements['blueBackingFaceUp']['blueComponents']} connected band(s) "
            f"{measurements['blueBackingFaceUp']['components']}, "
            f"top band {measurements['blueTopBandPx']} px, "
            f"side band {measurements['blueSideBandPx']} px"
        )

        background = bake_background(
            spec, scene, tile, table, out_dir,
            out_dir / spec["outputs"]["background"].format(
                ext=assets["background"]["fileFormat"].lower()
            ),
            samples=int(spec.get("single", {}).get("backgroundSamples", asset_samples(spec))),
        )
        review_dir = RENDER_DIR / "build" / "single"
        # 3x nearest zoom of the tile's top-right corner, where the blue top band
        # has to wrap into the blue side band across the bevel.
        tile_bounds = face["tileBounds"]
        right = int(tile_bounds[2]) - face["rect"][0]
        top = int(tile_bounds[1]) - face["rect"][1]
        corner = (
            max(0, right - 150),
            max(0, top - 40),
            min(face["sprite"].shape[1], right + 50),
            min(face["sprite"].shape[0], top + 120),
        )
        corner_crop = face["sprite"][corner[1]:corner[3], corner[0]:corner[2]]
        if corner_crop.size:
            zoom = np.repeat(np.repeat(corner_crop, 3, axis=0), 3, axis=1)
            save_raster(
                scene, review_dir / "corner-top-right-3x.png", zoom, "PNG", 100,
            )

        for name, sprite, rect in (
            ("tile-face", face["sprite"], face["rect"]),
            ("tile-back", back["sprite"], back["rect"]),
        ):
            # Whole scene at CSS resolution, plus a 1:1 device-pixel crop so the
            # bevel, the blue/white boundary, and the shadow edge can be judged.
            canvas = background["render"].copy()
            canvas = paste(canvas, sprite, rect[0], rect[1])
            canvas[..., 3] = 1.0
            margin = 60
            crop = (
                max(0, rect[0] - margin),
                max(0, rect[1] - margin),
                min(canvas.shape[1], rect[2] + margin),
                min(canvas.shape[0], rect[3] + margin),
            )
            save_raster(
                scene, review_dir / f"{name}-device.png",
                canvas[crop[1]:crop[3], crop[0]:crop[2]], "PNG", 100, colour_mode="RGB",
            )
            scene_view = downsample_box(
                canvas, spec["assets"]["background"].get("downscale", 1)
            )
            save_raster(
                scene, review_dir / f"{name}-scene.png", scene_view, "PNG", 100,
                colour_mode="RGB",
            )
        log(f"single-tile review: {review_dir}")
        layouts_records = None

    elif mode == "spike":
        # ---- review batch: one slot from the longest row ------------------ #
        source = next(
            layout
            for layout in layouts
            if layout["count"] == counts[0] and not layout["hasDraw"]
        )
        slot = next(
            (item for item in source["slots"] if item["id"] == spec["spike"]["slotId"]),
            None,
        )
        if slot is None:
            die(f"spike.slotId {spec['spike']['slotId']!r} is not a concealed hand slot")
        log(f"batch spike: slot {slot['id']} -> {out_dir}")

        face = None
        record = None
        if not preview.get("decalOnly"):
            face = bake_group(
                spec,
                scene,
                camera,
                tile,
                table,
                [slot],
                slot["pose"],
                out_dir,
                body_path(spec, out_dir, slot["id"], body_ext),
                label=slot["id"],
            )
            written_bodies.add(face["path"])
            body_bytes += face["bytes"]
            record = slot_record(spec, scene, camera, slot)
            record["body"] = str(face["path"].relative_to(out_dir))
            record["shadow"] = face["shadow"]
            record["back"] = None
            if not preview.get("skipBack"):
                back = bake_group(
                    spec,
                    scene,
                    camera,
                    tile,
                    table,
                    [slot],
                    slot["backPose"],
                    out_dir,
                    body_path(spec, out_dir, f"{slot['id']}-back", body_ext),
                    label=f"{slot['id']}-back",
                )
                written_bodies.add(back["path"])
                body_bytes += back["bytes"]
                record["back"] = {
                    "pose": slot["backPose"],
                    "body": str(back["path"].relative_to(out_dir)),
                    "x": back["rect"][0],
                    "y": back["rect"][1],
                    "width": back["rect"][2] - back["rect"][0],
                    "height": back["rect"][3] - back["rect"][1],
                    "shadow": back["shadow"],
                }
            # The crop is the measured shadow contour, so the slot's own rect no
            # longer describes where the file sits; `body`'s x/y/width/height
            # plus `shadow.contour` do.
            record["x"] = face["rect"][0]
            record["y"] = face["rect"][1]
            record["width"] = face["rect"][2] - face["rect"][0]
            record["height"] = face["rect"][3] - face["rect"][1]
            record["tileBounds"] = face["tileBounds"]

        # ---- decal and composite ----------------------------------------- #
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

        # Pixel-perfect (nearest) review zoom of the tile's top-left corner,
        # positioned from the slot's own bounds so a contour crop cannot move it
        # out of the panel.
        zoom = spec["spike"]["zoom"]
        inset = zoom.get("tileInset", [24, 24])
        tile_left = record["tileBounds"][0] - record["x"]
        tile_top = record["tileBounds"][1] - record["y"]
        zoom_x = max(0, min(composite.shape[1] - zoom["width"], int(tile_left - inset[0])))
        zoom_y = max(0, min(composite.shape[0] - zoom["height"], int(tile_top - inset[1])))
        zoom_crop = composite[
            zoom_y : zoom_y + zoom["height"], zoom_x : zoom_x + zoom["width"]
        ]
        zoom_image = np.repeat(
            np.repeat(zoom_crop, zoom["scale"], axis=0), zoom["scale"], axis=1
        )
        zoom_path = out_dir / spec["spike"]["outputs"]["zoom"]
        save_rgba(zoom_path, zoom_image)
        log(
            f"zoom: {zoom_path.name} ({zoom_image.shape[1]}x{zoom_image.shape[0]}, "
            f"from {zoom_x},{zoom_y})"
        )

        # ---- measurements ------------------------------------------------ #
        sprite = face["sprite"]
        face_centre_x = (record["decalQuad"][0][0] + record["decalQuad"][1][0]) / 2.0
        sliver = measure_blue_sliver(sprite, round(face_centre_x - record["x"]))
        matrix_world = pose_matrix(slot["pose"], slot, spec)
        top_front = project(
            scene, camera, matrix_world @ Vector((0.0, spec["tile"]["height"] / 2.0, top))
        )
        top_back = project(
            scene, camera, matrix_world @ Vector((0.0, spec["tile"]["height"] / 2.0, 0.0))
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

    else:
        # ---- shipped batch: every layout, both poses --------------------- #
        log(
            f"batch full: {len(layouts)} layouts "
            f"({', '.join(str(count) for count in counts)} concealed, each with "
            f"and without the draw) -> {out_dir}"
        )
        baked: dict = {}
        for layout in layouts:
            body_face = bake_group(
                spec, scene, camera, tile, table, layout["slots"], hand["pose"],
                out_dir,
                body_path(spec, out_dir, layout["id"], body_ext),
                label=layout["id"],
            )
            body_back = bake_group(
                spec, scene, camera, tile, table, layout["slots"], hand["backPose"],
                out_dir,
                body_path(spec, out_dir, f"{layout['id']}-back", body_ext),
                label=f"{layout['id']}-back",
            )
            baked[layout["id"]] = {"body": body_face, "back": body_back}
            body_bytes += body_face["bytes"] + body_back["bytes"]
            written_bodies.update({body_face["path"], body_back["path"]})

        # ---- background and review composites ---------------------------- #
        background = bake_background(
            spec,
            scene,
            tile,
            table,
            out_dir,
            out_dir / spec["outputs"]["background"].format(
                ext=assets["background"]["fileFormat"].lower()
            ),
        )
        review_dir = RENDER_DIR / "build" / "review"
        review_dir.mkdir(parents=True, exist_ok=True)
        for stale in review_dir.glob("*.png"):
            stale.unlink()

        # ---- per-layout manifest records, reviews, alignment ------------- #
        order_base = hand.get("drawOrderBase", 40)
        for layout in layouts:
            parts = baked[layout["id"]]
            concealed, _ = layout_groups(layout)
            layout_record = {
                "id": layout["id"],
                "seat": layout["seat"],
                "count": layout["count"],
                "hasDraw": layout["hasDraw"],
                "orientation": layout["orientation"],
                "body": body_entry(
                    out_dir,
                    parts["body"],
                    parts["back"],
                    hand["pose"],
                    hand["backPose"],
                    order_base,
                ),
                "slots": [
                    slot_record(spec, scene, camera, slot) for slot in layout["slots"]
                ],
                "measurements": {
                    "seamContrast": seam_contrast(
                        parts["body"]["sprite"],
                        parts["body"]["rect"],
                        spec,
                        scene,
                        camera,
                        concealed,
                    ),
                },
            }
            layouts_records.append(layout_record)
            review_parts = [
                {
                    "sprite": parts["body"]["sprite"],
                    "rect": parts["body"]["rect"],
                    "back_sprite": parts["back"]["sprite"],
                    "back_rect": parts["back"]["rect"],
                }
            ]
            render_review_composite(
                spec, scene, background["render"], review_parts, "face",
                review_dir / f"{layout['id']}-face-up.png",
            )
            render_review_composite(
                spec, scene, background["render"], review_parts, "back",
                review_dir / f"{layout['id']}-face-down.png",
            )
            alignments.append(
                layout_alignment(
                    spec,
                    scene,
                    camera,
                    tile,
                    table,
                    layout,
                    [
                        {
                            "label": layout["id"],
                            "region": parts["body"]["region"],
                            "alpha": parts["body"]["alpha"],
                        }
                    ],
                    out_dir,
                )
            )

        log(f"review composites: {review_dir}")
        for result in alignments:
            log(
                f"alignment {result['layout']}: {result['shiftedPixels']} shifted px of "
                f"{result['tilePixels']} tile px, "
                f"soft-edge {result['softPixelFraction']:.4%}"
            )
            if result["shiftedPixels"] > 0:
                worst = sorted(
                    result["bodies"], key=lambda row: -row["shiftedPixels"]
                )[:3]
                die(
                    f"{result['layout']}: baked bodies do not line up with the "
                    f"rendered scene: {result['shiftedPixels']} pixels disagree by a "
                    f"full pixel (worst bodies: {worst})"
                )
            if result["softPixelFraction"] > spec["checks"]["maxMaskMismatchFraction"]:
                die(
                    f"{result['layout']}: baked bodies differ from the rendered "
                    f"scene: {result['softPixelFraction']:.4%} of tile pixels"
                )

    # ---- manifest -------------------------------------------------------- #
    decal = decal_geometry(spec)
    spacing = resolve_row_spacing(spec)
    manifest = {
        "version": 3,
        "batch": mode,
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
            "exposure": spec["scene"]["colorManagement"]["exposure"],
            "viewTransform": spec["scene"]["colorManagement"]["viewTransform"],
        },
        "camera": camera_record(spec),
        "table": {
            "plan": table_plan(spec),
            "seats": ["bottom", "right", "top", "left"],
            "handRow": {
                "seat": hand["seat"],
                "y": hand["y"],
                "centerX": hand["centerX"],
                "concealedCounts": counts,
                "spacingUnits": round(spacing, 5),
                "spacingMode": (
                    "touch" if isinstance(hand["spacing"], str) else "explicit"
                ),
                "drawGapUnits": hand["drawGap"],
                "layoutIds": [layout["id"] for layout in layouts],
                "shadow": {
                    **hand["shadow"],
                    "note": (
                        "Bodies are cropped to the measured shadow contour: the "
                        "composited alpha above alphaThreshold, plus "
                        "cropMarginDevicePx, with the outer taperDevicePx of the "
                        "margin faded to zero on shadow-only pixels. "
                        "sceneEdgeClips lists the sides where the shadow is cut by "
                        "the scene frame itself, which is allowed."
                    ),
                },
            },
        },
        "facePixels": [
            round(spec["decals"]["cssFace"][0] * 2),
            round(spec["decals"]["cssFace"][1] * 2),
        ],
        "background": (
            spec["outputs"]["background"].format(
                ext=assets["background"]["fileFormat"].lower()
            )
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
            "compositeSupersample": spec["decals"].get("compositeSupersample"),
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
        "faces": face_entries,
        "assets": {
            "bodyFormat": body_format,
            "bodyQuality": assets["body"]["quality"] if mode != "spike" else 100,
            "spriteCount": len(written_bodies),
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
    if mode == "full":
        manifest["layouts"] = layouts_records
        manifest["checks"] = check_layouts(manifest)
        manifest["checks"]["alignment"] = {
            "maxSoftPixelFraction": spec["checks"]["maxMaskMismatchFraction"],
            "shiftedPixels": sum(result["shiftedPixels"] for result in alignments),
            "layouts": alignments,
        }
    else:
        manifest["slots"] = [record]
        manifest["checks"] = check_slots(manifest)

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
    manifest_bytes = manifest_path.stat().st_size
    if manifest_bytes > budget["manifest"]:
        die(
            f"manifest is {manifest_bytes} bytes, over the "
            f"{budget['manifest']} byte budget"
        )
    removed = prune_bodies(out_dir, written_bodies) if mode == "full" else []
    if removed:
        log(f"pruned {len(removed)} stale sprite(s): {', '.join(removed)}")
    log(f"manifest: {manifest_path.name} ({manifest_bytes} B)")
    log(
        f"assets: bodies {body_bytes} B ({len(written_bodies)} sprites), background "
        f"{background['bytes'] if background else 0} B, "
        f"total {manifest['assets']['totalBytes']} B "
        f"(budget {budget['total']} B)"
    )


if __name__ == "__main__":
    main()
