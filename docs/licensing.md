# Licensing

## Current licence

riichiprac is licensed under the **GNU Affero General Public License, version 3
or (at your option) any later version** (`AGPL-3.0-or-later`). The full text is
in [`LICENSE`](../LICENSE); the works it derives from are recorded in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

The app ships as `riichiprac_bg.wasm` in the browser, so the AGPL covers the
deployed web app as well as the source in this repository.

## Transition (2026-11-22)

Prior to **2026-11-22** this repository was licensed **MIT**. From that date it
is **AGPL-3.0-or-later**, because the shipped evaluator contains direct ports of
AGPL-3.0 `libriichi` code (`src/ai/sp.rs`, `src/ai/encoder.rs`) and mirrors
Mortal v4 (`src/ai/model.rs`), and because the distributed `mortal_298k` weights
are AGPL-3.0 as well.

The git history was deliberately not rewritten, squashed, or orphaned. The MIT
grant on commits and releases published before 2026-11-22 remains valid for
those snapshots, and copies and forks taken before the change may keep
circulating under MIT. The first commit after the transition records the licence
swap, the new third-party notice and the documentation corrections.

## Copyright

`LICENSE` names **Kyle Hipke** as the copyright holder. All commits in the
repository history are authored by Kyle Hipke. If that changes, keep the
existing MIT notices for third-party MIT code in `THIRD_PARTY_NOTICES.md` rather
than stripping attribution: MIT is one-way compatible with the AGPL, so the
combined work can be AGPL provided those notices remain.

## Network use and source offer (AGPL §13)

The Corresponding Source is this public repository:
<https://github.com/chairbender/riichiprac>. The deployed site is built from it
by `.github/workflows/deploy.yml`, and the build commit is exposed in the app as
`__BUILD_COMMIT__`.

If you modify the program and let other users interact with it over a network,
§13 requires you to offer those users the Corresponding Source of your modified
version. A "Source" link on the deployed site that points at your fork, at the
commit actually deployed, is the simplest way to satisfy it.

## Model weights

The weights are a separate AGPL-3.0 work, are not committed to git, and are not
part of the build. Their provenance is in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md#mortal-model-weights--agpl-30)
and the "License" section of [`README.md`](../README.md#license).
