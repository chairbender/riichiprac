/**
 * The physical compass square (3D-09): a flat lacquer panel inlaid in the
 * table's centre, under the DOM compass text.
 *
 * The user's rule (2026-11-19): the **square** is table furniture and must obey
 * the camera like everything else on the felt — it is real geometry, drawn in
 * perspective. Only the numbers and glyphs are DOM, superimposed in screen
 * space so they never foreshorten. The 2.5D compass panel's own dark face is
 * what this plate reproduces in 3D, so the two views still read as siblings.
 *
 * It is one mesh and one draw call: a rounded, slightly bevelled slab whose
 * footprint is exactly the 4-unit compass well, built from an extruded `Shape`
 * in core three (no addons, no new asset, no texture). Its top is 2.2 mm above
 * the felt, low enough to read as an inlay and low enough that no pond tile can
 * meet it.
 */

import {
  ExtrudeGeometry,
  Mesh,
  MeshStandardMaterial,
  Shape,
} from 'three';
import { TABLE } from '../layoutConstants';

/** The plate's committed numbers. */
export const COMPASS_PLATE = {
  /** Exactly the compass well: the square the text is laid over. */
  sizeUnits: TABLE.compassWellUnits,
  /** Rounded corners, so it reads as a finished panel rather than a cut slab. */
  cornerRadiusUnits: 0.28,
  /** 2.24 mm proud of the felt: an inlay, not a tray. */
  thicknessUnits: 0.08,
  /** The small chamfer on both faces. */
  bevelUnits: 0.015,
  /** Lacquer face: the 2.5D compass panel's colour (`#171c24`), a shade deeper. */
  topColor: '#151b23',
  roughness: 0.46,
  metalness: 0,
} as const;

/**
 * The plate's outline as a rounded square centred on the origin, in the shape
 * plane. Pure, so a test can assert its extent without a GPU.
 */
export function compassPlateShape(
  sizeUnits: number = COMPASS_PLATE.sizeUnits,
  cornerRadiusUnits: number = COMPASS_PLATE.cornerRadiusUnits,
): Shape {
  const half = sizeUnits / 2;
  const radius = Math.min(cornerRadiusUnits, half);
  const shape = new Shape();
  shape.moveTo(-half + radius, -half);
  shape.lineTo(half - radius, -half);
  shape.quadraticCurveTo(half, -half, half, -half + radius);
  shape.lineTo(half, half - radius);
  shape.quadraticCurveTo(half, half, half - radius, half);
  shape.lineTo(-half + radius, half);
  shape.quadraticCurveTo(-half, half, -half, half - radius);
  shape.lineTo(-half, -half + radius);
  shape.quadraticCurveTo(-half, -half, -half + radius, -half);
  return shape;
}

/** The live compass plate: one mesh, disposable with the board. */
export interface CompassPlate {
  readonly mesh: Mesh;
  dispose(): void;
}

/**
 * Build the compass plate: a rounded slab lying flat on the felt, its bottom at
 * y = 0 and its footprint centred on the table's origin.
 *
 * The extruded shape is authored in XY and pushed along +Z; one -90° turn about
 * X lays it on the felt (+Z becomes +Y), and the translation puts the lowest
 * point — the bevel, not the face — exactly at y = 0.
 */
export function createCompassPlate(): CompassPlate {
  const geometry = new ExtrudeGeometry(compassPlateShape(), {
    depth: COMPASS_PLATE.thicknessUnits,
    bevelEnabled: true,
    bevelThickness: COMPASS_PLATE.bevelUnits,
    bevelSize: COMPASS_PLATE.bevelUnits,
    bevelSegments: 2,
    curveSegments: 10,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingBox();
  const bottom = geometry.boundingBox?.min.y ?? 0;
  if (bottom !== 0) geometry.translate(0, -bottom, 0);
  geometry.computeBoundingSphere();

  const material = new MeshStandardMaterial({
    name: 'compass-plate',
    color: COMPASS_PLATE.topColor,
    roughness: COMPASS_PLATE.roughness,
    metalness: COMPASS_PLATE.metalness,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'compass-plate';

  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
