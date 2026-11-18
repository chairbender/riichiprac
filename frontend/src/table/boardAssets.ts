/**
 * The rendered board's non-atlas manifests.
 *
 * `TileAtlas.load` owns `shells.json`, `faces.json` and `decals.json`. The
 * contact-shadow layer is published separately (`overlays.json` for the
 * synthetic bands, `catches.json` for the standing 3D catches,
 * `lying-catches.json` for the ponds/melds), so the board opens them here.
 *
 * Every manifest is optional at runtime: the board still composes if a file is
 * missing or malformed, it just draws no contact decals. A missing `overlays`
 * manifest is the only one that must exist for the parser calls (the decal path
 * is skipped without it), so a failed fetch yields `null` and the compositor
 * skips the decal pass.
 */
import { tableAssetUrl } from './TileAtlas';
import { parseOverlayManifest } from './overlayManifest';
import type { OverlayManifest } from './overlayManifest';
import { parseCatchesManifest } from './catchManifest';
import type { CatchesManifest } from './catchManifest';
import { parseLyingCatchesManifest } from './lyingCatchManifest';
import type { LyingCatchesManifest } from './lyingCatchManifest';

export interface BoardAssets {
  readonly overlays: OverlayManifest | null;
  readonly catches: CatchesManifest | null;
  readonly lyingCatches: LyingCatchesManifest | null;
}

export interface BoardAssetLoadOptions {
  readonly urlFor?: (path: string) => string;
  readonly fetchJson?: (url: string) => Promise<unknown>;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  if (typeof fetch !== 'function') {
    throw new Error(`cannot fetch ${url}: no fetch available`);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cannot fetch ${url}: HTTP ${response.status}`);
  return response.json();
}

async function fetchManifest(
  url: string,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<unknown | null> {
  try {
    return await fetchJson(url);
  } catch (error) {
    console.warn(`rendered table: ${String(error)}`);
    return null;
  }
}

/** Read and validate the three decal manifests, tolerating any missing one. */
export async function loadBoardAssets(
  options: BoardAssetLoadOptions = {},
): Promise<BoardAssets> {
  const urlFor = options.urlFor ?? ((path: string) => tableAssetUrl(path));
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const [overlaysRaw, catchesRaw, lyingRaw] = await Promise.all([
    fetchManifest(urlFor('overlays.json'), fetchJson),
    fetchManifest(urlFor('catches.json'), fetchJson),
    fetchManifest(urlFor('lying-catches.json'), fetchJson),
  ]);

  let overlays: OverlayManifest | null = null;
  if (overlaysRaw) {
    try {
      overlays = parseOverlayManifest(overlaysRaw);
    } catch (error) {
      console.warn(`rendered table: overlays.json rejected: ${String(error)}`);
    }
  }
  let catches: CatchesManifest | null = null;
  if (catchesRaw) {
    try {
      catches = parseCatchesManifest(catchesRaw);
    } catch (error) {
      console.warn(`rendered table: catches.json rejected: ${String(error)}`);
    }
  }
  let lyingCatches: LyingCatchesManifest | null = null;
  if (lyingRaw) {
    try {
      lyingCatches = parseLyingCatchesManifest(lyingRaw);
    } catch (error) {
      console.warn(`rendered table: lying-catches.json rejected: ${String(error)}`);
    }
  }
  return { overlays, catches, lyingCatches };
}

let sharedAssets: Promise<BoardAssets> | null = null;

/** The app-wide decal manifests, fetched once. A failed load may retry. */
export function loadFirstBoardAssets(
  options: BoardAssetLoadOptions = {},
): Promise<BoardAssets> {
  if (!sharedAssets) {
    sharedAssets = loadBoardAssets(options).catch((error: unknown) => {
      sharedAssets = null;
      throw error;
    });
  }
  return sharedAssets;
}

/** Drop the shared manifests. Tests use this. */
export function resetSharedBoardAssets(): void {
  sharedAssets = null;
}
