// ratchet.js — the Double Ratchet, for messages that wait in a mailbox.
//
// WHY A SECOND PROTOCOL?
// session.js needs both phones online at the same moment (live handshake).
// A mailbox message is encrypted NOW and decrypted maybe days later, when the
// sender may be offline. That is exactly the problem Signal's Double Ratchet
// solves (https://signal.org/docs/specifications/doubleratchet/). We follow
// that spec closely, using only WebCrypto primitives (P-256 ECDH, HKDF/HMAC-
// SHA-256, AES-256-GCM) — no hand-written cryptography.
//
// PROPERTIES
//  • Forward secrecy: every message key is used once and then deleted; a
//    phone stolen tomorrow cannot decrypt yesterday's mailbox traffic.
//  • Break-in recovery: each reply mixes a fresh ECDH into the root key, so a
//    leaked state "heals" after one round trip.
//  • Out-of-order + loss tolerant: skipped message keys are kept (bounded).
//  • Transactional decrypt: the state only changes if the message authenticates.
//
// The relay sees: the header (ratchet public key + 2 counters) and ciphertext
// length (padded, see pad()). It never sees keys or plaintext.

import { concat, utf8, toB64u, fromB64u, Writer, Reader, random } from './bytes.js';
import { hkdf, hmac, ecdh, aesGcmEncrypt, aesGcmDecrypt, importAesKey } from './crypto.js';
import { pad, unpad } from './session.js';

const subtle = globalThis.crypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
export const MAX_SKIP = 1000;          // per chain: refuse absurd gaps (DoS guard)
export const MAX_STORED_SKIPPED = 2000; // whole conversation
export const RATCHET_VERSION = 1;

export class RatchetError extends Error { constructor(m) { super(m); this.name = 'RatchetError'; } }

// ---- key pairs that can be persisted inside the (encrypted) vault ----
export async function generateDH() {
  const kp = await subtle.generateKey(ECDH, true, ['deriveBits']);
  return {
    pub: new Uint8Array(await subtle.exportKey('raw', kp.publicKey)),
    priv: new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey)),
  };
}
const importPriv = (pkcs8) => subtle.importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits']);
async function importPub(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 65 || raw[0] !== 4) throw new RatchetError('bad ratchet key');
  try { return await subtle.importKey('raw', raw, ECDH, false, []); } // validates the point is on the curve
  catch { throw new RatchetError('bad ratchet key'); }
}
export async function dh(pair, pubRaw) { return ecdh(await importPriv(pair.priv), await importPub(pubRaw)); }

// ---- KDFs (spec §5.2) ----
async function kdfRK(rk, dhOut) {
  const out = await hkdf(dhOut, rk, 'murmur/dr/rk/v1', 64);
  return [out.slice(0, 32), out.slice(32)];
}
async function kdfCK(ck) {
  return [await hmac(ck, Uint8Array.of(2)), await hmac(ck, Uint8Array.of(1))]; // [nextCK, messageKey]
}
async function messageCipher(mk) {
  const okm = await hkdf(mk, new Uint8Array(32), 'murmur/dr/mk/v1', 44);
  return { key: await importAesKey(okm.slice(0, 32)), iv: okm.slice(32) };
}

// ---- header ----
function encodeHeader(h) {
  return new Writer().u8(RATCHET_VERSION).raw(h.dh).u32(h.pn).u32(h.n).done();
}
export function decodeHeader(b) {
  const r = new Reader(b);
  if (r.u8() !== RATCHET_VERSION) throw new RatchetError('unsupported ratchet version');
  const h = { dh: r.raw(65), pn: r.u32(), n: r.u32() };
  r.end();
  return h;
}
const HEADER_LEN = 1 + 65 + 4 + 4;

// ---- state (plain JSON-able object so the vault can store it) ----
const B = (u) => (u ? toB64u(u) : null);
const U = (s) => (s ? fromB64u(s) : null);
function serialize(s) {
  return {
    v: 1, ad: B(s.ad), rk: B(s.rk), cks: B(s.cks), ckr: B(s.ckr), ns: s.ns, nr: s.nr, pn: s.pn,
    dhs: s.dhs && { pub: B(s.dhs.pub), priv: B(s.dhs.priv) }, dhr: B(s.dhr),
    skipped: s.skipped.map(([k, mk]) => [k, B(mk)]),
  };
}
function deserialize(j) {
  return {
    ad: U(j.ad), rk: U(j.rk), cks: U(j.cks), ckr: U(j.ckr), ns: j.ns, nr: j.nr, pn: j.pn,
    dhs: j.dhs && { pub: U(j.dhs.pub), priv: U(j.dhs.priv) }, dhr: U(j.dhr),
    skipped: j.skipped.map(([k, mk]) => [k, U(mk)]),
  };
}
const skKey = (dhPub, n) => `${toB64u(dhPub)}:${n}`;

