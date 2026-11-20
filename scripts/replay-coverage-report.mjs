#!/usr/bin/env node
/**
 * Report which lessons the hosted replay packs cover, and which are
 * replay-default.
 *
 *   node scripts/replay-coverage-report.mjs
 *   node scripts/replay-coverage-report.mjs --json > coverage.json
 *
 * The coverage floor is the product rule from `replay-first-rollout.md`: a
 * lesson is replay-default when its shipped reviewed-base count reaches
 * `MIN_REPLAY_BASES` (40). The app reads the same numbers from the manifest's
 * `lesson_counts` without downloading a body, so this script reads the
 * manifest only — no pack body is fetched or decoded.
 *
 * It prints one row per covered lesson (pack, section, bases, floor) plus the
 * hosted packs that carry no counts, and exits 1 when the manifest is missing
 * or malformed. Thin lessons are reported, not failed: a lesson below the floor
 * stays generated-default by design and is opt-in in the picker.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FLOOR = 40;

function parseArgs(argv) {
  const parsed = {
    manifest: join(repoRoot, 'frontend', 'public', 'scenarios', 'manifest.json'),
    floor: DEFAULT_FLOOR,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, null];
    const value = () => {
      if (inline !== null) return inline;
      index += 1;
      if (index >= argv.length) {
        console.error(`${flag} needs a value`);
        process.exit(2);
      }
      return argv[index];
    };
    if (flag === '--manifest') parsed.manifest = resolve(process.cwd(), value());
    else if (flag === '--floor') parsed.floor = Number(value());
    else if (flag === '--json') parsed.json = true;
    else if (flag === '--help' || flag === '-h') {
      console.log('node scripts/replay-coverage-report.mjs [--manifest FILE] [--floor N] [--json]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(parsed.floor) || parsed.floor < 1) {
    console.error('--floor must be a positive integer');
    process.exit(2);
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
const packs = Array.isArray(manifest.packs) ? manifest.packs : null;
if (!packs) {
  console.error(`FAIL ${args.manifest} has no packs array`);
  process.exit(1);
}

const lessons = [];
const missing = [];
for (const pack of packs) {
  const counts = pack.lesson_counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    missing.push(pack.id);
    continue;
  }
  for (const lesson of Object.keys(counts).sort()) {
    const bases = counts[lesson];
    lessons.push({
      lesson,
      pack: pack.id,
      book_section: (pack.book_sections ?? [])[0] ?? null,
      bases,
      floor: args.floor,
      replay_default: bases >= args.floor,
    });
  }
}

lessons.sort((left, right) => left.lesson.localeCompare(right.lesson));
const covered = lessons.filter((row) => row.replay_default);
const thin = lessons.filter((row) => !row.replay_default);
const totalBases = lessons.reduce((sum, row) => sum + row.bases, 0);

const summary = {
  schema: 'riichiprac.replay-coverage',
  version: 1,
  manifest: args.manifest,
  floor: args.floor,
  packs: packs.map((pack) => pack.id),
  packs_without_counts: missing,
  lessons,
  replay_default: covered.map((row) => row.lesson),
  below_floor: thin.map((row) => row.lesson),
  totals: {
    lessons: lessons.length,
    replay_default: covered.length,
    below_floor: thin.length,
    reviewed_bases: totalBases,
  },
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    `replay coverage: ${summary.totals.replay_default}/${summary.totals.lessons} lesson(s) ` +
      `replay-default at ${args.floor} bases, ${summary.totals.reviewed_bases} reviewed bases`,
  );
  for (const row of lessons) {
    console.log(
      `  ${row.replay_default ? 'DEFAULT' : 'thin   '} ${row.lesson.padEnd(28)} ` +
        `${String(row.bases).padStart(5)} bases  ${row.pack}`,
    );
  }
  for (const pack of missing) {
    console.log(`  WARN ${pack} has no lesson_counts (coverage unknown, stays opt-in)`);
  }
}

process.exit(0);
