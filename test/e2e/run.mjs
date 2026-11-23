#!/usr/bin/env node
// End-to-end tests in a real Chromium: two isolated browser profiles (Alice & Bob)
// pair, chat, send a file, lock/unlock, go fully offline, and reconnect —
// while a network guard proves nothing ever leaves localhost.
//
// Requirements: Playwright + a Chromium. Point at a browser with CHROME_PATH if needed.
//   npm i -D playwright && npx playwright install chromium   (one-time, needs internet)
//   npm run build && npm run test:e2e

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let chromium;
for (const p of ['playwright', '/opt/npm-tools/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(p)); break; } catch {}
}
if (!chromium) { console.log('SKIP e2e: playwright not installed (npm i -D playwright)'); process.exit(0); }
const CHROME = process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const PORT = 8765 + Math.floor(Math.random() * 500);
const ORIGIN = `http://localhost:${PORT}`;

// Local relay (same code as production, Node runtime shim) — the app is built to use it.
const { startRelay } = await import('../../relay/node/server.mjs');
const relay = await startRelay({ port: 0, origins: [ORIGIN] });
const RELAY = relay.url; // http://127.0.0.1:<port>
execFileSync(process.execPath, [join(root, 'tools/build.mjs'), '--relay', RELAY], { stdio: 'inherit' });
const server = spawn(process.execPath, [join(root, 'tools/serve.mjs'), '--port', String(PORT)], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));

