// site-check.mjs — prove a deployed Murmur site serves EXACTLY what was built.
//   node tools/site-check.mjs https://murmur.princeisgenius.com
// Fetches every file listed in the site's SHA256SUMS the way a real browser would
// (browser User-Agent, navigation headers for the page) and compares hashes. Hosts
// and CDNs sometimes rewrite pages — analytics beacons, badges, "optimisations" —
// which is exactly what Murmur's integrity checks exist to catch. Also checks the
// security headers that only the host can send. Node 22+, read-only.
import { createHash } from 'node:crypto';

const SITE = (process.argv[2] || 'https://murmur.princeisgenius.com').replace(/\/$/, '');
const RELAY = process.argv[3] || 'https://relay.princeisgenius.com';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const NAV = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Accept-Language': 'en' };
const SUB = { 'User-Agent': UA, Accept: '*/*' };
const sha = (b) => createHash('sha256').update(b).digest('hex');
let problems = 0;
const bad = (m) => { problems++; console.log(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

console.log(`Checking ${SITE}\n`);
const sumsRes = await fetch(`${SITE}/SHA256SUMS`, { headers: SUB }).catch((e) => ({ ok: false, statusText: e.cause?.code || e.message }));
if (!sumsRes.ok) { console.log(`Cannot read ${SITE}/SHA256SUMS (${sumsRes.status || ''} ${sumsRes.statusText}). Is this a Murmur build?`); process.exit(2); }
const entries = (await sumsRes.text()).trim().split('\n').map((l) => l.split(/\s+/)).filter(([, p]) => p?.startsWith('./') && p !== './_headers');

console.log('1. Every file is byte-for-byte what was built');
for (const [hash, path] of entries) {
  const isPage = path === './index.html';
  const url = `${SITE}/${isPage ? '' : path.slice(2)}`;
  const res = await fetch(url, { headers: isPage ? NAV : SUB, redirect: 'manual' });
  if (res.status !== 200) { bad(`${path}: HTTP ${res.status}`); continue; }
  const body = Buffer.from(await res.arrayBuffer());
  if (sha(body) === hash) continue;
  const extra = [...body.toString('utf8').matchAll(/<script[^>]*>/g)].map((m) => m[0]).filter((t) => !t.includes('./js/app.js'));
  bad(`${path} was CHANGED by the host${extra.length ? ` — injected: ${extra.join(' ')}` : ''}`);
}
if (!problems) ok(`${entries.length} files match the build exactly`);

console.log('\n2. Security headers on the page');
const page = await fetch(`${SITE}/`, { headers: NAV });
const csp = page.headers.get('content-security-policy') || '';
const connect = /connect-src ([^;]+)/.exec(csp)?.[1] || '';
csp ? ok('Content-Security-Policy header present') : bad('no Content-Security-Policy header (is _headers deployed?)');
for (const o of [RELAY, RELAY.replace(/^https/, 'wss')]) connect.includes(o) ? ok(`connect-src allows ${o}`) : bad(`connect-src does NOT allow ${o} — internet mode will be blocked`);
/no-transform/.test(page.headers.get('cache-control') || '') ? ok('Cache-Control: no-transform (asks the CDN not to rewrite pages)') : bad('Cache-Control lacks no-transform');
/microphone=\(self\)/.test(page.headers.get('permissions-policy') || '') ? ok('microphone allowed for Murmur only (walkie-talkie)') : bad('Permissions-Policy blocks the microphone');
/geolocation=\(self\)/.test(page.headers.get('permissions-policy') || '') ? ok('location allowed for Murmur only') : bad('Permissions-Policy blocks location');

console.log(problems ? `\n${problems} PROBLEM(S) — see ✗ above.` : '\nALL GOOD: the site is exactly the tested build.');
process.exit(problems ? 1 : 0);
