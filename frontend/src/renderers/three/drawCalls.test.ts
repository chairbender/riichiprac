/**
 * The steady-state draw-call budget (3D-07 acceptance: `drawCalls ≤ 5` since
 * 3D-09 added the physical compass plate; it was 4 before that).
 *
 * CI has no GPU, so the renderer cannot render and report `info.render.calls`.
 * What *can* be proven in Node is the thing that decides that number: the whole
 * board is one instanced mesh, the contact shadows are one instanced mesh, the
 * sticks are one instanced mesh, the compass is one plate mesh and the felt is
 * one plane. This file builds the board layers from the real production builders
 * and counts the meshes three would draw (one call per visible mesh here: no
 * multi-material groups, no lines, no points), then checks that plan against the
 * budget.
 *
 * `measure().drawCalls` still reports the renderer's own count in the browser;
 * this is the offline gate for the same claim.
 */

import { Mesh, MeshBasicMaterial, PlaneGeometry, Scene, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { boardFixture } from './boardFixture';
import { layoutBoard } from './boardLayout';
import { buildBoardInstances, createBoardMesh } from './boardMesh';
import { createCompassPlate } from './compassPlate';
import { SCENE_DRAW_CALLS, countSceneDrawCalls, steadyStateDrawCalls } from './Scene';
import { createShadowLayer, shadowInstances } from './shadows';
import { createStickMesh } from './sticks';
import { createTileMaterial } from './tileMaterial';

const BUDGET = 5;

const layout = layoutBoard(boardFixture());

/** Build the whole scene the way `TableScene.buildBoard` does, minus WebGL. */
function buildBoardScene(): Scene {
  const material = createTileMaterial({
    tier: 'high',
    debug: null,
    albedo: new Texture(),
    normalDepth: new Texture(),
    aoRoughness: new Texture(),
  });
  const scene = new Scene();
  // The felt is a single plane (`felt.ts`); its texture needs a 2D canvas, so
  // the test substitutes an untextured plane with the same mesh shape.
  scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
  scene.add(createShadowLayer(shadowInstances(layout)).mesh);
  scene.add(
    createBoardMesh(buildBoardInstances(layout, () => null), material).mesh,
  );
  scene.add(createStickMesh(layout.sticks).mesh);
  scene.add(createCompassPlate().mesh);
  return scene;
}

describe('the default scene draw plan', () => {
  it('plans five draws: felt, shadows, tiles, sticks, compass plate', () => {
    expect(SCENE_DRAW_CALLS).toEqual({
      felt: 1,
      shadows: 1,
      tiles: 1,
      sticks: 1,
      compassPlate: 1,
    });
    expect(steadyStateDrawCalls()).toBe(BUDGET);
  });

  it('builds exactly that many drawables for the whole fixture board', () => {
    const scene = buildBoardScene();
    const calls = countSceneDrawCalls(scene);
    expect(calls).toBe(BUDGET);
    expect(calls).toBeLessThanOrEqual(BUDGET);
  });

  it('keeps the count independent of how many tiles the snapshot holds', () => {
    // A sparse table and a deep one both draw five meshes: the tile count is
    // instance data, not draw calls (§2.8).
    const sparse = layoutBoard(
      boardFixture({ riverCounts: [0, 0, 0, 0], meldCounts: [0, 0, 0, 0], doraCount: 0, draw: false }),
    );
    const lush = layoutBoard(boardFixture({ riverCounts: [22, 22, 22, 22], kan: true }));
    const scenes = [sparse, lush].map((board) => {
      const material = createTileMaterial({
        tier: 'high',
        debug: null,
        albedo: new Texture(),
        normalDepth: new Texture(),
        aoRoughness: new Texture(),
      });
      const scene = new Scene();
      scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
      scene.add(createShadowLayer(shadowInstances(board)).mesh);
      scene.add(createBoardMesh(buildBoardInstances(board, () => null), material).mesh);
      scene.add(createStickMesh(board.sticks).mesh);
      scene.add(createCompassPlate().mesh);
      return scene;
    });
    expect(sparse.tiles.length).toBeLessThan(lush.tiles.length);
    for (const scene of scenes) expect(countSceneDrawCalls(scene)).toBe(BUDGET);
  });
});
