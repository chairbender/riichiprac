#!/usr/bin/env node
/**
 * Named snapshots of `tools/render/decal-spec.json`.
 *
 * The carved-decal look is a set of lighting + carve numbers; experiments are
 * cheap to make and easy to lose. This tool saves the active spec under
 * `tools/render/decal-profiles/<name>.json` and restores it later.
 *
 *   node tools/render/scripts/decal-profile.mjs list
 *   node tools/render/scripts/decal-profile.mjs save approved-lying-v2
 *   node tools/render/scripts/decal-profile.mjs use approved-lying-v2
 *
 * `use` only rewrites `decal-spec.json`; it does not bake. Run
 * `bash tools/render/bake-decals.sh --bake` afterwards to commit the decals,
 * or `--build` for a preview.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(here, '../decal-spec.json');
const profilesDir = resolve(here, '../decal-profiles');

function fail(message) {
  console.error(`decal-profile: ${message}`);
  process.exit(2);
}

function readSpec(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function summary(spec) {
  const lying = spec.lighting?.lying?.lights ?? [];
  const key = lying.find((light) => light.id === 'key');
  const glare = lying.filter((light) => light.group === 'glare');
  return {
    whiteIslands: spec.carve?.whiteFillUncarved === true,
    lyingKeyTiltDeg: key?.tiltDeg ?? null,
    lyingLights: lying.length,
    glareLights: glare.length,
  };
}

function list() {
  if (!existsSync(profilesDir)) {
    console.log('no profiles yet (tools/render/decal-profiles/)');
    return;
  }
  const files = readdirSync(profilesDir).filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) {
    console.log('no profiles yet (tools/render/decal-profiles/)');
    return;
  }
  for (const file of files) {
    const name = file.slice(0, -5);
    const spec = readSpec(join(profilesDir, file));
    console.log(`${name.padEnd(28)} ${JSON.stringify(summary(spec))}`);
  }
}

function save(name) {
  if (!name) fail('save needs a profile name');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    fail('profile names are letters, digits, dot, underscore and dash');
  }
  mkdirSync(profilesDir, { recursive: true });
  const target = join(profilesDir, `${name}.json`);
  writeFileSync(target, `${JSON.stringify(readSpec(specPath), null, 2)}\n`);
  console.log(`saved ${specPath} -> ${target}`);
}

function use(name) {
  if (!name) fail('use needs a profile name');
  const source = join(profilesDir, `${name}.json`);
  if (!existsSync(source)) fail(`no profile ${name}`);
  writeFileSync(specPath, `${JSON.stringify(readSpec(source), null, 2)}\n`);
  console.log(`applied ${source} -> ${specPath}`);
  console.log('bake with: bash tools/render/bake-decals.sh --bake');
}

const [command, name] = process.argv.slice(2);
switch (command) {
  case 'list':
    list();
    break;
  case 'save':
    save(name);
    break;
  case 'use':
    use(name);
    break;
  case undefined:
  case '-h':
  case '--help':
    console.log('usage: decal-profile.mjs list | save NAME | use NAME');
    break;
  default:
    fail(`unknown command ${command}`);
}
