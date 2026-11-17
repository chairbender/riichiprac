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


def parse_options(argv: list[str]) -> dict:
    options = {
        "dryRun": False,
        "bake": False,
        "audition": False,
        "preview": False,
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
        elif arg == "--preview-width":
            options["previewWidth"] = int(argv[index + 1])
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
        offset_y = camera["shiftY"] * height
        return (
            width / 2 + offset_x + value.dot(right) / scale,
            height / 2 - offset_y - value.dot(up) / scale,
        )
    if depth <= 0:
        raise ValueError(f"point behind the camera: {point}")
    focal = camera["focalPixels"]
    return (
        width / 2 + camera["shiftX"] * width + focal * value.dot(right) / depth,
        height / 2 - camera["shiftY"] * height - focal * value.dot(up) / depth,
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


def build_felt(scene: bpy.types.Scene, spec: dict) -> bpy.types.Object:
    import bmesh

    felt = spec["table"]["felt"]
    half = felt["halfExtentUnits"]
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=half)
    mesh = bpy.data.meshes.new("felt")
    bm.to_mesh(mesh)
    bm.free()
    material = new_material("felt")
    node = principled(material)
    node.inputs["Base Color"].default_value = hex_linear(felt["baseColorHex"])
    node.inputs["Roughness"].default_value = felt["roughness"]
    node.inputs["Specular IOR Level"].default_value = 0.15
    mesh.materials.append(material)
    obj = new_object("felt", mesh)
    return obj


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


def build_scene(spec: dict, options: dict) -> tuple[bpy.types.Scene, dict, dict]:
    shell_spec = read_json(SHELL_SPEC_PATH)
    check_blender_version(shell_spec)
    scene = reset_scene()
    resolve_tile_dimensions(shell_spec)
    configure_render(scene, shell_spec)
    scene.cycles.samples = (
        options["samples"] if options["samples"] is not None else spec["scene"]["samples"]
    )
    log(f"reference render: {scene.cycles.samples} samples, film transparent {spec['scene']['filmTransparent']}")
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.render.film_transparent = spec["scene"]["filmTransparent"]
    scene.render.image_settings.color_mode = "RGB"
    scene.view_settings.look = spec["scene"]["colorManagement"]["look"]

    build_felt(scene, spec)
    build_reference_lights(scene, spec)

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
        return rng.choice(FACE_IDS)

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
    ) -> dict:
        seat_rot = Matrix.Rotation(math.radians(seat_angle[seat]), 4, "Z")
        rotation = (
            seat_rot
            @ Matrix.Translation(Vector((local_x, local_y, local_z)))
            @ Matrix.Rotation(math.radians(rot_z_deg), 4, "Z")
            @ Matrix.Rotation(math.radians(rot_x_deg), 4, "X")
        )
        body = template.copy()
        body.data = template.data
        body.name = tile_id
        body.hide_render = False
        body.hide_viewport = False
        body.matrix_world = rotation
        bpy.context.scene.collection.objects.link(body)
        tile_record = make_tile_record(
            tile_id,
            zone,
            kind,
            seat,
            face,
            pose,
            rotation.translation,
            rotation.to_3x3(),
            dimensions,
            cell,
        )
        tiles.append(tile_record)

        if face is not None and pose in ("lying-faceup", "standing"):
            if face == "5z":
                log_line = f"skip decal for {tile_id}: 5z has zero ink"
                decals.append({"tile": tile_id, "face": face, "line": log_line})
            else:
                if face not in materials:
                    materials[face] = build_face_material(face)
                decal = build_decal_plane(inner, materials[face])
                decal.matrix_world = (
                    rotation @ Matrix.Translation(Vector((0.0, 0.0, thickness + 0.0006)))
                )
                decal.name = f"{tile_id}-decal"
                decals.append({"tile": tile_id, "face": face})
        return tile_record

    seats = spec["table"]["seats"]
    wall = spec["table"]["wall"]
    pond = spec["table"]["pond"]
    hand = spec["table"]["hand"]
    meld = spec["table"]["meld"]

    for seat in seats:
        seat_id = seat["id"]
        angle = seat_angle[seat_id]

        # Four wall runs: 17 stacks x 2 tiers, every tile face-down.
        for slot in range(wall["stacksPerRun"]):
            x = (slot - (wall["stacksPerRun"] - 1) / 2) * wall["stackPitchUnits"]
            for tier in range(wall["tiers"]):
                tile_id = f"wall-{seat_id}-slot-{slot:02d}-t{tier}"
                place(
                    tile_id,
                    f"wall-{seat_id}",
                    "wall",
                    seat_id,
                    "lying-facedown",
                    x,
                    -wall["radiusUnits"],
                    thickness * (tier + 1),
                    180.0,
                    0.0,
                    {"slot": slot, "tier": tier},
                    None,
                )
                index["wall"].setdefault(f"wall-{seat_id}", []).append(tile_id)

        # Pond: 3 filled rows of 6.
        for row in range(pond["rows"]):
            for column in range(pond["columns"]):
                tile_id = f"pond-{seat_id}-{row}{column}"
                face = next_face(tile_id)
                place(
                    tile_id,
                    f"pond-{seat_id}",
                    "pond",
                    seat_id,
                    "lying-faceup",
                    (column - (pond["columns"] - 1) / 2) * pond["columnPitchUnits"],
                    -pond["rowRadiiUnits"][row],
                    0.0,
                    0.0,
                    0.0,
                    {"row": row, "column": column},
                    face,
                )
                index["pond"].setdefault(f"pond-{seat_id}", []).append(tile_id)

        # Concealed hand: 13 standing tiles, backs to the table centre.
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
                -hand["backRadiusUnits"],
                0.5,
                90.0,
                0.0,
                {"slot": slot},
                face,
            )
            index["hand"].setdefault(f"hand-{seat_id}", []).append(tile_id)

        # Open pon: two upright + one called sideways.
        cursor = meld["startXUnits"]
        widths = [0.75] * meld["uprightTiles"] + [1.0] * meld["calledTiles"]
        for column, width in enumerate(widths):
            tile_id = f"meld-{seat_id}-{column}"
            x = cursor + width / 2
            cursor += width
            face = next_face(tile_id)
            turned = column >= meld["uprightTiles"]
            place(
                tile_id,
                f"meld-{seat_id}",
                "meld",
                seat_id,
                "lying-faceup",
                x,
                -meld["rowRadiusUnits"],
                0.0,
                0.0,
                90.0 if turned else 0.0,
                {"column": column, "turned": turned},
                face,
            )
            index["meld"].setdefault(f"meld-{seat_id}", []).append(tile_id)

    # The human's drawn tile, after the 13th tile's +0.35 advance gap.
    drawn_id = "hand-bottom-draw"
    place(
        drawn_id,
        "hand-bottom",
        "drawn",
        "bottom",
        "standing",
        hand["drawnOffsetUnits"],
        -hand["backRadiusUnits"],
        0.5,
        90.0,
        0.0,
        {"slot": "draw"},
        next_face(drawn_id),
    )
    index["drawn"]["drawn"] = [drawn_id]

    # Link the decal records to their render state (nothing else to place).
    for record in decals:
        if "line" in record:
            log(record["line"])

    return scene, {
        "tiles": tiles,
        "index": index,
        "dimensions": dimensions,
        "inner": inner,
        "decals": [{"tile": record["tile"], "face": record["face"]} for record in decals],
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


def measure(camera: dict, tiles: list[dict], spec: dict) -> dict:
    by_id = {tile["id"]: tile for tile in tiles}
    scale_samples = []
    for seat in ("bottom", "right", "top", "left"):
        centre = by_id[f"pond-{seat}-12"]
        scale_samples.append(tile_size_px(camera, centre))
    scale_spread = max(scale_samples) / min(scale_samples)

    wall = spec["table"]["wall"]
    half_span = wall["stackCentreSpanUnits"] / 2 + wall["stackPitchUnits"] / 2
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
        else math.degrees(math.atan((wall["stackCentreSpanUnits"] / 2) / front_ground))
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
        width = tile["dimensions"]["width"]
        height = tile["dimensions"]["height"]
        local_z = visible_point_local(tile)[2]
        probes = [(0.0, 0.0)]
        for x in (-0.2, 0.2):
            for y in (-0.2, 0.2):
                probes.append((x * width, y * height))
        rotation = np.array(tile["rotation"], dtype=float).reshape(3, 3)
        origin = Vector(tile["origin"])
        for x, y in probes:
            point = origin + Vector(rotation @ np.array(Vector((x, y, local_z))))
            direction = (point - eye).normalized()
            hit, location, normal, index, hit_object, matrix = scene.ray_cast(
                depsgraph, eye, direction
            )
            samples += 1
            if not hit:
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

    scene, scene_data, shell_spec = build_scene(spec, options)
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
