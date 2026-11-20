import { useEffect, useRef, useState } from 'react';
import {
  hotseatDraft,
  hotseatDraftSummary,
  hotseatOptionsFromDraft,
  HOTSEAT_DISPARITIES,
  HOTSEAT_ROUNDS,
  HOTSEAT_SEATS,
} from '../hotseat';
import type {
  HotseatDisparity,
  HotseatDraft,
  HotseatOptions,
  HotseatRound,
  HotseatSeat,
} from '../hotseat';

const TITLE_ID = 'hotseat-card-title';

/**
 * The AI Hotseat generation form, without the modal wrapper (3D-H4).
 *
 * The 2D header opens this in its own dialog (`HotseatCard`); the 3D setup
 * sheet hosts the same body inside its one sheet, because a second scrim over
 * the scene would be a second modal (`3d_hud.md` §6.1, row 23). Everything the
 * card decides — the three pinned/random rows, the live summary and the
 * generate/cancel pair — lives here, so the two hosts cannot drift.
 *
 * `titleId` and `titleAs` let the host own the heading's level and the dialog's
 * `aria-labelledby`: an h2 in the standalone card, an h3 inside the sheet.
 */
export interface HotseatCardBodyProps {
  /** The last card choice, reused when the card is opened again. */
  initialOptions: HotseatOptions;
  /** Disables the deal while a generated hand is loading. */
  busy?: boolean;
  onGenerate: (options: HotseatOptions) => void;
  onCancel: () => void;
  /** The heading's id, for the host's `aria-labelledby`/`aria-describedby`. */
  titleId: string;
  /** The heading's level in the host's outline; defaults to `h2`. */
  titleAs?: 'h2' | 'h3';
}

