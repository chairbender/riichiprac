#!/usr/bin/env node
/**
 * Report which lessons the hosted replay packs cover, and which are
 * replay-default.
 *
 *   node scripts/replay-coverage-report.mjs
 *   node scripts/replay-coverage-report.mjs --json > coverage.json
 *   node scripts/replay-coverage-report.mjs --catalogue lessons.json
 *
 * The coverage floor is the product rule from `replay-first-rollout.md`: a
 * lesson is replay-default when its shipped reviewed-base count reaches
 * `MIN_REPLAY_BASES` (40). The app reads the same numbers from the manifest's
 * `lesson_counts` without downloading a body, so this script reads the
 * manifest only — no pack body is fetched or decoded.
 *
 * `--catalogue FILE` merges the app's published lesson catalogue (the
 * `list_scenarios_json()` document, one entry per book lesson; dump it with
 * `cargo run --quiet --bin dump_scenarios`). A catalogue lesson that no hosted
 * pack carries gets a row with zero bases and `status: "not-shipped"`, so the
 * report names the generated-only lessons as well as the shipped ones.
 *
 * It prints one row per lesson (pack, section, bases, floor, decision) plus the
 * hosted packs that carry no counts, and exits 1 when the manifest or catalogue
 * is missing or malformed. Thin and not-shipped lessons are reported, not
 * failed: a lesson below the floor stays generated-default by design and is
 * opt-in in the picker (or has no replay row at all).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FLOOR = 40;

function parseArgs(argv) {
  const parsed = {
    manifest: join(repoRoot, 'frontend', 'public', 'scenarios', 'manifest.json'),
    catalogue: null,
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
    else if (flag === '--catalogue') parsed.catalogue = resolve(process.cwd(), value());
    else if (flag === '--floor') parsed.floor = Number(value());
    else if (flag === '--json') parsed.json = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        'node scripts/replay-coverage-report.mjs [--manifest FILE] [--catalogue FILE] ' +
          '[--floor N] [--json]',
      );
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

// The app's published catalogue, when given, supplies the true book section for
// every lesson and the lessons no pack carries at all.
const catalogueSections = new Map();
let catalogue = null;
if (args.catalogue) {
  catalogue = JSON.parse(readFileSync(args.catalogue, 'utf8'));
  if (!Array.isArray(catalogue)) {
    console.error(`FAIL ${args.catalogue} is not a scenario catalogue array`);
    process.exit(1);
  }
  for (const entry of catalogue) {
    const lesson = entry?.id;
    const section = entry?.book?.key;
    if (typeof lesson === 'string' && typeof section === 'string') {
      catalogueSections.set(lesson, section);
    }
  }
}

for (const pack of packs) {
  const counts = pack.lesson_counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    missing.push(pack.id);
    continue;
  }
  for (const lesson of Object.keys(counts).sort()) {
    const bases = counts[lesson];
    const replayDefault = bases >= args.floor;
    lessons.push({
      lesson,
      pack: pack.id,
      book_section:
        catalogueSections.get(lesson) ?? (pack.book_sections ?? [])[0] ?? null,
      bases,
      floor: args.floor,
      replay_default: replayDefault,
      status: replayDefault ? 'replay-default' : 'thin',
    });
  }
}

const notShipped = [];
if (catalogue) {
  const packed = new Set(lessons.map((row) => row.lesson));
  for (const [lesson, bookSection] of catalogueSections) {
    if (packed.has(lesson)) continue;
    notShipped.push({
      lesson,
      pack: null,
      book_section: bookSection,
      bases: 0,
      floor: args.floor,
      replay_default: false,
      status: 'not-shipped',
    });
  }
  notShipped.sort((left, right) => left.lesson.localeCompare(right.lesson));
  lessons.push(...notShipped);
}

lessons.sort((left, right) => left.lesson.localeCompare(right.lesson));
const covered = lessons.filter((row) => row.status === 'replay-default');
const thin = lessons.filter((row) => row.status === 'thin');
const totalBases = lessons.reduce((sum, row) => sum + row.bases, 0);

const summary = {
  schema: 'riichiprac.replay-coverage',
  version: 2,
  manifest: args.manifest,
  catalogue: args.catalogue,
  floor: args.floor,
  packs: packs.map((pack) => pack.id),
  packs_without_counts: missing,
  lessons,
  replay_default: covered.map((row) => row.lesson),
  below_floor: thin.map((row) => row.lesson),
  not_shipped: notShipped.map((row) => row.lesson),
  totals: {
    lessons: lessons.length,
    replay_default: covered.length,
    below_floor: thin.length,
    not_shipped: notShipped.length,
    reviewed_bases: totalBases,
  },
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    `replay coverage: ${summary.totals.replay_default}/${summary.totals.lessons} lesson(s) ` +
      `replay-default at ${args.floor} bases, ${summary.totals.below_floor} thin, ` +
      `${summary.totals.not_shipped} not shipped, ${summary.totals.reviewed_bases} reviewed bases`,
  );
  for (const row of lessons) {
    const label =
      row.status === 'replay-default' ? 'DEFAULT' : row.status === 'thin' ? 'thin   ' : 'NONE   ';
    console.log(
      `  ${label} ${row.lesson.padEnd(28)} ` +
        `${String(row.bases).padStart(5)} bases  ${row.pack ?? '(no pack)'}`,
    );
  }
  for (const pack of missing) {
    console.log(`  WARN ${pack} has no lesson_counts (coverage unknown, stays opt-in)`);
  }
}

process.exit(0);
