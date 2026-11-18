#!/usr/bin/env node
/**
 * Measure an external scenario-pack mirror's CORS and integrity (P2).
 *
 *   node scripts/check-pack-cors.mjs \
 *     --url https://cdn.example/packs/replay.fixture.2026-11-<sha>.json.gz \
 *     --sha256 <64-hex> --bytes <n>
 *
 * The manifest always stays same-origin on Pages; only pack bodies may live on
 * an optional R2 or Hugging Face mirror. A browser can only use a mirror that
 * answers with `access-control-allow-origin: *` (or the Pages origin), so this
 * script measures exactly that instead of trusting a hosting provider's docs.
 * When `--sha256`/`--bytes` are given it downloads the body and proves the
 * mirror serves the audited bytes, not a stale or replaced pack.
 *
 * With no URL (argument or `PACK_MIRROR_BODY_URL`), it prints "skipped" and
 * exits 0: a mirror is optional and must never block a Pages deploy. Exit code 1
 * means the mirror is configured but unusable.
 *
 * The same rule as the weights CORS finding in hosting-plan.md applies: GitHub
 * Release assets send no `access-control-allow-origin` header, so they are a CI
 * copy source, never a browser mirror. Google Drive is a corpus/DB backup, never
 * a pack host.
 */
import { createHash } from 'node:crypto';

const DEFAULT_ORIGIN = 'https://chairbender.github.io';
const TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const parsed = {
    url: process.env.PACK_MIRROR_BODY_URL ?? '',
    origin: process.env.PACK_ORIGIN ?? DEFAULT_ORIGIN,
    sha256: '',
    bytes: null,
    requireCors: true,
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
    if (flag === '--url') parsed.url = value();
    else if (flag === '--origin') parsed.origin = value();
    else if (flag === '--sha256') parsed.sha256 = value().toLowerCase().replace(/^sha256:/, '');
    else if (flag === '--bytes') parsed.bytes = Number(value());
    else if (flag === '--require-cors') parsed.requireCors = true;
    else if (flag === '--no-require-cors') parsed.requireCors = false;
    else if (flag === '--json') parsed.json = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        'node scripts/check-pack-cors.mjs [--url URL] [--origin ORIGIN] [--sha256 HASH] [--bytes N] [--require-cors|--no-require-cors] [--json]',
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (parsed.bytes !== null && (!Number.isInteger(parsed.bytes) || parsed.bytes <= 0)) {
    console.error('--bytes must be a positive integer');
    process.exit(2);
  }
  if (parsed.sha256 && !/^[0-9a-f]{64}$/.test(parsed.sha256)) {
    console.error('--sha256 must be a 64-character hex SHA-256');
    process.exit(2);
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));

if (!args.url || args.url.trim() === '') {
  if (args.json) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no external mirror configured' }, null, 2));
  } else {
    console.log('pack mirror CORS: skipped (no --url / PACK_MIRROR_BODY_URL configured)');
  }
  process.exit(0);
}

let url;
let origin;
try {
  url = new URL(args.url);
  origin = new URL(args.origin);
} catch (error) {
  console.error(`invalid URL: ${error.message}`);
  process.exit(2);
}
if (!/^https?:$/.test(url.protocol)) {
  console.error(`--url must be http(s), got ${url.protocol}`);
  process.exit(2);
}

const crossOrigin = url.origin !== origin.origin;
const needsBody = Boolean(args.sha256);
const problems = [];
const report = {
  url: url.toString(),
  origin: origin.origin,
  crossOrigin,
  requireCors: args.requireCors && crossOrigin,
  status: null,
  contentType: null,
  contentLength: null,
  accessControlAllowOrigin: null,
  accessControlExposeHeaders: null,
  bytesReceived: null,
  sha256: null,
  ok: false,
  problems,
};

function record(condition, message) {
  if (!condition) problems.push(message);
  return condition;
}

async function request(method) {
  const response = await fetch(url, {
    method,
    redirect: 'follow',
    cache: 'no-store',
    headers: { Origin: origin.origin, 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return response;
}

let response;
try {
  response = await request(needsBody ? 'GET' : 'HEAD');
  if (response.status === 405 || response.status === 501) {
    response = await request('GET');
  }
} catch (error) {
  record(false, `request failed: ${error.message}`);
}

if (response) {
  report.status = response.status;
  report.contentType = response.headers.get('content-type');
  report.contentLength = response.headers.get('content-length');
  report.accessControlAllowOrigin = response.headers.get('access-control-allow-origin');
  report.accessControlExposeHeaders = response.headers.get('access-control-expose-headers');

  record(response.status === 200, `status is ${response.status} (expected 200)`);
  record(
    !report.contentType || !/text\/html/i.test(report.contentType),
    `content-type is ${report.contentType ?? 'missing'}; an HTML error page is not a pack body`,
  );

  if (report.requireCors) {
    const allowOrigin = report.accessControlAllowOrigin?.trim();
    record(
      allowOrigin === '*' || allowOrigin === origin.origin,
      `access-control-allow-origin is ${allowOrigin ?? 'missing'} (a browser needs * or ${origin.origin})`,
    );
  }

  if (args.bytes !== null) {
    if (report.contentLength === null) {
      record(false, 'content-length header is missing; the byte count cannot be verified');
    } else {
      record(
        Number(report.contentLength) === args.bytes,
        `content-length is ${report.contentLength} (expected ${args.bytes})`,
      );
    }
  }

  if (needsBody) {
    try {
      const bytes = Buffer.from(await response.arrayBuffer());
      report.bytesReceived = bytes.length;
      report.sha256 = createHash('sha256').update(bytes).digest('hex');
      record(
        report.sha256 === args.sha256,
        `body hashes to ${report.sha256} (expected ${args.sha256})`,
      );
      if (args.bytes !== null) {
        record(
          bytes.length === args.bytes,
          `received ${bytes.length} bytes (expected ${args.bytes})`,
        );
      }
    } catch (error) {
      record(false, `could not read the body: ${error.message}`);
    }
  }
}

report.ok = problems.length === 0;

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`pack mirror: ${report.url}`);
  console.log(`  origin: ${report.origin}${report.crossOrigin ? ' (cross-origin: CORS required)' : ' (same-origin)'}`);
  console.log(`  status: ${report.status ?? 'unreachable'}`);
  console.log(`  content-type: ${report.contentType ?? 'missing'}`);
  console.log(`  content-length: ${report.contentLength ?? 'missing'}`);
  console.log(`  access-control-allow-origin: ${report.accessControlAllowOrigin ?? 'missing'}`);
  if (report.accessControlExposeHeaders) {
    console.log(`  access-control-expose-headers: ${report.accessControlExposeHeaders}`);
  }
  if (report.sha256) console.log(`  sha256: ${report.sha256} (${report.bytesReceived} bytes received)`);
  if (report.ok) {
    console.log('  PASS');
  } else {
    for (const problem of problems) console.error(`  FAIL ${problem}`);
  }
}

process.exit(report.ok ? 0 : 1);
