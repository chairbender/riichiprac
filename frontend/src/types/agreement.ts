/**
 * TypeScript mirror of the Rust `MortalAgreementReport`
 * (`src/generator/mortal_agreement.rs`).
 *
 * The report travels beside the table when the app asks the WASM bridge for a
 * hand that also satisfies Mortal: `generate_puzzle_with_agreement` returns
 * `{ "state": GameState, "agreement": MortalAgreementReport }`.
 */

/** Rejected candidates, split by why the model disagreed. */
export interface AgreementRejections {
  /** Mortal's top action was a different action family. */
  action: number;
  /** Mortal picked the same family but a different tile. */
  tile: number;
  /** The book answer has no legal Mortal equivalent. */
  incomparable: number;
  /** The forward pass failed. */
  evaluation_failed: number;
}

/** What one agreement-sampling call did. */
export interface MortalAgreementReport {
  /** Candidate bound the app asked for. */
  max_candidates: number;
  /** Candidates generated, including generation and evaluation failures. */
  attempts: number;
  /** Candidates that produced an evaluation. */
  evaluations: number;
  /** Candidates the lesson generators could not build. */
  generation_failures: number;
  /** Always true on the accepted path. */
  accepted: boolean;
  /** Mortal's top action on the accepted candidate. */
  recommended_action?: string;
  rejected: AgreementRejections;
}
