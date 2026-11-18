#!/usr/bin/env python3
"""Build and render the whole-table 3D calibration reference.

Run inside the pinned Blender:

    ~/.local/opt/blender-4.5.9/blender --background \
        --python tools/render/bake_table_reference.py -- --bake

The scene is constructed from code on every run (no .blend is shipped) from
``table-reference-spec.json`` plus the tile mesh/material/lights in
``shell-spec.json``. It builds:

  - the felt plane (flat cloth, no rail/compass/apron geometry);
  - four wall runs: 17 stacks of two face-down tiles each;
  - four ponds: three filled 6-wide discard rows each;
  - four concealed 13-tile standing hands, plus the human's drawn tile;
  - one open pon per seat, the called tile lying sideways;
  - one perspective camera for the whole table.

It renders one @2x master, writes ``build/reference/geometry.json`` (camera,
every tile placement, zone bboxes, measured projection metrics and the crop
rectangles), and the @1x/@2x published renders are derived from that master by
``scripts/table-reference.mjs``. Use ``--audition`` to render the orthographic
and stronger-perspective candidates for comparison.

Options:
    --dry-run            print the plan and the camera metrics; write nothing
    --bake               render the committed @2x master
    --audition           render every camera candidate at @1x into build/
    --rig                build the same scene with the Task 2 2.5D rig camera
                         and light rig, then render the 16:9 RGBA reference
    --variant NAME       rig variant to build (default: rig.defaultVariant);
                         variants may override the table layout, camera, lights
                         and thresholds for A/B calibration
    --rig-width N        render the rig reference at N px wide (preview/tuning)
    --camera NAME        override the committed camera candidate
    --samples N          override the sample count
    --out DIR            output directory (default tools/render/build/reference)

The reference is a calibration target only. It never writes frontend/public and
the Phase 4 runtime compositor does not read it.
"""
from __future__ import annotations

import json
import math
import random
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

RENDER_DIR = Path(__file__).resolve().parent
if str(RENDER_DIR) not in sys.path:
    sys.path.insert(0, str(RENDER_DIR))

from bake_shells import (  # noqa: E402
    aim,
    build_tile,
    check_blender_version,
    configure_render,
    die,
    hex_linear,
    log,
    new_material,
    new_object,
    principled,
    render_pass,
    reset_scene,
    resolve_tile_dimensions,
)

SPEC_PATH = RENDER_DIR / "table-reference-spec.json"
SHELL_SPEC_PATH = RENDER_DIR / "shell-spec.json"
FACES_DIR = RENDER_DIR.parent.parent / "frontend" / "public" / "table" / "faces"

NORMAL_FACES = [
    f"{rank}{suit}"
    for suit in ("m", "p", "s")
    for rank in range(1, 10)
] + [f"{rank}z" for rank in range(1, 8)]
FACE_IDS = NORMAL_FACES + ["5mr", "5pr", "5sr"]


# --------------------------------------------------------------------------- #
# Spec and options
# --------------------------------------------------------------------------- #


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        die(f"{path} not found")
    except json.JSONDecodeError as error:
        die(f"{path} is not valid JSON: {error}")


def deep_merge(base, override):
    """Merge a variant override into the base record; lists replace wholesale."""
    if not isinstance(base, dict) or not isinstance(override, dict):
        return override
    merged = dict(base)
    for key, value in override.items():
        merged[key] = deep_merge(base[key], value) if key in base else value
    return merged


RIG_MERGE_KEYS = ("camera", "lighting", "render", "output", "samples", "checks")


def variant_chain(rig: dict, variant_id: str) -> list[tuple[str, dict]]:
    """The variant and its `extends` ancestors, oldest first."""
    chain = []
    seen = set()
    current = variant_id
    while current:
        if current in seen:
            die(f"rig variant cycle through {current!r}")
        seen.add(current)
        if current not in rig.get("variants", {}):
            die(
                f"unknown rig variant {current!r}; variants: "
                f"{', '.join(rig.get('variants', {})) or '(none)'}"
            )
        variant = rig["variants"][current]
        chain.append((current, variant))
        current = variant.get("extends")
    return list(reversed(chain))


def resolve_variant(spec: dict, variant_id: str | None) -> tuple[str, dict, dict]:
    """Resolve the rig variant into (id, variant, a spec with the resolved rig).

    Variants are A/B experiments: each may override the table layout (hand and
    meld radii, hand tilt), the camera, the lights, the render settings and the
    acceptance thresholds. A variant may `extends` another, so a small delta can
    sit on top of an earlier experiment while the base rig blocks stay the saved
    baseline.
    """
    rig = spec["rig"]
    chosen = variant_id or rig.get("defaultVariant")
    chain = variant_chain(rig, chosen)
    merged: dict = {}
    for _, entry in chain:
        shadow_override = entry.get("handShadow")
        merged = deep_merge(merged, {key: value for key, value in entry.items() if key != "extends"})
        # The shadow block is a strategy, not a bag of settings: a variant that
        # declares one replaces its ancestor's instead of merging into it.
        if shadow_override is not None:
            merged["handShadow"] = shadow_override
    resolved = dict(rig)
    for key in RIG_MERGE_KEYS:
        if key in rig:
            resolved[key] = deep_merge(rig[key], merged.get(key, {}))
    resolved.pop("variants", None)
    merged["extends"] = chain[-1][1].get("extends")
    for extra in ("lightingCheat", "handShadow"):
        if extra in merged:
            resolved[extra] = merged[extra]
    scene_spec = dict(spec)
    scene_spec["table"] = deep_merge(spec["table"], merged.get("table", {}))
    scene_spec["rig"] = resolved
    return chosen, merged, scene_spec


def parse_options(argv: list[str]) -> dict:
    options = {
        "dryRun": False,
        "bake": False,
        "audition": False,
        "preview": False,
        "rig": False,
        "variant": None,
        "rigWidth": None,
        "camera": None,
        "samples": None,
        "out": None,
    }
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--dry-run":
            options["dryRun"] = True
        elif arg == "--bake":
            options["bake"] = True
        elif arg == "--audition":
            options["audition"] = True
        elif arg == "--preview":
            options["preview"] = True
        elif arg == "--rig":
            options["rig"] = True
        elif arg == "--variant":
            options["variant"] = argv[index + 1]
            index += 1
        elif arg == "--preview-width":
            options["previewWidth"] = int(argv[index + 1])
            index += 1
        elif arg == "--rig-width":
            options["rigWidth"] = int(argv[index + 1])
            index += 1
        elif arg in ("--camera", "--samples", "--out"):
            if index + 1 >= len(argv):
                die(f"{arg} needs a value")
            value = argv[index + 1]
            index += 1
            if arg == "--camera":
                options["camera"] = value
            elif arg == "--samples":
                options["samples"] = int(value)
            else:
                options["out"] = Path(value)
        else:
            die(f"unknown option {arg}")
        index += 1
    return options


# --------------------------------------------------------------------------- #
# Camera model (shared with scripts/table-reference.mjs)
# --------------------------------------------------------------------------- #


def camera_from_candidate(candidate: dict, resolution: list[int]) -> dict:
    """Resolve a candidate record into the explicit camera the scene uses."""
    target = Vector(candidate["target"])
    elevation = math.radians(candidate["elevationDeg"])
    width, height = resolution
    if candidate["mode"] == "orthographic":
        distance = candidate["eyeDistanceUnits"]
        eye = target + Vector(
            (0.0, -distance * math.cos(elevation), distance * math.sin(elevation))
        )
        return {
            "mode": "orthographic",
            "eye": list(eye),
            "target": list(target),
            "elevationDeg": candidate["elevationDeg"],
            "distanceUnits": distance,
            "orthoScaleUnits": candidate["orthoScaleUnits"],
            "shiftX": 0.0,
            "shiftY": 0.0,
            "resolution": [width, height],
            "sensorFit": "HORIZONTAL",
        }
    lens = candidate["lensMm"]
    sensor = candidate["sensorWidthMm"]
    eye = Vector(candidate["eye"])
    distance = (eye - target).length
    return {
        "mode": "perspective",
        "eye": list(eye),
        "target": list(target),
        "elevationDeg": candidate["elevationDeg"],
        "distanceUnits": distance,
        "lensMm": lens,
        "sensorWidthMm": sensor,
        "sensorFit": candidate.get("sensorFit", "HORIZONTAL"),
        "shiftX": candidate.get("shiftX", 0.0),
        "shiftY": candidate.get("shiftY", 0.0),
        "focalPixels": lens / sensor * width,
        "pixelsPerUnitAtTarget": lens / sensor * width / distance,
        "resolution": [width, height],
    }


def camera_basis(eye: Vector, target: Vector) -> tuple[Vector, Vector, Vector]:
    forward = (target - eye).normalized()
    right = forward.cross(Vector((0.0, 0.0, 1.0))).normalized()
    up = right.cross(forward)
    return right, up, forward


def project_point(camera: dict, point) -> tuple[float, float]:
    """Pinhole projection, top-left origin, pixels. Matches Blender's camera."""
    eye = Vector(camera["eye"])
    target = Vector(camera["target"])
    right, up, forward = camera_basis(eye, target)
    width, height = camera["resolution"]
    value = Vector(point) - eye
    depth = value.dot(forward)
    if camera["mode"] == "orthographic":
        scale = camera["orthoScaleUnits"] / width
        offset_x = camera["shiftX"] * width
        offset_y = camera["shiftY"] * width
        return (
            width / 2 + offset_x + value.dot(right) / scale,
            height / 2 + offset_y - value.dot(up) / scale,
        )
    if depth <= 0:
        raise ValueError(f"point behind the camera: {point}")
    focal = camera["focalPixels"]
    return (
        width / 2 + camera["shiftX"] * width + focal * value.dot(right) / depth,
        height / 2 + camera["shiftY"] * width - focal * value.dot(up) / depth,
    )


def build_camera_object(scene: bpy.types.Scene, camera: dict) -> bpy.types.Object:
    data = bpy.data.cameras.new("reference-camera")
    data.sensor_fit = camera.get("sensorFit", "HORIZONTAL")
    if "sensorWidthMm" in camera:
        data.sensor_width = camera["sensorWidthMm"]
    data.shift_x = camera["shiftX"]
    data.shift_y = camera["shiftY"]
    data.clip_start = 1.0
    data.clip_end = 600.0
    if camera["mode"] == "orthographic":
        data.type = "ORTHO"
        data.ortho_scale = camera["orthoScaleUnits"]
    else:
        data.type = "PERSP"
        data.lens = camera["lensMm"]
    obj = new_object("reference-camera", data)
    obj.location = Vector(camera["eye"])
    direction = Vector(camera["target"]) - Vector(camera["eye"])
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = obj
    bpy.context.view_layer.update()
    return obj


def verify_projection(scene: bpy.types.Scene, camera: dict, points: list[Vector]) -> float:
    from bpy_extras.object_utils import world_to_camera_view

    width, height = camera["resolution"]
    worst = 0.0
    for point in points:
        co = world_to_camera_view(scene, scene.camera, point)
        expected = project_point(camera, point)
        delta = max(
            abs(co.x * width - expected[0]),
            abs((1.0 - co.y) * height - expected[1]),
        )
        worst = max(worst, delta)
    return worst


# --------------------------------------------------------------------------- #
# Scene construction
# --------------------------------------------------------------------------- #


def make_material(name: str, hex_colour: str, roughness: float, specular: float = 0.2):
    material = new_material(name)
    node = principled(material)
    node.inputs["Base Color"].default_value = hex_linear(hex_colour)
    node.inputs["Roughness"].default_value = roughness
    node.inputs["Specular IOR Level"].default_value = specular
    return material


def add_grid_mesh(name: str, size: float, z: float, material) -> bpy.types.Object:
    import bmesh

    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=size)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(material)
    obj = new_object(name, mesh)
    obj.location.z = z
    return obj


def add_square_ring(
    name: str,
    outer_half: float,
    inner_half: float,
    z_bottom: float,
    z_top: float,
    material,
) -> bpy.types.Object:
    """A flat square ring (a mat or a table rim) with closed top/bottom/sides."""
    import bmesh

    bm = bmesh.new()
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]

    def loop(half: float, z: float) -> list:
        return [bm.verts.new((corner[0] * half, corner[1] * half, z)) for corner in corners]

    outer_top = loop(outer_half, z_top)
    outer_bottom = loop(outer_half, z_bottom)
    inner_top = loop(inner_half, z_top)
    inner_bottom = loop(inner_half, z_bottom)
    for index in range(4):
        nxt = (index + 1) % 4
        bm.faces.new((outer_top[index], outer_top[nxt], inner_top[nxt], inner_top[index]))
        bm.faces.new((outer_bottom[nxt], outer_bottom[index], inner_bottom[index], inner_bottom[nxt]))
        bm.faces.new((outer_bottom[index], outer_bottom[nxt], outer_top[nxt], outer_top[index]))
        bm.faces.new((inner_bottom[index], inner_top[index], inner_top[nxt], inner_bottom[nxt]))
    bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(material)
    return new_object(name, mesh)


