import { create } from 'zustand';
import { grade_answer_json } from 'riichiprac';
import { findAiActionInfo, isCallDecision, isCorrectAction, isKanDecision } from '../actions';
import { parseAgreementPayload } from '../agreement';
import { answerPresentationFor } from '../answerPresentation';
import type { PickedCopyLike } from '../answerPresentation';
import type { AnsweredAction } from '../renderers/answeredBoard';
import {
  callButtonsFor,
  callContextFor,
  callName,
  callOptionForPicks,
  callOptionsFor,
  displayCopies,
  isSelectableCopy,
  previewCopiesFor,
  sharesCall,
} from '../callChoices';
import type {
  CallCopy,
  CallKind,
  CallOption,
  PendingCall,
  PickedCopy,
} from '../callChoices';
import type { ScenarioSnapshot } from '../scenarioHistory';
import { initMortalClient } from '../services/mortalClient';
import type { MortalClient } from '../services/mortalClient';
import { loadWeights, WEIGHTS_FILENAME } from '../services/weightLoader';
import { parseStateFile } from '../stateFile';
import type { AiDecision, AiEvaluation, AiStatus } from '../types/ai';
import type { MortalAgreementReport } from '../types/agreement';
import type { CorrectActionType, GameState } from '../types/game';
import type { DualGrade } from '../types/verdict';
import { ensureWasmReady, riichiDiscardTiles } from '../wasm';

/** An answer in the trainer's submitted-answer shape (mirrors `verdict.rs`). */
export interface SubmittedAnswer {
  action: CorrectActionType;
  tile: string;
  tile_index?: number;
  /** Mortal action name, e.g. `Discard_3m`, `Chi_Low`, `Pon`, `Pass`. */
  action_name?: string;
  /** True when the discarded tile was the draw (tsumogiri). */
  is_tsumogiri?: boolean;
}

/** A generic choice from the action bar. */
export interface PlayerChoice {
  /** Mortal action name, e.g. `Discard_3m`, `Chi_Low`, `Pon`, `Pass`. */
  action: string;
  /** Clicked or claimed tile code, when the action has one. */
  tile?: string;
  /** Index of the clicked copy in the dock's sorted display list. */
  tileIndex?: number;
  /**
   * Explicit tsumogiri flag from the dock. The dock sorts the hand, so the
   * drawn tile is not necessarily last; the click itself knows which copy it
   * was.
   */
  isTsumogiri?: boolean;
  /** Additional tiles consumed by a call (chi). */
  tiles?: string[];
  /** Optional label override; normally taken from the payload. */
  label?: string;
}

interface GradeRequest {
  table: GameState;
  answer: SubmittedAnswer;
  evaluation: AiEvaluation | null;
}

interface GameStore {
  /** Parsed table state from the WASM `generate_puzzle` payload. */
  gameState: GameState | null;
  isLoading: boolean;
  error: string | null;
  /**
   * The call whose tile pick is open, or null.
   *
   * A call is a click-to-pick step, never an armed toggle: pressing Chi, Pon,
   * Kan or Riichi opens exactly one pick, and Cancel/Escape closes it without
   * touching the hand. A call with one legal option never opens it at all.
   */
  pendingCall: PendingCall | null;
  /** Why the last pick was rejected, for the alert beside the call bar. */
  callError: string | null;
  /**
   * The hand tiles a hovered/focused call button would use, for the transient
   * raise (2026-11-21). Null when no call is being previewed.
   */
  callPreview: readonly CallCopy[] | null;

  /** The answer the player submitted, in trainer vocabulary. */
  submittedAnswer: SubmittedAnswer | null;
  /**
   * What that answer does to the table, for the 3D view's answered board
   * (261121-1206): the copies that leave the hand, the discard a call claims,
   * and the family. Presentation only — the graded `gameState` is untouched.
   */
  answeredAction: AnsweredAction | null;
  /** Dual verdict for `submittedAnswer`; null before answering. */
  dualGrade: DualGrade | null;
  /** True when the player revealed Mortal's line before answering. */
  peekedBeforeAnswer: boolean;

