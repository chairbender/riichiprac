import { describe, expect, it } from 'vitest';
import type { BookGrade } from './verdict';
import { bookAcceptedTiles, formatAcceptedTiles } from './verdict';

function book(overrides: Partial<BookGrade> = {}): BookGrade {
  return {
    is_action_correct: true,
    is_tile_correct: true,
    expected_action: 'dama',
    expected_tile: '5p',
    ...overrides,
  };
}

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
