// session.js — Murmur's end-to-end encrypted session over any ordered,
// reliable byte channel (in the app: a WebRTC data channel).
//
// WebRTC already encrypts with DTLS, and the DTLS fingerprints were exchanged
// in person via QR. Murmur adds its own E2E layer on top anyway, because:
//   • it authenticates the *people* (identity keys), not just the browsers;
//   • it binds both DTLS fingerprints into the handshake, so the transport
//     cannot be swapped out from under the session;
//   • it ratchets keys per message (forward secrecy inside a session) and
//     re-keys with fresh ECDH periodically (heals after a key compromise);
//   • it pads every message so lengths don't leak content.
//
// Handshake (both sides send HELLO immediately; channel is ordered):
//   HELLO  = 0x01 ‖ ver ‖ eph_pub(65) ‖ nonce(32)
//   T      = H("murmur/hs/v1", idO, idA, fpO, fpA, ephO, ephA, nonceO, nonceA)
//   AUTH   = 0x02 ‖ Sign(id_priv, "murmur/auth/v1" ‖ role ‖ T)
//   okm    = HKDF(ECDH(eph), salt=T, info="murmur/keys/v1", 96)
//          → root ‖ chain(offerer→answerer) ‖ chain(answerer→offerer)
// Data:
//   DATA   = 0x03 ‖ epoch(u8) ‖ seq(u32) ‖ AES-256-GCM(mk, pad(json), aad=header)
//   mk     = HMAC(ck, 0x01); ck' = HMAC(ck, 0x02)  (old ck is erased)
// Re-key (offerer-initiated → no races): see docs/PROTOCOL.md §5.

import * as C from './crypto.js';
import { Writer, Reader, concat, utf8, fromUtf8, equal } from './bytes.js';

const T_HELLO = 1, T_AUTH = 2, T_DATA = 3;
const VERSION = 1;
export const MAX_FRAME = 64 * 1024;
export const REKEY_EVERY_MESSAGES = 100;
export const REKEY_EVERY_MS = 5 * 60 * 1000;
const ZERO32 = new Uint8Array(32);

export class SessionError extends Error { constructor(m) { super(m); this.name = 'SessionError'; } }

// ---------- padding ----------
const BUCKETS = [256, 1024, 4096, 16384];
export function pad(data) {
  const need = data.length + 4;
  let size = BUCKETS.find((b) => b >= need);
  if (!size) size = Math.ceil(need / 16384) * 16384;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(data, 4);
  return out;
}
export function unpad(buf) {
  if (buf.length < 4) throw new SessionError('bad padding');
  const n = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
  if (n > buf.length - 4) throw new SessionError('bad padding');
  return buf.slice(4, 4 + n);
}

// ---------- KDF chain ----------
async function chainStep(ck) {
  const mk = await C.hmac(ck, Uint8Array.of(1));
  const next = await C.hmac(ck, Uint8Array.of(2));
  ck.fill(0);
  return { mk, next };
}
async function messageKey(mk) {
  const okm = await C.hkdf(mk, ZERO32, 'murmur/msg/v1', 44);
  mk.fill(0);
  const key = await C.importAesKey(okm.slice(0, 32));
  const iv = okm.slice(32, 44);
  okm.fill(0);
  return { key, iv };
}

const header = (epoch, seq) => new Writer().u8(T_DATA).u8(epoch).u32(seq).done();

class Chain {
  constructor(ck, epoch) { this.ck = ck; this.epoch = epoch; this.seq = 0; }
}

/**
 * @param {object} o
 * @param {'offerer'|'answerer'} o.role
 * @param {{privateKey, publicRaw}} o.identity      our identity
 * @param {Uint8Array} o.peerIdentityRaw              expected peer identity (from their signed pairing code)
 * @param {Uint8Array} o.localFingerprint             our DTLS cert fingerprint (from our local SDP)
 * @param {Uint8Array} o.remoteFingerprint            peer's DTLS cert fingerprint (from their pairing code)
 * @param {(bytes:Uint8Array)=>void} o.send            raw channel send
 */
export class SecureSession {
  constructor(o) {
    Object.assign(this, {
      role: o.role, identity: o.identity, peerIdentityRaw: o.peerIdentityRaw,
      localFp: o.localFingerprint, remoteFp: o.remoteFingerprint, rawSend: o.send,
      rekeyEveryMessages: o.rekeyEveryMessages ?? REKEY_EVERY_MESSAGES,
      rekeyEveryMs: o.rekeyEveryMs ?? REKEY_EVERY_MS,
    });
    this.onready = () => {}; this.onmessage = () => {}; this.onerror = () => {}; this.onrekey = () => {};
    this.state = 'new';
    this.recvQ = Promise.resolve();
    this.sendQ = Promise.resolve();
    this.pendingRekey = null;
    this.msgCount = 0;
    this.lastRekey = Date.now();
    this.epoch = 0;
  }

