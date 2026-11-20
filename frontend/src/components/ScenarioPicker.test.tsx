// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_SCENARIOS, mergePackLessons, packScenarioId } from '../scenarios';
import type { BookSection, ScenarioOption, ScenarioSelection } from '../scenarios';
import type { PackManifest } from '../services/packLoader';
import { ScenarioPicker } from './ScenarioPicker';

const chapter8Book: BookSection = {
  chapter: 8,
  chapter_title: 'Defense judgement',
  section: 1,
  section_title: 'To push or to fold?',
  key: 'ch8.1',
  label: 'ch8.1 · To push or to fold?',
};

function generated(
  id: string,
  label: string,
  extra: Partial<ScenarioOption> = {},
): ScenarioOption {
  return {
    id,
    label,
    description: `${label} description`,
    category: 'defense_decision',
    tags: ['defense'],
    requires_ai: false,
    grading: 'book_and_mortal',
    book: chapter8Book,
    ...extra,
  };
}

const fold = generated('fold_to_riichi', 'Fold to Riichi');
const ryanmen = generated('ryanmen_protorun', 'Ryanmen Protorun', {
  book: {
    ...chapter8Book,
    chapter: 4,
    section: 1,
    key: 'ch4.1',
    label: 'ch4.1 · Finding a redundant tile',
  },
});
const hotseat = generated('ai_hotseat', 'AI Hotseat', {
  book: null,
  tags: ['ai'],
  requires_ai: true,
  grading: 'mortal_only',
});

const manifest: PackManifest = {
  schema: 'riichiprac.scenario-pack-manifest',
  version: 1,
  updated_at: '2026-11-17T00:00:00Z',
  packs: [
    {
      id: 'replay.fixture.2026-11',
      path: 'replay.fixture.2026-11-8aa259ff85d4.json.gz',
      sha256: '8aa259ff85d470e434226beed84acd3d5cbe2d0864ab1e6b46148a802c8a2fcb',
      bytes: 3572,
      scenario_count: 2,
      lesson_ids: ['fold_to_riichi'],
      book_sections: ['ch8.1'],
      licence: 'CC-BY-4.0',
      requires_model: true,
      data_commercial_use: true,
    },
  ],
};

const catalogue = mergePackLessons([fold, ryanmen, hotseat], manifest);
const replayFold = packScenarioId('replay.fixture.2026-11', 'fold_to_riichi');

/** The same manifest with 731 reviewed bases for fold_to_riichi (RF1 counts). */
const coveredManifest: PackManifest = {
  ...manifest,
  packs: [
    {
      ...manifest.packs[0],
      lesson_counts: { fold_to_riichi: 731 },
    },
  ],
};
const coveredCatalogue = mergePackLessons(
  [fold, ryanmen, hotseat],
  coveredManifest,
);

afterEach(() => {
  cleanup();
});

interface PickerProps {
  scenarios?: ScenarioOption[];
  selection?: ScenarioSelection;
  packStatus?: 'loading' | 'ready' | 'empty' | 'error';
  packCount?: number;
  packError?: string | null;
  preferReplay?: boolean;
}

function renderPicker({
  scenarios = catalogue,
  selection = ALL_SCENARIOS,
  packStatus = 'ready',
  packCount = 1,
  packError = null,
  preferReplay = true,
}: PickerProps = {}) {
  const onChange = vi.fn();
  const onConfigureHotseat = vi.fn();
  const onPreferReplayChange = vi.fn();
  render(
    <ScenarioPicker
      scenarios={scenarios}
      selection={selection}
      onChange={onChange}
      onConfigureHotseat={onConfigureHotseat}
      packStatus={packStatus}
      packCount={packCount}
      packError={packError}
      preferReplay={preferReplay}
      onPreferReplayChange={onPreferReplayChange}
    />,
  );
  return { onChange, onConfigureHotseat, onPreferReplayChange };
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByTitle(
      'Choose one lesson, all scenarios, or a pool to randomise between',
    ),
  );
  return screen.getByRole('dialog', { name: 'Scenario pool' });
}

