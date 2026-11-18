import type { ComponentType, SVGProps } from 'react';
import {
  RegularNan,
  RegularPei,
  RegularShaa,
  RegularTon,
} from 'riichi-mahjong-tiles';
import type { Wind } from '../types/game';

type WindGlyphComponent = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * The wind symbol for each seat, drawn without a tile body.
 *
 * Both table views need it: the flat plan's compass and the rendered table's
 * compass show the same four symbols. Keeping the map in one module is what
 * stops the two views from disagreeing about which glyph means which wind.
 */
const WIND_GLYPHS: Record<Wind, WindGlyphComponent> = {
  East: RegularTon,
  South: RegularNan,
  West: RegularShaa,
  North: RegularPei,
};

interface WindGlyphProps {
  wind: Wind;
  className?: string;
}

/** One seat's wind symbol, decorative (the seat's label carries the meaning). */
export function WindGlyph({ wind, className }: WindGlyphProps) {
  const Glyph = WIND_GLYPHS[wind];
  return (
    <Glyph
      className={className}
      aria-hidden="true"
      focusable="false"
    />
  );
}
