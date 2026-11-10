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
