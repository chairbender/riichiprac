import { describe, expect, it } from 'vitest';
import type { BookGrade, MortalGrade } from './verdict';
import {
  acceptedAlternativeNote,
  bookAcceptedTiles,
  formatAcceptedTiles,
} from './verdict';

function book(overrides: Partial<BookGrade> = {}): BookGrade {
  return {
    is_action_correct: true,
    is_tile_correct: true,
    expected_action: 'dama',
    expected_tile: '5p',
    ...overrides,
  };
}

function mortal(overrides: Partial<MortalGrade> = {}): MortalGrade {
  return {
    model: 'mortal_298k.safetensors',
    recommended_action: 'Discard_3p',
    recommended_base: 'Discard_3p',
    recommended_label: 'Discard 3p',
    recommended_riichi: false,
    recommended_discard: null,
    answer_action: 'Discard_5p',
    matches_action: false,
    matches_tile: false,
    agrees: false,
    answer_probability: 0.1,
    top_probability: 0.6,
    confidence: 'high',
    close_second: false,
    ...overrides,
  };
}

const tiedBook = book({ expected_tiles: ['5p', '3p'] });

describe('bookAcceptedTiles', () => {
  it('lists the one accepted tile for a single-answer scenario', () => {
    expect(bookAcceptedTiles(book({ expected_tiles: ['5p'] }))).toEqual(['5p']);
  });

  it('falls back to expected_tile when an old payload has no set', () => {
    expect(bookAcceptedTiles(book())).toEqual(['5p']);
  });

  it('keeps the canonical tile first when it is not repeated in the set', () => {
    expect(bookAcceptedTiles(book({ expected_tiles: ['3p'] }))).toEqual([
      '5p',
      '3p',
    ]);
  });

  it('does not repeat a canonical tile already in the set', () => {
    expect(
      bookAcceptedTiles(book({ expected_tiles: ['5p', '3p'] })),
    ).toEqual(['5p', '3p']);
  });

  it('returns nothing for a missing or tile-less answer', () => {
    expect(bookAcceptedTiles(null)).toEqual([]);
    expect(bookAcceptedTiles(book({ expected_tile: '', expected_tiles: [] }))).toEqual(
      [],
    );
  });
});

describe('formatAcceptedTiles', () => {
  it('names a single answer unchanged', () => {
    expect(formatAcceptedTiles(book({ expected_tiles: ['5p'] }))).toBe('5p');
  });

  it('joins two tied answers with "or"', () => {
    expect(
      formatAcceptedTiles(book({ expected_tiles: ['5p', '3p'] })),
    ).toBe('5p or 3p');
  });

  it('uses a comma list for three or more accepted answers', () => {
    expect(
      formatAcceptedTiles(book({ expected_tiles: ['5p', '3p', '1p'] })),
    ).toBe('5p, 3p, or 1p');
  });

  it('prints honor tiles by their display names', () => {
    expect(formatAcceptedTiles(book({ expected_tile: '1z' }))).toBe('E');
  });

  it('is empty when no tile is accepted', () => {
    expect(
      formatAcceptedTiles(book({ expected_tile: '', expected_tiles: [] })),
    ).toBe('');
  });
});

describe('acceptedAlternativeNote', () => {
  it('names Mortal’s alternative when both picks are book-accepted', () => {
    expect(acceptedAlternativeNote(tiedBook, mortal())).toBe(
      'Book-accepted; Mortal preferred 3p from the same accepted set.',
    );
  });

  it('keeps the single-answer wording for a one-tile scenario', () => {
    expect(
      acceptedAlternativeNote(book({ expected_tiles: ['5p'] }), mortal()),
    ).toBeNull();
  });

  it('stays null when Mortal’s tile is not an accepted answer', () => {
    expect(
      acceptedAlternativeNote(
        tiedBook,
        mortal({
          recommended_action: 'Discard_7p',
          recommended_base: 'Discard_7p',
        }),
      ),
    ).toBeNull();
  });

  it('stays null when Mortal picks a different action family', () => {
    expect(
      acceptedAlternativeNote(
        tiedBook,
        mortal({
          recommended_action: 'Riichi',
          recommended_base: 'Riichi',
          recommended_riichi: true,
          recommended_discard: '3p',
        }),
      ),
    ).toBeNull();
  });

  it('stays null without a Mortal grade or an evaluation', () => {
    expect(acceptedAlternativeNote(tiedBook, null)).toBeNull();
    expect(acceptedAlternativeNote(null, mortal())).toBeNull();
  });

  it('names the declaration for a Riichi book answer', () => {
    const riichiBook = book({
      expected_action: 'riichi',
      expected_tiles: ['5p', '3p'],
    });
    expect(
      acceptedAlternativeNote(
        riichiBook,
        mortal({
          recommended_action: 'Riichi',
          recommended_base: 'Riichi',
          recommended_riichi: true,
          recommended_discard: '3p',
        }),
      ),
    ).toBe(
      'Book-accepted; Mortal preferred Riichi · discard 3p from the same accepted set.',
    );
  });

  it('stays null when Mortal’s Riichi discard was not resolved', () => {
    const riichiBook = book({
      expected_action: 'riichi',
      expected_tiles: ['5p', '3p'],
    });
    expect(
      acceptedAlternativeNote(
        riichiBook,
        mortal({
          recommended_action: 'Riichi',
          recommended_base: 'Riichi',
          recommended_riichi: true,
          recommended_discard: null,
        }),
      ),
    ).toBeNull();
  });

  it('prints honor tiles by their display names', () => {
    expect(
      acceptedAlternativeNote(
        book({ expected_tiles: ['5p', '5z'] }),
        mortal({
          recommended_action: 'Discard_5z',
          recommended_base: 'Discard_5z',
        }),
      ),
    ).toBe(
      'Book-accepted; Mortal preferred Wh from the same accepted set.',
    );
  });

  it('normalizes a red-five recommendation to its base tile', () => {
    expect(
      acceptedAlternativeNote(
        book({ expected_tiles: ['5p', '5m'] }),
        mortal({
          recommended_action: 'Discard_5mr',
          recommended_base: 'Discard_5m',
        }),
      ),
    ).toBe(
      'Book-accepted; Mortal preferred 5m from the same accepted set.',
    );
  });
});
