#!/usr/bin/env node
/**
 * Shared Task 3 layout rules for the proof publisher and the gate.
 *
 * The export (`bake_table_layout.py`) and this module both read the bucket
 * families from `table-reference-spec.json`'s `layout` block, so the two cannot
 * drift: the gate recomputes every bucket from the exported normalized x and
 * the projected face quad, and the probe measurement here is the one the proof
 * writes and the gate re-runs on the committed PNG.
 */

export function bucketFamilies(layoutSpec) {
  return layoutSpec.buckets;
}

/** Every bucket name a family can emit, upright and (for the flat family) turned. */
export function declaredBuckets(layoutSpec) {
  const declared = [];
  for (const family of bucketFamilies(layoutSpec)) {
    const seats = family.seats;
    if (seats && !Array.isArray(seats)) {
      for (const seat of Object.keys(seats)) {
        declared.push({ family: family.id, seat, name: seats[seat], rotated: false });
      }
      continue;
    }
    for (const name of family.names) {
      declared.push({ family: family.id, name, rotated: false });
      if (family.rotatedSuffix) {
        declared.push({ family: family.id, name: name + family.rotatedSuffix, rotated: true });
      }
    }
  }
  return declared;
}

export function familyFor(zone, seat, layoutSpec) {
  const matches = bucketFamilies(layoutSpec).filter((family) => {
    if (!family.zones.includes(zone)) return false;
    const seats = family.seats;
    if (seats == null) return true;
    if (Array.isArray(seats)) return seats.includes(seat);
    return seat in seats;
  });
  if (matches.length !== 1) {
    throw new Error(
      `table layout: zone ${zone}/${seat} matched ${matches.length} bucket families ` +
        `(${matches.map((family) => family.id).join(', ') || 'none'})`,
    );
  }
  return matches[0];
}

/** True when the projected TL -> TR edge reads more vertical than horizontal. */
export function isSideways(faceQuad, layoutSpec, resolution) {
  const [width, height] = resolution;
  const dx = (faceQuad[1].x - faceQuad[0].x) * width;
  const dy = (faceQuad[1].y - faceQuad[0].y) * height;
  const length = Math.hypot(dx, dy);
  if (length <= 0) throw new Error('table layout: degenerate face quad');
  return Math.abs(dx) / length <= layoutSpec.rotation.sidewaysMaxAbsCos;
}

export function bucketFor(zone, seat, x, faceQuad, layoutSpec, resolution) {
  const family = familyFor(zone, seat, layoutSpec);
  const sideways =
    Boolean(family.rotatedSuffix) && isSideways(faceQuad, layoutSpec, resolution);
  if (family.seats && !Array.isArray(family.seats)) return family.seats[seat];
  if (family.names.length !== family.boundaries.length + 1) {
    throw new Error(`table layout: family ${family.id} names/boundaries disagree`);
  }
  let index = 0;
  while (index < family.boundaries.length && x >= family.boundaries[index]) index += 1;
  return family.names[index] + (sideways ? family.rotatedSuffix : '');
}

/**
 * One component per probe marker, with its alpha-weighted centroid.
 *
 * The probe render is transparent film with only emissive spheres, so every
 * opaque blob is exactly one anchor marker. `alphaThreshold` seeds a component;
 * the centroid then weights the whole antialias fringe, which is what makes the
 * measurement subpixel.
 */
