#!/usr/bin/env python3
"""Bake the orthographic carved relief maps for the 2.5D tile faces.

Run inside the pinned Blender:

    ~/.local/opt/blender-4.5.9/blender --background \\
        --python tools/render/bake_relief.py -- [options]

Options:
    --dry-run              print the plan, write nothing
    --bake                 render every face, write the committed atlases
    --preview --only FACE[,...]   render only those faces into build/relief/preview
    --verify-determinism   render every face twice and compare the decoded cells

This is the Task 4B bake of the 2.5D pipeline's *orthographic PBR relief maps*.
It is not the Task 5A compositor and it does not draw a lit tile: it produces the
three master maps that Task 5A lights in world space from each slot's exported
basis (tangent, bitangent, normal), so a rotated riichi tile or a north pond tile
catches the key light on the newly exposed inner stroke walls.

What is baked (one cell per face, 256 x 340 px):

    face_albedo.png        RGB = pure pigment (no baked lighting), #FFFFFF on
                           un-carved ivory; A = paint mask (0 outside the etched
                           glyph, 1 inside the enamel groove).
    face_normal_depth.png  RGB = tangent-space normal, x right / y down / z out;
                           A = normalized surface height (1 at the un-carved
                           face, 0 at the deepest engraving point).
    face_ao_roughness.png  R = cavity AO (1 on the open face, ~0.45 in a tight
                           stroke junction); G = specular roughness (0.45 on the
                           open resin, 0.12 inside the painted groove).

The geometry is a real displaced mesh, not a 2D emboss: `scripts/
bake-relief-masks.mjs` writes an exact signed-distance field (millimetres) of the
glyph outline from the same vector artwork as the committed flat glyphs, and this
script samples it onto a 2x-oversampled plate grid, engraves the glyph floor
inward by 0.55 mm, adds a 40 degree V-carve bevel *outside* the glyph outline
(so the painted silhouette is exactly the flat glyph and the bevel is bare carved
ivory), rounds the creases with a small Gaussian and varies the depth with a
deterministic hand-carve sinusoid. Four orthographic Cycles passes then read the
true geometry: pigment emission, object-space normal, height/AO/roughness, and
the paint mask. Every pass shares the same camera, plate and pixel grid, so the
three committed atlases are aligned by construction; `scripts/check-relief.mjs`
re-proves it without Blender.

The camera frame is exactly the inset face plate (0.64 x 0.89 tile units =
17.92 x 24.92 mm). The cell's 256 x 340 px therefore have a 4.7% texel
anisotropy; `render.pixel_aspect_y` compensates so each texel covers exactly
1/256 x 1/340 of the plate and the render stays an honest orthographic take.
"""
from __future__ import annotations

import hashlib
import json
import math
import shutil
import sys
import time
import zlib
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector
from bpy_extras.object_utils import world_to_camera_view

RENDER_DIR = Path(__file__).resolve().parent
if str(RENDER_DIR) not in sys.path:
    sys.path.insert(0, str(RENDER_DIR))

from bake_shells import (  # noqa: E402  (Blender adds the script directory)
    aim,
    check_blender_version,
    die,
    load_rgba,
    log as shell_log,
    new_material,
    new_object,
    quantize,
    reset_scene,
    resolve_tile_dimensions,
    rgba_sha256,
)

PASSES = ("pigment", "normal", "fields", "mask")


def log(message: str) -> None:
    print(f"[relief] {message}")


# --------------------------------------------------------------------------- #
# Small helpers
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
        "preview": False,
        "only": None,
        "spec": None,
        "verifyDeterminism": False,
    }
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--dry-run":
            options["dryRun"] = True
        elif arg == "--bake":
            options["bake"] = True
        elif arg == "--preview":
            options["preview"] = True
        elif arg == "--verify-determinism":
            options["verifyDeterminism"] = True
        elif arg in ("--only", "--spec"):
            if index + 1 >= len(argv):
                die(f"{arg} needs a value")
            value = argv[index + 1]
            index += 1
            if arg == "--only":
                options["only"] = [part.strip() for part in value.split(",") if part.strip()]
            else:
                options["spec"] = value
        else:
            die(f"unknown option {arg}")
        index += 1
    return options


# --------------------------------------------------------------------------- #
# Plate geometry
# --------------------------------------------------------------------------- #


def plate_geometry(shell_spec: dict, relief_spec: dict) -> dict:
    """The inset face plate in units and millimetres, and the cell/texel scales."""
    tile = shell_spec["tile"]
    raster = relief_spec["raster"]
    mm_per_unit = tile["proportionsMm"]["height"] / tile["heightUnits"]
    plate_w = tile["width"] - 2.0 * tile["faceInset"]
    plate_h = tile["height"] - 2.0 * tile["faceInset"]
    cell_w = int(raster["cellWidth"])
    cell_h = int(raster["cellHeight"])
    plate_w_mm = plate_w * mm_per_unit
    plate_h_mm = plate_h * mm_per_unit
    return {
        "tile": tile,
        "mmPerUnit": mm_per_unit,
        "plateW": plate_w,
        "plateH": plate_h,
        "plateWMm": plate_w_mm,
        "plateHMm": plate_h_mm,
        "cellWidth": cell_w,
        "cellHeight": cell_h,
        "pxPerMmX": cell_w / plate_w_mm,
        "pxPerMmY": cell_h / plate_h_mm,
        "texelAspect": (cell_w / plate_w_mm) / (cell_h / plate_h_mm),
        # The render frame is the plate; pixel aspect makes the 256 x 340 cell
        # cover it exactly instead of squashing the geometry.
        "pixelAspectY": (plate_h / plate_w) * (cell_w / cell_h),
        "columns": int(raster["columns"]),
        "rows": int(raster["rows"]),
    }


