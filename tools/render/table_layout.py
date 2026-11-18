#!/usr/bin/env python3
"""Project the whole-table ``SlotAnchors`` collection into the runtime layout.

This module is imported by ``bake_table_layout.py`` (inside the pinned
Blender 4.5.9) and holds no render logic, so Task 3A can add a scene
``lighting`` block and a per-slot ``basis`` without restructuring anything:

  - :func:`project_table_layout` is the one walker over the collection. It
    reads every anchor's world position and face quadruple and projects them
    through the active camera with ``world_to_camera_view``;
  - :func:`render_anchor_probes` is the test render used to prove the exported
    screen coordinates land on the rendered tile centres (one emissive marker
    per anchor; every tile, light and the table are hidden, so the marker's
    alpha centroid is the camera's own projection of that centre).

The published schema is the Task 3 schema of ``2_5d_implementation_plan.md``
(``referenceResolution`` plus a ``slots`` array), with additive top-level
metadata: the resolved rig camera, the reference slot, the bucket spec and a
per-bucket catalogue. Bucket boundaries are spec data (``table-reference-spec
.json`` ``layout.buckets``), never derived from a render, because Task 4 bakes
exactly one blank sprite per bucket.

Face-quad corner order is the anchor's published order, **TL, TR, BR, BL**, in
the tile's own face frame. The exported offsets are normalized screen units
relative to the projected anchor, top-left origin, +y down.
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

RENDER_DIR = Path(__file__).resolve().parent
if str(RENDER_DIR) not in sys.path:
    sys.path.insert(0, str(RENDER_DIR))

from bake_shells import die, log  # noqa: E402

FACE_QUAD_ORDER = "TL,TR,BR,BL"

# The naming scheme is the contract from table-reference-spec.json anchors.
PATTERNS = {
    "wall": re.compile(r"^wall_(south|east|north|west)_(\d{2})_([01])$"),
    "river": re.compile(r"^river_(south|east|north|west)_([0-2])_(\d{1,2})$"),
    "meld": re.compile(r"^meld_(south|east|north|west)_([0-3])$"),
    "hand": re.compile(r"^hand_(south|east|north|west)_(\d{2})$"),
}

ZONES = ("wall", "river", "meld", "hand")


# --------------------------------------------------------------------------- #
# Anchors
# --------------------------------------------------------------------------- #


def _anchor_object(collection, name: str) -> bpy.types.Object:
    obj = collection.objects.get(name)
    if obj is None:
        die(f"layout: SlotAnchors has no object named {name}")
    return obj


def _row_col(name: str, zone: str, obj: bpy.types.Object) -> tuple[int, int]:
    """The published ``row``/``col`` for a slot, checked against its properties.

    ``wall`` publishes the stack as ``col`` and the tier as ``row``; ``river``
    publishes the pond row/column; ``meld`` and ``hand`` have a single row and
    publish the slot as ``col``. The anchor Empty also carries these as custom
    properties, so a rename or a stale property fails loudly.
    """
    match = PATTERNS[zone].match(name)
    if not match:
        die(f"layout: anchor {name} does not match the {zone} naming scheme")
    seat = match.group(1)
    if zone == "wall":
        col, row = int(match.group(2)), int(match.group(3))
        _check_prop(obj, name, "slot", col)
        _check_prop(obj, name, "tier", row)
    elif zone == "river":
        row, col = int(match.group(2)), int(match.group(3))
        _check_prop(obj, name, "row", row)
        _check_prop(obj, name, "column", col)
    else:
        row, col = 0, int(match.group(2))
        if zone == "meld":
            _check_prop(obj, name, "column", col)
        else:
            _check_prop(obj, name, "slot", col, ("draw",) if col == 13 else ())
    if obj.get("seat") != seat:
        die(f"layout: anchor {name} seat property is {obj.get('seat')!r}, expected {seat!r}")
    return row, col


def _check_prop(
    obj: bpy.types.Object,
    name: str,
    key: str,
    expected: int,
    aliases: tuple[str, ...] = (),
) -> None:
    if key not in obj:
        return
    value = str(obj[key])
    if value in {str(expected), *aliases}:
        return
    die(f"layout: anchor {name} property {key}={value!r} != name-derived {expected}")


def read_anchor(obj: bpy.types.Object) -> dict:
    """One anchor record: identity, row/col, world centre and world face quad."""
    name = obj.name
    zone = str(obj.get("zone", ""))
    if zone not in ZONES:
        die(f"layout: anchor {name} has unknown zone {zone!r}")
    row, col = _row_col(name, zone, obj)
    if obj.get("faceQuadOrder") != FACE_QUAD_ORDER:
        die(f"layout: anchor {name} faceQuadOrder is {obj.get('faceQuadOrder')!r}")
    flat = list(obj.get("faceQuadLocal", ()))
    if len(flat) != 12:
        die(f"layout: anchor {name} faceQuadLocal has {len(flat)} floats, expected 12")
    local = [Vector(flat[index * 3 : index * 3 + 3]) for index in range(4)]
    world = [obj.matrix_world @ corner for corner in local]
    stored = list(obj.get("faceQuadWorld", ()))
    if len(stored) == 12:
        for corner, point in enumerate(world):
            for axis in range(3):
                if abs(stored[corner * 3 + axis] - point[axis]) > 1e-5:
                    die(f"layout: anchor {name} faceQuadWorld drifts from matrix_world")
    return {
        "id": name,
        "zone": zone,
        "seat": str(obj["seat"]),
        "row": row,
        "col": col,
        "occupied": bool(obj.get("occupied", False)),
        "centre": obj.matrix_world.translation.copy(),
        "faceQuadWorld": world,
    }


def read_anchors(collection) -> list[dict]:
    records = [read_anchor(obj) for obj in collection.objects]
    ids = [record["id"] for record in records]
    if len(set(ids)) != len(ids):
        die("layout: duplicate SlotAnchors names")
    return sorted(records, key=lambda record: record["id"])


# --------------------------------------------------------------------------- #
# Projection
# --------------------------------------------------------------------------- #


def project_point_px(scene, camera, point, resolution: list[int]) -> tuple[float, float, float]:
    """Normalized top-left (x, y) plus Blender's view-axis depth for a point."""
    width, height = resolution
    co = world_to_camera_view(scene, scene.camera, point)
    # world_to_camera_view's v is bottom-to-top; the runtime is top-left.
    return co.x * width, (1.0 - co.y) * height, co.z


