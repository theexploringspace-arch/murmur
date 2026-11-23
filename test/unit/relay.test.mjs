// Runs the REAL relay code (router.js + inbox.js) on a Node shim of the Durable Objects runtime.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../relay/node/server.mjs';
import { addressOf, RETENTION_MS, MAX_MESSAGE } from '../../relay/src/inbox.js';
import { inboxAddress, newInboxSecret } from '../../src/js/core/invite.js';
import { toB64u } from '../../src/js/core/bytes.js';

const ORIGIN = 'http://app.test';
const relay = await startRelay({ port: 0, origins: [ORIGIN] });
after(() => relay.server.close());

async function box() { const secret = newInboxSecret(); return { secret, addr: toB64u(await inboxAddress(secret)) }; }
const post = (addr, data, origin = ORIGIN) => fetch(`${relay.url}/v1/inbox/${addr}`, { method: 'POST', body: data, headers: { Origin: origin, 'Content-Type': 'application/octet-stream' } });

function connect(b, { auth = true, origin = ORIGIN } = {}) {
  const ws = new WebSocket(`${relay.url.replace('http', 'ws')}/v1/inbox/${b.addr}`, { headers: { Origin: origin } });
  ws.binaryType = 'arraybuffer';
  const got = []; let synced; const syncedP = new Promise((r) => (synced = r)); const waiters = [];
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') { if (JSON.parse(e.data).t === 'synced') synced(); return; }
    const u = new Uint8Array(e.data); got.push({ id: toB64u(u.slice(0, 16)), data: u.slice(16) });
    while (waiters.length) waiters.shift()();
  };
  const closed = new Promise((r) => (ws.onclose = (e) => r(e.code)));
  const opened = new Promise((r, j) => { ws.onopen = () => { if (auth) ws.send(JSON.stringify({ t: 'auth', secret: toB64u(b.secret) })); r(); }; ws.onerror = j; });
  return { ws, got, opened, syncedP, closed, next: () => new Promise((r) => waiters.push(r)), ack: (ids) => ws.send(JSON.stringify({ t: 'ack', ids })) };
}

test('address derivation matches between app and relay', async () => {
  const s = newInboxSecret();
  assert.equal(await addressOf(s), toB64u(await inboxAddress(s)));
});

test('offline delivery: messages wait, arrive in order on connect, and are deleted after ack', async () => {
  const b = await box();
  for (const t of ['one', 'two', 'three']) assert.equal((await post(b.addr, new TextEncoder().encode(t))).status, 201);
  const c = connect(b); await c.syncedP;
  assert.deepEqual(c.got.map((m) => new TextDecoder().decode(m.data)), ['one', 'two', 'three']);
  c.ack(c.got.map((m) => m.id)); await new Promise((r) => setTimeout(r, 50)); c.ws.close();
  const c2 = connect(b); await c2.syncedP;
  assert.equal(c2.got.length, 0, 'acked messages are gone from the relay');
  c2.ws.close();
});

test('live delivery: a connected owner gets new messages instantly; unacked ones are redelivered', async () => {
  const b = await box();
  const c = connect(b); await c.syncedP;
  const n = c.next(); await post(b.addr, Uint8Array.of(1, 2, 3)); await n;
  assert.deepEqual([...c.got[0].data], [1, 2, 3]);
  c.ws.close(); await c.closed;
  const c2 = connect(b); await c2.syncedP;
  assert.equal(c2.got.length, 1, 'not acked → still there (phone died before saving it)');
  c2.ws.close();
});

test('only the secret holder can read: wrong secret is disconnected and receives nothing', async () => {
  const b = await box(); await post(b.addr, Uint8Array.of(9));
  const thief = connect({ addr: b.addr, secret: newInboxSecret() });
  assert.equal(await thief.closed, 4001); assert.equal(thief.got.length, 0);
  const lurker = connect(b, { auth: false }); await lurker.opened;
  lurker.ws.send(JSON.stringify({ t: 'ack', ids: ['x'] }));
  assert.equal(await lurker.closed, 4001, 'cannot ack/delete without auth');
});

test('other websites cannot use the relay (Origin check on POST, preflight, and WebSocket)', async () => {
  const b = await box();
  assert.equal((await post(b.addr, Uint8Array.of(1), 'https://evil.example')).status, 403);
  const pre = await fetch(`${relay.url}/v1/inbox/${b.addr}`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  const ws = new WebSocket(`${relay.url.replace('http', 'ws')}/v1/inbox/${b.addr}`, { headers: { Origin: 'https://evil.example' } });
  await assert.rejects(new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('refused')); }));
});

test('limits: oversized and malformed requests are refused', async () => {
  const b = await box();
  assert.equal((await post(b.addr, new Uint8Array(MAX_MESSAGE + 1))).status, 413);
  assert.equal((await post(b.addr, new Uint8Array(0))).status, 413);
  assert.equal((await post('short', Uint8Array.of(1))).status, 404);
  assert.equal((await fetch(`${relay.url}/v1/inbox/${b.addr}`, { headers: { Origin: ORIGIN } })).status, 405);
});

test('30-day retention: old messages are erased by the alarm even if never collected', async () => {
  const b = await box();
  await post(b.addr, Uint8Array.of(1));
  const st = relay.env.INBOX.instance(b.addr);
  assert.ok(st.alarmAt > Date.now() + RETENTION_MS - 60_000, 'alarm armed ~30 days out');
  st.storage.sql.exec('UPDATE m SET at = ?', Date.now() - RETENTION_MS - 1000); // age it
  await st.runAlarm();
  assert.equal(st.obj.count(), 0);
});

test('the relay stores only opaque bytes: no plaintext metadata columns exist', async () => {
  const b = await box(); await post(b.addr, Uint8Array.of(7));
  const cols = relay.env.INBOX.instance(b.addr).storage.sql.exec("SELECT name FROM pragma_table_info('m')").toArray().map((r) => r.name);
  assert.deepEqual(cols.sort(), ['at', 'data', 'id', 'size']);
});