const leaks = [];
let strict = false;       // when true, even requests to our own server are blocked + recorded
const strictHits = [];
async function profile(browser, name) {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 400, height: 820 } });
  // Network guard: anything not to our local origin is blocked AND recorded.
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (strict && !u.startsWith('blob:') && !u.startsWith('data:')) { strictHits.push(`${name}: ${u}`); return route.abort(); }
    if (u.startsWith(ORIGIN) || u.startsWith(RELAY) || u.startsWith('blob:') || u.startsWith('data:')) return route.continue();
    leaks.push(`${name}: ${u}`); return route.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  // Browser-generated network notices (a WebSocket that can't connect while offline) are expected, not app errors.
  page.on('console', (m) => { if (m.type() === 'error' && !/Camera|getUserMedia|NotFoundError|Requested device not found|WebSocket connection to .* failed/i.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto(ORIGIN + '/');
  return { ctx, page, errors, name };
}

const tid = (id) => `[data-testid="${id}"]`;

async function onboard(p, name, pass) {
  await p.page.click(tid('get-started'));
  await p.page.fill(tid('name'), name);
  await p.page.fill(tid('pass1'), pass);
  await p.page.fill(tid('pass2'), pass);
  await p.page.click(tid('create'));
  await p.page.waitForSelector(tid('invite'), { timeout: 30000 });
}

async function pairByText(inviter, joiner, { inviteBtn = 'invite', joinBtn = 'join' } = {}) {
  await inviter.page.click(tid(inviteBtn));
  await inviter.page.waitForFunction((s) => document.querySelector(s)?.value?.startsWith('mur1.'), tid('invite-code'), { timeout: 15000 });
  const invite = await inviter.page.$eval(tid('invite-code'), (e) => e.value);
  await joiner.page.click(tid(joinBtn));
  await joiner.page.click('details summary');
  await joiner.page.fill(tid('paste-invite'), invite);
  await joiner.page.click(tid('paste-invite-go'));
  await joiner.page.waitForFunction((s) => document.querySelector(s)?.value?.startsWith('mur1.'), tid('reply-code'), { timeout: 15000 });
  const reply = await joiner.page.$eval(tid('reply-code'), (e) => e.value);
  await inviter.page.click('details summary');
  await inviter.page.fill(tid('paste-reply'), reply);
  await inviter.page.click(tid('paste-reply-go'));
  for (const p of [inviter, joiner]) await p.page.waitForSelector(`${tid('conn-state')}[data-online="true"]`, { timeout: 30000 });
  return { invite, reply };
}

async function send(p, text) {
  await p.page.fill(tid('compose'), text);
  await p.page.click(tid('send'));
}
const lastIn = (p) => p.page.$$eval(`${tid('log')} ${tid('msg-in')} .text`, (els) => els.map((e) => e.textContent));

test('Murmur end-to-end', { timeout: 240000 }, async (t) => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-fake-ui-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  const A = await profile(browser, 'alice');
  const B = await profile(browser, 'bob');
  try {
    await t.test('onboarding creates encrypted vaults', async () => {
      await onboard(A, 'Alice', 'correct horse battery staple');
      await onboard(B, 'Bob', 'tr0ub4dor & 3 bananas');
    });

    await t.test('pairing with signed codes, no server', async () => {
      const { invite, reply } = await pairByText(A, B);
      assert.ok(invite.length < 700 && reply.length < 700, `codes are compact (${invite.length}/${reply.length} chars)`);
    });

    await t.test('messages both ways, delivery receipts, HTML is inert', async () => {
      const evil = 'Hello Bob <img src=x onerror="window.__pwned=1"> 😀';
      await send(A, evil);
      await B.page.waitForFunction((s) => document.querySelectorAll(s).length >= 1, `${tid('msg-in')}`);
      assert.deepEqual(await lastIn(B), [evil]);
      assert.equal(await B.page.$$eval(`${tid('log')} img`, (x) => x.length), 0, 'no <img> created from text');
      assert.equal(await B.page.evaluate(() => window.__pwned), undefined);
      await send(B, 'Hi Alice — line one\nline two');
      await A.page.waitForFunction((s) => document.querySelector(s), tid('msg-in'));
      assert.deepEqual(await lastIn(A), ['Hi Alice — line one\nline two']);
      await A.page.waitForFunction(() => document.querySelector('[data-testid="msg-out"] .status')?.textContent === '✓✓', null, { timeout: 5000 });
    });

    await t.test('burst of 150 messages arrives complete and in order (crosses re-key epochs)', async () => {
      await A.page.evaluate(async () => {
        const c = document.querySelector('[data-testid="compose"]'), s = document.querySelector('[data-testid="send"]');
        for (let i = 0; i < 150; i++) { c.value = `m${i}`; s.click(); await new Promise((r) => setTimeout(r, 5)); }
      });
      await B.page.waitForFunction(() => document.querySelectorAll('[data-testid="msg-in"]').length >= 151, null, { timeout: 30000 });
      const got = (await lastIn(B)).slice(1);
      assert.deepEqual(got, Array.from({ length: 150 }, (_, i) => `m${i}`));
    });

    await t.test('encrypted file transfer with integrity check', async () => {
      // a real 64×64 PNG, ~ few KB, plus a 300 KB binary blob to exercise chunking
      const png = Buffer.from(await A.page.evaluate(async () => {
        const c = new OffscreenCanvas(64, 64); const g = c.getContext('2d');
        g.fillStyle = '#0d9488'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#fff'; g.fillRect(16, 16, 32, 32);
        return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())];
      }));
      await A.page.setInputFiles(tid('file-input'), { name: 'pic.png', mimeType: 'image/png', buffer: png });
      await A.page.click(tid('modal-send'));
      await B.page.waitForSelector(`${tid('msg-in')} img.attach`, { timeout: 15000 });
      const big = Buffer.alloc(300 * 1024); for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 255;
      await A.page.setInputFiles(tid('file-input'), { name: 'data.bin', mimeType: 'application/octet-stream', buffer: big });
      await A.page.click(tid('modal-send'));
      await B.page.waitForFunction(() => [...document.querySelectorAll('button.file')].some((a) => a.textContent.includes('data.bin')), null, { timeout: 20000 });
      const sum = await B.page.evaluate(async () => {
        const a = [...document.querySelectorAll('button.file')].find((x) => x.textContent.includes('data.bin'));
        const b = new Uint8Array(await (await fetch(a.dataset.blob)).arrayBuffer());
        let s = 0; for (const x of b) s = (s * 31 + x) >>> 0; return [b.length, s];
      });
      let s = 0; for (const x of big) s = (s * 31 + x) >>> 0;
      assert.deepEqual(sum, [big.length, s]);
    });

    await t.test('safety numbers match on both phones', async () => {
      await A.page.click(tid('contact-info')); await B.page.click(tid('contact-info'));
      const get = (p) => p.page.waitForFunction((s) => /^\d{5}( \d{5}){11}$/.test(document.querySelector(s)?.textContent || '') && document.querySelector(s).textContent, tid('safety-number')).then((h) => h.jsonValue());
      const [sa, sb] = await Promise.all([get(A), get(B)]);
      assert.equal(sa, sb);
      await A.page.click(tid('back')); await B.page.click(tid('back'));
    });

    await t.test('data at rest is ciphertext; private key non-extractable', async () => {
      const raw = await A.page.evaluate(async () => {
        const db = await new Promise((r) => { const q = indexedDB.open('murmur'); q.onsuccess = () => r(q.result); });
        const all = await new Promise((r) => { const q = db.transaction('kv').objectStore('kv').getAll(); q.onsuccess = () => r(q.result); });
        const dec = new TextDecoder('latin1');
        return JSON.stringify(all, (_, v) => (v instanceof Uint8Array ? dec.decode(v) : v));
      });
      for (const needle of ['Bob', 'Hello', 'Alice', 'm149']) assert.ok(!raw.includes(needle), `"${needle}" must not appear in storage`);
    });

    await t.test('strict CSP + Trusted Types are enforced', async () => {
      // NB: Playwright's evaluate() itself runs with DevTools privileges (exempt from CSP
      // eval checks), so we probe the sinks a page script would actually hit.
      const r = await A.page.evaluate(async () => {
        const out = {};
        try { document.body.insertAdjacentHTML('beforeend', '<b>x</b>'); out.html = 'allowed'; } catch { out.html = 'blocked'; }
        try { setTimeout('window.__strEval = 1', 0); } catch {}
        await new Promise((res) => setTimeout(res, 50));
        out.stringTimer = window.__strEval ? 'allowed' : 'blocked';
        try { trustedTypes.createPolicy('evil', { createHTML: (x) => x }); out.rogue = 'allowed'; } catch { out.rogue = 'blocked'; }
        try { const s = document.createElement('script'); s.src = 'https://example.com/x.js'; document.head.append(s); out.extScript = 'appended'; }
        catch { out.extScript = 'blocked'; }
        return out;
      });
      assert.deepEqual(r, { html: 'blocked', stringTimer: 'blocked', rogue: 'blocked', extScript: 'blocked' });
      await A.page.waitForTimeout(200);
      // the deliberate probes above must have been reported as violations, then we reset the logs
      const v = await A.page.evaluate(() => window.__csp.splice(0));
      assert.ok(v.length >= 1, 'violations were reported');
      A.errors.length = 0; leaks.length = 0; // the external <script> probe was blocked and recorded by the guard
    });

    await t.test('lock wipes keys from memory; wrong passphrase counted; unlock restores contacts', async () => {
      await A.page.click(tid('back'));
      await A.page.click(tid('lock'));
      await A.page.waitForSelector(tid('unlock-pass'));
      await B.page.waitForSelector(`${tid('conn-state')}[data-online="false"]`, { timeout: 10000 });
      await A.page.fill(tid('unlock-pass'), 'not the passphrase');
      await A.page.click(tid('unlock'));
      await A.page.waitForFunction(() => /tries left/.test(document.querySelector('.error')?.textContent || ''));
      // Bob keeps writing while Alice is locked: it goes through the relay (set up
      // automatically when they paired face to face) and waits for her.
      await B.page.waitForSelector(`${tid('conn-state')}[data-kind="internet"]`, { timeout: 15000 });
      await send(B, 'written while you were locked');
      await A.page.fill(tid('unlock-pass'), 'correct horse battery staple');
      await A.page.click(tid('unlock'));
      await A.page.waitForSelector(tid('contact-Bob'));
      await A.page.click(tid('contact-Bob'));
      await A.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-in"] .text')].some((e) => e.textContent === 'written while you were locked'), null, { timeout: 15000 });
      await B.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-out"]')].at(-1)?.querySelector('.status')?.textContent === '✓✓', null, { timeout: 15000 });
      await A.page.click(tid('back'));
    });

    await t.test('fully offline: app reloads from service worker and reconnects', async () => {
      await A.page.evaluate(() => navigator.serviceWorker.ready);
      await B.page.evaluate(() => navigator.serviceWorker.ready);
      await A.ctx.setOffline(true); await B.ctx.setOffline(true);
      await A.page.reload(); await B.page.reload();
      await A.page.waitForSelector(tid('unlock-pass'));
      await B.page.waitForSelector(tid('unlock-pass'));
      assert.ok(await A.page.evaluate(() => !!navigator.serviceWorker.controller), 'served by service worker');
      for (const [p, pw] of [[A, 'correct horse battery staple'], [B, 'tr0ub4dor & 3 bananas']]) {
        await p.page.fill(tid('unlock-pass'), pw); await p.page.click(tid('unlock'));
        await p.page.waitForSelector(tid('contact-Alice') + ',' + tid('contact-Bob'));
      }
      // Chrome's emulated "offline" also kills loopback WebRTC, which real offline
      // (hotspot, no internet) does not. So: lift emulation but BLOCK EVERY HTTP
      // request — even to our own server — and prove the app makes none.
      await A.ctx.setOffline(false); await B.ctx.setOffline(false);
      strict = true;
      // Reconnect a KNOWN contact: Alice uses the chat's reconnect button.
      await A.page.click(tid('contact-Bob'));
      await pairByText(A, B, { inviteBtn: 'reconnect-invite', joinBtn: 'join' });
      assert.equal(await B.page.$$eval('[data-testid^="contact-"]', (x) => x.length).catch(() => 0) <= 1, true);
      await send(B, 'offline and still talking');
      await A.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-in"] .text')].some((e) => e.textContent === 'offline and still talking'));
      await B.page.click(tid('back'));
      assert.equal(await B.page.$$eval('[data-testid^="contact-"]', (x) => x.length), 1, 'known contact recognised, not duplicated');
      strict = false;
      // The relay may be *tried* (internet mode retries in the background); the app itself
      // must be served entirely from the phone, and nearby chat must not need any server.
      assert.deepEqual(strictHits.filter((u) => !u.includes(RELAY)), [], 'app made zero HTTP requests to its host while reconnecting and chatting');
    });

    await t.test('panic wipe erases everything', async () => {
      await B.page.click(tid('settings'));
      await B.page.click(tid('panic'));
      await B.page.click(tid('modal-true'));
      await B.page.waitForSelector(tid('get-started'));
      const dbs = await B.page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
      assert.ok(!dbs.includes('murmur') || (await B.page.evaluate(async () => {
        const db = await new Promise((r) => { const q = indexedDB.open('murmur'); q.onsuccess = () => r(q.result); });
        if (!db.objectStoreNames.contains('kv')) return true;
        return new Promise((r) => { const q = db.transaction('kv').objectStore('kv').count(); q.onsuccess = () => r(q.result === 0); });
      })));
    });

    await t.test('no network requests left localhost; no CSP violations; no page errors', async () => {
      assert.deepEqual(leaks, []);
      for (const p of [A, B]) {
        assert.deepEqual(await p.page.evaluate(() => window.__csp), [], `${p.name} CSP violations`);
        assert.deepEqual(p.errors, [], `${p.name} errors`);
      }
    });
  } finally {
    await browser.close();
  }
});

