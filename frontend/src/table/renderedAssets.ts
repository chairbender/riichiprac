/**
 * Asset loading for the rendered table: the startup atlas plus the committed
 * felt raster.
 *
 * Both are memoised per page, so switching away and back does not re-fetch or
 * re-compose anything. A failed load clears its own memo so the next attempt
 * retries; `RenderedTable` treats any failure as a reason to fall back to the
 * top-down plan.
 */
import { loadFirstBoardAtlas } from './TileAtlas';
import type { TileAtlas } from './TileAtlas';

export interface RenderedTableAssets {
  readonly atlas: TileAtlas;
  readonly felt: CanvasImageSource;
}

export type LoadRenderedTableAssets = () => Promise<RenderedTableAssets>;

function joinUrl(base: string, relativePath: string): string {
  const left = base.endsWith('/') ? base : `${base}/`;
  const right = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  return `${left}${right}`;
}

/** `public/table/`, honouring Vite's deployed base path. */
export function tableBaseUrl(): string {
  const base =
    typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL
      ? String(import.meta.env.BASE_URL)
      : '/';
  return joinUrl(base, 'table');
}

function loadImage(url: string): Promise<CanvasImageSource> {
  if (typeof Image === 'undefined') {
    return Promise.reject(new Error(`cannot load ${url}: no Image constructor`));
  }
  return new Promise<CanvasImageSource>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`cannot decode the felt ${url}`));
    image.src = url;
  });
}

let sharedFelt: Promise<CanvasImageSource> | null = null;

/** The committed felt raster, loaded once per page. */
export function loadRenderedFelt(): Promise<CanvasImageSource> {
  if (!sharedFelt) {
    sharedFelt = loadImage(joinUrl(tableBaseUrl(), 'felt.png')).catch(
      (error: unknown) => {
        sharedFelt = null;
        throw error;
      },
    );
  }
  return sharedFelt;
}

/** Drop the shared felt. Tests use this; production has one lifetime. */
export function resetRenderedAssets(): void {
  sharedFelt = null;
}

/** Production loader: the app-wide atlas plus the committed felt. */
export const loadDefaultRenderedAssets: LoadRenderedTableAssets = async () => {
  const [atlas, felt] = await Promise.all([
    loadFirstBoardAtlas(),
    loadRenderedFelt(),
  ]);
  return { atlas, felt };
};