  /** Import/export error shown beside the position controls. */
  fileError: string | null;
  /** Non-error notice, e.g. after exporting or importing a position. */
  fileNotice: string | null;
  /**
   * Description carried by the last imported position file, shown as a card.
   * Null when the file had none (or after the card is dismissed).
   */
  positionDescription: string | null;

  /** Model weight loading state for the Mortal evaluator. */
  aiStatus: AiStatus;
  aiError: string | null;
  /**
   * Inference worker holding the Candle model; created once and reused for
   * every evaluation. Null until the weights are loaded.
   */
  mortal: MortalClient | null;
  /** Latest AI result for the current table, or null before evaluating. */
  evaluation: AiEvaluation | null;
  isEvaluating: boolean;
  /**
   * Report from the opt-in Mortal-agreement filter, when it generated this
   * hand. Null for every ordinary book-only puzzle and for imported positions.
   */
  mortalAgreement: MortalAgreementReport | null;

  /** Parse and store a raw JSON payload returned by the WASM engine. */
  loadFromJson: (json: string) => void;
  /**
   * Put a hand on screen without regenerating it, from whatever snapshot the
   * caller supplies. Back/Forward passes one stripped of its answer state
   * (`withoutAnswerState`), so the same table comes back unanswered.
   */
  restoreSnapshot: (snapshot: ScenarioSnapshot) => void;
  /**
   * Parse the `{state, agreement}` payload returned by
   * `generate_puzzle_with_agreement` and load its table.
   */
  loadFromAgreementJson: (json: string) => void;
  /**
   * Press a call button. A call with exactly one legal option is submitted
   * immediately; otherwise a tile pick opens (`pendingCall`).
   */
  beginCall: (kind: CallKind) => void;
  /** Add a hand tile to the open pick, submitting the call when it is whole. */
  pickCallTile: (tile: string, tileIndex?: number) => void;
  /** Close the open pick without answering. */
  cancelCall: () => void;
  /**
   * Raise the tiles a call button's press would use. Pointer leave, focus
   * loss, opening the pick and answering clear it.
   */
  previewCall: (kind: CallKind | null) => void;
  /** Submit the clicked hand tile as the answer (or as the open pick's tile). */
  selectTile: (tile: string, tileIndex?: number, isDraw?: boolean) => void;
  /** Submit a generic AI-scenario choice. */
  submitChoice: (choice: PlayerChoice, picks?: readonly PickedCopyLike[]) => void;
  /** Submit a non-discard action from the generic action bar. */
  submitAction: (
    action: { action: string; tile?: string | null; tiles?: string[]; label?: string },
    picks?: readonly PickedCopyLike[],
  ) => void;
  /** Grade a submitted answer against both perspectives. */
  submitAnswer: (answer: SubmittedAnswer, picks?: readonly PickedCopyLike[]) => void;
  /** Re-grade the current answer after an evaluation arrives. */
  regrade: () => void;
  /** Reveal Mortal's line before answering. */
  peekMortal: () => void;
  /**
   * Return the current hand to its unanswered state without re-dealing it.
   *
   * Clears the submitted answer, the verdict, the peek and the armed call
   * state, and supersedes any evaluation still running for the answered hand so
   * it cannot re-grade the reset table. The `GameState` object is untouched, so
   * the same hand can be answered again (and graded normally the second time).
   */
  resetAnswer: () => void;
  /** Clear the current table and answer before loading the next scenario. */
  reset: () => void;
  setError: (error: string) => void;

  /** Import a saved position (or an older report's table) from file text. */
  importState: (text: string) => Promise<void>;
  /** Show or clear an import/export error. */
  setFileError: (error: string | null) => void;
  /** Show or clear an import/export notice. */
  setFileNotice: (notice: string | null) => void;
  /** Dismiss the current import/export notice. */
  clearFileNotice: () => void;
  /** Hide the imported position's description card. */
  clearPositionDescription: () => void;

  /** Fetch the Safetensors weights and start the inference worker once. */
  initializeAi: () => Promise<void>;
  /** Evaluate the current table now (used by the AI panel's retry). */
  evaluateWithAi: () => Promise<void>;
}

interface WasmErrorPayload {
  error?: string;
}