export function HotseatCardBody({
  initialOptions,
  busy = false,
  onGenerate,
  onCancel,
  titleId,
  titleAs = 'h2',
}: HotseatCardBodyProps) {
  const [draft, setDraft] = useState<HotseatDraft>(() =>
    hotseatDraft(initialOptions),
  );
  const Heading = titleAs;

  const roundSummary = HOTSEAT_ROUNDS.find(
    (round) => round.value === draft.round.value,
  )?.label;
  const disparitySummary = HOTSEAT_DISPARITIES.find(
    (disparity) => disparity.value === draft.disparity.value,
  );
  const seatSummary = HOTSEAT_SEATS.find(
    (seat) => seat.value === draft.seat.value,
  )?.label;

  const toggleRoundRandom = (random: boolean) =>
    setDraft((previous) => ({
      ...previous,
      round: { ...previous.round, random },
    }));
  const toggleDisparityRandom = (random: boolean) =>
    setDraft((previous) => ({
      ...previous,
      disparity: { ...previous.disparity, random },
    }));
  const toggleSeatRandom = (random: boolean) =>
    setDraft((previous) => ({
      ...previous,
      seat: { ...previous.seat, random },
    }));

  const setRound = (value: HotseatRound) =>
    setDraft((previous) => ({
      ...previous,
      round: { random: false, value },
    }));
  const setDisparity = (value: HotseatDisparity) =>
    setDraft((previous) => ({
      ...previous,
      disparity: { random: false, value },
    }));
  const setSeat = (value: HotseatSeat) =>
    setDraft((previous) => ({
      ...previous,
      seat: { random: false, value },
    }));

  return (
    <>
      <header className="hotseat-card-head">
        <Heading className="hotseat-card-title" id={titleId}>
          AI Hotseat self-play
        </Heading>
        <p className="hotseat-card-hint">
          Mortal plays all four seats of a full round. You take over your seat
          at one of its decisions that actually happened, and Mortal's own
          choice there is the answer. Pin any starting condition, or leave it
          random.
        </p>
      </header>

      <div className="hotseat-card-rows">
        <fieldset className="hotseat-row">
          <legend className="hotseat-row-label">Round</legend>
          <label className="hotseat-random">
            <input
              type="checkbox"
              checked={draft.round.random}
              onChange={(event) => toggleRoundRandom(event.target.checked)}
            />
            <span>Random</span>
          </label>
          <select
            className="hotseat-select"
            aria-label="Round"
            value={draft.round.value}
            disabled={draft.round.random}
            onChange={(event) => setRound(event.target.value as HotseatRound)}
          >
            {HOTSEAT_ROUNDS.map((round) => (
              <option value={round.value} key={round.value}>
                {round.label}
              </option>
            ))}
          </select>
          <span className="hotseat-row-note">
            {draft.round.random ? 'Drawn by the engine.' : roundSummary}
          </span>
        </fieldset>

        <fieldset className="hotseat-row">
          <legend className="hotseat-row-label">Point disparity</legend>
          <label className="hotseat-random">
            <input
              type="checkbox"
              checked={draft.disparity.random}
              onChange={(event) =>
                toggleDisparityRandom(event.target.checked)
              }
            />
            <span>Random</span>
          </label>
          <select
            className="hotseat-select"
            aria-label="Point disparity"
            value={draft.disparity.value}
            disabled={draft.disparity.random}
            onChange={(event) =>
              setDisparity(event.target.value as HotseatDisparity)
            }
          >
            {HOTSEAT_DISPARITIES.map((disparity) => (
              <option value={disparity.value} key={disparity.value}>
                {disparity.label}
              </option>
            ))}
          </select>
          <span className="hotseat-row-note">
            {draft.disparity.random
              ? 'Drawn by the engine.'
              : disparitySummary?.hint}
          </span>
        </fieldset>

        <fieldset className="hotseat-row">
          <legend className="hotseat-row-label">Your seat</legend>
          <label className="hotseat-random">
            <input
              type="checkbox"
              checked={draft.seat.random}
              onChange={(event) => toggleSeatRandom(event.target.checked)}
            />
            <span>Random</span>
          </label>
          <select
            className="hotseat-select"
            aria-label="Your seat"
            value={draft.seat.value}
            disabled={draft.seat.random}
            onChange={(event) => setSeat(event.target.value as HotseatSeat)}
          >
            {HOTSEAT_SEATS.map((seat) => (
              <option value={seat.value} key={seat.value}>
                {seat.label}
              </option>
            ))}
          </select>
          <span className="hotseat-row-note">
            {draft.seat.random ? 'Drawn by the engine.' : seatSummary}
          </span>
        </fieldset>
      </div>

      <footer className="hotseat-card-footer">
        <span className="hotseat-card-summary" aria-live="polite">
          {hotseatDraftSummary(draft)}
        </span>
        <div className="hotseat-card-actions">
          <button
            type="button"
            className="hotseat-cancel"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="hotseat-generate"
            onClick={() => onGenerate(hotseatOptionsFromDraft(draft))}
            disabled={busy}
          >
            {busy ? 'Playing…' : 'Play the round'}
          </button>
        </div>
      </footer>
    </>
  );
}

interface HotseatCardProps {
  /** The last card choice, reused when the card is opened again. */
  initialOptions: HotseatOptions;
  /** Disables the deal while a generated hand is loading. */
  busy?: boolean;
  onGenerate: (options: HotseatOptions) => void;
  onCancel: () => void;
}

/**
 * The AI Hotseat generation card.
 *
 * The scenario's whole point is choosing the starting conditions before a
 * round is played, so this card opens before any generation happens. Every row
 * is either pinned to a value or left to the engine; ticking "Random" clears
 * the pinned value, and the generated state reports the conditions it actually
 * used. This is the 2D modal host; the body is shared with the 3D setup sheet.
 */
export function HotseatCard({
  initialOptions,
  busy = false,
  onGenerate,
  onCancel,
}: HotseatCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div
      className="hotseat-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="hotseat-card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
      >
        <HotseatCardBody
          initialOptions={initialOptions}
          busy={busy}
          onGenerate={onGenerate}
          onCancel={onCancel}
          titleId={TITLE_ID}
        />
      </div>
    </div>
  );
}
