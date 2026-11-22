#!/usr/bin/env node
// serve.mjs — tiny zero-dependency static server for dist/ (development & tests).
//
//   node tools/serve.mjs                 → http://localhost:8080  (this computer only)
//   node tools/serve.mjs --port 9000 --dir dist
//
// Why localhost only by default: browsers treat http://localhost as a secure
// context, so the camera, service worker and WebCrypto all work. Other phones
// on your Wi-Fi would reach http://192.168.x.x, which is NOT a secure context —
// camera and offline install would be blocked. For phones, host dist/ on any
// HTTPS static host (see README → "Put it on your phones").

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, arg('--dir', 'dist'));
const port = Number(arg('--port', 8080));
const host = arg('--host', '127.0.0.1');
// Test-only: imitate a host that injects a script into index.html (as Netlify's badge does).
const injectHost = process.argv.includes('--imitate-host-injection');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '': 'text/plain; charset=utf-8',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-cache',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (p === '' || p.endsWith(sep)) p += 'index.html';
    const file = join(dir, p);
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404, SECURITY_HEADERS).end('not found'); return; }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    let body = await readFile(file);
    if (injectHost && file.endsWith('index.html'))
      body = Buffer.from(body.toString().replace('</body>', '<script async src="/.host/badge.js"></script></body>'));
    res.end(body);
  } catch { res.writeHead(500).end(); }
});
server.listen(port, host, () => console.log(`Murmur → http://${host === '127.0.0.1' ? 'localhost' : host}:${port}  (serving ${dir})`));
export default server;