test('QR camera path: each phone scans the other\'s screen', { timeout: 180000 }, async (t) => {
  // Chrome's fake camera plays a .y4m file. We screenshot one phone's QR,
  // turn it into a video frame, and feed it to the other phone's camera.
  const dir = mkdtempSync(join(tmpdir(), 'murmur-cam-'));
  let havePy = true;
  try { execFileSync('python3', ['-c', 'import cv2, numpy'], { stdio: 'ignore' }); } catch { havePy = false; }
  if (!havePy) { t.skip('python3 + opencv needed to synthesise camera frames'); return; }
  const toY4m = (png, out) => execFileSync('python3', ['-I', '-c', `
import cv2, numpy as np, sys
img = cv2.imread(sys.argv[1]) if sys.argv[1] != 'BLANK' else np.full((100, 100, 3), 255, np.uint8)
h, w = 720, 1280
canvas = np.full((h, w, 3), 245, np.uint8)
s = min(h * 0.8 / img.shape[0], w * 0.8 / img.shape[1]); img = cv2.resize(img, None, fx=s, fy=s)
y0, x0 = (h - img.shape[0]) // 2, (w - img.shape[1]) // 2
canvas[y0:y0+img.shape[0], x0:x0+img.shape[1]] = img
yuv = cv2.cvtColor(canvas, cv2.COLOR_BGR2YUV_I420)
with open(sys.argv[2], 'wb') as f:
    f.write(f"YUV4MPEG2 W{w} H{h} F10:1 Ip A1:1 C420jpeg\\n".encode())
    for _ in range(10): f.write(b"FRAME\\n"); f.write(yuv.tobytes())
`, png, out]);
  const camA = join(dir, 'camA.y4m'), camB = join(dir, 'camB.y4m');
  // placeholder frames so Chrome can open the devices
  toY4m('BLANK', camA);

  const launch = (cam) => chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${cam}`, '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const bA = await launch(camA);
  const A = await profile(bA, 'alice-cam');
  await onboard(A, 'Alice', 'correct horse battery staple');
  await A.page.click(tid('invite'));
  await A.page.waitForSelector('svg.qr');
  await (await A.page.$('.qrbox')).screenshot({ path: join(dir, 'inviteA.png') });
  toY4m(join(dir, 'inviteA.png'), camB);

  const bB = await launch(camB);
  const B = await profile(bB, 'bob-cam');
  try {
    await onboard(B, 'Bob', 'tr0ub4dor & 3 bananas');
    await B.page.click(tid('join')); // camera auto-starts and sees Alice's QR
    await B.page.waitForSelector(tid('reply-code'), { state: 'attached', timeout: 30000 });
    await (await B.page.$('.qrbox')).screenshot({ path: join(dir, 'replyB.png') });
    toY4m(join(dir, 'replyB.png'), camA); // Chrome opens the file when the camera starts
    await A.page.click(tid('scan-reply'));
    for (const p of [A, B]) await p.page.waitForSelector(`${tid('conn-state')}[data-online="true"]`, { timeout: 30000 });
    await send(A, 'scanned, not pasted');
    await B.page.waitForFunction(() => document.querySelector('[data-testid="msg-in"] .text')?.textContent === 'scanned, not pasted', null, { timeout: 15000 })
      .catch(async (e) => { console.error('B log:', await B.page.$eval('[data-testid="log"]', (x) => x.textContent).catch(() => '?'), 'B view:', await B.page.textContent('body')); throw e; });
    assert.deepEqual(leaks, []);
  } finally { await bA.close(); await bB.close(); }
});

test('slow human scan: reply scanned 45 s later still connects (was a false "can\'t reach" at 25 s)', { timeout: 180000 }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const A = await profile(browser, 'alice-slow'), B = await profile(browser, 'bob-slow');
  try {
    await onboard(A, 'Alice', 'correct horse battery staple');
    await onboard(B, 'Bob', 'tr0ub4dor & 3 bananas');
    await A.page.click(tid('invite'));
    await A.page.waitForFunction((s) => document.querySelector(s)?.value?.startsWith('mur1.'), tid('invite-code'));
    const invite = await A.page.$eval(tid('invite-code'), (e) => e.value);
    await B.page.click(tid('join'));
    await B.page.click('details summary');
    await B.page.fill(tid('paste-invite'), invite);
    await B.page.click(tid('paste-invite-go'));
    await B.page.waitForFunction((s) => document.querySelector(s)?.value?.startsWith('mur1.'), tid('reply-code'));
    const reply = await B.page.$eval(tid('reply-code'), (e) => e.value);
    await B.page.waitForTimeout(45000); // a person fumbling with a camera that won't focus
    assert.ok(await B.page.$(tid('reply-code')), 'joiner must still be waiting, not bounced home with an error');
    await A.page.click('details summary');
    await A.page.fill(tid('paste-reply'), reply);
    await A.page.click(tid('paste-reply-go'));
    for (const p of [A, B]) await p.page.waitForSelector(`${tid('conn-state')}[data-online="true"]`, { timeout: 30000 });
    assert.match(await A.page.$eval(tid('conn-state'), (e) => e.textContent), /connected/);
    await send(A, 'worth the wait');
    await B.page.waitForFunction(() => document.querySelector('[data-testid="msg-in"] .text')?.textContent === 'worth the wait');
  } finally { await browser.close(); }
});

test('dev server redirects /index.html like Cloudflare Pages (so the offline test above covers that host)', async () => {
  const r = await fetch(`http://localhost:${PORT}/index.html`, { redirect: 'manual' });
  assert.equal(r.status, 308);
  assert.equal(r.headers.get('location'), '/');
});

