// conversation.js — one live, end-to-end encrypted connection to one contact.
//
//   PeerLink (WebRTC data channel, DTLS)  ⇄  SecureSession (Murmur E2E)  ⇄  app messages
//
// Pairing flows (no server — the QR codes ARE the signaling):
//   Inviter:  createInvite() → show QR → acceptReply(scannedBytes) → connected
//   Joiner:   joinInvite(scannedBytes) → show reply QR → connected
//
// App message types (all inside the encrypted session):
//   hello  {name, app}                     — display name after handshake
//   msg    {id, ts, text, ttl}             — text message; ttl = seconds until both sides delete
//   ack    {id}                            — delivered
//   typing {on}
//   file   {id, ts, name, mime, size, sha, chunks, ttl} then chunk {id, i, d}
//   bye    {}                              — polite disconnect

import { PeerLink } from './transport.js';
import { SecureSession } from './session.js';
import { createPairingCode, parsePairingCode, PairingError } from './pairing.js';
import { sdpFingerprint } from './sdp.js';
import { toB64u, fromB64u, random, toHex, equal } from './bytes.js';
import { sha256 } from './crypto.js';

export const MAX_TEXT = 8000;
export const MAX_FILE = 25 * 1024 * 1024;
const CHUNK = 8 * 1024;
const HANDSHAKE_TIMEOUT = 15000;
export const APP_VERSION = '1.0.0';

export const newId = () => toHex(random(8));

export class Conversation {
  /** @param {{identity, name:string}} me */
  constructor(me) {
    this.me = me;
    this.link = new PeerLink();
    this.state = 'idle'; // idle → waiting-reply | waiting-connect → handshaking → connected → closed
    this.peer = null;    // { publicRaw, name }
    this.listeners = {};
    this.incomingFiles = new Map();
    this.link.onclose = (why) => this.#close(why);
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { for (const f of this.listeners[ev] || []) { try { f(...a); } catch (e) { console.error(e); } } }

  // ---------- pairing ----------
  async createInvite() {
    this.role = 'offerer';
    this.localSdp = await this.link.createOffer();
    this.inviteBytes = await createPairingCode({ kind: 'offer', identity: this.me.identity, name: this.me.name, sdp: this.localSdp });
    this.state = 'waiting-reply';
    return this.inviteBytes;
  }

  /** @param {Uint8Array} replyBytes @param {Uint8Array=} expectKey if reconnecting to a known contact */
  async acceptReply(replyBytes, expectKey = null) {
    if (this.state !== 'waiting-reply') throw new PairingError('No invite is waiting for a reply');
    const p = await parsePairingCode(replyBytes, { expectKind: 'answer', offerBytes: this.inviteBytes });
    this.#checkPeer(p, expectKey);
    this.peer = { publicRaw: p.publicRaw, name: p.name };
    await this.link.acceptAnswer(p.description);
    return this.#secure(p.description.sdp);
  }

  /** Joiner: returns the reply-code bytes to show; connection completes in the background (await .connected). */
  async joinInvite(inviteBytes, expectKey = null) {
    this.role = 'answerer';
    const p = await parsePairingCode(inviteBytes, { expectKind: 'offer' });
    if (equal(p.publicRaw, this.me.identity.publicRaw)) throw new PairingError('That is your own invite code');
    this.#checkPeer(p, expectKey);
    this.peer = { publicRaw: p.publicRaw, name: p.name };
    this.localSdp = await this.link.acceptOffer(p.description);
    const reply = await createPairingCode({ kind: 'answer', identity: this.me.identity, name: this.me.name, sdp: this.localSdp, offerBytes: p.bytes });
    this.state = 'waiting-connect';
    this.connected = this.#secure(p.description.sdp);
    this.connected.catch(() => {});
    return { reply, peer: this.peer };
  }

  #checkPeer(p, expectKey) {
    if (expectKey && !equal(p.publicRaw, expectKey))
      throw new PairingError('This code is from a different person than the contact you are reconnecting to.');
  }

