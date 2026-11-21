#!/usr/bin/env node
/**
 * 3D-15 handoff artifact: write the full-board stress state as an importable
 * position file.
 *
 * The state is the committed fixture (`src/renderers/three/stressFixture.ts`),
 * wrapped by the app's own `serializeState`, so the file is exactly what the
 * setup sheet's Position section accepts. The output lives under
 * `scripts/out/` (gitignored review artifacts) and is not used as test
 * evidence — `npm test` and `check-3d-layout.mjs` are.
 *
 * Usage: node scripts/export-stress-position.mjs [path]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(
  FRONTEND_ROOT,
  process.argv[2] ?? 'scripts/out/stress-position.json',
);

const server = await createServer({
  root: FRONTEND_ROOT,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});

try {
  const fixture = await server.ssrLoadModule(
    '/src/renderers/three/stressFixture.ts',
  );
  const stateFile = await server.ssrLoadModule('/src/stateFile.ts');
  const exported = stateFile.serializeState(
    fixture.stressGameState(),
    '3D-15 stress board: all zones full, all 37 faces, four Riichi, a closed kan per seat, ' +
      'three-row rivers, a claimed discard. Import in the Setup sheet (Position) to inspect ' +
      'the exposed 3D view.',
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, exported.json);
  console.log(`${output} (${exported.json.length} bytes)`);
} finally {
  await server.close();
}