test('host injects a script into index.html: offline install is refused AND the user is told why', { timeout: 120000 }, async () => {
  const port = PORT + 1;
  const bad = spawn(process.execPath, [join(root, 'tools/serve.mjs'), '--port', String(port), '--imitate-host-injection'], { stdio: 'pipe' });
  await new Promise((r) => bad.stdout.once('data', r));
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${port}/`);
    // the page itself still works online…
    await page.waitForSelector(tid('get-started'));
    // …but the offline engine refuses the altered copy and the app says so, loudly
    await page.waitForSelector('.toast.error', { timeout: 20000 });
    const msg = await page.$eval('.toast.error', (e) => e.textContent);
    assert.match(msg, /Offline mode is OFF/);
    assert.match(msg, /altered \.\/index\.html/);
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active ?? null), null, 'no active service worker');
    // and Settings states the same reason after setup
    await page.click(tid('get-started'));
    await page.fill(tid('name'), 'Eve'); await page.fill(tid('pass1'), 'correct horse battery staple'); await page.fill(tid('pass2'), 'correct horse battery staple');
    await page.click(tid('create')); await page.waitForSelector(tid('settings'));
    await page.click(tid('settings'));
    assert.match(await page.$eval(tid('offline-status'), (e) => e.textContent), /altered \.\/index\.html/);
  } finally { await browser.close(); bad.kill(); }
});



test('updates: a new build is verified, announced with its fingerprint, and applied on tap — data kept', { timeout: 180000 }, async () => {
  const port = PORT + 2;
  const dir = '.e2e-update'; // served dir (relative to repo root, like dist)
  const abs = join(root, dir);
  rmSync(abs, { recursive: true, force: true });
  cpSync(join(root, 'dist'), abs, { recursive: true });
  const fpA = JSON.parse(readFileSync(join(abs, 'build-info.json'), 'utf8')).fingerprint;
  const srv = spawn(process.execPath, [join(root, 'tools/serve.mjs'), '--port', String(port), '--dir', dir], { stdio: 'pipe' });
  await new Promise((r) => srv.stdout.once('data', r));
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://localhost:${port}/`);
    await onboard({ page }, 'Uma', 'correct horse battery staple');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
    await page.click(tid('settings'));
    assert.equal(await page.textContent(tid('build-fp')), fpA);
    assert.equal(await page.$(tid('update-banner')), null, 'no banner without an update');

    // The host publishes a new build (different relay → different files → new fingerprint).
    execFileSync(process.execPath, [join(root, 'tools/build.mjs'), '--relay', 'http://127.0.0.1:9', '--out', abs], { stdio: 'pipe' });
    const fpB = JSON.parse(readFileSync(join(abs, 'build-info.json'), 'utf8')).fingerprint;
    assert.notEqual(fpA, fpB);

    // Nothing changes by itself: the new build downloads, verifies, then WAITS and is announced.
    await page.click(tid('check-update'));
    await page.waitForSelector(tid('update-banner'), { timeout: 30000 });
    assert.match(await page.textContent(tid('update-banner')), new RegExp(fpB));
    assert.equal(await page.textContent(tid('build-fp')), fpA, 'still running the old build until the person agrees');

    // One tap: the verified build takes over and the page reloads into it.
    await Promise.all([page.waitForEvent('load', { timeout: 30000 }), page.click(tid('apply-update'))]);
    await page.waitForSelector(tid('unlock-pass'), { timeout: 30000 }); // vault survived; it's locked after a restart
    await page.fill(tid('unlock-pass'), 'correct horse battery staple');
    await page.click(tid('unlock'));
    await page.click(tid('settings'));
    await page.waitForFunction(([s, fp]) => document.querySelector(s)?.textContent === fp, [tid('build-fp'), fpB], { timeout: 10000 });
    assert.equal(await page.$(tid('update-banner')), null, 'banner gone once updated');
    assert.match(await page.inputValue('input[aria-label="Display name"]'), /Uma/, 'profile kept across the update');
  } finally { await browser.close(); srv.kill(); rmSync(abs, { recursive: true, force: true }); }
});

