import { describe, expect, it } from 'vitest';
import {
  CAMERA,
  COMPASS_PLATE,
  DORA,
  HAND,
  LIGHT,
  MELD,
  POND,
  SEATS,
  STICK,
  TABLE,
  TILE,
  TILE_MM,
  UNIT_MM,
  WALL,
} from './layoutConstants';

describe('3D layout constants: tile and table', () => {
  it('uses the committed 28 x 21 x 16.5 mm tile at 1 unit = 28 mm', () => {
    expect(TILE_MM).toEqual({ height: 28, width: 21, thickness: 16.5 });
    expect(UNIT_MM).toBe(28);
    expect(TILE.heightUnits).toBe(1);
    expect(TILE.widthUnits).toBeCloseTo(21 / 28, 12);
    expect(TILE.thicknessUnits).toBeCloseTo(16.5 / 28, 12);
    expect(TILE.thicknessUnits * UNIT_MM).toBeCloseTo(16.5, 12);
  });

  it('carries the committed shell bevel and carved face plate', () => {
    expect(TILE.bevelUnits).toBe(0.055);
    expect(TILE.facePlateWidthUnits).toBeCloseTo(17.92 / 28, 12);
    expect(TILE.facePlateHeightUnits).toBeCloseTo(24.92 / 28, 12);
    expect(TILE.facePlateWidthUnits * UNIT_MM).toBeCloseTo(17.92, 12);
    expect(TILE.facePlateHeightUnits * UNIT_MM).toBeCloseTo(24.92, 12);
    // The plate plus two bevel insets stays inside the 21 mm body.
    expect(TILE.facePlateWidthUnits + 2 * TILE.bevelUnits).toBeLessThanOrEqual(
      TILE.widthUnits,
    );
  });

  it('draws a 700 mm square mat with a 4-unit compass well', () => {
    expect(TABLE.matSizeUnits * UNIT_MM).toBeCloseTo(700, 9);
    expect(TABLE.matSizeUnits).toBe(25);
    expect(TABLE.compassWellUnits).toBe(4);
  });
});

describe('3D layout constants: seats', () => {
  it('turns the four seats in turn order from the human', () => {
    expect(SEATS.count).toBe(4);
    expect(SEATS.relativeRotationDeg).toEqual([0, 90, 180, 270]);
  });
});

describe('3D layout constants: wall', () => {
  it('is four runs of 17 stacks, two tiers, on a derived ring', () => {
    expect(WALL.runs).toBe(4);
    expect(WALL.stacksPerRun).toBe(17);
    expect(WALL.tiers).toBe(2);
    expect(WALL.slotsPerRun).toBe(34);
    // No gap constant: a side run's inner face lands exactly on an end run's
    // end tile, which is what closes the ring's corners.
    expect(WALL.radiusUnits).toBeCloseTo(6.875, 12);
    expect(WALL.radiusUnits - TILE.heightUnits / 2).toBeCloseTo(
      WALL.runHalfLengthUnits,
      12,
    );
  });

  it('spaces stacks by exactly one tile, so runs and tiers touch', () => {
    expect(WALL.stackPitchUnits).toBe(TILE.widthUnits);
    expect(WALL.tierStepUnits).toBe(TILE.thicknessUnits);
    expect(WALL.runSpanUnits).toBeCloseTo(17 * 0.75, 12);
  });

  it('squares the ring: the end runs are inset, the side runs are not', () => {
    // A run's end tile reaches `runHalfLengthUnits` from the table centre line.
    expect(WALL.runHalfLengthUnits).toBeCloseTo(
      ((WALL.stacksPerRun - 1) / 2) * WALL.stackPitchUnits + TILE.widthUnits / 2,
      12,
    );
    expect(WALL.runHalfLengthUnits).toBeCloseTo(6.375, 12);
    // The front/back runs' outer face is flush with a side run's end tile, so
    // the ring's front and back edges line up with the side walls.
    expect(WALL.endRunRadiusUnits).toBeCloseTo(
      WALL.runHalfLengthUnits - TILE.heightUnits / 2,
      12,
    );
    expect(
      WALL.endRunRadiusUnits + TILE.heightUnits / 2 - WALL.runHalfLengthUnits,
    ).toBeCloseTo(0, 12);
    // The inset is exact: the end runs' outer faces *are* the side runs' inner
    // faces, so the ring's corners share an edge rather than a slot.
    expect(WALL.radiusUnits - TILE.heightUnits / 2).toBeCloseTo(
      WALL.endRunRadiusUnits + TILE.heightUnits / 2,
      12,
    );
    expect(WALL.endRunRadiusUnits).toBeLessThan(WALL.radiusUnits);
  });

  it('reserves a 7-stack dead wall on the far run\u2019s draw-end half', () => {
    expect(WALL.drawEndSlot).toBe(16);
    expect(WALL.deadWallStacks).toBe(7);
    expect(WALL.deadWallStartStack).toBe(10);
    expect(WALL.deadWallTiles).toBe(14);
    // A deliberate break, wider than the layout gate's 1.4 mm slot threshold.
    expect(WALL.deadWallGapUnits).toBeCloseTo(0.3, 12);
    expect(WALL.deadWallGapUnits).toBeGreaterThan(0.05);
  });

  it('leaves 61 live stacks (122 tiles) beside the 14 dead ones', () => {
    expect(WALL.liveWallStacks).toBe(61);
    expect(WALL.liveWallStacks).toBe(
      WALL.runs * WALL.stacksPerRun - WALL.deadWallStacks,
    );
    expect(WALL.liveWallTiles).toBe(122);
    expect(WALL.liveWallTiles + WALL.deadWallTiles).toBe(136);
    // The deal is off the wall before any decision exists.
    expect(WALL.maxDecisionLiveTiles).toBe(70);
    expect(WALL.maxDecisionLiveTiles).toBeLessThan(WALL.liveWallTiles);
  });
});

