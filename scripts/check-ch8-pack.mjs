#!/usr/bin/env node
/**
 * Verify the first curated ch. 8 defense pack (implementation unit Q2).
 *
 *   node scripts/check-ch8-pack.mjs
 *   node scripts/check-ch8-pack.mjs --dir frontend/public/scenarios \
 *     --pack replay.ch8-defense.2026-11 --json
 *
 * The generic hosting check (`check-pack-hosting.mjs`) proves the manifest,
 * hashes, budgets and provenance envelope. This check proves the pack's
 * **content** is the lesson pack Q2 promised:
 *
 *   - exactly ch. 8 lessons and `ch8.*` book sections, no other chapter;
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
const CH8_LESSONS = new Set([
  'fold_to_riichi',
  'defense_safety_chart',
  'suji_kabe_safety',
  'kabe_no_chance',
  'kabe_one_chance',
  'kabe_double_one_chance',
  'kabe_suji_defense',
  'defense_stuck_heuristic',
  'push_or_fold',
  'open_hand_defense',
]);
const DEFAULT_PACK = 'replay.ch8-defense.2026-11';
const DEFAULT_MAX_BYTES = 50_000_000;
const DEFAULT_MIN_SCENARIOS = 100;
const DEFAULT_MIN_VARIANT_SHARE = 0.2;

function parseArgs(argv) {
  const parsed = {
    dir: join(repoRoot, 'frontend', 'public', 'scenarios'),
    pack: DEFAULT_PACK,
    maxBytes: DEFAULT_MAX_BYTES,
    minScenarios: DEFAULT_MIN_SCENARIOS,
    minVariantShare: DEFAULT_MIN_VARIANT_SHARE,
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
    if (flag === '--dir') parsed.dir = resolve(process.cwd(), value());
    else if (flag === '--pack') parsed.pack = value();
    else if (flag === '--max-bytes') parsed.maxBytes = Number(value());
    else if (flag === '--min-scenarios') parsed.minScenarios = Number(value());
    else if (flag === '--min-variant-share') parsed.minVariantShare = Number(value());
    else if (flag === '--json') parsed.json = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        'node scripts/check-ch8-pack.mjs [--dir DIR] [--pack ID] [--max-bytes N] ' +
          '[--min-scenarios N] [--min-variant-share F] [--json]',
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
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
const transformFamilies = new Set();
const scenarioIds = new Set();
const duplicateIds = [];
const offChapter = [];
const missingBook = [];
for (const scenario of scenarios) {
  if (scenarioIds.has(scenario.id)) duplicateIds.push(scenario.id);
  scenarioIds.add(scenario.id);
  if (!CH8_LESSONS.has(scenario.lesson_id)) offChapter.push(scenario.lesson_id);
  const key = scenario.book?.key;
  if (!key || !/^ch8\.\d+$/.test(key)) missingBook.push(`${scenario.id}:${key ?? 'none'}`);
  const provenance = scenario.provenance ?? {};
  const isVariant =
    Boolean(provenance.variant_of) ||
    (Array.isArray(provenance.transforms) && provenance.transforms.length > 0);
  if (isVariant) {
    variants += 1;
    for (const name of provenance.transforms ?? []) transformFamilies.add(name);
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
  }
}

check(duplicateIds.length === 0, `no duplicate scenario ids (${duplicateIds.length})`);
check(
  offChapter.length === 0,
  `every scenario is a ch. 8 lesson (${offChapter.length} off-chapter)`,
);
check(
  missingBook.length === 0,
  `every scenario carries a ch8.* book section (${missingBook.length} missing)`,
);
const variantShare = scenarios.length === 0 ? 0 : variants / scenarios.length;
check(
  variantShare >= args.minVariantShare,
  `variants are at least ${(args.minVariantShare * 100).toFixed(0)} % of the pack ` +
    `(${variants}/${scenarios.length} = ${(variantShare * 100).toFixed(1)} %)`,
);
check(
  transformFamilies.size >= 2,
  `variants come from at least two transform families (${[...transformFamilies].sort().join(', ') || 'none'})`,
);
check(
  scenarios.every((scenario) => Boolean(scenario.correct_action)),
  'every scenario carries its correct action',
);
check(
  scenarios.every((scenario) => Boolean(scenario.provenance?.replay_id)),
  'every scenario names its source replay',
);

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
