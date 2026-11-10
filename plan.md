# Riichi Mahjong Trainer: High-Level Architecture & Project Plan

## 1. Project Objective
To build a fully client-side, browser-based web application that trains players on specific Riichi Mahjong scenarios and heuristics (heavily inspired by *Riichi Book 1*). Instead of static puzzles, the app procedurally generates randomized hands and board states that perfectly fit predefined teaching constraints, asking the user to make the correct decision (e.g., Riichi vs. Dama, Push vs. Fold, Nani Kiru).

## 2. Technical Stack
*   **Frontend Framework:** Vite + React + TypeScript.
*   **State Management:** Zustand (for lightweight, predictable board state UI).
*   **Tile Rendering:** SVG-based tile library (e.g., `riichi-mahjong-tiles` npm package).
*   **Core Engine (Logic & Generation):** Rust compiled to WebAssembly (WASM).
*   **Mahjong Logic Library:** The open-source `agari` Rust crate (handles low-level shanten, yaku validation, wait parsing, and ukeire calculations).
*   **Hosting:** Fully serverless/static hosting (GitHub Pages, Vercel, Netlify).

## 3. Core Architectural Paradigm: Constraint Satisfaction Problem (CSP)
The app does **not** generate random hands and use an AI/Oracle to figure out the best move. Instead, the "correct answer" and the "scenario constraints" are known *first*. 

The app acts as a **Constraint Satisfaction generator**:
1.  **Define the Lesson:** (e.g., Target: Dama. Constraints: Turns 1-6, Kanchan wait, Mangan minimum, Tenpai).
2.  **Generate the State:** The Rust engine builds a randomized game state that exactly matches these constraints.
3.  **Present to User:** The frontend renders the state and asks for the decision.
4.  **Evaluate:** The user's input is compared against the predefined correct answer.

## 4. The Generation Pipeline (Rust/WASM)
Because finding exact edge-case hands via brute force takes too long, the Rust engine uses a combination of **Constructive Skeletons** and **Fast Rejection Sampling**.

*   **Step A: Construct the Skeleton:** Force the required constraints first. (e.g., Place a `46p` in the hand to force a Kanchan wait, and place a Yakuhai triplet + Dora indicator to guarantee Mangan).
*   **Step B: Random Fill (5-Block Theory):** Randomly pull tiles from the remaining 135-tile pool to complete the remaining necessary blocks (pairs/melds).
*   **Step C: Rejection Sampling via `agari`:** Feed the resulting 14 tiles into the `agari` crate's evaluator.
    *   *Did the random fill accidentally create a 3-sided wait?* Reject and re-roll.
    *   *Did the random fill accidentally add extra yaku making it a Haneman?* Reject and re-roll.
    *   Because Rust + `agari` is exceptionally fast, thousands of rejections can happen in milliseconds before yielding a valid puzzle to the frontend.
*   **Step D: Board State Generation:** Generate opponent discards to match the required threat level (e.g., generating safe tiles for fold scenarios, or generating a 6-tile river for an early-turn scenario).

## 5. Frontend / Backend Division of Labor
*   **Rust (WASM):** 
    *   Contains the `ScenarioGenerator` trait.
    *   Maintains the pool of constraints (the "Book 1" syllabus).
    *   Uses `agari` to build, validate, and verify hands.
    *   Exports a function like `generate_puzzle(category: String) -> JSON`.
*   **TypeScript (React):**
    *   Extremely thin logic layer. 
    *   Takes the JSON game state from WASM and renders the hand, rivers, and table UI.
    *   Captures user clicks (Discard X, Call Riichi, Fold) and compares it to the `correct_action` provided in the JSON payload.
    *   Handles localization, UI transitions, and local storage (progress tracking).

## 6. Implementation Phases
*   **Phase 1: Rust/WASM Foundation:** Set up the Rust project, import `agari`, set up `wasm-bindgen` with JS-based entropy (`js-sys` `Math.random`), and prove you can generate and parse a single hand.
*   **Phase 2: The Generator Engine:** Build the Constructive Skeleton + Rejection Sampling pipeline. Write the first specific scenario generator (e.g., Early Turn, Bad Wait, Mangan).
*   **Phase 3: React UI:** Scaffold the Vite project, build the Mahjong Table UI, and wire up the WASM module.
*   **Phase 4: Content Expansion:** Translate more *Riichi Book 1* rules into Rust constraint templates. Add push/fold threat simulation to the discard generators.