// relaybox.js — use a relay mailbox as a tiny encrypted drop box (online backup, move-to-phone).
// Same relay, same rules as messages: the relay stores opaque bytes, deletes what the owner acks,
// and erases anything older than 30 days.
import { toB64u } from './bytes.js';
import { inboxAddress } from './invite.js';

const defaultWs = (url) => new WebSocket(url);

/** Read everything in the mailbox owned by `secret`. → [{ id, data }]. Optionally delete it (ack). */
export function readBox(relayUrl, secret, { ack = false, timeoutMs = 20_000, wsFactory = defaultWs } = {}) {
  return inboxAddress(secret).then((addr) => new Promise((resolve, reject) => {
    const ws = wsFactory(`${relayUrl.replace(/^http/, 'ws')}/v1/inbox/${toB64u(addr)}`);
    ws.binaryType = 'arraybuffer';
    const rows = [];
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('The relay didn’t answer — check your internet connection')); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', secret: toB64u(secret) }));
    ws.onerror = () => { clearTimeout(t); reject(new Error('Couldn’t reach the relay — check your internet connection')); };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t !== 'synced') return;
        clearTimeout(t);
        if (ack && rows.length) ws.send(JSON.stringify({ t: 'ack', ids: rows.map((r) => r.id) }));
        setTimeout(() => { try { ws.close(); } catch {} resolve(rows); }, ack && rows.length ? 400 : 0);
        return;
      }
      const u = new Uint8Array(e.data);
      rows.push({ id: toB64u(u.slice(0, 16)), data: u.slice(16) });
    };
  }));
}

/** Put chunks into the mailbox owned by `secret` (optionally emptying it first). */
export async function writeBox(relayUrl, secret, chunks, { replace = false, fetchImpl = fetch, wsFactory = defaultWs, onProgress = () => {} } = {}) {
  if (replace) await readBox(relayUrl, secret, { ack: true, wsFactory });
  const addr = toB64u(await inboxAddress(secret));
  let i = 0;
  for (const c of chunks) {
    const r = await fetchImpl(`${relayUrl}/v1/inbox/${addr}`, { method: 'POST', body: c, headers: { 'Content-Type': 'application/octet-stream' }, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (r.status === 507) throw new Error('The backup is too big for the relay (64 MB). Try without photos and files.');
    if (!r.ok) throw new Error(`The relay refused the backup (HTTP ${r.status})`);
    onProgress(++i, chunks.length);
  }
}
