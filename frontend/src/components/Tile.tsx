import type { ComponentType, SVGProps } from 'react';
import { formatTileForDisplay } from '../display';
import {
  RegularMan1M,
  RegularMan2M,
  RegularMan3M,
  RegularMan4M,
  RegularMan5M,
  RegularMan5DoraM,
  RegularMan6M,
  RegularMan7M,
  RegularMan8M,
  RegularMan9M,
  RegularPin1M,
  RegularPin2M,
  RegularPin3M,
  RegularPin4M,
  RegularPin5M,
  RegularPin5DoraM,
  RegularPin6M,
  RegularPin7M,
  RegularPin8M,
  RegularPin9M,
  RegularSou1M,
  RegularSou2M,
  RegularSou3M,
  RegularSou4M,
  RegularSou5M,
  RegularSou5DoraM,
  RegularSou6M,
  RegularSou7M,
  RegularSou8M,
  RegularSou9M,
  RegularTonM,
  RegularNanM,
  RegularShaaM,
  RegularPeiM,
  RegularHakuM,
  RegularHatsuM,
  RegularChunM,
  RegularBlankM,
  RegularBackM,
} from 'riichi-mahjong-tiles';

type TileSvg = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Maps 34 standard Riichi tile codes to merged `riichi-mahjong-tiles` SVGs.
 * The merged `...M` variants include the white tile body along with the symbol.
 */
const TILE_MAP: Record<string, TileSvg> = {
  '1m': RegularMan1M,
  '2m': RegularMan2M,
  '3m': RegularMan3M,
  '4m': RegularMan4M,
  '5m': RegularMan5M,
  '6m': RegularMan6M,
  '7m': RegularMan7M,
  '8m': RegularMan8M,
  '9m': RegularMan9M,
  '1p': RegularPin1M,
  '2p': RegularPin2M,
  '3p': RegularPin3M,
  '4p': RegularPin4M,
  '5p': RegularPin5M,
  '6p': RegularPin6M,
  '7p': RegularPin7M,
  '8p': RegularPin8M,
  '9p': RegularPin9M,
  '1s': RegularSou1M,
  '2s': RegularSou2M,
  '3s': RegularSou3M,
  '4s': RegularSou4M,
  '5s': RegularSou5M,
  '6s': RegularSou6M,
  '7s': RegularSou7M,
  '8s': RegularSou8M,
  '9s': RegularSou9M,
  '1z': RegularTonM,
  '2z': RegularNanM,
  '3z': RegularShaaM,
  '4z': RegularPeiM,
  '5z': RegularHakuM,
  '6z': RegularHatsuM,
  '7z': RegularChunM,
};

/** Red-five (aka dora) variants of the five tiles. */
const RED_FIVE_MAP: Record<string, TileSvg> = {
  '5m': RegularMan5DoraM,
  '5p': RegularPin5DoraM,
  '5s': RegularSou5DoraM,
};

interface TileProps {
  /** Tile code such as "1m", "5p", or "7z". */
  code: string;
  className?: string;
  /** Render the red-five variant of a 5 tile. */
  isRedFive?: boolean;
}

export function Tile({ code, className, isRedFive = false }: TileProps) {
  const TileSvg =
    (isRedFive ? RED_FIVE_MAP[code] : undefined) ??
    TILE_MAP[code] ??
    RegularBlankM;
  const label = formatTileForDisplay(code, isRedFive);

  return (
    <TileSvg
      className={className}
      role="img"
      aria-label={label}
      focusable="false"
    />
  );
}

interface TileBackProps {
  className?: string;
}

/**
 * A face-down tile: the package's merged regular back, so it has the same
 * 300 × 400 body as `Tile`'s merged faces and sits in the same footprint.
 *
 * Only the places that conceal a tile use it — a closed kan's two outer tiles
 * in the meld list. The hand, river and wall drawing is unchanged, and the
 * label says the tile is face down rather than naming a face it does not show.
 */
export function TileBack({ className }: TileBackProps) {
  return (
    <RegularBackM
      className={className}
      role="img"
      aria-label="face-down tile"
      focusable="false"
    />
  );
}
