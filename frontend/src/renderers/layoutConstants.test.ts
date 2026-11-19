import { describe, expect, it } from 'vitest';
import {
  CAMERA,
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
    expect(TILE.gapUnits * UNIT_MM).toBeCloseTo(0.3, 12);
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
  it('is four runs of 17 stacks, two tiers, on a radius-7 ring', () => {
    expect(WALL.runs).toBe(4);
    expect(WALL.stacksPerRun).toBe(17);
    expect(WALL.tiers).toBe(2);
    expect(WALL.radiusUnits).toBe(7);
    expect(WALL.slotsPerRun).toBe(34);
  });

  it('spaces stacks by the 21 mm tile plus the 0.3 mm groove', () => {
    expect(WALL.stackPitchUnits).toBeCloseTo(0.75 + 0.3 / 28, 12);
    expect(WALL.stackPitchUnits).toBeCloseTo(0.7607142857, 9);
    expect(WALL.tierStepUnits).toBeCloseTo(16.5 / 28 + 0.3 / 28, 12);
    expect(WALL.tierStepUnits).toBeCloseTo(0.6, 12);
    expect(WALL.runSpanUnits).toBeCloseTo(12.932142857, 8);
  });

  it('omits each run\u2019s draw-end top tile', () => {
    expect(WALL.drawEndSlot).toBe(16);
    expect(WALL.drawEndTiers).toBe(1);
    expect(WALL.tileCount).toBe(132);
    expect(WALL.tileCount).toBe(
      WALL.runs * (WALL.stacksPerRun * WALL.tiers - 1),
    );
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

  it('uses the committed row/column pitches and radii', () => {
    expect(POND.columnPitchUnits).toBeCloseTo(0.757142857, 9);
    expect(POND.rowPitchUnits).toBeCloseTo(1.010714286, 9);
    expect(POND.columnCentreOffsetUnits).toBeCloseTo(1.892857142, 8);
    // Row 0 is nearest the player; the rows advance toward the table centre.
    expect(POND.rowRadiiUnits).toEqual([4.81, 3.799286, 2.788571]);
    expect(POND.rowRadiiUnits[0]).toBeGreaterThan(POND.rowRadiiUnits[2]);
  });
});

describe('3D layout constants: human hand', () => {
  it('is 13 concealed tiles plus a separated draw slot', () => {
    expect(HAND.concealedCount).toBe(13);
    expect(HAND.pitchUnits).toBeCloseTo(0.7607142857, 9);
    expect(HAND.drawGapUnits).toBe(0.2625);
    expect(HAND.drawOffsetUnits).toBeCloseTo(5.576785714, 9);
    // The board handoff (2026-11-18) moved the hand in from the reference's
    // 10.6 so it sits 30 mm behind the wall ring, not a hand's width away.
    expect(HAND.backRadiusUnits).toBe(8.35);
    expect(HAND.backRadiusUnits - TILE.thicknessUnits / 2).toBeGreaterThan(
      WALL.radiusUnits,
    );
    expect(
      HAND.backRadiusUnits - TILE.thicknessUnits / 2 - WALL.radiusUnits,
    ).toBeLessThan(1.5);
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
    expect(POND.columnGapUnits).toBeCloseTo(0.2 / 28, 12);
    expect(POND.sidewaysPitchUnits).toBeCloseTo(1 + 0.3 / 28, 12);
    // The committed centre offset is the middle of a 6-column row.
    expect(POND.columnCentreOffsetUnits).toBeCloseTo(
      2.5 * POND.columnPitchUnits,
      9,
    );
    expect(
      POND.columnCentreOffsetUnits + TILE.widthUnits / 2,
    ).toBeCloseTo(2.267857142, 8);
  });

  it('lays a meld row right of the drawn tile, outside the wall', () => {
    expect(MELD.slots).toBe(4);
    expect(MELD.rowStartUnits).toBeCloseTo(6.1, 12);
    expect(MELD.rowRadiusUnits).toBe(HAND.backRadiusUnits);
    expect(MELD.uprightPitchUnits).toBeCloseTo(0.7607142857, 9);
    expect(MELD.sidewaysPitchUnits).toBeCloseTo(1.0107142857, 9);
    // The row starts clear of the 13-tile draw slot.
    expect(MELD.rowStartUnits).toBeGreaterThan(
      HAND.drawOffsetUnits + TILE.widthUnits / 2,
    );
    // A four-tile kan fits inside one row's tangential limit.
    expect(MELD.rowStartUnits + 4 * MELD.sidewaysPitchUnits).toBeLessThanOrEqual(
      MELD.maxRowUnits,
    );
    // Rows step toward the player, so the *first* row is the one nearest the
    // wall: it must clear the wall's outer face, and the last row must stay on
    // the mat.
    expect(MELD.rowRadiusUnits - TILE.heightUnits / 2).toBeGreaterThan(
      WALL.radiusUnits + TILE.thicknessUnits / 2,
    );
    expect(
      MELD.rowRadiusUnits +
        (MELD.rowCount - 1) * MELD.rowPitchUnits +
        TILE.heightUnits / 2,
    ).toBeLessThanOrEqual(TABLE.matSizeUnits / 2);
  });

  it('keeps a point stick between the compass well and the near pond row', () => {
    expect(STICK.widthUnits).toBeLessThan(
      POND.rowRadiiUnits[POND.rows - 1] -
        TILE.heightUnits / 2 -
        TABLE.compassWellUnits / 2,
    );
    expect(STICK.radiusUnits - STICK.widthUnits / 2).toBeGreaterThan(
      TABLE.compassWellUnits / 2,
    );
    expect(STICK.radiusUnits + STICK.widthUnits / 2).toBeLessThan(
      POND.rowRadiiUnits[POND.rows - 1] - TILE.heightUnits / 2,
    );
    expect(STICK.pitchUnits).toBeGreaterThan(STICK.widthUnits);
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
