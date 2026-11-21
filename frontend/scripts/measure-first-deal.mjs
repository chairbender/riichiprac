#!/usr/bin/env node
/**
 * Measure the replay-first first deal (RF4, strategy C).
 *
 *     node scripts/measure-first-deal.mjs
 *     node scripts/measure-first-deal.mjs --runs 9 --out /tmp/first-deal.json
 *
 * A cold launch may now fetch the pack manifest and one section body before it
 * draws the first hand (`FIRST_DEAL_BUDGET_MS` bounds each phase). This script
 * prints what that costs for the committed packs: the manifest and body bytes,
 * the lesson the deal opens with, and the per-phase milliseconds the browser
 * pays after the download — SHA-256 verification against the manifest, gzip
 * decode and JSON parse.
 *
 * It reads the published files, not a copy, and runs the same steps as
 * `services/packLoader.ts` in Node. Node is a proxy for the browser: it has no
 * IndexedDB, no service worker and no real network here, so the numbers are
 * verify/decode cost plus file reads, not a field measurement. The "cache hit"
 * row is the same verify+decode from already-held bytes: the loader re-verifies
 * a cached body against the manifest, so a warm visit saves the download only.
 *
 * Dependency-free on purpose (same rule as the other `scripts/check-*.mjs`).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** Coverage floor from `scenarios.ts` / `replay-first-rollout.md`. */
const MIN_REPLAY_BASES = 40;

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    manifest: resolve(here, '..', 'public', 'scenarios', 'manifest.json'),
    runs: 5,
    out: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') args.manifest = resolve(argv[++index]);
    else if (arg === '--runs') args.runs = Math.max(1, Number(argv[++index]) || 5);
    else if (arg === '--out') args.out = resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/measure-first-deal.mjs [--manifest <path>] [--runs N] [--out <json>]',
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

/**
 * The lesson the first deal opens with (mirrors `firstDealReplayOption`):
 * the covered lesson with the most reviewed bases, manifest order on a tie.
 * The app additionally requires a generated sibling, which every current pack
 * lesson has, so the two agree for the shipped catalogue.
 */
function firstDealLesson(packs, floor = MIN_REPLAY_BASES) {
  const byLesson = new Map();
  for (const entry of packs) {
    for (const lessonId of entry.lesson_ids) {
      const bases = entry.lesson_counts?.[lessonId] ?? 0;
      if (bases < floor) continue;
      const record = byLesson.get(lessonId);
      if (!record) byLesson.set(lessonId, { bases, entry });
      else record.bases += bases;
    }
  }
  let best = null;
  for (const [lessonId, record] of byLesson) {
    if (!best || record.bases > best.bases) {
      best = { lessonId, bases: record.bases, entry: record.entry };
    }
  }
  return best;
}

function now() {
  return Number(process.hrtime.bigint()) / 1e6;
}

/** Median, so one scheduler hiccup does not become the reported number. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Timed samples. The best wall-clock sample is reported next to the median
 * because a shared build box can be noisy, and so is the process CPU time,
 * which attributes only the phase's own work and is therefore the stable
 * estimate when another job owns most of the machine.
 */
function timed(runs, work) {
  const samples = [];
  let result;
  for (let run = 0; run < runs; run += 1) {
    const startCpu = process.cpuUsage();
    const start = now();
    result = work();
    const cpu = process.cpuUsage(startCpu);
    samples.push({
      wall: now() - start,
      cpu: (cpu.user + cpu.system) / 1000,
    });
  }
  return {
    result,
    min: Math.min(...samples.map((sample) => sample.wall)),
    median: median(samples.map((sample) => sample.wall)),
    cpuMin: Math.min(...samples.map((sample) => sample.cpu)),
    cpuMedian: median(samples.map((sample) => sample.cpu)),
  };
}