/** Mortal's evaluation as embedded in an AI scenario's payload. */
function evaluationFromDecision(decision: AiDecision): AiEvaluation {
  return {
    model: decision.model,
    expected_value: decision.expected_value,
    recommended_action: decision.recommended_action,
    riichi_discard: decision.riichi_discard ?? null,
    evaluations: decision.evaluations,
  };
}

/**
 * Deduplicates concurrent model loads. `loadEvaluator` runs from an effect, so
 * React StrictMode can fire it twice; the model must only be parsed once.
 */
let aiInitPromise: Promise<void> | null = null;

/**
 * Parse and validate one engine payload.
 *
 * Both a fresh deal and a hand restored from browser history arrive as the same
 * `GameState` JSON, so both go through this one check and an error envelope can
 * never reach the table renderer.
 */
function parseGameState(json: string): GameState {
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
  return parsed;
}

const emptyState = {
  gameState: null,
  isLoading: true,
  error: null,
  pendingCall: null,
  callError: null,
  callPreview: null,
  submittedAnswer: null,
  answeredAction: null,
  dualGrade: null,
  peekedBeforeAnswer: false,
  evaluation: null,
  mortalAgreement: null,
  fileError: null,
  fileNotice: null,
  positionDescription: null,
} satisfies Pick<
  GameStore,
  | 'gameState'
  | 'isLoading'
  | 'error'
  | 'pendingCall'
  | 'callError'
  | 'callPreview'
  | 'submittedAnswer'
  | 'answeredAction'
  | 'dualGrade'
  | 'peekedBeforeAnswer'
  | 'evaluation'
  | 'mortalAgreement'
  | 'fileError'
  | 'fileNotice'
  | 'positionDescription'
>;

/**
 * True when this answer throws the tile just drawn, which makes the discard
 * tsumogiri. Calls and a riichi toggle alone never qualify; only an action that
 * discards the draw does.
 */
function submitsTheDraw(game: GameState, answer: SubmittedAnswer): boolean {
  const human = game.players.find((player) => player.is_human);
  if (!human?.draw) return false;

  // Fallback for callers that only know the tile code. The hand dock supplies
  // the clicked copy's `isDraw` flag instead, because it sorts the hand and the
  // draw is no longer always last.
  const clickedTheDraw =
    answer.tile_index !== undefined
      ? answer.tile_index === human.hand.length
      : answer.tile === human.draw;
  if (!clickedTheDraw) return false;

  switch (answer.action) {
    case 'riichi':
    case 'dama':
    case 'fold':
    case 'discard':
      return true;
    case 'pass':
    case 'call':
      return false;
    case 'best': {
      // A declaration discards a tile too; the drawn tile can be that discard.
      const action = answer.action_name;
      return (
        action !== undefined &&
        (action.startsWith('Discard') || action === 'Riichi')
      );
    }
    default:
      return false;
  }
}

