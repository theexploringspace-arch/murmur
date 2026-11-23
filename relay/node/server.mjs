// server.mjs — run the relay locally:  node relay/node/server.mjs --port 8787 --origin http://localhost:8080
// Same router.js + inbox.js code as production; only the runtime shim differs.
import { createServer } from 'node:http';
import { route, allowed } from '../src/router.js';
import { makeInbox, ADDRESS_RE } from '../src/inbox.js';
import { FakeNamespace, hibernatable } from './runtime.mjs';
import { acceptUpgrade } from './ws-lite.mjs';

export function startRelay({ port = 8787, host = '127.0.0.1', origins = [], env: extra = {} } = {}) {
  const env = { ALLOWED_ORIGINS: origins.join(','), ...extra };
  const Inbox = makeInbox(class { constructor() {} });
  env.INBOX = new FakeNamespace(Inbox, env);
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const r = await route(request, env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  server.on('upgrade', (req, socket) => {
    const m = /^\/v1\/inbox\/([A-Za-z0-9_-]{43})$/.exec(new URL(req.url, 'http://x').pathname);
    if (!m || !ADDRESS_RE.test(m[1]) || !allowed(env, req.headers.origin)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const conn = acceptUpgrade(req, socket);
    if (conn) env.INBOX.instance(m[1]).obj.accept(hibernatable(conn), m[1]);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, env, url: `http://${host}:${server.address().port}` })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  const { url } = await startRelay({ port: Number(arg('--port', 8787)), origins: arg('--origin', 'http://localhost:8080').split(',') });
  console.log(`Murmur relay (local) on ${url}`);
}