def add_disc_ring(
    name: str,
    outer_radius: float,
    inner_radius: float,
    z: float,
    material,
    segments: int = 64,
) -> bpy.types.Object:
    import bmesh

    bm = bmesh.new()
    outer = []
    inner = []
    for index in range(segments):
        angle = 2 * math.pi * index / segments
        outer.append(bm.verts.new((outer_radius * math.cos(angle), outer_radius * math.sin(angle), z)))
        inner.append(bm.verts.new((inner_radius * math.cos(angle), inner_radius * math.sin(angle), z)))
    for index in range(segments):
        nxt = (index + 1) % segments
        bm.faces.new((outer[index], outer[nxt], inner[nxt], inner[index]))
    bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(material)
    return new_object(name, mesh)


def build_table(scene: bpy.types.Scene, spec: dict) -> list[bpy.types.Object]:
    """The playing mat, raised rim/frame and recessed centre compass well.

    The mat is a 700 mm square ring with a square well hole; the well floor,
    compass plate and brass ring sit below z = 0, so the centre can never
    occlude a pond. The rim sits outside the mat; the locked board framing
    crops its near edge, as the old full-table framing did.
    """
    table = spec["table"]
    mat = table["playingMat"]
    rim = table["rim"]
    floor_spec = table["floor"]
    well = table["compassWell"]

    felt_material = make_material("mat-felt", mat["baseColorHex"], mat["roughness"], 0.15)
    rim_material = make_material("rim-wood", rim["colorHex"], rim["roughness"], 0.25)
    floor_material = make_material("floor", floor_spec["colorHex"], floor_spec["roughness"], 0.1)
    plate_material = make_material("compass-plate", well["plateColorHex"], 0.5, 0.2)
    ring_material = make_material("compass-ring", well["ringColorHex"], 0.35, 0.5)

    objects = [add_grid_mesh("floor", floor_spec["halfExtentUnits"], floor_spec["zUnits"], floor_material)]
    mat_half = mat["sizeUnits"] / 2
    objects.append(
        add_square_ring(
            "mat",
            mat_half,
            well["halfUnits"],
            -mat["thicknessUnits"],
            mat["topZUnits"],
            felt_material,
        )
    )
    rim_outer = rim["innerHalfUnits"] + rim["widthUnits"]
    objects.append(
        add_square_ring(
            "rim",
            rim_outer,
            rim["innerHalfUnits"],
            floor_spec["zUnits"],
            rim["heightUnits"],
            rim_material,
        )
    )
    objects.append(
        add_grid_mesh("compass-well-floor", well["halfUnits"], -well["depthUnits"], plate_material)
    )
    objects.append(
        add_grid_mesh("compass-plate", well["plateHalfUnits"], well["plateZUnits"], plate_material)
    )
    objects.append(
        add_disc_ring(
            "compass-ring",
            well["ringOuterUnits"],
            well["ringInnerUnits"],
            well["ringZUnits"],
            ring_material,
        )
    )
    log(
        f"table: {mat['sizeUnits']:g} unit ({mat['sizeMm']:g} mm) mat, rim "
        f"{rim['innerHalfUnits']:g}..{rim_outer:g} high {rim['heightUnits']:g}, "
        f"compass well {2 * well['halfUnits']:g} square x {well['depthUnits']:g} deep"
    )
    return objects



def build_reference_lights(scene: bpy.types.Scene, spec: dict) -> list[bpy.types.Object]:
    key = spec["lighting"]["key"]
    data = bpy.data.lights.new("reference-key", type=key["type"])
    if key["type"] == "AREA":
        data.shape = "RECTANGLE"
        data.size = key["size"]
        data.size_y = key["sizeY"]
        data.energy = key["energyW"]
    else:
        data.energy = key["energyWPerM2"]
        data.angle = math.radians(key["angleDeg"])
    data.color = hex_linear(key["hex"])[:3]
    obj = new_object("reference-key", data)
    azimuth = math.radians(key["azimuthDeg"])
    elevation = math.radians(key["elevationDeg"])
    distance = key["distance"]
    obj.location = Vector(
        (
            distance * math.cos(elevation) * math.sin(azimuth),
            -distance * math.cos(elevation) * math.cos(azimuth),
            distance * math.sin(elevation),
        )
    )
    aim(obj, Vector((0.0, 0.0, 0.0)))

    world = bpy.data.worlds.new("reference-world")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = hex_linear(spec["lighting"]["world"]["hex"])
    background.inputs["Strength"].default_value = spec["lighting"]["world"]["strength"]
    scene.world = world
    log(
        f"light: {key['type']} "
        + (
            f"{key['energyW']:.0f} W area {key['size']}x{key['sizeY']}"
            if key["type"] == "AREA"
            else f"{key['energyWPerM2']:.2f} W/m2, {key['angleDeg']} deg angular size"
        )
        + f" at az {key['azimuthDeg']}deg el {key['elevationDeg']}deg, {distance} units; "
        f"world {spec['lighting']['world']['hex']} x {spec['lighting']['world']['strength']}"
    )
    return [obj]


def build_rig_lights(scene: bpy.types.Scene, rig: dict) -> list[dict]:
    """The Task 2 2.5D light rig: one large AREA key plus low AREA fills.

    The key is large and close enough that tile-base contact shadows are soft
    penumbrae; the fills exist to open the bevels and the inner vertical faces
    of side tiles, which a pure overhead source leaves dark. Cycles path
    tracing produces the contact occlusion (there is no AO toggle in Cycles).
    The records are what the rig manifest publishes for Task 3A's lighting
    block.
    """
    lighting = rig["lighting"]
    entries = [lighting["key"], *lighting["fills"]]
    records: list[dict] = []
    for entry in entries:
        data = bpy.data.lights.new(entry["id"], type=entry["type"])
        if entry["type"] == "AREA":
            data.shape = entry.get("shape", "RECTANGLE")
            data.size = entry["sizeUnits"]
            data.size_y = entry.get("sizeYUnits", entry["sizeUnits"])
            data.energy = entry["energyW"]
        else:
            die(f"rig light {entry['id']}: only AREA lights are defined")
        data.color = hex_linear(entry["hex"])[:3]
        obj = new_object(entry["id"], data)
        location = Vector(entry["location"])
        aim_at = Vector(entry["aimAt"])
        obj.location = location
        aim(obj, aim_at)
        direction = (aim_at - location).normalized()
        records.append(
            {
                "id": entry["id"],
                "type": entry["type"],
                "shape": entry.get("shape"),
                "sizeUnits": entry["sizeUnits"],
                "sizeYUnits": entry.get("sizeYUnits"),
                "location": [round(value, 6) for value in location],
                "aimAt": [round(value, 6) for value in aim_at],
                "energyW": entry["energyW"],
                "hex": entry["hex"],
                "distanceUnits": round((aim_at - location).length, 6),
                "direction": [round(value, 6) for value in direction],
                "toLight": [round(-value, 6) for value in direction],
            }
        )

    world_spec = lighting["world"]
    world = bpy.data.worlds.new("rig-world")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = hex_linear(world_spec["hex"])
    background.inputs["Strength"].default_value = world_spec["strength"]
    scene.world = world
    log(
        f"rig light: AREA key {lighting['key']['sizeUnits']}x{lighting['key']['sizeYUnits']} "
        f"at {lighting['key']['location']} ({lighting['key']['energyW']:.0f} W) + "
        f"{len(lighting['fills'])} fills; world {world_spec['hex']} x {world_spec['strength']}"
    )
    return records


def build_face_material(face_id: str) -> bpy.types.Material:
    path = FACES_DIR / f"{face_id}.png"
    if not path.exists():
        die(f"face glyph {path} is missing; run node tools/render/scripts/bake-faces.mjs")
    image = bpy.data.images.load(str(path), check_existing=True)
    image.alpha_mode = "STRAIGHT"
    material = new_material(f"face-{face_id}")
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    node = nodes["Principled BSDF"]
    node.inputs["Roughness"].default_value = 0.42
    node.inputs["Specular IOR Level"].default_value = 0.2
    node.inputs["Coat Weight"].default_value = 0.0
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    texture.interpolation = "Linear"
    texture.extension = "CLIP"
    links.new(texture.outputs["Color"], node.inputs["Base Color"])
    links.new(texture.outputs["Alpha"], node.inputs["Alpha"])
    return material


def build_decal_plane(inner: dict, material: bpy.types.Material) -> bpy.types.Object:
    """One thin transparent glyph plane inside the face plate bevel."""
    import bmesh

    half_width = inner["width"] / 2
    half_height = inner["height"] / 2
    bm = bmesh.new()
    verts = [
        bm.verts.new((-half_width, half_height, 0.0)),
        bm.verts.new((half_width, half_height, 0.0)),
        bm.verts.new((half_width, -half_height, 0.0)),
        bm.verts.new((-half_width, -half_height, 0.0)),
    ]
    face = bm.faces.new(verts)
    uv_layer = bm.loops.layers.uv.new("UVMap")
    uvs = [(0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)]
    for loop, uv in zip(face.loops, uvs):
        loop[uv_layer].uv = uv
    bm.normal_update()
    mesh = bpy.data.meshes.new("face-decal")
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(material)
    obj = new_object("face-decal", mesh)
    obj.visible_shadow = False
    return obj


def tile_box_corners(tile: dict) -> list[Vector]:
    """World corners of the tile's pre-bevel body box."""
    half_width = tile["dimensions"]["width"] / 2
    half_height = tile["dimensions"]["height"] / 2
    thickness = tile["dimensions"]["thickness"]
    rotation = np.array(tile["rotation"], dtype=float).reshape(3, 3)
    origin = Vector(tile["origin"])
    corners = []
    for x in (-half_width, half_width):
        for y in (-half_height, half_height):
            for z in (0.0, thickness):
                local = Vector((x, y, z))
                world = rotation @ np.array(local)
                corners.append(origin + Vector((world[0], world[1], world[2])))
    return corners


def tile_bbox_px(camera: dict, tile: dict) -> tuple[float, float, float, float]:
    points = [project_point(camera, corner) for corner in tile_box_corners(tile)]
    left = min(point[0] for point in points)
    top = min(point[1] for point in points)
    right = max(point[0] for point in points)
    bottom = max(point[1] for point in points)
    return left, top, right, bottom


def tile_size_px(camera: dict, tile: dict) -> float:
    """Largest projected body-box dimension: the sprite's 'long axis'."""
    left, top, right, bottom = tile_bbox_px(camera, tile)
    return max(right - left, bottom - top)


def tile_long_axis_px(camera: dict, tile: dict) -> float:
    rotation = np.array(tile["rotation"], dtype=float).reshape(3, 3)
    origin = Vector(tile["origin"])
    half = tile["dimensions"]["height"] / 2
    low = origin + Vector(rotation @ np.array(Vector((0.0, -half, tile["dimensions"]["thickness"]))))
    high = origin + Vector(rotation @ np.array(Vector((0.0, half, tile["dimensions"]["thickness"]))))
    a = project_point(camera, low)
    b = project_point(camera, high)
    return math.hypot(b[0] - a[0], b[1] - a[1])


def tile_edge_px(camera: dict, tile: dict, axis: int) -> float:
    """Projected length of the local body axis (0=x width, 1=y long axis)."""
    rotation = np.array(tile["rotation"], dtype=float).reshape(3, 3)
    origin = Vector(tile["origin"])
    half = tile["dimensions"]["width" if axis == 0 else "height"] / 2
    z = tile["dimensions"]["thickness"]
    local = [0.0, 0.0, z]
    local[axis] = -half
    a = project_point(camera, origin + Vector(rotation @ np.array(Vector(local))))
    local[axis] = half
    b = project_point(camera, origin + Vector(rotation @ np.array(Vector(local))))
    return math.hypot(b[0] - a[0], b[1] - a[1])


def make_tile_record(
    tile_id: str,
    zone: str,
    kind: str,
    seat: str,
    face: str | None,
    pose: str,
    origin: Vector,
    rotation: Matrix,
    dimensions: dict,
    cell: dict,
) -> dict:
    matrix = [[rotation[row][col] for col in range(3)] for row in range(3)]
    return {
        "id": tile_id,
        "zone": zone,
        "kind": kind,
        "seat": seat,
        "face": face,
        "pose": pose,
        "origin": [round(origin.x, 6), round(origin.y, 6), round(origin.z, 6)],
        "rotation": [round(matrix[row][col], 9) for row in range(3) for col in range(3)],
        "dimensions": dimensions,
        "cell": cell,
    }


def tile_world_aabb(tile: dict) -> dict:
    corners = tile_box_corners(tile)
    minimum = [min(corner[axis] for corner in corners) for axis in range(3)]
    maximum = [max(corner[axis] for corner in corners) for axis in range(3)]
    return {"min": minimum, "max": maximum}