export const useGameStore = create<GameStore>((set, get) => {
  /** One-slot queue so a puzzle swap during a forward pass is not dropped. */
  let pendingState: GameState | null = null;
  let evaluationRequestId = 0;

  /** Parse the WASM grade payload, throwing on an error envelope. */
  const parseGrade = (raw: string): DualGrade => {
    const parsed = JSON.parse(raw) as DualGrade & WasmErrorPayload;
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    return parsed;
  };

  /** Grade with the Rust dual grader; returns null and reports on failure. */
  const gradeNow = (
    table: GameState,
    answer: SubmittedAnswer,
    evaluation: AiEvaluation | null,
  ): DualGrade | null => {
    try {
      const request: GradeRequest = { table, answer, evaluation };
      return parseGrade(grade_answer_json(JSON.stringify(request)));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };

  const requestEvaluationFor = (state: GameState) => {
    if (!get().mortal) return;
    if (get().gameState !== state) return;
    if (get().isEvaluating) {
      pendingState = state;
      return;
    }
    void runEvaluation(state);
  };

  const runEvaluation = async (state: GameState) => {
    const mortal = get().mortal;
    if (!mortal) return;

    const requestId = ++evaluationRequestId;
    set({ isEvaluating: true, aiError: null });
    try {
      // Let the "Mortal is thinking" state paint while the worker starts.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      const evaluation = await mortal.evaluate(JSON.stringify(state));
      if (requestId !== evaluationRequestId) return;

      if (get().gameState !== state) {
        set({ isEvaluating: false });
        return;
      }

      set({ evaluation, isEvaluating: false });

      const answer = get().submittedAnswer;
      if (answer) {
        const grade = gradeNow(state, answer, evaluation);
        if (grade) {
          set({ dualGrade: grade });
        }
      }
    } catch (err) {
      if (requestId !== evaluationRequestId) return;
      set({
        isEvaluating: false,
        aiError: err instanceof Error ? err.message : String(err),
      });
    } finally {
      const next = pendingState;
      pendingState = null;
      if (requestId === evaluationRequestId && next && get().gameState === next) {
        requestEvaluationFor(next);
      }
    }
  };

  /**
   * Resolve an option's hand copies against the displayed hand, so a submitted
   * answer carries the click's display index and tsumogiri flag.
   */
  const pickedCopies = (
    player: GameState['players'][number],
    copies: readonly { code: string; isRed: boolean }[],
  ): PickedCopy[] => {
    const display = displayCopies(player);
    const used = new Set<number>();
    const picks: PickedCopy[] = [];
    for (const copy of copies) {
      const index = display.findIndex(
        (tile, position) =>
          !used.has(position) &&
          tile.code === copy.code &&
          tile.isRed === copy.isRed,
      );
      if (index < 0) continue;
      used.add(index);
      picks.push({
        code: copy.code,
        isRed: copy.isRed,
        index,
        isDraw: display[index].isDraw,
      });
    }
    return picks;
  };

  /**
   * Submit the hand tile a declaration or discard names.
   *
   * `declaration` is the call that owns this pick (Riichi's discard, a Kan's
   * fourth tile); null is an ordinary discard/dama/fold answer.
   */
  const submitHandTile = (
    tile: string,
    tileIndex: number | undefined,
    isDraw: boolean | undefined,
    declaration: 'riichi' | 'kan' | null,
    picked?: PickedCopyLike,
  ) => {
    const state = get();
    const game = state.gameState;
    if (!game || state.dualGrade) return;

    if (game.correct_action.type === 'best') {
      const name =
        declaration === 'riichi'
          ? 'Riichi'
          : declaration === 'kan'
            ? 'Kan'
            : `Discard_${tile}`;
      const info = findAiActionInfo(game, name, tile);
      get().submitChoice(
        {
          action: info?.action ?? name,
          tile,
          tileIndex,
          isTsumogiri: isDraw,
          tiles: info?.tiles,
          label: info?.label,
        },
        picked ? [picked] : undefined,
      );
      return;
    }

    let selectedType: CorrectActionType =
      game.correct_action.type === 'fold' ? 'fold' : 'dama';
    if (declaration === 'kan') {
      selectedType = 'kan';
    } else if (declaration === 'riichi') {
      selectedType = 'riichi';
    } else if (isKanDecision(game.correct_action)) {
      selectedType = 'discard';
    }

    const answer: SubmittedAnswer = { action: selectedType, tile };
    if (tileIndex !== undefined) {
      answer.tile_index = tileIndex;
    }
    if (isDraw !== undefined) {
      answer.is_tsumogiri = isDraw;
    } else if (submitsTheDraw(game, answer)) {
      answer.is_tsumogiri = true;
    }
    get().submitAnswer(answer, picked ? [picked] : undefined);
  };

  /** Submit the answer a completed call makes. */
  const completeCall = (
    kind: CallKind,
    option: CallOption,
    picks: PickedCopy[],
  ) => {
    const game = get().gameState;
    if (!game) return;
    const picked = picks[picks.length - 1];

    if (game.correct_action.type === 'best') {
      get().submitChoice(
        {
          action: option.action ?? callName(kind),
          tile: option.calledTile ?? picked?.code ?? '',
          tileIndex: picked?.index,
          isTsumogiri: picked?.isDraw,
          tiles: option.handTiles.map((copy) => copy.code),
        },
        picks,
      );
      return;
    }

    if (kind === 'riichi') {
      if (picked) {
        submitHandTile(picked.code, picked.index, picked.isDraw, 'riichi', picked);
      }
      return;
    }

    const offer = game.call_offer;
    if (offer) {
      get().submitAction({ action: offer.action }, picks);
      return;
    }

    if (kind === 'kan' && picked) {
      submitHandTile(picked.code, picked.index, picked.isDraw, 'kan', picked);
    }
  };

  return {
    ...emptyState,
    aiStatus: 'idle',
    aiError: null,
    mortal: null,
    isEvaluating: false,

    loadFromJson: (json) => {
      try {
        const parsed = parseGameState(json);

        // The AI scenario already carries the ranking, so seed the column from
        // it instead of paying for a second identical forward pass.
        const evaluation = parsed.ai_decision
          ? evaluationFromDecision(parsed.ai_decision)
          : null;

        set({
          gameState: parsed,
          isLoading: false,
          error: null,
          pendingCall: null,
          callError: null,
          callPreview: null,
          submittedAnswer: null,
          answeredAction: null,
          dualGrade: null,
          peekedBeforeAnswer: false,
          evaluation,
          mortalAgreement: null,
          fileError: null,
          fileNotice: null,
          // Cleared per load; `importState` sets the imported file's own text.
          positionDescription: null,
        });

        if (!evaluation) {
          requestEvaluationFor(parsed);
        }
      } catch (err) {
        set({
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
          pendingCall: null,
          callError: null,
          callPreview: null,
          submittedAnswer: null,
          answeredAction: null,
          dualGrade: null,
          peekedBeforeAnswer: false,
          evaluation: null,
          mortalAgreement: null,
          fileError: null,
          fileNotice: null,
          positionDescription: null,
        });
      }
    },

    restoreSnapshot: (snapshot) => {
      pendingState = null;
      // A history restore supersedes any evaluation still running for the hand
      // the player just left, so its late result cannot land on the new table.
      evaluationRequestId += 1;

      let parsed: GameState;
      try {
        parsed = parseGameState(snapshot.json);
      } catch (err) {
        set({
          ...emptyState,
          isLoading: false,
          isEvaluating: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // A stored evaluation is reused when the caller supplies one: it belongs
      // to this exact table, so a fresh forward pass would be slow and could
      // disagree after a model update. Back/Forward strips it instead, so a
      // restored hand starts with no evaluation of its own.
      const evaluation =
        snapshot.evaluation ??
        (parsed.ai_decision
          ? evaluationFromDecision(parsed.ai_decision)
          : null);

      set({
        gameState: parsed,
        isLoading: false,
        error: null,
        pendingCall: null,
        callError: null,
        callPreview: null,
        submittedAnswer: snapshot.submittedAnswer,
        answeredAction: snapshot.submittedAnswer
          ? answerPresentationFor(parsed, snapshot.submittedAnswer)
          : null,
        dualGrade: snapshot.dualGrade,
        peekedBeforeAnswer: snapshot.peekedBeforeAnswer,
        evaluation,
        mortalAgreement: snapshot.mortalAgreement,
        isEvaluating: false,
        fileError: null,
        fileNotice: null,
        positionDescription: snapshot.positionDescription,
      });

      if (!evaluation) {
        requestEvaluationFor(parsed);
      }
    },

    loadFromAgreementJson: (json) => {
      let payload;
      try {
        payload = parseAgreementPayload(json);
      } catch (err) {
        set({
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
          pendingCall: null,
          callError: null,
          callPreview: null,
          submittedAnswer: null,
          answeredAction: null,
          dualGrade: null,
          peekedBeforeAnswer: false,
          evaluation: null,
          mortalAgreement: null,
          fileError: null,
          fileNotice: null,
          positionDescription: null,
        });
        return;
      }

      // `loadFromJson` owns the table validation and the payload's own error
      // handling; the report is attached only once the table is accepted.
      get().loadFromJson(payload.stateJson);
      if (get().error) return;
      set({ mortalAgreement: payload.report });
    },

    beginCall: (kind) => {
      const state = get();
      const game = state.gameState;
      if (!game || state.dualGrade) return;
      const human = game.players.find((player) => player.is_human);
      if (!human) return;

      const context = callContextFor(game);
      if (!callButtonsFor(game, human, context).calls.some((call) => call.kind === kind)) {
        return;
      }
      if (state.pendingCall) {
        set({ pendingCall: null, callError: null });
      }
      // Opening a call lowers the hover preview; the pick's own selected tiles
      // are what rise next.
      set({ callPreview: null });

      if (kind === 'riichi') {
        // Rust lists the legal declaration discards. One distinct copy is not
        // a choice: the button press is the whole interaction. More than one
        // (including a red/plain five of the same tile) opens the pick, whose
        // options are the engine's list, so a tenpai-breaking discard cannot be
        // chosen at all. A test double (or an older Wasm package) that cannot
        // answer falls back to any tile and leaves the grading to the engine.
        let legal: string[] = [];
        try {
          legal = riichiDiscardTiles(JSON.stringify(game)) ?? [];
        } catch {
          legal = [];
        }

        const display = displayCopies(human);
        const options: CallOption[] = [];
        for (const code of legal) {
          const seenRed = new Set<boolean>();
          for (const tile of display) {
            if (tile.code !== code || seenRed.has(tile.isRed)) continue;
            seenRed.add(tile.isRed);
            options.push({
              kind: 'riichi',
              calledTile: null,
              handTiles: [{ code: tile.code, isRed: tile.isRed }],
            });
          }
        }

        if (options.length === 1) {
          completeCall('riichi', options[0], pickedCopies(human, options[0].handTiles));
          return;
        }
        set({
          pendingCall: {
            kind: 'riichi',
            need: 1,
            picks: [],
            options,
            anyTile: legal.length === 0,
          },
          callError: null,
        });
        return;
      }

      const options = callOptionsFor(game, human, context, kind);
      if (options.length === 0) {
        set({ callError: 'That call is not available here.', pendingCall: null });
        return;
      }
      if (options.length === 1) {
        const option = options[0];
        completeCall(kind, option, pickedCopies(human, option.handTiles));
        return;
      }

      set({
        pendingCall: {
          kind,
          need: kind === 'chi' ? 2 : 1,
          picks: [],
          options,
          anyTile: false,
        },
        callError: null,
      });
    },

    pickCallTile: (tile, tileIndex) => {
      const state = get();
      const pending = state.pendingCall;
      const game = state.gameState;
      if (!pending || !game || state.dualGrade) return;
      const human = game.players.find((player) => player.is_human);
      if (!human) return;

      const display = displayCopies(human);
      const index =
        tileIndex ?? display.findIndex((candidate) => candidate.code === tile);
      const candidate = display[index];
      if (!candidate || candidate.code !== tile) {
        set({ callError: 'That is not one of your hand tiles.' });
        return;
      }

      const copy = { code: candidate.code, isRed: candidate.isRed };
      if (!isSelectableCopy(pending, copy)) {
        set({
          callError:
            pending.kind === 'riichi'
              ? 'That tile cannot be discarded for Riichi.'
              : `That tile cannot be used for this ${callName(pending.kind)}.`,
        });
        return;
      }

      /*
       * Selection is a toggle. Clicking a raised tile lowers it; clicking a new
       * tile raises it, and once more than `need` are raised only the most
       * recent `need` stay up. A set that makes the call submits at once.
       */
      const already = pending.picks.findIndex(
        (pick) => pick.code === copy.code && pick.isRed === copy.isRed,
      );
      if (already >= 0) {
        const picks = pending.picks.filter((_, position) => position !== already);
        set({ pendingCall: { ...pending, picks }, callError: null });
        return;
      }

      const picked: PickedCopy = {
        code: candidate.code,
        isRed: candidate.isRed,
        index,
        isDraw: candidate.isDraw,
      };
      const next = [...pending.picks, picked];
      let picks =
        next.length > pending.need ? next.slice(next.length - pending.need) : next;

      /*
       * Keep the newest tile and only the raised tiles that can share a call
       * with it. A tile that cannot join the current selection replaces it
       * (user request 2026-11-21), rather than leaving an impossible pair up.
       */
      if (picks.length > 1 && !sharesCall(pending.options, picks)) {
        picks = [picks[picks.length - 1]];
      }

      if (picks.length === pending.need) {
        const option = callOptionForPicks(pending, picks);
        if (option) {
          set({ pendingCall: null, callError: null });
          completeCall(pending.kind, option, picks);
          return;
        }
        // A full set that is not the call yet stays raised; the next click
        // replaces its oldest tile.
        set({
          pendingCall: { ...pending, picks },
          callError: `Those tiles do not make a ${callName(pending.kind)}.`,
        });
        return;
      }

      set({ pendingCall: { ...pending, picks }, callError: null });
    },

    cancelCall: () =>
      set({ pendingCall: null, callError: null, callPreview: null }),

    previewCall: (kind) => {
      const state = get();
      const game = state.gameState;
      if (!kind || !game || state.dualGrade || state.pendingCall) {
        set({ callPreview: null });
        return;
      }
      const human = game.players.find((player) => player.is_human);
      if (!human) {
        set({ callPreview: null });
        return;
      }

      const context = callContextFor(game);
      if (
        !callButtonsFor(game, human, context).calls.some(
          (call) => call.kind === kind,
        )
      ) {
        set({ callPreview: null });
        return;
      }

      if (kind === 'riichi') {
        let legal: string[] = [];
        try {
          legal = riichiDiscardTiles(JSON.stringify(game)) ?? [];
        } catch {
          legal = [];
        }
        const display = displayCopies(human).filter(
          (tile) => legal.length === 0 || legal.includes(tile.code),
        );
        const seen = new Set<string>();
        const copies: CallCopy[] = [];
        for (const tile of display) {
          const key = `${tile.code}|${tile.isRed}`;
          if (seen.has(key)) continue;
          seen.add(key);
          copies.push({ code: tile.code, isRed: tile.isRed });
        }
        set({ callPreview: copies });
        return;
      }

      set({
        callPreview: previewCopiesFor(
          callOptionsFor(game, human, context, kind),
        ),
      });
    },

    selectTile: (tile, tileIndex, isDraw) => {
      const state = get();
      const game = state.gameState;
      if (!game || state.dualGrade) return;

      // A pick step owns the hand: a tile click collects the call's tiles
      // instead of answering.
      if (state.pendingCall) {
        get().pickCallTile(tile, tileIndex);
        return;
      }

      // A book call lesson answers with its call/Pass buttons, never a tile.
      if (isCallDecision(game)) return;

      submitHandTile(tile, tileIndex, isDraw, null);
    },

    submitChoice: (choice, picks) => {
      const game = get().gameState;
      if (!game || game.correct_action.type !== 'best' || get().dualGrade) return;

      const answer: SubmittedAnswer = {
        action: 'best',
        tile: choice.tile ?? '',
      };
      if (choice.action) {
        answer.action_name = choice.action;
      }
      if (choice.tileIndex !== undefined) {
        answer.tile_index = choice.tileIndex;
      }
      if (choice.isTsumogiri !== undefined) {
        answer.is_tsumogiri = choice.isTsumogiri;
      } else if (submitsTheDraw(game, answer)) {
        answer.is_tsumogiri = true;
      }
      get().submitAnswer(answer, picks);
    },

    submitAction: (action, picks) => {
      if (action.action === 'Riichi') {
        get().beginCall('riichi');
        return;
      }

      // A book call lesson answers `pass` or `call`; the offered call's name
      // (`Pon`/`Chi`) rides along so the report can name what was declined or
      // taken. A Kan is graded on its tile, so the offer's tile travels with the
      // answer. The engine grades all three against the state's
      // `correct_action`.
      const game = get().gameState;
      if (game && isCallDecision(game)) {
        const isPass = action.action === 'Pass';
        const isKan = action.action === 'Kan';
        const answer: SubmittedAnswer = {
          action: isPass ? 'pass' : isKan ? 'kan' : 'call',
          tile: isKan ? (game.call_offer?.tile ?? '') : '',
        };
        if (!isPass && !isKan) {
          answer.action_name = action.action;
        }
        get().submitAnswer(answer, picks);
        return;
      }

      get().submitChoice(
        {
          action: action.action,
          tile: action.tile ?? undefined,
          tiles: action.tiles,
          label: action.label,
        },
        picks,
      );
    },

    submitAnswer: (answer, picks) => {
      const { gameState, evaluation } = get();
      if (!gameState || get().dualGrade) return;

      const grade = gradeNow(gameState, answer, evaluation);
      if (!grade) return;

      set({
        submittedAnswer: answer,
        answeredAction: answerPresentationFor(gameState, answer, picks),
        dualGrade: grade,
        callPreview: null,
      });
    },

    regrade: () => {
      const { gameState, submittedAnswer, evaluation } = get();
      if (!gameState || !submittedAnswer) return;
      const grade = gradeNow(gameState, submittedAnswer, evaluation);
      if (grade) {
        set({ dualGrade: grade });
      }
    },

    peekMortal: () => set({ peekedBeforeAnswer: true }),

    resetAnswer: () => {
      const { gameState } = get();
      if (!gameState) return;

      /*
       * Supersede the evaluation still running for the answered hand. Its late
       * result must not populate the reset table's Mortal column or re-grade it;
       * the fresh request below gets a new id and owns the state from here.
       */
      evaluationRequestId += 1;
      pendingState = null;

      /*
       * An AI drill's ranking is part of the hand (`ai_decision`), not of the
       * answer, so it is re-seeded as-is. A book lesson drops the evaluation it
       * had and asks Mortal again for the same table: the reset hand starts with
       * no evaluation of its own, exactly as when it was first dealt.
       */
      const evaluation = gameState.ai_decision
        ? evaluationFromDecision(gameState.ai_decision)
        : null;

      set({
        submittedAnswer: null,
        answeredAction: null,
        dualGrade: null,
        peekedBeforeAnswer: false,
        // A call pick cannot outlive the answer it belonged to.
        pendingCall: null,
        callError: null,
        callPreview: null,
        evaluation,
        isEvaluating: false,
      });

      if (!evaluation) {
        requestEvaluationFor(gameState);
      }
    },

    reset: () => {
      pendingState = null;
      evaluationRequestId += 1;
      set({ ...emptyState, isEvaluating: false });
    },

    setError: (error) => {
      pendingState = null;
      evaluationRequestId += 1;
      set({
        isLoading: false,
        error,
        pendingCall: null,
        callError: null,
        callPreview: null,
        submittedAnswer: null,
        answeredAction: null,
        dualGrade: null,
        peekedBeforeAnswer: false,
        evaluation: null,
        isEvaluating: false,
        fileError: null,
        fileNotice: null,
        positionDescription: null,
      });
    },

    importState: async (text) => {
      try {
        await ensureWasmReady();
        const imported = parseStateFile(text);

        get().loadFromJson(imported.json);
        if (get().error) return;

        set({
          fileError: null,
          fileNotice: imported.fromReport
            ? 'Loaded the position from a scenario-report file.'
            : 'Position loaded.',
          positionDescription: imported.description,
        });
      } catch (err) {
        set({
          fileError: err instanceof Error ? err.message : String(err),
          fileNotice: null,
        });
      }
    },

    setFileError: (fileError) =>
      set(fileError ? { fileError, fileNotice: null } : { fileError }),

    setFileNotice: (fileNotice) => set({ fileNotice }),

    clearFileNotice: () => set({ fileNotice: null }),

    clearPositionDescription: () => set({ positionDescription: null }),

    initializeAi: () => {
      if (aiInitPromise) return aiInitPromise;
      if (get().aiStatus === 'ready' || get().aiStatus === 'loading') {
        return Promise.resolve();
      }

      aiInitPromise = (async () => {
        set({ aiStatus: 'loading', aiError: null });
        try {
          await ensureWasmReady();

          // Resolves from IndexedDB when cached, otherwise downloads from the
          // external CDN. See services/weightLoader.ts and hosting-plan.md.
          const bytes = await loadWeights();

          // The worker instantiates its own WASM copy and parses the 43 MB
          // checkpoint off the UI thread, so this await does not block input.
          const mortal = await initMortalClient(bytes, WEIGHTS_FILENAME);
          set({ mortal, aiStatus: 'ready', aiError: null });

          const state = get().gameState;
          if (state && !get().evaluation) {
            requestEvaluationFor(state);
          }
        } catch (err) {
          aiInitPromise = null; // allow a retry from the UI
          set({
            mortal: null,
            aiStatus: 'error',
            aiError: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      return aiInitPromise;
    },

    evaluateWithAi: async () => {
      const state = get().gameState;
      if (!state || get().isEvaluating || !get().mortal) return;
      await runEvaluation(state);
    },
  };
});
