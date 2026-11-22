// encode.js — text → QR module matrix. Chooses the densest mode
// (numeric / alphanumeric / byte) for the whole string and the smallest version.

import {
  ECL, sizeOf, dataCodewords, functionGrid, drawFormat, formatBits, dataOrder, interleave, MASKS,
} from './qr.js';

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function countBits(mode, ver) {
  const i = ver <= 9 ? 0 : ver <= 26 ? 1 : 2;
  return { numeric: [10, 12, 14], alnum: [9, 11, 13], byte: [8, 16, 16] }[mode][i];
}

class Bits {
  constructor() { this.a = []; }
  put(v, n) { for (let i = n - 1; i >= 0; i--) this.a.push((v >>> i) & 1); }
}

function segment(text) {
  if (/^\d*$/.test(text)) return { mode: 'numeric', ind: 1, count: text.length, data: text };
  if ([...text].every((c) => ALNUM.includes(c))) return { mode: 'alnum', ind: 2, count: text.length, data: text };
  const bytes = new TextEncoder().encode(text);
  return { mode: 'byte', ind: 4, count: bytes.length, data: bytes };
}

function segBits(seg, ver) {
  const b = new Bits();
  b.put(seg.ind, 4);
  b.put(seg.count, countBits(seg.mode, ver));
  if (seg.mode === 'numeric') {
    for (let i = 0; i < seg.data.length; i += 3) {
      const chunk = seg.data.substr(i, 3);
      b.put(parseInt(chunk, 10), chunk.length * 3 + 1);
    }
  } else if (seg.mode === 'alnum') {
    for (let i = 0; i + 1 < seg.data.length; i += 2) b.put(ALNUM.indexOf(seg.data[i]) * 45 + ALNUM.indexOf(seg.data[i + 1]), 11);
    if (seg.data.length % 2) b.put(ALNUM.indexOf(seg.data[seg.data.length - 1]), 6);
  } else {
    for (const x of seg.data) b.put(x, 8);
  }
  return b.a;
}

function penalty(m, n) {
  let p = 0;
  // Rule 1: runs of ≥5 same-colour modules (rows and columns)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        const a = pass ? m[j][i] : m[i][j], b = pass ? m[j - 1][i] : m[i][j - 1];
        if (a === b) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
      }
    }
  }
  // Rule 2: 2×2 blocks
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
  }
  // Rule 3: finder-like 1:1:3:1:1 with 4 light modules on a side
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) for (let j = 0; j + 11 <= n; j++) {
    let a = true, b = true;
    for (let k = 0; k < 11; k++) {
      const v = pass ? m[j + k][i] : m[i][j + k];
      if (v !== pat1[k]) a = false;
      if (v !== pat2[k]) b = false;
      if (!a && !b) break;
    }
    if (a) p += 40; if (b) p += 40;
  }
  // Rule 4: dark balance
  let dark = 0; for (const row of m) for (const v of row) dark += v;
  const total = n * n;
  p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return p;
}

/**
 * @param {string} text
 * @param {{ecl?: 'L'|'M'|'Q'|'H', minVersion?: number, mask?: number}} opts
 * @returns {{size:number, version:number, ecl:string, mask:number, modules:Uint8Array[]}}
 */
export function encodeQR(text, { ecl = 'M', minVersion = 1, mask = -1 } = {}) {
  const seg = segment(text);
  let ver, bits;
  for (ver = minVersion; ver <= 40; ver++) {
    bits = segBits(seg, ver);
    if (bits.length <= dataCodewords(ver, ecl) * 8) break;
  }
  if (ver > 40) throw new Error('Data too long for a QR code');
  // Opportunistically boost ECC if it still fits in the same version
  for (const better of ['Q', 'H'].filter((e) => ECL[e].ord > ECL[ecl].ord)) {
    if (segBits(seg, ver).length <= dataCodewords(ver, better) * 8) ecl = better;
  }
  const cap = dataCodewords(ver, ecl) * 8;
  const b = new Bits(); b.a = bits;
  b.put(0, Math.min(4, cap - b.a.length));
  b.put(0, (8 - (b.a.length % 8)) % 8);
  for (let pad = 0xec; b.a.length < cap; pad ^= 0xec ^ 0x11) b.put(pad, 8);
  const data = new Uint8Array(cap / 8);
  for (let i = 0; i < b.a.length; i++) data[i >>> 3] |= b.a[i] << (7 - (i & 7));

  const cw = interleave(data, ver, ecl);
  const { m: base, fn, n } = functionGrid(ver);
  let i = 0;
  for (const [x, y] of dataOrder(fn, n)) {
    base[y][x] = i < cw.length * 8 ? (cw[i >>> 3] >>> (7 - (i & 7))) & 1 : 0;
    i++;
  }
  let best = null;
  for (let k = 0; k < 8; k++) {
    if (mask >= 0 && k !== mask) continue;
    const m = base.map((r) => r.slice());
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fn[y][x] && MASKS[k](x, y)) m[y][x] ^= 1;
    drawFormat(m, fn.map((r) => r.slice()), formatBits(ecl, k), n);
    const score = penalty(m, n);
    if (!best || score < best.score) best = { m, score, k };
  }
  return { size: sizeOf(ver), version: ver, ecl, mask: best.k, modules: best.m };
}

/** Render to an SVG string (quiet zone 4). Pure string — safe under Trusted Types via DOMParser. */
export function qrToSvgPath(qr) {
  let d = '';
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++)
    if (qr.modules[y][x]) d += `M${x + 4},${y + 4}h1v1h-1z`;
  return { d, viewBox: `0 0 ${qr.size + 8} ${qr.size + 8}` };
}
