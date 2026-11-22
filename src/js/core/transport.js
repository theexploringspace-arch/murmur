// transport.js — a serverless WebRTC data channel.
//
// iceServers: []  → the browser gathers ONLY "host" candidates (its own LAN
// addresses). No STUN, no TURN: no packet is ever sent to a third party, and
// the connection can only form between devices on the same local network —
// e.g. a phone hotspot with mobile data switched off, or any offline Wi-Fi.
//
// The offer/answer descriptions are carried by the signed pairing codes
// (pairing.js), so there is no signaling server either.

export const GATHER_TIMEOUT_MS = 4000;
export const CONNECT_TIMEOUT_MS = 30000;
export const NETWORK_HELP = 'Both codes were scanned, but the phones could not open a direct link. Make sure both are on the SAME Wi-Fi or hotspot. Some Wi-Fi (hotels, cafés, some routers) blocks phones from talking to each other — a phone hotspot usually works.';
const RTC_CONFIG = { iceServers: [], iceCandidatePoolSize: 0, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };

function gathered(pc) {
  // Must be wired up BEFORE setLocalDescription, or the "complete" event can be missed.
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') done(); });
    pc.addEventListener('icecandidate', (e) => { if (!e.candidate) done(); });
  });
}

export class PeerLink {
  constructor() {
    this.pc = new RTCPeerConnection(RTC_CONFIG);
    // Pre-negotiated channel: both sides create it with the same id; no extra round trip.
    this.dc = this.pc.createDataChannel('murmur', { negotiated: true, id: 0, ordered: true });
    this.dc.binaryType = 'arraybuffer';
    this.dc.bufferedAmountLowThreshold = 256 * 1024;
    this.onmessage = () => {}; this.onclose = () => {};
    this.dc.onmessage = (e) => { if (e.data instanceof ArrayBuffer) this.onmessage(new Uint8Array(e.data)); };
    this.dc.onclose = () => this.#closed('channel closed');
    this.pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(this.pc.connectionState)) this.#closed(this.pc.connectionState);
    };
    this.isClosed = false;
  }

  #closed(reason) { if (this.isClosed) return; this.isClosed = true; this.onclose(reason); }

  /** Offerer step 1 → our local offer SDP (with all candidates inlined). */
  async createOffer() {
    const g = gathered(this.pc);
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await g;
    return this.pc.localDescription.sdp;
  }

  /** Answerer step 1 → our local answer SDP. */
  async acceptOffer(offerDesc) {
    await this.pc.setRemoteDescription(offerDesc);
    const g = gathered(this.pc);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await g;
    return this.pc.localDescription.sdp;
  }

  /** Offerer step 2. */
  async acceptAnswer(answerDesc) { await this.pc.setRemoteDescription(answerDesc); }

  /**
   * Resolves when the encrypted DTLS/SCTP channel is open.
   * @param {{timeout?: number, timeoutMessage?: string, failFast?: boolean}} o
   *   failFast: reject as soon as ICE reports 'failed'. Only safe once BOTH
   *   descriptions are set (the inviter after scanning the reply). The joiner
   *   must not fail fast: its checks start before the inviter has scanned and
   *   can transiently fail, then recover when the inviter's checks arrive.
   */
  opened({ timeout = CONNECT_TIMEOUT_MS, timeoutMessage = NETWORK_HELP, failFast = false } = {}) {
    if (this.dc.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (fn, arg) => { clearTimeout(t); this.pc.removeEventListener('iceconnectionstatechange', onIce); fn(arg); };
      const t = setTimeout(() => done(reject, new Error(timeoutMessage)), timeout);
      const onIce = () => { if (failFast && this.pc.iceConnectionState === 'failed') done(reject, new Error(NETWORK_HELP)); };
      this.pc.addEventListener('iceconnectionstatechange', onIce);
      this.dc.addEventListener('open', () => done(resolve), { once: true });
      this.dc.addEventListener('close', () => done(reject, new Error('Connection closed')), { once: true });
    });
  }

  send(bytes) {
    if (this.dc.readyState !== 'open') throw new Error('not connected');
    this.dc.send(bytes);
  }

  /** Wait until the outgoing buffer drains below the threshold (backpressure for files). */
  drained() {
    if (this.dc.bufferedAmount <= this.dc.bufferedAmountLowThreshold) return Promise.resolve();
    return new Promise((r) => this.dc.addEventListener('bufferedamountlow', r, { once: true }));
  }

  close() { try { this.dc.close(); } catch {} try { this.pc.close(); } catch {} this.#closed('closed by you'); }
}
