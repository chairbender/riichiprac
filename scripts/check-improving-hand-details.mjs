#!/usr/bin/env node
/**
 * Verify the shipped ch. 7 improving-hand Details text.
 *
 *   node scripts/check-improving-hand-details.mjs
 *   node scripts/check-improving-hand-details.mjs --dir frontend/public/scenarios
 *
 * Task 261120-2242 made the `dama_improving_hand` reason's `applies` line list
 * the hand's actual improving kinds, with the copies still live. The text is
 * stamped into the replay pack at assembly time, so a reassembly with older
 * code (or a hand-edit) would quietly restore the generic sentence while the
 * body hash still checks out. This check catches that.
 *
 * It cannot recompute the improving set without the Rust engine; the lib tests
 * (`rationale::tests::improving_hand_details_*`) prove the list against the
 * computed count. Here it proves the shipped packs carry that derived text and
 * that every "(N left)" agrees with the tiles on the visible table:
 * hand + rivers + melds + dora indicators, four copies minus what is seen.
 *
 * Dependency-free, prints numbers and pass/fail. Exit 1 on failure.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { dir: join(repoRoot, 'frontend', 'public', 'scenarios') };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = resolve(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(
        'node scripts/check-improving-hand-details.mjs [--dir DIR]',
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

const HONOR = { E: '1z', S: '2z', W: '3z', N: '4z', Wh: '5z', G: '6z', R: '7z' };
const codeOf = (name) => HONOR[name] ?? name;

function tableCopies(state, code) {
  let total = state.tiles.filter((tile) => tile === code).length;
  for (const player of state.players) {
    total += player.discards.filter((discard) => discard.tile === code).length;
    for (const meld of player.melds ?? []) {
      total += meld.tiles.filter((tile) => tile === code).length;
    }
  }
  total += state.dora_indicators.filter((tile) => tile === code).length;
  return total;
}

const GENERIC = 'at least six kinds of draws';
const LIST = /kinds (?:that improve this ready hand are |improve this ready hand \()(.*?)(?:\. Each draw|\), short of)/;

const args = parseArgs(process.argv);

let checked = 0;
const failures = [];

function fail(where, detail) {
  failures.push(`${where}: ${detail}`);
}

for (const entry of JSON.parse(readFileSync(join(args.dir, 'manifest.json'), 'utf8')).packs) {
  const body = JSON.parse(
    gunzipSync(readFileSync(join(args.dir, entry.path))).toString('utf8'),
  );
  let inPack = 0;
  for (const scenario of body.scenarios) {
    const state = scenario.state;
    if (state.category !== 'dama_improving_hand') continue;
    inPack += 1;
    checked += 1;
    const where = scenario.id;
    const rule = state.book_rationale?.rules?.find(
      (candidate) => candidate.id === 'improving_hand',
    );
    if (!rule) {
      fail(where, 'no improving_hand rule');
      continue;
    }
    if (rule.applies.includes(GENERIC)) {
      fail(where, 'the generic improving sentence is back');
      continue;
    }
    const match = rule.applies.match(LIST);
    if (!match) {
      fail(where, `unparsable list: ${rule.applies}`);
      continue;
    }
    const entries = match[1].split(', ');
    for (const text of entries) {
      const item = text.match(/^(.+?) \((?:(\d+) left|no copies left)\)$/);
      if (!item) {
        fail(where, `unparsable entry ${JSON.stringify(text)}`);
        continue;
      }
      const [, name, left] = item;
      const expected = Math.max(0, 4 - tableCopies(state, codeOf(name)));
      if (Number(left ?? 0) !== expected) {
        fail(where, `${name} says ${left ?? 0} left, the table says ${expected}`);
      }
    }
    const kinds = Number(rule.applies.match(/(\d+) kinds/)[1]);
    if (kinds !== entries.length) {
      fail(where, `says ${kinds} kinds but lists ${entries.length}`);
    }
    if (kinds < 6 && !/Drawing \S+ is a three-han step/.test(rule.applies)) {
      fail(where, 'fewer than six kinds and no three-han step');
    }
    const summaryKinds = state.book_rationale.summary.match(/(\d+) kinds/);
    if (kinds >= 6 && (!summaryKinds || Number(summaryKinds[1]) !== kinds)) {
      fail(where, `summary kind count disagrees: ${state.book_rationale.summary}`);
    }
  }
  if (inPack > 0) {
    console.log(`${entry.id}: ${inPack} dama_improving_hand base(s)`);
  }
}

console.log(
  `checked ${checked} dama_improving_hand base(s), ${failures.length} failure(s)`,
);
for (const failure of failures.slice(0, 25)) console.log(`FAIL ${failure}`);
if (failures.length > 25) console.log(`... ${failures.length - 25} more`);
process.exit(failures.length === 0 ? 0 : 1);