def pinhole_point_px(camera: dict, point, resolution: list[int]) -> tuple[float, float, float]:
    """The independent pinhole used by the Node tooling, for cross-checks."""
    eye = Vector(camera["eye"])
    target = Vector(camera["target"])
    forward = (target - eye).normalized()
    right = forward.cross(Vector((0.0, 0.0, 1.0))).normalized()
    up = right.cross(forward)
    value = Vector(point) - eye
    depth = value.dot(forward)
    if depth <= 0:
        die(f"layout: point {tuple(point)} is behind the camera")
    if camera["mode"] != "perspective":
        die("layout: only the perspective rig camera is supported")
    width, height = resolution
    focal = camera["focalPixels"]
    return (
        width / 2 + camera["shiftX"] * width + focal * value.dot(right) / depth,
        height / 2 + camera["shiftY"] * width - focal * value.dot(up) / depth,
        depth,
    )


def verify_projection(scene, camera, points, resolution: list[int]) -> float:
    """Worst Blender-vs-pinhole pixel delta over the given world points."""
    worst = 0.0
    for point in points:
        x, y, depth = project_point_px(scene, camera, point, resolution)
        ex, ey, edepth = pinhole_point_px(camera, point, resolution)
        worst = max(worst, abs(x - ex), abs(y - ey), abs(depth - edepth))
    return worst


# --------------------------------------------------------------------------- #
# Bucketing
# --------------------------------------------------------------------------- #


def _family_for(zone: str, seat: str, layout_spec: dict) -> dict:
    matches = []
    for family in layout_spec["buckets"]:
        if zone not in family["zones"]:
            continue
        seats = family.get("seats")
        if seats is None:
            matches.append(family)
        elif isinstance(seats, dict) and seat in seats:
            matches.append(family)
        elif isinstance(seats, list) and seat in seats:
            matches.append(family)
    if len(matches) != 1:
        die(
            f"layout: slot family for zone {zone!r} seat {seat!r} matched "
            f"{len(matches)} bucket rules ({[m['id'] for m in matches]})"
        )
    return matches[0]


