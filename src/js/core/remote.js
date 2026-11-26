// remote.js — "Internet mode": talk to contacts who are far away, through the relay.
//
//   app message ─► Double Ratchet (ratchet.js) ─► envelope ─► POST relay/v1/inbox/<their address>
//   relay WebSocket (our inbox) ─► envelope ─► find contact by routing tag ─► ratchet decrypt ─► app
//
// The relay is untrusted. It only ever sees: our inbox address, the envelopes
// (version, day number, a routing tag that changes daily, ratchet header,
// padded ciphertext), timing, and IP addresses. Names, identity keys,
// mailbox addresses of senders and all content stay end-to-end encrypted.
//
// RELIABILITY RULES
//  • Decrypt → persist ratchet → THEN ack. If the phone dies in between, the
//    relay re-delivers and nothing is lost (a duplicate is rejected harmlessly).
//  • Sending offline works: the message is encrypted immediately and parked in an
//    encrypted outbox in the vault; it is posted as soon as the relay is reachable.
//  • Every ratchet operation runs through one queue, so two messages can never
//    race on the same chain key.

import { concat, Writer, Reader, toB64u, fromB64u, toHex, utf8, fromUtf8, equal } from './bytes.js';
import { labeledHash } from './crypto.js';
import { contactId } from './identity.js';
import { Ratchet } from './ratchet.js';
import * as INV from './invite.js';

const V = 1, KIND_MSG = 5, KIND_RESYNC = 6;
// KIND_RESYNC: [V, 6, invite]. Sent by a phone that was restored from a backup, whose ratchet
// state may be older than the conversation. The invite is signed by its identity key, so a
// contact accepts it only if that key is the one it already has for this person — nobody else
// can re-key a conversation. Never creates a contact. Replays are refused (created/id).
export const MAX_ENVELOPE = 1024 * 1024; // must match relay MAX_MESSAGE
const DAY = 86400_000;
const dayOf = (t) => Math.floor(t / DAY);

export class Remote {
  /**
   * @param {{vault, identity, relayUrl:string, origin:string, getName:()=>string,
   *          wsFactory?:(url:string)=>WebSocket, fetchImpl?:typeof fetch, now?:()=>number}} o
   */
  constructor(o) {
    Object.assign(this, { wsFactory: (u) => new WebSocket(u), fetchImpl: (...a) => fetch(...a), now: () => Date.now() }, o);
    this.relayUrl = o.relayUrl.replace(/\/$/, '');
    this.listeners = {}; this.ws = null; this.online = false; this.stopped = true; this.backoff = 1000;
    this.q = Promise.resolve(); this.tagCache = new Map();
  }
  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { for (const f of this.listeners[ev] || []) { try { f(...a); } catch (e) { console.error(e); } } }
  #serial(fn) { const p = this.q.then(fn, fn); this.q = p.catch(() => {}); return p; }