describe('ScenarioPicker ARIA parity', () => {
  it('labels the trigger and wires it to the dialog', async () => {
    const user = userEvent.setup();
    renderPicker();

    const trigger = screen.getByRole('button', { name: /All scenarios/i });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-controls')).toBeNull();

    const panel = await openPanel(user);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-label')).toBe('Scenario pool');
  });

  it('keeps every lesson a checkbox with its section as an accessible group toggle', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPanel(user);

    for (const option of catalogue) {
      expect(
        screen.getAllByRole('checkbox', {
          name: new RegExp(option.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        }).length,
      ).toBeGreaterThan(0);
    }
    expect(
      screen.getByRole('checkbox', { name: /Select all in ch8\.1/i }),
    ).toBeTruthy();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderPicker();
    const trigger = screen.getByRole('button', { name: /All scenarios/i });
    await openPanel(user);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('replay pack entries', () => {
  it('shows a replay entry with a PACK badge and the merged label', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPanel(user);

    const box = screen.getByRole('checkbox', {
      name: /fold to riichi \(replay\)/i,
    });
    expect((box as HTMLInputElement).checked).toBe(false);
    const row = box.closest('li');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('PACK')).toBeTruthy();
  });

  it('deals exactly the replay lesson from its Only button', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();
    await openPanel(user);

    const box = screen.getByRole('checkbox', {
      name: /fold to riichi \(replay\)/i,
    });
    const row = box.closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Only' }));

    expect(onChange).toHaveBeenCalledWith({
      kind: 'selected',
      ids: [replayFold],
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opts a replay lesson into a pool without dropping the rest', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();
    await openPanel(user);

    await user.click(
      screen.getByRole('checkbox', { name: /fold to riichi \(replay\)/i }),
    );
    await user.click(screen.getByRole('button', { name: /Deal from pool/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const selection = onChange.mock.calls[0][0] as ScenarioSelection;
    expect(selection.kind).toBe('selected');
    expect(selection.kind === 'selected' && selection.ids).toContain(replayFold);
    expect(selection.kind === 'selected' && selection.ids).toContain(
      'fold_to_riichi',
    );
  });

  it('stages the checkboxes and only deals the draft', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({
      selection: { kind: 'selected', ids: ['fold_to_riichi'] },
    });
    await openPanel(user);

    // Cancel discards a staged tick.
    await user.click(
      screen.getByRole('checkbox', { name: /fold to riichi \(replay\)/i }),
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onChange).not.toHaveBeenCalled();

    // Re-opening starts from the committed pool, not the cancelled draft.
    await openPanel(user);
    const box = screen.getByRole('checkbox', {
      name: /fold to riichi \(replay\)/i,
    });
    expect((box as HTMLInputElement).checked).toBe(false);
  });

  it('keeps the AI badge for evaluator drills', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPanel(user);

    const aiRow = screen
      .getByRole('checkbox', { name: /AI Hotseat/i })
      .closest('li') as HTMLElement;
    expect(within(aiRow).getByText('AI')).toBeTruthy();
    expect(within(aiRow).queryByText('PACK')).toBeNull();
  });
});

describe('source filter and generated opt-in', () => {
  it('offers Replay, Generated and Both as one labelled radio group', async () => {
    const user = userEvent.setup();
    renderPicker();
    const panel = await openPanel(user);

    const group = within(panel).getByRole('group', { name: 'Source' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('value'))).toEqual([
      'replay',
      'generated',
      'both',
    ]);
    expect((within(group).getByRole('radio', { name: 'Both' }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('opens on Generated for a stored preferReplay of false', async () => {
    const user = userEvent.setup();
    renderPicker({ scenarios: coveredCatalogue, preferReplay: false });
    const panel = await openPanel(user);

    expect(
      (within(panel).getByRole('radio', { name: 'Generated' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    // The filter agrees with the pool: All now stands for the generated lesson.
    const generatedBox = screen.getByRole('checkbox', {
      name: /fold to riichi generated/i,
    }) as HTMLInputElement;
    expect(generatedBox.checked).toBe(true);
  });

  it('leads a covered lesson with its replay row and badges the generated alternative', async () => {
    const user = userEvent.setup();
    renderPicker({ scenarios: coveredCatalogue });
    await openPanel(user);

    const replayRow = screen
      .getByRole('checkbox', { name: /fold to riichi \(replay\)/i })
      .closest('li') as HTMLElement;
    const generatedRow = screen
      .getByRole('checkbox', { name: /fold to riichi generated/i })
      .closest('li') as HTMLElement;

    expect(within(replayRow).getByText('PACK')).toBeTruthy();
    expect(within(generatedRow).getByText('GENERATED')).toBeTruthy();
    expect(
      replayRow.compareDocumentPosition(generatedRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The replay position is what All stands for; the generated row is opt-in.
    expect(
      (within(replayRow).getByRole('checkbox') as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(generatedRow).getByRole('checkbox') as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('leaves an uncovered lesson generated-first without a badge', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPanel(user);

    const generatedRow = screen
      .getByRole('checkbox', { name: /^fold to riichi$/i })
      .closest('li') as HTMLElement;
    const replayRow = screen
      .getByRole('checkbox', { name: /fold to riichi \(replay\)/i })
      .closest('li') as HTMLElement;
    expect(within(generatedRow).queryByText('GENERATED')).toBeNull();
    expect(
      generatedRow.compareDocumentPosition(replayRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('deals exactly the generated lesson from its opt-in row', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ scenarios: coveredCatalogue });
    await openPanel(user);

    const generatedRow = screen
      .getByRole('checkbox', { name: /fold to riichi generated/i })
      .closest('li') as HTMLElement;
    await user.click(within(generatedRow).getByRole('button', { name: 'Only' }));

    expect(onChange).toHaveBeenCalledWith({
      kind: 'selected',
      ids: ['fold_to_riichi'],
    });
  });

  it('Generated hides replay rows and switches the default pool', async () => {
    const user = userEvent.setup();
    const { onPreferReplayChange } = renderPicker({
      scenarios: coveredCatalogue,
    });
    const panel = await openPanel(user);

    await user.click(within(panel).getByRole('radio', { name: 'Generated' }));
    expect(onPreferReplayChange).toHaveBeenLastCalledWith(false);
    expect(
      screen.queryAllByRole('checkbox', { name: /\(replay\)/i }),
    ).toHaveLength(0);
    expect(
      screen.getByRole('checkbox', { name: /fold to riichi generated/i }),
    ).toBeTruthy();
  });

  it('Replay hides covered generated rows but keeps replay-less lessons', async () => {
    const user = userEvent.setup();
    const { onPreferReplayChange } = renderPicker({
      scenarios: coveredCatalogue,
    });
    const panel = await openPanel(user);

    await user.click(within(panel).getByRole('radio', { name: 'Replay' }));
    expect(onPreferReplayChange).toHaveBeenLastCalledWith(true);
    expect(
      screen.queryAllByRole('checkbox', { name: /fold to riichi generated/i }),
    ).toHaveLength(0);
    expect(
      screen.getByRole('checkbox', { name: /fold to riichi \(replay\)/i }),
    ).toBeTruthy();
    // AI Hotseat has no replay row and must stay reachable.
    expect(
      screen.getByRole('checkbox', { name: /AI Hotseat/i }),
    ).toBeTruthy();
  });

  it('keeps the filter and a generated tick across a selection change', async () => {
    const user = userEvent.setup();
    renderPicker({ scenarios: coveredCatalogue });
    const panel = await openPanel(user);

    // All holds the five replay-first defaults; the generated pick makes six.
    await user.click(
      screen.getByRole('checkbox', { name: /fold to riichi generated/i }),
    );
    // All stands for the three replay-first defaults; the generated pick is 4.
    expect(within(panel).getByText(/Pool: 4 scenarios/)).toBeTruthy();

    await user.click(within(panel).getByRole('radio', { name: 'Replay' }));
    expect(
      (
        within(panel).getByRole('radio', { name: 'Replay' }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    // The tick survives even though its row is filtered out.
    expect(within(panel).getByText(/Pool: 4 scenarios/)).toBeTruthy();

    await user.click(within(panel).getByRole('radio', { name: 'Both' }));
    expect(
      (
        screen.getByRole('checkbox', {
          name: /fold to riichi generated/i,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it('keeps the chosen filter after dealing a generated lesson', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ scenarios: coveredCatalogue });
    await openPanel(user);

    await user.click(screen.getByRole('radio', { name: 'Generated' }));
    const generatedRow = screen
      .getByRole('checkbox', { name: /fold to riichi generated/i })
      .closest('li') as HTMLElement;
    await user.click(within(generatedRow).getByRole('button', { name: 'Only' }));
    expect(onChange).toHaveBeenCalledWith({
      kind: 'selected',
      ids: ['fold_to_riichi'],
    });

    const panel = await openPanel(user);
    expect(
      (within(panel).getByRole('radio', { name: 'Generated' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it('tabs through the source filter before the All checkbox', async () => {
    const user = userEvent.setup();
    renderPicker();
    const trigger = screen.getByRole('button', { name: /All scenarios/i });
    await openPanel(user);
    expect(document.activeElement).toBe(trigger);

    await user.tab();
    expect((document.activeElement as HTMLElement).getAttribute('name')).toBe(
      'scenario-source-filter',
    );

    const allBox = screen.getByRole('checkbox', { name: /All scenarios/i });
    for (let step = 0; step < 5 && document.activeElement !== allBox; step += 1) {
      await user.tab();
    }
    expect(document.activeElement).toBe(allBox);
  });
});

describe('pack manifest states', () => {
  it('announces the loading state', async () => {
    const user = userEvent.setup();
    renderPicker({ packStatus: 'loading' });
    const panel = await openPanel(user);
    expect(within(panel).getByRole('status').textContent).toBe(
      'Loading replay packs…',
    );
  });

  it('announces an empty manifest without breaking the generated pool', async () => {
    const user = userEvent.setup();
    renderPicker({ packStatus: 'empty', packCount: 0 });
    const panel = await openPanel(user);
    expect(within(panel).getByRole('status').textContent).toBe(
      'No replay packs are published yet, so every lesson stays generated.',
    );
    expect(screen.getByRole('button', { name: /Deal from pool/i })).toBeTruthy();
  });

  it('announces a manifest error with its message', async () => {
    const user = userEvent.setup();
    renderPicker({
      packStatus: 'error',
      packCount: 0,
      packError: 'The replay pack manifest answered HTTP 404.',
    });
    const panel = await openPanel(user);
    expect(within(panel).getByRole('status').textContent).toContain(
      'Replay packs unavailable: The replay pack manifest answered HTTP 404.',
    );
  });

  it('explains that replay is the default for a covered lesson', async () => {
    const user = userEvent.setup();
    renderPicker({ packStatus: 'ready', packCount: 1 });
    const panel = await openPanel(user);
    const note = within(panel).getByRole('status').textContent ?? '';
    expect(note).toContain('PACK rows deal a real audited replay hand');
    expect(note).toContain('GENERATED rows drill the same lesson');
    expect(note).toContain('Replay is the default where a lesson has enough');
    expect(note).toContain('not the ticks you already made');
  });

  it('appends a body failure after the ready note', async () => {
    const user = userEvent.setup();
    renderPicker({
      packStatus: 'ready',
      packCount: 1,
      packError: 'dealing the generated lesson instead.',
    });
    const panel = await openPanel(user);
    expect(within(panel).getByRole('status').textContent).toContain(
      'dealing the generated lesson instead.',
    );
  });
});
