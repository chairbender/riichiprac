# riichiprac
Practice riichi mahjong strategy

## Development

Requires Rust, [`wasm-pack`](https://rustwasm.github.io/wasm-pack/), and Node.js.

```bash
# Build the WASM package used by the frontend.
wasm-pack build --target web

cd frontend
npm install
npm run dev
```

The Mortal AI evaluator is optional. Its weights are not committed; generate them
with `scripts/convert_weights.py` (see `scripts/README.md`). Without the weights,
the app runs normally and the AI panel reports that the model is unavailable.

## AI Best Action scenario

`AI Best Action` generates a random, deck-consistent table and presents whatever
decision the loaded Mortal v4 model can answer: discard, Riichi, tsumo/ron, chi,
pon, kan, or pass. The correct answer is the model's highest-probability legal
action at generation time; it is not a hand-written lesson. After answering, the
trainer shows `Best answer per <model>` and the full ranked report of every legal
action.

The scenario requires the model weights. The picker marks it as model-backed,
and the "All scenarios" random pool skips it until the weights have finished
loading. The recommendation is an AI opinion, not ground truth; the explanation
says so explicitly.

The AI scenario is generated entirely in Rust/WASM: the state is built from the
shared deck, validated, encoded, evaluated once (plus a second pass when the
model chooses Riichi), and returned to React with `correct_action`, the legal
action list, and the evaluation. React only renders and grades.
