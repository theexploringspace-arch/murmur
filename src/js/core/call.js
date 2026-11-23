// call.js — one voice or video call, peer to peer over WebRTC.
//
// Signaling (offer/answer/hang-up) travels as { t: 'call' } messages inside Murmur's existing
// end-to-end encrypted channel — nearby (data channel) or via the relay. The SDP carries each
// phone's DTLS fingerprint, and since that SDP is authenticated by the ratchet, nobody in the
// middle (not the relay, not a TURN server) can substitute their own: the media is end-to-end
// encrypted (DTLS-SRTP) between the two phones.
//
// Connectivity, in order of preference:
//   nearby, no internet  → host candidates on the shared Wi-Fi/hotspot
//   internet, "hide IP"  → TURN relay only (the other person never sees your IP)
//   internet, direct ok  → STUN-discovered direct path, TURN as fallback

export const CALL_KINDS = new Set(['offer', 'answer', 'end', 'decline', 'busy', 'unavailable']);
export const RING_TIMEOUT_MS = 45_000;
export const GATHER_TIMEOUT_MS = 3_000;
export const RECONNECT_GRACE_MS = 10_000;
const ID_RE = /^[0-9a-f]{16,32}$/;

/** Strict validation of an incoming call signal. → sanitized, or null. */
export function readSignal(m) {
  if (!m || m.t !== 'call' || typeof m.id !== 'string' || !ID_RE.test(m.id) || !CALL_KINDS.has(m.k)) return null;
  const out = { id: m.id, k: m.k };
  if (m.k === 'offer' || m.k === 'answer') {
    if (typeof m.sdp !== 'string' || m.sdp.length > 40_000 || !m.sdp.startsWith('v=0')) return null;
    out.sdp = m.sdp;
  }
  if (m.k === 'offer') out.video = m.video === true;
  return out;
}

/**
 * Should an incoming call ring? Enforced by the RECEIVER, whatever the caller's app shows.
 * → 'ring' | 'unavailable' (calls of this kind are off, or this person is blocked) | 'busy'
 */
export function callDecision({ settings = {}, contact, video, busy }) {
  if (!contact || contact.request || contact.noCalls) return 'unavailable';
  const calls = settings.calls || {};
  if ((video ? calls.video : calls.voice) === false) return 'unavailable';
  return busy ? 'busy' : 'ring';
}

/** Which call buttons to show for a contact (they told us what they accept). */
export function callButtons(contact) {
  if (!contact || contact.request) return { voice: false, video: false };
  const c = contact.calls || {};
  return { voice: c.voice !== false, video: c.video !== false };
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function gathered(pc) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') done(); });
    pc.addEventListener('icecandidate', (e) => { if (!e.candidate) done(); });
  });
}

