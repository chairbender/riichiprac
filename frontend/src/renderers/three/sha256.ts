/**
 * SHA-256 in plain TypeScript: the relief bridge's hash when WebCrypto is not
 * there (3D-20 follow-up).
 *
 * The carve atlases are pinned by SHA-256 (`reliefAssets.PINNED_RELIEF3D_ATLASES`
 * and the committed `relief3d.json`), and the loader verified them with
 * `crypto.subtle.digest`. **`crypto.subtle` does not exist outside a secure
 * context** — any plain-HTTP origin other than `localhost` — so on a self-hosted
 * LAN or tailnet URL the verification threw, the bridge took its fallback path,
 * and the whole 3D view silently drew the procedural neutral cells instead of
 * the committed carved art. That is a data-loss-shaped bug for a self-hoster:
 * the renderer said `status: 'fallback'` and the art just looked wrong.
 *
 * The atlases are small (0.45-1.6 MB each, ~3 MB together), so a plain-JS
 * SHA-256 costs a few tens of milliseconds once per load — cheap enough to be
 * the fallback rather than a reason to skip verification. WebCrypto is still
 * preferred where it exists.
 *
 * Implementation notes: FIPS 180-4, 32-bit words, `>>> 0` after every add so the
 * values stay unsigned; the block loop reads big-endian. No DOM, no `node:crypto`,
 * no `TextEncoder` dependency beyond the caller's bytes, so it runs identically
 * in the browser, a worker and Node, and a test can compare it with `node:crypto`
 * and with the committed pins.
 */

/** The SHA-256 round constants: the first 32 bits of the cube roots of the primes. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

/** The initial hash state: the fractional parts of the square roots of the primes. */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
  0x5be0cd19,
]);

function rotr(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

/**
 * The SHA-256 digest of `bytes`, as lowercase hex.
 *
 * Pure and synchronous: the same input always produces the same digest, on any
 * platform, with no promise. A 3 MB atlas takes a few tens of milliseconds.
 */
export function sha256HexSync(bytes: Uint8Array): string {
  const length = bytes.length;
  // Padding: 0x80, then zeros, then the 64-bit big-endian bit length, rounded up
  // to a whole block. (The first draft used `((length + 9) >> 6) + 1`, which adds
  // a spurious block whenever `length + 9` is already a multiple of 64 — lengths
  // 55, 119, ... — and the vector test caught it.)
  const paddedLength = (((length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[length] = 0x80;
  const bitLengthHigh = Math.floor(length / 0x20000000); // length * 8 / 2^32
  const bitLengthLow = (length << 3) >>> 0;
  const end = paddedLength;
  padded[end - 8] = (bitLengthHigh >>> 24) & 0xff;
  padded[end - 7] = (bitLengthHigh >>> 16) & 0xff;
  padded[end - 6] = (bitLengthHigh >>> 8) & 0xff;
  padded[end - 5] = bitLengthHigh & 0xff;
  padded[end - 4] = (bitLengthLow >>> 24) & 0xff;
  padded[end - 3] = (bitLengthLow >>> 16) & 0xff;
  padded[end - 2] = (bitLengthLow >>> 8) & 0xff;
  padded[end - 1] = bitLengthLow & 0xff;

  const h = Uint32Array.from(H0);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] =
        ((padded[at] << 24) |
          (padded[at + 1] << 16) |
          (padded[at + 2] << 8) |
          padded[at + 3]) >>>
        0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i += 1) {
    hex += h[i].toString(16).padStart(8, '0');
  }
  return hex;
}
