#!/usr/bin/env node
/**
 * Verify a curated lesson pack's content (implementation units Q2 and Q3).
 *
 *   node scripts/check-ch8-pack.mjs
 *   node scripts/check-ch8-pack.mjs --dir frontend/public/scenarios \
 *     --pack replay.ch8-defense.2026-11 --json
 *   node scripts/check-ch8-pack.mjs --chapter ch7 --allow-no-variants
 *   node scripts/check-ch8-pack.mjs --chapter ch5 --allow-no-variants
 *   node scripts/check-ch8-pack.mjs --chapter ch9 --allow-no-variants
 *   node scripts/check-ch8-pack.mjs --chapter ch34 --allow-no-variants
 *
 * The generic hosting check (`check-pack-hosting.mjs`) proves the manifest,
 * hashes, budgets and provenance envelope. This check proves the pack's
 * **content** is the lesson pack the pipeline promised, for the chapter named
 * by `--chapter`:
 *
 *   - exactly that chapter's lessons and `<chapter>.*` book sections, no other
 *     chapter;
 *   - at least 100 scenarios, no duplicate scenario id;
 *   - variants are a real share of the pack (default at least 20 %) and come
 *     from at least two transform families;
 *   - every variant names its base and carries its transform chain/seed;
 *   - the source is `ai_selfplay`, every agent has a licence, and the
 *     commercial flag is false whenever an Akochan-derived source contributes;
 *   - the pack stays inside the same-origin body budget.
 *
 * Dependency-free, and it prints numbers and pass/fail. Exit 1 on failure.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHAPTERS = {
  ch8: {
    lessons: new Set([
      'fold_to_riichi',
      'defense_safety_chart',
      'suji_kabe_safety',
      'kabe_no_chance',
      'kabe_one_chance',
      'kabe_double_one_chance',
      'kabe_suji_defense',
      'defense_stuck_heuristic',
      'defense_multi_threat',
      'push_or_fold',
      'open_hand_defense',
    ]),
    sectionPattern: /^ch8\.\d+$/,
    defaultPack: 'replay.ch8-defense.2026-11',
  },
  ch7: {
    lessons: new Set([
      'riichi_judgement',
      'chiitoitsu_riichi_vs_dama',
      'dama_bad_wait',
      'dama_genbutsu_wait',
      'dama_expensive_hand',
      'dama_improving_hand',
    ]),
    sectionPattern: /^ch7\.\d+$/,
    defaultPack: 'replay.ch7-riichi-dama.2026-11',
  },
  ch5: {
    // `sanshoku_pursuit` is a ch5 lesson but stays below the 40-base floor
    // (corpus growth C9), so no shipped pack carries it yet.
    lessons: new Set([
      'honitsu_decision',
      'pinfu_head',
      'chiitoi_vs_toitoi',
      'sanshoku_pursuit',
    ]),
    sectionPattern: /^ch5\.\d+$/,
    defaultPack: 'replay.ch5-values.2026-11',
  },
  ch9: {
    // The ch. 9 seating/kan pack is lesson-scoped: `wind_discard_order` (and,
    // when its measured supply clears the floor, `ankan_decision`) ships;
    // `shouminkan_decision`, `daiminkan_decision` and `meld_or_not` stay
    // generated until corpus growth C9. Every scenario must still be one of
    // these five lessons so a stray ch. 8/7/5 decision cannot leak in.
    lessons: new Set([
      'wind_discard_order',
      'ankan_decision',
      'shouminkan_decision',
      'daiminkan_decision',
      'meld_or_not',
    ]),
    sectionPattern: /^ch9\.\d+$/,
    defaultPack: 'replay.ch9-seating-calls.2026-11',
  },
  ch34: {
    // Q6 spans three book sections (ch3.2, ch3.3, ch4.1), so the section
    // pattern is an alternation rather than one chapter prefix. The lesson
    // set stays explicit and lesson-scoped: the four thin ch3.2/ch3.3
    // lessons (`perfect_one_away`, `pair_count_open`, `nobetan_keep`,
    // `ryankan_break`) stay generated until corpus growth C9, and naming only
    // the six shipped lessons keeps one from leaking in.
    lessons: new Set([
      'protorun_priority',
      'pair_count',
      'skipping_block',
      'protorun_plus_one',
      'nakabukure_ready',
      'ryanmen_protorun',
    ]),
    sectionPattern: /^ch(3\.[23]|4\.1)$/,
    defaultPack: 'replay.ch34-shapes.2026-11',
  },
};
const DEFAULT_CHAPTER = 'ch8';
const DEFAULT_MAX_BYTES = 50_000_000;
const DEFAULT_MIN_SCENARIOS = 100;
const DEFAULT_MIN_VARIANT_SHARE = 0.2;

function parseArgs(argv) {
  const parsed = {
    chapter: DEFAULT_CHAPTER,
    dir: join(repoRoot, 'frontend', 'public', 'scenarios'),
    pack: null,
    maxBytes: DEFAULT_MAX_BYTES,
    minScenarios: DEFAULT_MIN_SCENARIOS,
    minVariantShare: DEFAULT_MIN_VARIANT_SHARE,
    allowNoVariants: false,
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
    if (flag === '--chapter') parsed.chapter = value();
    else if (flag === '--dir') parsed.dir = resolve(process.cwd(), value());
    else if (flag === '--pack') parsed.pack = value();
    else if (flag === '--max-bytes') parsed.maxBytes = Number(value());
    else if (flag === '--min-scenarios') parsed.minScenarios = Number(value());
    else if (flag === '--min-variant-share') parsed.minVariantShare = Number(value());
    else if (flag === '--allow-no-variants') parsed.allowNoVariants = true;
    else if (flag === '--json') parsed.json = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        'node scripts/check-ch8-pack.mjs [--chapter ch34|ch5|ch7|ch8|ch9] [--dir DIR] [--pack ID] ' +
          '[--max-bytes N] [--min-scenarios N] [--min-variant-share F] ' +
          '[--allow-no-variants] [--json]',
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!(parsed.chapter in CHAPTERS)) {
    console.error(`unknown chapter: ${parsed.chapter} (expected ${Object.keys(CHAPTERS).join(' or ')})`);
    process.exit(2);
  }
  parsed.pack ??= CHAPTERS[parsed.chapter].defaultPack;
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const chapter = CHAPTERS[args.chapter];
const CHAPTER_LESSONS = chapter.lessons;
const BOOK_SECTION_PATTERN = chapter.sectionPattern;
const checks = [];
const problems = [];

function check(condition, message) {
  checks.push(message);
  if (!condition) problems.push(message);
  return condition;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function renderCounts(counts) {
  const keys = Object.keys(counts ?? {}).sort();
  if (keys.length === 0) return 'none';
  return keys.map((key) => `${key}=${counts[key]}`).join(',');
}

const manifest = JSON.parse(readFileSync(join(args.dir, 'manifest.json'), 'utf8'));
const entry = (manifest.packs ?? []).find((candidate) => candidate.id === args.pack);
if (!entry) {
  console.error(`FAIL manifest lists pack \`${args.pack}\``);
  process.exit(1);
}

const body = readFileSync(join(args.dir, entry.path));
check(body.length === entry.bytes, `body is ${entry.bytes} bytes`);
check(sha256(body) === entry.sha256, 'body SHA-256 matches the manifest');
check(body.length <= args.maxBytes, `body stays under ${args.maxBytes} bytes`);
const pack = JSON.parse(gunzipSync(body).toString('utf8'));

check(pack.schema === 'riichiprac.scenario-pack', 'body is a scenario pack');
check(pack.version === 1, 'body is pack schema v1');
check(pack.pack_id === entry.id, 'pack id matches the manifest');
const scenarios = pack.scenarios ?? [];
check(
  scenarios.length >= args.minScenarios,
  `pack has at least ${args.minScenarios} scenarios (${scenarios.length})`,
);
check(
  scenarios.length === entry.scenario_count,
  `manifest scenario count ${entry.scenario_count} matches the body`,
);

let variants = 0;
let bases = 0;
const baseCountsByLesson = {};
const transformFamilies = new Set();
const scenarioIds = new Set();
const duplicateIds = [];
const offChapter = [];
const missingBook = [];
const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
let variantIndex = -1;
let sameHandVariants = 0;
for (const [index, scenario] of scenarios.entries()) {
  if (scenarioIds.has(scenario.id)) duplicateIds.push(scenario.id);
  scenarioIds.add(scenario.id);
  if (!CHAPTER_LESSONS.has(scenario.lesson_id)) offChapter.push(scenario.lesson_id);
  const key = scenario.book?.key;
  if (!key || !BOOK_SECTION_PATTERN.test(key)) missingBook.push(`${scenario.id}:${key ?? 'none'}`);
  const provenance = scenario.provenance ?? {};
  const isVariant =
    Boolean(provenance.variant_of) ||
    (Array.isArray(provenance.transforms) && provenance.transforms.length > 0);
  if (isVariant) {
    if (variantIndex < 0) variantIndex = index;
    variants += 1;
    for (const name of provenance.transforms ?? []) transformFamilies.add(name);
    const base = byId.get(provenance.variant_of);
    if (base && base.state?.hand_string === scenario.state?.hand_string) {
      sameHandVariants += 1;
    }
    check(
      Boolean(provenance.variant_of),
      `${scenario.id} names its base`,
    );
    check(
      Boolean(provenance.transform_chain) && Boolean(provenance.transform_seed),
      `${scenario.id} carries its chain and seed`,
    );
  } else {
    bases += 1;
    baseCountsByLesson[scenario.lesson_id] = (baseCountsByLesson[scenario.lesson_id] ?? 0) + 1;
  }
}

check(duplicateIds.length === 0, `no duplicate scenario ids (${duplicateIds.length})`);
check(
  variantIndex < 0 ||
    (scenarios.slice(0, variantIndex).every((scenario) => !scenario.provenance?.variant_of) &&
      scenarios.slice(variantIndex).every((scenario) => Boolean(scenario.provenance?.variant_of))),
  'the base block precedes every variant',
);
check(
  sameHandVariants === 0,
  `no variant repeats its base's actor hand (${sameHandVariants})`,
);
check(
  offChapter.length === 0,
  `every scenario is a ${args.chapter} lesson (${offChapter.length} off-chapter)`,
);
check(
  missingBook.length === 0,
  `every scenario carries a ${args.chapter}.* book section (${missingBook.length} missing)`,
);
const variantShare = scenarios.length === 0 ? 0 : variants / scenarios.length;
if (variants === 0) {
  check(
    args.allowNoVariants,
    'the pack ships variants (pass --allow-no-variants to ship the reviewed bases only)',
  );
  check(
    args.allowNoVariants,
    'variants are disabled by product decision; variety comes from real scenarios',
  );
} else {
  check(
    variantShare >= args.minVariantShare,
    `variants are at least ${(args.minVariantShare * 100).toFixed(0)} % of the pack ` +
      `(${variants}/${scenarios.length} = ${(variantShare * 100).toFixed(1)} %)`,
  );
  check(
    transformFamilies.size >= 2,
    `variants come from at least two transform families (${[...transformFamilies].sort().join(', ') || 'none'})`,
  );
}
check(
  scenarios.every((scenario) => Boolean(scenario.correct_action)),
  'every scenario carries its correct action',
);
check(
  scenarios.every((scenario) => Boolean(scenario.provenance?.replay_id)),
  'every scenario names its source replay',
);

// Per-lesson coverage is what the app reads without a body download; this pack
// must record it and it must match the reviewed (non-variant) bases.
const declaredCounts = entry.lesson_counts;
const declaredCountsOk = check(
  declaredCounts !== null && typeof declaredCounts === 'object' && !Array.isArray(declaredCounts),
  'manifest records lesson_counts',
);
if (declaredCountsOk) {
  const declaredKeys = Object.keys(declaredCounts).sort();
  check(
    declaredKeys.every((lesson) => Number.isInteger(declaredCounts[lesson]) && declaredCounts[lesson] > 0),
    'lesson_counts are positive integers per lesson',
  );
  check(
    declaredKeys.join(',') === Object.keys(baseCountsByLesson).sort().join(','),
    `lesson_counts name the pack's lessons (${declaredKeys.join(', ') || 'none'})`,
  );
  check(
    declaredKeys.every((lesson) => declaredCounts[lesson] === baseCountsByLesson[lesson]),
    `lesson_counts agree with the reviewed bases ` +
      `(manifest ${renderCounts(declaredCounts)}, body ${renderCounts(baseCountsByLesson)})`,
  );
}

const source = pack.source ?? {};
check(source.kind === 'ai_selfplay', 'source.kind is ai_selfplay');
check(Boolean(source.licence), 'pack declares a data licence');
check(Boolean(source.attribution), 'pack declares its attribution');
check(Array.isArray(source.agents) && source.agents.length > 0, 'pack names its agents');
const agents = Array.isArray(source.agents) ? source.agents : [];
check(
  agents.every((agent) => Boolean(agent.licence?.id)),
  'every contributing agent carries a licence',
);
const akochan = agents.some(
  (agent) =>
    String(agent.engine ?? '').toLowerCase().includes('akochan') ||
    String(agent.agent_id ?? '').toLowerCase().includes('akochan'),
);
if (akochan) {
  check(source.data_commercial_use === false, 'Akochan source keeps the pack non-commercial');
}

report();

function report() {
  const summary = {
    schema: 'riichiprac.ch8-pack-check',
    version: 1,
    chapter: args.chapter,
    dir: args.dir,
    pack: args.pack,
    checks: checks.length,
    problems,
    scenarios: scenarios?.length ?? 0,
    bases,
    variants,
    variant_share: variants + bases === 0 ? 0 : variants / (variants + bases),
    transform_families: [...transformFamilies].sort(),
    lessons: [...new Set((scenarios ?? []).map((scenario) => scenario.lesson_id))].sort(),
    lesson_counts: baseCountsByLesson,
    book_sections: [
      ...new Set((scenarios ?? []).map((scenario) => scenario.book?.key).filter(Boolean)),
    ].sort(),
    bytes: body?.length ?? 0,
    agents: agents.map((agent) => `${agent.agent_id} (${agent.engine})`),
    data_commercial_use: source?.data_commercial_use,
  };
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const message of problems) console.log(`FAIL ${message}`);
    console.log(
      `check-ch8-pack: ${summary.scenarios} scenarios (${summary.bases} bases + ` +
        `${summary.variants} variants, ${(summary.variant_share * 100).toFixed(1)} %), ` +
        `${summary.bytes} bytes, ${summary.lessons.length} lesson(s), ` +
        `${summary.transform_families.length} transform famil(ies), ` +
        `${checks.length - problems.length}/${checks.length} checks passed`,
    );
  }
  process.exit(problems.length === 0 ? 0 : 1);
}