  get isOfferer() { return this.role === 'offerer'; }
  get ready() { return this.state === 'ready'; }

  async start() {
    if (this.state !== 'new' || this.starting) throw new SessionError('already started');
    this.starting = true;
    this.peerIdentityKey = await C.importIdentityPublic(this.peerIdentityRaw);
    this.eph = await C.generateEphemeral();
    this.ephPub = await C.exportPublic(this.eph.publicKey);
    this.nonce = crypto.getRandomValues(new Uint8Array(32));
    this.rawSend(new Writer().u8(T_HELLO).u8(VERSION).raw(this.ephPub).raw(this.nonce).done());
    this.state = 'hello-sent'; // frames arriving before this point were buffered in earlyFrames
    // A HELLO that arrived before start() finished is processed now.
    if (this.earlyFrames) { const f = this.earlyFrames; this.earlyFrames = null; f.forEach((b) => this.receive(b)); }
  }

  /** Feed every raw frame from the channel here. Never throws; errors go to onerror and kill the session. */
  receive(bytes) {
    if (this.state === 'new') { (this.earlyFrames ||= []).push(bytes); return; }
    this.recvQ = this.recvQ.then(() => this.#handle(bytes)).catch((e) => this.#fail(e));
  }

  #fail(e) {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.send = this.recv = null;
    if (this.pendingRekey) this.pendingRekey.reject(e);
    this.onerror(e instanceof SessionError ? e : new SessionError(e.message || String(e)));
  }

  close() { this.state = 'dead'; this.send = this.recv = null; if (this.pendingRekey) this.pendingRekey.reject(new SessionError('closed')); }

