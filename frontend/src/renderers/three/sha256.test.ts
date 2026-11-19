/**
 * The plain-JS SHA-256 the relief bridge falls back to (3D-20 follow-up).
 *
 * Two things are pinned here: the implementation against the standard's own test
 * vectors (and against `node:crypto` on random bytes), and — the point of the
 * fallback — that it reproduces the **committed atlases'** pinned digests. That
 * second test is the one that matters: it proves a self-hoster on a plain-HTTP
 * origin gets the committed carved art, not the procedural neutral cells.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PINNED_RELIEF3D_ATLASES } from './reliefAssets';
import { sha256HexSync } from './sha256';

const tableDir = fileURLToPath(new URL('../../../public/table/', import.meta.url));

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe('plain SHA-256 (the non-secure-context fallback)', () => {
  it('matches the standard test vectors', () => {
    // FIPS 180-4 / the usual published vectors.
    expect(sha256HexSync(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256HexSync(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      sha256HexSync(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    // The padding boundaries either side of a block.
    expect(sha256HexSync(new Uint8Array(55).fill(0x61))).toBe(
      '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
    );
    expect(sha256HexSync(new Uint8Array(56).fill(0x61))).toBe(
      'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    );
  });

  it('agrees with node:crypto across lengths and alignments', () => {
    // The padding boundaries: 55/56 and 119/120 straddle the points where the
    // 0x80 terminator plus the 8-byte length no longer fit in the same block.
    for (const length of [
      0, 1, 2, 3, 54, 55, 56, 57, 63, 64, 65, 111, 118, 119, 120, 127, 128, 129, 1000, 4096,
      65_537,
    ]) {
      const bytes = randomBytes(length);
      expect(sha256HexSync(new Uint8Array(bytes)), `length ${length}`).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
    }
  });

  it('reproduces the committed atlases\u2019 pinned digests', () => {
    // The whole point: on an insecure origin the loader hashes with this
    // implementation, and the pins must still verify or the carve is lost.
    for (const key of Object.keys(PINNED_RELIEF3D_ATLASES) as (keyof typeof PINNED_RELIEF3D_ATLASES)[]) {
      const pin = PINNED_RELIEF3D_ATLASES[key];
      const bytes = new Uint8Array(readFileSync(join(tableDir, pin.file)));
      expect(bytes.byteLength, pin.file).toBe(pin.bytes);
      expect(sha256HexSync(bytes), pin.file).toBe(pin.sha256);
    }
  });

  it('is fast enough to be the fallback on the real payload', () => {
    const bytes = new Uint8Array(
      readFileSync(join(tableDir, PINNED_RELIEF3D_ATLASES.face_normal_depth.file)),
    );
    const started = performance.now();
    sha256HexSync(bytes);
    const elapsed = performance.now() - started;
    // One 1.6 MB atlas, one pass. A generous bound: the fallback runs once per
    // load, and a slow machine should still be far inside it.
    expect(elapsed).toBeLessThan(250);
  });
});
