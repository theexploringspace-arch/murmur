// relaybox.js — use a relay mailbox as a tiny encrypted drop box (online backup, move-to-phone).
// Same relay, same rules as messages: the relay stores opaque bytes, deletes what the owner acks,
// and erases anything older than 30 days.
import { toB64u } from './bytes.js';
import { inboxAddress } from './invite.js';

const defaultWs = (url) => new WebSocket(url);

/** The relay refused because this mailbox has a security PIN. state: 'required' | 'wrong' | 'locked'. */
export class PinError extends Error {
  constructor({ state, left = 0, until = 0 }) {
    super(state === 'required' ? 'Enter your security PIN' : state === 'locked' ? 'Too many wrong PINs' : 'Wrong PIN');
    Object.assign(this, { name: 'PinError', state, left, until });
  }
}

/** Open the mailbox owned by `secret` (with the PIN token, if it's gated). Resolves once the relay says
 *  everything stored was sent; `onSynced(ws, rows)` may keep using the socket. */
function openBox(relayUrl, secret, { pin = null, timeoutMs = 20_000, wsFactory = defaultWs, onSynced }) {
  return inboxAddress(secret).then((addr) => new Promise((resolve, reject) => {
    const ws = wsFactory(`${relayUrl.replace(/^http/, 'ws')}/v1/inbox/${toB64u(addr)}`);
    ws.binaryType = 'arraybuffer';
    const rows = [];
    let done = false;
    const fail = (e) => { if (done) return; done = true; clearTimeout(t); try { ws.close(); } catch {} reject(e); };
    const t = setTimeout(() => fail(new Error('The relay didn’t answer — check your internet connection')), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', secret: toB64u(secret), ...(pin ? { pin: toB64u(pin) } : {}) }));
    ws.onerror = () => fail(new Error('Couldn’t reach the relay — check your internet connection'));
    ws.onclose = () => fail(new Error('The relay closed the connection'));
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'pin') return fail(new PinError(m));
        // Let in with the right PIN, but the relay reports wrong PINs tried since: surface it.
        if (m.t === 'pinfails') { rows.pinFails = { n: m.n, last: m.last }; return; }
        if (m.t !== 'synced' || done) return;
        done = true; clearTimeout(t);
        onSynced(ws, rows, resolve, reject);
        return;
      }
      const u = new Uint8Array(e.data);
      rows.push({ id: toB64u(u.slice(0, 16)), data: u.slice(16) });
    };
  }));
}

/** Read everything in the mailbox owned by `secret`. → [{ id, data }]. Optionally delete it (ack). */
export function readBox(relayUrl, secret, { ack = false, pin = null, timeoutMs = 20_000, wsFactory = defaultWs } = {}) {
  return openBox(relayUrl, secret, { pin, timeoutMs, wsFactory, onSynced: (ws, rows, resolve) => {
    if (ack && rows.length) ws.send(JSON.stringify({ t: 'ack', ids: rows.map((r) => r.id) }));
    setTimeout(() => { try { ws.close(); } catch {} resolve(rows); }, ack && rows.length ? 400 : 0);
  } });
}

/** Set (verifier = base64url SHA-256 of the new token) or remove (verifier = null) a mailbox's PIN.
 *  `pin` is the CURRENT token if it already has one. */
export function gateBox(relayUrl, secret, verifier, { pin = null, timeoutMs = 20_000, wsFactory = defaultWs } = {}) {
  return openBox(relayUrl, secret, { pin, timeoutMs, wsFactory, onSynced: (ws, rows, resolve, reject) => {
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('The relay didn’t confirm the PIN change')); }, timeoutMs);
    ws.onclose = () => {};
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'gated') { clearTimeout(t); try { ws.close(); } catch {} resolve(m.on); }
    };
    ws.send(JSON.stringify(verifier ? { t: 'gate', v: verifier } : { t: 'ungate' }));
  } });
}

/** Put chunks into the mailbox owned by `secret` (optionally emptying it first). */
export async function writeBox(relayUrl, secret, chunks, { replace = false, pin = null, fetchImpl = fetch, wsFactory = defaultWs, onProgress = () => {} } = {}) {
  const old = replace ? await readBox(relayUrl, secret, { ack: true, pin, wsFactory }) : [];
  const addr = toB64u(await inboxAddress(secret));
  let i = 0;
  for (const c of chunks) {
    const r = await fetchImpl(`${relayUrl}/v1/inbox/${addr}`, { method: 'POST', body: c, headers: { 'Content-Type': 'application/octet-stream' }, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (r.status === 507) throw new Error('The backup is too big for the relay (64 MB). Try without photos and files.');
    if (!r.ok) throw new Error(`The relay refused the backup (HTTP ${r.status})`);
    onProgress(++i, chunks.length);
  }
  return { pinFails: old.pinFails || null };
}
