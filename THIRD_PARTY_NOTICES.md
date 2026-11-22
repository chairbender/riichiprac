# Third-party notices

riichiprac is licensed **AGPL-3.0-or-later** (see `LICENSE` and
`docs/licensing.md`). This file records the third-party works the repository
derives from, vendors, or distributes, with their licences and provenance.

## Riichi Book 1 — CC BY-NC 3.0

- Work: *Riichi Book 1: A Mahjong Strategy Primer* by **Daina Chiba**.
- Licence: [Creative Commons
  Attribution-NonCommercial 3.0 Unported](https://creativecommons.org/licenses/by-nc/3.0/).
- How it is used: the book is the main inspiration for riichiprac. The lessons
  encode its heuristics and cite the chapter and section; the verdict panel
  quotes short passages from the book beside the rule each scenario teaches.
  The book's full text is not vendored, redistributed, or included in any
  build.
- Attribution: the README's "Built on Riichi Book 1" section and the About
  panel name the book, the author, and the licence.
- No endorsement: riichiprac is an independent, non-commercial study aid.
  Daina Chiba has not reviewed or endorsed it.
- This licence is separate from the repository's AGPL-3.0-or-later code
  licence. The AGPL does not relicense the book, and the book's CC BY-NC
  licence does not relicense any code in this repository.

## Mortal and libriichi — AGPL-3.0

- Upstream: <https://github.com/Equim-chan/Mortal>, including its Rust
  `libriichi` crate
  (<https://github.com/Equim-chan/Mortal/tree/master/libriichi>).
- Licence: GNU Affero General Public License, version 3.
- How it is used: the shipped WASM evaluator is a **translation**, not a link.
  - `src/ai/model.rs` mirrors Mortal's `mortal/model.py` (version 4) network.
  - `src/ai/encoder.rs` builds the `(1012, 34)` observation that libriichi's
    `PlayerState::encode_obs(4, false)` produces.
  - `src/ai/sp.rs` is a port of the single-player EV solver under
    `libriichi/src/algo/sp/`.
- Those ports are compiled into `riichiprac_bg.wasm` and served to users, so
  this repository is AGPL-3.0-or-later as a whole. The ports are not optional
  and not miner-only.

## Mortal model weights — AGPL-3.0

- File: `mortal_298k.safetensors` (43,555,532 bytes, SHA-256
  `afb911473ac8e20cb249c4c71344cf92c780cfc98d405c60574f38f485ccc128`).
- Upstream: `VoidShine/mortal-298k` on Hugging Face
  (<https://huggingface.co/VoidShine/mortal-298k>), an AGPL-3.0 checkpoint of
  `Equim-chan/Mortal`. Its model card says it was trained on Tenhou hanchan
  data.
- Conversion: `scripts/convert_weights.py` reads `mortal_298k.pth`, drops the
  training/optimizer state and writes the flat Safetensors file;
  `scripts/weight_keys.txt` records the key map. The `weights-v1` GitHub
  Release of this repository, published 2026-11-11, distributes the converted
  file. It is fetched at runtime and is not committed to git.
- The converter is the Corresponding Source for the conversion; the upstream
  checkpoint is the source for the weights themselves.
- This repository grants no licence to the weights beyond the AGPL-3.0 they
  already carry.

## Tile artwork

- `tools/render/faces/Regular-*.svg`: public-domain symbol-only SVGs from
  `SakaiTaka23/riichi-mahjong-tiles`, pinned at commit
  `f37d6cc2557498d23f13eb3e955e0e44e5c863ff`; the upstream README states
  CC0 1.0. The committed `frontend/public/table/faces/*.png` masters and the
  `frontend/public/table/relief3d/` atlases are bakes of those SVGs.
- The `riichi-mahjong-tiles` npm package (MIT) supplies the 2D React tile
  components: <https://github.com/SakaiTaka23/riichi-mahjong-tiles>.

## Libraries

Direct dependencies keep their own licences; this repository's
AGPL-3.0-or-later does not relicense them.

- `three` (MIT) — <https://github.com/mrdoob/three.js>
- `agari` (MIT) — <https://github.com/agari-industries/agari>
- `react`, `react-dom`, `zustand` (MIT)
- `candle-core`, `candle-nn`, `wasm-bindgen`, `serde`, `serde_json`
  (MIT OR Apache-2.0)

Development and test tooling keeps the licences recorded in `Cargo.lock` and
`frontend/package-lock.json`. Akochan is not shipped: it is an offline corpus
engine whose output terms are handled by the miner's per-agent licence gate, and
no Akochan code is in this repository.

## Source and network use (AGPL §13)

The Corresponding Source is public at
<https://github.com/chairbender/riichiprac>. If you modify this program and let
users interact with it over a network, §13 requires you to offer those users the
Corresponding Source of your version; a link to your public fork at the deployed
site is the simplest way to comply.