export function measureProbes(image, alphaThreshold) {
  const { width, height, data } = image;
  if (image.channels !== 4) throw new Error('table layout: probe must be RGBA');
  const components = [];
  const seen = new Uint8Array(width * height);
  const queue = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (seen[index]) continue;
      seen[index] = 1;
      if (data[index * 4 + 3] <= alphaThreshold) continue;
      let count = 0;
      let left = width;
      let right = -1;
      let top = height;
      let bottom = -1;
      queue.length = 0;
      queue.push(index);
      while (queue.length) {
        const pixel = queue.pop();
        count += 1;
        const px = pixel % width;
        const py = (pixel - px) / width;
        if (px < left) left = px;
        if (px > right) right = px;
        if (py < top) top = py;
        if (py > bottom) bottom = py;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbour = ny * width + nx;
          if (seen[neighbour]) continue;
          seen[neighbour] = 1;
          if (data[neighbour * 4 + 3] > alphaThreshold) queue.push(neighbour);
        }
      }
      let mass = 0;
      let sumX = 0;
      let sumY = 0;
      for (let py = Math.max(0, top - 2); py <= Math.min(height - 1, bottom + 2); py += 1) {
        for (let px = Math.max(0, left - 2); px <= Math.min(width - 1, right + 2); px += 1) {
          const alpha = data[(py * width + px) * 4 + 3] / 255;
          if (alpha === 0) continue;
          mass += alpha;
          sumX += alpha * (px + 0.5);
          sumY += alpha * (py + 0.5);
        }
      }
      components.push({
        x: sumX / mass,
        y: sumY / mass,
        mass: Math.round(mass),
        pixels: count,
        bbox: [left, top, right, bottom],
      });
    }
  }
  return components;
}

const round = (value) => Math.round(value * 1e6) / 1e6;

/**
 * Match every rendered marker to one exported anchor and measure the delta.
 *
 * Matching is greedy nearest with a hard radius: a marker that is farther than
 * `matchRadiusPx` from every unused anchor fails instead of being silently
 * assigned, and the caller also asserts that every anchor was used.
 */
export function matchProbes(components, slots, width, height, matchRadiusPx) {
  if (components.length !== slots.length) {
    throw new Error(
      `table layout: probe has ${components.length} markers but the layout has ${slots.length} slots`,
    );
  }
  const anchors = slots.map((slot) => ({
    id: slot.id,
    x: slot.anchor.x * width,
    y: slot.anchor.y * height,
  }));
  const matched = new Array(components.length).fill(-1);
  const used = new Set();
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    let best = -1;
    let bestDistance = Infinity;
    for (let other = 0; other < anchors.length; other += 1) {
      if (used.has(other)) continue;
      const distance = Math.hypot(anchors[other].x - component.x, anchors[other].y - component.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = other;
      }
    }
    if (best < 0 || bestDistance > matchRadiusPx) {
      throw new Error(
        `table layout: marker at (${component.x.toFixed(2)}, ${component.y.toFixed(2)}) is ` +
          `${bestDistance.toFixed(2)} px from the nearest unmatched anchor`,
      );
    }
    used.add(best);
    matched[index] = best;
  }
  if (used.size !== anchors.length) {
    throw new Error(`table layout: ${anchors.length - used.size} anchors have no marker`);
  }
  const records = new Map();
  let maxDelta = 0;
  let sumDelta = 0;
  for (let index = 0; index < components.length; index += 1) {
    const anchor = anchors[matched[index]];
    const component = components[index];
    const delta = Math.hypot(anchor.x - component.x, anchor.y - component.y);
    maxDelta = Math.max(maxDelta, delta);
    sumDelta += delta;
    records.set(anchor.id, {
      id: anchor.id,
      anchorPx: [round(anchor.x), round(anchor.y)],
      probePx: [round(component.x), round(component.y)],
      deltaPx: round(delta),
    });
  }
  const deltas = [...records.values()].map((record) => record.deltaPx).sort((a, b) => a - b);
  const p95 = deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))];
  return { records, maxDelta, meanDelta: sumDelta / components.length, p95 };
}

/** Normalized shoelace area; positive for the published TL, TR, BR, BL order. */
export function faceQuadArea(faceQuad) {
  let sum = 0;
  for (let index = 0; index < faceQuad.length; index += 1) {
    const next = (index + 1) % faceQuad.length;
    sum += faceQuad[index].x * faceQuad[next].y - faceQuad[next].x * faceQuad[index].y;
  }
  return sum / 2;
}