test('duress passcode: opens an empty decoy, real chats untouched; optional erase destroys them silently', { timeout: 240000 }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const A = await profile(browser, 'alice-duress'), B = await profile(browser, 'bob-duress');
  const REAL = 'correct horse battery staple', DURESS = 'grandma birthday cake';
  const lockAndUnlock = async (pass) => {
    await A.page.click(tid('lock'));
    await A.page.fill(tid('unlock-pass'), pass); await A.page.click(tid('unlock'));
  };
  try {
    await onboard(A, 'Alice', REAL); await onboard(B, 'Bob', 'another long passphrase');
    await pairByText(A, B);
    await A.page.click(tid('back'));
    await A.page.waitForSelector(tid('contact-Bob'));

    // Set it up from the real vault.
    await A.page.click(tid('settings'));
    assert.equal(await A.page.textContent(tid('duress-status')), 'Off');
    await A.page.fill(tid('duress-pass'), REAL); await A.page.fill(tid('duress-pass2'), REAL);
    await A.page.click(tid('duress-save'));
    await A.page.waitForFunction(() => /different from your real passphrase/.test(document.body.textContent), null, { timeout: 20000 });
    await A.page.fill(tid('duress-pass'), DURESS); await A.page.fill(tid('duress-pass2'), DURESS);
    await A.page.click(tid('duress-save'));
    await A.page.waitForFunction((s) => document.querySelector(s)?.textContent === 'On', tid('duress-status'), { timeout: 30000 });
    await A.page.click(tid('back'));

    // Forced to unlock: the duress passcode opens an ordinary, empty Murmur.
    await lockAndUnlock(DURESS);
    await A.page.waitForSelector(tid('invite'), { timeout: 30000 });
    assert.equal(await A.page.$$eval(tid('contact-Bob'), (e) => e.length), 0, 'real contact hidden');
    assert.match(await A.page.textContent('body'), /No contacts yet/);
    await A.page.click(tid('settings'));
    assert.equal(await A.page.textContent(tid('duress-status')), 'Off', 'the decoy looks like a phone with no duress passcode');
    assert.equal(await A.page.inputValue('input[aria-label="Display name"]'), 'Alice', 'same name: nothing looks off');
    await A.page.click(tid('back'));

    // Back to the real passphrase: everything is still there.
    await lockAndUnlock(REAL);
    await A.page.waitForSelector(tid('contact-Bob'), { timeout: 30000 });

    // Now with "erase real chats": one use of the duress passcode destroys them.
    await A.page.click(tid('settings'));
    await A.page.fill(tid('duress-pass'), DURESS); await A.page.fill(tid('duress-pass2'), DURESS);
    await A.page.check(tid('duress-erase'));
    await A.page.click(tid('duress-save'));
    await A.page.click(tid('modal-yes'));
    await A.page.waitForFunction((s) => /erases/.test(document.querySelector(s)?.textContent || ''), tid('duress-status'), { timeout: 30000 });
    await A.page.click(tid('back'));
    await lockAndUnlock(DURESS);
    await A.page.waitForSelector(tid('invite'), { timeout: 30000 });
    assert.equal(await A.page.evaluate(() => /eras|wip|delet|destroy/i.test([...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' '))), false, 'no hint on screen that anything was erased');
    await lockAndUnlock(REAL);
    await A.page.waitForFunction(() => /Wrong passphrase/.test(document.body.textContent), null, { timeout: 30000 });
    assert.equal(await A.page.$$eval(tid('contact-Bob'), (e) => e.length), 0);
    for (const p of [A, B]) assert.deepEqual(p.errors, []);
  } finally { await browser.close(); }
});

