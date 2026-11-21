//! Print the app's published scenario catalogue as JSON.
//!
//! `generator::list_scenarios_json()` is the document the WASM
//! `list_scenarios()` binding hands the frontend picker. The replay coverage
//! report reads the same document through `--catalogue`, so a book lesson that
//! has no hosted pack appears in the report with zero bases and a
//! `not-shipped` decision instead of disappearing from the coverage table.
//!
//! ```text
//! cargo run --quiet --bin dump_scenarios > lessons.json
//! node scripts/replay-coverage-report.mjs --catalogue lessons.json
//! ```

fn main() {
    println!("{}", riichiprac::generator::list_scenarios_json());
}