export class Ratchet {
  /** @private */ constructor(state) { this.s = state; }

  /** The side that RECEIVED the bundle (it knows the other side's ratchet public key). Sends first. */
  static async initSender(sharedKey, theirRatchetPub, ad) {
    const dhs = await generateDH();
    const [rk, cks] = await kdfRK(sharedKey, await dh(dhs, theirRatchetPub));
    return new Ratchet({ ad, rk, cks, ckr: null, ns: 0, nr: 0, pn: 0, dhs, dhr: theirRatchetPub, skipped: [] });
  }

  /** The side that PUBLISHED its ratchet key (inviter). Can only reply after receiving. */
  static initReceiver(sharedKey, ourRatchetPair, ad) {
    return new Ratchet({ ad, rk: sharedKey, cks: null, ckr: null, ns: 0, nr: 0, pn: 0, dhs: ourRatchetPair, dhr: null, skipped: [] });
  }

  static fromJSON(j) { return new Ratchet(deserialize(j)); }
  toJSON() { return serialize(this.s); }
  get canSend() { return !!this.s.cks; }

  /** → wire bytes: header || AES-GCM(padded plaintext), AAD = ad || header */
  async encrypt(plaintext) {
    if (!this.s.cks) throw new RatchetError('cannot send before the first message arrives');
    const [ck, mk] = await kdfCK(this.s.cks);
    const header = encodeHeader({ dh: this.s.dhs.pub, pn: this.s.pn, n: this.s.ns });
    const { key, iv } = await messageCipher(mk);
    const ct = await aesGcmEncrypt(key, iv, pad(plaintext), concat(this.s.ad, header));
    this.s.cks = ck; this.s.ns += 1;
    return concat(header, ct);
  }

  /** Throws RatchetError on any forgery/replay; state is untouched in that case. */
  async decrypt(wire) {
    if (!(wire instanceof Uint8Array) || wire.length < HEADER_LEN + 16) throw new RatchetError('truncated');
    const headerBytes = wire.slice(0, HEADER_LEN);
    const h = decodeHeader(headerBytes);
    const ct = wire.slice(HEADER_LEN);
    const aad = concat(this.s.ad, headerBytes);
    const open = async (mk) => {
      const { key, iv } = await messageCipher(mk);
      let padded;
      try { padded = await aesGcmDecrypt(key, iv, ct, aad); }
      catch { throw new RatchetError('message failed authentication'); }
      try { return unpad(padded); } catch { throw new RatchetError('bad padding'); }
    };

    // 1. a key we skipped earlier (late / reordered message)
    const id = skKey(h.dh, h.n);
    const idx = this.s.skipped.findIndex(([k]) => k === id);
    if (idx >= 0) {
      const pt = await open(this.s.skipped[idx][1]);
      this.s.skipped.splice(idx, 1);          // one use only → replay of it now fails
      return pt;
    }

    // 2. work on a copy; commit only after authentication succeeds
    const t = { ...this.s, skipped: [...this.s.skipped] };
    const sameChain = t.dhr && equalBytes(h.dh, t.dhr);
    if (!sameChain) {
      if (t.ckr) await skipTo(t, h.pn);
      await dhRatchet(t, h);
    }
    if (h.n < t.nr) throw new RatchetError('replayed or duplicate message');
    await skipTo(t, h.n);
    const [ck, mk] = await kdfCK(t.ckr);
    const pt = await open(mk);
    t.ckr = ck; t.nr += 1;
    this.s = t;
    return pt;
  }
}

function equalBytes(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }

async function skipTo(t, until) {
  if (!t.ckr) return;
  if (until - t.nr > MAX_SKIP) throw new RatchetError('too many skipped messages');
  while (t.nr < until) {
    const [ck, mk] = await kdfCK(t.ckr);
    t.skipped.push([skKey(t.dhr, t.nr), mk]);
    t.ckr = ck; t.nr += 1;
  }
  if (t.skipped.length > MAX_STORED_SKIPPED) t.skipped.splice(0, t.skipped.length - MAX_STORED_SKIPPED);
}

async function dhRatchet(t, h) {
  t.pn = t.ns; t.ns = 0; t.nr = 0; t.dhr = h.dh;
  [t.rk, t.ckr] = await kdfRK(t.rk, await dh(t.dhs, t.dhr));
  t.dhs = await generateDH();
  [t.rk, t.cks] = await kdfRK(t.rk, await dh(t.dhs, t.dhr));
}

/** Associated data binds both identities: initiator first. */
export const associatedData = (initiatorIdentityPub, responderIdentityPub) =>
  concat(utf8('murmur/dr/ad/v1'), initiatorIdentityPub, responderIdentityPub);

export const _random = random;