test('internet mode: invite link, stranger gating, scam warnings, offline queue, verification', { timeout: 240000 }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const C = await profile(browser, 'carol'), D = await profile(browser, 'dave');
  try {
    await onboard(C, 'Carol', 'correct horse battery staple');
    await onboard(D, 'Dave', 'tr0ub4dor & 3 bananas');
    await C.page.waitForFunction(() => /connected to the relay|Far away/.test(document.body.textContent));

    // Carol makes an invite link and "texts" it to Dave.
    await C.page.click(tid('link-invite'));
    await C.page.waitForFunction((s) => /#i=/.test(document.querySelector(s)?.value || ''), tid('invite-link'));
    const link = await C.page.$eval(tid('invite-link'), (e) => e.value);
    assert.ok(link.startsWith(ORIGIN + '/#i='), link);
    await C.page.click(tid('back'));

    // Dave opens the link: unlock → invite preview → Join.
    await D.page.goto('about:blank'); await D.page.goto(link); // a fresh load, like tapping the link in a text
    await D.page.fill(tid('unlock-pass'), 'tr0ub4dor & 3 bananas'); await D.page.click(tid('unlock'));
    assert.ok(!(await D.page.evaluate(() => location.hash)), 'invite removed from the address bar');
    await D.page.waitForSelector(tid('join-invite'));
    assert.match(await D.page.textContent('.big-instruction'), /Carol invites you/);
    await D.page.click(tid('join-invite'));
    await D.page.waitForSelector(tid('verify-banner'));
    await send(D, 'Hi Carol! Pay the deposit here: paypa1.com/pay');

    // Carol: Dave appears as a REQUEST. His link is visible but locked, and flagged as dangerous.
    await C.page.waitForSelector(tid('contact-Dave'), { timeout: 20000 });
    await C.page.click(tid('contact-Dave'));
    await C.page.waitForSelector(tid('request-banner'));
    await C.page.waitForSelector(`${tid('msg-in')} ${tid('link')}`, { timeout: 20000 });
    assert.match(await C.page.getAttribute(`${tid('msg-in')} ${tid('link')}`, 'class'), /risk-high/);
    await C.page.click(`${tid('msg-in')} ${tid('link')}`);
    assert.match(await C.page.textContent('.modal'), /Accept this contact before opening/);
    assert.equal(await C.page.$$eval('.modal button', (b) => b.map((x) => x.textContent).includes('Open anyway')), false);
    await C.page.click(tid('modal-cancel'));
    await C.page.click(tid('accept-request'));
    await C.page.click(`${tid('msg-in')} ${tid('link')}`);
    assert.equal(await C.page.textContent(tid('link-host')), 'paypa1.com');
    assert.match(await C.page.textContent(tid('link-risk')), /Danger/);
    assert.match(await C.page.textContent('.modal'), /Looks like Paypal, but it is NOT paypal\.com/);
    await C.page.click(tid('modal-cancel'));

    // Carol replies; Dave sees it and Carol gets ✓✓.
    await send(C, 'Hi Dave — not clicking that 😄');
    await D.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-in"] .text')].some((e) => e.textContent.startsWith('Hi Dave')), null, { timeout: 20000 });
    await C.page.waitForFunction(() => document.querySelector('[data-testid="msg-out"] .status')?.textContent === '✓✓', null, { timeout: 20000 });

    // A disguised program sent as a "photo" is flagged and never displayed.
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2000, 7)]);
    await C.page.setInputFiles(tid('file-input'), { name: 'holiday.jpg', mimeType: 'image/jpeg', buffer: exe });
    await C.page.click(tid('modal-send'));
    await D.page.waitForSelector(`${tid('msg-in')} ${tid('file-warning')}`, { timeout: 20000 });
    assert.match(await D.page.textContent(`${tid('msg-in')} ${tid('file-warning')}`), /Disguised program|Pretends/);
    assert.equal(await D.page.$$eval(`${tid('msg-in')} img`, (x) => x.length), 0);

    // Dave loses internet, writes anyway: it waits on his phone, then delivers by itself.
    await D.ctx.setOffline(true);
    await send(D, 'typed with no signal');
    await D.page.waitForSelector(`${tid('conn-state')}[data-kind="queued"]`, { timeout: 20000 }); // failed send → offline detected
    assert.equal(await D.page.evaluate(() => [...document.querySelectorAll('[data-testid="msg-out"]')].at(-1).querySelector('.status').textContent), '○');
    await D.ctx.setOffline(false);
    await C.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-in"] .text')].some((e) => e.textContent === 'typed with no signal'), null, { timeout: 40000 });

    // Verification after comparing numbers on a "call".
    await D.page.click(tid('contact-info'));
    await C.page.click(tid('contact-info'));
    const sn = (p) => p.page.waitForFunction((s) => /^\d{5}( \d{5}){11}$/.test(document.querySelector(s)?.textContent || '') && document.querySelector(s).textContent, tid('safety-number')).then((x) => x.jsonValue());
    assert.equal(await sn(C), await sn(D));
    await D.page.click(tid('mark-verified'));
    await D.page.waitForSelector(tid('verified'));
    await D.page.click(tid('back'));
    assert.equal(await D.page.$(tid('verify-banner')), null);

    assert.deepEqual(leaks, []);
    for (const p of [C, D]) assert.deepEqual(await p.page.evaluate(() => window.__csp), [], `${p.name} CSP`);
  } finally { await browser.close(); }
});

