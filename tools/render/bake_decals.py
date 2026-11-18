#!/usr/bin/env python3
"""Bake the carved, painted, separately lit tile face decals.

Run inside the pinned Blender:

    ~/.local/opt/blender-4.5.9/blender --background \
        --python tools/render/bake_decals.py -- [options]

Options:
    --dry-run              print the plan, write nothing
    --spike                bake decal-spec.json's spike faces into build/decals
    --only FACE[,FACE]     bake only these face ids
    --rotations N[,N]      override the light rotations (default 0,90,180,270)
    --verify-determinism   render every decal twice and compare decoded RGBA

This restores only the retired full-scene pipeline's carve -> paint -> light
decal step. The decal is a transparent carve/paint overlay: it contains the
recessed lip/fillet and the paint, and transparent pixels everywhere else, so
the current shell keeps its own lighting and face colour outside the carve.

The symbol stays upright in face-local space; the shell's published faceQuad
applies the tile's rotation. The four images per face differ only in the baked
light direction, chosen so the light lands top-left on screen after that quad
rotation. There is one image per (face, light rotation, symbol rotation); the
Phase 2 catalogue bakes symbol rotation 0 only.

Outputs (full bake):
    frontend/public/table/decals/<face>-l<rotation>.png
    frontend/public/table/decals.json
Spike outputs (gitignored):
    tools/render/build/decals/<face>-l<rotation>.png
    tools/render/build/decals.json
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

RENDER_DIR = Path(__file__).resolve().parent
if str(RENDER_DIR) not in sys.path:
    sys.path.insert(0, str(RENDER_DIR))

from bake_shells import (  # noqa: E402  (Blender adds the script directory)
    aim,
    check_blender_version,
    configure_render,
    die,
    encode_png,
    hex_linear,
    load_rgba,
    log,
    new_material,
    new_object,
    principled,
    quantize,
    render_pass,
    reset_scene,
    resolve_tile_dimensions,
    rgba_sha256,
)

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
        "spike": False,
        "build": False,
        "only": None,
        "rotations": None,
        "surface": None,
        "spec": None,
        "verifyDeterminism": False,
    }
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--dry-run":
            options["dryRun"] = True
        elif arg == "--spike":
            options["spike"] = True
        elif arg == "--build":
            options["build"] = True
        elif arg == "--verify-determinism":
            options["verifyDeterminism"] = True
        elif arg in ("--only", "--rotations", "--surface", "--spec"):
            if index + 1 >= len(argv):
                die(f"{arg} needs a value")
            value = argv[index + 1]
            index += 1
            if arg == "--only":
                options["only"] = [part.strip() for part in value.split(",") if part.strip()]
            elif arg == "--surface":
                options["surface"] = [part.strip() for part in value.split(",") if part.strip()]
            elif arg == "--spec":
                options["spec"] = value
            else:
                options["rotations"] = [int(part.strip()) for part in value.split(",") if part.strip()]
        else:
            die(f"unknown option {arg}")
        index += 1
    return options


def normalize_rotation(value: int) -> int:
    return (int(value) // 90 * 90) % 360


def rotate_about_axis(point: Vector, center: Vector, axis: Vector, angle_deg: float) -> Vector:
    """Rotate a point about an arbitrary axis through ``center``."""
    rotation = Matrix.Rotation(math.radians(angle_deg), 4, axis.normalized())
    return center + rotation @ (point - center)


# --------------------------------------------------------------------------- #
# Geometry, field and carve (ported from the retired scene pipeline, e39d92e)
# --------------------------------------------------------------------------- #


def decal_geometry(shell_spec: dict, decal_spec: dict) -> dict:
    """The padded face-plate frame at the decal's @2x size, in units and pixels."""
    tile = shell_spec["tile"]
    raster = decal_spec["raster"]
    padding = int(raster.get("paddingPixels", 0))
    inset_w = tile["width"] - 2.0 * tile["faceInset"]
    inset_h = tile["height"] - 2.0 * tile["faceInset"]
    width = int(raster["width"])
    height = int(raster["height"])
    frame_w = width - 2 * padding
    frame_h = height - 2 * padding
    px_per_unit = frame_h / inset_h
    derived_w = round(inset_w * px_per_unit) + 2 * padding
    if abs(derived_w - width) > 1:
        die(
            f"decal raster {width}x{height} does not match the inset face "
            f"({derived_w}x{height} at {px_per_unit:.4f} px/unit)"
        )
    face_plate_rect = [
        padding / width,
        padding / height,
        (width - padding) / width,
        (height - padding) / height,
    ]
    return {
        "width": width,
        "height": height,
        "padding": padding,
        "frameW": width / px_per_unit,
        "frameH": height / px_per_unit,
        "pxPerUnit": px_per_unit,
        "facePlateRect": face_plate_rect,
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
    """Approximate signed distance (pixels, positive inside) from a blurred mask."""
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


def bezier_profile(u: np.ndarray, top_spread: float, bottom_spread: float) -> np.ndarray:
    """Groove height profile as a cubic Bézier with independent fillets."""
    ts = np.linspace(0.0, 1.0, 1025)
    one_minus = 1.0 - ts
    xs = (
        3.0 * one_minus * one_minus * ts * top_spread
        + 3.0 * one_minus * ts * ts * (1.0 - bottom_spread)
        + ts * ts * ts
    )
    ys = ts * ts * (3.0 - 2.0 * ts)
    xs = np.maximum.accumulate(xs) + np.arange(ts.size) * 1e-12
    return np.interp(np.clip(u, 0.0, 1.0), xs, ys)


def carve_field(symbol_path: Path, decal_spec: dict, geometry: dict, out_path: Path) -> np.ndarray:
    """Load the glyph, make the carve distance field and write it as a PNG."""
    carve = decal_spec["carve"]
    px_per_unit = geometry["pxPerUnit"]
    symbol = load_rgba(symbol_path)
    raw_mask = symbol[..., 3].copy()
    # Pure-white glyph fills are the tile's ivory showing through the paint,
    # not white enamel. Excluding them from the carve mask leaves the shell
    # face at its original height there: a raised island inside the recessed
    # glyph (pinzu/souzu). The decal is transparent over the island.
    if carve.get("whiteFillUncarved", False):
        threshold = float(carve.get("whiteFillThreshold", 0.9))
        white = (
            (symbol[..., 0] >= threshold)
            & (symbol[..., 1] >= threshold)
            & (symbol[..., 2] >= threshold)
        )
        raw_mask[white] = 0.0
    sigma_px = float(carve["blurUnits"]) * px_per_unit
    blurred = blur2d(raw_mask, sigma_px)
    distance_px = alpha_to_distance(blurred, sigma_px)
    transition_px = float(carve["transitionUnits"]) * px_per_unit
    field = np.clip(distance_px / transition_px, 0.0, 1.0)
    rgba = np.stack([field, field, field, np.ones_like(field)], axis=-1)
    encode_png(out_path, quantize(rgba))
    return field


def build_carved_face(
    shell_spec: dict,
    decal_spec: dict,
    material: bpy.types.Material,
    field: np.ndarray,
    half_w: float,
    half_h: float,
    top: float,
    uv_rect: tuple[float, float, float, float],
    decal_pixels: tuple[int, int],
) -> bpy.types.Object:
    """Subdivided face plate with the painted symbol physically recessed."""
    carve = decal_spec["carve"]
    depth = carve["depthFractionOfThickness"] * shell_spec["tile"]["thickness"]
    columns = max(2, round(decal_pixels[0] * carve["gridScale"]))
    rows = max(2, round(decal_pixels[1] * carve["gridScale"]))
    u0, v0, u1, v1 = uv_rect

    grid_x = np.linspace(-half_w, half_w, columns, dtype=np.float64)
    grid_y = np.linspace(half_h, -half_h, rows, dtype=np.float64)
    u = np.linspace(u0, u1, columns)
    v = np.linspace(v1, v0, rows)  # row 0 is the top of the face (v = v1)
    uu, vv = np.meshgrid(u, v)

    field_height, field_width = field.shape
    sampled = bilinear2d(field, uu * (field_width - 1), (1.0 - vv) * (field_height - 1))
    profile = carve["profile"]
    height = bezier_profile(sampled, profile["topSpread"], profile["bottomSpread"])
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
    uvs = np.concatenate([uv_top_left, uv_bottom_left, uv_bottom_right, uv_top_right], axis=1)
    uv_layer.data.foreach_set("uv", uvs.ravel().tolist())

    return new_object("face-plane", mesh)


# --------------------------------------------------------------------------- #
# Decal material
# --------------------------------------------------------------------------- #


def decal_material(
    shell_spec: dict,
    decal_spec: dict,
    symbol_path: Path,
    field_path: Path,
    surface: str,
) -> bpy.types.Material:
    """The carved face shader: face + paint, cavity AO, and transparent outside."""
    tile_spec = shell_spec["tile"]
    carve = decal_spec["carve"]
    material = new_material("face-decal")
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    face_spec = tile_spec["materials"]["face"]
    paint_spec = tile_spec["materials"]["paint"]

    face_bsdf = principled(material)
    face_bsdf.inputs["Roughness"].default_value = face_spec["roughness"]
    face_bsdf.inputs["Specular IOR Level"].default_value = 0.5
    face_bsdf.inputs["Coat Weight"].default_value = face_spec["coat"]
    face_bsdf.inputs["Coat Roughness"].default_value = face_spec["coatRoughness"]

    ambient = nodes.new("ShaderNodeAmbientOcclusion")
    ambient.inputs["Distance"].default_value = carve["occlusionDistance"]
    ambient.samples = carve["occlusionSamples"]
    ambient.only_local = True
    occlusion_strength = carve["occlusionStrength"]

    face_colour = nodes.new("ShaderNodeRGB")
    face_colour.outputs["Color"].default_value = hex_linear(face_spec["hex"])
    face_ao = nodes.new("ShaderNodeMixRGB")
    face_ao.blend_type = "MULTIPLY"
    face_ao.inputs["Fac"].default_value = occlusion_strength
    links.new(face_colour.outputs["Color"], face_ao.inputs[1])
    links.new(ambient.outputs["Color"], face_ao.inputs[2])
    links.new(face_ao.outputs["Color"], face_bsdf.inputs["Base Color"])

    symbol_image = bpy.data.images.load(str(symbol_path))
    symbol_image.colorspace_settings.name = "sRGB"
    symbol_node = nodes.new("ShaderNodeTexImage")
    symbol_node.image = symbol_image
    symbol_node.interpolation = "Linear"

    field_image = bpy.data.images.load(str(field_path))
    field_image.colorspace_settings.name = "Non-Color"
    field_node = nodes.new("ShaderNodeTexImage")
    field_node.image = field_image
    field_node.interpolation = "Linear"
    field_channel = nodes.new("ShaderNodeSeparateColor")
    links.new(field_node.outputs["Color"], field_channel.inputs["Color"])

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

    paint_gate = nodes.new("ShaderNodeMapRange")
    paint_edge = carve["paintEdge"]
    paint_gate.inputs["From Min"].default_value = paint_edge - 0.02
    paint_gate.inputs["From Max"].default_value = paint_edge + 0.02
    paint_gate.inputs["To Min"].default_value = 0.0
    paint_gate.inputs["To Max"].default_value = 1.0
    paint_gate.clamp = True
    links.new(field_channel.outputs["Red"], paint_gate.inputs["Value"])

    paint_mix = nodes.new("ShaderNodeMixShader")
    links.new(paint_gate.outputs["Result"], paint_mix.inputs["Fac"])
    links.new(face_bsdf.outputs["BSDF"], paint_mix.inputs[1])
    links.new(paint_bsdf.outputs["BSDF"], paint_mix.inputs[2])

    # Transparent surround: alpha is 1 only where the carve/paint exists. The
    # outer lip fades over alphaRamp of the transition so it melts into the
    # shell face instead of ending on a hard decal rectangle.
    field_gate = nodes.new("ShaderNodeMapRange")
    field_gate.inputs["From Min"].default_value = 0.0
    field_gate.inputs["From Max"].default_value = carve["alphaRamp"]
    field_gate.inputs["To Min"].default_value = 0.0
    field_gate.inputs["To Max"].default_value = 1.0
    field_gate.clamp = True
    links.new(field_channel.outputs["Red"], field_gate.inputs["Value"])

    coverage = nodes.new("ShaderNodeMath")
    coverage.operation = "MAXIMUM"
    links.new(field_gate.outputs["Result"], coverage.inputs[0])
    links.new(paint_gate.outputs["Result"], coverage.inputs[1])
    coverage_output = coverage.outputs["Value"]

    # White fill islands (pinzu/souzu): keep them in the decal as *uncarved
    # ivory*, not white paint and not a transparent hole. The carve field is
    # zero there, so the geometry stays at the original surface; the coverage
    # below makes the face (ivory) material opaque over the island. The paint
    # gate is zero because the field is zero.
    if carve.get("whiteFillUncarved", False):
        threshold = float(carve.get("whiteFillThreshold", 0.9))
        separate_symbol = nodes.new("ShaderNodeSeparateColor")
        links.new(symbol_node.outputs["Color"], separate_symbol.inputs["Color"])
        min_rg = nodes.new("ShaderNodeMath")
        min_rg.operation = "MINIMUM"
        links.new(separate_symbol.outputs["Red"], min_rg.inputs[0])
        links.new(separate_symbol.outputs["Green"], min_rg.inputs[1])
        min_rgb = nodes.new("ShaderNodeMath")
        min_rgb.operation = "MINIMUM"
        links.new(min_rg.outputs["Value"], min_rgb.inputs[0])
        links.new(separate_symbol.outputs["Blue"], min_rgb.inputs[1])
        white_gate = nodes.new("ShaderNodeMapRange")
        white_gate.inputs["From Min"].default_value = max(0.0, threshold - 0.05)
        white_gate.inputs["From Max"].default_value = min(1.0, threshold + 0.03)
        white_gate.inputs["To Min"].default_value = 0.0
        white_gate.inputs["To Max"].default_value = 1.0
        white_gate.clamp = True
        links.new(min_rgb.outputs["Value"], white_gate.inputs["Value"])
        island_alpha = nodes.new("ShaderNodeMath")
        island_alpha.operation = "MULTIPLY"
        links.new(white_gate.outputs["Result"], island_alpha.inputs[0])
        links.new(symbol_node.outputs["Alpha"], island_alpha.inputs[1])
        coverage_with_island = nodes.new("ShaderNodeMath")
        coverage_with_island.operation = "MAXIMUM"
        links.new(coverage_output, coverage_with_island.inputs[0])
        links.new(island_alpha.outputs["Value"], coverage_with_island.inputs[1])
        coverage_output = coverage_with_island.outputs["Value"]

    # Display-only glare stamp: a small white hot core with a fast radial
    # falloff. A physical spot light cannot shape this falloff at the requested
    # angle (the flat-face mirror point leaves the tile), so this is baked into
    # the decal like a reflection. It is screen-locked by construction.
    stamp = decal_spec.get("glareStamps", {}).get(surface)
    base_shader = paint_mix.outputs["Shader"]
    stamp_mask_output = None
    if stamp and stamp.get("enabled", True):
        coord = nodes.new("ShaderNodeTexCoord")
        uv = nodes.new("ShaderNodeSeparateXYZ")
        links.new(coord.outputs["UV"], uv.inputs["Vector"])
        cx, cy = stamp["centerUv"]
        dx = nodes.new("ShaderNodeMath")
        dx.operation = "SUBTRACT"
        links.new(uv.outputs["X"], dx.inputs[0])
        dx.inputs[1].default_value = float(cx)
        dy = nodes.new("ShaderNodeMath")
        dy.operation = "SUBTRACT"
        links.new(uv.outputs["Y"], dy.inputs[0])
        dy.inputs[1].default_value = float(cy)
        dx2 = nodes.new("ShaderNodeMath")
        dx2.operation = "MULTIPLY"
        links.new(dx.outputs["Value"], dx2.inputs[0])
        links.new(dx.outputs["Value"], dx2.inputs[1])
        dy2 = nodes.new("ShaderNodeMath")
        dy2.operation = "MULTIPLY"
        links.new(dy.outputs["Value"], dy2.inputs[0])
        links.new(dy.outputs["Value"], dy2.inputs[1])
        dist2 = nodes.new("ShaderNodeMath")
        dist2.operation = "ADD"
        links.new(dx2.outputs["Value"], dist2.inputs[0])
        links.new(dy2.outputs["Value"], dist2.inputs[1])
        dist = nodes.new("ShaderNodeMath")
        dist.operation = "POWER"
        links.new(dist2.outputs["Value"], dist.inputs[0])
        dist.inputs[1].default_value = 0.5
        halo = float(stamp["haloRadiusUv"])
        hot = float(stamp["hotRadiusUv"])
        falloff = float(stamp["falloff"])
        # halo = (1 - d/halo)^falloff, clamped; 0 outside the halo.
        t = nodes.new("ShaderNodeMapRange")
        t.inputs["From Min"].default_value = 0.0
        t.inputs["From Max"].default_value = halo
        t.inputs["To Min"].default_value = 1.0
        t.inputs["To Max"].default_value = 0.0
        t.clamp = True
        links.new(dist.outputs["Value"], t.inputs["Value"])
        power = nodes.new("ShaderNodeMath")
        power.operation = "POWER"
        links.new(t.outputs["Result"], power.inputs[0])
        power.inputs[1].default_value = falloff
        core = nodes.new("ShaderNodeMapRange")
        core.inputs["From Min"].default_value = 0.0
        core.inputs["From Max"].default_value = hot
        core.inputs["To Min"].default_value = 1.0
        core.inputs["To Max"].default_value = 0.0
        core.clamp = True
        links.new(dist.outputs["Value"], core.inputs["Value"])
        mask = nodes.new("ShaderNodeMath")
        mask.operation = "MAXIMUM"
        links.new(power.outputs["Value"], mask.inputs[0])
        links.new(core.outputs["Result"], mask.inputs[1])
        strength = nodes.new("ShaderNodeMath")
        strength.operation = "MULTIPLY"
        links.new(mask.outputs["Value"], strength.inputs[0])
        strength.inputs[1].default_value = float(stamp.get("intensity", 1.0))
        # The stamp carries its own coverage: it must draw even where the glyph
        # is transparent (a glare on the tile face, not only inside the carve).
        stamp_mask_output = mask.outputs["Value"]
        stamp_emission = nodes.new("ShaderNodeEmission")
        stamp_emission.inputs["Color"].default_value = hex_linear(stamp.get("color", "#ffffff"))
        links.new(strength.outputs["Value"], stamp_emission.inputs["Strength"])
        add_stamp = nodes.new("ShaderNodeAddShader")
        links.new(paint_mix.outputs["Shader"], add_stamp.inputs[0])
        links.new(stamp_emission.outputs["Emission"], add_stamp.inputs[1])
        base_shader = add_stamp.outputs["Shader"]

    if stamp_mask_output is not None:
        coverage_with_stamp = nodes.new("ShaderNodeMath")
        coverage_with_stamp.operation = "MAXIMUM"
        links.new(coverage_output, coverage_with_stamp.inputs[0])
        links.new(stamp_mask_output, coverage_with_stamp.inputs[1])
        coverage_output = coverage_with_stamp.outputs["Value"]

    transparent = nodes.new("ShaderNodeBsdfTransparent")
    final_mix = nodes.new("ShaderNodeMixShader")
    links.new(coverage_output, final_mix.inputs["Fac"])
    links.new(transparent.outputs["BSDF"], final_mix.inputs[1])
    links.new(base_shader, final_mix.inputs[2])
    output_node = nodes["Material Output"]
    links.new(final_mix.outputs["Shader"], output_node.inputs["Surface"])
    return material


# --------------------------------------------------------------------------- #
# Scene: camera and decal light rig
# --------------------------------------------------------------------------- #


def stand_face_plane(obj: bpy.types.Object, shell_spec: dict) -> None:
    """Stand the local XY face plane up at world y=0, facing the camera."""
    tile = shell_spec["tile"]
    rotation = Matrix.Rotation(math.radians(90.0), 4, "X")
    location = Vector((0.0, tile["thickness"], tile["height"] / 2.0))
    obj.matrix_world = Matrix.Translation(location) @ rotation


def build_decal_lights(
    scene: bpy.types.Scene,
    shell_spec: dict,
    decal_spec: dict,
    light_rotation_deg: int,
    surface: str,
) -> None:
    """The surface's light rig, translated to the canonical face and rotated."""
    lighting = decal_spec["lighting"][surface]
    tile = shell_spec["tile"]
    old_slot_y = float(lighting["translation"]["fromSlotY"])
    translate = Vector((0.0, -old_slot_y, 0.0))
    # The decal face stands at world y=0, facing the camera at -Y. Rotate the
    # rig around the FACE NORMAL, not world Z: a world-Z rotation sends the key
    # behind a vertical face at 90/180 and leaves the carving flat. The face
    # normal is -Y after stand_face_plane.
    axis = Vector((0.0, -1.0, 0.0))
    center = Vector((0.0, 0.0, tile["height"] / 2.0))
    frame = lighting.get("frame", "world")
    for entry in lighting["lights"]:
        light_type = entry.get("type", "AREA")
        data = bpy.data.lights.new(entry["id"], light_type)
        if light_type == "AREA":
            data.shape = "RECTANGLE"
            data.size = entry["size"]
            data.size_y = entry["sizeY"]
        elif light_type == "POINT":
            # A finite-distance point source gives a local specular hotspot on
            # a flat face instead of the whole-face wash of a large area light.
            data.shadow_soft_size = float(entry.get("shadowSoftSize", 0.1))
        elif light_type == "SPOT":
            data.shadow_soft_size = float(entry.get("shadowSoftSize", 0.1))
            data.spot_size = float(entry.get("spotSizeDeg", 30.0)) * math.pi / 180.0
            data.spot_blend = float(entry.get("spotBlend", 0.3))
        else:
            die(f"decal light {entry['id']} has unsupported type {light_type}")
        data.energy = entry["energyW"]
        data.color = hex_linear(entry["hex"])[:3]
        # Glare experiments use specular-only lights: a white reflection
        # without a diffuse wash that would flatten the carve.
        data.diffuse_factor = float(entry.get("diffuseFactor", 1.0))
        data.specular_factor = float(entry.get("specularFactor", 1.0))
        if frame == "face-normal":
            # Room light expressed in the tile's face frame: aroundDeg turns
            # around the face normal, tiltDeg is the angle from the normal.
            target = center + Vector(entry["target"])
            around = math.radians(entry["aroundDeg"])
            tilt = math.radians(entry["tiltDeg"])
            direction = Vector(
                (
                    math.sin(tilt) * math.sin(around),
                    -math.cos(tilt),
                    math.sin(tilt) * math.cos(around),
                )
            )
        else:
            target = Vector(entry["target"]) + translate
            azimuth = math.radians(entry["azimuthDeg"])
            elevation = math.radians(entry["elevationDeg"])
            direction = Vector(
                (
                    math.sin(azimuth) * math.cos(elevation),
                    -math.cos(azimuth) * math.cos(elevation),
                    math.sin(elevation),
                )
            )
        location = target + direction * entry["distance"]
        target = rotate_about_axis(target, center, axis, light_rotation_deg)
        location = rotate_about_axis(location, center, axis, light_rotation_deg)
        obj = new_object(entry["id"], data)
        obj.location = location
        aim(obj, target)
        roll = entry.get("rollDeg", 0.0)
        if roll:
            obj.matrix_world = obj.matrix_world @ Matrix.Rotation(math.radians(roll), 4, "Z")
        obj["group"] = entry.get("group", "key")


def build_decal_camera(
    scene: bpy.types.Scene,
    shell_spec: dict,
    decal_spec: dict,
    geometry: dict,
    surface: str,
) -> bpy.types.Object:
    tile = shell_spec["tile"]
    camera_data = bpy.data.cameras.new("decal-camera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = geometry["frameH"]
    camera_data.clip_start = 0.1
    camera_data.clip_end = 200.0
    camera = new_object("decal-camera", camera_data)
    distance = float(decal_spec["lighting"][surface]["translation"].get("cameraDistance", 5.0))
    target = Vector((0.0, 0.0, tile["height"] / 2.0))
    camera.location = Vector((0.0, -distance, tile["height"] / 2.0))
    aim(camera, target)
    scene.camera = camera
    return camera


def build_decal_world(scene: bpy.types.Scene, decal_spec: dict, surface: str) -> None:
    world_spec = decal_spec["lighting"][surface]["world"]
    world = bpy.data.worlds.new("decal-world")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = hex_linear(world_spec["hex"])
    background.inputs["Strength"].default_value = world_spec["strength"]
    scene.world = world


# --------------------------------------------------------------------------- #
# Measurement and manifest
# --------------------------------------------------------------------------- #


def measure(rgba_u8: np.ndarray) -> dict:
    alpha = rgba_u8[..., 3].astype(np.float64) / 255.0
    height, width = alpha.shape
    mask = alpha > (8.0 / 255.0)
    alpha_pixels = int(mask.sum())
    if alpha_pixels == 0:
        die("decal render has no visible pixels")
    ys, xs = np.nonzero(mask)
    bbox = {
        "left": int(xs.min()),
        "top": int(ys.min()),
        "right": int(xs.max()),
        "bottom": int(ys.max()),
    }
    rgb = rgba_u8[..., :3].astype(np.int32)
    red = int(((rgb[..., 0] > rgb[..., 1] + 40) & (rgb[..., 0] > rgb[..., 2] + 40) & mask).sum())
    luma = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    saturation = rgb.max(axis=-1) - rgb.min(axis=-1)
    ink_mask = ((saturation > 24) | (luma < 150)) & mask & (alpha > 0.5)
    ink = int(ink_mask.sum())
    ink_ys, ink_xs = np.nonzero(ink_mask)
    ink_bbox = (
        {
            "left": int(ink_xs.min()),
            "top": int(ink_ys.min()),
            "right": int(ink_xs.max()),
            "bottom": int(ink_ys.max()),
        }
        if ink_xs.size
        else None
    )
    corners = [
        int(rgba_u8[0, 0, 3]),
        int(rgba_u8[0, width - 1, 3]),
        int(rgba_u8[height - 1, 0, 3]),
        int(rgba_u8[height - 1, width - 1, 3]),
    ]
    if any(corner != 0 for corner in corners):
        die(f"decal corners are not transparent: {corners}; option A requires a carve-only decal")
    return {
        "width": width,
        "height": height,
        "alphaBBox": bbox,
        "alphaPixels": alpha_pixels,
        "transparentFraction": round(1.0 - alpha_pixels / (width * height), 5),
        "inkPixels": ink,
        "inkBBox": ink_bbox,
        "redPixels": red,
        "cornerAlpha": corners,
    }


def bake_one(
    shell_spec: dict,
    decal_spec: dict,
    faces_spec: dict,
    face: str,
    surface: str,
    light_rotation_deg: int,
    symbol_rotation_deg: int,
    symbol_path: Path,
    output_path: Path,
    field_dir: Path,
) -> dict:
    if symbol_rotation_deg != 0:
        die("symbol rotations other than 0 are not implemented yet")
    if not symbol_path.exists():
        die(f"{symbol_path} is missing; run node tools/render/scripts/bake-faces.mjs first")

    geometry = decal_geometry(shell_spec, decal_spec)
    tile = shell_spec["tile"]
    scene = reset_scene()
    configure_render(scene, shell_spec)
    preview_samples = decal_spec.get("previewSamples")
    if preview_samples:
        scene.cycles.samples = int(preview_samples)
    build_decal_world(scene, decal_spec, surface)
    scene.render.resolution_x = geometry["width"]
    scene.render.resolution_y = geometry["height"]
    scene.render.resolution_percentage = 100
    build_decal_lights(scene, shell_spec, decal_spec, light_rotation_deg, surface)
    build_decal_camera(scene, shell_spec, decal_spec, geometry, surface)

    field_path = field_dir / f"{face}-field.png"
    field = carve_field(symbol_path, decal_spec, geometry, field_path)

    material = decal_material(shell_spec, decal_spec, symbol_path, field_path, surface)
    half_w = tile["width"] / 2.0 - tile["faceInset"]
    half_h = tile["height"] / 2.0 - tile["faceInset"]
    # Map the FULL upstream symbol canvas (300 x 400) onto the inset face
    # plate. Cropping the glyph to the faceInset sub-rect (the old mapping)
    # enlarged every symbol and cut the pinzu/manzu strokes that reach the
    # canvas edge; the full canvas keeps the same relative size as the flat
    # glyph and fits every face.
    u0, v0, u1, v1 = 0.0, 0.0, 1.0, 1.0
    plane = build_carved_face(
        shell_spec,
        decal_spec,
        material,
        field,
        half_w,
        half_h,
        tile["thickness"],
        (u0, v0, u1, v1),
        (geometry["width"], geometry["height"]),
    )
    stand_face_plane(plane, shell_spec)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    render_pass(scene, output_path)
    rgba = load_rgba(output_path)
    decoded = quantize(rgba)
    measured = measure(decoded)
    log(
        f"decal {face} {surface} l{light_rotation_deg} s{symbol_rotation_deg}: "
        f"{geometry['width']}x{geometry['height']}, "
        f"alpha {measured['alphaPixels']} px, ink {measured['inkPixels']} px, "
        f"{output_path.stat().st_size} B"
    )
    return {
        "face": face,
        "surface": surface,
        "lightRotationDeg": light_rotation_deg,
        "symbolRotationDeg": symbol_rotation_deg,
        "textureFile": f"decals/{output_path.name}",
        "width": geometry["width"],
        "height": geometry["height"],
        "facePlateRect": [round(value, 8) for value in geometry["facePlateRect"]],
        "bytes": output_path.stat().st_size,
        "sha256": {"decodedRgba": rgba_sha256(decoded)},
        "measured": measured,
    }


def verify_determinism(
    shell_spec: dict,
    decal_spec: dict,
    face: str,
    surface: str,
    light_rotation_deg: int,
    symbol_rotation_deg: int,
    symbol_path: Path,
    output_path: Path,
    field_dir: Path,
) -> None:
    first = load_rgba(output_path)
    second_path = output_path.with_name(output_path.stem + "-repeat.png")
    bake_one(
        shell_spec,
        decal_spec,
        {},
        face,
        surface,
        light_rotation_deg,
        symbol_rotation_deg,
        symbol_path,
        second_path,
        field_dir,
    )
    second = load_rgba(second_path)
    second_path.unlink(missing_ok=True)
    if not np.array_equal(quantize(first), quantize(second)):
        die(f"{face} l{light_rotation_deg} is not deterministic across renders")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main(argv: list[str]) -> int:
    options = parse_options(argv)
    spec_path = Path(options["spec"]) if options.get("spec") else RENDER_DIR / "decal-spec.json"
    if not spec_path.is_absolute():
        spec_path = RENDER_DIR / spec_path
    decal_spec = read_json(spec_path)
    shell_spec = read_json(RENDER_DIR / "shell-spec.json")
    faces_spec = read_json(RENDER_DIR / decal_spec["source"]["facesSpec"])
    check_blender_version(decal_spec)
    resolve_tile_dimensions(shell_spec)

    geometry = decal_geometry(shell_spec, decal_spec)
    log(
        f"decal frame {geometry['width']}x{geometry['height']} px, "
        f"{geometry['pxPerUnit']:.3f} px/unit, face plate "
        f"{geometry['frameW']:.3f} x {geometry['frameH']:.3f} units"
    )

    faces = [entry["id"] for entry in faces_spec["faces"]]
    all_faces = list(faces)
    if options["spike"]:
        faces = list(decal_spec["spike"]["faces"])
    if options["spike"] or options["build"]:
        output_dir = RENDER_DIR / decal_spec["output"]["buildDir"]
        manifest_path = RENDER_DIR / decal_spec["output"]["buildManifest"]
    else:
        output_dir = RENDER_DIR / decal_spec["output"]["dir"]
        manifest_path = RENDER_DIR / decal_spec["output"]["manifest"]
    if options["only"]:
        missing = [face for face in options["only"] if face not in all_faces]
        if missing:
            die(f"unknown face(s) {missing}")
        faces = options["only"]
    surfaces = options["surface"] or list(decal_spec.get("surfaces", ["upright", "lying"]))
    allowed_surfaces = list(decal_spec.get("surfaces", ["upright", "lying"]))
    unknown = [surface for surface in surfaces if surface not in allowed_surfaces]
    if unknown:
        die(f"unknown surface(s) {unknown}; expected {allowed_surfaces}")
    surface_rotations = {}
    for surface in surfaces:
        rotations = options["rotations"] or list(
            decal_spec.get("surfaceRotations", {}).get(surface, decal_spec["rotations"])
        )
        if any(rotation % 90 != 0 for rotation in rotations):
            die(f"{surface} rotations must be multiples of 90: {rotations}")
        surface_rotations[surface] = [normalize_rotation(rotation) for rotation in rotations]
    rotations = sorted({rotation for values in surface_rotations.values() for rotation in values})
    symbol_rotations = list(decal_spec.get("symbolRotations", [0]))

    symbol_dir = (RENDER_DIR / decal_spec["source"]["symbolDir"]).resolve()
    inkless = []
    for face in faces:
        symbol_path = symbol_dir / f"{face}.png"
        if not symbol_path.exists():
            die(f"{symbol_path} is missing; run node tools/render/scripts/bake-faces.mjs first")
        if load_rgba(symbol_path)[..., 3].max() <= 0.0:
            inkless.append(face)
    if inkless:
        log(f"skipping inkless faces (no carve, bare shell): {', '.join(inkless)}")
        faces = [face for face in faces if face not in inkless]
    if not faces:
        log("no inked faces to bake")
        return 0

    plan = [
        (face, surface, rotation, symbol_rotation)
        for face in faces
        for surface in surfaces
        for rotation in surface_rotations[surface]
        for symbol_rotation in symbol_rotations
    ]
    log(
        f"plan: {len(plan)} decals ({len(faces)} faces; "
        + ", ".join(f"{surface} {surface_rotations[surface]}" for surface in surfaces)
        + f"; {len(symbol_rotations)} symbol rotations) -> {output_dir}"
    )
    if options["dryRun"]:
        for face, surface, rotation, symbol_rotation in plan:
            log(f"  {face} {surface} light {rotation} symbol {symbol_rotation}")
        return 0

    output_dir.mkdir(parents=True, exist_ok=True)
    field_dir = RENDER_DIR / decal_spec["output"]["buildDir"] / "fields"
    field_dir.mkdir(parents=True, exist_ok=True)
    records: dict[str, dict] = {}
    total_bytes = 0
    for index, (face, surface, rotation, symbol_rotation) in enumerate(plan, start=1):
        symbol_path = symbol_dir / f"{face}.png"
        output_path = output_dir / f"{face}-{surface}-l{rotation}.png"
        log(f"[{index}/{len(plan)}] {face} {surface} light {rotation}")
        record = bake_one(
            shell_spec,
            decal_spec,
            faces_spec,
            face,
            surface,
            rotation,
            symbol_rotation,
            symbol_path,
            output_path,
            field_dir,
        )
        if options["verifyDeterminism"]:
            verify_determinism(
                shell_spec,
                decal_spec,
                face,
                surface,
                rotation,
                symbol_rotation,
                symbol_path,
                output_path,
                field_dir,
            )
        key = f"{face}:{surface}:l{rotation}:s{symbol_rotation}"
        records[key] = record
        total_bytes += record["bytes"]

    manifest = {
        "version": 1,
        "generatedBy": "tools/render/bake_decals.py",
        "coordinateSpace": (
            "Each textureFile is the inset face plate at raster.scale times the "
            "@1x face. It is mapped into the shell's faceQuad (face-local order) "
            "with symbolRotationDeg applied inside the plate; the quad applies "
            "the tile's rotation. lightRotationDeg is the baked rig rotation, "
            "chosen so the light lands top-left on screen after that rotation. "
            "facePlateRect is the normalized sub-rect of the decal that maps to "
            "the face plate; the 4 px safety ring is outside it. surface selects "
            "the separate upright or lying light rig."
        ),
        "source": {
            "facesSpec": decal_spec["source"]["facesSpec"],
            "shellSpec": decal_spec["source"]["shellSpec"],
            "symbolDir": decal_spec["source"]["symbolDir"],
            "upstream": faces_spec["source"],
        },
        "raster": {
            "width": geometry["width"],
            "height": geometry["height"],
            "scale": decal_spec["raster"]["scale"],
            "format": decal_spec["raster"]["format"],
            "pxPerUnit": round(geometry["pxPerUnit"], 6),
            "frameUnits": [round(geometry["frameW"], 6), round(geometry["frameH"], 6)],
        },
        "carve": decal_spec["carve"],
        "lighting": {
            surface: {
                "preset": decal_spec["lighting"][surface]["preset"],
                "rotationConvention": decal_spec["lighting"][surface]["rotationConvention"],
                "world": decal_spec["lighting"][surface]["world"],
                "translation": decal_spec["lighting"][surface]["translation"],
                "lights": decal_spec["lighting"][surface]["lights"],
            }
            for surface in surfaces
        },
        "surfaces": surfaces,
        "surfaceRotations": surface_rotations,
        "rotations": rotations,
        "symbolRotations": symbol_rotations,
        "budget": {"bytes": decal_spec["output"]["bytesBudget"]},
        "totals": {
            "decals": len(records),
            "faces": len(faces),
            "surfaces": len(surfaces),
            "lightRotations": len(rotations),
            "surfaceRotations": surface_rotations,
            "symbolRotations": len(symbol_rotations),
            "bytes": total_bytes,
        },
        "decals": records,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    log(
        f"wrote {len(records)} decals ({total_bytes} B) to {output_dir} and "
        f"{manifest_path}"
    )
    if options["spike"] or options["build"]:
        budget = int(decal_spec["output"].get("buildBytesBudget", decal_spec["output"]["bytesBudget"]))
    else:
        budget = int(decal_spec["output"]["bytesBudget"])
    if total_bytes > budget:
        die(f"decal bytes {total_bytes} exceed the budget {budget}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]))
