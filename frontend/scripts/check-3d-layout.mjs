#!/usr/bin/env node
/**
 * 3D layout gate (3D-06).
 *
 * Prints the committed constant table, the per-zone counts of a full fixture
 * board and the framing numbers for every supported aspect, and exits non-zero
 * if any internal invariant fails. It is dependency-free in the sense that it
 * adds no package: it loads the app's own TypeScript through the frontend's
 * existing Vite install (already required for `npm test`), with no browser, no
 * WebGL and no GPU. The board is pure world-space math.
 *
 * Invariants asserted:
 *
 *  - the foreground multiset equals the snapshot's non-wall tiles exactly;
 *  - no two tiles' oriented boxes intersect, wall tiers included;
 *  - the wall is the fixed 132-tile decorative set minus the tiles the dora
 *    indicators cover, and each run's draw end is at its seat's right;
 *  - ponds fill from the far row toward the player and the overflow extends the
 *    nearest row; a turned discard is set out by the column gap and advances by
 *    its long axis;
 *  - the human hand is reclined 40° about its far bottom edge, opponents are
 *    upright and face-down, and the drawn tile sits exactly the tsumogiri gap
 *    from the 13-tile row (reproducing `HAND.drawOffsetUnits`);
 *  - melds form one line at the hand's right, the called tile turned sideways,
 *    four melds (kans included) stay on the mat without overlapping, and the
 *    line never extends the meld-free board's extents or moves the solved
 *    camera (task 261120-2225);
 *  - the mat and every tile are inside the safe area with the committed margin
 *    at every supported aspect, the hand's face-to-view angle is within the
 *    25° gate, and its long axis stays readable at the reference aspect.
 *
 * The constants are 3D-owned (plan §9); the 2.5D whole-table spec they were
 * first compared against was retired in task 261119-1637 and is in git history.
 */

import { fileURLToPath } from 'node:url';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));

