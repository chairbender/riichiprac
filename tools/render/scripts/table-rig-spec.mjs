#!/usr/bin/env node
/**
 * Rig-variant resolution shared by the publisher and the checker.
 *
 * A variant is an A/B experiment on the Task 2 rig: it may override the table
 * layout (hand/meld radii, hand tilt), the camera, the lights, the render
 * settings and the acceptance thresholds. The base `rig` blocks are the saved
 * baseline (v1-baseline), so an empty variant is exactly the first committed
 * rig. Lists replace wholesale (a lighting override supplies the full fills
 * list); objects merge key by key.
 */

export const RIG_MERGE_KEYS = ['camera', 'lighting', 'render', 'output', 'samples', 'checks'];

export function deepMerge(base, override) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return override;
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return merged;
}

/** The variant and its `extends` ancestors, oldest first. */
export function variantChain(rig, id) {
  const chain = [];
  const seen = new Set();
  let current = id;
  while (current) {
    if (seen.has(current)) throw new Error(`table-rig: variant cycle through ${current}`);
    seen.add(current);
    const variant = rig.variants?.[current];
    if (!variant) {
      throw new Error(
        `table-rig: unknown variant ${current}; variants: ` +
          `${Object.keys(rig.variants ?? {}).join(', ') || '(none)'}`,
      );
    }
    chain.push(variant);
    current = variant.extends;
  }
  return chain.reverse();
}

/** Resolve a rig variant (and any `extends` chain) into its explicit settings. */
export function resolveRigVariant(spec, requested) {
  const rig = spec.rig;
  const id = requested ?? rig.defaultVariant;
  const chain = variantChain(rig, id);
  const variant = chain.reduce((merged, entry) => {
    const next = deepMerge(
      merged,
      Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'extends')),
    );
    // The shadow block is a strategy, not a bag of settings: a variant that
    // declares one replaces its ancestor's instead of merging into it.
    if (entry.handShadow) next.handShadow = entry.handShadow;
    return next;
  }, {});
  variant.extends = chain[chain.length - 1].extends ?? null;
  const resolved = { ...rig };
  for (const key of RIG_MERGE_KEYS) {
    if (key in rig) resolved[key] = deepMerge(rig[key], variant[key] ?? {});
  }
  delete resolved.variants;
  for (const extra of ['lightingCheat', 'handShadow']) {
    if (variant[extra]) resolved[extra] = variant[extra];
  }
  const table = deepMerge(spec.table, variant.table ?? {});
  return { id, variant, rig: resolved, table };
}

/** Variant ids ordered for the A/B page. */
export function orderedVariants(spec) {
  return Object.entries(spec.rig.variants ?? {})
    .sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0) || a[0].localeCompare(b[0]))
    .map(([id, variant]) => ({ id, variant }));
}