export class Call {
  /**
   * @param o.id        call id (hex)
   * @param o.peer      contact id
   * @param o.outgoing  true if we placed it
   * @param o.video     video call?
   * @param o.ice       { iceServers, relayOnly }
   * @param o.send      (signal) => Promise — delivers { t:'call', ... } to the peer
   * @param o.getMedia  (constraints) => Promise<MediaStream>
   */
  constructor({ id, peer, outgoing, video, ice = { iceServers: [] }, send, getMedia = (c) => navigator.mediaDevices.getUserMedia(c) }) {
    Object.assign(this, { id, peer, outgoing, video, ice, send, getMedia });
    this.state = outgoing ? 'calling' : 'ringing';
    this.muted = false; this.cameraOff = false; this.facing = 'user';
    this.local = null; this.remote = new MediaStream();
    this.connectedAt = 0; this.ended = false;
    this.listeners = {};
    this.ringTimer = setTimeout(() => this.#finish(this.outgoing ? 'no answer' : 'missed', true), RING_TIMEOUT_MS);
  }
  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); return this; }
  #emit(ev, ...a) { for (const fn of this.listeners[ev] || []) { try { fn(...a); } catch (e) { console.warn(e); } } }
  #set(state) { if (this.ended) return; this.state = state; this.#emit('state', state); }

  async #media() {
    const video = this.video ? { facingMode: this.facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } : false;
    this.local = await this.getMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video });
    this.#emit('local', this.local);
  }
  #peer() {
    const pc = this.pc = new RTCPeerConnection({
      iceServers: this.ice.iceServers || [],
      iceTransportPolicy: this.ice.relayOnly ? 'relay' : 'all',
      bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require',
    });
    for (const t of this.local.getTracks()) pc.addTrack(t, this.local);
    pc.ontrack = (e) => { if (!this.remote.getTracks().includes(e.track)) this.remote.addTrack(e.track); this.#emit('remote', this.remote); };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        clearTimeout(this.graceTimer);
        if (!this.connectedAt) this.connectedAt = Date.now();
        this.#set('connected');
      } else if (s === 'disconnected') {
        this.#set('reconnecting');
        clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => this.#finish('connection lost', true), RECONNECT_GRACE_MS);
      } else if (s === 'failed') this.#finish(this.connectedAt ? 'connection lost' : 'could not connect', true);
    };
    return pc;
  }

  /** Caller: get the mic/camera, make the offer, send it. */
  async start() {
    try {
      await this.#media();
      if (this.ended) return this.#stopLocal();
      const pc = this.#peer();
      const g = gathered(pc);
      await pc.setLocalDescription(await pc.createOffer());
      await g;
      if (this.ended) return;
      await this.send({ t: 'call', id: this.id, k: 'offer', sdp: pc.localDescription.sdp, video: this.video });
    } catch (e) { this.#finish(e.name === 'NotAllowedError' ? 'no permission' : 'failed', true, e); }
  }
  /** Callee: accept the offer we were given. */
  async accept(offerSdp) {
    if (this.ended) return;
    clearTimeout(this.ringTimer);
    this.#set('connecting');
    try {
      await this.#media();
      const pc = this.#peer();
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      const g = gathered(pc);
      await pc.setLocalDescription(await pc.createAnswer());
      await g;
      if (this.ended) return;
      await this.send({ t: 'call', id: this.id, k: 'answer', sdp: pc.localDescription.sdp });
    } catch (e) { this.#finish(e.name === 'NotAllowedError' ? 'no permission' : 'failed', true, e); }
  }
  decline() { this.#finish('declined', true, null, 'decline'); }
  hangup() { this.#finish(this.connectedAt ? 'ended' : this.outgoing ? 'cancelled' : 'declined', true); }

  /** Signals from the other phone. */
  async onSignal(s) {
    if (this.ended || s.id !== this.id) return;
    if (s.k === 'answer' && this.outgoing && this.pc && this.pc.signalingState === 'have-local-offer') {
      clearTimeout(this.ringTimer);
      this.#set('connecting');
      try { await this.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp }); } catch (e) { this.#finish('failed', true, e); }
    } else if (s.k === 'end') this.#finish(this.connectedAt ? 'ended' : this.outgoing ? 'no answer' : 'missed', false);
    else if (s.k === 'decline') this.#finish('declined', false);
    else if (s.k === 'busy') this.#finish('busy', false);
    else if (s.k === 'unavailable') this.#finish('unavailable', false);
  }

  setMuted(on) { this.muted = on; for (const t of this.local?.getAudioTracks() || []) t.enabled = !on; this.#emit('controls'); }
  setCameraOff(on) { this.cameraOff = on; for (const t of this.local?.getVideoTracks() || []) t.enabled = !on; this.#emit('controls'); }
  async flipCamera() {
    if (!this.video || !this.pc) return;
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    const s = await this.getMedia({ video: { facingMode: this.facing, width: { ideal: 640 }, height: { ideal: 480 } } });
    const nt = s.getVideoTracks()[0]; if (!nt) return;
    nt.enabled = !this.cameraOff;
    const sender = this.pc.getSenders().find((x) => x.track?.kind === 'video');
    await sender?.replaceTrack(nt);
    for (const t of this.local.getVideoTracks()) { this.local.removeTrack(t); t.stop(); }
    this.local.addTrack(nt);
    this.#emit('local', this.local);
  }

  #stopLocal() { for (const t of this.local?.getTracks() || []) t.stop(); }
  #finish(reason, tellPeer, err, kind = 'end') {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.ringTimer); clearTimeout(this.graceTimer);
    if (tellPeer) this.send({ t: 'call', id: this.id, k: kind }).catch(() => {});
    this.#stopLocal();
    try { this.pc?.close(); } catch { /* already closed */ }
    this.state = 'ended';
    this.#emit('end', { reason, duration: this.connectedAt ? Date.now() - this.connectedAt : 0, error: err?.message });
  }
}