def gaussian_blur(field: np.ndarray, sigma_px: float) -> np.ndarray:
    """Separable Gaussian on a 2D millimetre height field."""
    if sigma_px <= 0:
        return field
    radius = max(1, int(round(sigma_px * 3)))
    offsets = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-(offsets**2) / (2.0 * sigma_px * sigma_px))
    kernel /= kernel.sum()
    result = field.astype(np.float64)
    for axis in (0, 1):
        padded = np.pad(result, [(radius, radius) if a == axis else (0, 0) for a in (0, 1)], mode="edge")
        accumulated = np.zeros_like(result)
        count = result.shape[axis]
        for index, weight in enumerate(kernel):
            window = [slice(None), slice(None)]
            window[axis] = slice(index, index + count)
            accumulated += weight * padded[tuple(window)]
        result = accumulated
    return result


def bilinear(field: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    height, width = field.shape
    xs = np.clip(xs, 0.0, width - 1.001)
    ys = np.clip(ys, 0.0, height - 1.001)
    x0 = np.floor(xs).astype(np.int32)
    y0 = np.floor(ys).astype(np.int32)
    x1 = np.minimum(x0 + 1, width - 1)
    y1 = np.minimum(y0 + 1, height - 1)
    fx = xs - x0
    fy = ys - y0
    return (
        field[y0, x0] * (1 - fx) * (1 - fy)
        + field[y0, x1] * fx * (1 - fy)
        + field[y1, x0] * (1 - fx) * fy
        + field[y1, x1] * fx * fy
    )


def height_signature(carve: dict, geometry: dict) -> dict:
    """The carve parameters derived from the spec, in units and millimetres."""
    depth_mm = float(carve["depthMm"])
    angle = float(carve["wallAngleDeg"])
    wall_run_mm = depth_mm / math.tan(math.radians(angle))
    return {
        "depthMm": depth_mm,
        "wallAngleDeg": angle,
        "wallRunMm": wall_run_mm,
        "roundingSigmaMm": float(carve["roundingSigmaMm"]),
        "handVariation": float(carve["handCarve"]["depthVariation"]),
        "wavelengthsMm": [float(v) for v in carve["handCarve"]["wavelengthMm"]],
        "phases": [float(v) for v in carve["handCarve"]["phase"]],
        "depthUnits": depth_mm / geometry["mmPerUnit"],
        "wallRunUnits": wall_run_mm / geometry["mmPerUnit"],
    }


def height_field(
    field_path: Path,
    mask_size: tuple[int, int],
    geometry: dict,
    carve: dict,
    samples_per_texel: int,
    bleed_texels: int = 2,
) -> dict:
    """Sample the high-resolution signed distance onto the plate vertex grid.

    The grid extends ``bleed_texels`` past the frame on every side so no rendered
    pixel straddles the plate edge: a partially covered edge texel would average
    the emission with the transparent background and corrupt the normal, depth
    and AO data along the cell border. The bleed geometry is un-carved ivory (the
    glyph artwork keeps a margin far larger than the bleed) and its UVs run
    outside [0, 1], which the CLIP image extension handles.
    """
    mask_w, mask_h = mask_size
    plates = height_signature(carve, geometry)
    samples = max(1, int(samples_per_texel))
    cells_x = geometry["cellWidth"] * samples
    cells_y = geometry["cellHeight"] * samples
    bleed_x = bleed_texels * samples
    bleed_y = bleed_texels * samples
    half_w = geometry["plateW"] / 2.0
    half_h = geometry["plateH"] / 2.0

    xs = np.linspace(-half_w, half_w, cells_x + 1)
    ys = np.linspace(half_h, -half_h, cells_y + 1)
    step_x = xs[1] - xs[0]
    step_y = ys[0] - ys[1]
    xs = np.concatenate([xs[0] - step_x * np.arange(bleed_x, 0, -1), xs, xs[-1] + step_x * np.arange(1, bleed_x + 1)])
    ys = np.concatenate([ys[0] + step_y * np.arange(bleed_y, 0, -1), ys, ys[-1] - step_y * np.arange(1, bleed_y + 1)])
    xx, yy = np.meshgrid(xs, ys)

    # Plate millimetres -> mask pixels; the glyph canvas maps 1:1 onto the plate.
    # Outside the plate the sample clamps to the plate edge (un-carved margin).
    xs_mm = np.clip((xx + half_w) / geometry["plateW"], 0.0, 1.0) * geometry["plateWMm"]
    ys_mm = np.clip((half_h - yy) / geometry["plateH"], 0.0, 1.0) * geometry["plateHMm"]
    px = xs_mm / geometry["plateWMm"] * (mask_w - 1)
    py = ys_mm / geometry["plateHMm"] * (mask_h - 1)
    distance_mm = bilinear(np.fromfile(field_path, dtype="<f4").reshape(mask_h, mask_w), px, py)

    # The V-carve: one ramp to the glyph floor, measured from the outline
    # outward. Where two strokes are closer than 2x the run the deeper ramp
    # wins, so the gap is a shallow valley instead of an over-cut.
    ramp = np.clip((distance_mm + plates["wallRunMm"]) / plates["wallRunMm"], 0.0, 1.0)

    # Deterministic hand-carve depth: 1.0 at the deepest, down to
    # (1 - variation) where the two sinusoids peak. The deepest point is
    # therefore the nominal depth, before the rounding blur.
    wave_x = np.cos(2.0 * math.pi * (xx + half_w) / plates["wavelengthsMm"][0] + plates["phases"][0])
    wave_y = np.cos(2.0 * math.pi * (half_h - yy) / plates["wavelengthsMm"][1] + plates["phases"][1])
    modulation = 1.0 - plates["handVariation"] * 0.5 * (1.0 - wave_x * wave_y)
    depth_local = plates["depthMm"] * modulation

    height_mm = -depth_local * ramp
    grid_mm = geometry["plateWMm"] / cells_x
    sigma_px = plates["roundingSigmaMm"] / grid_mm
    height_mm = gaussian_blur(height_mm, sigma_px)

    # Normalize so the deepest pixel is exactly the nominal -depth: the depth
    # map's 0 means "deepest engraving point" for every face. A bare face (haku)
    # has no glyph at all, so it stays a flat plate.
    deepest = float(-height_mm.min()) if height_mm.min() < 0 else 0.0
    if deepest > 0.0:
        height_mm *= plates["depthMm"] / deepest

    return {
        "xx": xx,
        "yy": yy,
        "heightMm": height_mm,
        "cellsX": cells_x,
        "cellsY": cells_y,
        "deepestMm": plates["depthMm"],
        "blurredDeepestMm": deepest,
        "wallRunMm": plates["wallRunMm"],
        "distanceMm": distance_mm,
    }


def build_plate_mesh(height_mm: np.ndarray, xx: np.ndarray, yy: np.ndarray, geometry: dict) -> bpy.types.Object:
    """A smooth-shaded plate in local XY, displaced inward along -Z.

    The UV layer maps the plate 1:1 onto the glyph canvas (u left to right, v
    bottom to top), which is what the pigment and paint-mask passes sample. The
    face winding is TL/BL/BR/TR so the interpolated normal is +Z, out of the
    face.
    """
    rows, columns = height_mm.shape
    units = height_mm / geometry["mmPerUnit"]
    verts = np.stack([xx.ravel(), yy.ravel(), units.ravel()], axis=1)
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
    mesh = bpy.data.meshes.new("relief-plate")
    mesh.from_pydata(verts.tolist(), [], faces.tolist())
    mesh.update()
    for polygon in mesh.polygons:
        polygon.use_smooth = True

    u = (xx[0] + geometry["plateW"] / 2.0) / geometry["plateW"]
    v = (yy[:, 0] + geometry["plateH"] / 2.0) / geometry["plateH"]
    uu, vv = np.meshgrid(u, v)
    uv_layer = mesh.uv_layers.new(name="UVMap")
    uv_top_left = np.stack([uu[:-1, :-1].ravel(), vv[:-1, :-1].ravel()], axis=1)
    uv_bottom_left = np.stack([uu[1:, :-1].ravel(), vv[1:, :-1].ravel()], axis=1)
    uv_bottom_right = np.stack([uu[1:, 1:].ravel(), vv[1:, 1:].ravel()], axis=1)
    uv_top_right = np.stack([uu[:-1, 1:].ravel(), vv[:-1, 1:].ravel()], axis=1)
    uvs = np.concatenate([uv_top_left, uv_bottom_left, uv_bottom_right, uv_top_right], axis=1)
    uv_layer.data.foreach_set("uv", uvs.ravel().tolist())
    return new_object("relief-plate", mesh)


def stand_plate(obj: bpy.types.Object, geometry: dict) -> None:
    """Stand the local XY plate up at world y=0, facing the -Y camera."""
    rotation = Matrix.Rotation(math.radians(90.0), 4, "X")
    location = Vector((0.0, 0.0, geometry["plateH"] / 2.0))
    obj.matrix_world = Matrix.Translation(location) @ rotation


# --------------------------------------------------------------------------- #
# Scene, camera and the four orthographic passes
# --------------------------------------------------------------------------- #


def configure_relief_render(scene: bpy.types.Scene, relief_spec: dict, geometry: dict) -> None:
    raster = relief_spec["raster"]
    render = scene.render
    render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = int(raster["samples"])
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.use_denoising = False
    render.film_transparent = True
    render.resolution_x = geometry["cellWidth"]
    render.resolution_y = geometry["cellHeight"]
    render.resolution_percentage = 100
    render.pixel_aspect_x = 1.0
    render.pixel_aspect_y = geometry["pixelAspectY"]
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGBA"
    render.image_settings.color_depth = "8"
    render.image_settings.compression = 15
    # Data maps must not be dithered: a flat 255 depth has to stay 255, not
    # flicker to 254 in 8% of pixels.
    render.dither_intensity = 0.0
    scene.display_settings.display_device = "sRGB"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0


def build_camera(scene: bpy.types.Scene, geometry: dict) -> bpy.types.Object:
    """Orthographic camera filling exactly the inset face plate."""
    data = bpy.data.cameras.new("relief-camera")
    data.type = "ORTHO"
    data.sensor_fit = "AUTO"
    data.ortho_scale = geometry["plateH"]
    data.clip_start = 0.1
    data.clip_end = 50.0
    camera = new_object("relief-camera", data)
    target = Vector((0.0, 0.0, geometry["plateH"] / 2.0))
    camera.location = Vector((0.0, -5.0, geometry["plateH"] / 2.0))
    aim(camera, target)
    scene.camera = camera
    bpy.context.view_layer.update()

    # Fail loudly if the frame is not exactly the plate: the whole bake's
    # alignment rests on this projection.
    scene.render.resolution_x = geometry["cellWidth"]
    scene.render.resolution_y = geometry["cellHeight"]
    corners = [
        (-geometry["plateW"] / 2.0, 0.0, 0.0),
        (geometry["plateW"] / 2.0, 0.0, 0.0),
        (-geometry["plateW"] / 2.0, 0.0, geometry["plateH"]),
        (geometry["plateW"] / 2.0, 0.0, geometry["plateH"]),
    ]
    def at_edge(value: float) -> bool:
        return abs(value) <= 1e-4 or abs(value - 1.0) <= 1e-4

    for point in corners:
        u, v, _ = world_to_camera_view(scene, camera, Vector(point))
        if not (at_edge(u) and at_edge(v)):
            die(
                "the relief camera frame is not the plate: corner "
                f"{point} projects to ({u:.6f}, {v:.6f})"
            )
    return camera


def mask_image(mask_path: Path) -> bpy.types.Image:
    image = bpy.data.images.load(str(mask_path))
    image.colorspace_settings.name = "sRGB"
    return image


def new_pass_material(scene: bpy.types.Scene, name: str):
    material = new_material(name)
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    return material, nodes, links


def pigment_material(scene: bpy.types.Scene, mask_path: Path) -> bpy.types.Material:
    """Pure pigment, linearised from the glyph's sRGB fills, emitted unlit."""
    material, nodes, links = new_pass_material(scene, "relief-pigment")
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = mask_image(mask_path)
    texture.interpolation = "Linear"
    texture.extension = "CLIP"
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 1.0
    links.new(texture.outputs["Color"], emission.inputs["Color"])
    output = nodes["Material Output"]
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def normal_material(scene: bpy.types.Scene) -> bpy.types.Material:
    """Object-space shading normal encoded x right, y down, z out."""
    material, nodes, links = new_pass_material(scene, "relief-normal")
    geometry = nodes.new("ShaderNodeNewGeometry")
    to_object = nodes.new("ShaderNodeVectorTransform")
    to_object.vector_type = "NORMAL"
    to_object.convert_from = "WORLD"
    to_object.convert_to = "OBJECT"
    links.new(geometry.outputs["Normal"], to_object.inputs["Vector"])
    separate = nodes.new("ShaderNodeSeparateXYZ")
    links.new(to_object.outputs["Vector"], separate.inputs["Vector"])
    flip = nodes.new("ShaderNodeMath")
    flip.operation = "MULTIPLY"
    flip.inputs[1].default_value = -1.0
    links.new(separate.outputs["Y"], flip.inputs[0])
    combine = nodes.new("ShaderNodeCombineXYZ")
    links.new(separate.outputs["X"], combine.inputs["X"])
    links.new(flip.outputs[0], combine.inputs["Y"])
    links.new(separate.outputs["Z"], combine.inputs["Z"])
    encode = nodes.new("ShaderNodeVectorMath")
    encode.operation = "MULTIPLY_ADD"
    encode.inputs[1].default_value = (0.5, 0.5, 0.5)
    encode.inputs[2].default_value = (0.5, 0.5, 0.5)
    links.new(combine.outputs["Vector"], encode.inputs[0])
    emission = nodes.new("ShaderNodeEmission")
    links.new(encode.outputs["Vector"], emission.inputs["Color"])
    output = nodes["Material Output"]
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def fields_material(
    scene: bpy.types.Scene,
    relief_spec: dict,
    geometry: dict,
    mask_path: Path,
    depth_units: float,
) -> bpy.types.Material:
    """R = normalized height, G = remapped cavity AO, B = specular roughness."""
    material, nodes, links = new_pass_material(scene, "relief-fields")
    ao_spec = relief_spec["ao"]
    paint = relief_spec["paint"]

    ambient = nodes.new("ShaderNodeAmbientOcclusion")
    ambient.inputs["Distance"].default_value = float(ao_spec["distanceMm"]) / geometry["mmPerUnit"]
    ambient.samples = int(relief_spec["raster"]["aoSamples"])
    ambient.only_local = True

    texture = nodes.new("ShaderNodeTexImage")
    texture.image = mask_image(mask_path)
    texture.interpolation = "Linear"
    texture.extension = "CLIP"
    roughness_map = nodes.new("ShaderNodeMapRange")
    roughness_map.clamp = True
    roughness_map.inputs["From Min"].default_value = 0.0
    roughness_map.inputs["From Max"].default_value = 1.0
    roughness_map.inputs["To Min"].default_value = float(paint["roughness"]["open"])
    roughness_map.inputs["To Max"].default_value = float(paint["roughness"]["paint"])
    links.new(texture.outputs["Alpha"], roughness_map.inputs["Value"])

    coordinates = nodes.new("ShaderNodeTexCoord")
    separate = nodes.new("ShaderNodeSeparateXYZ")
    links.new(coordinates.outputs["Object"], separate.inputs["Vector"])
    depth_map = nodes.new("ShaderNodeMapRange")
    depth_map.clamp = True
    depth_map.inputs["From Min"].default_value = -depth_units
    depth_map.inputs["From Max"].default_value = 0.0
    depth_map.inputs["To Min"].default_value = 0.0
    depth_map.inputs["To Max"].default_value = 1.0
    links.new(separate.outputs["Z"], depth_map.inputs["Value"])

    combine = nodes.new("ShaderNodeCombineXYZ")
    links.new(depth_map.outputs["Result"], combine.inputs["X"])
    links.new(ambient.outputs["Color"], combine.inputs["Y"])
    links.new(roughness_map.outputs["Result"], combine.inputs["Z"])
    emission = nodes.new("ShaderNodeEmission")
    links.new(combine.outputs["Vector"], emission.inputs["Color"])
    output = nodes["Material Output"]
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def mask_material(scene: bpy.types.Scene, mask_path: Path) -> bpy.types.Material:
    """The paint mask, written to all three channels so any reader gets it."""
    material, nodes, links = new_pass_material(scene, "relief-mask")
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = mask_image(mask_path)
    texture.interpolation = "Linear"
    texture.extension = "CLIP"
    combine = nodes.new("ShaderNodeCombineXYZ")
    for channel in ("X", "Y", "Z"):
        links.new(texture.outputs["Alpha"], combine.inputs[channel])
    emission = nodes.new("ShaderNodeEmission")
    links.new(combine.outputs["Vector"], emission.inputs["Color"])
    output = nodes["Material Output"]
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def render_pass(scene: bpy.types.Scene, path: Path, view_transform: str) -> None:
    scene.view_settings.view_transform = view_transform
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


# --------------------------------------------------------------------------- #
# Measurement
# --------------------------------------------------------------------------- #


def median3(field: np.ndarray) -> np.ndarray:
    """3x3 median on a float 2D field; kills single-ray AO self-intersection speckle."""
    height, width = field.shape
    padded = np.pad(field, 1, mode="edge")
    stack = np.stack(
        [padded[dy : dy + height, dx : dx + width] for dy in range(3) for dx in range(3)]
    )
    return np.median(stack, axis=0)


def map_ao(raw_ao: np.ndarray, remap: dict) -> tuple[np.ndarray, dict]:
    """Median-filter the ray-cast visibility, then apply the cavity remap."""
    smoothed = median3(raw_ao)
    floor = float(remap["floor"])
    low = float(remap["low"])
    gamma = float(remap["gamma"])
    t = np.clip((smoothed - low) / (1.0 - low), 0.0, 1.0)
    mapped = floor + (1.0 - floor) * np.power(t, gamma)
    speckle = int((np.abs(smoothed - raw_ao) > 0.02).sum())
    return np.clip(np.rint(mapped * 255.0), 0, 255).astype(np.uint8), {
        "rawMin": round(float(raw_ao.min()), 4),
        "rawMean": round(float(raw_ao.mean()), 4),
        "min": round(float(mapped.min()), 4),
        "mean": round(float(mapped.mean()), 4),
        "openMean": round(float(mapped[raw_ao > 0.985].mean()) if (raw_ao > 0.985).any() else 1.0, 4),
        "medianFilteredPixels": speckle,
    }


def normal_angles(normal_rgb: np.ndarray) -> np.ndarray:
    """Wall angle in degrees from the encoded x-right / y-down normal bytes."""
    nx = (normal_rgb[..., 0].astype(np.float64) / 255.0) * 2.0 - 1.0
    ny = (normal_rgb[..., 1].astype(np.float64) / 255.0) * 2.0 - 1.0
    nz = (normal_rgb[..., 2].astype(np.float64) / 255.0) * 2.0 - 1.0
    horizontal = np.sqrt(nx * nx + ny * ny)
    return np.degrees(np.arctan2(horizontal, np.maximum(nz, 1e-6)))


def measure_cell(albedo: np.ndarray, normal_depth: np.ndarray, ao_roughness: np.ndarray) -> dict:
    """Numbers from the committed cell, not from the render before quantizing."""
    paint = albedo[..., 3] > 127
    depth = normal_depth[..., 3]
    open_face = depth == 255
    paint_pixels = int(paint.sum())
    angles = normal_angles(normal_depth[..., :3])
    wall_angles = angles[(angles > 6.0) & ~paint]
    ao = ao_roughness[..., 0].astype(np.float64) / 255.0
    roughness = ao_roughness[..., 1].astype(np.float64) / 255.0
    rgb = albedo[..., :3].astype(np.int32)
    red = int(((rgb[..., 0] > rgb[..., 1] + 40) & (rgb[..., 0] > rgb[..., 2] + 40) & paint).sum())
    return {
        "paintPixels": paint_pixels,
        "paintFraction": round(paint_pixels / paint.size, 5),
        "redPaintPixels": red,
        "depthMin": int(depth.min()),
        "depthMax": int(depth.max()),
        "openFaceFraction": round(float(open_face.mean()), 5),
        "aoMin": round(float(ao.min()), 4),
        "aoMean": round(float(ao.mean()), 4),
        "aoOpenMean": round(float(ao[open_face].mean()) if open_face.any() else 1.0, 4),
        "roughnessPaintMean": round(float(roughness[paint].mean()) if paint_pixels else 0.0, 4),
        "roughnessOpenMean": round(
            float(roughness[open_face & ~paint].mean()) if (open_face & ~paint).any() else 0.0, 4
        ),
        "wallAngleP50": round(float(np.percentile(wall_angles, 50)), 2) if wall_angles.size else 0.0,
        "wallAngleP90": round(float(np.percentile(wall_angles, 90)), 2) if wall_angles.size else 0.0,
        "wallAngleMax": round(float(wall_angles.max()), 2) if wall_angles.size else 0.0,
        "cornerAlpha": [
            int(albedo[0, 0, 3]),
            int(albedo[0, -1, 3]),
            int(albedo[-1, 0, 3]),
            int(albedo[-1, -1, 3]),
        ],
    }


# --------------------------------------------------------------------------- #
# Atlas assembly
# --------------------------------------------------------------------------- #


def assemble_cell(
    pigment: np.ndarray,
    normal: np.ndarray,
    fields: np.ndarray,
    mask: np.ndarray,
    ao_mapped: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The three committed cells from the four rendered passes (all uint8 RGBA)."""
    albedo = np.empty_like(pigment)
    albedo[..., :3] = pigment[..., :3]
    albedo[..., 3] = mask[..., 0]
    painted = albedo[..., 3] > 0
    albedo[..., 0][~painted] = 255
    albedo[..., 1][~painted] = 255
    albedo[..., 2][~painted] = 255

    normal_depth = np.empty_like(normal)
    normal_depth[..., :3] = normal[..., :3]
    normal_depth[..., 3] = fields[..., 0]

    ao_roughness = np.empty_like(fields)
    ao_roughness[..., 0] = ao_mapped
    ao_roughness[..., 1] = fields[..., 2]
    ao_roughness[..., 2] = 0
    ao_roughness[..., 3] = 255
    return albedo, normal_depth, ao_roughness


def png_filtered(rows: np.ndarray) -> bytes:
    """PNG raw stream with the usual per-row minimum-sum filter heuristic."""
    height, stride = rows.shape
    raw = bytearray()
    previous = np.zeros(stride, dtype=np.int16)
    for y in range(height):
        row = rows[y].astype(np.int16)
        left = np.concatenate([np.zeros(4, dtype=np.int16), row[:-4]])
        up_left = np.concatenate([np.zeros(4, dtype=np.int16), previous[:-4]])

        def paeth(a, b, c):
            p = a + b - c
            pa = np.abs(p - a)
            pb = np.abs(p - b)
            pc = np.abs(p - c)
            return np.where((pa <= pb) & (pa <= pc), a, np.where(pb <= pc, b, c))

        candidates = {
            0: row,
            1: (row - left) & 0xFF,
            2: (row - previous) & 0xFF,
            3: (row - ((left + previous) >> 1)) & 0xFF,
            4: (row - paeth(left, previous, up_left)) & 0xFF,
        }
        which = min(
            candidates,
            key=lambda kind: int(np.abs(np.where(candidates[kind] < 128, candidates[kind], 256 - candidates[kind])).sum()),
        )
        raw.append(which)
        raw.extend(candidates[which].astype(np.uint8).tobytes())
        previous = row
    return bytes(raw)


def encode_atlas(path: Path, rgba: np.ndarray) -> dict:
    height, width, channels = rgba.shape
    if channels != 4:
        die(f"{path}: expected RGBA, got {channels} channels")
    payload = zlib.compress(png_filtered(rgba.reshape(height, width * 4)), 9)

    def chunk(kind: bytes, body: bytes) -> bytes:
        return (
            len(body).to_bytes(4, "big")
            + kind
            + body
            + (zlib.crc32(kind + body) & 0xFFFFFFFF).to_bytes(4, "big")
        )

    header = width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes([8, 6, 0, 0, 0])
    data = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", payload)
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {
        "file": path.name,
        "width": width,
        "height": height,
        "bytes": len(data),
        "sha256": {
            "png": hashlib.sha256(data).hexdigest(),
            "decodedRgba": rgba_sha256(rgba),
        },
    }


# --------------------------------------------------------------------------- #
# One face
# --------------------------------------------------------------------------- #


def bake_face(
    face: dict,
    relief_spec: dict,
    shell_spec: dict,
    geometry: dict,
    mask_dir: Path,
    pass_dir: Path,
) -> dict:
    mask_path = mask_dir / f"{face['id']}.png"
    field_path = mask_dir / f"{face['id']}.f32"
    if not mask_path.exists() or not field_path.exists():
        die(f"{face['id']} masks are missing; run node tools/render/scripts/bake-relief-masks.mjs")

    started = time.time()
    level = height_field(
        field_path,
        (int(relief_spec["source"]["maskWidth"]), round(int(relief_spec["source"]["maskWidth"]) * 400 / 300)),
        geometry,
        relief_spec["carve"],
        int(relief_spec["raster"]["meshSamplesPerTexel"]),
    )
    depth_units = level["deepestMm"] / geometry["mmPerUnit"]

    scene = reset_scene()
    configure_relief_render(scene, relief_spec, geometry)
    build_camera(scene, geometry)
    plate = build_plate_mesh(level["heightMm"], level["xx"], level["yy"], geometry)
    stand_plate(plate, geometry)

    face_pass_dir = pass_dir / face["id"]
    face_pass_dir.mkdir(parents=True, exist_ok=True)

    materials = {
        "pigment": pigment_material(scene, mask_path),
        "normal": normal_material(scene),
        "fields": fields_material(scene, relief_spec, geometry, mask_path, depth_units),
        "mask": mask_material(scene, mask_path),
    }
    views = {
        "pigment": relief_spec["raster"].get("colorViewTransform", "Standard"),
        "normal": relief_spec["raster"]["viewTransform"],
        "fields": relief_spec["raster"]["viewTransform"],
        "mask": relief_spec["raster"]["viewTransform"],
    }
    rendered: dict[str, np.ndarray] = {}
    for name in PASSES:
        plate.data.materials.clear()
        plate.data.materials.append(materials[name])
        path = face_pass_dir / f"{name}.png"
        render_pass(scene, path, views[name])
        rendered[name] = quantize(load_rgba(path))

    raw_ao = rendered["fields"][..., 1].astype(np.float64) / 255.0
    ao_mapped, ao_stats = map_ao(raw_ao, relief_spec["ao"]["remap"])
    albedo, normal_depth, ao_roughness = assemble_cell(
        rendered["pigment"], rendered["normal"], rendered["fields"], rendered["mask"], ao_mapped
    )
    measured = measure_cell(albedo, normal_depth, ao_roughness)
    measured["ao"] = ao_stats
    elapsed = time.time() - started
    log(
        f"relief {face['id']}: {geometry['cellWidth']}x{geometry['cellHeight']}, "
        f"paint {measured['paintPixels']} px, wall P90 {measured['wallAngleP90']:.1f} deg, "
        f"AO min {measured['aoMin']:.2f}, depth min {measured['depthMin']}, {elapsed:.1f}s"
    )
    if measured["paintPixels"] and measured["cornerAlpha"] != [0, 0, 0, 0]:
        die(f"{face['id']} paint mask reaches a cell corner: {measured['cornerAlpha']}")
    return {
        "id": face["id"],
        "albedo": albedo,
        "normalDepth": normal_depth,
        "aoRoughness": ao_roughness,
        "measured": measured,
        "geometry": {
            "deepestMm": round(level["deepestMm"], 6),
            "preNormalizeDeepestMm": round(level["blurredDeepestMm"], 6),
            "wallRunMm": round(level["wallRunMm"], 6),
            "meshCells": [level["heightMm"].shape[1] - 1, level["heightMm"].shape[0] - 1],
        },
        "renderSeconds": round(elapsed, 2),
        "camera": {"orthoScale": geometry["plateH"], "pixelAspectY": geometry["pixelAspectY"]},
    }


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main(argv: list[str]) -> int:
    options = parse_options(argv)
    spec_path = Path(options["spec"]) if options.get("spec") else RENDER_DIR / "relief-spec.json"
    if not spec_path.is_absolute():
        spec_path = RENDER_DIR / spec_path
    relief_spec = read_json(spec_path)
    shell_spec = read_json(RENDER_DIR / relief_spec["source"]["shellSpec"])
    faces_spec = read_json(RENDER_DIR / relief_spec["source"]["facesSpec"])
    masks_info = read_json(RENDER_DIR / relief_spec["source"]["maskDir"] / "masks.json")

    check_blender_version(relief_spec)
    resolve_tile_dimensions(shell_spec)
    geometry = plate_geometry(shell_spec, relief_spec)
    log(
        f"plate {geometry['plateW']:.4f} x {geometry['plateH']:.4f} units "
        f"({geometry['plateWMm']:.3f} x {geometry['plateHMm']:.3f} mm), "
        f"{geometry['pxPerMmX']:.2f} x {geometry['pxPerMmY']:.2f} px/mm "
        f"(texel aspect {geometry['texelAspect']:.5f})"
    )
    columns = geometry["columns"]
    rows = geometry["rows"]
    if columns * rows < len(faces_spec["faces"]):
        die(f"the atlas fits {columns * rows} cells for {len(faces_spec['faces'])} faces")

    faces = list(faces_spec["faces"])
    if options["only"]:
        known = {face["id"] for face in faces}
        missing = [face_id for face_id in options["only"] if face_id not in known]
        if missing:
            die(f"unknown face(s) {missing}")
        faces = [face for face in faces if face["id"] in options["only"]]

    if options["preview"]:
        output_dir = RENDER_DIR / relief_spec["output"]["buildDir"] / "preview"
        manifest_path = RENDER_DIR / relief_spec["output"]["buildDir"] / "preview.json"
        pass_dir = RENDER_DIR / relief_spec["output"]["buildDir"] / "passes-preview"
    else:
        output_dir = (RENDER_DIR / relief_spec["output"]["dir"]).resolve()
        manifest_path = (RENDER_DIR / relief_spec["output"]["manifest"]).resolve()
        pass_dir = RENDER_DIR / relief_spec["output"]["buildDir"] / "passes"

    mask_dir = RENDER_DIR / relief_spec["source"]["maskDir"]
    if options["dryRun"]:
        log(
            f"plan: {len(faces)} faces x {len(PASSES)} passes -> {output_dir} "
            f"(cell {geometry['cellWidth']}x{geometry['cellHeight']}, "
            f"atlas {columns * geometry['cellWidth']}x{rows * geometry['cellHeight']})"
        )
        for index, face in enumerate(faces):
            column = index % columns
            row = index // columns
            log(f"  {index:02d} {face['id']} cell ({column},{row})")
        return 0

    cells: dict[str, dict] = {}
    rendered_faces: list[dict] = []
    for index, face in enumerate(faces):
        log(f"[{index + 1}/{len(faces)}] {face['id']}")
        result = bake_face(face, relief_spec, shell_spec, geometry, mask_dir, pass_dir)
        if options["verifyDeterminism"]:
            repeat = bake_face(face, relief_spec, shell_spec, geometry, mask_dir, pass_dir / "repeat")
            for key in ("albedo", "normalDepth", "aoRoughness"):
                if not np.array_equal(result[key], repeat[key]):
                    die(f"{face['id']} {key} is not deterministic across renders")
            shutil.rmtree(pass_dir / "repeat", ignore_errors=True)
        rendered_faces.append(result)

    atlas_w = columns * geometry["cellWidth"]
    atlas_h = rows * geometry["cellHeight"]
    # Unused cells get neutral values rather than zeros, so a stray sample is a
    # flat ivory face (no paint, flat normal, open AO, resin roughness) instead
    # of a black, -Z-facing, fully-occluded pixel.
    albedo_atlas = np.zeros((atlas_h, atlas_w, 4), dtype=np.uint8)
    albedo_atlas[...] = (255, 255, 255, 0)
    normal_atlas = np.zeros((atlas_h, atlas_w, 4), dtype=np.uint8)
    normal_atlas[...] = (128, 128, 255, 255)
    ao_atlas = np.zeros((atlas_h, atlas_w, 4), dtype=np.uint8)
    ao_atlas[...] = (255, 115, 0, 255)
    faces_manifest: dict[str, dict] = {}
    for index, result in enumerate(rendered_faces):
        column = index % columns
        row = index // columns
        x = column * geometry["cellWidth"]
        y = row * geometry["cellHeight"]
        albedo_atlas[y : y + geometry["cellHeight"], x : x + geometry["cellWidth"]] = result["albedo"]
        normal_atlas[y : y + geometry["cellHeight"], x : x + geometry["cellWidth"]] = result["normalDepth"]
        ao_atlas[y : y + geometry["cellHeight"], x : x + geometry["cellWidth"]] = result["aoRoughness"]
        cell = {
            "index": index,
            "column": column,
            "row": row,
            "x": x,
            "y": y,
            "rect": [
                round(x / atlas_w, 8),
                round(y / atlas_h, 8),
                round((x + geometry["cellWidth"]) / atlas_w, 8),
                round((y + geometry["cellHeight"]) / atlas_h, 8),
            ],
        }
        cells[result["id"]] = cell
        faces_manifest[result["id"]] = {
            "kind": next(face["kind"] for face in faces_spec["faces"] if face["id"] == result["id"]),
            "cell": cell,
            "measured": result["measured"],
            "geometry": result["geometry"],
            "renderSeconds": result["renderSeconds"],
        }

    atlases = {
        "face_albedo": encode_atlas(output_dir / "face_albedo.png", albedo_atlas),
        "face_normal_depth": encode_atlas(output_dir / "face_normal_depth.png", normal_atlas),
        "face_ao_roughness": encode_atlas(output_dir / "face_ao_roughness.png", ao_atlas),
    }
    for name, record in atlases.items():
        log(f"atlas {name}: {record['width']}x{record['height']}, {record['bytes']} B")

    if len(rendered_faces) == len(faces_spec["faces"]):
        full = True
    else:
        full = False

    manifest = {
        "version": 1,
        "generatedBy": (
            "tools/render/bake_relief.py (Blender 4.5.9 Cycles) + "
            "tools/render/scripts/bake-relief-masks.mjs"
        ),
        "purpose": relief_spec["purpose"],
        "status": relief_spec["status"],
        "state": "preview" if options["preview"] or not full else "committed",
        "coordinateSpace": (
            "Each atlas cell is the inset face plate in face-local space: the cell's "
            "top-left is the glyph's top-left, exactly like the flat glyph in faces.json, "
            "so the cell maps onto the same shell faceQuad (TL/TR/BR/BL). The plate is "
            "0.64 x 0.89 tile units = 17.92 x 24.92 mm; the 256 x 340 px cell has 14.2857 "
            "px/mm across and 13.6434 px/mm down (4.7% texel anisotropy). Normal RGB is "
            "tangent x right, y down, z out; the slot basis published by table_layout.json "
            "maps it to world space as n.x*T + n.y*B + n.z*N with no sign flip."
        ),
        "source": {
            "facesSpec": relief_spec["source"]["facesSpec"],
            "shellSpec": relief_spec["source"]["shellSpec"],
            "maskDir": relief_spec["source"]["maskDir"],
            "maskWidth": relief_spec["source"]["maskWidth"],
            "maskHeight": round(int(relief_spec["source"]["maskWidth"]) * 400 / 300),
            "glyphCanvas": [300, 400],
            "upstream": faces_spec["source"],
            "masks": {
                face_id: {
                    "sha256": record["sha256"],
                    "insidePixels": record["field"]["insidePixels"],
                    "signedDistanceMm": record["field"]["signedDistanceMm"],
                }
                for face_id, record in masks_info["masks"].items()
            },
        },
        "raster": {
            "cellWidth": geometry["cellWidth"],
            "cellHeight": geometry["cellHeight"],
            "columns": columns,
            "rows": rows,
            "atlasWidth": atlas_w,
            "atlasHeight": atlas_h,
            "faces": len(faces),
            "format": "8-bit RGBA PNG",
            "samples": int(relief_spec["raster"]["samples"]),
            "aoSamples": int(relief_spec["raster"]["aoSamples"]),
            "meshSamplesPerTexel": int(relief_spec["raster"]["meshSamplesPerTexel"]),
            "viewTransform": relief_spec["raster"]["viewTransform"],
            "colorViewTransform": relief_spec["raster"].get("colorViewTransform", "Standard"),
            "pixelAspectY": round(geometry["pixelAspectY"], 8),
            "mmPerUnit": geometry["mmPerUnit"],
            "plateUnits": [round(geometry["plateW"], 8), round(geometry["plateH"], 8)],
            "plateMm": [round(geometry["plateWMm"], 6), round(geometry["plateHMm"], 6)],
            "pxPerMm": {
                "x": round(geometry["pxPerMmX"], 6),
                "y": round(geometry["pxPerMmY"], 6),
            },
            "texelAspect": round(geometry["texelAspect"], 8),
            "cells": cells,
            "channels": {
                "face_albedo": "RGB pure pigment (no baked lighting), #FFFFFF where the paint mask is 0; A paint mask (0 un-carved resin, 1 enamel groove)",
                "face_normal_depth": "RGB tangent normal x right / y down / z out; A normalized height (1 un-carved, 0 deepest engraving)",
                "face_ao_roughness": "R cavity AO (1 open face, ~0.45 tight junction); G specular roughness (0.45 resin, 0.12 lacquer); B 0; A 255",
            },
        },
        "carve": {
            **height_signature(relief_spec["carve"], geometry),
            "bevelSide": relief_spec["carve"]["bevelSide"],
            "depthRangeMm": relief_spec["carve"]["depthRangeMm"],
            "wallAngleRangeDeg": relief_spec["carve"]["wallAngleRangeDeg"],
            "notes": relief_spec["carve"]["notes"],
        },
        "paint": relief_spec["paint"],
        "ao": relief_spec["ao"],
        "atlases": {
            name: {
                "file": f"{output_dir.name}/{record['file']}",
                "width": record["width"],
                "height": record["height"],
                "bytes": record["bytes"],
                "sha256": record["sha256"],
            }
            for name, record in atlases.items()
        },
        "totals": {
            "faces": len(faces_manifest),
            "atlasBytes": sum(record["bytes"] for record in atlases.values()),
            "renderSeconds": round(sum(f["renderSeconds"] for f in faces_manifest.values()), 1),
        },
        "faces": faces_manifest,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    log(
        f"wrote {len(faces_manifest)} face cells and "
        f"{manifest['totals']['atlasBytes']} B of atlases to {output_dir} and {manifest_path}"
    )
    budget = int(relief_spec["output"]["bytesBudget"])
    if manifest["totals"]["atlasBytes"] > budget:
        log(
            f"advisory: atlas bytes {manifest['totals']['atlasBytes']} exceed the "
            f"spec budget {budget} (AGENTS.md 1c)"
        )
    return 0

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]))
