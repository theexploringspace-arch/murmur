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

test('calls: /v1/turn mints short-lived credentials server-side, filters port 53, rate-limits, and falls back to STUN', async () => {
  const calls = [];
  const fakeCf = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({ iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u1', credential: 'c1' },
    ] }), { status: 200 });
  };
  let n = 0; const limiter = { limit: async () => ({ success: ++n <= 2 }) };
  const r2 = await startRelay({ port: 0, origins: [ORIGIN], env: { TURN_KEY_ID: 'key123', TURN_KEY_API_TOKEN: 'secret-token', fetch: fakeCf, TURN_LIMIT: limiter } });
  try {
    const get = (origin = ORIGIN) => fetch(`${r2.url}/v1/turn`, { headers: { Origin: origin } });
    const res = await get(); assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.turn, true);
    assert.ok(!JSON.stringify(j).includes('secret-token'), 'the long-term key never reaches the phone');
    assert.ok(!JSON.stringify(j.iceServers).includes(':53'), 'port 53 removed');
    assert.deepEqual(j.iceServers[1].urls, ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp']);
    assert.equal(j.iceServers[1].username, 'u1');
    assert.deepEqual(calls[0], { url: 'https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/generate-ice-servers', auth: 'Bearer secret-token', body: { ttl: 3600 } });
    assert.equal((await get('https://evil.example')).status, 403, 'other sites can’t spend our TURN quota');
    assert.equal((await get()).status, 200);
    assert.equal((await get()).status, 429, 'rate limited');
  } finally { r2.server.close(); }
  // Not configured (or Cloudflare down): STUN only, and the app knows it.
  const plain = await (await fetch(`${relay.url}/v1/turn`, { headers: { Origin: ORIGIN } })).json();
  assert.deepEqual(plain, { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], turn: false, reason: 'not set up (missing TURN_KEY_ID and TURN_KEY_API_TOKEN)' });
  // A wrong token: the reason says so, and never echoes the token.
  const r3 = await startRelay({ port: 0, origins: [ORIGIN], env: { TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 'wrong-token', fetch: async () => new Response('no', { status: 401 }) } });
  try {
    const bad = await (await fetch(`${r3.url}/v1/turn`, { headers: { Origin: ORIGIN } })).json();
    assert.equal(bad.turn, false);
    assert.match(bad.reason, /refused the key \(HTTP 401\)/);
    assert.ok(!JSON.stringify(bad).includes('wrong-token'));
  } finally { r3.server.close(); }
});

// ---------------------------------------------------------------- security PIN (gated mailboxes)
import { pinWait, PIN_FREE } from '../../relay/src/inbox.js';
import { route } from '../../relay/src/router.js';

