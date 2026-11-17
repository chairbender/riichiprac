// Throwaway: the row-repeat metric that the side-hand camera has to satisfy.
// A hand row pastes ONE shell down its published gridStepPx.x. The tile is a
// lens (widest at its near end); stacked, every tile's near end pokes out past
// the next tile's far end. This measures that poke, plus the union outline's
// sawtooth, in @1x px.
import { readPng, drawSprite } from '/home/kylehipke/workspaces/riichiprac-261116-2217/tools/render/scripts/png.mjs';

const A = 128;

export function silhouette(sprite, w = sprite.width, h = sprite.height) {
  const rows = [];
  for (let y = 0; y < h; y += 1) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < w; x += 1) {
      if (sprite.data[(y * w + x) * 4 + 3] >= A) {
        if (left < 0) left = x;
        right = x;
      }
    }
    rows.push(left < 0 ? null : { left, right, width: right - left + 1 });
  }
  return rows;
}

/** Composite `count` copies of the sprite down the step and measure the union. */
export function rowMetrics(sprite, record, count = 3, scale = 1) {
  const step = [record.gridStepPx.x[0] * scale, record.gridStepPx.x[1] * scale];
  const anchor = [record.anchorX * scale, record.anchorY * scale];
  const pad = 40 * scale;
  const W = Math.ceil(sprite.width + Math.abs(step[0]) * (count - 1) + 2 * pad);
  const H = Math.ceil(sprite.height + Math.abs(step[1]) * (count - 1) + 2 * pad);
  const canvas = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  const ox = pad + (step[0] < 0 ? Math.abs(step[0]) * (count - 1) : 0);
  const oy = pad;
  const tops = [];
  for (let i = 0; i < count; i += 1) {
    const gx = Math.round(ox + i * step[0] - anchor[0]);
    const gy = Math.round(oy + i * step[1] - anchor[1]);
    drawSprite(canvas, sprite, gx, gy);
    tops.push({ y: Math.round(oy + i * step[1]), x: Math.round(ox + i * step[0]) });
  }
  const rows = silhouette(canvas);

  // Flare: one tile's own silhouette width at its narrowest (far) row vs its
  // widest row inside one step.
  const own = silhouette(sprite);
  const bodyStart = Math.round(record.anchorY * scale) + scale;
  const bodyEnd = Math.round((record.anchorY + record.advanceHeight) * scale) - scale;
  let narrow = Infinity;
  let wide = 0;
  const stepDown = Math.abs(Math.round(record.gridStepPx.x[1] * scale));
  for (let y = bodyStart; y <= Math.min(bodyEnd, bodyStart + stepDown); y += 1) {
    const row = own[y];
    if (!row) continue;
    narrow = Math.min(narrow, row.width);
    wide = Math.max(wide, row.width);
  }

  // Wedge: at each tile's top row, how much wider the union is than that tile's
  // own silhouette there. That poke is the next tile's near end sticking out.
  const wedges = [];
  for (let i = 1; i < count; i += 1) {
    const gy = tops[i].y;
    const union = rows[gy];
    const tileTop = own[Math.round(record.anchorY * scale) + scale];
    if (!union || !tileTop) continue;
    wedges.push(union.width - tileTop.width);
  }

  // Sawtooth: the union's left edge over the middle tile, against a straight
  // line fit through the whole column.
  const ys = [];
  const lefts = [];
  const rights = [];
  for (let y = tops[0].y; y <= tops[count - 1].y; y += 1) {
    const row = rows[y];
    if (!row) continue;
    ys.push(y);
    lefts.push(row.left);
    rights.push(row.right);
  }
  const fit = (values) => {
    const n = ys.length;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const mv = values.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
      num += (ys[i] - my) * (values[i] - mv);
      den += (ys[i] - my) ** 2;
    }
    const slope = den ? num / den : 0;
    let worst = 0;
    for (let i = 0; i < n; i += 1) {
      worst = Math.max(worst, Math.abs(values[i] - (mv + slope * (ys[i] - my))));
    }
    return worst;
  };

  // Blue-back share: the fraction of the body's fully opaque px that read as
  // blue resin (blue over red by 60, the resin family on every shell). The
  // candidates hold the camera ANGLE fixed, so this number must stay ~level
  // with the committed REF; a drop would mean the frustum scale changed which
  // surfaces the camera sees, not just their convergence.
  let covered = 0;
  let blue = 0;
  let white = 0;
  for (let y = bodyStart; y <= bodyEnd; y += 1) {
    for (let x = Math.round(record.anchorX * scale); x < Math.round((record.anchorX + record.advanceWidth) * scale); x += 1) {
      const o = (y * sprite.width + x) * 4;
      if (sprite.data[o + 3] < 250) continue;
      covered += 1;
      const [r, g, b] = [sprite.data[o], sprite.data[o + 1], sprite.data[o + 2]];
      if (b - r >= 60) blue += 1;
      if (r > 150 && r > b) white += 1;
    }
  }

  return {
    step,
    flare: wide - narrow,
    narrow,
    wide,
    wedges,
    wedge: wedges.length ? wedges.reduce((a, b) => a + b, 0) / wedges.length : 0,
    sawLeft: fit(lefts),
    sawRight: fit(rights),
    blueShare: covered ? blue / covered : 0,
    whiteShare: covered ? white / covered : 0,
    canvas,
    rows,
  };
}

if (process.argv[1]?.endsWith('side-hand-metrics.mjs')) {
  const { readFileSync } = await import('node:fs');
  const table = '/home/kylehipke/workspaces/riichiprac-261116-2217/frontend/public/table';
  const manifest = JSON.parse(readFileSync(`${table}/shells.json`, 'utf8'));
  for (const id of ['shell_hand_side_left', 'shell_hand_side_right']) {
    const record = manifest.shells[id];
    const sprite = readPng(`${table}/${record.textureFile}`);
    const m = rowMetrics(sprite, record, 3);
    console.log(
      `${id}: step ${m.step.join(',')} flare ${m.flare}px (${m.narrow}..${m.wide}) ` +
        `wedge ${m.wedge.toFixed(1)}px per tile ${JSON.stringify(m.wedges)} ` +
        `sawtooth L ${m.sawLeft.toFixed(1)} R ${m.sawRight.toFixed(1)} ` +
        `blue ${(m.blueShare * 100).toFixed(0)}%`,
    );
  }
}