def aabb_gap(left: dict, right: dict) -> float:
    gaps = [
        max(0.0, left["min"][axis] - right["max"][axis], right["min"][axis] - left["max"][axis])
        for axis in range(3)
    ]
    return math.sqrt(sum(gap * gap for gap in gaps))


def aabb_intersects(left: dict, right: dict, epsilon: float = 1e-7) -> bool:
    return all(
        left["min"][axis] < right["max"][axis] - epsilon
        and right["min"][axis] < left["max"][axis] - epsilon
        for axis in range(3)
    )


def measure_clearance(tiles: list[dict], spec: dict) -> dict:
    """Tile-body spacing and the zero-mesh-intersection acceptance.

    Adjacent wall/river/hand tiles must have 0.2-0.5 mm clearance. The boxes are
    the pre-bevel tile bodies (the bevel only pulls the silhouette inward), so
    the measurement is conservative. Every pair of tile bodies must be
    non-intersecting.
    """
    clearance = spec["table"]["clearanceUnits"]
    low_mm, high_mm = spec["anchors"]["clearanceRangeMm"]
    boxes = {tile["id"]: tile_world_aabb(tile) for tile in tiles}
    by_id = {tile["id"]: tile for tile in tiles}

    pairs: list[tuple[str, str]] = []

    def add_pairs(grouped: dict, key):
        for items in grouped.values():
            ordered = sorted(items, key=key)
            for left, right in zip(ordered, ordered[1:]):
                pairs.append((left, right))

    wall_by_key = {}
    pond_rows = {}
    pond_cols = {}
    hand_by_seat = {}
    meld_by_seat = {}
    for tile in tiles:
        if tile["kind"] == "wall":
            wall_by_key.setdefault((tile["seat"], tile["cell"]["tier"]), []).append(tile["id"])
        elif tile["kind"] == "pond":
            pond_rows.setdefault((tile["seat"], tile["cell"]["row"]), []).append(tile["id"])
            pond_cols.setdefault((tile["seat"], tile["cell"]["column"]), []).append(tile["id"])
        elif tile["kind"] == "hand":
            hand_by_seat.setdefault(tile["seat"], []).append(tile["id"])
        elif tile["kind"] == "meld":
            meld_by_seat.setdefault(tile["seat"], []).append(tile["id"])

    dead = spec["table"]["wall"]["deadWall"]
    break_ids = {
        (
            f"wall-{dead['seat']}-slot-{dead['breakAfterSlot']:02d}-t{tier}",
            f"wall-{dead['seat']}-slot-{dead['breakAfterSlot'] + 1:02d}-t{tier}",
        )
        for tier in range(spec["table"]["wall"]["tiers"])
    }
    for items in wall_by_key.values():
        ordered = sorted(items, key=lambda tile_id: by_id[tile_id]["cell"]["slot"])
        for left, right in zip(ordered, ordered[1:]):
            if (left, right) in break_ids:
                continue
            pairs.append((left, right))
    for tier in range(spec["table"]["wall"]["tiers"] - 1):
        for seat in ("bottom", "right", "top", "left"):
            for slot in range(spec["table"]["wall"]["stacksPerRun"]):
                left = f"wall-{seat}-slot-{slot:02d}-t{tier}"
                right = f"wall-{seat}-slot-{slot:02d}-t{tier + 1}"
                if left in boxes and right in boxes:
                    pairs.append((left, right))
    for items in pond_rows.values():
        ordered = sorted(items, key=lambda tile_id: by_id[tile_id]["cell"]["column"])
        for left, right in zip(ordered, ordered[1:]):
            pairs.append((left, right))
    riichi_ids = {
        tile["id"] for tile in tiles if tile.get("cell", {}).get("riichi")
    }
    riichi_row = spec["table"]["pond"]["riichi"]["row"]
    far_riichi_pairs = []
    for items in pond_cols.values():
        ordered = sorted(items, key=lambda tile_id: by_id[tile_id]["cell"]["row"])
        for left, right in zip(ordered, ordered[1:]):
            if left in riichi_ids or right in riichi_ids:
                other = right if left in riichi_ids else left
                if by_id[other]["cell"]["row"] > riichi_row:
                    far_riichi_pairs.append((left, right))
                    continue
            pairs.append((left, right))
    for items in hand_by_seat.values():
        ordered = sorted(items, key=lambda tile_id: by_id[tile_id]["cell"]["slot"])
        for left, right in zip(ordered, ordered[1:]):
            pairs.append((left, right))
    for items in meld_by_seat.values():
        ordered = sorted(items, key=lambda tile_id: by_id[tile_id]["cell"]["column"])
        for left, right in zip(ordered, ordered[1:]):
            pairs.append((left, right))

    # The acceptance range is 0.2-0.5 mm; the nominal target is 0.3 mm, so the
    # rounded spec pitch may land a few micro-units above the target.
    low = low_mm / 28.0 - 1e-6
    high = high_mm / 28.0 + 1e-6
    measured = []
    for left, right in pairs:
        gap = aabb_gap(boxes[left], boxes[right])
        measured.append(gap)
        if not (low <= gap <= high):
            die(
                f"clearance {left} <-> {right} is {gap * 28:.6f} mm, "
                f"expected 0.2-0.5 mm"
            )
    break_gaps = []
    for left, right in break_ids:
        if left in boxes and right in boxes:
            break_gaps.append(aabb_gap(boxes[left], boxes[right]))
    expected_break = spec["table"]["wall"]["deadWall"]["breakGapUnits"] + clearance
    for gap in break_gaps:
        if abs(gap - expected_break) > 1e-5:
            die(
                f"dead-wall break gap {gap:.6f} != {expected_break:.6f} units"
            )

    overlapping = []
    ids = list(boxes)
    for index, left in enumerate(ids):
        for right in ids[index + 1 :]:
            if aabb_intersects(boxes[left], boxes[right]):
                overlapping.append((left, right))
    if overlapping:
        die(f"{len(overlapping)} tile pairs intersect, e.g. {overlapping[:4]}")

    result = {
        "targetMm": round(clearance * 28, 4),
        "rangeMm": [low_mm, high_mm],
        "adjacentPairs": len(pairs),
        "minGapMm": round(min(measured) * 28, 4),
        "maxGapMm": round(max(measured) * 28, 4),
        "intersectingPairs": 0,
        "tiles": len(tiles),
        "deadWallBreakMm": round((max(break_gaps) if break_gaps else 0.0) * 28, 4),
        "deadWallBreakPairs": len(break_gaps),
        "riichiFarGapMm": round(
            min((aabb_gap(boxes[left], boxes[right]) for left, right in far_riichi_pairs),
                default=0.0) * 28, 4
        ),
        "riichiFarPairs": len(far_riichi_pairs),
    }
    log(
        f"clearance: {len(pairs)} adjacent pairs at "
        f"{result['minGapMm']:.4f}-{result['maxGapMm']:.4f} mm, 0 intersecting pairs"
    )
    return result


def corrected_normal_material(source, angle: float, cache: dict) -> bpy.types.Material:
    """A copy of `source` whose shading normal is rotated about world X."""
    if source.name in cache:
        return cache[source.name]
    material = source.copy()
    material.name = f"{source.name}-handlit"
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    geometry = nodes.new("ShaderNodeNewGeometry")
    rotate = nodes.new("ShaderNodeVectorRotate")
    rotate.rotation_type = "AXIS_ANGLE"
    rotate.inputs["Axis"].default_value = (1.0, 0.0, 0.0)
    rotate.inputs["Angle"].default_value = angle
    rotate.location = (-600.0, 300.0)
    links.new(geometry.outputs["Normal"], rotate.inputs["Vector"])
    count = 0
    for node in nodes:
        if node.type == "BSDF_PRINCIPLED":
            links.new(rotate.outputs["Vector"], node.inputs["Normal"])
            count += 1
    if not count:
        die(f"hand lighting cheat: {source.name} has no Principled BSDF")
    cache[source.name] = material
    return material


def apply_hand_lighting_cheat(spec: dict, rig: dict) -> dict | None:
    """Shade the player's hand as if it sat at the physical tilt.

    The hand is reclined further than physically plausible so its faces read
    from the 50 deg camera (the user's deliberate cheat; the runtime replaces
    its real shadow with a blob). To keep the light on it looking like a
    normally seated tile, every hand material shades with its normal rotated
    back by the extra tilt (delta = cheated tilt - physical tilt) about world X
    (the hand row is not yawed). The silhouette keeps the cheat; the shading
    does not.
    """
    cheat = rig.get("lightingCheat")
    if not cheat:
        return None
    if cheat.get("mode") != "physicalPose":
        die(f"hand lighting cheat: unknown mode {cheat.get('mode')!r}")
    hand = spec["table"]["hand"]
    cheated = math.radians(hand["tiltDeg"])
    physical = math.radians(cheat["physicalTiltDeg"])
    delta = cheated - physical
    if abs(delta) < 1e-6:
        return {
            "mode": cheat["mode"],
            "physicalTiltDeg": cheat["physicalTiltDeg"],
            "cheatedTiltDeg": hand["tiltDeg"],
            "deltaDeg": 0.0,
            "objects": 0,
            "materials": 0,
        }
    prefix = "hand-bottom-"
    targets = [
        obj for obj in bpy.data.objects
        if obj.type == "MESH" and obj.name.startswith(prefix)
    ]
    if not targets:
        die("hand lighting cheat: found no south-hand mesh objects")
    cache: dict = {}
    for obj in targets:
        for slot in obj.material_slots:
            source = slot.material
            if source is None:
                continue
            # Switching the slot to object-linked materials clears the slot, so
            # keep the source material before the switch.
            slot.link = "OBJECT"
            slot.material = corrected_normal_material(source, delta, cache)
    record = {
        "mode": cheat["mode"],
        "physicalTiltDeg": cheat["physicalTiltDeg"],
        "cheatedTiltDeg": hand["tiltDeg"],
        "deltaDeg": round(math.degrees(delta), 4),
        "axis": [1.0, 0.0, 0.0],
        "objects": len(targets),
        "materials": len(cache),
        "note": cheat.get("note"),
    }
    log(
        f"hand lighting cheat: {len(targets)} objects, {len(cache)} materials shade as if the "
        f"hand were at {cheat['physicalTiltDeg']:g} deg (cheated pose {hand['tiltDeg']:g} deg, "
        f"normal rotated {math.degrees(delta):+.2f} deg about world X)"
    )
    return record


