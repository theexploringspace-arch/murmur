// qr.js — QR Code Model 2 symbol structure shared by the encoder and decoder
// (ISO/IEC 18004). Versions 1–40, ECC levels L/M/Q/H, all 8 masks.

import { rsEncode } from './rs.js';

export const ECL = {
  L: { ord: 0, bits: 1 }, M: { ord: 1, bits: 0 }, Q: { ord: 2, bits: 3 }, H: { ord: 3, bits: 2 },
};
export const ECL_BY_BITS = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };

// [ecl][version]  (index 0 unused)
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export const sizeOf = (ver) => ver * 4 + 17;

export function rawDataModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const na = Math.floor(ver / 7) + 2;
    r -= (25 * na - 10) * na - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
export const rawCodewords = (ver) => Math.floor(rawDataModules(ver) / 8);
export const eccPerBlock = (ver, ecl) => ECC_PER_BLOCK[ECL[ecl].ord][ver];
export const numBlocks = (ver, ecl) => NUM_BLOCKS[ECL[ecl].ord][ver];
export const dataCodewords = (ver, ecl) => rawCodewords(ver) - eccPerBlock(ver, ecl) * numBlocks(ver, ecl);

export function alignmentPositions(ver) {
  if (ver === 1) return [];
  const na = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + na * 3 + 5) / (na * 4 - 4)) * 2;
  const out = [6];
  for (let pos = sizeOf(ver) - 7; out.length < na; pos -= step) out.splice(1, 0, pos);
  return out;
}

export function formatBits(ecl, mask) {
  const data = (ECL[ecl].bits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
export function versionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}
export const ALL_FORMATS = [];
for (const e of 'LMQH') for (let m = 0; m < 8; m++) ALL_FORMATS.push({ ecl: e, mask: m, bits: formatBits(e, m) });

export const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Grid with function patterns drawn; `fn[y][x]` marks reserved modules. */
export function functionGrid(ver) {
  const n = sizeOf(ver);
  const m = Array.from({ length: n }, () => new Uint8Array(n));
  const fn = Array.from({ length: n }, () => new Uint8Array(n));
  const set = (x, y, dark) => { m[y][x] = dark ? 1 : 0; fn[y][x] = 1; };
  for (let i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
  const ap = alignmentPositions(ver), last = ap.length - 1;
  for (let i = 0; i <= last; i++) for (let j = 0; j <= last; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
      set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // Reserve format areas (values filled later) + dark module
  drawFormat(m, fn, 0, n, true);
  if (ver >= 7) drawVersion(m, fn, ver, n);
  return { m, fn, n };
}

/** Coordinates of the two format-info copies, bit i → [x,y]. */
export function formatCoords(n) {
  const a = [], b = [];
  for (let i = 0; i <= 5; i++) a.push([8, i]);
  a.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) a.push([14 - i, 8]);
  for (let i = 0; i < 8; i++) b.push([n - 1 - i, 8]);
  for (let i = 8; i < 15; i++) b.push([8, n - 15 + i]);
  return [a, b];
}
export function drawFormat(m, fn, bits, n, reserveOnly = false) {
  const [a, b] = formatCoords(n);
  for (let i = 0; i < 15; i++) {
    const v = (bits >>> i) & 1;
    for (const [x, y] of [a[i], b[i]]) { m[y][x] = reserveOnly ? 0 : v; fn[y][x] = 1; }
  }
  m[n - 8][8] = 1; fn[n - 8][8] = 1; // always-dark module
}
/** Version-info coordinates: bit i → two [x,y] positions. */
export function versionCoords(n) {
  const out = [];
  for (let i = 0; i < 18; i++) {
    const a = n - 11 + (i % 3), b = Math.floor(i / 3);
    out.push([[a, b], [b, a]]);
  }
  return out;
}
function drawVersion(m, fn, ver, n) {
  const bits = versionBits(ver);
  versionCoords(n).forEach((pair, i) => { for (const [x, y] of pair) { m[y][x] = (bits >>> i) & 1; fn[y][x] = 1; } });
}

/** Zig-zag module order for data codewords. Yields [x,y]. */
export function* dataOrder(fn, n) {
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (!fn[y][x]) yield [x, y];
      }
    }
  }
}

/** Split data into blocks, add ECC, interleave → final codeword sequence. */
export function interleave(data, ver, ecl) {
  const nb = numBlocks(ver, ecl), ecc = eccPerBlock(ver, ecl), raw = rawCodewords(ver);
  const numShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const len = shortLen - ecc + (i < numShort ? 0 : 1);
    const d = data.slice(k, k + len); k += len;
    const e = rsEncode(d, ecc);
    const blk = Array.from(d);
    if (i < numShort) blk.push(0); // placeholder so all blocks align
    blk.push(...e);
    blocks.push(blk);
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++)
    blocks.forEach((b, j) => { if (i !== shortLen - ecc || j >= numShort) out.push(b[i]); });
  return out;
}

/** Inverse of interleave: codeword sequence → [{data, ecc}] blocks (uncorrected). */
export function deinterleave(codewords, ver, ecl) {
  const nb = numBlocks(ver, ecl), ecc = eccPerBlock(ver, ecl), raw = rawCodewords(ver);
  const numShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const blocks = Array.from({ length: nb }, (_, i) => new Uint8Array(shortLen + (i < numShort ? 0 : 1)));
  let k = 0;
  const dlen = (j) => shortLen - ecc + (j < numShort ? 0 : 1);
  // data part
  for (let i = 0; i < shortLen - ecc + 1; i++)
    for (let j = 0; j < nb; j++) if (i < dlen(j)) blocks[j][i] = codewords[k++];
  // ecc part
  for (let i = 0; i < ecc; i++)
    for (let j = 0; j < nb; j++) blocks[j][dlen(j) + i] = codewords[k++];
  return { blocks, ecc, dlen };
}
