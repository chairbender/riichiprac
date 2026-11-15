/**
 * Dependency-free 5x7 bitmap font for the shell review sheets.
 *
 * The review artefacts are developer-only PNGs under the gitignored `build/`
 * directory. They annotate each candidate with its numbers, and AGENTS.md §6
 * requires the parameters to be printed rather than narrated, so the sheet has
 * to carry text. Pulling in a font renderer just for that would add a font file
 * and a native dependency to a script CI never runs; a 5x7 bitmap font keeps the
 * sheets deterministic and dependency-free.
 *
 * Only the characters the sheets use are defined. Anything else renders as a
 * blank advance. Text is drawn opaque; the sheets are review composites, not
 * shipped assets, so there is no anti-aliasing.
 */

/** 5 columns x 7 rows per glyph, one string per row. */
const GLYPHS = {
  ' ': '00000/00000/00000/00000/00000/00000/00000',
  A: '01110/10001/10001/11111/10001/10001/10001',
  B: '11110/10001/10001/11110/10001/10001/11110',
  C: '01111/10000/10000/10000/10000/10000/01111',
  D: '11110/10001/10001/10001/10001/10001/11110',
  E: '11111/10000/10000/11110/10000/10000/11111',
  F: '11111/10000/10000/11110/10000/10000/10000',
  G: '01110/10001/10000/10111/10001/10001/01110',
  H: '10001/10001/10001/11111/10001/10001/10001',
  I: '11111/00100/00100/00100/00100/00100/11111',
  J: '00111/00010/00010/00010/00010/10010/01100',
  K: '10001/10010/10100/11000/10100/10010/10001',
  L: '10000/10000/10000/10000/10000/10000/11111',
  M: '10001/11011/10101/10101/10001/10001/10001',
  N: '10001/11001/10101/10011/10001/10001/10001',
  O: '01110/10001/10001/10001/10001/10001/01110',
  P: '11110/10001/10001/11110/10000/10000/10000',
  Q: '01110/10001/10001/10001/10101/10010/01101',
  R: '11110/10001/10001/11110/10100/10010/10001',
  S: '01111/10000/10000/01110/00001/00001/11110',
  T: '11111/00100/00100/00100/00100/00100/00100',
  U: '10001/10001/10001/10001/10001/10001/01110',
  V: '10001/10001/10001/10001/10001/01010/00100',
  W: '10001/10001/10001/10101/10101/11011/10001',
  X: '10001/10001/01010/00100/01010/10001/10001',
  Y: '10001/10001/01010/00100/00100/00100/00100',
  Z: '11111/00001/00010/00100/01000/10000/11111',
  0: '01110/10001/10011/10101/11001/10001/01110',
  1: '00100/01100/00100/00100/00100/00100/01110',
  2: '01110/10001/00001/00010/00100/01000/11111',
  3: '11111/00010/00100/00010/00001/10001/01110',
  4: '00010/00110/01010/10010/11111/00010/00010',
  5: '11111/10000/11110/00001/00001/10001/01110',
  6: '00110/01000/10000/11110/10001/10001/01110',
  7: '11111/00001/00010/00100/01000/01000/01000',
  8: '01110/10001/10001/01110/10001/10001/01110',
  9: '01110/10001/10001/01111/00001/00010/01100',
  '.': '00000/00000/00000/00000/00000/01100/01100',
  ',': '00000/00000/00000/00000/01100/00100/01000',
  '-': '00000/00000/00000/11111/00000/00000/00000',
  '+': '00000/00100/00100/11111/00100/00100/00000',
  '/': '00001/00010/00010/00100/01000/01000/10000',
  '(': '00010/00100/01000/01000/01000/00100/00010',
  ')': '01000/00100/00010/00010/00010/00100/01000',
  ':': '00000/01100/01100/00000/01100/01100/00000',
  '=': '00000/00000/11111/00000/11111/00000/00000',
  '!': '00100/00100/00100/00100/00100/00000/00100',
  '?': '01110/10001/00001/00010/00100/00000/00100',
  '%': '11001/11010/00010/00100/01000/01011/10011',
  '°': '01110/10001/01110/00000/00000/00000/00000',
  '×': '00000/10001/01010/00100/01010/10001/00000',
};

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;

function rowsFor(character) {
  const glyph = GLYPHS[character] ?? GLYPHS[' '];
  return glyph.split('/');
}

/** Pixel width of `text` at `scale`, including the 1-column letter gap. */
export function textWidth(text, scale = 2, letterSpacing = 1) {
  if (!text.length) return 0;
  return (text.length * (GLYPH_WIDTH + letterSpacing) - letterSpacing) * scale;
}

/**
 * Draw uppercase text at (x, y) into an RGBA canvas. Returns the advance width.
 * Unknown characters (and lowercase, which is folded to uppercase) advance.
 */
export function drawText(canvas, text, x, y, options = {}) {
  const { scale = 2, rgb = [235, 240, 236], letterSpacing = 1 } = options;
  const [red, green, blue] = rgb;
  let cursor = Math.round(x);
  const top = Math.round(y);
  for (const raw of String(text).toUpperCase()) {
    const rows = rowsFor(raw);
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      const line = rows[row] ?? '00000';
      for (let column = 0; column < GLYPH_WIDTH; column += 1) {
        if (line[column] !== '1') continue;
        for (let dy = 0; dy < scale; dy += 1) {
          const py = top + row * scale + dy;
          if (py < 0 || py >= canvas.height) continue;
          for (let dx = 0; dx < scale; dx += 1) {
            const px = cursor + column * scale + dx;
            if (px < 0 || px >= canvas.width) continue;
            const offset = (py * canvas.width + px) * 4;
            canvas.data[offset] = red;
            canvas.data[offset + 1] = green;
            canvas.data[offset + 2] = blue;
            canvas.data[offset + 3] = 255;
          }
        }
      }
    }
    cursor += (GLYPH_WIDTH + letterSpacing) * scale;
  }
  return textWidth(String(text), scale, letterSpacing);
}

/** Greedy word wrap at `maxWidth` px, returned as lines. */
export function wrapText(text, maxWidth, scale = 2, letterSpacing = 1) {
  const words = String(text).toUpperCase().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, scale, letterSpacing) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}
