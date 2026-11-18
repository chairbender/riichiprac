#!/usr/bin/env bash
# Q1 end-to-end acceptance harness for the replay miner.
#
# Runs the whole fixture pipeline twice into separate data roots, proves the two
# packs are byte-identical (same SHA-256), verifies the same-origin hosting
# directory, runs the gate-failure matrix, and loads the produced pack through
# the frontend loader. No GPU, network or Mortal checkpoint is used.
#
# Usage:
#   bash scripts/check-pipeline-e2e.sh
#   Q1_OUT_DIR=/tmp/q1 bash scripts/check-pipeline-e2e.sh
#
# Real corpus generation stays offline (C1–C8); this is the fixture harness only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="${Q1_GENERATED_AT:-2026-11-17T00:00:00Z}"
OUT="${Q1_OUT_DIR:-$ROOT/target/q1}"
RUN_A="$OUT/run-a"
RUN_B="$OUT/run-b"
REPORT_A="$OUT/run-a.json"
REPORT_B="$OUT/run-b.json"
BIN="$ROOT/target/release/mine_replays"

step() {
  printf '\n== %s ==\n' "$1"
}

step "Build the miner (release)"
cargo build --release --features miner --bin mine_replays

rm -rf "$OUT"
mkdir -p "$OUT"

step "Run the fixture pipeline (run A)"
"$BIN" --data-dir "$RUN_A" qa fixture \
  --corpus "$ROOT/testdata/replays" \
  --generated-at "$STAMP" \
  --json >"$REPORT_A"

step "Run the fixture pipeline (run B)"
"$BIN" --data-dir "$RUN_B" qa fixture \
  --corpus "$ROOT/testdata/replays" \
  --generated-at "$STAMP" \
  --json >"$REPORT_B"

step "G10: the same inputs produce the same pack hash"
node - "$REPORT_A" "$REPORT_B" <<'NODE'
const fs = require('node:fs');

const [aPath, bPath] = process.argv.slice(2);
const a = JSON.parse(fs.readFileSync(aPath, 'utf8'));
const b = JSON.parse(fs.readFileSync(bPath, 'utf8'));

const failures = [];
if (a.schema !== 'riichiprac.qa-pipeline') failures.push(`unexpected schema ${a.schema}`);
if (a.version !== 1) failures.push(`unexpected version ${a.version}`);
for (const [name, ok] of Object.entries(a.checks)) {
  if (!ok) failures.push(`run A check ${name} is false`);
}
for (const [name, ok] of Object.entries(b.checks)) {
  if (!ok) failures.push(`run B check ${name} is false`);
}
for (const key of ['sha256', 'bytes', 'scenarios']) {
  if (a.pack[key] !== b.pack[key]) {
    failures.push(`pack ${key}: run A ${a.pack[key]} != run B ${b.pack[key]}`);
  }
}
if (a.selection.selected !== b.selection.selected) {
  failures.push(`selection ${a.selection.selected} != ${b.selection.selected}`);
}
if (a.selection.held_out !== b.selection.held_out) {
  failures.push(`held-out ${a.selection.held_out} != ${b.selection.held_out}`);
}
if (a.storage.integrity !== 'ok') failures.push('snapshot integrity is not ok');
if (!a.hosting.verified) failures.push('hosting was not verified');

if (failures.length > 0) {
  console.error('Q1 determinism/acceptance FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`pack sha256: ${a.pack.sha256}`);
console.log(`pack bytes:  ${a.pack.bytes}`);
console.log(`scenarios:   ${a.pack.scenarios}`);
console.log(`selected:    ${a.selection.selected} (+${a.selection.held_out} held out)`);
console.log(`variants:    ${a.variants.shipped} shipped / ${a.variants.attempted} attempted`);
console.log(`snapshot:    ${a.storage.integrity}`);
NODE

step "P2/P3: verify the staged hosting directory"
node scripts/check-pack-hosting.mjs --dir "$RUN_A/hosted"

step "G9: load the pipeline pack through the frontend loader"
if [[ ! -d "$ROOT/frontend/node_modules" ]]; then
  (cd "$ROOT/frontend" && npm ci)
fi
(
  cd "$ROOT/frontend"
  Q1_PACK_DIR="$RUN_A/hosted" npx vitest run src/services/packLoader.q1.test.ts
)

step "Gate matrix: every hard gate has a failing fixture"
cargo test --features miner --test q1_gates

step "Q1 verdict"
echo "PASS"
echo "  pack:    $RUN_A/packs/$(node -e "const r=require('$REPORT_A'); console.log(r.pack.path.split('/').pop())")"
echo "  hosted:  $RUN_A/hosted"
echo "  reports: $REPORT_A $REPORT_B"
