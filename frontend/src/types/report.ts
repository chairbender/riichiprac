/**
 * TypeScript mirror of the scenario report model in `src/report/model.rs`.
 * Keep this file in sync with the Rust structs.
 */

import type { AiEvaluation } from './ai';
import type { CorrectActionType, GameState } from './game';

export const REPORT_SCHEMA = 'riichiprac.scenario-report';
export const REPORT_VERSION = 1;
export const MAX_NOTE_CHARS = 4000;
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;

export type ReportReason =
  | 'expected_action_wrong'
  | 'expected_tile_wrong'
  | 'explanation_wrong'
  | 'ai_evaluation_wrong'
  | 'other';

export interface ReportedAction {
  action: CorrectActionType;
  tile: string;
  /** Index of the clicked copy in the rendered hand, when known. */
  tile_index?: number;
}

export interface AiComparison {
  app_action: string;
  app_probability: number;
  reporter_action: string;
  reporter_probability: number;
  ai_agrees_with_app: boolean;
  ai_agrees_with_reporter: boolean;
}

export interface ReportedAi {
  model: string;
  evaluated_at: string;
  evaluation: AiEvaluation;
  comparison?: AiComparison;
}

export interface ReportVerdict {
  is_correct: boolean;
  is_action_correct: boolean;
  is_tile_correct: boolean;
  expected_action: CorrectActionType;
  expected_tile: string;
}

export interface ScenarioSnapshot {
  id: string;
  label: string;
  description: string;
  category: string;
  tags: string[];
}

export interface AppInfo {
  app_version: string;
  commit: string;
  build_time: string;
}

export interface ReportDecision {
  prompt: string;
  reason: ReportReason;
  note?: string;
  answer: ReportedAction;
  verdict: ReportVerdict;
}

export interface ScenarioReport {
  schema: string;
  version: number;
  report_id: string;
  created_at: string;
  app: AppInfo;
  scenario: ScenarioSnapshot;
  decision: ReportDecision;
  table: GameState;
  ai?: ReportedAi;
  /** Derived summary lines for humans/agents; rebuilt on import. */
  human_readable: string[];
}

export interface ParsedReport {
  report: ScenarioReport;
  verdict: ReportVerdict;
  warnings: string[];
}

export interface BuildReportRequest {
  table: GameState;
  answer: ReportedAction;
  reason: ReportReason;
  note?: string;
  created_at: string;
  report_id: string;
  commit?: string;
  build_time?: string;
  ai?: ReportedAi;
}

/** Error envelope returned by the WASM report functions. */
export interface ReportErrorPayload {
  error?: string;
}