function phase(sample) {
  return {
    median_ms: Number(sample.median.toFixed(2)),
    min_ms: Number(sample.min.toFixed(2)),
    cpu_median_ms: Number(sample.cpuMedian.toFixed(2)),
    cpu_min_ms: Number(sample.cpuMin.toFixed(2)),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const startManifest = now();
  const manifestBytes = readFileSync(args.manifest);
  const manifestText = manifestBytes.toString('utf8');
  const manifest = JSON.parse(manifestText);
  const manifestParseMs = now() - startManifest;

  const packs = Array.isArray(manifest.packs) ? manifest.packs : [];
  const first = firstDealLesson(packs);
  if (!first) {
    console.error(
      `no lesson reaches the ${MIN_REPLAY_BASES}-base coverage floor in ${args.manifest}`,
    );
    process.exit(1);
  }

  const bodyPath = join(dirname(args.manifest), first.entry.path);
  const read = timed(args.runs, () => readFileSync(bodyPath));
  const bodyBytes = read.result;
  const sha = timed(args.runs, () => createHash('sha256').update(bodyBytes).digest('hex'));
  const inflated = timed(args.runs, () => gunzipSync(bodyBytes));
  const parsed = timed(args.runs, () => JSON.parse(inflated.result.toString('utf8')));
  const body = parsed.result;

  const counts = body.scenarios.reduce((countsByLesson, scenario) => {
    if (scenario.provenance?.variant_of || scenario.provenance?.transforms?.length) {
      return countsByLesson;
    }
    countsByLesson[scenario.lesson_id] = (countsByLesson[scenario.lesson_id] ?? 0) + 1;
    return countsByLesson;
  }, {});

  const decodeMs = sha.median + inflated.median + parsed.median;
  const decodeMinMs = sha.min + inflated.min + parsed.min;
  const decodeCpuMs = sha.cpuMedian + inflated.cpuMedian + parsed.cpuMedian;
  const decodeCpuMinMs = sha.cpuMin + inflated.cpuMin + parsed.cpuMin;
  const report = {
    measured_at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    load_average_1m: Number(loadavg()[0].toFixed(2)),
    runs: args.runs,
    manifest: {
      // Relative to the working directory the measurement ran from, so the
      // committed report never embeds a worktree path that later disappears.
      path: relative(process.cwd(), args.manifest),
      bytes: manifestBytes.byteLength,
      parse_ms: Number(manifestParseMs.toFixed(2)),
      packs: packs.length,
    },
    first_deal: {
      pack_id: first.entry.id,
      lesson_id: first.lessonId,
      reviewed_bases: counts[first.lessonId] ?? first.bases,
      body_path: first.entry.path,
      body_bytes: bodyBytes.byteLength,
      body_scenarios: body.scenarios.length,
      uncompressed_bytes: inflated.result.byteLength,
      sha256_matches: sha.result === String(first.entry.sha256).toLowerCase(),
    },
    phases_ms: {
      sha256_verify: phase(sha),
      gunzip: phase(inflated),
      json_parse: phase(parsed),
      decode_total: {
        median_ms: Number(decodeMs.toFixed(2)),
        min_ms: Number(decodeMinMs.toFixed(2)),
        cpu_median_ms: Number(decodeCpuMs.toFixed(2)),
        cpu_min_ms: Number(decodeCpuMinMs.toFixed(2)),
      },
    },
    cache: {
      cold: 'manifest + body download, then verify/decode',
      hit: 'no body download; the loader still verifies and decodes cached bytes',
      cache_hit_median_ms: Number(decodeMs.toFixed(2)),
      cache_hit_min_ms: Number(decodeMinMs.toFixed(2)),
      cache_hit_cpu_median_ms: Number(decodeCpuMs.toFixed(2)),
      cache_hit_cpu_min_ms: Number(decodeCpuMinMs.toFixed(2)),
    },
    budget_ms: 2500,
    within_budget_cpu: decodeCpuMinMs <= 2500,
  };

  console.log(`manifest ${report.manifest.path}`);
  console.log(`  ${report.manifest.bytes} bytes, ${report.manifest.packs} pack(s), parse ${report.manifest.parse_ms} ms`);
  console.log(
    `first deal ${report.first_deal.lesson_id} from ${report.first_deal.pack_id}`,
  );
  console.log(
    `  ${report.first_deal.reviewed_bases} reviewed bases, body ${report.first_deal.body_bytes} bytes ` +
      `(${report.first_deal.uncompressed_bytes} bytes uncompressed, ${report.first_deal.body_scenarios} scenarios)`,
  );
  console.log(`  sha256 matches the manifest: ${report.first_deal.sha256_matches}`);
  console.log(
    `phases over ${args.runs} run(s), wall median / best, CPU median / best: ` +
      `sha256 ${report.phases_ms.sha256_verify.median_ms} / ${report.phases_ms.sha256_verify.min_ms} / ` +
      `${report.phases_ms.sha256_verify.cpu_median_ms} / ${report.phases_ms.sha256_verify.cpu_min_ms} ms, ` +
      `gunzip ${report.phases_ms.gunzip.median_ms} / ${report.phases_ms.gunzip.min_ms} / ` +
      `${report.phases_ms.gunzip.cpu_median_ms} / ${report.phases_ms.gunzip.cpu_min_ms} ms, ` +
      `JSON parse ${report.phases_ms.json_parse.median_ms} / ${report.phases_ms.json_parse.min_ms} / ` +
      `${report.phases_ms.json_parse.cpu_median_ms} / ${report.phases_ms.json_parse.cpu_min_ms} ms`,
  );
  console.log(
    `decode total: wall ${report.phases_ms.decode_total.median_ms} / ${report.phases_ms.decode_total.min_ms} ms, ` +
      `CPU ${report.phases_ms.decode_total.cpu_median_ms} / ${report.phases_ms.decode_total.cpu_min_ms} ms`,
  );
  console.log(
    `cache: cold = manifest+body download+decode; hit = decode only, ` +
      `${report.cache.cache_hit_median_ms} / ${report.cache.cache_hit_min_ms} ms wall, ` +
      `${report.cache.cache_hit_cpu_median_ms} / ${report.cache.cache_hit_cpu_min_ms} ms CPU`,
  );
  console.log(
    `first-deal budget ${report.budget_ms} ms per phase: decode CPU ` +
      `${report.within_budget_cpu ? 'within' : 'over'} budget`,
  );

  if (args.out) {
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${args.out}`);
  }
  return report.first_deal.sha256_matches ? 0 : 1;
}

process.exit(main());