def shadow_decal_material(max_alpha: float, falloff: float, edge_fade: float) -> bpy.types.Material:
    """Pure darkening: a black, roughness-1 surface whose alpha is a UV gradient.

    Alpha is strongest at the strip's near edge (v = 0, hidden under the tile),
    falls off across the strip and is zero at both x ends. Building it from math
    nodes keeps the ramp exact at any resolution, with no image to sample.
    """
    material = new_material("hand-shadow-decal")
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = nodes["Principled BSDF"]
    principled.inputs["Base Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    principled.inputs["Roughness"].default_value = 1.0
    principled.inputs["Specular IOR Level"].default_value = 0.0
    uv = nodes.new("ShaderNodeUVMap")
    separate = nodes.new("ShaderNodeSeparateXYZ")
    links.new(uv.outputs["UV"], separate.inputs["Vector"])

    one_minus_y = nodes.new("ShaderNodeMath")
    one_minus_y.operation = "SUBTRACT"
    one_minus_y.inputs[0].default_value = 1.0
    links.new(separate.outputs["Y"], one_minus_y.inputs[1])
    power = nodes.new("ShaderNodeMath")
    power.operation = "POWER"
    power.inputs[1].default_value = falloff
    links.new(one_minus_y.outputs[0], power.inputs[0])

    left = nodes.new("ShaderNodeMath")
    left.operation = "DIVIDE"
    left.use_clamp = True
    left.inputs[1].default_value = edge_fade
    links.new(separate.outputs["X"], left.inputs[0])
    right = nodes.new("ShaderNodeMath")
    right.operation = "DIVIDE"
    right.use_clamp = True
    right.inputs[1].default_value = edge_fade
    invert = nodes.new("ShaderNodeMath")
    invert.operation = "SUBTRACT"
    invert.inputs[0].default_value = 1.0
    links.new(separate.outputs["X"], invert.inputs[1])
    links.new(invert.outputs[0], right.inputs[0])
    edge = nodes.new("ShaderNodeMath")
    edge.operation = "MINIMUM"
    links.new(left.outputs[0], edge.inputs[0])
    links.new(right.outputs[0], edge.inputs[1])
    edge_power = nodes.new("ShaderNodeMath")
    edge_power.operation = "POWER"
    edge_power.inputs[1].default_value = 0.8
    links.new(edge.outputs[0], edge_power.inputs[0])

    combined = nodes.new("ShaderNodeMath")
    combined.operation = "MULTIPLY"
    links.new(power.outputs[0], combined.inputs[0])
    links.new(edge_power.outputs[0], combined.inputs[1])
    scaled = nodes.new("ShaderNodeMath")
    scaled.operation = "MULTIPLY"
    scaled.inputs[1].default_value = max_alpha
    links.new(combined.outputs[0], scaled.inputs[0])
    links.new(scaled.outputs[0], principled.inputs["Alpha"])
    return material


def edge_profile(nodes, links, source, edge: float, sigma: float, inside_sign: float):
    """A one-sided blurred edge: 0.5 at the edge, 1 inside, 0 outside over 2 sigma."""
    offset = nodes.new("ShaderNodeMath")
    offset.operation = "SUBTRACT"
    offset.inputs[1].default_value = edge
    links.new(source, offset.inputs[0])
    distance = offset.outputs[0]
    if inside_sign < 0:
        negate = nodes.new("ShaderNodeMath")
        negate.operation = "MULTIPLY"
        negate.inputs[1].default_value = -1.0
        links.new(offset.outputs[0], negate.inputs[0])
        distance = negate.outputs[0]
    ramp = nodes.new("ShaderNodeMapRange")
    ramp.interpolation_type = "SMOOTHSTEP"
    ramp.clamp = True
    ramp.inputs["From Min"].default_value = -2.0 * sigma
    ramp.inputs["From Max"].default_value = 2.0 * sigma
    ramp.inputs["To Min"].default_value = 0.0
    ramp.inputs["To Max"].default_value = 1.0
    links.new(distance, ramp.inputs["Value"])
    return ramp.outputs["Result"]


def blurred_footprint_material(
    x0: float,
    x1: float,
    y_south: float,
    depth: float,
    sigma_x: float,
    sigma_y: float,
    max_alpha: float,
) -> bpy.types.Material:
    """A Gaussian-like blurred rounded rectangle under the hand's footprint.

    This is the render-time analogue of the retired UI recipe: the contact
    rectangle blurred once, drawn under the object. All four edges are blurred
    (the north edge sits under the tiles, so it is hidden in the row and fades
    softly past the end tiles instead of leaving a hard line). The alpha is
    0.5*maxAlpha at every footprint edge, 1 inside and 0 two sigma outside.
    """
    material = new_material("hand-shadow-blob")
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = nodes["Principled BSDF"]
    principled.inputs["Base Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    principled.inputs["Roughness"].default_value = 1.0
    principled.inputs["Specular IOR Level"].default_value = 0.0
    coordinates = nodes.new("ShaderNodeTexCoord")
    separate = nodes.new("ShaderNodeSeparateXYZ")
    links.new(coordinates.outputs["Object"], separate.inputs["Vector"])
    y_north = y_south + depth
    profiles = [
        edge_profile(nodes, links, separate.outputs["X"], x0, sigma_x, 1.0),
        edge_profile(nodes, links, separate.outputs["X"], x1, sigma_x, -1.0),
        edge_profile(nodes, links, separate.outputs["Y"], y_south, sigma_y, 1.0),
        edge_profile(nodes, links, separate.outputs["Y"], y_north, sigma_y, -1.0),
    ]
    alpha = None
    for source in profiles:
        multiply = nodes.new("ShaderNodeMath")
        multiply.operation = "MULTIPLY"
        if alpha is None:
            multiply.inputs[0].default_value = max_alpha
        else:
            links.new(alpha, multiply.inputs[0])
        links.new(source, multiply.inputs[1])
        alpha = multiply.outputs[0]
    links.new(alpha, principled.inputs["Alpha"])
    return material


def add_shadow_plane(
    name: str,
    x0: float,
    x1: float,
    y_north: float,
    y_south: float,
    z: float,
    material: bpy.types.Material,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(
        [(x0, y_north, z), (x1, y_north, z), (x1, y_south, z), (x0, y_south, z)],
        [],
        [(0, 1, 2, 3)],
    )
    mesh.materials.append(material)
    obj = new_object(name, mesh)
    obj.visible_camera = True
    obj.visible_shadow = False
    obj.visible_diffuse = False
    obj.visible_glossy = False
    obj.visible_transmission = False
    obj.visible_volume_scatter = False
    return obj


def add_shadow_strip(
    name: str,
    x0: float,
    x1: float,
    y_start: float,
    y_end: float,
    z: float,
    material: bpy.types.Material,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(
        [(x0, y_start, z), (x1, y_start, z), (x1, y_end, z), (x0, y_end, z)],
        [],
        [(0, 1, 2, 3)],
    )
    uv = mesh.uv_layers.new(name="UVMap")
    for loop, coordinate in zip(mesh.loops, [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]):
        uv.data[loop.index].uv = coordinate
    mesh.materials.append(material)
    obj = new_object(name, mesh)
    obj.visible_camera = True
    obj.visible_shadow = False
    obj.visible_diffuse = False
    obj.visible_glossy = False
    obj.visible_transmission = False
    obj.visible_volume_scatter = False
    return obj


def apply_hand_shadow_cheat(spec: dict, rig: dict, tiles: list[dict]) -> dict | None:
    """Give the cheated player's hand a fake, seated-tile shadow.

    The 40 deg readability cheat floats the tile's front (near) bottom edge
    above the table, so its own shadow starts at the *rear* edge where it
    balances and climbs the wall behind it. Both give the trick away. The hand's
    bodies and decals therefore stop casting shadows entirely, and one of two
    fake shadows goes under the row:

    - ``physicalPoseCaster``: a shadow-only duplicate at the 12 deg physical
      pose, with the fills light-linked so only the key casts it (v3).
    - ``gradientDecal`` (v4): a short, soft, straight-alpha gradient strip laid
      on the mat. Its darkest point is hidden under the tile and the visible
      gradient begins right at the tile's front edge, as if the tile sat upright
      and level there, fading out within a third of a tile height. No shadow
      rays at all, so the wall behind stays clean.
    """
    shadow = rig.get("handShadow")
    if not shadow:
        return None
    hand = spec["table"]["hand"]
    radius = hand.get("backRadiusUnitsBySeat", {}).get("bottom", hand["backRadiusUnits"])
    bodies = [
        obj for obj in bpy.data.objects
        if obj.type == "MESH"
        and obj.name.startswith("hand-bottom-")
        and not obj.name.endswith("-decal")
    ]
    decals = [
        obj for obj in bpy.data.objects
        if obj.type == "MESH"
        and obj.name.startswith("hand-bottom-")
        and obj.name.endswith("-decal")
    ]
    if not bodies:
        die("hand shadow cheat: found no south-hand bodies")
    for obj in bodies + decals:
        obj.visible_shadow = False

    mode = shadow.get("mode")
    if mode == "physicalPoseCaster":
        return apply_physical_caster_shadow(
            spec, rig, shadow, hand, radius, bodies, decals
        )
    if mode == "gradientDecal":
        return apply_gradient_decal_shadow(
            spec, rig, shadow, hand, radius, tiles, bodies, decals
        )
    if mode == "blurredFootprint":
        return apply_blurred_footprint_shadow(
            spec, rig, shadow, hand, radius, tiles, bodies, decals
        )
    die(f"hand shadow cheat: unknown mode {mode!r}")


def apply_physical_caster_shadow(
    spec: dict,
    rig: dict,
    shadow: dict,
    hand: dict,
    radius: float,
    bodies: list[bpy.types.Object],
    decals: list[bpy.types.Object],
) -> dict:
    cheat = rig.get("lightingCheat")
    if cheat and abs(float(cheat["physicalTiltDeg"]) - float(shadow["physicalTiltDeg"])) > 1e-9:
        die("hand shadow cheat: physicalTiltDeg disagrees with the lighting cheat")
    cheated = math.radians(hand["tiltDeg"])
    physical = math.radians(shadow["physicalTiltDeg"])
    delta = cheated - physical
    caster_collection = bpy.data.collections.new("HandShadowCasters")
    bpy.context.scene.collection.children.link(caster_collection)
    casters = []
    for body in bodies:
        caster = body.copy()
        caster.data = body.data
        caster.name = f"{body.name}-shadowcaster"
        pivot = Vector((body.matrix_world.translation.x, -radius, 0.0))
        caster.matrix_world = (
            Matrix.Translation(pivot)
            @ Matrix.Rotation(delta, 4, "X")
            @ Matrix.Translation(-pivot)
            @ body.matrix_world
        )
        caster.visible_shadow = True
        caster.visible_camera = False
        caster.visible_diffuse = False
        caster.visible_glossy = False
        caster.visible_transmission = False
        caster.visible_volume_scatter = False
        caster.hide_render = False
        caster_collection.objects.link(caster)
        casters.append(caster)

    fills = []
    if shadow.get("fillsDoNotSeeCaster", True):
        blocker_collection = bpy.data.collections.new("RigFillBlockers")
        bpy.context.scene.collection.children.link(blocker_collection)
        caster_set = set(casters)
        for obj in bpy.context.scene.objects:
            if obj in caster_set or obj.type in {"LIGHT", "CAMERA"}:
                continue
            blocker_collection.objects.link(obj)
        for entry in rig["lighting"]["fills"]:
            light = bpy.data.objects.get(entry["id"])
            if light is None:
                die(f"hand shadow cheat: fill {entry['id']} is missing")
            light.light_linking.blocker_collection = blocker_collection
            fills.append(entry["id"])

    record = {
        "mode": shadow["mode"],
        "physicalTiltDeg": shadow["physicalTiltDeg"],
        "cheatedTiltDeg": hand["tiltDeg"],
        "deltaDeg": round(math.degrees(delta), 4),
        "playerHandRadiusUnits": radius,
        "hiddenObjects": len(bodies) + len(decals),
        "handBodies": len(bodies),
        "handDecals": len(decals),
        "casters": len(casters),
        "fillLights": fills,
        "note": shadow.get("note"),
    }
    log(
        f"hand shadow cheat: {len(bodies) + len(decals)} hand objects hidden from shadows, "
        f"{len(casters)} casters at the {shadow['physicalTiltDeg']:g} deg physical pose"
        + (f"; {len(fills)} fills do not see the casters" if fills else "")
    )
    return record


def apply_blurred_footprint_shadow(
    spec: dict,
    rig: dict,
    shadow: dict,
    hand: dict,
    radius: float,
    tiles: list[dict],
    bodies: list[bpy.types.Object],
    decals: list[bpy.types.Object],
) -> dict:
    """The retired UI recipe in the reference scene: a blurred contact rectangle.

    One plane per hand group (the 13-tile row and the drawn tile). Each group's
    shadow rectangle is its contact footprint, widened outward (away from the
    other group) by ``spreadUnits`` so the wrap extends past the outer end
    tiles, and extended ``depthUnits`` north under the tiles. All four edges are
    blurred, so the shadow wraps in every direction and the groups stay separate
    at the tsumogiri gap. The rectangle is drawn at 0.5*maxAlpha on its edges
    and fades to zero two sigma outside; the plane starts at the south edge and
    only extends outward, with no shadow rays.
    """
    thickness = tiles[0]["dimensions"]["thickness"]
    tilt = math.radians(hand["tiltDeg"])
    pitch = math.radians(rig["camera"]["elevationDeg"])
    front_edge = radius + math.cos(tilt) * thickness
    edge_height = math.sin(tilt) * thickness
    edge_line = front_edge - edge_height / math.tan(pitch)
    sigma = float(shadow["sigmaUnits"])
    sigma_x = float(shadow.get("sigmaXUnits", sigma))
    max_alpha = float(shadow["maxAlpha"])
    spread = float(shadow.get("spreadUnits", 0.0))
    spreads = shadow.get("spreads") or {}
    offset = float(shadow.get("offsetYUnits", 0.0))
    depth = float(shadow.get("depthUnits", 0.5))
    z = float(shadow.get("zUnits", 0.0025))
    margin = 2.5 * sigma
    # Offset the whole footprint a little forward (south): the shadow should not
    # look like it surrounds the tiles perfectly evenly.
    y_south = -edge_line - offset
    y_north = y_south + depth
    bottom = [tile for tile in tiles if tile["seat"] == "bottom" and tile["kind"] in ("hand", "drawn")]
    groups = [
        [tile for tile in bottom if tile["kind"] == "hand"],
        [tile for tile in bottom if tile["kind"] == "drawn"],
    ]
    groups = [group for group in groups if group]
    if shadow.get("unionGroups"):
        # The retired UI group recipe: union the zone's footprints, blur once.
        # The hand row and the drawn tile become one symmetric shadow with no
        # double-darkened overlap in the tsumogiri gap.
        groups = [bottom]
    planes = []
    group_records = []
    for index, group in enumerate(groups):
        half = group[0]["dimensions"]["width"] / 2
        xs = [tile["origin"][0] for tile in group]
        tile_x0, tile_x1 = min(xs) - half, max(xs) + half
        # Per-group spreads: the hand row widens both of its ends (so its right
        # shadow passes the last tile), while the drawn tile keeps its gap side
        # at its tile edge and widens only outward. A variant may override each
        # side through `spreads`.
        kind = "hand" if shadow.get("unionGroups") else group[0]["kind"]
        entry = spreads.get(kind, {})
        spread_left = float(entry.get("left", spread))
        spread_right = float(entry.get("right", spread))
        x0, x1 = tile_x0 - spread_left, tile_x1 + spread_right
        material = blurred_footprint_material(x0, x1, y_south, depth, sigma_x, sigma, max_alpha)
        planes.append(
            add_shadow_plane(
                f"hand-shadow-blob-{len(planes)}",
                x0 - margin,
                x1 + margin,
                y_north + margin,
                y_south - margin,
                # Coplanar translucent planes z-fight and one of them wins per
                # pixel, which shows up as a bright notch where the row's and
                # the drawn tile's blobs overlap. Stagger them by a hair.
                z + 0.0008 * len(planes),
                material,
            )
        )
        group_records.append(
            {
                "kind": kind,
                "x0": round(x0, 4),
                "x1": round(x1, 4),
                "tileX0": round(tile_x0, 4),
                "tileX1": round(tile_x1, 4),
                "spreadLeftUnits": round(spread_left, 4),
                "spreadRightUnits": round(spread_right, 4),
                "widthUnits": round(x1 - x0, 4),
                "tileWidthUnits": round(tile_x1 - tile_x0, 4),
                "edgeRadiusUnits": round(edge_line, 4),
            }
        )
    record = {
        "mode": shadow["mode"],
        "cheatedTiltDeg": hand["tiltDeg"],
        "playerHandRadiusUnits": radius,
        "frontEdgeRadiusUnits": round(front_edge, 4),
        "edgeHeightUnits": round(edge_height, 4),
        "edgeLineRadiusUnits": round(edge_line, 4),
        "sigmaUnits": sigma,
        "sigmaXUnits": sigma_x,
        "maxAlpha": max_alpha,
        "spreadUnits": spread,
        "spreads": spreads,
        "offsetYUnits": offset,
        "depthUnits": depth,
        "falloff": "gaussian-like smoothstep on all four edges, 2 sigma",
        "unionGroups": bool(shadow.get("unionGroups")),
        "groups": group_records,
        "hiddenObjects": len(bodies) + len(decals),
        "handBodies": len(bodies),
        "handDecals": len(decals),
        "objects": len(planes),
        "note": shadow.get("note"),
    }
    log(
        f"hand shadow blob: {len(planes)} blurred-footprint planes, edge line {edge_line:.3f} "
        f"(front edge {front_edge:.3f}), sigma {sigma:.3f}/{sigma_x:.3f} x, max alpha {max_alpha:g}, "
f"spreads {spreads or spread}, offset {offset:.3f} south, "
        f"depth {depth:.3f} north, "
        f"over {len(bodies) + len(decals)} hidden hand objects"
    )
    return record


def apply_gradient_decal_shadow(
    spec: dict,
    rig: dict,
    shadow: dict,
    hand: dict,
    radius: float,
    tiles: list[dict],
    bodies: list[bpy.types.Object],
    decals: list[bpy.types.Object],
) -> dict:
    thickness = tiles[0]["dimensions"]["thickness"]
    tilt = math.radians(hand["tiltDeg"])
    pitch = math.radians(rig["camera"]["elevationDeg"])
    front_edge = radius + math.cos(tilt) * thickness
    edge_height = math.sin(tilt) * thickness
    # The mat point that projects at the tile's front-edge silhouette: pull the
    # decal's start north under the tile by edgeHeight / tan(pitch) so its hard
    # near edge is hidden by the tile and the visible gradient begins right at
    # the tile's front edge.
    start_radius = front_edge - edge_height / math.tan(pitch)
    length = float(shadow["lengthUnits"])
    max_alpha = float(shadow["maxAlpha"])
    z = float(shadow.get("zUnits", 0.0025))
    material = shadow_decal_material(
        max_alpha,
        float(shadow.get("falloff", 1.2)),
        float(shadow.get("edgeFade", 0.03)),
    )
    bottom = [tile for tile in tiles if tile["seat"] == "bottom" and tile["kind"] in ("hand", "drawn")]
    groups = [
        [tile for tile in bottom if tile["kind"] == "hand"],
        [tile for tile in bottom if tile["kind"] == "drawn"],
    ]
    strips = []
    for group in groups:
        if not group:
            continue
        half = group[0]["dimensions"]["width"] / 2
        xs = [tile["origin"][0] for tile in group]
        x0, x1 = min(xs) - half, max(xs) + half
        y_start = -start_radius
        strips.append(
            add_shadow_strip(
                f"hand-shadow-strip-{len(strips)}",
                x0,
                x1,
                y_start,
                y_start - length,
                z,
                material,
            )
        )
    record = {
        "mode": shadow["mode"],
        "physicalTiltDeg": shadow.get("physicalTiltDeg"),
        "cheatedTiltDeg": hand["tiltDeg"],
        "playerHandRadiusUnits": radius,
        "frontEdgeRadiusUnits": round(front_edge, 4),
        "edgeHeightUnits": round(edge_height, 4),
        "startRadiusUnits": round(start_radius, 4),
        "lengthUnits": length,
        "maxAlpha": max_alpha,
        "falloff": float(shadow.get("falloff", 1.2)),
        "edgeFade": float(shadow.get("edgeFade", 0.03)),
        "hiddenObjects": len(bodies) + len(decals),
        "handBodies": len(bodies),
        "handDecals": len(decals),
        "strips": len(strips),
        "objects": len(strips),
        "note": shadow.get("note"),
    }
    log(
        f"hand shadow decal: {len(strips)} gradient strips, start {start_radius:.3f} units "
        f"(front edge {front_edge:.3f}), {length:.3f} units long, max alpha {max_alpha:g}, "
        f"over {len(bodies) + len(decals)} hidden hand objects"
    )
    return record


def build_scene(spec: dict, options: dict) -> tuple[bpy.types.Scene, dict, dict]:
    shell_spec = read_json(SHELL_SPEC_PATH)
    check_blender_version(shell_spec)
    scene = reset_scene()
    resolve_tile_dimensions(shell_spec)
    configure_render(scene, shell_spec)
    scene.cycles.samples = (
        options["samples"] if options["samples"] is not None else spec["scene"]["samples"]
    )
    rig_mode = bool(options.get("rig"))
    if rig_mode:
        rig = spec["rig"]
        scene.cycles.samples = (
            options["samples"] if options["samples"] is not None else rig["render"]["samples"]
        )
        scene.cycles.adaptive_threshold = rig["render"]["adaptiveThreshold"]
        scene.cycles.use_adaptive_sampling = rig["render"]["adaptiveSampling"]
        scene.render.film_transparent = rig["render"]["filmTransparent"]
        scene.render.image_settings.color_mode = rig["render"]["colorMode"]
    log(
        f"{'rig' if rig_mode else 'reference'} render: {scene.cycles.samples} samples, "
        f"film transparent "
        f"{rig['render']['filmTransparent'] if rig_mode else spec['scene']['filmTransparent']}"
    )
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    if not rig_mode:
        scene.render.film_transparent = spec["scene"]["filmTransparent"]
        scene.render.image_settings.color_mode = "RGB"
    scene.view_settings.look = spec["scene"]["colorManagement"]["look"]

    table_objects = build_table(scene, spec)
    if rig_mode:
        if rig["render"]["hideFloor"]:
            for obj in table_objects:
                if obj.name == "floor":
                    obj.hide_render = True
                    obj.hide_viewport = True
                    log("rig: room floor hidden (film transparent)")
        light_records = build_rig_lights(scene, rig)
        rig_lighting = {
            "lights": light_records,
            "world": {
                "hex": rig["lighting"]["world"]["hex"],
                "strength": rig["lighting"]["world"]["strength"],
            },
            "ambientOcclusion": rig["lighting"]["ambientOcclusion"],
        }
    else:
        build_reference_lights(scene, spec)
        rig_lighting = None

    anchors_spec = spec["anchors"]
    anchor_collection = bpy.data.collections.new(anchors_spec["collection"])
    scene.collection.children.link(anchor_collection)

    tile = shell_spec["tile"]
    dimensions = {
        "width": round(tile["width"], 6),
        "height": round(tile["height"], 6),
        "thickness": round(tile["thickness"], 6),
    }
    thickness = tile["thickness"]
    face_inset = tile["faceInset"]
    inner = {
        "width": tile["width"] - 2 * face_inset,
        "height": tile["height"] - 2 * face_inset,
    }
    template = build_tile(scene, shell_spec)
    template.hide_render = True
    template.hide_viewport = True

    seat_ids = [seat["id"] for seat in spec["table"]["seats"]]
    seat_angle = {seat["id"]: seat["rotateZDeg"] for seat in spec["table"]["seats"]}
    rng = random.Random(spec["content"]["seed"])
    sample_face = spec["faces"]["sampleFace"]
    sample_tile = spec["faces"]["sampleTileId"]

    tiles: list[dict] = []
    decals: list[dict] = []
    materials: dict[str, bpy.types.Material] = {}
    index = {"pond": {}, "hand": {}, "meld": {}, "wall": {}, "drawn": {}}

    def next_face(tile_id: str) -> str:
        if tile_id == sample_tile:
            return sample_face
        if rig_mode:
            rig_samples = spec["rig"].get("samples", {})
            if tile_id == rig_samples.get("handFaceTileId"):
                # Burn the draw so the seeded stream stays aligned with the
                # placement reference; only this one face differs.
                rng.choice(FACE_IDS)
                return rig_samples["handFace"]
        return rng.choice(FACE_IDS)

    seat_name = {"bottom": "south", "right": "east", "top": "north", "left": "west"}
    half_plate_x = dimensions["width"] / 2 - face_inset
    half_plate_y = dimensions["height"] / 2 - face_inset
    half_thickness = thickness / 2
    face_quad = [
        (-half_plate_x, half_plate_y, half_thickness),
        (half_plate_x, half_plate_y, half_thickness),
        (half_plate_x, -half_plate_y, half_thickness),
        (-half_plate_x, -half_plate_y, half_thickness),
    ]
    anchors: list[dict] = []

    def add_anchor(
        name: str,
        zone: str,
        seat: str,
        index_value: str,
        matrix: Matrix,
        face: str | None,
        tile_id: str | None,
        cell: dict,
    ) -> dict:
        empty = bpy.data.objects.new(name, None)
        empty.empty_display_type = "PLAIN_AXES"
        empty.empty_display_size = 0.35
        empty.show_name = True
        anchor_collection.objects.link(empty)
        empty.matrix_world = matrix
        empty["zone"] = zone
        empty["seat"] = seat_name[seat]
        empty["index"] = index_value
        empty["tileId"] = tile_id or ""
        empty["tileFace"] = face or ""
        empty["occupied"] = tile_id is not None
        empty["faceQuadLocal"] = [
            round(value, 6) for corner in face_quad for value in corner
        ]
        world_quad = [matrix @ Vector(corner) for corner in face_quad]
        empty["faceQuadWorld"] = [
            round(value, 6) for point in world_quad for value in (point.x, point.y, point.z)
        ]
        empty["faceQuadOrder"] = "TL,TR,BR,BL"
        for key in ("row", "column", "slot", "tier"):
            if key in cell:
                empty[key] = cell[key]
        if cell.get("overflow"):
            empty["overflow"] = True
        record = {
            "name": name,
            "zone": zone,
            "seat": seat_name[seat],
            "index": index_value,
            "tileId": tile_id,
            "tileFace": face,
            "occupied": tile_id is not None,
            "origin": [
                round(matrix.translation.x, 6),
                round(matrix.translation.y, 6),
                round(matrix.translation.z, 6),
            ],
            "rotation": [
                round(matrix[row][column], 9)
                for row in range(3)
                for column in range(3)
            ],
            "faceQuadLocal": [
                [round(value, 6) for value in corner] for corner in face_quad
            ],
            "faceQuadWorld": [
                [round(point.x, 6), round(point.y, 6), round(point.z, 6)]
                for point in world_quad
            ],
            "faceQuadOrder": "TL,TR,BR,BL",
            "cell": cell,
        }
        anchors.append(record)
        return record

    def body_matrix(
        seat: str,
        local_x: float,
        local_y: float,
        local_z: float,
        rot_x_deg: float,
        rot_z_deg: float,
        tilt_deg: float = 0.0,
        pivot_y: float | None = None,
    ) -> Matrix:
        """Seat-local body-centre placement.

        A non-zero ``tilt_deg`` reclines the tile backward about its far bottom
        edge at seat z = 0, so the top leans away from its player and the edge
        stays on the table. ``pivot_y`` is the seat-local y of that edge.
        """
        seat_rot = Matrix.Rotation(math.radians(seat_angle[seat]), 4, "Z")
        local = (
            Matrix.Translation(Vector((local_x, local_y, local_z)))
            @ Matrix.Rotation(math.radians(rot_z_deg), 4, "Z")
            @ Matrix.Rotation(math.radians(rot_x_deg), 4, "X")
        )
        if tilt_deg:
            pivot = Vector((local_x, pivot_y if pivot_y is not None else local_y, 0.0))
            local = (
                Matrix.Translation(pivot)
                @ Matrix.Rotation(math.radians(-tilt_deg), 4, "X")
                @ Matrix.Translation(-pivot)
                @ local
            )
        return seat_rot @ local

    def place(
        tile_id: str,
        zone: str,
        kind: str,
        seat: str,
        pose: str,
        local_x: float,
        local_y: float,
        local_z: float,
        rot_x_deg: float,
        rot_z_deg: float,
        cell: dict,
        face: str | None,
        anchor_name: str,
        anchor_index: str,
        anchor_zone: str,
        tilt_deg: float = 0.0,
        pivot_y: float | None = None,
    ) -> dict:
        centre_matrix = body_matrix(
            seat,
            local_x,
            local_y,
            local_z,
            rot_x_deg,
            rot_z_deg,
            tilt_deg,
            pivot_y,
        )
        object_matrix = centre_matrix @ Matrix.Translation(Vector((0.0, 0.0, -half_thickness)))
        body = template.copy()
        body.data = template.data
        body.name = tile_id
        body.hide_render = False
        body.hide_viewport = False
        body.matrix_world = object_matrix
        bpy.context.scene.collection.objects.link(body)
        tile_record = make_tile_record(
            tile_id,
            zone,
            kind,
            seat,
            face,
            pose,
            object_matrix.translation,
            object_matrix.to_3x3(),
            dimensions,
            cell,
        )
        tiles.append(tile_record)
        add_anchor(anchor_name, anchor_zone, seat, anchor_index, centre_matrix, face, tile_id, cell)

        if face is not None and pose in ("lying-faceup", "standing"):
            if face == "5z":
                log_line = f"skip decal for {tile_id}: 5z has zero ink"
                decals.append({"tile": tile_id, "face": face, "line": log_line})
            else:
                if face not in materials:
                    materials[face] = build_face_material(face)
                decal = build_decal_plane(inner, materials[face])
                decal.matrix_world = (
                    object_matrix @ Matrix.Translation(Vector((0.0, 0.0, thickness + 0.0006)))
                )
                decal.name = f"{tile_id}-decal"
                decals.append({"tile": tile_id, "face": face})
        return tile_record

    seats = spec["table"]["seats"]
    wall = spec["table"]["wall"]
    pond = spec["table"]["pond"]
    hand = spec["table"]["hand"]
    meld = spec["table"]["meld"]
    gap = spec["table"]["clearanceUnits"]
    tilt = hand["tiltDeg"]

    for seat in seats:
        seat_id = seat["id"]
        short = seat_name[seat_id]

        # Four wall runs: 17 stacks x 2 tiers. The west run has the 7-stack
        # dead wall with a small break; every run has a one-tile draw end at
        # slot 16; the dead wall's dora indicator is face-up on the top tier.
        dead = wall["deadWall"]
        for slot in range(wall["stacksPerRun"]):
            x = (slot - (wall["stacksPerRun"] - 1) / 2) * wall["stackPitchUnits"]
            if seat_id == dead["seat"] and slot > dead["breakAfterSlot"]:
                x += dead["breakGapUnits"]
            for tier in range(wall["tiers"]):
                cell = {"slot": slot, "tier": tier}
                anchor_name = f"wall_{short}_{slot:02d}_{tier}"
                anchor_index = f"{slot:02d}_{tier}"
                if slot == wall["drawEndSlot"] and tier >= wall["drawEndTiers"]:
                    cell["drawn"] = True
                    matrix = body_matrix(
                        seat_id,
                        x,
                        -wall["radiusUnits"],
                        thickness / 2 + tier * wall["tierStepUnits"],
                        180.0,
                        0.0,
                    )
                    add_anchor(
                        anchor_name, "wall", seat_id, anchor_index,
                        matrix, None, None, cell,
                    )
                    continue
                is_dora = (
                    seat_id == dead["seat"]
                    and slot == dead["doraSlot"]
                    and tier == dead["doraTier"]
                )
                if is_dora:
                    cell["dora"] = True
                face = dead["doraFace"] if is_dora else None
                tile_id = f"wall-{seat_id}-slot-{slot:02d}-t{tier}"
                place(
                    tile_id,
                    f"wall-{seat_id}",
                    "wall",
                    seat_id,
                    "lying-faceup" if is_dora else "lying-facedown",
                    x,
                    -wall["radiusUnits"],
                    thickness / 2 + tier * wall["tierStepUnits"],
                    0.0 if is_dora else 180.0,
                    0.0,
                    cell,
                    face,
                    anchor_name,
                    anchor_index,
                    "wall",
                )
                index["wall"].setdefault(f"wall-{seat_id}", []).append(tile_id)

        # Pond: 3 filled rows of 6, with one riichi discard turned 90 degrees
        # to the declaring player's right. It is the last tile of row 1; a
        # turned tile is one unit long along the row, so it is placed after
        # the previous tile's face with the normal gap.
        riichi = pond["riichi"]
        if riichi["column"] != pond["columns"] - 1:
            die("the riichi discard must be the last column of its pond row")
        for row in range(pond["rows"]):
            for column in range(pond["columns"]):
                tile_id = f"pond-{seat_id}-{row}{column}"
                cell = {"row": row, "column": column}
                x = (column - (pond["columns"] - 1) / 2) * pond["columnPitchUnits"]
                y = -pond["rowRadiiUnits"][row]
                rot_z = 0.0
                if row == riichi["row"] and column == riichi["column"]:
                    previous_right = (
                        (column - 1 - (pond["columns"] - 1) / 2) * pond["columnPitchUnits"]
                        + dimensions["width"] / 2
                    )
                    x = previous_right + gap + dimensions["height"] / 2
                    y = -(pond["rowRadiiUnits"][row] + (dimensions["height"] - dimensions["width"]) / 2)
                    rot_z = riichi["turnDeg"]
                    cell["riichi"] = True
                    cell["turned"] = True
                face = next_face(tile_id)
                place(
                    tile_id,
                    f"pond-{seat_id}",
                    "pond",
                    seat_id,
                    "lying-faceup",
                    x,
                    y,
                    thickness / 2,
                    0.0,
                    rot_z,
                    cell,
                    face,
                    f"river_{short}_{row}_{column}",
                    f"{row}_{column}",
                    "river",
                )
                index["pond"].setdefault(f"pond-{seat_id}", []).append(tile_id)

        # Overflow anchors extend the third (nearest) row at columns 6..9. Rows
        # fill from the far side, so row 0 is the third row a player reaches;
        # the standard six-three arrangement extends that row rather than the
        # far first row. They are anchors only in this reference.
        overflow_row = pond["overflowRow"]
        for column in range(
            pond["columns"],
            pond["columns"] + spec["anchors"]["riverOverflowColumns"],
        ):
            matrix = body_matrix(
                seat_id,
                (column - (pond["columns"] - 1) / 2) * pond["columnPitchUnits"],
                -pond["rowRadiiUnits"][overflow_row],
                thickness / 2,
                0.0,
                0.0,
            )
            add_anchor(
                f"river_{short}_{overflow_row}_{column}",
                "river",
                seat_id,
                f"{overflow_row}_{column}",
                matrix,
                None,
                None,
                {"row": overflow_row, "column": column, "overflow": True},
            )

        # Concealed hand: 13 standing tiles, reclined 12 degrees backward.
        # A seat may sit farther back than the shared radius (v3 moves only the
        # player's hand back), stored as backRadiusUnitsBySeat[seat].
        seat_hand_radius = hand.get("backRadiusUnitsBySeat", {}).get(
            seat_id, hand["backRadiusUnits"]
        )
        for slot in range(hand["count"]):
            tile_id = f"hand-{seat_id}-{slot:02d}"
            face = next_face(tile_id) if seat_id == "bottom" else None
            place(
                tile_id,
                f"hand-{seat_id}",
                "hand",
                seat_id,
                "standing" if face is not None else "standing-back",
                (slot - (hand["count"] - 1) / 2) * hand["pitchUnits"],
                -seat_hand_radius - thickness / 2,
                0.5,
                90.0,
                0.0,
                {"slot": slot},
                face,
                f"hand_{short}_{slot:02d}",
                f"{slot:02d}",
                "hand",
                tilt if seat_id == "bottom" else 0.0,
                -seat_hand_radius,
            )
            index["hand"].setdefault(f"hand-{seat_id}", []).append(tile_id)

        # Open meld row outside the wall, on the edge to the player's right.
        cursor = meld["startXUnits"]
        widths = [meld["uprightWidthUnits"]] * meld["uprightTiles"] + [
            meld["calledWidthUnits"]
        ] * meld["calledTiles"]
        for column, width in enumerate(widths):
            tile_id = f"meld-{seat_id}-{column}"
            x = cursor + width / 2
            cursor += width
            face = next_face(tile_id)
            turned = column >= meld["uprightTiles"]
            y = -meld["rowRadiusUnits"]
            if turned:
                # The called tile lies sideways (0.75 units deep) and must keep
                # its near edge flush with the upright tiles' bottom edge, the
                # same near-edge alignment as the riichi discard.
                y = -(
                    meld["rowRadiusUnits"]
                    + (dimensions["height"] - dimensions["width"]) / 2
                )
            place(
                tile_id,
                f"meld-{seat_id}",
                "meld",
                seat_id,
                "lying-faceup",
                x,
                y,
                thickness / 2,
                0.0,
                90.0 if turned else 0.0,
                {"column": column, "turned": turned},
                face,
                f"meld_{short}_{column}",
                f"{column}",
                "meld",
            )
            index["meld"].setdefault(f"meld-{seat_id}", []).append(tile_id)

        # Kan extension slot after the modelled pon (anchor only).
        for column in range(len(widths), meld["slots"]):
            width = meld["uprightWidthUnits"]
            x = cursor + width / 2
            cursor += width
            matrix = body_matrix(
                seat_id,
                x,
                -meld["rowRadiusUnits"],
                thickness / 2,
                0.0,
                0.0,
            )
            add_anchor(
                f"meld_{short}_{column}",
                "meld",
                seat_id,
                f"{column}",
                matrix,
                None,
                None,
                {"column": column, "turned": False},
            )

    # The human's drawn tile, after the 13th tile's +0.35 advance gap.
    drawn_id = "hand-bottom-draw"
    bottom_hand_radius = hand.get("backRadiusUnitsBySeat", {}).get(
        "bottom", hand["backRadiusUnits"]
    )
    place(
        drawn_id,
        "hand-bottom",
        "drawn",
        "bottom",
        "standing",
        hand["drawnOffsetUnits"],
        -bottom_hand_radius - thickness / 2,
        0.5,
        90.0,
        0.0,
        {"slot": "draw"},
        next_face(drawn_id),
        "hand_south_13",
        "13",
        "hand",
        tilt,
        -bottom_hand_radius,
    )
    index["drawn"]["drawn"] = [drawn_id]

    # Link the decal records to their render state (nothing else to place).
    for record in decals:
        if "line" in record:
            log(record["line"])

    names = [record["name"] for record in anchors]
    if len(set(names)) != len(names):
        die("duplicate slot anchor names")
    counted: dict[str, int] = {}
    for record in anchors:
        counted[record["zone"]] = counted.get(record["zone"], 0) + 1
    expected = spec["anchors"]["counts"]
    for zone in ("wall", "river", "meld", "hand"):
        if counted.get(zone, 0) != expected[zone]:
            die(f"slot anchor count for {zone}: {counted.get(zone, 0)} != {expected[zone]}")
    if len(anchors) != expected["total"]:
        die(f"slot anchor total: {len(anchors)} != {expected['total']}")
    occupied_expected = spec["anchors"]["occupied"]
    occupied: dict[str, int] = {}
    for record in anchors:
        if record["occupied"]:
            occupied[record["zone"]] = occupied.get(record["zone"], 0) + 1
    for zone in ("wall", "river", "meld", "hand"):
        if occupied.get(zone, 0) != occupied_expected[zone]:
            die(f"occupied {zone} anchors: {occupied.get(zone, 0)} != {occupied_expected[zone]}")
    empty_count = sum(1 for record in anchors if not record["occupied"])
    if empty_count != spec["anchors"]["empty"]["total"]:
        die(f"empty anchors: {empty_count} != {spec['anchors']['empty']['total']}")
    if len(anchor_collection.objects) != len(anchors):
        die(
            f"SlotAnchors collection has {len(anchor_collection.objects)} Empties, "
            f"expected {len(anchors)}"
        )
    for record in anchors:
        if record["name"] not in anchor_collection.objects:
            die(f"missing SlotAnchors Empty {record['name']}")
    log(
        f"anchors: {counted} ({occupied} occupied, {empty_count} empty) in "
        f"'{anchor_collection.name}' ({len(anchor_collection.objects)} Empties)"
    )

    hand_lighting_cheat = apply_hand_lighting_cheat(spec, spec["rig"]) if rig_mode else None
    hand_shadow_cheat = apply_hand_shadow_cheat(spec, spec["rig"], tiles) if rig_mode else None

    clearance = measure_clearance(tiles, spec)
    return scene, {
        "tiles": tiles,
        "index": index,
        "dimensions": dimensions,
        "inner": inner,
        "decals": [{"tile": record["tile"], "face": record["face"]} for record in decals],
        "anchors": anchors,
        "anchorCounts": counted,
        "anchorCollection": anchor_collection.name,
        "clearance": clearance,
        "rigLighting": rig_lighting,
        "handLightingCheat": hand_lighting_cheat,
        "handShadowCheat": hand_shadow_cheat,
        "floorHidden": bool(rig_mode and spec["rig"]["render"]["hideFloor"]),
        "props": {
            "mat": spec["table"]["playingMat"],
            "rim": spec["table"]["rim"],
            "floor": spec["table"]["floor"],
            "compassWell": spec["table"]["compassWell"],
        },
    }, shell_spec


# --------------------------------------------------------------------------- #
# Measurement
# --------------------------------------------------------------------------- #


def zone_bounds(camera: dict, tiles: list[dict], zone: str) -> dict:
    left = top = math.inf
    right = bottom = -math.inf
    for tile in tiles:
        if tile["zone"] != zone:
            continue
        for corner in tile_box_corners(tile):
            u, v = project_point(camera, corner)
            left = min(left, u)
            top = min(top, v)
            right = max(right, u)
            bottom = max(bottom, v)
    if not math.isfinite(left):
        die(f"zone {zone} has no tiles")
    return {"left": left, "top": top, "right": right, "bottom": bottom}


def line_angle_error(angle_deg: float, expected_deg: float) -> float:
    """Smallest deviation of a line's direction from an expected axis (0..90)."""
    value = angle_deg % 180.0
    delta = abs(value - expected_deg)
    return min(delta, 180.0 - delta)


def projected_run(camera: dict, radius: float, seat_deg: float, half_span: float, vertical: bool) -> tuple[float, float]:
    rotation = Matrix.Rotation(math.radians(seat_deg), 3, "Z")
    if vertical:
        a_local = Vector((radius, -half_span, 0.0))
        b_local = Vector((radius, half_span, 0.0))
    else:
        a_local = Vector((-half_span, -radius, 0.0))
        b_local = Vector((half_span, -radius, 0.0))
    a = rotation @ a_local
    b = rotation @ b_local
    return project_point(camera, a), project_point(camera, b)


def rim_frame_metrics(camera: dict, spec: dict) -> dict:
    """Projected bounds of the table surface props against the frame."""
    width, height = camera["resolution"]
    mat_half = spec["table"]["playingMat"]["sizeUnits"] / 2
    rim = spec["table"]["rim"]
    points = []
    for half, top in (
        (mat_half, 0.0),
        (rim["innerHalfUnits"] + rim["widthUnits"], 0.0),
        (rim["innerHalfUnits"] + rim["widthUnits"], rim["heightUnits"]),
    ):
        for x in (-half, half):
            for y in (-half, half):
                points.append((x, y, top))
    projected = [project_point(camera, point) for point in points]
    left = min(point[0] for point in projected)
    top = min(point[1] for point in projected)
    right = max(point[0] for point in projected)
    bottom = max(point[1] for point in projected)
    return {
        "matHalfUnits": round(mat_half, 6),
        "rimOuterHalfUnits": rim["innerHalfUnits"] + rim["widthUnits"],
        "boundsPx": {
            "left": round(left, 2),
            "top": round(top, 2),
            "right": round(right, 2),
            "bottom": round(bottom, 2),
        },
        "marginsPx": {
            "left": round(left, 2),
            "top": round(top, 2),
            "right": round(width - right, 2),
            "bottom": round(height - bottom, 2),
        },
    }


def measure(camera: dict, tiles: list[dict], spec: dict) -> dict:
    by_id = {tile["id"]: tile for tile in tiles}
    scale_samples = []
    for seat in ("bottom", "right", "top", "left"):
        centre = by_id[f"pond-{seat}-12"]
        scale_samples.append(tile_size_px(camera, centre))
    scale_spread = max(scale_samples) / min(scale_samples)

    wall = spec["table"]["wall"]
    half_span = wall["stackSpanUnits"] / 2
    front_a, front_b = projected_run(camera, wall["radiusUnits"], 0.0, half_span, False)
    back_a, back_b = projected_run(camera, wall["radiusUnits"], 180.0, half_span, False)
    left_a, left_b = projected_run(camera, wall["radiusUnits"], 270.0, half_span, True)
    right_a, right_b = projected_run(camera, wall["radiusUnits"], 90.0, half_span, True)
    front_length = math.hypot(front_b[0] - front_a[0], front_b[1] - front_a[1])
    back_length = math.hypot(back_b[0] - back_a[0], back_b[1] - back_a[1])
    left_length = math.hypot(left_b[0] - left_a[0], left_b[1] - left_a[1])
    right_length = math.hypot(right_b[0] - right_a[0], right_b[1] - right_a[1])
    ratio = max(front_length, back_length) / min(front_length, back_length)
    side_ratio = max(left_length, right_length) / min(left_length, right_length)

    front_angle = math.degrees(
        math.atan2(front_b[1] - front_a[1], front_b[0] - front_a[0])
    )
    back_angle = math.degrees(
        math.atan2(back_b[1] - back_a[1], back_b[0] - back_a[0])
    )
    left_angle = math.degrees(
        math.atan2(left_b[1] - left_a[1], left_b[0] - left_a[0])
    ) - 90.0
    right_angle = math.degrees(
        math.atan2(right_b[1] - right_a[1], right_b[0] - right_a[0])
    ) + 90.0

    bottom_hand = tile_long_axis_px(camera, by_id["hand-bottom-06"])
    top_hand = tile_long_axis_px(camera, by_id["hand-top-06"])
    eye = Vector(camera["eye"])
    front_ground = abs(eye.y + wall["radiusUnits"])
    reveal = (
        0.0
        if camera["mode"] == "orthographic"
        else math.degrees(math.atan((wall["stackSpanUnits"] / 2) / front_ground))
    )

    all_corners = [corner for tile in tiles for corner in tile_box_corners(tile)]
    projected = [project_point(camera, corner) for corner in all_corners]
    width, height = camera["resolution"]
    left = min(point[0] for point in projected)
    top = min(point[1] for point in projected)
    right = max(point[0] for point in projected)
    bottom = max(point[1] for point in projected)
    margins = {
        "left": left,
        "top": top,
        "right": width - right,
        "bottom": height - bottom,
    }

    return {
        "pondTileSizePx": [round(value, 4) for value in scale_samples],
        "scaleSpread": round(scale_spread, 6),
        "frontRunLengthPx": round(front_length, 3),
        "backRunLengthPx": round(back_length, 3),
        "leftRunLengthPx": round(left_length, 3),
        "rightRunLengthPx": round(right_length, 3),
        "frontBackRunRatio": round(ratio, 6),
        "leftRightRunRatio": round(side_ratio, 6),
        "runAnglesDeg": {
            "front": round(front_angle, 6),
            "back": round(back_angle, 6),
            "left": round(left_angle, 6),
            "right": round(right_angle, 6),
        },
        "runAngleErrorDeg": {
            "front": round(line_angle_error(front_angle, 0.0), 6),
            "back": round(line_angle_error(back_angle, 0.0), 6),
            "left": round(line_angle_error(left_angle, 90.0), 6),
            "right": round(line_angle_error(right_angle, 90.0), 6),
        },
        "bottomTopHandRatio": round(bottom_hand / top_hand, 6),
        "frontOuterRevealDeg": round(reveal, 4),
        "tableBoundsPx": {
            "left": round(left, 2),
            "top": round(top, 2),
            "right": round(right, 2),
            "bottom": round(bottom, 2),
        },
        "frameMarginsPx": {key: round(value, 2) for key, value in margins.items()},
        "minFrameMarginPx": round(min(margins.values()), 3),
        "rimFrame": rim_frame_metrics(camera, spec),
    }


def crop_zones(spec: dict, tiles: list[dict], index: dict, camera2x: dict) -> tuple[dict, dict]:
    """2x crop rectangles per element family, from projected tile bounds."""
    margin = spec["renders"]["cropMarginPx2x"]
    width, height = spec["camera"]["output"]["resolution2x"]
    plan = {
        "wall-front": ("wall", "bottom"),
        "wall-back": ("wall", "top"),
        "wall-left": ("wall", "left"),
        "wall-right": ("wall", "right"),
        "pond-bottom": ("pond", "bottom"),
        "pond-right": ("pond", "right"),
        "pond-top": ("pond", "top"),
        "pond-left": ("pond", "left"),
        "hand-bottom": ("hand", "bottom"),
        "hand-top": ("hand", "top"),
        "hand-left": ("hand", "left"),
        "hand-right": ("hand", "right"),
        "meld-bottom": ("meld", "bottom"),
        "meld-right": ("meld", "right"),
        "meld-top": ("meld", "top"),
        "meld-left": ("meld", "left"),
        "drawn-tile": ("drawn", "bottom"),
    }
    families = {entry["id"]: entry for entry in spec["renders"]["cropFamilies"]}
    if set(families) != set(plan):
        die(
            "renders.cropFamilies does not match the crop plan: "
            f"{sorted(set(families) ^ set(plan))}"
        )
    rects = {}
    for family_id, (kind, seat) in plan.items():
        if kind == "drawn":
            ids = index["drawn"]["drawn"]
        else:
            ids = index[kind][f"{kind}-{seat}"]
        zone_tiles = [tile for tile in tiles if tile["id"] in set(ids)]
        bounds = {
            "left": min(project_point(camera2x, corner)[0] for tile in zone_tiles for corner in tile_box_corners(tile)),
            "top": min(project_point(camera2x, corner)[1] for tile in zone_tiles for corner in tile_box_corners(tile)),
            "right": max(project_point(camera2x, corner)[0] for tile in zone_tiles for corner in tile_box_corners(tile)),
            "bottom": max(project_point(camera2x, corner)[1] for tile in zone_tiles for corner in tile_box_corners(tile)),
        }
        rect = {
            "x": max(0, int(math.floor(bounds["left"])) - margin),
            "y": max(0, int(math.floor(bounds["top"])) - margin),
        }
        rect["width"] = min(width - rect["x"], int(math.ceil(bounds["right"])) + margin - rect["x"])
        rect["height"] = min(height - rect["y"], int(math.ceil(bounds["bottom"])) + margin - rect["y"])
        rects[family_id] = {
            "family": families[family_id]["kind"],
            "seat": seat,
            "tiles": ids,
            "rect2x": rect,
        }
    return rects, plan


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def visible_point_local(tile: dict) -> tuple[float, float, float]:
    """A point on the surface the reference camera should see, in tile-local units."""
    thickness = tile["dimensions"]["thickness"]
    if tile["pose"] == "lying-faceup":
        return (0.0, 0.0, thickness)
    if tile["pose"] == "lying-facedown":
        # rotX 180 puts the painted face on the table and the blue back on top,
        # so local z 0 is the visible surface.
        return (0.0, 0.0, 0.0005)
    if tile["pose"] == "standing":
        return (0.0, 0.0, thickness)
    return (0.0, 0.0, 0.0005)


def check_visibility(scene: bpy.types.Scene, camera: dict, tiles: list[dict]) -> dict:
    """Ray-cast the visible surface of every tile; nothing may occlude it.

    A two-tier wall legitimately hides its own lower tier, so tier 0 is the one
    exception. Every pond, meld, hand, drawn tile and upper wall tier must be
    hit by its own body or face decal first. This is the numeric guard against
    the camera elevation letting the wall swallow the near pond row.
    """
    depsgraph = bpy.context.evaluated_depsgraph_get()
    eye = Vector(camera["eye"])
    samples = 0
    occluded = []
    for tile in tiles:
        if tile["kind"] == "wall" and tile["cell"].get("tier") == 0:
            continue
        if tile["kind"] == "hand" and tile["seat"] in ("right", "left"):
            # The side hands run directly away from the camera, so the near
            # tile legitimately hides the next tile's back. The row silhouette
            # is the visible evidence; only south/north hands need a face probe.
            continue
        width = tile["dimensions"]["width"]
        height = tile["dimensions"]["height"]
        local_z = visible_point_local(tile)[2]
        probes = [(0.0, 0.0)]
        if tile["pose"] not in ("standing", "standing-back"):
            # A packed, reclined hand row legitimately hides its neighbours'
            # side slivers, so hands only require their visible centre; every
            # lying tile (walls, rivers, melds) requires its whole face.
            for x in (-0.2, 0.2):
                for y in (-0.2, 0.2):
                    probes.append((x * width, y * height))
        rotation = np.array(tile["rotation"], dtype=float).reshape(3, 3)
        origin = Vector(tile["origin"])
        for x, y in probes:
            point = origin + Vector(rotation @ np.array(Vector((x, y, local_z))))
            direction = (point - eye).normalized()
            # Skip camera-invisible helpers (the hand's shadow-only casters):
            # they exist for shadow rays, not for the rendered image.
            start = eye
            hit_object = None
            for _ in range(6):
                hit, location, normal, index, candidate, matrix = scene.ray_cast(
                    depsgraph, start, direction
                )
                if not hit:
                    break
                if getattr(candidate, "visible_camera", True) and not candidate.hide_render:
                    hit_object = candidate
                    break
                start = location + direction * 1e-4
            samples += 1
            if not hit:
                occluded.append({"tile": tile["id"], "hit": None})
                continue
            if hit_object is None:
                occluded.append({"tile": tile["id"], "hit": None})
                continue
            allowed = {tile["id"], f"{tile['id']}-decal"}
            if hit_object.name not in allowed:
                occluded.append({"tile": tile["id"], "hit": hit_object.name})
    return {"samples": samples, "occluded": len(occluded), "details": occluded[:40]}


def lighting_samples(camera: dict, tiles: list[dict], spec: dict) -> dict:
    """Pixel positions where the checker samples the reference lighting.

    The 5z (haku) tile has zero ink, so its bare face plate is the white
    sample; the top tier of a face-down wall tile is the blue backing sample.
    """
    by_id = {tile["id"]: tile for tile in tiles}
    thickness = by_id[spec["faces"]["sampleTileId"]]["dimensions"]["thickness"]
    face_tile = by_id[spec["faces"]["sampleTileId"]]
    blue_tile = by_id["wall-bottom-slot-08-t1"]
    records = {}
    for name, tile, local_z in (
        ("face", face_tile, thickness),
        ("blue", blue_tile, 0.001),
    ):
        rotation = np.array(tile["rotation"], dtype=float).reshape(3, 3)
        origin = Vector(tile["origin"])
        point = origin + Vector(rotation @ np.array(Vector((0.0, 0.0, local_z))))
        u, v = project_point(camera, point)
        records[name] = {
            "tile": tile["id"],
            "localPoint": [0.0, 0.0, round(local_z, 6)],
            "pixel1x": [round(u, 3), round(v, 3)],
            "sampleRadiusPx1x": 3,
        }
    records["face"]["shell"] = "shell_flat_upright"
    records["blue"]["shell"] = "shell_wall_horizontal"
    records["face"]["face"] = spec["faces"]["sampleFace"]
    return records


def main() -> None:
    argv = blender_args()
    options = parse_options(argv)
    spec = read_json(SPEC_PATH)
    out_dir = options["out"] or (RENDER_DIR / "build" / "reference")
    out_dir.mkdir(parents=True, exist_ok=True)

    camera_name = options["camera"] or spec["camera"]["chosen"]
    if camera_name not in spec["camera"]["candidates"]:
        die(f"unknown camera candidate {camera_name}")
    candidate = spec["camera"]["candidates"][camera_name]

    variant_id = None
    variant = None
    scene_spec = spec
    if options["rig"]:
        variant_id, variant, scene_spec = resolve_variant(spec, options["variant"])
        log(f"rig variant: {variant_id} — {variant.get('label', '')}")

    scene, scene_data, shell_spec = build_scene(scene_spec, options)

    if options["rig"]:
        rig = scene_spec["rig"]
        resolution = list(rig["output"]["resolution"])
        if options["rigWidth"]:
            resolution = [
                options["rigWidth"],
                round(options["rigWidth"] * rig["output"]["resolution"][1] / rig["output"]["resolution"][0]),
            ]
        camera = camera_from_candidate(rig["camera"], resolution)
        scene.render.resolution_x = resolution[0]
        scene.render.resolution_y = resolution[1]
        build_camera_object(scene, camera)
        sample_points = [tile_box_corners(tile)[0] for tile in scene_data["tiles"][::23]]
        delta = verify_projection(scene, camera, sample_points)
        if delta > 0.01:
            die(f"rig pinhole projection drifts from Blender by {delta:.4f} px")
        log(f"rig projection: pinhole matches Blender within {delta:.6f} px")

        visibility = check_visibility(scene, camera, scene_data["tiles"])
        if visibility["occluded"]:
            die(
                f"rig: {visibility['occluded']} of {visibility['samples']} visible-surface "
                f"probes are occluded: {visibility['details'][:6]}"
            )
        log(f"rig visibility: {visibility['samples']} probes, 0 occluded")

        rig_dir = out_dir / rig["output"]["bakeDirectory"].format(variant=variant_id)
        rig_dir.mkdir(parents=True, exist_ok=True)
        bake = {
            "version": 1,
            "generatedBy": "tools/render/bake_table_reference.py",
            "mode": "rig",
            "rig": rig["id"],
            "variant": variant_id,
            "variantLabel": variant.get("label"),
            "variantNote": variant.get("note"),
            "variantDate": variant.get("date"),
            "strictScene": bool(variant.get("strictScene", False)),
            "variantExtends": variant.get("extends"),
            "blender": bpy.app.version_string,
            "resolution": resolution,
            "camera": camera,
            "projectionDeltaPx": round(delta, 6),
            "visibility": visibility,
            "render": {
                "engine": bpy.context.scene.render.engine,
                "device": scene.cycles.device,
                "samples": scene.cycles.samples,
                "adaptiveSampling": scene.cycles.use_adaptive_sampling,
                "adaptiveThreshold": round(scene.cycles.adaptive_threshold, 6),
                "denoise": scene.cycles.use_denoising,
                "denoiser": scene.cycles.denoiser,
                "filmTransparent": scene.render.film_transparent,
                "colorMode": scene.render.image_settings.color_mode,
                "floorHidden": scene_data["floorHidden"],
                "look": scene.view_settings.look,
                "viewTransform": scene.view_settings.view_transform,
            },
            "scene": {
                "dimensions": scene_data["dimensions"],
                "innerFacePlate": scene_data["inner"],
                "tiles": scene_data["tiles"],
            },
            "lighting": scene_data["rigLighting"],
            "handLightingCheat": scene_data["handLightingCheat"],
            "handShadowCheat": scene_data["handShadowCheat"],
        }
        bake_path = rig_dir / rig["output"]["bakeFile"]
        bake_path.write_text(json.dumps(bake, indent=1))
        log(f"rig bake: {bake_path}")
        log(
            "rig camera: "
            f"{camera['mode']} {camera['lensMm']:.1f} mm, {camera['distanceUnits']:.3f} units, "
            f"pitch {camera['elevationDeg']:.1f} deg, shift {camera['shiftX']:.3f}/{camera['shiftY']:.3f}, "
            f"eye {[round(value, 3) for value in camera['eye']]}"
        )

        if options["dryRun"]:
            log("rig dry run: nothing rendered")
            return
        path = rig_dir / rig["output"]["renderPattern"].format(width=resolution[0])
        render_pass(scene, path)
        log(f"rig render: {path} ({resolution[0]}x{resolution[1]})")
        return

    resolution1x = spec["camera"]["output"]["resolution1x"]
    resolution2x = spec["camera"]["output"]["resolution2x"]
    camera1x = camera_from_candidate(candidate, resolution1x)
    camera2x = camera_from_candidate(candidate, resolution2x)

    scene.render.resolution_x = resolution2x[0]
    scene.render.resolution_y = resolution2x[1]
    build_camera_object(scene, camera2x)
    sample_points = [
        tile_box_corners(tile)[0] for tile in scene_data["tiles"][::23]
    ]
    delta = verify_projection(scene, camera2x, sample_points)
    if delta > 0.01:
        die(f"pinhole projection drifts from Blender by {delta:.4f} px")
    log(f"projection: pinhole matches Blender within {delta:.6f} px")

    visibility = check_visibility(scene, camera2x, scene_data["tiles"])
    if visibility["occluded"]:
        die(
            f"{visibility['occluded']} of {visibility['samples']} visible-surface probes "
            f"are occluded: {visibility['details'][:6]}"
        )
    log(f"visibility: {visibility['samples']} probes, 0 occluded")

    metrics = measure(camera1x, scene_data["tiles"], spec)

    rects, _ = crop_zones(spec, scene_data["tiles"], scene_data["index"], camera2x)

    geometry = {
        "version": 1,
        "generatedBy": "tools/render/bake_table_reference.py",
        "blender": bpy.app.version_string,
        "cameraCandidate": camera_name,
        "camera": {**camera2x, "shiftX": camera2x["shiftX"], "shiftY": camera2x["shiftY"]},
        "camera1x": camera1x,
        "resolution1x": resolution1x,
        "resolution2x": resolution2x,
        "projectionDeltaPx": round(delta, 6),
        "visibility": visibility,
        "scene": {
            "dimensions": scene_data["dimensions"],
            "innerFacePlate": scene_data["inner"],
            "tiles": scene_data["tiles"],
        },
        "zones": {
            zone: zone_bounds(camera2x, scene_data["tiles"], zone)
            for zone in sorted({tile["zone"] for tile in scene_data["tiles"]})
        },
        "crops": rects,
        "metrics": metrics,
        "lightingSamples": lighting_samples(camera1x, scene_data["tiles"], spec),
        "anchors": scene_data["anchors"],
        "anchorCounts": scene_data["anchorCounts"],
        "anchorCollection": scene_data["anchorCollection"],
        "clearance": scene_data["clearance"],
        "tableProps": scene_data["props"],
    }

    log("camera: " + ", ".join(
        f"{key} {value}" if not isinstance(value, list) else f"{key} {value}"
        for key, value in {
            "mode": camera2x["mode"],
            "eye": [round(v, 3) for v in camera2x["eye"]],
            "lensMm": camera2x.get("lensMm"),
            "elevationDeg": camera2x["elevationDeg"],
            "pixelsPerUnitAtTarget": round(camera2x.get("pixelsPerUnitAtTarget", 0.0), 3),
        }.items()
    ))
    for key in (
        "pondTileSizePx",
        "scaleSpread",
        "frontBackRunRatio",
        "leftRightRunRatio",
        "runAngleErrorDeg",
        "bottomTopHandRatio",
        "frontOuterRevealDeg",
        "minFrameMarginPx",
    ):
        log(f"metric {key}: {metrics[key]}")

    (out_dir / "geometry.json").write_text(json.dumps(geometry, indent=1))

    if options["dryRun"]:
        log("dry run: nothing rendered")
        return

    if options["preview"]:
        width = options.get("previewWidth") or resolution1x[0]
        height = round(width * resolution1x[1] / resolution1x[0])
        scene.render.resolution_x = width
        scene.render.resolution_y = height
        preview_camera = camera_from_candidate(candidate, [width, height])
        build_camera_object(scene, preview_camera)
        path = out_dir / ("preview-1x.png" if width == resolution1x[0] else f"preview-{width}px.png")
        render_pass(scene, path)
        log(f"preview: {path}")
        return

    if options["audition"]:
        audition_dir = out_dir / "audition"
        audition_dir.mkdir(parents=True, exist_ok=True)
        records = {}
        original_samples = scene.cycles.samples
        scene.cycles.samples = min(original_samples, 24)
        audition_resolution = [1440, 900]
        scene.render.resolution_x = audition_resolution[0]
        scene.render.resolution_y = audition_resolution[1]
        for name, entry in spec["camera"]["candidates"].items():
            cam1x = camera_from_candidate(entry, resolution1x)
            audition_camera = camera_from_candidate(entry, audition_resolution)
            build_camera_object(scene, audition_camera)
            path = audition_dir / f"{name}-1440.png"
            render_pass(scene, path)
            candidate_metrics = measure(cam1x, scene_data["tiles"], spec)
            candidate_visibility = check_visibility(scene, cam1x, scene_data["tiles"])
            records[name] = {
                "path": str(path),
                "resolution": audition_resolution,
                "metrics": candidate_metrics,
                "visibility": candidate_visibility,
            }
            log(f"audition {name}: {path} ({audition_resolution[0]}x{audition_resolution[1]})")
            log(
                f"  {name} visibility: {candidate_visibility['samples']} probes, "
                f"{candidate_visibility['occluded']} occluded"
            )
            for key in ("scaleSpread", "frontBackRunRatio", "bottomTopHandRatio", "frontOuterRevealDeg", "minFrameMarginPx"):
                log(f"  {name} {key}: {candidate_metrics[key]}")
        (audition_dir / "cameras.json").write_text(json.dumps(records, indent=1))
        scene.cycles.samples = original_samples
        return

    scene.render.resolution_x = resolution2x[0]
    scene.render.resolution_y = resolution2x[1]
    build_camera_object(scene, camera2x)
    master = out_dir / "master-2x.png"
    render_pass(scene, master)
    log(f"master: {master}")


def blender_args() -> list[str]:
    if "--" in sys.argv:
        return sys.argv[sys.argv.index("--") + 1 :]
    return []


if __name__ == "__main__":
    main()
