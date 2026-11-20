#!/usr/bin/env node
/**
 * Verify the same-origin scenario-pack hosting directory (implementation unit
 * P2).
 *
 *   node scripts/check-pack-hosting.mjs
 *   node scripts/check-pack-hosting.mjs --dir frontend/dist/scenarios
 *   node scripts/check-pack-hosting.mjs --json
 *
 * Dependency-free on purpose: it runs in the Pages workflow and on any machine
 * with Node. It checks facts, never looks:
 *
 *   - the manifest is `riichiprac.scenario-pack-manifest` v1, non-empty,
 *     sorted by pack id and inside its byte ceiling;
 *   - every entry is a safe relative path whose filename is
 *     `<pack-id>-<sha256-prefix>.json.gz`, with a well-formed hash and a
 *     positive byte/scenario count;
 *   - every entry records `lesson_counts` (lesson id → reviewed bases): the app
 *     reads coverage from the manifest without downloading a body, so a hosted
 *     entry must carry it, name exactly its lessons, and agree with the body's
 *     non-variant scenarios per lesson;
 *   - every body exists, is exactly the declared byte length, hashes to the
 *     declared SHA-256, gunzips, parses as `riichiprac.scenario-pack` v1 and
 *     agrees with the manifest's id, count, lesson ids, book sections, licence,
 *     `requires_model` and `data_commercial_use`;
 *   - the body's source is `ai_selfplay`, redistributable, attributed and names
 *     at least one agent (the hosting licence/traceability rule);
 *   - the directory holds nothing else: no raw replay (`.jsonl.gz`), database
 *     (`.sqlite`/`.duckdb`) or weights (`.safetensors`/`.pth`) file can ride
 *     along with the packs;
 *   - the summed bodies stay inside the same-origin budget (default 50 MB; the
 *     rest of the AGENTS.md asset budget belongs to the rendered view).
 *
 * Run it on the source (`frontend/public/scenarios`) before the build and on
 * `frontend/dist/scenarios` after it, so the Pages artifact is proven to
 * include exactly the audited export. Exit code 1 on any failure.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PACK_SCHEMA = 'riichiprac.scenario-pack';
const MANIFEST_SCHEMA = 'riichiprac.scenario-pack-manifest';
const SCHEMA_VERSION = 1;
const MANIFEST_FILE_NAME = 'manifest.json';
const FILENAME_SHA_PREFIX = 12;
const DEFAULT_MAX_TOTAL_BYTES = 50_000_000;
const DEFAULT_MAX_MANIFEST_BYTES = 512 * 1024;
const FORBIDDEN_SUFFIXES = [
  '.safetensors',
  '.pth',
  '.bin',
  '.sqlite',
  '.sqlite-wal',
  '.sqlite-shm',
  '.duckdb',
  '.jsonl',
  '.jsonl.gz',
  '.weights',
];

function parseArgs(argv) {
  const parsed = {
    dir: join(repoRoot, 'frontend', 'public', 'scenarios'),
    maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
    maxManifestBytes: DEFAULT_MAX_MANIFEST_BYTES,
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
    else if (flag === '--max-total-bytes') parsed.maxTotalBytes = Number(value());
    else if (flag === '--max-manifest-bytes') parsed.maxManifestBytes = Number(value());
    else if (flag === '--json') parsed.json = true;
    else if (flag === '--help' || flag === '-h') {
      console.log('node scripts/check-pack-hosting.mjs [--dir DIR] [--max-total-bytes N] [--max-manifest-bytes N] [--json]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  for (const key of ['maxTotalBytes', 'maxManifestBytes']) {
    if (!Number.isFinite(parsed[key]) || parsed[key] <= 0) {
      console.error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a positive number`);
      process.exit(2);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const problems = [];
const checks = [];

function check(condition, message) {
  checks.push(message);
  if (!condition) problems.push(message);
  return condition;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isSha256(value) {
  if (typeof value !== 'string') return false;
  const raw = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return /^[0-9a-fA-F]{64}$/.test(raw);
}

function rawSha(value) {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}

function isSlug(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 96 &&
    value !== '.' &&
    value !== '..' &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function sameStringArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSortedUnique(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) return false;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) return false;
  }
  return true;
}

/**
 * Reviewed bases per lesson. A variant derives from one base and adds no review
 * coverage, so only non-variant scenarios count; this is the same definition as
 * the Rust `Pack::lesson_counts`.
 */
function reviewedBasesByLesson(scenarios) {
  const counts = {};
  for (const scenario of scenarios) {
    const provenance = scenario?.provenance ?? {};
    const isVariant =
      Boolean(provenance.variant_of) ||
      (Array.isArray(provenance.transforms) && provenance.transforms.length > 0);
    if (isVariant) continue;
    counts[scenario.lesson_id] = (counts[scenario.lesson_id] ?? 0) + 1;
  }
  return counts;
}

function isLessonCounts(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([lesson, count]) => isSlug(lesson) && Number.isInteger(count) && count > 0,
    )
  );
}

function renderLessonCounts(counts) {
  const keys = Object.keys(counts ?? {}).sort();
  if (keys.length === 0) return 'none';
  return keys.map((key) => `${key}=${counts[key]}`).join(',');
}