/** Open + auth (optionally with a PIN token) and collect every text frame until the socket closes or syncs. */
function session(b, pin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${relay.url.replace('http', 'ws')}/v1/inbox/${b.addr}`, { headers: { Origin: ORIGIN } });
    const texts = [];
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', secret: toB64u(b.secret), ...(pin ? { pin: toB64u(pin) } : {}) }));
    ws.onmessage = (e) => { if (typeof e.data !== 'string') return; const m = JSON.parse(e.data); texts.push(m); if (m.t === 'synced') resolve({ ws, texts, ok: true }); };
    ws.onclose = (e) => resolve({ ws, texts, ok: false, code: e.code });
  });
}
const sha = async (u8) => toB64u(new Uint8Array(await crypto.subtle.digest('SHA-256', u8)));
const reply = (ws, msg) => new Promise((r) => { ws.onmessage = (e) => { if (typeof e.data === 'string' && JSON.parse(e.data).t === 'gated') r(JSON.parse(e.data)); }; ws.send(JSON.stringify(msg)); });

test('PIN wait schedule: 4 tries, then 1 min, 10 min, 1 h, 6 h, 24 h and stays at 24 h', () => {
  assert.equal(PIN_FREE, 4);
  assert.deepEqual([1, 2, 3].map(pinWait), [0, 0, 0]);
  assert.deepEqual([4, 5, 6, 7, 8, 9, 50].map(pinWait), [60e3, 600e3, 3600e3, 6 * 3600e3, 86400e3, 86400e3, 86400e3]);
  // 1,000,000 PINs at ~1 try/day after the first few ≈ 1,370 years on average to hit it.
});

test('gated mailbox: needs the PIN, counts wrong tries, makes you wait, resets on success, can be removed', async () => {
  const b = await box();
  const good = new Uint8Array(32).fill(7), bad = new Uint8Array(32).fill(8);
  await post(b.addr, new TextEncoder().encode('sealed backup'));
  // Owner gates it (no PIN yet → plain auth works).
  let s = await session(b); assert.equal(s.ok, true);
  assert.deepEqual(await reply(s.ws, { t: 'gate', v: await sha(good) }), { t: 'gated', on: true }); s.ws.close();

  // No PIN → refused, not counted.
  s = await session(b);
  assert.equal(s.ok, false); assert.equal(s.code, 4003); assert.deepEqual(s.texts, [{ t: 'pin', state: 'required' }]);
  // Wrong PIN → refused BEFORE any stored row is sent; tries left counts down.
  const real = Date.now; let now = real();
  Date.now = () => now;
  try {
    for (const left of [3, 2, 1, 0]) {
      s = await session(b, bad);
      assert.equal(s.ok, false);
      assert.equal(s.texts[0].state, 'wrong'); assert.equal(s.texts[0].left, left);
    }
    assert.equal(s.texts[0].until, now + 60_000, '4th wrong try (0 left) → wait 1 minute');
    // During the wait even the RIGHT PIN is refused, and the refusal isn't counted.
    s = await session(b, good);
    assert.deepEqual(s.texts[0], { t: 'pin', state: 'locked', until: now + 60_000 });
    now += 61_000;
    s = await session(b, bad);
    const lastWrong = now;
    assert.equal(s.texts[0].until, now + 600_000, '5th wrong → 10 minutes');
    now += 601_000;
    // Right PIN: in — and the owner is TOLD how many wrong tries there were (someone knows the passphrase).
    s = await session(b, good);
    assert.equal(s.ok, true);
    assert.deepEqual(s.texts.find((m) => m.t === 'pinfails'), { t: 'pinfails', n: 5, last: lastWrong });
    s.ws.close();
    // …but the count is NOT reset by the owner's success (that would give an attacker a fresh ladder
    // every time the owner's phone refreshes its backup): the next wrong try waits 1 hour.
    s = await session(b, bad);
    assert.equal(s.texts[0].until, now + 3600_000, '6th wrong → 1 hour, despite the right PIN in between');
    // After a quiet week the count fades.
    now += 8 * 86400_000;
    s = await session(b, good); assert.equal(s.texts.some((m) => m.t === 'pinfails'), false, 'old tries aren’t reported forever'); s.ws.close();
    s = await session(b, bad);
    assert.equal(s.texts[0].left, 3, 'a week later the count starts again');
    // Malformed token: counted as wrong, never crashes the object.
    s = await new Promise((resolve) => {
      const ws = new WebSocket(`${relay.url.replace('http', 'ws')}/v1/inbox/${b.addr}`, { headers: { Origin: ORIGIN } });
      const texts = []; ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', secret: toB64u(b.secret), pin: '!!not base64!!' }));
      ws.onmessage = (e) => texts.push(JSON.parse(e.data)); ws.onclose = () => resolve({ texts });
    });
    assert.equal(s.texts[0].state, 'wrong');
    // The owner removes the PIN; plain auth works again.
    s = await session(b, good); assert.equal(s.ok, true);
    assert.deepEqual(await reply(s.ws, { t: 'ungate' }), { t: 'gated', on: false }); s.ws.close();
    s = await session(b); assert.equal(s.ok, true); s.ws.close();
  } finally { Date.now = real; }
});

test('gate commands need an authenticated socket, and a gate value must be a 32-byte hash', async () => {
  const b = await box();
  const c = connect(b, { auth: false }); await c.opened;
  c.ws.send(JSON.stringify({ t: 'gate', v: 'A'.repeat(43) }));
  assert.equal(await c.closed, 4001);
  const s = await session(b); assert.equal(s.ok, true);
  s.ws.send(JSON.stringify({ t: 'gate', v: 'short' }));           // ignored
  await new Promise((r) => setTimeout(r, 100)); s.ws.close();
  const again = await session(b); again.ws.close();
  assert.equal(again.ok, true, 'still ungated');
});

test('mailbox opens are rate-limited per IP when the limiter is configured (429 before touching the mailbox)', async () => {
  let touched = false;
  const env = { ALLOWED_ORIGINS: ORIGIN, INBOX_LIMIT: { limit: async ({ key }) => ({ success: key !== '203.0.113.9' }) },
    INBOX: { idFromName: (n) => n, get: () => ({ fetch: async () => { touched = true; return new Response(null, { status: 200 }); } }) } };
  const req = (ip) => new Request(`https://relay.test/v1/inbox/${'A'.repeat(43)}`, { headers: { Origin: ORIGIN, Upgrade: 'websocket', 'CF-Connecting-IP': ip } });
  assert.equal((await route(req('203.0.113.9'), env)).status, 429);
  assert.equal(touched, false);
  assert.equal((await route(req('198.51.100.1'), env)).status, 200);
  assert.equal(touched, true);
});

test('security review: 20 PIN guesses sent AT ONCE still only get 4 real tries (checks are serialised)', async () => {
  const b = await box();
  const good = new Uint8Array(32).fill(1);
  let s = await session(b);
  await reply(s.ws, { t: 'gate', v: await sha(good) }); s.ws.close();
  const guesses = await Promise.all(Array.from({ length: 20 }, (_, i) => session(b, new Uint8Array(32).fill(100 + i))));
  const states = guesses.map((g) => g.texts[0]?.state);
  assert.equal(states.filter((x) => x === 'wrong').length, 4, `got ${JSON.stringify(states)}`);
  assert.equal(states.filter((x) => x === 'locked').length, 16);
  // Even the RIGHT PIN is refused during the wait the burst triggered.
  assert.equal((await session(b, good)).texts[0].state, 'locked');
});

test('security review: a socket that never authenticates is closed after AUTH_TIMEOUT_MS', async () => {
  const b = await box();
  const idle = connect(b, { auth: false }); await idle.opened;
  const real = Date.now; const t0 = real();
  Date.now = () => t0 + 11_000;
  try {
    const other = connect(b, { auth: false }); await other.opened; // a new connection sweeps old ones
    assert.equal(await idle.closed, 4008);
    other.ws.close();
  } finally { Date.now = real; }
});
