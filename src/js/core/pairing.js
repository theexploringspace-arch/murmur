// pairing.js — the signed "pairing code" carried by QR (or copy/paste/AirDrop).
//
// A pairing code replaces a signaling server. It says:
//   "I am identity key K, call me NAME, and here is how to reach my browser
//    right now (compact SDP, which includes my DTLS certificate fingerprint)."
// and it is signed by K, so it cannot be altered in transit without detection.
//
// Wire format (v1):
//   u8   version = 1
//   u8   kind    = 1 offer | 2 answer
//   u32  created (unix seconds)
//   65B  identity public key (uncompressed P-256)
//   lp8  display name (UTF-8, ≤ 40 bytes)
//   lp16 compact SDP
//   8B   [answer only] first 8 bytes of SHA-256(offer code bytes)  — binds answer to offer
//   64B  ECDSA-P256-SHA256 signature over "murmur/pair/v1" || all bytes above
//
// Text forms:
//   QR:    "MUR1:" + base45(bytes)   (QR alphanumeric mode — dense and text-safe)
//   paste: "mur1." + base64url(bytes)

import { Writer, Reader, concat, utf8, fromUtf8, toB45, fromB45, toB64u, fromB64u, equal } from './bytes.js';
import * as C from './crypto.js';
import { compactSdp, expandSdp } from './sdp.js';

export const KIND = { offer: 1, answer: 2 };
export const MAX_AGE_S = 15 * 60;
export const MAX_SKEW_S = 5 * 60;
const SIG_LABEL = utf8('murmur/pair/v1');
const MAX_NAME = 40;

export function clampName(name) {
  let b = utf8(String(name).trim().replace(/[\u0000-\u001f\u007f]/g, ''));
  while (b.length > MAX_NAME) { name = [...fromUtf8(b)].slice(0, -1).join(''); b = utf8(name); }
  return fromUtf8(b);
}

export async function createPairingCode({ kind, identity, name, sdp, offerBytes = null, now = Date.now() }) {
  const w = new Writer();
  w.u8(1).u8(KIND[kind]).u32(Math.floor(now / 1000));
  w.raw(identity.publicRaw).lp8(utf8(clampName(name))).lp16(compactSdp(sdp));
  if (kind === 'answer') {
    if (!offerBytes) throw new Error('answer must reference an offer');
    w.raw((await C.sha256(offerBytes)).slice(0, 8));
  }
  const body = w.done();
  const sig = await C.sign(identity.privateKey, concat(SIG_LABEL, body));
  return concat(body, sig);
}

export class PairingError extends Error { constructor(m) { super(m); this.name = 'PairingError'; } }

/** Parse + verify. Throws PairingError with a user-presentable reason. */
export async function parsePairingCode(bytes, { expectKind, offerBytes = null, now = Date.now() } = {}) {
  if (bytes.length < 2 + 4 + 65 + 1 + 2 + 64) throw new PairingError('Code is too short');
  const body = bytes.slice(0, -64);
  const sig = bytes.slice(-64);
  const r = new Reader(body);
  let out;
  try {
    if (r.u8() !== 1) throw new PairingError('Unsupported code version — update Murmur');
    const kindN = r.u8();
    const kind = kindN === 1 ? 'offer' : kindN === 2 ? 'answer' : null;
    if (!kind) throw new PairingError('Unknown code type');
    const created = r.u32();
    const publicRaw = r.raw(65);
    const name = clampName(fromUtf8(r.lp8()));
    const sdpBytes = r.lp16();
    const offerHash = kind === 'answer' ? r.raw(8) : null;
    r.end();
    out = { kind, created, publicRaw, name, sdpBytes, offerHash };
  } catch (e) {
    if (e instanceof PairingError) throw e;
    throw new PairingError('Code is damaged or incomplete');
  }
  let pub;
  try { pub = await C.importIdentityPublic(out.publicRaw); } catch { throw new PairingError('Code contains an invalid key'); }
  if (!(await C.verify(pub, sig, concat(SIG_LABEL, body)))) throw new PairingError('Signature check failed — code was altered');

  if (expectKind && out.kind !== expectKind)
    throw new PairingError(expectKind === 'answer' ? 'That is an invite code. Scan your friend\'s REPLY code.' : 'That is a reply code. Scan an INVITE code.');
  const age = Math.floor(now / 1000) - out.created;
  if (age > MAX_AGE_S) throw new PairingError('Code expired — make a new one');
  if (age < -MAX_SKEW_S) throw new PairingError('Code is from the future — check both phones\' clocks');
  if (out.kind === 'answer') {
    if (!offerBytes) throw new PairingError('No invite is waiting for this reply');
    const h = (await C.sha256(offerBytes)).slice(0, 8);
    if (!equal(h, out.offerHash)) throw new PairingError('This reply belongs to a different invite');
  }
  let desc;
  try { desc = expandSdp(out.sdpBytes, out.kind); } catch { throw new PairingError('Connection details in code are invalid'); }
  return { ...out, identityKey: pub, description: desc, bytes };
}

export const toQrText = (b) => 'MUR1:' + toB45(b);
export const toPasteText = (b) => 'mur1.' + toB64u(b);

export function fromText(s) {
  s = String(s).trim();
  try {
    if (s.startsWith('MUR1:')) return fromB45(s.slice(5));
    const m = /mur1\.([A-Za-z0-9_-]+)/.exec(s.replace(/\s+/g, '')); // tolerate wrapped/quoted pastes
    if (m) return fromB64u(m[1]);
  } catch { /* fallthrough */ }
  throw new PairingError('That doesn\'t look like a Murmur code');
}
