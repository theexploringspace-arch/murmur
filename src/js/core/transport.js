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
export const CONNECT_TIMEOUT_MS = 25000;
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

  /** Resolves when the encrypted DTLS/SCTP channel is open. */
  opened(timeout = CONNECT_TIMEOUT_MS) {
    if (this.dc.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(
        'Could not reach your friend\'s phone. Make sure you are both on the SAME Wi-Fi or hotspot, then try again.')), timeout);
      this.dc.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      this.dc.addEventListener('close', () => { clearTimeout(t); reject(new Error('Connection closed')); }, { once: true });
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