def _is_sideways(face_quad: list[dict], layout_spec: dict, resolution: list[int]) -> bool:
    """True when the projected face's top edge reads more vertical than flat.

    ``TL -> TR`` is the glyph's top edge. A physically turned tile (riichi
    discard, called meld tile) has that edge running up the screen, so it needs
    the rotated blank. 180-degree seats keep a horizontal top edge and are
    upright sprites with a rotated glyph. The comparison is in *pixels*, not
    normalized units, because the reference frame is 16:9.
    """
    width, height = resolution
    dx = (face_quad[1]["x"] - face_quad[0]["x"]) * width
    dy = (face_quad[1]["y"] - face_quad[0]["y"]) * height
    length = math.hypot(dx, dy)
    if length <= 0.0:
        die("layout: degenerate face quad cannot be classified")
    return abs(dx) / length <= layout_spec["rotation"]["sidewaysMaxAbsCos"]


def bucket_for(
    zone: str,
    seat: str,
    x: float,
    face_quad: list[dict],
    layout_spec: dict,
    resolution: list[int],
) -> str:
    family = _family_for(zone, seat, layout_spec)
    # Only the face-up pond/meld family has rotated blanks. A standing opponent
    # hand is seen edge-on from the human's camera, but its blank family is the
    # human's fan, not a turned sprite.
    sideways = bool(family.get("rotatedSuffix")) and _is_sideways(
        face_quad, layout_spec, resolution
    )

    if "seats" in family and isinstance(family["seats"], dict):
        return family["seats"][seat]

    boundaries = family["boundaries"]
    names = family["names"]
    if len(names) != len(boundaries) + 1:
        die(f"layout: bucket family {family['id']} names/boundaries disagree")
    index = 0
    while index < len(boundaries) and x >= boundaries[index]:
        index += 1
    name = names[index]
    if sideways:
        name += family["rotatedSuffix"]
    return name


# --------------------------------------------------------------------------- #
# Layout
# --------------------------------------------------------------------------- #


def _reference_slot(records: list[dict], layout_spec: dict) -> dict:
    point = Vector(layout_spec["reference"]["point"])
    if layout_spec["reference"].get("mode") != "nearest-slot":
        die("layout: reference.mode must be 'nearest-slot'")
    return min(
        records,
        key=lambda record: (
            round((record["centre"] - point).length, 9),
            record["id"],
        ),
    )


def project_table_layout(
    scene,
    collection,
    camera: dict,
    layout_spec: dict,
    resolution: list[int],
    variant_id: str,
) -> dict:
    """Project every anchor and publish the Task 3 layout record."""
    records = read_anchors(collection)
    reference = _reference_slot(records, layout_spec)
    width, height = resolution
    checked: list[Vector] = []
    for record in records:
        checked.append(record["centre"])
        checked.extend(record["faceQuadWorld"])

    slots: list[dict] = []
    for record in records:
        x, y, depth = project_point_px(scene, camera, record["centre"], resolution)
        corners = [
            project_point_px(scene, camera, point, resolution) for point in record["faceQuadWorld"]
        ]
        face_quad = [
            {
                "x": round((corner[0] - x) / width, layout_spec["rounding"]),
                "y": round((corner[1] - y) / height, layout_spec["rounding"]),
            }
            for corner in corners
        ]
        slots.append(
            {
                "id": record["id"],
                "zone": record["zone"],
                "seat": record["seat"],
                "row": record["row"],
                "col": record["col"],
                "anchor": {
                    "x": round(x / width, layout_spec["rounding"]),
                    "y": round(y / height, layout_spec["rounding"]),
                },
                "depth": round(depth, layout_spec["rounding"]),
                "bucket": bucket_for(
                    record["zone"], record["seat"], x / width, face_quad, layout_spec, resolution
                ),
                "faceQuad": face_quad,
            }
        )

    reference_depth = next(
        slot["depth"] for slot in slots if slot["id"] == reference["id"]
    )
    for slot in slots:
        slot["scale"] = round(reference_depth / slot["depth"], layout_spec["rounding"])

    catalogue = _bucket_catalogue(
        slots, layout_spec, {record["id"] for record in records if record["occupied"]}
    )
    delta = verify_projection(scene, camera, checked, resolution)
    if delta > 0.05:
        die(f"layout: Blender projection drifts from the pinhole by {delta:.4f} px")

    return {
        "version": 1,
        "generatedBy": "tools/render/bake_table_layout.py",
        "rig": layout_spec["rigId"],
        "variant": variant_id,
        "referenceResolution": {"width": width, "height": height},
        "camera": camera,
        "projectionDeltaPx": round(delta, 6),
        "reference": {
            "mode": layout_spec["reference"]["mode"],
            "point": list(layout_spec["reference"]["point"]),
            "slot": reference["id"],
            "depth": reference_depth,
            "note": layout_spec["reference"]["note"],
        },
        "buckets": layout_spec["buckets"],
        "bucketCatalogue": catalogue,
        "slots": slots,
    }