function sameLessonCounts(left, right) {
  const leftKeys = Object.keys(left ?? {}).sort();
  if (!sameStringArray(leftKeys, Object.keys(right ?? {}).sort())) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function isForbiddenArtifact(name) {
  const lower = name.toLowerCase();
  return FORBIDDEN_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function summarize(extra) {
  const payload = {
    ok: problems.length === 0,
    dir: args.dir,
    budgetBytes: args.maxTotalBytes,
    manifestBytes: extra.manifestBytes ?? 0,
    totalBytes: extra.totalBytes ?? 0,
    packs: extra.packs ?? [],
    problems,
    checks: checks.length,
  };
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  return payload;
}

if (!existsSync(args.dir)) {
  problems.push('hosting directory does not exist; publish a smoke pack with `mine_replays pack publish`');
  if (args.json) summarize({});
  else console.error(`FAIL ${problems[0]}`);
  process.exit(1);
}

const manifestPath = join(args.dir, MANIFEST_FILE_NAME);
if (!check(existsSync(manifestPath), `manifest exists at ${manifestPath}`)) {
  const payload = summarize({});
  if (!args.json) {
    for (const problem of problems) console.error(`FAIL ${problem}`);
    console.error(`\n${problems.length} failure(s)`);
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
  process.exit(1);
}

const manifestBytes = statSync(manifestPath).size;
check(manifestBytes <= args.maxManifestBytes, `manifest is ${manifestBytes} bytes (ceiling ${args.maxManifestBytes})`);
check(manifestBytes > 0, 'manifest is not empty');

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  check(true, 'manifest parses as JSON');
} catch (error) {
  check(false, `manifest parses as JSON (${error.message})`);
}

const packs = [];
let totalBytes = 0;
const listedNames = new Set();

if (manifest) {
  check(manifest.schema === MANIFEST_SCHEMA, `manifest schema is ${MANIFEST_SCHEMA}`);
  check(manifest.version === SCHEMA_VERSION, `manifest version is ${SCHEMA_VERSION}`);
  check(typeof manifest.updated_at === 'string' && manifest.updated_at.trim() !== '', 'manifest has an updated_at timestamp');
  if (check(Array.isArray(manifest.packs) && manifest.packs.length > 0, 'manifest lists at least one pack')) {
    const ids = manifest.packs.map((entry) => entry?.id);
    check(new Set(ids).size === ids.length, 'manifest pack ids are unique');
    check(ids.every((id, index) => index === 0 || ids[index - 1] < id), 'manifest pack ids are sorted');

    for (const entry of manifest.packs) {
      const label = typeof entry?.id === 'string' ? entry.id : '<invalid entry>';
      if (!check(entry && typeof entry === 'object', `${label}: entry is an object`)) continue;
      if (!check(isSlug(entry.id), `${label}: id is a safe slug`)) continue;
      if (!check(isSha256(entry.sha256), `${label}: sha256 is well formed`)) continue;
      if (!check(isSafeRelativePath(entry.path), `${label}: path is a safe relative path`)) continue;
      const expectedName = `${entry.id}-${rawSha(entry.sha256).slice(0, FILENAME_SHA_PREFIX)}.json.gz`;
      check(
        entry.path === expectedName,
        `${label}: path is the content-addressed filename ${expectedName} (found ${entry.path})`,
      );
      check(Number.isInteger(entry.bytes) && entry.bytes > 0, `${label}: bytes is a positive integer`);
      check(Number.isInteger(entry.scenario_count) && entry.scenario_count > 0, `${label}: scenario_count is a positive integer`);
      check(isSortedUnique(entry.lesson_ids), `${label}: lesson_ids are sorted and unique`);
      check(isSortedUnique(entry.book_sections), `${label}: book_sections are sorted and unique`);
      const countsOk = check(isLessonCounts(entry.lesson_counts), `${label}: lesson_counts records positive bases per lesson`);
      if (countsOk) {
        check(
          sameStringArray(Object.keys(entry.lesson_counts).sort(), [...new Set(entry.lesson_ids)].sort()),
          `${label}: lesson_counts name exactly the entry's lesson_ids`,
        );
        check(
          Object.values(entry.lesson_counts).reduce((sum, count) => sum + count, 0) <= entry.scenario_count,
          `${label}: lesson_counts do not claim more bases than the ${entry.scenario_count} scenario(s)`,
        );
      }
      check(typeof entry.licence === 'string' && entry.licence.trim() !== '', `${label}: licence is present`);
      check(typeof entry.requires_model === 'boolean', `${label}: requires_model is a boolean`);
      check(typeof entry.data_commercial_use === 'boolean', `${label}: data_commercial_use is a boolean`);

      const bodyPath = join(args.dir, entry.path);
      listedNames.add(entry.path);
      if (!check(existsSync(bodyPath), `${label}: body exists at ${entry.path}`)) continue;
      const bodyBytes = readFileSync(bodyPath);
      check(bodyBytes.length === entry.bytes, `${label}: body is ${entry.bytes} bytes (found ${bodyBytes.length})`);
      const actualSha = sha256(bodyBytes);
      check(
        actualSha === rawSha(entry.sha256).toLowerCase(),
        `${label}: body hashes to ${actualSha} (manifest says ${entry.sha256})`,
      );
      totalBytes += bodyBytes.length;

      let pack;
      try {
        pack = JSON.parse(gunzipSync(bodyBytes).toString('utf8'));
        check(true, `${label}: body gunzips and parses as JSON`);
      } catch (error) {
        check(false, `${label}: body gunzips and parses as JSON (${error.message})`);
        continue;
      }
      check(pack.schema === PACK_SCHEMA, `${label}: body schema is ${PACK_SCHEMA}`);
      check(pack.version === SCHEMA_VERSION, `${label}: body version is ${SCHEMA_VERSION}`);
      check(pack.pack_id === entry.id, `${label}: body pack_id agrees with the manifest`);
      check(
        Array.isArray(pack.scenarios) && pack.scenarios.length === entry.scenario_count,
        `${label}: body has ${entry.scenario_count} scenario(s)`,
      );
      const scenarioList = Array.isArray(pack.scenarios) ? pack.scenarios : [];
      const lessonIds = [...new Set(scenarioList.map((scenario) => scenario.lesson_id))].sort();
      const bookSections = [
        ...new Set(scenarioList.map((scenario) => scenario.book?.key).filter((key) => typeof key === 'string')),
      ].sort();
      check(sameStringArray(lessonIds, entry.lesson_ids), `${label}: lesson_ids agree with the body`);
      const bodyCounts = reviewedBasesByLesson(scenarioList);
      if (countsOk) {
        check(
          sameLessonCounts(entry.lesson_counts, bodyCounts),
          `${label}: lesson_counts agree with the body's reviewed bases ` +
            `(manifest ${renderLessonCounts(entry.lesson_counts)}, body ${renderLessonCounts(bodyCounts)})`,
        );
      }
      check(sameStringArray(bookSections, entry.book_sections), `${label}: book_sections agree with the body`);
      check(pack.source?.licence === entry.licence, `${label}: licence agrees with the body`);
      check(
        Boolean(scenarioList.some((scenario) => scenario.mortal == null)) === entry.requires_model,
        `${label}: requires_model agrees with the body`,
      );
      check(
        pack.source?.data_commercial_use === entry.data_commercial_use,
        `${label}: data_commercial_use agrees with the body`,
      );
      check(pack.source?.kind === 'ai_selfplay', `${label}: source kind is ai_selfplay`);
      check(pack.source?.redistributable === true, `${label}: source is redistributable`);
      check(
        typeof pack.source?.attribution === 'string' && pack.source.attribution.trim() !== '',
        `${label}: source carries attribution`,
      );
      check(
        Array.isArray(pack.source?.agents) && pack.source.agents.length > 0,
        `${label}: source names at least one contributing agent`,
      );
      check(
        Array.isArray(pack.source?.agents) &&
          pack.source.agents.every((agent) => agent && typeof agent.licence?.id === 'string' && agent.licence.id !== ''),
        `${label}: every contributing agent carries a licence`,
      );

      packs.push({
        id: entry.id,
        bytes: bodyBytes.length,
        scenarios: entry.scenario_count,
        sha256: rawSha(entry.sha256),
        lessonIds,
        lessonCounts: bodyCounts,
      });
    }
  }
}

function renderedLessonIds(pack) {
  return [...new Set((pack.scenarios ?? []).map((scenario) => scenario.lesson_id))].sort();
}

check(totalBytes <= args.maxTotalBytes, `hosted bodies total ${totalBytes} bytes (ceiling ${args.maxTotalBytes})`);

for (const entry of readdirSync(args.dir, { withFileTypes: true })) {
  if (entry.name === MANIFEST_FILE_NAME) continue;
  if (!entry.isFile()) {
    check(false, `${entry.name}: the hosting directory holds files only`);
    continue;
  }
  if (listedNames.has(entry.name)) continue;
  if (isForbiddenArtifact(entry.name)) {
    check(false, `${entry.name}: raw corpus, database or weights files are never hosted`);
  } else {
    check(false, `${entry.name}: file is not a manifest-listed pack body`);
  }
}

const payload = summarize({
  manifestBytes,
  totalBytes,
  packs,
});

if (!args.json) {
  console.log(`pack hosting: ${args.dir}`);
  for (const pack of packs) {
    console.log(
      `  ${pack.id} · ${pack.bytes} B · ${pack.scenarios} scenario(s) · sha256:${pack.sha256.slice(0, FILENAME_SHA_PREFIX)}`,
    );
  }
  console.log(
    `  ${packs.length} pack(s), ${totalBytes} body bytes of ${args.maxTotalBytes} allowed, ${manifestBytes} byte manifest`,
  );
  if (problems.length === 0) {
    console.log(`  PASS (${checks.length} checks)`);
  } else {
    for (const problem of problems) console.error(`  FAIL ${problem}`);
    console.error(`  ${problems.length} failure(s) of ${checks.length} checks`);
  }
}

process.exit(problems.length === 0 ? 0 : 1);
