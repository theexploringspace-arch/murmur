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
console.log('\nALL GOOD: the relay works end to end.');
process.exit(0);
