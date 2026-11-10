import { create } from 'zustand';
import { WasmMortalEvaluator } from 'riichiprac';
import {
  correctActionTile,
  findKanCandidateTile,
  isCorrectAction,
  isKanDecision,
} from '../actions';
import { WEIGHTS_URL } from '../aiModel';
import { parseImportedState } from '../report';
import type { AiActionInfo, AiEvaluation, AiStatus } from '../types/ai';
import type { CorrectActionType, GameState } from '../types/game';
import type { ReportVerdict, ScenarioReport } from '../types/report';
import { ensureWasmReady } from '../wasm';

export interface PlayerChoice {
  /** Mortal action name, e.g. `Discard_3m`, `Chi_Low`, `Pon`, `Pass`. */
  action: string;
  /** Clicked or claimed tile code, when the action has one. */
  tile?: string;
  /** Additional tiles consumed by a call (chi). */
  tiles?: string[];
  /** Optional label override; normally taken from the payload. */
  label?: string;
}

export interface AnswerFeedback {
  /** True only when both the action type and clicked tile are correct. */
  isCorrect: boolean;
  /** Whether the player submitted Riichi, Dama, Kan, or a normal discard. */
  selectedType: CorrectActionType;
  /** Action type the scenario expected. */
  correctType: CorrectActionType;
  isActionCorrect: boolean;
  selectedTile: string;
  /** Index of the clicked copy in the rendered hand, when known. */
  selectedTileIndex?: number;
  correctTile: string;
  isTileCorrect: boolean;
  /** Human-readable labels for AI-scenario feedback. */
  selectedLabel: string;
  correctLabel: string;
  /** Concrete tiles involved in a call, for highlighting. */
  selectedTiles: string[];
  correctTiles: string[];
  isMortalDecision: boolean;
  /** Mortal action name for an AI-scenario answer. */
  selectedAction?: string;
}

/** An imported report being reviewed in the UI. */
export interface ReportMode {
  report: ScenarioReport;
  verdict: ReportVerdict;
  warnings: string[];
}

interface GameStore {
  /** Parsed table state from the WASM `generate_puzzle` payload. */
  gameState: GameState | null;
  isLoading: boolean;
  error: string | null;
  /** Whether the player has armed the "Call Riichi" toggle. */
  callRiichi: boolean;
  /** Whether the player has armed the Shouminkan call. */
  callKan: boolean;
  /** Result of the player's action + tile choice, or null before answering. */
  feedback: AnswerFeedback | null;

  /** Imported report currently under review, or null in normal practice. */
  reportMode: ReportMode | null;
  /** Import/export error shown beside the report controls. */
  reportError: string | null;
  /** Non-error notice, e.g. after importing a bare game state. */
  reportNotice: string | null;
  /** True after "Try this puzzle", so normal answer feedback is shown again. */
  isReportRetry: boolean;

  /** Model weight loading state for the Mortal evaluator. */
  aiStatus: AiStatus;
  aiError: string | null;
  /** Loaded Candle model; created once and reused for every evaluation. */
  evaluator: WasmMortalEvaluator | null;
  /** Latest AI result for the current table, or null before evaluating. */
  evaluation: AiEvaluation | null;
  isEvaluating: boolean;

  /** Parse and store a raw JSON payload returned by the WASM engine. */
  loadFromJson: (json: string) => void;
  /** Arm or disarm the Riichi declaration before choosing a discard. */
  toggleRiichi: () => void;
  /** Arm or disarm the Added Kan before choosing the fourth tile. */
  toggleKan: () => void;
  /** Submit the armed call state and clicked hand tile as one answer. */
  selectTile: (tile: string, tileIndex?: number) => void;
  /** Submit a generic AI-scenario choice. */
  submitChoice: (choice: PlayerChoice) => void;
  /** Submit a non-discard action from the generic action bar. */
  submitAction: (action: AiActionInfo) => void;
  /** Clear the current table and answer before loading the next scenario. */
  reset: () => void;
  setError: (error: string) => void;