async function linkFriends(from, to, toPass) {
  await from.page.click(tid('link-invite'));
  await from.page.waitForFunction((s) => /#i=/.test(document.querySelector(s)?.value || ''), tid('invite-link'));
  const link = await from.page.$eval(tid('invite-link'), (e) => e.value);
  await from.page.click(tid('back'));
  await to.page.goto('about:blank'); await to.page.goto(link);
  await to.page.fill(tid('unlock-pass'), toPass); await to.page.click(tid('unlock'));
  await to.page.waitForSelector(tid('join-invite')); await to.page.click(tid('join-invite'));
  await to.page.waitForSelector(tid('verify-banner'));
  await to.page.click(tid('back'));
}
const holdButton = async (page, selector, ms) => {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(ms); await page.mouse.up();
};

test('phase 1: private photos, walkie-talkie, location, SOS and groups (3 people, relay + forwarding)', { timeout: 300000 }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const pass = { Carol: 'correct horse battery staple', Dave: 'tr0ub4dor & 3 bananas', Emma: 'purple monkey dishwasher 9' };
  const P = {};
  try {
    for (const n of ['Carol', 'Dave', 'Emma']) {
      P[n] = await profile(browser, n.toLowerCase() + '-p1');
      await P[n].ctx.grantPermissions(['geolocation', 'microphone', 'clipboard-read', 'clipboard-write'], { origin: ORIGIN });
      await onboard(P[n], n, pass[n]);
    }
    await P.Carol.ctx.setGeolocation({ latitude: 6.5244, longitude: 3.3792, accuracy: 15 });   // Lagos
    await P.Dave.ctx.setGeolocation({ latitude: 6.6018, longitude: 3.3515, accuracy: 20 });    // ~9 km N
    await P.Emma.ctx.setGeolocation({ latitude: 6.4550, longitude: 3.3941, accuracy: 30 });
    // Carol knows Dave and Emma; Dave and Emma do NOT know each other.
    await linkFriends(P.Carol, P.Dave, pass.Dave);
    await linkFriends(P.Carol, P.Emma, pass.Emma);
    for (const n of ['Dave', 'Emma']) {
      await P.Carol.page.waitForSelector(tid(`contact-${n}`), { timeout: 20000 });
      await P.Carol.page.click(tid(`contact-${n}`)); await P.Carol.page.click(tid('accept-request')); await P.Carol.page.click(tid('back'));
    }

    // --- photo privacy: GPS/camera data never leaves Carol's phone ---
    await P.Carol.page.click(tid('contact-Dave'));
    // A wrong pick never sends: the photo is previewed (already cleaned) and Cancel stops it.
    await P.Carol.page.setInputFiles(tid('file-input'), join(root, 'test/fixtures/media/photo-gps.jpg'));
    await P.Carol.page.waitForSelector(tid('review-image'), { timeout: 15000 });
    assert.match(await P.Carol.page.textContent('.modal'), /Removed hidden location/);
    await P.Carol.page.click(tid('modal-cancel'));
    assert.equal(await P.Carol.page.$$eval(tid('msg-out'), (e) => e.length), 0, 'cancelled photo was not sent');
    await P.Carol.page.setInputFiles(tid('file-input'), join(root, 'test/fixtures/media/photo-gps.jpg'));
    await P.Carol.page.click(tid('modal-send'));
    await P.Dave.page.click(tid('contact-Carol'));
    await P.Dave.page.waitForSelector(`${tid('msg-in')} img.attach`, { timeout: 20000 });
    const got = await P.Dave.page.evaluate(async () => {
      const b = new Uint8Array(await (await fetch(document.querySelector('[data-testid="msg-in"] img.attach').src)).arrayBuffer());
      const t = new TextDecoder('latin1').decode(b);
      return { jpeg: b[0] === 0xff && b[1] === 0xd8, secret: /SECRET/.test(t) };
    });
    assert.deepEqual(got, { jpeg: true, secret: false }, 'photo arrives as a JPEG with no hidden camera/location data');

    // --- saving it on a phone: the system share sheet ("Save Image" → Photos), not a dead download link ---
    await P.Dave.page.evaluate(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => (q === '(pointer:coarse)' ? { matches: true, media: q } : real(q)); // a touch phone
      navigator.canShare = (d) => Array.isArray(d?.files) && d.files.every((f) => f instanceof File);
      navigator.share = async (d) => {
        const f = d.files[0]; const b = new Uint8Array(await f.arrayBuffer());
        window.__shared = { n: d.files.length, name: f.name, type: f.type, jpeg: b[0] === 0xff && b[1] === 0xd8, secret: /SECRET/.test(new TextDecoder('latin1').decode(b)) };
      };
    });
    await P.Dave.page.click(`${tid('msg-in')} ${tid('file')}`);
    await P.Dave.page.waitForFunction(() => !!window.__shared, null, { timeout: 5000 });
    assert.deepEqual(await P.Dave.page.evaluate(() => window.__shared), { n: 1, name: 'photo-gps.jpg', type: 'image/jpeg', jpeg: true, secret: false },
      'phone save hands the cleaned photo, with its real image type, to the share sheet');

    // --- location: GPS position, distance and direction, no map server ---
    await P.Carol.page.click(tid('share-location'));
    await P.Carol.page.click(tid('modal-once'));
    await P.Dave.page.waitForSelector(`${tid('msg-in')} ${tid('loc-card')}`, { timeout: 20000 });
    await P.Dave.page.click(`${tid('msg-in')} ${tid('how-far')}`);
    await P.Dave.page.waitForFunction(() => /km S of you|km SSE of you|km SSW of you/.test(document.querySelector('[data-testid="msg-in"] [data-testid="loc-relative"]')?.textContent || ''), null, { timeout: 15000 });

    // --- walkie-talkie: by default you hear the clip first; Delete sends nothing, Send sends it ---
    await holdButton(P.Carol.page, tid('voice'), 1600);
    await P.Carol.page.waitForSelector(tid('review-audio'), { timeout: 15000 });
    await P.Carol.page.click(tid('modal-cancel'));
    await holdButton(P.Carol.page, tid('voice'), 1600);
    await P.Carol.page.click(tid('modal-send'));
    await P.Dave.page.waitForSelector(tid('voice-clip'), { timeout: 30000 });
    const dur = await P.Dave.page.evaluate(() => new Promise((res) => {
      const a = document.querySelector('[data-testid="voice-clip"]');
      const done = () => res(a.duration);
      if (a.readyState >= 1) done(); else a.addEventListener('loadedmetadata', done, { once: true });
      setTimeout(() => res(-1), 8000);
    }));
    assert.ok(dur === Infinity || dur > 0.5, `voice clip has audio (duration ${dur})`); // Chrome reports Infinity for streamed WebM
    assert.equal(await P.Dave.page.$$eval(tid('voice-clip'), (e) => e.length), 1, 'the deleted clip never arrived');
    // Real walkie-talkie mode (Settings): sends the moment you let go, no question asked.
    await P.Carol.page.click(tid('back')); await P.Carol.page.click(tid('settings'));
    await P.Carol.page.selectOption(tid('voice-send'), 'release');
    await P.Carol.page.click(tid('back')); await P.Carol.page.click(tid('contact-Dave'));
    await holdButton(P.Carol.page, tid('voice'), 1600);
    await P.Dave.page.waitForFunction((s) => document.querySelectorAll(s).length === 2, tid('voice-clip'), { timeout: 30000 });
    assert.equal(await P.Carol.page.$('.modal'), null, 'no review step in walk-talkie mode');

    // --- SOS: Dave holds the button; Carol gets an alarm with his position ---
    await P.Dave.page.click(tid('back')); await P.Dave.page.click(tid('sos'));
    assert.match(await P.Dave.page.textContent(tid('sos-disclaimer')), /cannot call emergency services/);
    await holdButton(P.Dave.page, tid('sos-send'), 300); // too short: must NOT send
    await P.Dave.page.waitForTimeout(500);
    assert.ok(await P.Dave.page.$(tid('sos-send')), 'a quick tap does not send SOS');
    await holdButton(P.Dave.page, tid('sos-send'), 2000);
    await P.Carol.page.waitForSelector(tid('sos-alert'), { timeout: 20000 });
    assert.match(await P.Carol.page.textContent('.modal'), /SOS from Dave[\s\S]*I need help[\s\S]*6\.60180/);
    await P.Carol.page.click(tid('modal-false'));

    // --- groups: Carol creates; Dave and Emma (strangers to each other) can talk via forwarding ---
    await P.Carol.page.click(tid('back'));
    await P.Carol.page.click(tid('new-group'));
    await P.Carol.page.fill(tid('group-name'), 'Hike crew');
    await P.Carol.page.click(tid('pick-Dave')); await P.Carol.page.click(tid('pick-Emma'));
    await P.Carol.page.click(tid('create-group'));
    await P.Carol.page.waitForSelector(tid('group-size'));
    for (const n of ['Dave', 'Emma']) {
      await P[n].page.waitForSelector(tid('group-Hike crew'), { timeout: 20000 });
      await P[n].page.click(tid('group-Hike crew'));
    }
    await send(P.Dave, 'who is bringing water?');
    await P.Emma.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-in"]')].some((m) => /who is bringing water/.test(m.textContent) && /Dave \(via group\)/.test(m.querySelector('[data-testid="sender"]')?.textContent || '')), null, { timeout: 20000 });
    await P.Carol.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-in"]')].some((m) => /who is bringing water/.test(m.textContent) && m.querySelector('[data-testid="sender"]')?.textContent === 'Dave'), null, { timeout: 20000 });
    await send(P.Emma, 'I will!');
    await P.Dave.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-in"]')].some((m) => /I will!/.test(m.textContent)), null, { timeout: 20000 });
    await send(P.Carol, 'see you at 7');
    await P.Carol.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-out"] .status')].at(-1)?.textContent === '✓✓', null, { timeout: 20000 });
    // (Non-creators can't change the roster: covered by geo-groups.test.mjs.)
    // Carol removes Emma: Emma's group closes and she stops getting messages
    await P.Carol.page.click(tid('group-info'));
    const before = await P.Carol.page.$$eval(`${tid('member-list')} li`, (x) => x.length);
    assert.equal(before, 3);
    await P.Carol.page.locator(`${tid('member-list')} li`, { hasText: 'Emma' }).locator('button').click();
    await P.Carol.page.click(tid('modal-true'));
    await P.Carol.page.waitForFunction(() => document.querySelectorAll('[data-testid="member-list"] li').length === 2);
    await P.Emma.page.waitForFunction(() => /no longer in this group/.test(document.querySelector('[data-testid="compose"]')?.placeholder || ''), null, { timeout: 20000 });

    assert.deepEqual(leaks, []);
    for (const n of Object.keys(P)) assert.deepEqual(await P[n].page.evaluate(() => window.__csp), [], `${n} CSP`);
  } finally { await browser.close(); }
});

// Tear everything down so the test process exits by itself (no lingering servers).
after(() => { server.kill(); relay.server.closeAllConnections?.(); relay.server.close(); });