describe('3D layout constants: pond', () => {
  it('is a 3 x 6 pond plus four overflow anchors', () => {
    expect(POND.columns).toBe(6);
    expect(POND.rows).toBe(3);
    expect(POND.overflowColumns).toBe(4);
    expect(POND.capacity).toBe(22);
    expect(POND.rowRadiiUnits).toHaveLength(POND.rows);
  });

  it('spaces rows and columns by exactly one tile, so a pond is closed', () => {
    expect(POND.columnPitchUnits).toBe(TILE.widthUnits);
    expect(POND.rowPitchUnits).toBe(TILE.heightUnits);
    expect(POND.columnGapUnits).toBe(0);
    expect(POND.columnCentreOffsetUnits).toBeCloseTo(1.875, 12);
    // Row 0 is nearest the player; the rows advance toward the table centre by
    // one tile height each.
    expect(POND.rowRadiiUnits[0]).toBe(4.81);
    expect(POND.rowRadiiUnits[1]).toBeCloseTo(3.81, 12);
    expect(POND.rowRadiiUnits[2]).toBeCloseTo(2.81, 12);
    expect(POND.rowRadiiUnits[0] - POND.rowRadiiUnits[1]).toBeCloseTo(
      TILE.heightUnits,
      12,
    );
  });
});

describe('3D layout constants: human hand', () => {
  it('is 13 concealed tiles plus a separated draw slot', () => {
    expect(HAND.concealedCount).toBe(13);
    expect(HAND.pitchUnits).toBe(TILE.widthUnits);
    expect(HAND.drawGapUnits).toBe(0.2625);
    // Six pitches + a half tile + the tsumogiri gap + a half tile.
    expect(HAND.drawOffsetUnits).toBeCloseTo(6 * 0.75 + 0.75 + 0.2625, 12);
    // The board handoff (2026-11-18) moved the hand in from the reference's
    // 10.6. Its floor is a *side* run's outer face, because a side run occupies
    // the band beside the hand: radius + tileHeight / 2 + wallGapUnits.
    expect(HAND.backRadiusUnits).toBeCloseTo(
      WALL.radiusUnits + TILE.heightUnits / 2 + HAND.wallGapUnits,
      12,
    );
    expect(HAND.backRadiusUnits).toBeCloseTo(8.225, 12);
    expect(HAND.wallGapUnits).toBeGreaterThan(0.5);
    expect(HAND.wallGapUnits).toBeLessThan(1.2);
    // The near wall is an inset end run, so it sits further behind the hand.
    expect(HAND.backRadiusUnits).toBeGreaterThan(
      WALL.endRunRadiusUnits + TILE.heightUnits / 2,
    );
  });

  it('uses the signed-off 40\u00b0 recline with a numeric readability gate', () => {
    expect(HAND.reclineDeg).toBe(40);
    expect(HAND.reclineBandDeg).toEqual([30, 45]);
    expect(HAND.reclineDeg).toBeGreaterThanOrEqual(HAND.reclineBandDeg[0]);
    expect(HAND.reclineDeg).toBeLessThanOrEqual(HAND.reclineBandDeg[1]);
    expect(HAND.maxFaceToViewDeg).toBe(25);
  });
});