const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok    ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`);
    failures.push(label);
  }
}

function close(actual, expected, tolerance = 1e-9) {
  return Math.abs(actual - expected) <= tolerance;
}

function formatNumber(value, digits = 3) {
  if (!Number.isFinite(value)) return String(value);
  return value.toFixed(digits);
}

function formatMatrix3(values) {
  return `[${values.map((value) => formatNumber(value)).join(', ')}]`;
}

/** A comparison cell: numbers to six decimals, everything else as printed. */
function formatValue(value) {
  return typeof value === 'number' ? String(Number(formatNumber(value, 6))) : String(value);
}

/** Load the pure TS modules through Vite's SSR loader (no browser). */
async function loadModules() {
  let createServer;
  try {
    ({ createServer } = await import('vite'));
  } catch {
    throw new Error(
      'this gate loads the app\u2019s TypeScript through the frontend\u2019s own Vite install; run `npm ci` in frontend/ first',
    );
  }
  const server = await createServer({
    root: FRONTEND_ROOT,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    return {
      constants: await server.ssrLoadModule(
        '/src/renderers/layoutConstants.ts',
      ),
      layout: await server.ssrLoadModule(
        '/src/renderers/three/boardLayout.ts',
      ),
      fixture: await server.ssrLoadModule(
        '/src/renderers/three/boardFixture.ts',
      ),
      gaps: await server.ssrLoadModule(
        '/src/renderers/three/gaps.ts',
      ),
      wall: await server.ssrLoadModule(
        '/src/renderers/wall.ts',
      ),
    };
  } finally {
    await server.close();
  }
}

/** A stable key for the foreground multiset comparison. */
function tileKey(tile) {
  return `${tile.seat ?? 'table'}/${tile.zone}/${tile.slot}/${tile.face}`;
}

function snapshotForeground(snapshot) {
  const keys = [];
  for (const seat of snapshot.seats) {
    for (const tile of seat.concealed) {
      keys.push(tileKey({ ...tile, seat: seat.seat }));
    }
    if (seat.draw) keys.push(tileKey({ ...seat.draw, seat: seat.seat }));
    for (const meld of seat.melds) {
      for (const tile of meld.tiles) {
        keys.push(tileKey({ ...tile, seat: seat.seat }));
      }
    }
    for (const tile of seat.river) {
      keys.push(tileKey({ ...tile, seat: seat.seat }));
    }
  }
  for (const tile of snapshot.dora) keys.push(tileKey({ ...tile, seat: null }));
  return keys.sort();
}

function overlaps(board, layout) {
  const boxes = board.tiles.map((tile) =>
    layout.orientedBox(tile.pose),
  );
  const hits = [];
  for (let left = 0; left < board.tiles.length; left += 1) {
    for (let right = left + 1; right < board.tiles.length; right += 1) {
      if (layout.orientedBoxesIntersect(boxes[left], boxes[right])) {
        hits.push(`${board.tiles[left].id} x ${board.tiles[right].id}`);
      }
    }
  }
  return hits;
}

function zoneCounts(board) {
  const counts = new Map();
  for (const tile of board.tiles) {
    counts.set(tile.zone, (counts.get(tile.zone) ?? 0) + 1);
  }
  return counts;
}

/** The biggest board the layout must survive: every seat full. */
function widestFixture(fixture) {
  return fixture.boardFixture({
    humanSeat: 2,
    riverCounts: [22, 22, 22, 22],
    meldCounts: [4, 4, 4, 4],
    kan: true,
    doraCount: 5,
    // Every seat declares: the most per-seat riichi sticks this board can draw.
    riichiSeats: [0, 1, 2, 3],
  });
}

async function main() {
  const { constants: C, layout: L, fixture: F, gaps: G, wall: W } = await loadModules();

  const fixture = F.boardFixture();
  const board = L.layoutBoard(fixture);
  const matHalf = C.TABLE.matSizeUnits / 2;
  const matCorners = [
    [-matHalf, 0, -matHalf],
    [matHalf, 0, -matHalf],
    [matHalf, 0, matHalf],
    [-matHalf, 0, matHalf],
  ];
  const humanSeat = fixture.humanSeat;

  console.log('3D layout gate (3D-06)\n');
  console.log(`fixture: human seat ${humanSeat}, ` +
    `${fixture.dora.length} dora, ` +
    `${fixture.seats.filter((seat) => seat.riichi).length} declarers, ` +
    `${fixture.seats.reduce((sum, seat) => sum + seat.river.length, 0)} discards\n`);

  /* ---------------------------- constants ---------------------------- */
  console.log('committed constants (tile units: 1 = 28 mm)');
  const rows = [
    ['tile body (w x h x t)', `${formatNumber(C.TILE.widthUnits)} x ${formatNumber(C.TILE.heightUnits)} x ${formatNumber(C.TILE.thicknessUnits)}`],
    ['row gap / bevel', `${formatNumber(C.TILE.gapUnits, 4)} / ${formatNumber(C.TILE.bevelUnits)}`],
    ['mat / compass well', `${C.TABLE.matSizeUnits} / ${C.TABLE.compassWellUnits}`],
    ['compass plate size / top', `${formatNumber(C.COMPASS_PLATE.sizeUnits, 4)} / ${formatNumber(C.COMPASS_PLATE.topUnits, 4)}`],
    ['plate edge to innermost discard', formatNumber((C.POND.rowRadiiUnits[C.POND.rows - 1] - C.TILE.heightUnits / 2) - (C.COMPASS_PLATE.sizeUnits / 2 + C.COMPASS_PLATE.bevelUnits), 4)],
    ['wall runs x stacks x tiers', `${C.WALL.runs} x ${C.WALL.stacksPerRun} x ${C.WALL.tiers}`],
    ['wall ring radius / end-run radius / pitch / tier step', `${formatNumber(C.WALL.radiusUnits)} / ${formatNumber(C.WALL.endRunRadiusUnits, 6)} / ${formatNumber(C.WALL.stackPitchUnits, 6)} / ${formatNumber(C.WALL.tierStepUnits)}`],
    ['wall draw end (slot, seat right)', `${C.WALL.drawEndSlot} (${C.WALL.drawEndIsSeatRight})`],
    ['live wall (stacks / tiles / max in a state)', `${C.WALL.liveWallStacks} / ${C.WALL.liveWallTiles} / ${C.WALL.maxDecisionLiveTiles}`],
    ['dead wall (stacks / tiles / first stack / gap)', `${C.WALL.deadWallStacks} / ${C.WALL.deadWallTiles} / ${C.WALL.deadWallStartStack} / ${formatNumber(C.WALL.deadWallGapUnits, 4)}`],
    ['pond rows x columns (+overflow)', `${C.POND.rows} x ${C.POND.columns} (+${C.POND.overflowColumns})`],
    ['pond radii (nearest first)', formatMatrix3(C.POND.rowRadiiUnits)],
    ['pond column pitch / centre offset', `${formatNumber(C.POND.columnPitchUnits, 6)} / ${formatNumber(C.POND.columnCentreOffsetUnits, 6)}`],
    ['hand tiles / pitch / back radius', `${C.HAND.concealedCount} / ${formatNumber(C.HAND.pitchUnits, 6)} / ${formatNumber(C.HAND.backRadiusUnits)}`],
    ['hand recline / band / face-to-view max', `${C.HAND.reclineDeg}° / ${C.HAND.reclineBandDeg.join('–')}° / ${C.HAND.maxFaceToViewDeg}°`],
    ['drawn tile offset / tsumogiri gap', `${formatNumber(C.HAND.drawOffsetUnits, 6)} / ${formatNumber(C.HAND.drawGapUnits, 4)}`],
    ['meld line clearance / meld gap / slot gap', `${formatNumber(C.MELD.rowClearanceUnits, 4)} / ${formatNumber(C.MELD.meldGapUnits, 4)} / ${C.MELD.slotGapUnits}`],
    ['meld corner shift / upright / sideways', `${formatNumber(C.MELD.rowShiftUnits, 4)} / ${formatNumber(C.MELD.uprightPitchUnits, 6)} / ${formatNumber(C.MELD.sidewaysPitchUnits, 6)}`],
    ['dora tier / in from draw end / max', `${C.DORA.tier} / ${C.DORA.firstStackFromDrawEnd} / ${C.DORA.maxIndicators}`],
    ['point stick (l x w x h) / radius', `${formatNumber(C.STICK.lengthUnits)} x ${formatNumber(C.STICK.widthUnits)} x ${formatNumber(C.STICK.heightUnits)} / ${formatNumber(C.STICK.radiusUnits)}`],
    ['camera lens / sensor / fit', `${C.CAMERA.lensMm} mm / ${C.CAMERA.sensorWidthMm} mm / ${C.CAMERA.sensorFit}`],
    ['camera pitch / portrait pitch', `${C.CAMERA.pitchDeg}° / ${C.CAMERA.portraitPitchDeg}°`],
    ['camera distance / shift X, Y', `${C.CAMERA.distanceUnits} / ${C.CAMERA.shiftX}, ${C.CAMERA.shiftY}`],
    ['camera target / clip', formatMatrix3(C.CAMERA.targetUnits) + ` / ${C.CAMERA.clipStartUnits}–${C.CAMERA.clipEndUnits}`],
    ['safe-area margin / hand long-axis min', `${C.CAMERA.safeAreaMargin} / ${C.CAMERA.handLongAxisMinViewportFraction}`],
  ];
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(40, '.')} ${value}`);
  }
  console.log();

  /* ----------------------------- counts ------------------------------ */
  console.log('layout counts');
  const counts = zoneCounts(board);
  for (const zone of ['wall', 'dora', 'hand', 'draw', 'river', 'meld']) {
    console.log(`  ${zone.padEnd(10, '.')} ${counts.get(zone) ?? 0}`);
  }
  console.log(`  ${'sticks'.padEnd(10, '.')} ${board.sticks.length}`);
  console.log(`  ${'total'.padEnd(10, '.')} ${board.tiles.length} tiles\n`);

  console.log('per-seat zones (hand / draw / river / melds)');
  for (const seat of fixture.seats) {
    const of = (zone) =>
      board.foreground.filter(
        (tile) => tile.seat === seat.seat && tile.zone === zone,
      ).length;
    console.log(
      `  seat ${seat.seat}: ${of('hand')} / ${of('draw')} / ${of('river')} / ${of('meld')}` +
        `   wind ${seat.wind}${seat.seat === humanSeat ? ' (human)' : ''}`,
    );
  }
  console.log();

  /* --------------------------- invariants ---------------------------- */
  console.log('invariants');

  const foreground = board.foreground.map(tileKey).sort();
  check(
    'foreground multiset equals the snapshot',
    JSON.stringify(foreground) === JSON.stringify(snapshotForeground(fixture)),
    `${foreground.length} tiles`,
  );

  const collisions = overlaps(board, L);
  check(
    'no two tiles intersect',
    collisions.length === 0,
    collisions.length ? collisions.slice(0, 3).join('; ') : `${board.tiles.length} tiles`,
  );

  const widestSnapshot = widestFixture(F);
  const widest = L.layoutBoard(widestSnapshot);
  const widestCollisions = overlaps(widest, L);
  check(
    'widest board (4 melds/seat, kans, 22 discards, 5 dora) stays separate',
    widestCollisions.length === 0,
    widestCollisions.length ? widestCollisions.slice(0, 3).join('; ') : `${widest.tiles.length} tiles`,
  );

  // The meld line's whole job (task 261120-2225) is to live inside the footprint
  // a meld-free board already needs. Check it against the widest board's own
  // human seat, so the claim covers all four seats' melds.
  const meldFreeWidest = L.layoutBoard(
    F.boardFixture({
      humanSeat: widestSnapshot.humanSeat,
      riverCounts: [22, 22, 22, 22],
      meldCounts: [0, 0, 0, 0],
      doraCount: 5,
      riichiSeats: [0, 1, 2, 3],
    }),
  );
  const envelope = (source) => {
    const corners = source.tiles.flatMap((tile) =>
      L.orientedBoxCorners(L.orientedBox(tile.pose)),
    );
    return {
      minX: Math.min(...corners.map((corner) => corner[0])),
      maxX: Math.max(...corners.map((corner) => corner[0])),
      minZ: Math.min(...corners.map((corner) => corner[2])),
      maxZ: Math.max(...corners.map((corner) => corner[2])),
    };
  };
  const freeBox = envelope(meldFreeWidest);
  const meldCorners = (source) =>
    source.foreground
      .filter((tile) => tile.zone === 'meld')
      .flatMap((tile) => L.orientedBoxCorners(L.orientedBox(tile.pose)));
  const outsideMeldFree = meldCorners(widest).filter(
    (corner) =>
      corner[0] < freeBox.minX - 1e-9 ||
      corner[0] > freeBox.maxX + 1e-9 ||
      corner[2] < freeBox.minZ - 1e-9 ||
      corner[2] > freeBox.maxZ + 1e-9,
  );
  check(
    'every meld stays inside the meld-free board’s extents',
    meldCorners(widest).length > 0 && outsideMeldFree.length === 0,
    `x ${formatNumber(freeBox.minX, 3)}..${formatNumber(freeBox.maxX, 3)}, ` +
      `z ${formatNumber(freeBox.minZ, 3)}..${formatNumber(freeBox.maxZ, 3)}`,
  );

  const farSeat = (humanSeat + 2) % C.SEATS.count;
  const isDead = (tile) => W.isDeadWallSlot(tile.slot, humanSeat);
  const liveTiles = board.wall.filter((tile) => !isDead(tile));
  const deadTiles = board.wall.filter(isDead);
  const liveCount = Math.min(
    fixture.compass.tilesRemaining,
    C.WALL.maxDecisionLiveTiles,
  );
  check(
    'live wall holds exactly the published tiles_remaining tiles',
    liveTiles.length === liveCount,
    `${liveTiles.length} = ${liveCount}`,
  );

  const decoded = (tile) => W.decodeWallSlot(tile.slot);
  const stackOf = (tile) => decoded(tile).stack;
  const deadStacks = new Set(deadTiles.map(stackOf));
  const coveredStacks = new Set(
    fixture.dora.map(
      (_tile, index) =>
        C.WALL.drawEndSlot - C.DORA.firstStackFromDrawEnd - index,
    ),
  );
  const deadIntact =
    deadStacks.size === C.WALL.deadWallStacks &&
    [...deadStacks].every(
      (stack) =>
        stack >= C.WALL.deadWallStartStack && stack <= C.WALL.drawEndSlot,
    ) &&
    deadTiles.length + fixture.dora.length === C.WALL.deadWallTiles;
  check(
    'dead wall is intact: 7 stacks x 2 tiers, 14 tiles, dora on its top tier',
    deadIntact,
    `${deadTiles.length} face-down + ${fixture.dora.length} indicators = ${C.WALL.deadWallTiles}`,
  );

  const runRadiusOk = [0, 1, 2, 3].every((run) => {
    const expected = L.wallRunRadius(run, fixture.humanSeat);
    return board.wall
      .filter((tile) => Math.floor(tile.slot / C.WALL.slotsPerRun) === run)
      .every((tile) => {
        const outward = L.seatPoint(run, 0, 1, 0);
        const radius =
          tile.pose.position[0] * outward[0] + tile.pose.position[2] * outward[2];
        return close(radius, expected, 1e-9);
      });
  });
  check(
    'front/back runs sit on the inset radius, side runs on the ring',
    runRadiusOk,
    `end ${formatNumber(C.WALL.endRunRadiusUnits, 4)} / side ${formatNumber(C.WALL.radiusUnits, 4)}`,
  );
  check(
    'a front/back run\u2019s outer face is flush with a side run\u2019s end tile',
    close(
      C.WALL.endRunRadiusUnits + C.TILE.heightUnits / 2,
      C.WALL.runHalfLengthUnits,
      1e-9,
    ),
    `${formatNumber(C.WALL.runHalfLengthUnits, 6)} units`,
  );

  const deadRight = L.seatPoint(farSeat, 1, 0, 0);
  const deadW = (tile) =>
    tile.pose.position[0] * deadRight[0] + tile.pose.position[2] * deadRight[2];
  const deadShifted = deadTiles.every((tile) =>
    close(
      deadW(tile),
      (stackOf(tile) - (C.WALL.stacksPerRun - 1) / 2) *
        C.WALL.stackPitchUnits +
        C.WALL.deadWallGapUnits,
      1e-9,
    ),
  );
  check(
    'the dead wall is nudged clear of the live wall by the committed felt break',
    deadShifted,
    `${formatNumber(C.WALL.deadWallGapUnits, 3)} units = ${formatNumber(C.WALL.deadWallGapUnits * C.UNIT_MM, 1)} mm`,
  );

  const wallGaps = G.tileGaps(board.tiles, { withinUnits: 1.5 });
  const byId = new Map(board.tiles.map((tile) => [tile.id, tile]));
  const deadLiveGaps = wallGaps.filter((pair) => {
    const a = byId.get(pair.aId);
    const b = byId.get(pair.bId);
    // Wall tiles only: a dora indicator's slot is an indicator index, not a ring
    // slot, and it belongs to the dead block anyway.
    if (!a || !b || a.zone !== 'wall' || b.zone !== 'wall') return false;
    return isDead(a) !== isDead(b);
  });
  const nearestDeadLive = deadLiveGaps.length
    ? Math.min(...deadLiveGaps.map((pair) => pair.gapUnits))
    : Number.POSITIVE_INFINITY;
  check(
    'no dead-wall tile touches the live wall',
    nearestDeadLive + 1e-9 >= C.WALL.deadWallGapUnits,
    `${formatNumber(nearestDeadLive, 4)} units minimum`,
  );

  const modelSlots = W.liveWallSlots(
    fixture.compass.tilesRemaining,
    humanSeat,
  )
    .map((slot) => W.wallSlotId(slot.run, slot.stack, slot.tier))
    .sort((left, right) => left - right);
  const liveSlots = liveTiles
    .map((tile) => tile.slot)
    .sort((left, right) => left - right);
  check(
    'the live wall is exactly the arc suffix the draw order implies',
    JSON.stringify(liveSlots) === JSON.stringify(modelSlots),
    `${liveSlots.length} slots`,
  );

  const partialStacks = (() => {
    const byStack = new Map();
    for (const tile of liveTiles) {
      const { run, stack, tier } = decoded(tile);
      const key = `${run}:${stack}`;
      byStack.set(key, [...(byStack.get(key) ?? []), tier]);
    }
    return [...byStack.entries()].filter(([, tiers]) => tiers.length === 1);
  })();
  const expectPartial = liveCount % 2 === 1;
  check(
    'an odd live count leaves one bottom-only stack at the draw edge',
    partialStacks.length === (expectPartial ? 1 : 0) &&
      (!expectPartial || partialStacks[0][1][0] === 0),
    `${partialStacks.length} partial stack(s) at ${liveCount} tiles`,
  );

  const doraTiles = board.foreground.filter((tile) => tile.zone === 'dora');
  check(
    'dora indicators sit on the dead wall\u2019s top tier, on the block',
    doraTiles.every((tile, index) => {
      const outward = L.seatPoint(farSeat, 0, 1, 0);
      const radius =
        tile.pose.position[0] * outward[0] + tile.pose.position[2] * outward[2];
      return (
        close(radius, L.wallRunRadius(farSeat, humanSeat)) &&
        close(tile.pose.position[1], L.wallTierHeightUnits(1)) &&
        close(
          deadW(tile),
          (C.WALL.drawEndSlot -
            C.DORA.firstStackFromDrawEnd -
            index -
            (C.WALL.stacksPerRun - 1) / 2) *
            C.WALL.stackPitchUnits +
            C.WALL.deadWallGapUnits,
          1e-9,
        ) &&
        tile.pose.tiltDeg === -90
      );
    }),
    `${doraTiles.length} indicators`,
  );

  // A late hand: the live wall is nearly empty, the dead wall is still 14 tiles
  // and still clear of the live wall and of everything else.
  const late = L.layoutBoard(F.boardFixture({ tilesRemaining: 12, doraCount: 5 }));
  const lateDead = late.wall.filter((tile) =>
    W.isDeadWallSlot(tile.slot, late.humanSeat),
  );
  const lateLive = late.wall.filter(
    (tile) => !W.isDeadWallSlot(tile.slot, late.humanSeat),
  );
  check(
    'a late-hand board keeps the dead wall intact and draws only the live count',
    lateLive.length === 12 &&
      lateDead.length + 5 === C.WALL.deadWallTiles &&
      overlaps(late, L).length === 0,
    `${lateLive.length} live + ${lateDead.length} face-down dead + 5 dora`,
  );

  const humanHand = board.foreground
    .filter((tile) => tile.seat === humanSeat && tile.zone === 'hand')
    .sort((left, right) => left.slot - right.slot);
  const humanDraw = board.foreground.find(
    (tile) => tile.seat === humanSeat && tile.zone === 'draw',
  );
  check(
    'human hand is reclined 40° about its far bottom edge',
    humanHand.every((tile) => {
      const [, ay, az] = L.poseAxes(tile.pose);
      const corner = [
        tile.pose.position[0] - ay[0] * 0.5 - az[0] * (C.TILE.thicknessUnits / 2),
        tile.pose.position[1] - ay[1] * 0.5 - az[1] * (C.TILE.thicknessUnits / 2),
        tile.pose.position[2] - ay[2] * 0.5 - az[2] * (C.TILE.thicknessUnits / 2),
      ];
      const outward = L.seatPoint(humanSeat, 0, 1, 0);
      const radius = corner[0] * outward[0] + corner[2] * outward[2];
      return (
        tile.pose.tiltDeg === -C.HAND.reclineDeg &&
        close(radius, L.handRadius(humanSeat, humanSeat), 1e-9) &&
        close(corner[1], 0)
      );
    }),
    `tilt ${C.HAND.reclineDeg}°`,
  );
  // The near and far hands sit one tile thickness closer to their (inset) end
  // runs than the side hands do: the handoff's "player and across player" rule.
  const acrossSeat = (humanSeat + 2) % C.SEATS.count;
  check(
    'the player and across hands are one tile thickness closer than the side hands',
    close(L.handRadius(humanSeat, humanSeat), C.HAND.backRadiusUnits - C.TILE.thicknessUnits, 1e-9) &&
      close(L.handRadius(acrossSeat, humanSeat), C.HAND.backRadiusUnits - C.TILE.thicknessUnits, 1e-9) &&
      close(L.handRadius((humanSeat + 1) % C.SEATS.count, humanSeat), C.HAND.backRadiusUnits, 1e-9),
    `${formatNumber(L.handRadius(humanSeat, humanSeat), 4)} / across ${formatNumber(L.handRadius(acrossSeat, humanSeat), 4)} / side ${formatNumber(C.HAND.backRadiusUnits, 4)}`,
  );

  check(
    'hand recline stays inside the accepted band',
    C.HAND.reclineDeg >= C.HAND.reclineBandDeg[0] &&
      C.HAND.reclineDeg <= C.HAND.reclineBandDeg[1],
    `${C.HAND.reclineBandDeg[0]}–${C.HAND.reclineBandDeg[1]}°`,
  );

  const thirteen = L.layoutBoard(
    F.boardFixture({ meldCounts: [0, 0, 0, 0] }),
  );
  const thirteenHand = thirteen.foreground
    .filter((tile) => tile.seat === 0 && tile.zone === 'hand')
    .map((tile) => tile.pose.position[0]);
  const thirteenDraw = thirteen.foreground.find(
    (tile) => tile.seat === 0 && tile.zone === 'draw',
  );
  const rowRight = Math.max(...thirteenHand) + C.TILE.widthUnits / 2;
  const gap = thirteenDraw.pose.position[0] - C.TILE.widthUnits / 2 - rowRight;
  check(
    'drawn tile sits the tsumogiri gap from the 13-tile row',
    close(gap, C.HAND.drawGapUnits, 1e-9),
    `gap ${formatNumber(gap, 6)}`,
  );
  check(
    'the 13-tile draw slot reproduces the committed offset',
    close(thirteenDraw.pose.position[0], C.HAND.drawOffsetUnits, 1e-9),
    `${formatNumber(thirteenDraw.pose.position[0], 6)} vs ${C.HAND.drawOffsetUnits}`,
  );

  const opponentHands = board.foreground.filter(
    (tile) =>
      tile.seat !== humanSeat && (tile.zone === 'hand' || tile.zone === 'draw'),
  );
  check(
    'opponent hands are upright and face-down',
    opponentHands.length > 0 &&
      opponentHands.every((tile) => tile.pose.tiltDeg === 0 && !tile.faceUp),
    `${opponentHands.length} tiles`,
  );

  const river = board.foreground
    .filter((tile) => tile.seat === humanSeat && tile.zone === 'river')
    .sort((left, right) => left.slot - right.slot);
  const outwardHuman = L.seatPoint(humanSeat, 0, 1, 0);
  const radial = (tile) =>
    tile.pose.position[0] * outwardHuman[0] +
    tile.pose.position[2] * outwardHuman[2];
  const pondOk = (() => {
    if (river.length < 22) return 'fixture river is shorter than the overflow';
    if (!close(radial(river[0]), C.POND.rowRadiiUnits[2])) return 'first discard is not on the far row';
    if (!close(radial(river[6]), C.POND.rowRadiiUnits[1])) return 'seventh discard is not on the middle row';
    if (!close(radial(river[12]), C.POND.rowRadiiUnits[0])) return 'thirteenth discard is not on the near row';
    if (!close(radial(river[18]), C.POND.rowRadiiUnits[C.POND.overflowRow])) return 'overflow is not on the near row';
    if (!(river[18].pose.position[0] > river[17].pose.position[0])) return 'overflow does not extend the row';
    return null;
  })();
  check(
    'pond fills far to near, overflow extends the near row',
    pondOk === null,
    pondOk ?? 'rows 2, 1, 0 then 0+overflow',
  );

  const declared = river.find((tile) => tile.slot === 5);
  check(
    'a riichi discard is turned sideways',
    declared.sideways && declared.pose.rollDeg === -90,
    'roll -90°',
  );

  const seatOk = [1, 2, 3].every((seat) => {
    const a = board.foreground.find(
      (tile) => tile.seat === 0 && tile.zone === 'river' && tile.slot === 0,
    );
    const b = board.foreground.find(
      (tile) => tile.seat === seat && tile.zone === 'river' && tile.slot === 0,
    );
    let x = a.pose.position[0];
    let z = a.pose.position[2];
    for (let turn = 0; turn < seat; turn += 1) [x, z] = [z, -x];
    return (
      b.pose.yawDeg - a.pose.yawDeg === 90 * seat &&
      close(b.pose.position[0], x) &&
      close(b.pose.position[2], z)
    );
  });
  check('the four seats are exact rotations of each other', seatOk, 'yaw 0/90/180/270°');

  const declarers = fixture.seats.filter((seat) => seat.riichi);
  const sticksOk =
    board.sticks.length === declarers.length &&
    board.sticks.every((stick) => {
      // Each stick lies on its own declarer's side, lengthways along the edge.
      const yaw = (stick.yawDeg * Math.PI) / 180;
      const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
      const outward = [Math.sin(yaw), 0, Math.cos(yaw)];
      const radial =
        stick.position[0] * outward[0] + stick.position[2] * outward[2];
      const tangential =
        stick.position[0] * right[0] + stick.position[2] * right[2];
      const box = {
        centre: stick.position,
        axes: [right, [0, 1, 0], outward],
        halfExtents: stick.sizeUnits.map((extent) => extent / 2),
      };
      return (
        declarers.some((seat) => seat.seat === stick.seat) &&
        close(radial, C.STICK.radiusUnits) &&
        close(tangential, 0) &&
        // Standing on the compass plate, inside its footprint.
        close(
          stick.position[1] - C.STICK.heightUnits / 2,
          C.COMPASS_PLATE.topUnits,
        ) &&
        radial + C.STICK.widthUnits / 2 < C.COMPASS_PLATE.sizeUnits / 2 &&
        board.tiles.every(
          (tile) => !L.orientedBoxesIntersect(box, L.orientedBox(tile.pose)),
        )
      );
    });
  const stickBoxes = board.sticks.map((stick) => {
    const yaw = (stick.yawDeg * Math.PI) / 180;
    return {
      centre: stick.position,
      axes: [
        [Math.cos(yaw), 0, -Math.sin(yaw)],
        [0, 1, 0],
        [Math.sin(yaw), 0, Math.cos(yaw)],
      ],
      halfExtents: stick.sizeUnits.map((extent) => extent / 2),
    };
  });
  let sticksApart = true;
  for (let first = 0; first < stickBoxes.length; first += 1) {
    for (let second = first + 1; second < stickBoxes.length; second += 1) {
      if (L.orientedBoxesIntersect(stickBoxes[first], stickBoxes[second])) {
        sticksApart = false;
      }
    }
  }
  check(
    'one riichi stick per declarer sits on that seat’s side, clear of every tile and neighbour',
    sticksOk && sticksApart,
    `${board.sticks.length} sticks for ${declarers.length} declarers`,
  );

  check(
    'the layout is deterministic',
    JSON.stringify(L.layoutBoard(fixture)) === JSON.stringify(board),
  );

  /* ---------------------------- framing ------------------------------ */
  const height = 1000;
  const aspects = [...C.CAMERA.supportedAspects].sort((a, b) => b - a);
  console.log('\nframing (every tile inside the safe area; the mat may crop)');
  console.log(
    '  aspect   pitch  distance   mat X    mat Y   tiles     hand long   hand bottom   face/view   strict ray',
  );

  let tilesOk = true;
  let faceOk = true;
  let referenceLongAxis = 0;
  let referenceHandBottom = 1;
  for (const aspect of aspects) {
    const frame = L.frameForAspect(aspect, board);
    const width = height * aspect;
    const corners = matCorners.map((corner) =>
      L.projectToPixels(corner, frame, width, height),
    );
    const marginX =
      Math.min(
        ...corners.map((point) => Math.min(point.x, width - point.x)),
      ) / width;
    const marginY =
      Math.min(
        ...corners.map((point) => Math.min(point.y, height - point.y)),
      ) / height;

    // A margin as a fraction of the frame dimension: NDC 1 is half the frame.
    let tilesMargin = 1;
    for (const tile of board.tiles) {
      for (const corner of L.orientedBoxCorners(L.orientedBox(tile.pose))) {
        const ndc = L.projectPoint(corner, frame);
        tilesMargin = Math.min(
          tilesMargin,
          (1 - Math.abs(ndc.x)) / 2,
          (1 - Math.abs(ndc.y)) / 2,
        );
      }
    }

    const tile = humanHand[Math.floor(humanHand.length / 2)];
    const axes = L.poseAxes(tile.pose);
    const top = tile.pose.position.map((value, index) => value + axes[1][index] / 2);
    const bottom = tile.pose.position.map((value, index) => value - axes[1][index] / 2);
    const a = L.projectToPixels(top, frame, width, height);
    const b = L.projectToPixels(bottom, frame, width, height);
    const longAxis = Math.hypot(a.x - b.x, a.y - b.y) / height;
    if (aspect === C.CAMERA.framingAspect) referenceLongAxis = longAxis;

    // The human hand's own bottom margin: the handoff asked for the hand to sit
    // only a sliver above the bottom edge, which is a number, not a look.
    let handBottom = 1;
    for (const entry of humanHand) {
      for (const corner of L.orientedBoxCorners(L.orientedBox(entry.pose))) {
        const pixel = L.projectToPixels(corner, frame, width, height);
        handBottom = Math.min(handBottom, 1 - pixel.y / height);
      }
    }
    if (aspect === C.CAMERA.framingAspect) referenceHandBottom = handBottom;

    const faceToView = L.handFaceToViewDeg(frame);
    const strict = Math.max(
      ...humanHand.map((entry) => L.handTileToEyeDeg(entry, frame)),
    );

    console.log(
      `  ${aspect.toFixed(3).padStart(6)}  ${String(frame.pitchDeg).padStart(4)}°  ${formatNumber(frame.distanceUnits, 2).padStart(7)}` +
        `  ${(marginX * 100).toFixed(2).padStart(6)}%  ${(marginY * 100).toFixed(2).padStart(6)}%` +
        `  ${(tilesMargin * 100).toFixed(2).padStart(6)}%  ${(longAxis * 100).toFixed(2).padStart(8)}%` +
        `  ${(handBottom * 100).toFixed(2).padStart(10)}%` +
        `  ${faceToView.toFixed(1).padStart(8)}°  ${strict.toFixed(1).padStart(9)}°`,
    );

    const margin = C.CAMERA.safeAreaMargin;
    if (tilesMargin + 1e-9 < margin) tilesOk = false;
    if (faceToView > C.HAND.maxFaceToViewDeg + 1e-9) faceOk = false;
  }

  console.log(
    '  (long axis is a fraction of the frame height; the 5 % floor is the\n' +
      '   landscape readability gate at the reference aspect, since a portrait\n' +
      '   frame is taller than the table and shrinks any height fraction)\n',
  );
  check('every tile keeps the 2 % safe-area margin', tilesOk);
  check(
    'the hand face-to-view angle is within 25° at every aspect',
    faceOk,
  );
  check(
    'the hand long axis is at least 5 % of the frame height at 16:9',
    referenceLongAxis + 1e-9 >= C.CAMERA.handLongAxisMinViewportFraction,
    `${formatNumber(referenceLongAxis * 100, 2)} %`,
  );
  // Melds no longer take the near corners (task 261120-2225), so the human hand
  // is the board's nearest content and sits on the 2 % safe-area edge.
  check(
    'the human hand sits within 3 % of the frame bottom at 16:9',
    referenceHandBottom <= 0.03 + 1e-9,
    `${formatNumber(referenceHandBottom * 100, 2)} %`,
  );

  /* --------------------- meld framing stability ---------------------- */
  // The acceptance for 261120-2225: declaring melds must not move the camera.
  // The melds live inside the meld-free board's extents, so the wide landscape
  // solves are identical; the row still grows by under 2 tile widths (a meld
  // replaces three concealed tiles), and the residual at the narrow aspects is
  // far below the old 13-28 unit zoom-out. The bound is 2 % of the solve and
  // 0.75 units absolute.
  console.log('\nmeld framing stability (distance Δ vs the meld-free board)');
  console.log('  seat  case              16:9 Δ     worst Δ   at aspect   worst %');
  const FRAMING_EPSILON_UNITS = 0.75;
  const FRAMING_EPSILON_FRACTION = 0.02;
  let meldStable = true;
  let meldExactLandscape = true;
  for (const seat of [0, 1, 2, 3]) {
    const plain = L.layoutBoard(
      F.boardFixture({ humanSeat: seat, meldCounts: [0, 0, 0, 0] }),
    );
    for (const [label, options] of [
      ['one meld', { meldCounts: [1, 1, 1, 1] }],
      ['four melds + kan', { meldCounts: [4, 4, 4, 4], kan: true }],
    ]) {
      const heavy = L.layoutBoard(F.boardFixture({ humanSeat: seat, ...options }));
      let worst = { delta: 0, aspect: 0, fraction: 0 };
      for (const aspect of aspects) {
        const before = L.frameForAspect(aspect, plain).distanceUnits;
        const after = L.frameForAspect(aspect, heavy).distanceUnits;
        const delta = after - before;
        const fraction = Math.abs(delta) / before;
        if (Math.abs(delta) > Math.abs(worst.delta)) {
          worst = { delta, aspect, fraction };
        }
        if (
          Math.abs(delta) > FRAMING_EPSILON_UNITS + 1e-9 ||
          fraction > FRAMING_EPSILON_FRACTION + 1e-9
        ) {
          meldStable = false;
        }
      }
      const at169 =
        L.frameForAspect(C.CAMERA.framingAspect, heavy).distanceUnits -
        L.frameForAspect(C.CAMERA.framingAspect, plain).distanceUnits;
      if (Math.abs(at169) > 1e-6) meldExactLandscape = false;
      console.log(
        `  ${seat}     ${label.padEnd(17)} ` +
          `${formatNumber(at169, 3).padStart(7)}  ` +
          `${formatNumber(worst.delta, 3).padStart(8)}  ` +
          `${formatNumber(worst.aspect, 3).padStart(9)}  ` +
          `${formatNumber(worst.fraction * 100, 2).padStart(7)} %`,
      );
    }
  }
  check(
    'the 16:9 solve is identical with one or four melds, every human seat',
    meldExactLandscape,
  );
  check(
    'no meld declaration moves the solve by more than 2 % (0.75 units)',
    meldStable,
  );

  const sixteenNine = L.frameForAspect(C.CAMERA.framingAspect, board);
  check(
    'the 16:9 frame keeps the committed 75 mm / 50° lens, solved from the board',
    sixteenNine.pitchDeg === C.CAMERA.pitchDeg &&
      close(sixteenNine.tanHalfHorizontal, 18 / 75, 1e-12) &&
      sixteenNine.distanceUnits < C.CAMERA.distanceUnits,
    `d = ${formatNumber(sixteenNine.distanceUnits, 3)} (reference ${C.CAMERA.distanceUnits})`,
  );
  const reference = L.referenceFrame(C.CAMERA.framingAspect);
  const referenceCorners = matCorners.map((corner) =>
    L.projectToPixels(corner, reference, 1920, 1080),
  );
  console.log(
    '  reference 16:9 mat corners (1920x1080): ' +
      referenceCorners
        .map((point) => `(${Math.round(point.x)}, ${Math.round(point.y)})`)
        .join(' '),
  );
  console.log(
    '  shipped 16:9 mat corners   (1920x1080): ' +
      matCorners
        .map((corner) => {
          const point = L.projectToPixels(corner, sixteenNine, 1920, 1080);
          return `(${Math.round(point.x)}, ${Math.round(point.y)})`;
        })
        .join(' '),
  );

  /* ----------------------------- gaps -------------------------------- */
  // 3D-20: the defect the user reported was seeing *through* a slot where two
  // tiles should meet, so the gate measures the slots themselves. Nothing may sit
  // between touching and clearly apart: a pair is either in contact (0 up to the
  // touching tolerance) or at least `GAP.maxTouchingGapUnits` away.
  console.log('tile gaps (surface-to-surface; a slot is a gap in (0.000001, 0.05])');
  const reportGaps = (label, board) => {
    const measured = G.tileGaps(board.tiles);
    const slots = G.slotGaps(measured);
    const merged = G.overlaps(measured);
    const touching = G.touchingByZone(measured);
    const touchingCount = [...touching.values()].reduce((sum, count) => sum + count, 0);
    console.log(
      `  ${label}: ${board.tiles.length} tiles, ${touchingCount} touching pairs, ` +
        `${slots.length} slots, ${merged.length} overlapping`,
    );
    const zoneRows = [...touching.entries()].sort((left, right) => right[1] - left[1]);
    if (zoneRows.length) {
      console.log(
        `    touching by zone: ${zoneRows.map(([zone, count]) => `${zone} ${count}`).join(', ')}`,
      );
    }
    const worst = [...slots].sort((left, right) => right.gapUnits - left.gapUnits).slice(0, 6);
    for (const slot of worst) {
      console.log(
        `    slot ${formatNumber(slot.gapUnits, 5)} u ` +
          `(${formatNumber(slot.gapUnits * C.UNIT_MM, 2)} mm): ${slot.aId} x ${slot.bId}`,
      );
    }
    const narrowest = [...measured]
      .filter((gap) => gap.gapUnits > G.GAP.maxTouchingGapUnits)
      .sort((left, right) => left.gapUnits - right.gapUnits)
      .slice(0, 3);
    for (const deliberate of narrowest) {
      console.log(
        `    deliberate gap ${formatNumber(deliberate.gapUnits, 4)} u: ` +
          `${deliberate.aId} x ${deliberate.bId}`,
      );
    }
    return { slots, merged };
  };

  const fixtureGaps = reportGaps('fixture board', board);
  check(
    'no tile pair leaves a slot between touching and clearly apart',
    fixtureGaps.slots.length === 0,
    fixtureGaps.slots.length ? `${fixtureGaps.slots.length} slot(s)` : '0 slots',
  );
  check(
    'no two tiles interpenetrate',
    fixtureGaps.merged.length === 0,
    fixtureGaps.merged.length ? `${fixtureGaps.merged.length} overlap(s)` : '0 overlaps',
  );
  const widestGaps = reportGaps('widest board', widest);
  check(
    'the widest board leaves no slot either',
    widestGaps.slots.length === 0,
    widestGaps.slots.length ? `${widestGaps.slots.length} slot(s)` : '0 slots',
  );
  console.log();

  console.log();
  if (failures.length) {
    console.log(`FAILED ${failures.length} invariant(s):`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('all 3D layout invariants pass');
}

main().catch((error) => {
  console.error('3D layout gate crashed:', error);
  process.exitCode = 1;
});