def _representative_axis(family: dict) -> str:
    return family.get("representativeAxis", "x")


def _bucket_catalogue(slots: list[dict], layout_spec: dict, occupied_ids: set[str]) -> dict:
    families = {family["id"]: family for family in layout_spec["buckets"]}
    members: dict[str, list[dict]] = {}
    for slot in slots:
        members.setdefault(slot["bucket"], []).append(slot)
    catalogue = {}
    for bucket in sorted(members):
        family = families[_family_of(bucket, layout_spec)]
        axis = _representative_axis(family)
        candidates = members[bucket]
        seat = family.get("representativeSeat")
        if seat is not None:
            preferred = [slot for slot in candidates if slot["seat"] == seat]
            if preferred:
                candidates = preferred
        # A reserved anchor is a valid slot but has no reference body; prefer a
        # slot the reference board actually fills so Task 4 has a body to pose.
        occupied = [slot for slot in candidates if slot["id"] in occupied_ids]
        if occupied:
            candidates = occupied
        ordered = sorted(
            candidates,
            key=lambda slot: (slot["anchor"][axis], slot["id"]),
        )
        # The median member represents the bucket's typical view angle; the
        # drawn hand tile and reserved anchors are deliberately not special-cased.
        representative = ordered[(len(ordered) - 1) // 2]
        catalogue[bucket] = {
            "family": family["id"],
            "representative": representative["id"],
            "count": len(members[bucket]),
            "axis": axis,
        }
    return catalogue


def _family_of(bucket: str, layout_spec: dict) -> str:
    for family in layout_spec["buckets"]:
        seats = family.get("seats")
        if isinstance(seats, dict):
            names = list(seats.values())
        else:
            names = list(family.get("names", []))
        suffixes = [""]
        if family.get("rotatedSuffix"):
            suffixes.append(family["rotatedSuffix"])
        for name in names:
            for suffix in suffixes:
                if bucket == name + suffix:
                    return family["id"]
    die(f"layout: bucket {bucket!r} does not belong to any family")
    return ""


def write_layout(layout: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(layout, indent=1) + "\n")


def bucket_table(layout: dict) -> str:
    lines = []
    for bucket, record in layout["bucketCatalogue"].items():
        lines.append(
            f"  {bucket:<22} {record['family']:<16} "
            f"{record['count']:>3} slots  representative {record['representative']}"
        )
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Probe render (the 1 px acceptance evidence)
# --------------------------------------------------------------------------- #


def _emission_material(name: str) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    output = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    emission.inputs["Strength"].default_value = 1.0
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def _marker_mesh(name: str, radius: float):
    import bmesh

    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=12, radius=radius)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def render_anchor_probes(
    scene,
    records: list[dict],
    resolution: list[int],
    path: Path,
    probe_spec: dict,
) -> list[dict]:
    """Render one emissive marker per anchor with every other object hidden.

    The marker is centred on the anchor's world position, so the rendered
    alpha centroid is Blender's own projection of that centre. ``probes-1x.png``
    is committed and the Node proof measures it (no Blender in the gate).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    for obj in bpy.data.objects:
        obj.hide_render = True
        obj.hide_viewport = True
    scene.world = None
    scene.render.resolution_x = resolution[0]
    scene.render.resolution_y = resolution[1]
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.color_mode = "RGBA"
    scene.cycles.samples = probe_spec["samples"]
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 0

    material = _emission_material("layout-probe")
    mesh = _marker_mesh("layout-probe-marker", float(probe_spec["radiusUnits"]))
    mesh.materials.append(material)
    markers = []
    for record in records:
        marker = bpy.data.objects.new(f"probe-{record['id']}", mesh)
        marker.location = record["centre"]
        scene.collection.objects.link(marker)
        marker.hide_render = False
        marker.hide_viewport = False
        markers.append(marker)
    bpy.context.view_layer.update()
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    log(f"layout probe render: {path} ({len(markers)} markers)")
    return [
        {
            "id": record["id"],
            "world": [round(value, 6) for value in record["centre"]],
        }
        for record in records
    ]