  async load() {
    let rec = await this.vault.getRecord('remote', null);
    if (!rec) { rec = { secret: toB64u(INV.newInboxSecret()), invites: [] }; await this.vault.putRecord('remote', rec); }
    this.rec = rec;
    this.secret = fromB64u(rec.secret);
    this.addressBytes = await INV.inboxAddress(this.secret);
    this.address = toB64u(this.addressBytes);
    this.peers = await this.vault.getRecord('remote/peers', {});      // cid → {pub, inbox, ratchet}
    // Outbox: a small index (who, where, which message) + ONE vault record per envelope.
    // Saving the whole queue as one record made every send rewrite every queued byte:
    // a 2-minute voice clip (15 chunks) re-encrypted ~75 MB on the phone and took minutes.
    const ob = await this.vault.getRecord('remote/outbox2', null);
    this.outbox = ob?.items || []; this.obNext = ob?.next || 0;      // [{seq, cid, to, mid}]
    const legacy = await this.vault.getRecord('remote/outbox', null);  // older builds: [{to, wire, mid, cid}]
    if (legacy?.length) {
      for (const o of legacy) await this.#enqueue({ cid: o.cid, to: o.to, mid: o.mid }, o.wire);
      await this.vault.deleteRecord('remote/outbox');
    }
    return this;
  }
  #savePeers() { return this.vault.putRecord('remote/peers', this.peers); }
  #saveRec() { return this.vault.putRecord('remote', this.rec); }
  #saveOutbox() { return this.vault.putRecord('remote/outbox2', { next: this.obNext, items: this.outbox }); }
  /** Park one envelope: write its bytes first, then the index that points at them. */
  async #enqueue(entry, wireB64) {
    const seq = this.obNext++;
    await this.vault.putRecord(`remote/ob/${seq}`, wireB64);
    this.outbox.push({ seq, ...entry });
    await this.#saveOutbox();
  }
  async #dequeue() {
    const o = this.outbox.shift();
    await this.#saveOutbox();                                  // index first: a crash here leaves an orphan, never a dangling pointer
    await this.vault.deleteRecord(`remote/ob/${o.seq}`);
  }

  has(cid) { return !!this.peers[cid]; }
  canSend(cid) { const p = this.peers[cid]; return !!p && (!!p.resync || Ratchet.fromJSON(p.ratchet).canSend); }
  /** Contacts still waiting to renew the secure link after a restore. */
  resyncing() { return Object.entries(this.peers).filter(([, p]) => p.resync).map(([cid]) => cid); }
  forget(cid) {
    return this.#serial(async () => {
      delete this.peers[cid];
      const gone = this.outbox.filter((o) => o.cid === cid);
      this.outbox = this.outbox.filter((o) => o.cid !== cid);
      await this.#savePeers(); await this.#saveOutbox();
      for (const o of gone) await this.vault.deleteRecord(`remote/ob/${o.seq}`);
    });
  }

  // ------------------------------------------------------------ connection
  start() {
    if (!this.stopped) return;
    this.stopped = false; this.#connect();
  }
  stop() {
    this.stopped = true; clearTimeout(this.retryT); clearInterval(this.pingT);
    try { this.ws?.close(1000, 'bye'); } catch {}
    this.ws = null; this.#setOnline(false);
  }
  /** Reconnect right away (e.g. the app came back to the foreground). */
  kick() { if (this.stopped || this.online || (this.ws && this.ws.readyState <= 1)) return; clearTimeout(this.retryT); this.backoff = 1000; this.#connect(); }
  #setOnline(v) { if (this.online !== v) { this.online = v; this.emit('status', v); } }
  #connect() {
    if (this.stopped) return;
    const url = `${this.relayUrl.replace(/^http/, 'ws')}/v1/inbox/${this.address}`;
    let ws;
    try { ws = this.wsFactory(url); } catch { return this.#retry(); }
    this.ws = ws; ws.binaryType = 'arraybuffer';
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'auth', secret: toB64u(this.secret) })); };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        if (e.data === 'pong') { this.lastPong = Date.now(); return; }
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'synced') { this.backoff = 1000; this.#setOnline(true); this.flush(); }
        return;
      }
      const u = new Uint8Array(e.data);
      if (u.length > 16) this.#serial(() => this.#receive(toB64u(u.slice(0, 16)), u.slice(16)));
    };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.#setOnline(false); clearInterval(this.pingT); this.#retry(); } };
    ws.onerror = () => {};
    // Liveness: a phone that loses signal often keeps a "zombie" socket for minutes.
    // Ping every 20 s; no pong within 10 s → treat as offline and reconnect.
    clearInterval(this.pingT);
    this.pingT = setInterval(() => {
      if (ws.readyState !== 1) return;
      const sent = Date.now();
      try { ws.send('ping'); } catch { return this.#drop(ws); }
      setTimeout(() => { if (this.ws === ws && (this.lastPong || 0) < sent) this.#drop(ws); }, 10_000);
    }, 20_000);
  }
  /** Declare a socket dead (no pong, failed POST) and start reconnecting. */
  #drop(ws = this.ws) {
    if (!ws || this.ws !== ws) return;
    this.ws = null; clearInterval(this.pingT);
    try { ws.close(4000, 'stale'); } catch {}
    this.#setOnline(false); this.#retry();
  }
  /** Resolves when every queued ratchet/vault operation has finished. */
  idle() { return this.q; }
  #retry() {
    if (this.stopped) return;
    clearTimeout(this.retryT);
    this.retryT = setTimeout(() => this.#connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }
  #ack(ids) { try { this.ws?.send(JSON.stringify({ t: 'ack', ids })); } catch {} }

  async #post(toB64, bytes) {
    if (bytes.length > MAX_ENVELOPE) throw new Error('message too large for the relay');
    let r;
    try { r = await this.fetchImpl(`${this.relayUrl}/v1/inbox/${toB64}`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' }, credentials: 'omit', referrerPolicy: 'no-referrer' }); }
    catch (e) { this.#drop(); throw e; } // network gone: the socket is probably a zombie too
    if (r.status === 507) throw Object.assign(new Error('Their mailbox is full'), { permanent: true });
    if (r.status === 413) throw Object.assign(new Error('Too large for the relay'), { permanent: true });
    if (!r.ok) throw new Error(`relay answered ${r.status}`);
  }

  /** Post everything parked in the outbox (oldest first). */
  flush() {
    return this.#serial(async () => {
      while (this.outbox.length) {
        const o = this.outbox[0];
        const wire = await this.vault.getRecord(`remote/ob/${o.seq}`, null);
        if (wire == null) { await this.#dequeue(); continue; } // bytes missing (wiped mid-write): nothing to send
        try { await this.#post(o.to, fromB64u(wire)); }
        catch (e) {
          if (!e.permanent) return; // offline: keep it, retry on next connect
          this.emit('send-failed', o.cid, o.mid, e.message);
        }
        await this.#dequeue();
        if (o.mid) this.emit('sent', o.cid, o.mid);
      }
    });
  }

  // ------------------------------------------------------------ routing tags
  async #tag(day, fromPub, toPub) {
    const k = `${day}:${toB64u(fromPub)}:${toB64u(toPub)}`;
    if (!this.tagCache.has(k)) {
      if (this.tagCache.size > 4096) this.tagCache.clear();
      this.tagCache.set(k, (await labeledHash('murmur/route/v1', fromPub, toPub, new Writer().u32(day).done())).slice(0, 16));
    }
    return this.tagCache.get(k);
  }

  // ------------------------------------------------------------ sending
  /** Encrypts now (even offline) and queues; resolves once queued. */
  send(cid, appMsg) {
    return this.#serial(async () => {
      const p = this.peers[cid];
      if (!p) throw new Error('No internet link with this contact yet');
      // After a restore: hold messages (encrypted at rest in the vault) until the link is renewed.
      if (p.resync) { if (appMsg.t !== 'ack') { (p.held ||= []).push(appMsg); await this.#savePeers(); } return 'held'; }
      const r = Ratchet.fromJSON(p.ratchet);
      if (!r.canSend) throw new Error('Waiting for their first message before you can write');
      const wire = await r.encrypt(utf8(JSON.stringify(appMsg)));
      const day = dayOf(this.now());
      const env = concat(new Writer().u8(V).u8(KIND_MSG).u32(day).done(), await this.#tag(day, this.identity.publicRaw, fromB64u(p.pub)), wire);
      p.ratchet = r.toJSON(); await this.#savePeers();   // ratchet advanced: persist BEFORE the bytes leave
      await this.#enqueue({ cid, to: p.inbox, mid: appMsg.t === 'ack' ? null : appMsg.id || null }, toB64u(env));
    }).then((v) => { if (this.online) this.flush(); return v; });
  }

  /** After restoring a backup: ask every contact to renew the secure link (see KIND_RESYNC). */
  resyncAll(origin = 'https://local.invalid') {
    return this.#serial(async () => {
      for (const [cid, p] of Object.entries(this.peers)) {
        const inv = await INV.createInvite({ identity: this.identity, name: this.getName(), inbox: this.addressBytes, now: this.now(), ttlS: INV.INVITE_TTL_S });
        const t = Math.floor(this.now() / 1000);
        this.rec.invites = [...this.rec.invites.filter((i) => i.expires > t), { ...inv.pending, resync: cid }].slice(-50);
        p.resync = { id: inv.pending.id, at: t };
        await this.#enqueue({ cid, to: p.inbox, mid: null }, toB64u(concat(Uint8Array.of(V, KIND_RESYNC), inv.bytes)));
      }
      await this.#saveRec(); await this.#savePeers();
    }).then(() => { if (this.online) this.flush(); });
  }

  // ------------------------------------------------------------ receiving
  async #receive(relayId, data) {
    try {
      if (INV.isJoin(data)) await this.#onJoin(data);
      else if (data[0] === V && data[1] === KIND_RESYNC) await this.#onResync(data.slice(2));
      else if (data[0] === V && data[1] === KIND_MSG && data.length > 22) await this.#onMessage(data);
    } catch (e) {
      // Before throwing a message away for good, ask whether this account has moved to another phone
      // (devices.js). If it has, the message is the OTHER phone's — leave it on the relay for it.
      // Without this, an old copy of the account silently deleted the new phone's messages.
      let theirs = false;
      try { theirs = !!(await this.beforeDrop?.()); } catch {}
      if (theirs) { this.emit('warning', 'Left a message for the phone this account moved to'); return; }
      this.emit('warning', `Dropped an undecryptable message (${e.message})`);
    }
    this.#ack([relayId]); // processed (or provably garbage): never redeliver
  }

  async #onMessage(data) {
    const r = new Reader(data); r.u8(); r.u8();
    const day = r.u32(), tag = r.raw(16), wire = data.slice(22);
    for (const [cid, p] of Object.entries(this.peers)) {
      if (!equal(await this.#tag(day, fromB64u(p.pub), this.identity.publicRaw), tag)) continue;
      const rat = Ratchet.fromJSON(p.ratchet);
      const pt = await rat.decrypt(wire);              // throws on forgery/replay: state untouched
      p.ratchet = rat.toJSON(); await this.#savePeers();
      let msg; try { msg = JSON.parse(fromUtf8(pt)); } catch { return; }
      if (msg && typeof msg.t === 'string') this.emit('message', cid, msg);
      return;
    }
    throw new Error('unknown sender');
  }

  /** A contact restored their phone and asks to renew the link. Only their KNOWN identity can. */
  async #onResync(inviteBytes) {
    const inv = await INV.parseInvite(inviteBytes, { now: this.now() });   // signature + expiry checked
    const cid = await contactId(inv.identityPub);
    const p = this.peers[cid];
    if (!p || !equal(fromB64u(p.pub), inv.identityPub)) throw new Error('resync from someone who is not a contact');
    const id = toHex(inv.inviteId);
    if (inv.created < (p.resyncAt || 0) || (p.resyncIds || []).includes(id)) throw new Error('replayed resync');
    const { join, ratchet, peer } = await INV.acceptInvite(inv, { identity: this.identity, name: this.getName(), inbox: this.addressBytes, now: this.now() });
    Object.assign(p, { ratchet: ratchet.toJSON(), inbox: toB64u(peer.inbox), resyncAt: inv.created, resyncIds: [...(p.resyncIds || []), id].slice(-10) });
    await this.#savePeers();
    await this.#enqueue({ cid, to: p.inbox, mid: null }, toB64u(join));
    this.emit('resynced', cid, { initiator: false });
    // A first message lets them write back immediately (the inviter side can't send first).
    queueMicrotask(() => this.send(cid, { t: 'hello', name: this.getName() }).catch(() => {}));
  }

  async #onJoin(data) {
    const id = INV.joinInviteId(data);
    const pending = this.rec.invites.find((i) => i.id === id);
    if (!pending) throw new Error('join for an unknown or already-used invite');
    const { ratchet, peer } = await INV.openJoin(data, pending, { identity: this.identity, now: this.now() });
    this.rec.invites = this.rec.invites.filter((i) => i.id !== id); // single use
    await this.#saveRec();
    const cid = await contactId(peer.identityPub);
    if (pending.resync) {
      // Our own renewal came back: only from the contact we asked, then release held messages.
      const p = this.peers[pending.resync];
      if (!p || cid !== pending.resync) throw new Error('renewal answered by someone else');
      const held = p.held || [];
      Object.assign(p, { ratchet: ratchet.toJSON(), inbox: toB64u(peer.inbox) }); delete p.resync; delete p.held;
      await this.#savePeers();
      this.emit('resynced', cid, { initiator: true, released: held.length });
      if (held.length) queueMicrotask(async () => { for (const m of held) await this.send(cid, m).catch(() => {}); });
      return;
    }
    this.peers[cid] = { pub: toB64u(peer.identityPub), inbox: toB64u(peer.inbox), ratchet: ratchet.toJSON() };
    await this.#savePeers();
    this.emit('joined', { cid, name: peer.name, pub: peer.identityPub, viaInvite: true });
  }

  // ------------------------------------------------------------ invites
  /** → { link, text, expires } to share by SMS/WhatsApp/email. */
  createInvite(origin, ttlS = INV.INVITE_TTL_S) {
    return this.#serial(async () => {
      const inv = await INV.createInvite({ identity: this.identity, name: this.getName(), inbox: this.addressBytes, now: this.now(), ttlS });
      const t = Math.floor(this.now() / 1000);
      this.rec.invites = [...this.rec.invites.filter((i) => i.expires > t), inv.pending].slice(-20);
      await this.#saveRec();
      return { link: INV.inviteLink(origin, inv.bytes), text: inv.text, bytes: inv.bytes, expires: inv.pending.expires };
    });
  }

  /** Preview an invite (no side effects). */
  async inspectInvite(textOrBytes) {
    const bytes = textOrBytes instanceof Uint8Array ? textOrBytes : INV.inviteBytesFromText(textOrBytes);
    const inv = await INV.parseInvite(bytes, { now: this.now() });
    return { inv, cid: await contactId(inv.identityPub), name: inv.name, pub: inv.identityPub };
  }

  /** Join someone's invite: post the join + a first hello so they can answer right away. */
  acceptInvite(inv, helloMsg) {
    return this.#serial(async () => {
      const { join, ratchet, peer } = await INV.acceptInvite(inv, { identity: this.identity, name: this.getName(), inbox: this.addressBytes, now: this.now() });
      const cid = await contactId(peer.identityPub);
      this.peers[cid] = { pub: toB64u(peer.identityPub), inbox: toB64u(peer.inbox), ratchet: ratchet.toJSON() };
      await this.#savePeers();
      await this.#enqueue({ cid, to: toB64u(peer.inbox), mid: null }, toB64u(join));
      return cid;
    }).then(async (cid) => { await this.send(cid, helloMsg); return cid; });
  }

  // ------------------------------------------------------------ in-person bootstrap
  // When two phones are already connected face to face (QR + live session), they
  // set up the internet link THROUGH that authenticated channel: no relay involved,
  // nothing to intercept, so the result is "verified".

  /** Offerer side: → bytes to send over the live session. */
  async liveOffer() { return (await this.createInvite('https://local.invalid', 15 * 60)).bytes; }

  /** Answerer side: must be given the live peer's key so a different identity can't sneak in. */
  liveAnswer(inviteBytes, livePeerPub, helloMsg) {
    return this.#serial(async () => {
      const inv = await INV.parseInvite(inviteBytes, { now: this.now() });
      if (!equal(inv.identityPub, livePeerPub)) throw new Error('internet setup came from a different identity');
      const { join, ratchet, peer } = await INV.acceptInvite(inv, { identity: this.identity, name: this.getName(), inbox: this.addressBytes, now: this.now() });
      const first = await ratchet.encrypt(utf8(JSON.stringify(helloMsg)));
      const cid = await contactId(peer.identityPub);
      this.peers[cid] = { pub: toB64u(peer.identityPub), inbox: toB64u(peer.inbox), ratchet: ratchet.toJSON() };
      await this.#savePeers();
      return { join, first };
    });
  }

  /** Offerer side, with the answer that came back over the live session. */
  liveFinish(join, first, livePeerPub) {
    return this.#serial(async () => {
      const id = INV.joinInviteId(join);
      const pending = this.rec.invites.find((i) => i.id === id);
      if (!pending) throw new Error('unknown internet setup');
      const { ratchet, peer } = await INV.openJoin(join, pending, { identity: this.identity, now: this.now() });
      if (!equal(peer.identityPub, livePeerPub)) throw new Error('internet setup came from a different identity');
      await ratchet.decrypt(first);
      this.rec.invites = this.rec.invites.filter((i) => i.id !== id); await this.#saveRec();
      const cid = await contactId(peer.identityPub);
      this.peers[cid] = { pub: toB64u(peer.identityPub), inbox: toB64u(peer.inbox), ratchet: ratchet.toJSON() };
      await this.#savePeers();
      return cid;
    });
  }
}

export const _internals = { dayOf, toHex };