  /** Import a report (or a bare game state) from file text. */
  importReport: (text: string) => Promise<void>;
  /** Clear the imported answer so the reviewer can try the puzzle again. */
  retryImportedPuzzle: () => void;
  /** Leave report mode without changing the table. */
  exitReportMode: () => void;
  /** Show or clear an import/export error. */
  setReportError: (error: string | null) => void;
  /** Dismiss the bare-state notice. */
  clearReportNotice: () => void;

  /** Fetch the Safetensors weights and build the WASM evaluator once. */
  initializeAi: () => Promise<void>;
  /** Evaluate the current table with the loaded Mortal model. */
  evaluateWithAi: () => Promise<void>;
  /** Hide the current AI recommendation without unloading the model. */
  clearEvaluation: () => void;
}

interface WasmErrorPayload {
  error?: string;
}

const LEGACY_LABELS: Record<CorrectActionType, string> = {
  riichi: 'Riichi',
  dama: 'Dama',
  kan: 'Kan',
  discard: 'No Kan',
  best: 'AI best action',
};

/** Collapse a red-five discard action onto its base tile for grading. */
function normalizeMortalAction(action: string): string {
  return action.startsWith('Discard_') && action.endsWith('r')
    ? action.slice(0, -1)
    : action;
}

/** Find the payload info for a selected AI action, including red-five aliases. */
function findAiAction(
  state: GameState,
  action: string,
  tile?: string,
): AiActionInfo | undefined {
  const actions = state.ai_decision?.actions ?? [];
  return (
    actions.find((candidate) => candidate.action === action) ??
    actions.find(
      (candidate) =>
        normalizeMortalAction(candidate.action) ===
          normalizeMortalAction(action) &&
        (tile === undefined || candidate.tile === tile),
    )
  );
}

/**
 * Deduplicates concurrent model loads. `loadEvaluator` runs from an effect, so
 * React StrictMode can fire it twice; the model must only be parsed once.
 */
let aiInitPromise: Promise<void> | null = null;

const emptyState = {
  gameState: null,
  isLoading: true,
  error: null,
  callRiichi: false,
  callKan: false,
  feedback: null,
  evaluation: null,
  reportMode: null,
  reportError: null,
  reportNotice: null,
  isReportRetry: false,
} satisfies Pick<
  GameStore,
  | 'gameState'
  | 'isLoading'
  | 'error'
  | 'callRiichi'
  | 'callKan'
  | 'feedback'
  | 'evaluation'
  | 'reportMode'
  | 'reportError'
  | 'reportNotice'
  | 'isReportRetry'
>;

