#!/usr/bin/env python3
"""Export the runtime table layout (Task 3 of the 2.5D implementation plan).

Run inside the pinned Blender:

    ~/.local/opt/blender-4.5.9/blender --background \
        --python tools/render/bake_table_layout.py -- --rig [--variant NAME]

The scene, the ``SlotAnchors`` collection and the camera are the same objects
Task 1 and Task 2 build (``bake_table_reference.py``); this script only
projects them. It runs in the rig mode of the chosen variant, so the exported
anchors are the variant's hand/meld/pond/wall placements seen through the
variant's perspective camera, not a second layout.

Outputs:

  - ``frontend/public/table/table_layout.json`` — the runtime contract:
    ``referenceResolution`` and a ``slots`` array of
    ``{id, zone, seat, row, col, anchor, depth, scale, bucket, faceQuad}``;
  - ``tools/render/reference/layout/probes-1x.png`` — one emissive marker per
    anchor, rendered alone at 1920 x 1080 RGBA. The committed proof measures
    each marker's alpha centroid against the export to prove the coordinates
    land on the rendered tile centres within one pixel;
  - ``tools/render/build/layout/layout-plan.json`` — the bucket plan and the
    resolved camera for a run, so a re-run can be diffed.

``--dry-run`` builds and prints the plan but writes nothing. ``--no-probe``
skips the probe render while iterating on the JSON. The script is idempotent:
slots are sorted by id, numbers are rounded by ``layout.rounding`` and the probe
render is deterministic at the pixel level (seed 0, CPU Cycles, emission only);
Blender's PNG container metadata can differ between runs, but the decoded RGBA
does not.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

RENDER_DIR = Path(__file__).resolve().parent
if str(RENDER_DIR) not in sys.path:
    sys.path.insert(0, str(RENDER_DIR))

import bake_table_reference as reference  # noqa: E402
import table_layout  # noqa: E402
from bake_shells import die, log  # noqa: E402

REPO_ROOT = RENDER_DIR.parent.parent


def parse_layout_options(argv: list[str]) -> dict:
    """The reference parser plus the layout-only probe switch."""
    probe = "--no-probe" not in argv
    options = reference.parse_options([arg for arg in argv if arg != "--no-probe"])
    if not options["rig"]:
        die("bake_table_layout: pass --rig (the layout is exported for the rig camera)")
    options["probe"] = probe
    return options


def main() -> None:
    options = parse_layout_options(reference.blender_args())
    spec = reference.read_json(reference.SPEC_PATH)
    layout_spec = spec.get("layout")
    if not layout_spec:
        die("bake_table_layout: table-reference-spec.json has no layout block")
    if layout_spec.get("collection") != spec["anchors"]["collection"]:
        die("bake_table_layout: layout.collection disagrees with anchors.collection")

    variant_id, variant, scene_spec = reference.resolve_variant(spec, options["variant"])
    log(f"layout variant: {variant_id} — {variant.get('label', '')}")

    scene, scene_data, _shell_spec = reference.build_scene(scene_spec, options)
    rig = scene_spec["rig"]
    resolution = list(rig["output"]["resolution"])
    if resolution != list(layout_spec["referenceResolution"]):
        die(
            "bake_table_layout: the rig renders "
            f"{resolution[0]}x{resolution[1]} but the layout reference frame is "
            f"{layout_spec['referenceResolution']}"
        )

    camera = reference.camera_from_candidate(rig["camera"], resolution)
    scene.render.resolution_x = resolution[0]
    scene.render.resolution_y = resolution[1]
    scene.render.resolution_percentage = 100
    reference.build_camera_object(scene, camera)

    collection = bpy_collection(scene_data["anchorCollection"])
    layout = table_layout.project_table_layout(
        scene, collection, camera, layout_spec, resolution, variant_id
    )
    counts: dict[str, int] = {}
    for slot in layout["slots"]:
        counts[slot["zone"]] = counts.get(slot["zone"], 0) + 1
    expected = spec["anchors"]["counts"]
    for zone in ("wall", "river", "meld", "hand"):
        if counts.get(zone) != expected[zone]:
            die(f"layout: {zone} slots {counts.get(zone)} != spec {expected[zone]}")
    if len(layout["slots"]) != expected["total"]:
        die(f"layout: {len(layout['slots'])} slots != spec {expected['total']}")

    log(
        f"layout: {len(layout['slots'])} slots in {collection}; "
        f"reference {layout['reference']['slot']} depth {layout['reference']['depth']:.6f}; "
        f"projection delta {layout['projectionDeltaPx']:.6f} px"
    )
    log("layout buckets:\n" + table_layout.bucket_table(layout))

    if options["dryRun"]:
        log("layout dry run: nothing written")
        return

    default_variant = spec["rig"]["defaultVariant"]
    is_default = variant_id == default_variant
    if is_default:
        output = REPO_ROOT / layout_spec["output"]
        probe_dir = RENDER_DIR / layout_spec["proof"]["directory"]
    else:
        # A/B variant: never touch the committed runtime contract.
        build_dir = RENDER_DIR / "build" / "layout" / variant_id
        output = build_dir / "table_layout.json"
        probe_dir = build_dir
    table_layout.write_layout(layout, output)
    log(f"layout JSON: {output}")

    plan = {
        "version": 1,
        "generatedBy": "tools/render/bake_table_layout.py",
        "variant": variant_id,
        "defaultVariant": default_variant,
        "resolution": resolution,
        "camera": camera,
        "reference": layout["reference"],
        "bucketCatalogue": layout["bucketCatalogue"],
        "slots": len(layout["slots"]),
        "output": str(output.relative_to(REPO_ROOT)) if is_default else str(output),
        "render": rig["output"]["renderPattern"].format(width=resolution[0]),
    }
    build_dir = RENDER_DIR / "build" / "layout"
    build_dir.mkdir(parents=True, exist_ok=True)
    (build_dir / "layout-plan.json").write_text(json.dumps(plan, indent=1) + "\n")

    if options["probe"]:
        probe_path = probe_dir / layout_spec["proof"]["probes"]
        records = table_layout.read_anchors(collection)
        table_layout.render_anchor_probes(
            scene, records, resolution, probe_path, layout_spec["probe"]
        )
    else:
        log("layout probe: skipped (--no-probe)")


def bpy_collection(name: str):
    import bpy

    collection = bpy.data.collections.get(name)
    if collection is None:
        die(f"bake_table_layout: collection {name!r} is missing")
    return collection


if __name__ == "__main__":
    main()