  async #secure(remoteSdp) {
    this.session = new SecureSession({
      role: this.role, identity: this.me.identity, peerIdentityRaw: this.peer.publicRaw,
      localFingerprint: sdpFingerprint(this.localSdp), remoteFingerprint: sdpFingerprint(remoteSdp),
      send: (b) => this.link.send(b),
    });
    this.link.onmessage = (b) => this.session.receive(b);
    const ready = new Promise((resolve, reject) => {
      this.session.onready = resolve;
      this.session.onerror = (e) => { reject(e); this.emit('error', e); this.close(); };
    });
    this.session.onmessage = (m) => this.#onApp(m);
    this.session.onrekey = (epoch) => this.emit('rekey', epoch);
    await this.link.opened();
    this.state = 'handshaking';
    await this.session.start();
    let t;
    await Promise.race([ready, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('Secure handshake timed out')), HANDSHAKE_TIMEOUT); })])
      .finally(() => clearTimeout(t));
    this.state = 'connected';
    await this.session.sendMessage({ t: 'hello', name: this.me.name, app: APP_VERSION });
    this.emit('connected', this.peer);
    return this.peer;
  }

  // ---------- sending ----------
  async sendText(text, ttl = 0) {
    text = String(text);
    if (!text.trim()) return null;
    if (text.length > MAX_TEXT) throw new Error(`Message too long (max ${MAX_TEXT} characters)`);
    const m = { t: 'msg', id: newId(), ts: Date.now(), text, ttl: ttl | 0 };
    await this.#send(m);
    return m;
  }

  setTyping(on) { if (this.state === 'connected') this.session.sendMessage({ t: 'typing', on: !!on }).catch(() => {}); }

  /** @param {File|Blob} file @param {(sent:number,total:number)=>void} progress */
  async sendFile(file, ttl = 0, progress = () => {}) {
    if (file.size > MAX_FILE) throw new Error(`File too large (max ${MAX_FILE / 1048576} MB)`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const meta = {
      t: 'file', id: newId(), ts: Date.now(), name: String(file.name || 'file').slice(0, 120),
      mime: String(file.type || 'application/octet-stream').slice(0, 100), size: bytes.length,
      sha: toB64u(await sha256(bytes)), chunks: Math.ceil(bytes.length / CHUNK) || 1, ttl: ttl | 0,
    };
    await this.#send(meta);
    for (let i = 0; i < meta.chunks; i++) {
      await this.link.drained();
      await this.#send({ t: 'chunk', id: meta.id, i, d: toB64u(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)) });
      progress(Math.min(bytes.length, (i + 1) * CHUNK), bytes.length);
    }
    return { ...meta, blob: new Blob([bytes], { type: meta.mime }) };
  }

  #send(m) {
    if (this.state !== 'connected') return Promise.reject(new Error('Not connected'));
    return this.session.sendMessage(m);
  }

  // ---------- receiving ----------
  #onApp(m) {
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'hello':
        if (typeof m.name === 'string') this.peer.liveName = m.name.slice(0, 40);
        this.emit('hello', m);
        break;
      case 'msg':
        if (typeof m.text !== 'string' || m.text.length > MAX_TEXT || typeof m.id !== 'string') return;
        this.emit('message', { id: m.id.slice(0, 32), ts: +m.ts || Date.now(), text: m.text, ttl: Math.max(0, m.ttl | 0) });
        this.session.sendMessage({ t: 'ack', id: m.id }).catch(() => {});
        break;
      case 'ack': this.emit('ack', String(m.id)); break;
      case 'typing': this.emit('typing', !!m.on); break;
      case 'file': {
        if (!(m.size >= 0 && m.size <= MAX_FILE) || !(m.chunks >= 1 && m.chunks <= Math.ceil(MAX_FILE / CHUNK) + 1)) return;
        if (this.incomingFiles.size >= 4) return; // bound memory
        this.incomingFiles.set(m.id, { meta: m, parts: [], got: 0 });
        this.emit('file-start', m);
        break;
      }
      case 'chunk': {
        const f = this.incomingFiles.get(m.id);
        if (!f || m.i !== f.parts.length) return;
        const d = fromB64u(String(m.d));
        f.got += d.length;
        if (f.got > f.meta.size) { this.incomingFiles.delete(m.id); return; }
        f.parts.push(d);
        this.emit('file-progress', m.id, f.got, f.meta.size);
        if (f.parts.length === f.meta.chunks) this.#finishFile(f);
        break;
      }
      case 'bye': this.close('peer left'); break;
      default: break; // ignore unknown types (forward compatibility)
    }
  }

  async #finishFile(f) {
    this.incomingFiles.delete(f.meta.id);
    const blob = new Blob(f.parts, { type: f.meta.mime });
    const hash = toB64u(await sha256(new Uint8Array(await blob.arrayBuffer())));
    if (hash !== f.meta.sha) { this.emit('error', new Error(`File "${f.meta.name}" failed its integrity check`)); return; }
    this.emit('file', { id: String(f.meta.id), ts: +f.meta.ts || Date.now(), name: String(f.meta.name), mime: String(f.meta.mime), size: blob.size, ttl: Math.max(0, f.meta.ttl | 0), blob });
    this.session.sendMessage({ t: 'ack', id: f.meta.id }).catch(() => {});
  }

  // ---------- teardown ----------
  close(why = 'closed') {
    if (this.state === 'closed' || this.state === 'closing') return;
    const finish = () => { this.#close(why); this.link.close(); };
    if (this.state === 'connected') {
      this.state = 'closing'; // let the encrypted "bye" leave before tearing down
      this.session.sendMessage({ t: 'bye' }).catch(() => {}).finally(() => setTimeout(finish, 60));
    } else finish();
  }
  #close(why) {
    if (this.state === 'closed') return;
    const was = this.state;
    this.state = 'closed';
    this.session?.close();
    this.incomingFiles.clear();
    this.emit('closed', why, was);
  }
}