export const useGameStore = create<GameStore>((set, get) => ({
  ...emptyState,
  aiStatus: 'idle',
  aiError: null,
  evaluator: null,
  isEvaluating: false,

  loadFromJson: (json) => {
    try {
      const parsed = JSON.parse(json) as GameState & WasmErrorPayload;

      if (parsed.error) {
        throw new Error(parsed.error);
      }
      if (!Array.isArray(parsed.players) || parsed.players.length !== 4) {
        throw new Error('WASM returned an invalid table state');
      }
      if (!isCorrectAction(parsed.correct_action)) {
        throw new Error('WASM returned an invalid correct action');
      }

      set({
        gameState: parsed,
        isLoading: false,
        error: null,
        callRiichi: false,
        callKan: false,
        feedback: null,
        evaluation: null,
        reportMode: null,
        reportError: null,
        reportNotice: null,
        isReportRetry: false,
      });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
        callRiichi: false,
        callKan: false,
        feedback: null,
        evaluation: null,
        reportMode: null,
        reportError: null,
        reportNotice: null,
        isReportRetry: false,
      });
    }
  },

  toggleRiichi: () =>
    set((state) => {
      if (!state.gameState || state.feedback) return state;
      if (state.gameState.correct_action.type === 'best') {
        const hasRiichi = state.gameState.ai_decision?.actions.some(
          (action) => action.action === 'Riichi',
        );
        if (!hasRiichi) return state;
      }
      return { callRiichi: !state.callRiichi, callKan: false };
    }),

  toggleKan: () =>
    set((state) => {
      if (!state.gameState || state.feedback) return state;

      const human = state.gameState.players.find((player) => player.is_human);
      if (!human || !findKanCandidateTile(human)) return state;

      return { callKan: !state.callKan, callRiichi: false };
    }),

  selectTile: (tile, tileIndex) => {
    const state = get();
    if (!state.gameState || state.feedback) return;

    if (state.gameState.correct_action.type === 'best') {
      const action = state.callRiichi ? 'Riichi' : `Discard_${tile}`;
      const info = findAiAction(state.gameState, action, tile);
      get().submitChoice({
        action: info?.action ?? action,
        tile,
        tiles: info?.tiles,
        label: info?.label,
      });
      return;
    }

    set((current) => {
      if (!current.gameState || current.feedback) return current;

      const { correct_action: correctAction, players } = current.gameState;
      const human = players.find((player) => player.is_human);
      const kanCandidate = human ? findKanCandidateTile(human) : null;

      let selectedType: CorrectActionType = 'dama';
      if (current.callKan && kanCandidate) {
        selectedType = 'kan';
      } else if (current.callRiichi) {
        selectedType = 'riichi';
      } else if (isKanDecision(correctAction)) {
        selectedType = 'discard';
      }

      const correctTile = correctActionTile(correctAction) ?? '';
      const isActionCorrect = selectedType === correctAction.type;
      const isTileCorrect = tile === correctTile;

      return {
        feedback: {
          isCorrect: isActionCorrect && isTileCorrect,
          selectedType,
          correctType: correctAction.type,
          isActionCorrect,
          selectedTile: tile,
          selectedTileIndex: tileIndex,
          correctTile,
          isTileCorrect,
          selectedLabel: LEGACY_LABELS[selectedType],
          correctLabel: LEGACY_LABELS[correctAction.type],
          selectedTiles: [tile],
          correctTiles: correctTile ? [correctTile] : [],
          isMortalDecision: false,
        },
      };
    });
  },

  submitChoice: (choice) =>
    set((state) => {
      if (!state.gameState || state.feedback) return state;
      const correctAction = state.gameState.correct_action;
      if (correctAction.type !== 'best') return state;

      const isActionCorrect =
        normalizeMortalAction(choice.action) ===
        normalizeMortalAction(correctAction.action);

      const needsTile =
        correctAction.action === 'Riichi' ||
        correctAction.action.startsWith('Discard_');
      const isTileCorrect =
        !needsTile || (choice.tile ?? '') === (correctAction.tile ?? '');

      const info = findAiAction(state.gameState, choice.action, choice.tile);
      const selectedBase =
        choice.label ?? info?.label ?? choice.action.replace(/_/g, ' ');
      const selectedLabel =
        correctAction.action === 'Riichi' && choice.tile
          ? `${selectedBase} — discard ${choice.tile}`
          : selectedBase;
      const correctLabel =
        correctAction.action === 'Riichi' && correctAction.tile
          ? `${correctAction.label} — discard ${correctAction.tile}`
          : correctAction.label;

      return {
        feedback: {
          isCorrect: isActionCorrect && isTileCorrect,
          selectedType: 'best',
          correctType: 'best',
          isActionCorrect,
          selectedTile: choice.tile ?? '',
          correctTile: correctAction.tile ?? '',
          isTileCorrect,
          selectedLabel,
          correctLabel,
          selectedTiles: choice.tiles ?? info?.tiles ?? [],
          correctTiles: correctAction.tiles ?? [],
          isMortalDecision: true,
          selectedAction: choice.action,
        },
      };
    }),

  submitAction: (action) => {
    if (action.action === 'Riichi') {
      get().toggleRiichi();
      return;
    }
    get().submitChoice({
      action: action.action,
      tile: action.tile ?? undefined,
      tiles: action.tiles,
      label: action.label,
    });
  },

  reset: () => set(emptyState),

  setError: (error) =>
    set({
      isLoading: false,
      error,
      callRiichi: false,
      callKan: false,
      feedback: null,
      evaluation: null,
      reportMode: null,
      reportError: null,
      reportNotice: null,
      isReportRetry: false,
    }),

  importReport: async (text) => {
    try {
      await ensureWasmReady();
      const imported = parseImportedState(text);

      if (imported.kind === 'bare') {
        get().loadFromJson(imported.json);
        if (!get().error) {
          set({
            reportNotice:
              'Loaded a bare game state. No reported answer was attached.',
          });
        }
        return;
      }

      const { report, verdict, warnings } = imported.parsed;
      const human = report.table.players.find((player) => player.is_human);
      if (!human) {
        throw new Error('The report does not contain a human player.');
      }

      const answer = report.decision.answer;
      const correctAction = report.table.correct_action;
      const feedback: AnswerFeedback = {
        isCorrect: verdict.is_correct,
        selectedType: answer.action,
        correctType: verdict.expected_action,
        isActionCorrect: verdict.is_action_correct,
        selectedTile: answer.tile,
        selectedTileIndex: answer.tile_index,
        correctTile: verdict.expected_tile,
        isTileCorrect: verdict.is_tile_correct,
        selectedLabel:
          answer.action === 'best'
            ? (answer.action_name ?? answer.tile)
            : LEGACY_LABELS[answer.action],
        correctLabel:
          correctAction.type === 'best'
            ? correctAction.label
            : LEGACY_LABELS[correctAction.type],
        selectedTiles: answer.tile ? [answer.tile] : [],
        correctTiles: verdict.expected_tile ? [verdict.expected_tile] : [],
        isMortalDecision:
          answer.action === 'best' || correctAction.type === 'best',
        selectedAction: answer.action_name,
      };

      set({
        gameState: report.table,
        isLoading: false,
        error: null,
        callRiichi: false,
        callKan: false,
        feedback,
        evaluation: null,
        reportMode: { report, verdict, warnings },
        reportError: null,
        reportNotice: null,
        isReportRetry: false,
      });

      if (get().aiStatus === 'ready') {
        // Fire and forget: the banner shows the "Checking…" state and the
        // import button should not stay busy while the model runs.
        void get().evaluateWithAi();
      }
    } catch (err) {
      set({
        reportError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  retryImportedPuzzle: () =>
    set({ feedback: null, isReportRetry: true }),

  exitReportMode: () =>
    set({ reportMode: null, isReportRetry: false }),

  setReportError: (reportError) => set({ reportError }),

  clearReportNotice: () => set({ reportNotice: null }),

  initializeAi: () => {
    if (aiInitPromise) return aiInitPromise;
    if (get().aiStatus === 'ready' || get().aiStatus === 'loading') {
      return Promise.resolve();
    }

    aiInitPromise = (async () => {
      set({ aiStatus: 'loading', aiError: null });
      try {
        await ensureWasmReady();

        const response = await fetch(WEIGHTS_URL);
        if (!response.ok) {
          throw new Error(
            `could not load ${WEIGHTS_URL} (HTTP ${response.status}). ` +
              'Run scripts/convert_weights.py to generate the model file.',
          );
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('text/html')) {
          throw new Error(
            `could not find ${WEIGHTS_URL}. ` +
              'Run scripts/convert_weights.py to generate the model file.',
          );
        }

        const bytes = new Uint8Array(await response.arrayBuffer());

        // Let the loading badge paint before the blocking 43 MB parse/bind.
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });

        const modelName = WEIGHTS_URL.split('/').pop() ?? 'Mortal v4';
        const evaluator = new WasmMortalEvaluator(bytes, modelName);
        set({ evaluator, aiStatus: 'ready', aiError: null });
      } catch (err) {
        aiInitPromise = null; // allow a retry from the UI
        set({
          evaluator: null,
          aiStatus: 'error',
          aiError: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return aiInitPromise;
  },

  evaluateWithAi: async () => {
    const { evaluator, gameState, isEvaluating } = get();
    if (!evaluator || !gameState || isEvaluating) return;

    set({ isEvaluating: true, aiError: null });
    try {
      // Yield once so the button's "Evaluating…" state can render before the
      // synchronous forward pass blocks the main thread.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      const evaluation = evaluator.evaluate(
        JSON.stringify(gameState),
      ) as AiEvaluation;

      // A scenario may have been swapped while the model was running.
      if (get().gameState === gameState) {
        set({ evaluation, isEvaluating: false });
      } else {
        set({ isEvaluating: false });
      }
    } catch (err) {
      set({
        isEvaluating: false,
        aiError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  clearEvaluation: () => set({ evaluation: null }),
}));
