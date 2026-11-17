/**
 * Asset loading for the rendered table (Phase 4).
 *
 * The board needs four things beside the startup atlas:
 *
 *   - the committed `shells.json` (the atlas holds it already);
 *   - `overlays.json` and the two catch manifests, for the Phase 3.5 contact
 *     decals drawn between bodies;
 *   - the @1x PNGs of every shell whose face is bare (walls, the top hand, the
 *     side hands), plus the contact decals the current board uses.
 *
 * Face-up tiles are blitted from the startup atlas and need no extra image.
 * The loader collects the exact image set from the built board, so a hand
 * without a wall or a call does not download unused textures.
 */
import { parseCatchesManifest } from './catchManifest';
import type { CatchesManifest } from './catchManifest';
import { parseLyingCatchesManifest } from './lyingCatchManifest';
import type { LyingCatchesManifest } from './lyingCatchManifest';
import { parseOverlayManifest } from './overlayManifest';
import type { OverlayManifest } from './overlayManifest';
import type { Board } from './boardLayout';
import type { ContactOverlay } from './contactOverlays';
import type { ShellsManifest } from './shellManifest';
import { isFaceUpShellId } from './tiles';
import { TileAtlas, loadFirstBoardAtlas, tableAssetBaseUrl, tableAssetUrl } from './TileAtlas';

export interface TableManifests {
  readonly overlays: OverlayManifest | null;
  readonly catches: CatchesManifest | null;
  readonly lyingCatches: LyingCatchesManifest | null;
}

export interface RenderedTableAssets extends TableManifests {
  readonly baseUrl: string;
  readonly atlas: TileAtlas;
  /** The table directory's felt raster, for the view background. */
  readonly feltUrl: string;
}

export interface LoadRenderedTableOptions {
  readonly baseUrl?: string;
  readonly fetchJson?: (url: string) => Promise<unknown>;
  readonly atlas?: TileAtlas;
}

function defaultFetchJson(): (url: string) => Promise<unknown> {
  return async (url) => {
    if (typeof fetch !== 'function') throw new Error(`cannot fetch ${url}: no fetch available`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`cannot fetch ${url}: HTTP ${response.status}`);
    return response.json();
  };
}

async function optional<T>(
  label: string,
  load: () => Promise<T>,
): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    // Contact shadows are polish; a missing manifest must not hide the table.
    console.warn(`${label} unavailable: ${String(error)}`);
    return null;
  }
}

/** Load the atlas plus the optional contact-shadow manifests. */
export async function loadRenderedTableAssets(
  options: LoadRenderedTableOptions = {},
): Promise<RenderedTableAssets> {
  const baseUrl = options.baseUrl ?? tableAssetBaseUrl();
  const fetchJson = options.fetchJson ?? defaultFetchJson();
  const atlas =
    options.atlas ??
    (await loadFirstBoardAtlas({
      baseUrl,
      ...(options.fetchJson ? { fetchJson } : {}),
    }));

  const [overlays, catches, lyingCatches] = await Promise.all([
    optional('overlays.json', async () =>
      parseOverlayManifest(await fetchJson(tableAssetUrl('overlays.json', baseUrl))),
    ),
    optional('catches.json', async () =>
      parseCatchesManifest(await fetchJson(tableAssetUrl('catches.json', baseUrl))),
    ),
    optional('lying-catches.json', async () =>
      parseLyingCatchesManifest(await fetchJson(tableAssetUrl('lying-catches.json', baseUrl))),
    ),
  ]);

  return {
    baseUrl,
    atlas,
    overlays,
    catches,
    lyingCatches,
    feltUrl: tableAssetUrl('felt.png', baseUrl),
  };
}

/**
 * Every 1x texture the board draws outside the atlas: bare shell bodies and
 * the contact decals resolved for each zone. Deduplicated and stable-sorted so
 * the load order does not depend on object iteration.
 */
export function boardImagePaths(
  board: Board,
  manifest: ShellsManifest,
  overlaysByZone: ReadonlyMap<string, readonly ContactOverlay[]>,
): string[] {
  const paths = new Set<string>();
  for (const placement of board.zones) {
    for (const tile of placement.zone.bodies) {
      if (tile.face && isFaceUpShellId(tile.shell)) continue;
      const shell = manifest.shells[tile.shell];
      if (shell) paths.add(shell.textureFile);
    }
  }
  for (const overlays of overlaysByZone.values()) {
    for (const overlay of overlays) paths.add(overlay.textureFile);
  }
  return [...paths].sort();
}

/** Decode every path not already in `cache`; returns the same map. */
export async function loadBoardImages(
  paths: readonly string[],
  cache: Map<string, CanvasImageSource>,
  options: {
    readonly baseUrl?: string;
    readonly loadImage?: (url: string) => Promise<CanvasImageSource>;
    readonly tableBaseUrl?: string;
  } = {},
): Promise<Map<string, CanvasImageSource>> {
  const baseUrl = options.tableBaseUrl ?? options.baseUrl ?? tableAssetBaseUrl();
  const loadImage = options.loadImage ?? browserLoadImage;
  const missing = paths.filter((path) => !cache.has(path));
  const loaded = await Promise.all(
    missing.map(async (path) => {
      const image = await loadImage(tableAssetUrl(path, baseUrl));
      cache.set(path, image);
      return image;
    }),
  );
  if (loaded.length !== missing.length) {
    throw new Error('rendered table: image loader dropped a texture');
  }
  return cache;
}

/** Browser image decoder; tests inject their own. */
export function browserLoadImage(url: string): Promise<CanvasImageSource> {
  if (typeof Image === 'undefined') {
    return Promise.reject(new Error(`cannot decode ${url}: no Image constructor`));
  }
  const image = new Image();
  image.decoding = 'async';
  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`cannot decode image ${url}`));
    image.src = url;
  });
}
