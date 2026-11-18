#!/usr/bin/env node
/**
 * Verify how a static server presents the same-origin pack bodies.
 *
 *   npm --prefix frontend run build
 *   node scripts/check-pack-serving.mjs
 *
 * The loader verifies the body's byte count and SHA-256 against the manifest
 * *before* it gunzips it, so the body must arrive as the exact bytes on disk:
 * `Content-Type: application/gzip` and no `Content-Encoding`. Vite's static
 * middleware used to infer `Content-Encoding: gzip` from the `.json.gz`
 * extension; a browser then silently decompressed the response and the loader
 * saw the 2 MB JSON document instead of the 143 KB gzip body.
 *
 * This starts `vite preview` (the same `rawScenarioPackBodies` middleware as
 * `vite dev`), reads the manifest, fetches every pack body with Node's raw
 * `http` client (no automatic decompression) and asserts:
 *
 *   - the body is served as `application/gzip`;
 *   - the response carries no `Content-Encoding` (or `identity`);
 *   - `Content-Length`, byte count and SHA-256 match the manifest.
 *
 * Exit 1 on any failure. This is an HTTP-header check, not a visual judgement.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { get } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = join(repoRoot, 'frontend');
const dist = join(frontend, 'dist', 'scenarios');

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('PASS 0: frontend/dist/scenarios is missing; run `npm --prefix frontend run build` first');
  process.exit(1);
}

const port = 5199 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const viteBin = join(frontend, 'node_modules', 'vite', 'bin', 'vite.js');
const child = spawn(
  process.execPath,
  [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {
    cwd: frontend,
    stdio: ['ignore', 'pipe', 'pipe'],
    // CI builds with the Pages base path; this check only needs the pack
    // directory, so serve the preview at the root for a stable URL.
    env: { ...process.env, VITE_BASE_PATH: '/' },
  },
);
let serverOutput = '';
child.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  serverOutput += chunk.toString();
});

function httpGet(url) {
  return new Promise((resolvePromise, reject) => {
    const request = get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolvePromise({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error(`timeout: ${url}`)));
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await httpGet(`${base}/scenarios/manifest.json`);
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await delay(100);
  }
  throw new Error(`vite preview did not start:\n${serverOutput}`);
}

const problems = [];
const checks = [];
function check(condition, message) {
  checks.push(message);
  if (!condition) problems.push(message);
}

try {
  await waitForServer();
  const manifestResponse = await httpGet(`${base}/scenarios/manifest.json`);
  check(manifestResponse.status === 200, 'manifest responds 200');
  const manifest = JSON.parse(manifestResponse.body.toString('utf8'));
  check(Array.isArray(manifest.packs) && manifest.packs.length > 0, 'manifest lists a pack');

  for (const entry of manifest.packs) {
    const response = await httpGet(`${base}/scenarios/${entry.path}`);
    check(response.status === 200, `${entry.id}: body responds 200`);
    check(
      String(response.headers['content-type'] ?? '').startsWith('application/gzip'),
      `${entry.id}: content-type is application/gzip (${response.headers['content-type']})`,
    );
    const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
    check(
      encoding === '' || encoding === 'identity',
      `${entry.id}: no Content-Encoding (${encoding || 'absent'})`,
    );
    check(
      Number(response.headers['content-length']) === entry.bytes,
      `${entry.id}: Content-Length ${response.headers['content-length']} equals manifest ${entry.bytes}`,
    );
    check(
      response.body.length === entry.bytes,
      `${entry.id}: body is ${entry.bytes} bytes (${response.body.length})`,
    );
    const digest = createHash('sha256').update(response.body).digest('hex');
    check(digest === entry.sha256, `${entry.id}: body SHA-256 matches the manifest`);
  }
} catch (err) {
  problems.push(String(err));
} finally {
  child.kill('SIGTERM');
}

for (const problem of problems) console.log(`FAIL ${problem}`);
console.log(
  `check-pack-serving: ${checks.length - problems.length}/${checks.length + problems.length} checks passed`,
);
process.exit(problems.length === 0 ? 0 : 1);