describe('3D layout constants: camera rig', () => {
  it('mirrors the committed v13 whole-table rig', () => {
    expect(CAMERA.mode).toBe('perspective');
    expect(CAMERA.lensMm).toBe(75);
    expect(CAMERA.sensorWidthMm).toBe(36);
    expect(CAMERA.sensorFit).toBe('horizontal');
    expect(CAMERA.pitchDeg).toBe(50);
    expect(CAMERA.distanceUnits).toBe(76);
    expect(CAMERA.targetUnits).toEqual([0, 0.35, 0]);
    expect(CAMERA.shiftX).toBe(0);
    expect(CAMERA.shiftY).toBe(-0.02);
    expect(CAMERA.clipStartUnits).toBe(1);
    expect(CAMERA.clipEndUnits).toBe(600);
  });

  it('has a portrait preset and the seven aspects the framing must hold', () => {
    expect(CAMERA.portraitPitchDeg).toBe(62);
    expect(CAMERA.portraitPitchDeg).toBeGreaterThan(CAMERA.pitchDeg);
    expect(CAMERA.supportedAspects).toHaveLength(7);
    expect(CAMERA.supportedAspects[0]).toBeCloseTo(21 / 9, 12);
    expect(CAMERA.supportedAspects[1]).toBeCloseTo(16 / 9, 12);
    expect(CAMERA.supportedAspects[6]).toBeCloseTo(9 / 16, 12);
  });
});

describe('3D layout constants: light', () => {
  it('keeps the authored top-left key direction as a unit vector', () => {
    const [x, y, z] = LIGHT.keyDirection;
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
    // Up, to the left and toward the human: highlights land top-left.
    expect(x).toBeLessThan(0);
    expect(y).toBeGreaterThan(0);
    expect(z).toBeGreaterThan(0);
    expect(LIGHT.azimuthDeg).toBe(315);
    expect(LIGHT.elevationDeg).toBe(55);
  });
});

