// bytes.js — small, dependency-free byte utilities.
// Everything in Murmur moves around as Uint8Array; these helpers keep
// conversions in one audited place instead of scattered ad-hoc code.

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (s) => te.encode(s);
export const fromUtf8 = (b) => td.decode(b);

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Constant-time comparison (for MACs/fingerprints). Length leak is acceptable. */
export function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export const random = (n) => crypto.getRandomValues(new Uint8Array(n));

export function u32be(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}
export function readU32be(b, off = 0) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, false);
}

export function toHex(b) {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
export function fromHex(s) {
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

// ---- base64url (RFC 4648 §5, no padding) ----
export function toB64u(b) {
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64u(s) {
  if (/[^A-Za-z0-9_-]/.test(s)) throw new Error('bad base64url');
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : s.length % 4 === 0 ? '' : null;
  if (pad === null) throw new Error('bad base64url length');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- base45 (RFC 9285) ----
// Uses exactly the QR "alphanumeric" alphabet, so a base45 string packs into
// a QR code at ~5.5 bits/char — almost as dense as raw bytes, but survives
// scanners (like BarcodeDetector) that only hand back text.
export const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
export function toB45(b) {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) {
    let n = b[i] * 256 + b[i + 1];
    const c = n % 45; n = (n - c) / 45;
    const d = n % 45; const e = (n - d) / 45;
    s += B45[c] + B45[d] + B45[e];
  }
  if (b.length % 2) {
    const n = b[b.length - 1];
    s += B45[n % 45] + B45[(n / 45) | 0];
  }
  return s;
}
export function fromB45(s) {
  const v = [];
  for (const ch of s) {
    const i = B45.indexOf(ch);
    if (i < 0) throw new Error('bad base45 char');
    v.push(i);
  }
  if (v.length % 3 === 1) throw new Error('bad base45 length');
  const out = [];
  for (let i = 0; i < v.length; i += 3) {
    if (i + 2 < v.length) {
      const n = v[i] + v[i + 1] * 45 + v[i + 2] * 2025;
      if (n > 0xffff) throw new Error('bad base45 triple');
      out.push(n >> 8, n & 0xff);
    } else {
      const n = v[i] + v[i + 1] * 45;
      if (n > 0xff) throw new Error('bad base45 pair');
      out.push(n);
    }
  }
  return new Uint8Array(out);
}

/** Minimal TLV-ish binary writer/reader used by the wire formats. */
export class Writer {
  constructor() { this.parts = []; }
  u8(n) { this.parts.push(Uint8Array.of(n & 0xff)); return this; }
  u16(n) { this.parts.push(Uint8Array.of((n >> 8) & 0xff, n & 0xff)); return this; }
  u32(n) { this.parts.push(u32be(n)); return this; }
  raw(b) { this.parts.push(b); return this; }
  /** length-prefixed (u8) bytes, max 255 */
  lp8(b) { if (b.length > 255) throw new Error('field too long'); this.u8(b.length); return this.raw(b); }
  /** length-prefixed (u16) bytes */
  lp16(b) { if (b.length > 0xffff) throw new Error('field too long'); this.u16(b.length); return this.raw(b); }
  done() { return concat(...this.parts); }
}
export class Reader {
  constructor(b) { this.b = b; this.o = 0; }
  need(n) { if (this.o + n > this.b.length) throw new Error('truncated'); }
  u8() { this.need(1); return this.b[this.o++]; }
  u16() { this.need(2); const v = (this.b[this.o] << 8) | this.b[this.o + 1]; this.o += 2; return v; }
  u32() { this.need(4); const v = readU32be(this.b, this.o); this.o += 4; return v; }
  raw(n) { this.need(n); const v = this.b.slice(this.o, this.o + n); this.o += n; return v; }
  lp8() { return this.raw(this.u8()); }
  lp16() { return this.raw(this.u16()); }
  get remaining() { return this.b.length - this.o; }
  end() { if (this.o !== this.b.length) throw new Error('trailing bytes'); }
}
