// relay-smoke.mjs — check a deployed relay end to end, like a phone would.
//   node tools/relay-smoke.mjs https://relay.princeisgenius.com https://murmur.princeisgenius.com
// Uses a brand-new throwaway mailbox; reads/changes nothing else. Node 22+.
import { webcrypto as crypto } from 'node:crypto';

const RELAY = (process.argv[2] || 'https://relay.princeisgenius.com').replace(/\/$/, '');
const ORIGIN = process.argv[3] || 'https://murmur.princeisgenius.com';
const b64u = (u) => Buffer.from(u).toString('base64url');
const step = (n, msg) => console.log(`${n}. ${msg}`);
const fail = (msg) => { console.log(`   ✗ ${msg}`); process.exit(1); };

const secret = crypto.getRandomValues(new Uint8Array(32));
const label = new TextEncoder().encode('murmur/inbox/v1');
const buf = new Uint8Array(label.length + 1 + 32); buf.set(label); buf.set(secret, label.length + 1);
const addr = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));

step(1, `health check ${RELAY}/v1/health`);
try { const r = await fetch(`${RELAY}/v1/health`); console.log(`   → ${r.status} ${await r.text()}`); if (!r.ok) fail('relay not healthy'); }
catch (e) { fail(`cannot reach relay: ${e.cause?.code || e.message}`); }

step(2, 'open WebSocket to a throwaway mailbox');
const ws = new WebSocket(`${RELAY.replace(/^http/, 'ws')}/v1/inbox/${addr}`, { headers: { Origin: ORIGIN } });
ws.binaryType = 'arraybuffer';
const events = [];
let resolveNext; const next = () => new Promise((r) => { if (events.length) r(events.shift()); else resolveNext = r; });
const push = (e) => { if (resolveNext) { const r = resolveNext; resolveNext = null; r(e); } else events.push(e); };
ws.onmessage = (e) => push({ kind: 'msg', data: e.data });
ws.onclose = (e) => push({ kind: 'close', code: e.code, reason: e.reason });
ws.onerror = (e) => push({ kind: 'error', message: e.message || 'socket error' });
const timeout = (ms) => new Promise((r) => setTimeout(() => r({ kind: 'timeout' }), ms));
await new Promise((res) => { ws.onopen = res; setTimeout(res, 10000); });
if (ws.readyState !== 1) fail(`WebSocket did not open (state ${ws.readyState}) ${JSON.stringify(events)}`);
console.log('   → open');

step(3, 'log in to the mailbox (auth) and wait for "synced"');
ws.send(JSON.stringify({ t: 'auth', secret: b64u(secret) }));
let ev = await Promise.race([next(), timeout(10000)]);
console.log(`   → ${JSON.stringify(ev.kind === 'msg' ? { kind: 'msg', data: typeof ev.data === 'string' ? ev.data : `[${ev.data.byteLength} bytes]` } : ev)}`);
if (!(ev.kind === 'msg' && ev.data === '{"t":"synced"}')) fail('expected {"t":"synced"} — the relay rejected or crashed during auth');

step(4, 'keep-alive ping → pong');
ws.send('ping');
ev = await Promise.race([next(), timeout(10000)]);
console.log(`   → ${JSON.stringify(ev.kind === 'msg' ? { data: ev.data } : ev)}`);
if (!(ev.kind === 'msg' && ev.data === 'pong')) fail('no pong — the app would think the connection died every 30 s');

step(5, 'send a test message to the mailbox (POST) and receive it live');
const payload = crypto.getRandomValues(new Uint8Array(64));
const r = await fetch(`${RELAY}/v1/inbox/${addr}`, { method: 'POST', body: payload, headers: { Origin: ORIGIN, 'Content-Type': 'application/octet-stream' } });
console.log(`   → POST ${r.status}`);
if (r.status !== 201) fail(`deposit failed: ${await r.text()}`);
ev = await Promise.race([next(), timeout(10000)]);
if (ev.kind !== 'msg' || typeof ev.data === 'string') fail(`expected the message, got ${JSON.stringify(ev)}`);
const got = new Uint8Array(ev.data);
if (got.length !== 16 + 64 || Buffer.compare(Buffer.from(got.slice(16)), Buffer.from(payload)) !== 0) fail('received bytes differ');
console.log('   → received intact');

step(6, 'acknowledge (deletes it from the relay)');
ws.send(JSON.stringify({ t: 'ack', ids: [b64u(got.slice(0, 16))] }));
await new Promise((res) => setTimeout(res, 500));
ws.close();

step(7, 'calls: ask for TURN credentials (GET /v1/turn)');
const t = await fetch(`${RELAY}/v1/turn`, { headers: { Origin: ORIGIN } });
if (t.status !== 200) fail(`/v1/turn answered ${t.status} — is the latest relay deployed?`);
const tj = await t.json();
const urls = tj.iceServers.flatMap((x) => [].concat(x.urls));
console.log(`   → ${tj.turn ? 'TURN ON' : 'TURN OFF (STUN only)'}: ${urls.join(', ')}`);
if (!tj.turn) console.log(`   → why: ${tj.reason || 'unknown (relay is an older version — redeploy it)'}`);
if (!tj.turn) console.log('   ! Calls work on the same Wi-Fi and between most home networks, but phones on mobile data often\n     can\'t reach each other directly, and "Hide my IP" can\'t be honoured. Set TURN_KEY_ID and\n     TURN_KEY_API_TOKEN (see README → "Calls: switch on the TURN relay").');
if (urls.some((u) => /:53(\?|$)/.test(u))) fail('port 53 URLs should have been filtered out');

console.log('\nALL GOOD: the relay works end to end.');
process.exit(0);