describe('3D layout constants: board layout additions (3D-06)', () => {
  it('puts each run\u2019s draw end at the seat\u2019s right', () => {
    expect(WALL.drawEndIsSeatRight).toBe(true);
  });

  it('reveals dora on the far wall\u2019s top tier, in from the draw end', () => {
    expect(DORA.tier).toBe(1);
    expect(DORA.firstStackFromDrawEnd).toBe(1);
    expect(DORA.maxIndicators).toBe(5);
    // Five indicators still land on real stacks of the far run.
    expect(
      WALL.drawEndSlot - DORA.firstStackFromDrawEnd - (DORA.maxIndicators - 1),
    ).toBeGreaterThanOrEqual(0);
  });

  it('describes the pond overflow on the nearest row', () => {
    expect(POND.overflowRow).toBe(0);
    expect(POND.rowRadiiUnits[POND.overflowRow]).toBe(POND.rowRadiiUnits[0]);
    expect(POND.overflowColumns).toBe(4);
    expect(POND.columnGapUnits).toBe(0);
    expect(POND.sidewaysPitchUnits).toBe(TILE.heightUnits);
    // The committed centre offset is the middle of a 6-column row.
    expect(POND.columnCentreOffsetUnits).toBeCloseTo(
      2.5 * POND.columnPitchUnits,
      9,
    );
    expect(
      POND.columnCentreOffsetUnits + TILE.widthUnits / 2,
    ).toBeCloseTo(2.25, 12);
  });

  it('lays a meld row right of the drawn tile, outside the wall', () => {
    expect(MELD.slots).toBe(4);
    expect(MELD.rowStartUnits).toBeCloseTo(5.5125 + 0.375 + 0.15, 12);
    expect(MELD.rowRadiusUnits).toBe(HAND.backRadiusUnits);
    expect(MELD.uprightPitchUnits).toBe(TILE.widthUnits);
    expect(MELD.sidewaysPitchUnits).toBe(TILE.heightUnits);
    expect(MELD.slotGapUnits).toBe(0);
    // The row starts clear of the 13-tile draw slot.
    expect(MELD.rowStartUnits).toBeGreaterThan(
      HAND.drawOffsetUnits + TILE.widthUnits / 2,
    );
    // A four-tile kan fits inside one row's tangential limit.
    expect(MELD.rowStartUnits + 4 * MELD.sidewaysPitchUnits).toBeLessThanOrEqual(
      MELD.maxRowUnits,
    );
    // Rows step toward the player, so the *first* row is the one nearest the
    // wall: it must clear both the end run's outer face and the side run's, and
    // the last row must stay on the mat.
    expect(MELD.rowRadiusUnits - TILE.heightUnits / 2).toBeGreaterThan(
      WALL.radiusUnits + TILE.heightUnits / 2,
    );
    expect(MELD.rowRadiusUnits - TILE.heightUnits / 2).toBeGreaterThan(
      WALL.endRunRadiusUnits + TILE.heightUnits / 2,
    );
    expect(
      MELD.rowRadiusUnits +
        (MELD.rowCount - 1) * MELD.rowPitchUnits +
        TILE.heightUnits / 2,
    ).toBeLessThanOrEqual(TABLE.matSizeUnits / 2);
  });

  it('stretches the compass plate to touch the innermost discard row', () => {
    const pondInnerEdge =
      POND.rowRadiiUnits[POND.rows - 1] - TILE.heightUnits / 2;
    const physicalHalf = COMPASS_PLATE.sizeUnits / 2 + COMPASS_PLATE.bevelUnits;
    // Touching, not overlapping: the chamfer stops a hair short of a discard.
    expect(physicalHalf).toBeLessThan(pondInnerEdge);
    expect(pondInnerEdge - physicalHalf).toBeLessThan(0.01);
    // It clears the well entirely and still sits below every tile.
    expect(COMPASS_PLATE.sizeUnits / 2).toBeGreaterThan(
      TABLE.compassWellUnits / 2,
    );
    expect(COMPASS_PLATE.topUnits).toBeLessThan(TILE.thicknessUnits);
  });

  it('keeps a declarer’s point stick on the compass plate', () => {
    // Inside the plate's footprint, so the stick stands on its top face.
    expect(STICK.radiusUnits - STICK.widthUnits / 2).toBeGreaterThan(0);
    expect(STICK.radiusUnits + STICK.widthUnits / 2).toBeLessThan(
      COMPASS_PLATE.sizeUnits / 2,
    );
    // The stick's top stays below a lying tile's face, so it reads as an inlay.
    expect(COMPASS_PLATE.topUnits + STICK.heightUnits).toBeLessThan(
      TILE.thicknessUnits,
    );
    // The stick lies lengthways along its own seat's edge; neighbouring seats'
    // sticks are a quarter-turn apart, so their footprints never meet.
    expect(STICK.radiusUnits - STICK.widthUnits / 2).toBeGreaterThan(
      STICK.lengthUnits / 2,
    );
  });

  it('carries the framing solver\u2019s inputs', () => {
    expect(CAMERA.portraitBelowAspect).toBe(1);
    expect(CAMERA.framingAspect).toBeCloseTo(16 / 9, 12);
    expect(CAMERA.safeAreaMargin).toBe(0.02);
    expect(CAMERA.handLongAxisMinViewportFraction).toBe(0.05);
    // The reference frame is one of the supported aspects.
    expect(CAMERA.supportedAspects).toContain(CAMERA.framingAspect);
  });
});
