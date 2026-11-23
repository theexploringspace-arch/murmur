// router.js — the Worker in front of the mailboxes. Stateless; keeps no logs.
//   POST /v1/inbox/<address>   deposit ciphertext (CORS-checked)
//   GET  /v1/inbox/<address>   WebSocket upgrade; the owner then proves the secret
//   GET  /v1/health
//   GET  /v1/turn              short-lived TURN credentials for calls (needs TURN_KEY_ID + TURN_KEY_API_TOKEN secrets)
import { ADDRESS_RE, MAX_MESSAGE } from './inbox.js';

export function allowed(env, origin) {
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return origin && list.includes(origin);
}
function cors(env, origin, extra = {}) {
  const h = { 'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra };
  if (allowed(env, origin)) { h['Access-Control-Allow-Origin'] = origin; h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'; h['Access-Control-Allow-Headers'] = 'Content-Type'; h['Access-Control-Max-Age'] = '86400'; }
  return h;
}

// Cloudflare's STUN is free and unlimited; it only tells a phone its own public address.
export const STUN_ONLY = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
const TURN_TTL = 3600; // credentials expire after an hour; a call keeps working once connected

/** Calls: hand out TURN credentials minted from the long-term key, which never leaves the relay. */
async function turn(request, env, origin) {
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: cors(env, origin, { 'Content-Type': 'application/json' }) });
  if (!allowed(env, origin)) return new Response('origin not allowed', { status: 403, headers: cors(env, origin) });
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: cors(env, origin) });
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ iceServers: STUN_ONLY, turn: false });
  // Each credential lets someone use bandwidth we pay for past the free tier: limit per address.
  if (env.TURN_LIMIT) {
    const { success } = await env.TURN_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) return json({ error: 'slow down' }, 429);
  }
  try {
    const r = await (env.fetch || fetch)(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL }),
    });
    if (!r.ok) throw new Error(`TURN API ${r.status}`);
    const { iceServers } = await r.json();
    // Browsers block port 53; without trickle ICE those URLs only add a timeout.
    const clean = [].concat(iceServers || []).map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) })).filter((s) => s.urls.length);
    if (!clean.some((s) => s.urls.some((u) => u.startsWith('turn')))) throw new Error('no TURN servers returned');
    return json({ iceServers: clean, turn: true, ttl: TURN_TTL });
  } catch {
    return json({ iceServers: STUN_ONLY, turn: false }); // calls still work where a direct path exists
  }
}

export async function route(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (url.pathname === '/v1/health') return new Response('ok', { headers: cors(env, origin) });
  if (url.pathname === '/v1/turn') return request.method === 'OPTIONS'
    ? new Response(null, { status: allowed(env, origin) ? 204 : 403, headers: cors(env, origin) })
    : turn(request, env, origin);
  const m = /^\/v1\/inbox\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if (!m || !ADDRESS_RE.test(m[1])) return new Response('not found', { status: 404, headers: cors(env, origin) });
  const addr = m[1];

  if (request.method === 'OPTIONS') return new Response(null, { status: allowed(env, origin) ? 204 : 403, headers: cors(env, origin) });
  // Browsers always send Origin on cross-origin POST and on WebSocket upgrades:
  // refuse anything that isn't the Murmur app (stops other sites using the relay).
  if (!allowed(env, origin)) return new Response('origin not allowed', { status: 403, headers: cors(env, origin) });

  const isWs = request.headers.get('Upgrade') === 'websocket';
  if (!isWs && request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors(env, origin) });
  if (!isWs) {
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_MESSAGE) return new Response('message too large', { status: 413, headers: cors(env, origin) });
  }
  const stub = env.INBOX.get(env.INBOX.idFromName(addr));
  const fwd = new Request(request, { headers: new Headers(request.headers) });
  fwd.headers.set('x-murmur-addr', addr);
  const res = await stub.fetch(fwd);
  if (isWs) return res;
  return new Response(res.body, { status: res.status, headers: cors(env, origin) });
}
