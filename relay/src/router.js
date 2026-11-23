// router.js — the Worker in front of the mailboxes. Stateless; keeps no logs.
//   POST /v1/inbox/<address>   deposit ciphertext (CORS-checked)
//   GET  /v1/inbox/<address>   WebSocket upgrade; the owner then proves the secret
//   GET  /v1/health
import { ADDRESS_RE, MAX_MESSAGE } from './inbox.js';

export function allowed(env, origin) {
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return origin && list.includes(origin);
}
function cors(env, origin, extra = {}) {
  const h = { 'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra };
  if (allowed(env, origin)) { h['Access-Control-Allow-Origin'] = origin; h['Access-Control-Allow-Methods'] = 'POST, OPTIONS'; h['Access-Control-Allow-Headers'] = 'Content-Type'; h['Access-Control-Max-Age'] = '86400'; }
  return h;
}

export async function route(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (url.pathname === '/v1/health') return new Response('ok', { headers: cors(env, origin) });
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
