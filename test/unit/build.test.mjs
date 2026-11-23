// Build-output tests: the service worker refuses to install if ANY precached
// file is missing or differs from its recorded hash — which silently disables
// offline mode. These tests make that failure loud at build time instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = mkdtempSync(join(tmpdir(), 'murmur-build-'));
execFileSync(process.execPath, [join(root, 'tools/build.mjs'), '--out', out], { stdio: 'pipe' });
const sw = readFileSync(join(out, 'sw.js'), 'utf8');
const precache = JSON.parse(sw.slice(sw.indexOf('const FILES = ') + 14, sw.indexOf('; // {')));
const sha = (b) => createHash('sha256').update(b).digest('hex');

test('every precached file exists in the build with exactly the recorded hash', () => {
  assert.ok(Object.keys(precache).length > 20);
  for (const [p, want] of Object.entries(precache)) {
    const f = join(out, p);
    assert.ok(existsSync(f), `${p} is precached but missing from the build`);
    assert.equal(sha(readFileSync(f)), want, `${p} hash mismatch`);
  }
});

test('host config files are deployed but never precached (Netlify/Cloudflare do not serve them)', () => {
  assert.ok(existsSync(join(out, '_headers')), '_headers must still be deployed');
  for (const p of Object.keys(precache)) assert.doesNotMatch(p, /\/_(headers|redirects)$/);
});

test('the app shell and offline-critical files are precached', () => {
  for (const p of ['./index.html', './js/app.js', './js/core/session.js', './js/qr/worker.js', './css/app.css', './manifest.webmanifest', './build-info.json'])
    assert.ok(p in precache, `${p} must be precached`);
});

test('the fingerprint covers the offline engine (template + precache list)', () => {
  const sums = readFileSync(join(out, 'SHA256SUMS'), 'utf8');
  assert.match(sums, /  sw\.template\.js\n/);
  assert.match(sums, /  sw-precache-list\n/);
  const info = JSON.parse(readFileSync(join(out, 'build-info.json'), 'utf8'));
  assert.equal(info.sha256, sha(sums));
  assert.match(info.fingerprint, /^([0-9a-f]{4}-){7}[0-9a-f]{4}$/);
});

test('the build is reproducible: same source → same fingerprint', () => {
  const out2 = mkdtempSync(join(tmpdir(), 'murmur-build-'));
  execFileSync(process.execPath, [join(root, 'tools/build.mjs'), '--out', out2], { stdio: 'pipe' });
  const a = JSON.parse(readFileSync(join(out, 'build-info.json'), 'utf8')).fingerprint;
  const b = JSON.parse(readFileSync(join(out2, 'build-info.json'), 'utf8')).fingerprint;
  assert.equal(a, b);
});

test('the CSP header (_headers) and the <meta> CSP allow exactly the same things', () => {
  // Browsers enforce BOTH. If one forgets an origin (e.g. the relay), that feature is
  // silently blocked in production — this happened once, so it is now a test.
  const parse = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean)
    .map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v.sort().join(' ')]; }));
  const meta = parse(/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(readFileSync(join(root, 'src/index.html'), 'utf8'))[1]);
  const header = parse(/Content-Security-Policy:\s*(.+)/.exec(readFileSync(join(root, 'src/_headers'), 'utf8'))[1]);
  delete header['frame-ancestors']; // only valid in a header; the meta tag can't carry it
  assert.deepEqual(header, meta);
  const relay = /RELAY_URL = '([^']+)'/.exec(readFileSync(join(root, 'src/js/config.js'), 'utf8'))[1];
  for (const origin of [relay, relay.replace(/^https/, 'wss')]) assert.ok(meta['connect-src'].split(' ').includes(origin), `connect-src allows ${origin}`);
});