  async #handle(bytes) {
    if (this.state === 'dead') return;
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length > MAX_FRAME) throw new SessionError('frame too large');
    const r = new Reader(bytes);
    const type = r.u8();
    if (type === T_HELLO) return this.#onHello(r);
    if (type === T_AUTH) return this.#onAuth(r);
    if (type === T_DATA) return this.#onData(bytes, r);
    throw new SessionError('unknown frame');
  }

  async #onHello(r) {
    if (this.state !== 'hello-sent') throw new SessionError('unexpected HELLO');
    if (r.u8() !== VERSION) throw new SessionError('peer runs an incompatible protocol version');
    this.peerEphPub = r.raw(65);
    this.peerNonce = r.raw(32);
    r.end();
    this.peerEph = await C.importEphemeralPublic(this.peerEphPub); // rejects off-curve points
    const O = this.isOfferer;
    this.transcript = await C.labeledHash('murmur/hs/v1',
      O ? this.identity.publicRaw : this.peerIdentityRaw,
      O ? this.peerIdentityRaw : this.identity.publicRaw,
      O ? this.localFp : this.remoteFp,
      O ? this.remoteFp : this.localFp,
      O ? this.ephPub : this.peerEphPub,
      O ? this.peerEphPub : this.ephPub,
      O ? this.nonce : this.peerNonce,
      O ? this.peerNonce : this.nonce);
    const sig = await C.sign(this.identity.privateKey,
      concat(utf8('murmur/auth/v1'), Uint8Array.of(O ? 1 : 2), this.transcript));
    this.state = 'auth-sent';
    this.rawSend(concat(Uint8Array.of(T_AUTH), sig));
  }

  async #onAuth(r) {
    if (this.state !== 'auth-sent') throw new SessionError('unexpected AUTH');
    const sig = r.raw(64); r.end();
    const peerRole = this.isOfferer ? 2 : 1;
    const ok = await C.verify(this.peerIdentityKey, sig,
      concat(utf8('murmur/auth/v1'), Uint8Array.of(peerRole), this.transcript));
    if (!ok) throw new SessionError('Peer failed to prove its identity — possible interception. Connection closed.');
    const shared = await C.ecdh(this.eph.privateKey, this.peerEph);
    const okm = await C.hkdf(shared, this.transcript, 'murmur/keys/v1', 96);
    shared.fill(0);
    this.#installKeys(okm, 0);
    this.eph = null; // ephemeral private key dropped → forward secrecy
    this.state = 'ready';
    this.lastRekey = Date.now();
    this.onready();
  }

  #installKeys(okm, epoch) {
    this.root = okm.slice(0, 32);
    const o2a = okm.slice(32, 64), a2o = okm.slice(64, 96);
    okm.fill(0);
    this.epoch = epoch;
    this.nextSend = new Chain(this.isOfferer ? o2a : a2o, epoch);
    this.nextRecv = new Chain(this.isOfferer ? a2o : o2a, epoch);
    if (!this.send) this.send = this.nextSend;
    if (!this.recv) this.recv = this.nextRecv;
  }

  async #onData(bytes, r) {
    if (this.state !== 'ready') throw new SessionError('data before handshake');
    const epoch = r.u8(); const seq = r.u32();
    const chain = this.recv;
    if (epoch !== chain.epoch) throw new SessionError('unexpected key epoch');
    if (seq !== chain.seq) throw new SessionError(seq < chain.seq ? 'replayed message' : 'missing message');
    const { mk, next } = await chainStep(chain.ck);
    const { key, iv } = await messageKey(mk);
    let pt;
    try { pt = await C.aesGcmDecrypt(key, iv, bytes.subarray(6), bytes.subarray(0, 6)); }
    catch { throw new SessionError('message failed authentication — tampered'); }
    chain.ck = next; chain.seq++;
    const msg = JSON.parse(fromUtf8(unpad(pt)));
    this.msgCount++;
    if (msg.t === 'rekey') return this.#answerRekey(msg);
    if (msg.t === 'rekey-ack') return this.#finishRekey(msg);
    this.onmessage(msg);
    this.#maybeRekey();
  }

  /** Encrypt and send an application object. Resolves when handed to the channel. */
  sendMessage(obj) {
    if (this.state !== 'ready') return Promise.reject(new SessionError('session not ready'));
    const p = this.sendQ.then(() => this.#encryptAndSend(obj));
    this.sendQ = p.catch(() => {});
    p.then(() => { this.msgCount++; this.#maybeRekey(); }, () => {});
    return p;
  }

  async #encryptAndSend(obj) {
    if (this.state !== 'ready') throw new SessionError('session closed');
    const chain = this.send;
    const hdr = header(chain.epoch, chain.seq);
    const { mk, next } = await chainStep(chain.ck);
    const { key, iv } = await messageKey(mk);
    const ct = await C.aesGcmEncrypt(key, iv, pad(utf8(JSON.stringify(obj))), hdr);
    chain.ck = next; chain.seq++;
    this.rawSend(concat(hdr, ct));
  }

  // ---------- re-keying (DH ratchet step) ----------
  #maybeRekey() {
    if (!this.isOfferer || this.pendingRekey || this.state !== 'ready') return;
    if (this.msgCount >= this.rekeyEveryMessages || Date.now() - this.lastRekey >= this.rekeyEveryMs) this.rekey();
  }

  /** Offerer only. Pauses outgoing traffic until the answerer acknowledges. */
  rekey() {
    if (!this.isOfferer) return Promise.reject(new SessionError('only the offerer initiates re-keying'));
    if (this.pendingRekey) return this.pendingRekey.promise;
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    this.pendingRekey = { promise, resolve, reject };
    const job = this.sendQ.then(async () => {
      const eph = await C.generateEphemeral();
      this.pendingRekey.eph = eph;
      await this.#encryptAndSend({ t: 'rekey', eph: Array.from(await C.exportPublic(eph.publicKey)) });
      const newSend = await promise;    // queue blocks here → nothing sent under old keys after REKEY
      this.send = newSend;
    });
    this.sendQ = job.catch(() => {});
    return job;
  }

  async #deriveEpoch(myEph, peerRaw) {
    const peer = await C.importEphemeralPublic(Uint8Array.from(peerRaw));
    const shared = await C.ecdh(myEph.privateKey, peer);
    const epoch = (this.epoch + 1) & 0xff;
    const okm = await C.hkdf(shared, this.root, concat(utf8('murmur/rekey/v1'), Uint8Array.of(epoch)), 96);
    shared.fill(0); this.root.fill(0);
    this.#installKeys(okm, epoch);
  }

  async #answerRekey(msg) {
    if (this.isOfferer) throw new SessionError('answerer may not initiate re-key');
    const eph = await C.generateEphemeral();
    const myPub = Array.from(await C.exportPublic(eph.publicKey));
    await this.#deriveEpoch(eph, msg.eph);
    this.recv = this.nextRecv;          // offerer sends nothing more under the old epoch
    const newSend = this.nextSend;
    const job = this.sendQ.then(async () => {
      await this.#encryptAndSend({ t: 'rekey-ack', eph: myPub }); // last message under old send chain
      this.send = newSend;
    });
    this.sendQ = job.catch(() => {});
    await job;
    this.#rekeyed();
  }

  async #finishRekey(msg) {
    if (!this.isOfferer || !this.pendingRekey?.eph) throw new SessionError('unexpected re-key ack');
    await this.#deriveEpoch(this.pendingRekey.eph, msg.eph);
    this.recv = this.nextRecv;
    const p = this.pendingRekey; this.pendingRekey = null;
    p.resolve(this.nextSend);
    this.#rekeyed();
  }

  #rekeyed() { this.msgCount = 0; this.lastRekey = Date.now(); this.onrekey(this.epoch); }
}

/** Test helper: compare two Uint8Arrays safely. */
export const _equal = equal;
