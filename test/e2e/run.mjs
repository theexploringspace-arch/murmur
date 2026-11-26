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

/** The lock screen fills in a remembered username asynchronously; wait for it before typing. */
const userReady = (page) => page.waitForSelector('[data-testid="unlock-form"][data-ready="1"]', { timeout: 15000 });

async function onboard(p, name, pass) {
  await p.page.click(tid('get-started'));
  await p.page.fill(tid('name'), name);
  await p.page.fill(tid('username'), `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}_test`);
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
    await t.test('launch screen: logo + "from Prince Is Genius", then it gets out of the way', async () => {
      // A fresh page, so we catch the splash before app.js removes it.
      const p = await A.ctx.newPage(); await p.goto(ORIGIN + '/');
      assert.match(await p.textContent(tid('splash')), /Murmur\s*from\s*Prince Is Genius/);
      assert.equal(await p.$eval('.splash-logo', (i) => i.complete && i.naturalWidth > 0), true, 'the logo loads (CSP allows it)');
      await p.waitForSelector(tid('splash'), { state: 'detached', timeout: 5000 }); // removed, not just faded
      await p.click(tid('get-started'), { timeout: 5000 }); // the app underneath is usable
      await p.close();
    });

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
      await B.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="file"]')].some((a) => a.textContent.includes('data.bin')), null, { timeout: 20000 });
      const sum = await B.page.evaluate(async () => {
        const a = [...document.querySelectorAll('[data-testid="file"]')].find((x) => x.textContent.includes('data.bin'));
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
      // Two checks, so the test is both strict and never flaky:
      //  1. everything OUTSIDE ciphertext (record names, any readable field) contains no names/texts at all;
      //  2. ciphertext bytes contain no plaintext JSON ("Bob" with its quotes, "text":"Hello"…).
      // (Matching a bare 3-byte word like Bob inside ~1 MB of random ciphertext hits by pure chance
      //  about once in 20 runs — it did. A 5+ byte JSON fragment: about once in a million.)
      const { plain, cipher, shapes } = await A.page.evaluate(async () => {
        const db = await new Promise((r) => { const q = indexedDB.open('murmur'); q.onsuccess = () => r(q.result); });
        const rows = await new Promise((r) => { const out = []; const q = db.transaction('kv').objectStore('kv').openCursor();
          q.onsuccess = () => { const c = q.result; if (!c) return r(out); out.push([c.key, c.value]); c.continue(); }; });
        const dec = new TextDecoder('latin1'); let cipher = ''; const shapes = [];
        const plain = JSON.stringify(rows, (k, v) => {
          if (v instanceof Uint8Array) { if (k === 'ct') { cipher += dec.decode(v); return '<ct>'; } return `<${v.length} bytes>`; }
          return v;
        });
        for (const [k, v] of rows) if (/^(b:)?rec\//.test(k)) shapes.push(v && v.iv instanceof Uint8Array && v.iv.length === 12 && v.ct instanceof Uint8Array && Object.keys(v).length === 2 ? 'sealed' : `OPEN ${k}`);
        return { plain, cipher, shapes };
      });
      assert.ok(shapes.length > 3 && shapes.every((x) => x === 'sealed'), `every record is {iv, ct}: ${shapes.filter((x) => x !== 'sealed').join(', ')}`);
      for (const needle of ['Bob', 'bob_test', 'Hello', 'Alice', 'm149']) assert.ok(!plain.includes(needle), `"${needle}" must not appear in readable storage`);
      for (const needle of ['"Bob"', '"bob_test"', '"text":"Hello', '"Alice"', '"m149"']) assert.ok(!cipher.includes(needle), `${needle} must not appear inside ciphertext (plaintext JSON leak)`);
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
      await userReady(A.page); await A.page.fill(tid('unlock-pass'), 'not the passphrase');
      await A.page.click(tid('unlock'));
      await A.page.waitForFunction(() => /Wrong username or passphrase/.test(document.querySelector('.error')?.textContent || ''));
      // Bob keeps writing while Alice is locked: it goes through the relay (set up
      // automatically when they paired face to face) and waits for her.
      await B.page.waitForSelector(`${tid('conn-state')}[data-kind="internet"]`, { timeout: 15000 });
      await send(B, 'written while you were locked');
      await userReady(A.page); await A.page.fill(tid('unlock-pass'), 'correct horse battery staple');
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
        await userReady(p.page); await p.page.fill(tid('unlock-pass'), pw); await p.page.click(tid('unlock'));
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
    await page.fill(tid('name'), 'Eve'); await page.fill(tid('username'), 'eve_test'); await page.fill(tid('pass1'), 'correct horse battery staple'); await page.fill(tid('pass2'), 'correct horse battery staple');
    await page.click(tid('create')); await page.waitForSelector(tid('settings'));
    await openSetting(page, 'help');
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
    await openSetting(page, 'help');
    await page.waitForFunction((s) => /^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/.test(document.querySelector(s)?.textContent || ''), tid('build-fp'), { timeout: 10000 }); // loads async
    assert.equal(await page.textContent(tid('build-fp')), fpA);
    assert.equal(await page.$$eval(tid('update-banner'), (e) => e.length), 0, 'no banner without an update');

    // The host publishes a new build (different relay → different files → new fingerprint).
    execFileSync(process.execPath, [join(root, 'tools/build.mjs'), '--relay', 'http://127.0.0.1:9', '--out', abs], { stdio: 'pipe' });
    const fpB = JSON.parse(readFileSync(join(abs, 'build-info.json'), 'utf8')).fingerprint;
    assert.notEqual(fpA, fpB);

    // Nothing changes by itself: the new build downloads, verifies, then WAITS and is announced.
    await page.click(tid('check-update'));
    await page.waitForSelector(tid('update-banner'), { timeout: 30000 });
    assert.match(await page.textContent(tid('update-banner')), new RegExp(fpB));
    await page.waitForFunction(([s, fp]) => document.querySelector(s)?.textContent === fp, [tid('build-fp'), fpA], { timeout: 10000 }); // still the old build until the person agrees

    // One tap: the verified build takes over and the page reloads into it.
    await Promise.all([page.waitForEvent('load', { timeout: 30000 }), page.click(tid('apply-update'))]);
    await page.waitForSelector(tid('unlock-pass'), { timeout: 30000 }); // vault survived; it's locked after a restart
    await userReady(page); await page.fill(tid('unlock-pass'), 'correct horse battery staple');
    await page.click(tid('unlock'));
    await openSetting(page, 'help');
    await page.waitForFunction(([s, fp]) => document.querySelector(s)?.textContent === fp, [tid('build-fp'), fpB], { timeout: 10000 });
    assert.equal(await page.$$eval(tid('update-banner'), (e) => e.length), 0, 'banner gone once updated');
    await page.click(tid('back')); await page.click(tid('settings-account'));
    assert.match(await page.inputValue('input[aria-label="Display name"]'), /Uma/, 'profile kept across the update');
  } finally { await browser.close(); srv.kill(); rmSync(abs, { recursive: true, force: true }); }
});

test('duress passcode: opens an empty decoy, real chats untouched; optional erase destroys them silently', { timeout: 240000 }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const A = await profile(browser, 'alice-duress'), B = await profile(browser, 'bob-duress');
  const REAL = 'correct horse battery staple', DURESS = 'grandma birthday cake';
  const lockAndUnlock = async (pass) => {
    await A.page.click(tid('lock'));
    await userReady(A.page); await A.page.fill(tid('unlock-pass'), pass); await A.page.click(tid('unlock'));
  };
  try {
    await onboard(A, 'Alice', REAL); await onboard(B, 'Bob', 'another long passphrase');
    await pairByText(A, B);
    await A.page.click(tid('back'));
    await A.page.waitForSelector(tid('contact-Bob'));

    // Set it up from the real vault.
    await openSetting(A.page, 'security');
    assert.equal(await A.page.textContent(tid('duress-status')), 'Off');
    await A.page.fill(tid('duress-pass'), REAL); await A.page.fill(tid('duress-pass2'), REAL);
    await A.page.click(tid('duress-save'));
    await A.page.waitForFunction(() => /different from your real passphrase/.test(document.body.textContent), null, { timeout: 20000 });
    await A.page.fill(tid('duress-pass'), DURESS); await A.page.fill(tid('duress-pass2'), DURESS);
    await A.page.click(tid('duress-save'));
    await A.page.waitForFunction((s) => document.querySelector(s)?.textContent === 'On', tid('duress-status'), { timeout: 30000 });
    await leaveSettings(A.page);

    // Forced to unlock: the duress passcode opens an ordinary, empty Murmur.
    await lockAndUnlock(DURESS);
    await A.page.waitForSelector(tid('invite'), { timeout: 30000 });
    assert.equal(await A.page.$$eval(tid('contact-Bob'), (e) => e.length), 0, 'real contact hidden');
    assert.match(await A.page.textContent('body'), /No contacts yet/);
    await openSetting(A.page, 'security');
    assert.equal(await A.page.textContent(tid('duress-status')), 'Off', 'the decoy looks like a phone with no duress passcode');
    await A.page.click(tid('back')); await A.page.click(tid('settings-account'));
    assert.equal(await A.page.inputValue('input[aria-label="Display name"]'), 'Alice', 'same name: nothing looks off');
    await leaveSettings(A.page);

    // Back to the real passphrase: everything is still there.
    await lockAndUnlock(REAL);
    await A.page.waitForSelector(tid('contact-Bob'), { timeout: 30000 });

    // Now with "erase real chats": one use of the duress passcode destroys them.
    await openSetting(A.page, 'security');
    await A.page.fill(tid('duress-pass'), DURESS); await A.page.fill(tid('duress-pass2'), DURESS);
    await A.page.check(tid('duress-erase'));
    await A.page.click(tid('duress-save'));
    await A.page.click(tid('modal-yes'));
    await A.page.waitForFunction((s) => /erases/.test(document.querySelector(s)?.textContent || ''), tid('duress-status'), { timeout: 30000 });
    await leaveSettings(A.page);
    await lockAndUnlock(DURESS);
    await A.page.waitForSelector(tid('invite'), { timeout: 30000 });
    assert.equal(await A.page.evaluate(() => /eras|wip|delet|destroy/i.test([...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' '))), false, 'no hint on screen that anything was erased');
    await lockAndUnlock(REAL);
    await A.page.waitForFunction(() => /Wrong username or passphrase/.test(document.body.textContent), null, { timeout: 30000 });
    assert.equal(await A.page.$$eval(tid('contact-Bob'), (e) => e.length), 0);

    // Wrong tries make you WAIT (nothing is erased by default), and the wait survives a reload.
    for (let i = 0; i < 4; i++) {
      await userReady(A.page); await A.page.fill(tid('unlock-pass'), `wrong guess number ${i}`); await A.page.click(tid('unlock'));
      await A.page.waitForFunction(() => !document.querySelector('[data-testid="unlock"]').textContent.startsWith('Unlocking'), null, { timeout: 30000 });
    }
    await A.page.waitForFunction(() => /Try again in (2\d|30) seconds/.test(document.querySelector('[data-testid="unlock"]').textContent), null, { timeout: 10000 });
    assert.equal(await A.page.$eval(tid('unlock'), (b) => b.disabled), true);
    await A.page.reload();
    await A.page.waitForFunction(() => /Try again in/.test(document.querySelector('[data-testid="unlock"]')?.textContent || ''), null, { timeout: 15000 });
    for (const p of [A, B]) assert.deepEqual(p.errors, []);
  } finally { await browser.close(); }
});

test('profile photo, @username login, edit & delete messages', { timeout: 240000 }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const A = await profile(browser, 'alice-prof'), B = await profile(browser, 'bob-prof');
  const PASS = 'correct horse battery staple';
  const bubbleMenu = async (p, text, dir = 'out') => {
    const el = p.page.locator(`${tid(`msg-${dir}`)}:has-text("${text}")`).last();
    await el.click({ button: 'right' });
    await p.page.waitForSelector(tid('message-menu'));
  };
  try {
    await onboard(A, 'Alice', PASS); await onboard(B, 'Bob', 'another long passphrase');
    await pairByText(A, B);

    // --- Bob is mid-sentence when Alice's new photo arrives and re-draws his chat: nothing he typed is lost ---
    const draft = 'half-typed while your photo changes';
    await B.page.fill(tid('compose'), draft);
    await B.page.$eval(tid('compose'), (t) => t.setSelectionRange(4, 4));

    // --- profile photo + @username reach the contact ---
    await A.page.click(tid('back')); await openSetting(A.page, 'account');
    await A.page.setInputFiles(tid('pic-input'), join(root, 'test/fixtures/media/photo-gps.jpg'));
    await A.page.waitForFunction(() => /Profile photo updated/.test(document.body.textContent), null, { timeout: 15000 });
    await B.page.waitForFunction(() => !!document.querySelector('.screen [data-testid="avatar"] img'), null, { timeout: 20000 }); // the chat WAS re-drawn
    assert.deepEqual(await B.page.$eval(tid('compose'), (t) => [t.value, document.activeElement === t, t.selectionStart]), [draft, true, 4],
      'draft, keyboard focus and cursor all survive the redraw');
    await B.page.click(tid('send'));
    await B.page.click(tid('back')); await B.page.click(tid('contact-Alice'));
    assert.equal(await B.page.inputValue(tid('compose')), '', 'a sent draft is gone');
    await B.page.fill(tid('compose'), 'kept while I look elsewhere');
    await B.page.click(tid('back')); await B.page.click(tid('contact-Alice'));
    assert.equal(await B.page.inputValue(tid('compose')), 'kept while I look elsewhere', 'leaving the chat keeps the draft, like WhatsApp');
    await B.page.fill(tid('compose'), '');
    await B.page.click(tid('back'));
    await B.page.waitForFunction(() => !!document.querySelector('[data-testid="contact-Alice"] [data-testid="avatar"] img'), null, { timeout: 20000 });
    await B.page.waitForFunction(() => document.querySelector('[data-testid="contact-Alice"] [data-testid="avatar"] img')?.naturalWidth > 0, null, { timeout: 10000 });
    const pic = await B.page.$eval('[data-testid="contact-Alice"] [data-testid="avatar"] img', (i) => ({ w: i.naturalWidth, h: i.naturalHeight, blob: i.src.startsWith('blob:') }));
    assert.deepEqual(pic, { w: 256, h: 256, blob: true }, 'a 256×256 photo (re-drawn: no metadata), shown from memory');
    await B.page.click(tid('contact-Alice')); await B.page.click(tid('contact-info'));
    assert.equal(await B.page.textContent(tid('contact-username')), '@alice_test');
    await B.page.click(tid('back'));

    // --- edit (both phones update, marked "edited") ---
    await leaveSettings(A.page); await A.page.click(tid('contact-Bob'));
    await A.page.waitForFunction((t) => document.querySelector('[data-testid="log"]')?.textContent.includes(t), draft, { timeout: 15000 });
    await send(A, 'helo wrld');
    await B.page.waitForFunction(() => /helo wrld/.test(document.querySelector('[data-testid="log"]')?.textContent || ''), null, { timeout: 15000 });
    await bubbleMenu(A, 'helo wrld');
    assert.match(await A.page.textContent(tid('menu-edit')), /Edit\s*1[45] min/);
    await A.page.click(tid('menu-edit'));
    await A.page.fill(tid('edit-text'), 'hello world');
    await A.page.click(tid('modal-save'));
    await B.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-in"]')].some((m) => /hello world/.test(m.textContent) && m.querySelector('[data-testid="edited"]')), null, { timeout: 15000 });
    assert.equal(await A.page.$$eval(tid('edited'), (e) => e.length), 1);

    // --- delete for everyone ---
    await send(A, 'oops wrong chat');
    await B.page.waitForFunction(() => /oops wrong chat/.test(document.querySelector('[data-testid="log"]').textContent), null, { timeout: 15000 });
    await bubbleMenu(A, 'oops wrong chat');
    await A.page.click(tid('menu-all'));
    await A.page.click(tid('modal-true'));
    await B.page.waitForFunction(() => /This message was deleted/.test(document.querySelector('[data-testid="log"]').textContent), null, { timeout: 15000 });
    assert.equal(await B.page.evaluate(() => /oops wrong chat/.test(document.body.textContent)), false, 'gone from their phone');
    assert.match(await A.page.textContent(tid('log')), /You deleted this message/);

    // --- the receiver can only delete for themselves ---
    await bubbleMenu(B, 'hello world', 'in');
    assert.equal(await B.page.$$eval(tid('menu-all'), (e) => e.length), 0, 'no "delete for everyone" on someone else’s message');
    assert.equal(await B.page.$$eval(tid('menu-edit'), (e) => e.length), 0);
    await B.page.click(tid('menu-me'));
    assert.equal(await B.page.evaluate(() => /hello world/.test(document.querySelector('[data-testid="log"]').textContent)), false);
    assert.match(await A.page.textContent(tid('log')), /hello world/, 'still on the sender’s phone');

    // --- media, links and docs: one screen per contact, opened from the photo at the top of the chat ---
    await A.page.setInputFiles(tid('file-input'), join(root, 'test/fixtures/media/photo-gps.jpg'));
    await A.page.click(tid('modal-send'));
    await A.page.setInputFiles(tid('file-input'), { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('meeting at 6') });
    await A.page.click(tid('modal-send'));
    await send(A, 'directions: https://example.org/map?x=1');
    await B.page.waitForFunction(() => document.querySelectorAll('[data-testid="msg-in"]').length >= 4, null, { timeout: 20000 });
    await A.page.click(tid('chat-title'));
    assert.match(await A.page.textContent(tid('open-shared')), /Media, links and docs\s*3/);
    await A.page.click(tid('open-shared'));
    assert.deepEqual(await A.page.$$eval('.tabs button', (b) => b.map((x) => x.textContent)), ['Media 1', 'Docs 1', 'Links 1']);
    await A.page.click('[data-testid="shared-media"] .thumb');
    await A.page.waitForFunction(() => document.querySelector('[data-testid="viewer-image"]')?.naturalWidth > 0, null, { timeout: 10000 });
    await A.page.waitForSelector(tid('viewer-chat')); // opened from Shared: "In chat" jumps back to the message
    await A.page.click(tid('viewer-close'));
    assert.equal(await A.page.$$eval(tid('viewer'), (v) => v.length), 0);
    await A.page.click(tid('tab-docs'));
    await A.page.click(tid('doc-open'));
    assert.match(await A.page.textContent(tid('viewer-info')), /^TXT · \d+ B$/);
    await A.page.click(tid('viewer-close'));
    await A.page.click(tid('tab-docs'));
    assert.match(await A.page.textContent(tid('shared-docs')), /notes\.txt/);
    await A.page.click(tid('tab-links'));
    assert.match(await A.page.textContent(tid('shared-links')), /example\.org\/map/);
    await A.page.click(tid('back')); await A.page.click(tid('back'));

    // --- username login: remembered and prefilled; a wrong one counts as a wrong attempt ---
    await A.page.click(tid('back')); await A.page.click(tid('lock'));
    await userReady(A.page);
    assert.equal(await A.page.inputValue(tid('unlock-user')), 'alice_test');
    await A.page.fill(tid('unlock-user'), 'mallory');
    await A.page.fill(tid('unlock-pass'), PASS); await A.page.click(tid('unlock'));
    await A.page.waitForFunction(() => document.querySelector('.error')?.textContent === 'Wrong username or passphrase.', null, { timeout: 15000 });
    await A.page.fill(tid('unlock-user'), '@Alice_Test');
    await A.page.fill(tid('unlock-pass'), PASS); await A.page.click(tid('unlock'));
    await A.page.waitForSelector(tid('contact-Bob'), { timeout: 30000 });

    // --- history is on by default now, and it keeps PHOTOS and files, not just text ---
    await A.page.click(tid('contact-Bob'));
    await A.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-out"] img.attach')].some((i) => i.naturalWidth > 0), null, { timeout: 20000 });
    assert.match(await A.page.textContent(tid('log')), /notes\.txt[\s\S]*directions/);
    for (const p of [A, B]) assert.deepEqual(p.errors, []);
  } catch (e) { console.error('DEBUG', A.errors, B.errors); throw e; } finally { await browser.close(); }
});

test('a new phone: backup file, online login (username + passphrase) and move-to-phone — chats come along, messaging keeps working', { timeout: 300000 }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const PASS = 'correct horse battery staple';
  const A = await profile(browser, 'alice-old'), B = await profile(browser, 'bob-move');
  const P = [A, B];
  const logHas = (p, t) => p.page.waitForFunction((x) => (document.querySelector('[data-testid="log"]')?.textContent || '').includes(x), t, { timeout: 30000 });
  const openBob = async (p) => { await p.page.waitForSelector(tid('contact-Bob'), { timeout: 30000 }); await p.page.click(tid('contact-Bob')); };
  try {
    await onboard(A, 'Alice', PASS); await onboard(B, 'Bob', 'another long passphrase');
    await pairByText(A, B);
    await B.page.waitForSelector(`${tid('conn-state')}[data-online="true"]`);
    await send(A, 'before backup');
    await logHas(B, 'before backup');

    // --- 1. backup file ---
    await A.page.click(tid('back')); await openSetting(A.page, 'backups');
    await A.page.click(tid('backup-file'));
    await A.page.fill(tid('confirm-pass'), PASS);
    const [dl] = await Promise.all([A.page.waitForEvent('download', { timeout: 60000 }), A.page.click(tid('modal-ok'))]);
    assert.match(dl.suggestedFilename(), /^murmur-backup-\d{4}-\d\d-\d\d\.murmur$/);
    const file = join(mkdtempSync(join(tmpdir(), 'murmur-bk-')), dl.suggestedFilename());
    await dl.saveAs(file); // downloads vanish with the browser profile, and this "phone" is about to be lost
    // The conversation moves on after the backup, then the old phone is lost.
    await leaveSettings(A.page); await openBob(A);
    await send(A, 'after the backup');
    await logHas(B, 'after the backup');
    await send(B, 'reply after backup');
    await logHas(A, 'reply after backup');
    await A.page.context().close();

    const C = await profile(browser, 'alice-restored'); P.push(C);
    await C.page.click(tid('have-account')); await C.page.click(tid('restore-file'));
    await C.page.setInputFiles(tid('restore-file'), file);
    await C.page.fill(tid('restore-pass'), 'not my passphrase'); await C.page.click(tid('restore-go'));
    await C.page.waitForFunction(() => /Wrong passphrase/.test(document.querySelector('[data-testid="restore-error"]')?.textContent || ''), null, { timeout: 30000 });
    await C.page.fill(tid('restore-pass'), PASS); await C.page.click(tid('restore-go'));
    await openBob(C);
    await logHas(C, 'before backup'); // history came back
    await send(C, 'hello from my restored phone');   // held until the secure link is renewed
    await logHas(B, 'restored Murmur on a new phone');
    await logHas(B, 'hello from my restored phone');
    await send(B, 'welcome back');
    await logHas(C, 'welcome back');

    // --- 2. online backup → log in on another phone with just username + passphrase ---
    await C.page.click(tid('back')); await openSetting(C.page, 'backups');
    await C.page.click(tid('online-toggle'));
    await C.page.fill(tid('confirm-pass'), PASS); await C.page.click(tid('modal-ok'));
    await C.page.waitForFunction(() => /^On — last backup/.test(document.querySelector('[data-testid="online-status"]')?.textContent || ''), null, { timeout: 60000 });
    await C.page.context().close();

    const D = await profile(browser, 'alice-login'); P.push(D);
    await D.page.click(tid('have-account')); await D.page.click(tid('restore-online'));
    await D.page.fill(tid('login-user'), 'alice_test'); await D.page.fill(tid('login-pass'), 'wrong passphrase here');
    await D.page.click(tid('login-go'));
    await D.page.waitForFunction(() => /No online backup found/.test(document.querySelector('[data-testid="restore-error"]')?.textContent || ''), null, { timeout: 60000 });
    await D.page.fill(tid('login-pass'), PASS); await D.page.click(tid('login-go'));
    await openBob(D);
    await logHas(D, 'welcome back');
    await send(D, 'logged in on yet another phone');
    await logHas(B, 'logged in on yet another phone');
    await send(B, 'got it');
    await logHas(D, 'got it');

    // --- 3. move to a new phone: exact copy, then the old phone erases itself ---
    await D.page.click(tid('back')); await openSetting(D.page, 'backups');
    await D.page.click(tid('move-start'));
    await D.page.fill(tid('confirm-pass'), PASS); await D.page.click(tid('modal-ok'));
    await D.page.waitForFunction(() => document.querySelector('[data-testid="move-code"]')?.value.startsWith('murmur-move:'), null, { timeout: 60000 });
    const code = await D.page.inputValue(tid('move-code'));
    const E = await profile(browser, 'alice-moved'); P.push(E);
    await E.page.click(tid('have-account')); await E.page.click(tid('restore-move'));
    await E.page.fill(tid('move-paste'), code); await E.page.click(tid('move-paste-go'));
    await userReady(E.page);
    assert.equal(await E.page.inputValue(tid('unlock-user')), 'alice_test', 'same username, remembered');
    await E.page.fill(tid('unlock-pass'), PASS); await E.page.click(tid('unlock'));
    await D.page.waitForSelector(tid('get-started'), { timeout: 30000 }); // the old phone erased itself
    await openBob(E);
    await logHas(E, 'got it');
    await send(E, 'moved without a backup file');
    await logHas(B, 'moved without a backup file');
    await send(B, 'still here');
    await logHas(E, 'still here');
    for (const p of P) assert.deepEqual(p.errors.filter((e) => !/WebSocket connection/.test(e)), [], p.name);
  } catch (e) { for (const p of P) console.error('DEBUG', p.errors); throw e; } finally { await browser.close(); }
});

test('devices: see where your account is signed in; logging in elsewhere parks the old phone (no lost messages), take it back, sign a phone out', { timeout: 300000 }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const PASS = 'correct horse battery staple';
  const A = await profile(browser, 'alice-phone1'), B = await profile(browser, 'bob-dev');
  const P = [A, B];
  const logHas = (p, t) => p.page.waitForFunction((x) => (document.querySelector('[data-testid="log"]')?.textContent || '').includes(x), t, { timeout: 30000 });
  const openContact = async (p, name) => { await p.page.waitForSelector(tid(`contact-${name}`), { timeout: 30000 }); await p.page.click(tid(`contact-${name}`)); };
  const devices = async (p) => { await openSetting(p.page, 'devices'); await p.page.waitForSelector(tid('devices-list'), { timeout: 30000 }); };
  const rows = (p) => p.page.$$eval('[data-testid="devices-list"] li', (ls) => ls.map((l) => [l.dataset.state, l.textContent]));
  try {
    await onboard(A, 'Alice', PASS); await onboard(B, 'Bob', 'another long passphrase');
    await pairByText(A, B);
    await B.page.waitForSelector(`${tid('conn-state')}[data-online="true"]`);
    await send(B, 'hello phone one'); await logHas(A, 'hello phone one');

    // 1. One phone: it's listed as this phone, created here.
    await A.page.click(tid('back'));
    await devices(A);
    let r = await rows(A);
    assert.equal(r.length, 1);
    assert.equal(r[0][0], 'me');
    assert.match(r[0][1], /This phone[\s\S]*Active now[\s\S]*Created the account/);
    await A.page.click(tid('device-rename'));
    await A.page.fill(tid('device-name'), 'Alice’s Tecno'); await A.page.click(tid('modal-save'));
    await A.page.waitForFunction(() => /Alice’s Tecno/.test(document.querySelector('[data-testid="device-me"]')?.textContent || ''));
    await shot(A.page, 'd01-devices-one');

    // Online backup on, so another phone can log in with username + passphrase.
    await A.page.click(tid('back')); await A.page.click(tid('settings-backups'));
    await A.page.click(tid('online-toggle'));
    await A.page.fill(tid('confirm-pass'), PASS); await A.page.click(tid('modal-ok'));
    await A.page.waitForFunction(() => /^On — last backup/.test(document.querySelector('[data-testid="online-status"]')?.textContent || ''), null, { timeout: 60000 });
    await leaveSettings(A.page);

    // 2. Log in on a second phone WHILE the first is still open.
    const D = await profile(browser, 'alice-phone2'); P.push(D);
    await D.page.click(tid('have-account')); await D.page.click(tid('restore-online'));
    await D.page.fill(tid('login-user'), 'alice_test'); await D.page.fill(tid('login-pass'), PASS);
    await D.page.click(tid('login-go'));
    await openContact(D, 'Bob');
    await logHas(B, 'restored Murmur on a new phone');
    // Bob writes after the move. The new phone gets it; the old one must NOT swallow it (it used to:
    // it grabbed the message, couldn't decrypt it, and deleted it from the relay for good).
    // The case that used to LOSE messages: the new phone is closed, the old one is open. The old
    // phone receives Bob's message, can't decrypt it (it's keyed for the new phone)… and used to
    // delete it from the relay. Now it checks the device list, leaves it there and parks itself.
    await D.page.close();
    await send(B, 'after the move');
    await A.page.waitForSelector(tid('replaced'), { timeout: 30000 });
    D.page = await D.ctx.newPage(); await D.page.goto(ORIGIN + '/');
    await userReady(D.page); await D.page.fill(tid('unlock-pass'), PASS); await D.page.click(tid('unlock'));
    await openContact(D, 'Bob');
    await logHas(D, 'after the move'); // it waited on the relay for the right phone
    assert.match(await A.page.textContent(tid('replaced-by')), /Logged in with username \+ passphrase/);
    await shot(A.page, 'd02-replaced');
    await send(B, 'second after the move'); await logHas(D, 'second after the move');

    // The new phone sees both: itself (active) and the old one, replaced.
    await D.page.click(tid('back'));
    await devices(D);
    r = await rows(D);
    assert.deepEqual(r.map(([s]) => s), ['me', 'replaced']);
    assert.match(r[1][1], /Alice’s Tecno[\s\S]*Replaced/);
    await shot(D.page, 'd03-devices-two');
    await leaveSettings(D.page);

    // 3. Take it back on the first phone: the second gets parked, Bob's messages follow.
    await A.page.click(tid('take-back')); await A.page.click(tid('modal-take'));
    await A.page.waitForSelector(tid('tab-chats'), { timeout: 30000 });
    await openContact(A, 'Bob');
    await send(B, 'welcome back phone one');
    await logHas(A, 'welcome back phone one');
    await D.page.waitForSelector(tid('replaced'), { timeout: 30000 });
    assert.match(await D.page.textContent(tid('replaced-by')), /Alice’s Tecno[\s\S]*Took the account back/);

    // 4. Sign the second phone out from the first: it erases its copy next time it checks.
    await A.page.click(tid('back')); await devices(A);
    await A.page.waitForFunction(() => document.querySelectorAll('[data-testid="devices-list"] li').length === 2);
    await A.page.click(tid('device-signout')); await A.page.click(tid('modal-out'));
    await A.page.waitForSelector('[data-testid="devices-list"] li[data-state="out"]', { timeout: 30000 });
    await D.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // the owner opens it again
    await D.page.waitForFunction(() => /signed out of this phone from “Alice’s Tecno”/.test(document.body.textContent), null, { timeout: 30000 });
    await D.page.click(tid('modal-ok'));
    await D.page.waitForSelector(tid('get-started')); // erased: back to a fresh start
    // And phone one keeps working.
    await leaveSettings(A.page); await openContact(A, 'Bob');
    await send(A, 'all mine again'); await logHas(B, 'all mine again');
    for (const p of P) assert.deepEqual(p.errors.filter((e) => !/WebSocket connection/.test(e)), [], p.name);
  } catch (e) { for (const p of P) console.error('DEBUG', p.name, p.errors); throw e; } finally { await browser.close(); }
});

test('WhatsApp-style chat: photo & document bubbles, viewer, reply (menu, swipe, to a photo), forward, read receipts on/off', { timeout: 300000 }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const A = await profile(browser, 'alice-wa'), B = await profile(browser, 'bob-wa'), C = await profile(browser, 'carol-wa');
  const inLog = (p, re, sel = 'msg-in') => p.page.waitForFunction(([s, r]) => [...document.querySelectorAll(`[data-testid="${s}"]`)].some((m) => new RegExp(r).test(m.textContent)), [sel, re.source], { timeout: 20000 });
  const bubbleOf = (text, dir) => `${tid(`msg-${dir}`)}:has-text("${text}")`;
  const openMenu = async (p, text, dir) => { await p.page.locator(bubbleOf(text, dir)).last().click({ button: 'right' }); await p.page.waitForSelector(tid('message-menu')); };
  const statusOf = (p, text) => p.page.$eval(`${bubbleOf(text, 'out')} .status`, (e) => e.dataset.st);
  try {
    await onboard(A, 'Alice', 'correct horse battery staple');
    await onboard(B, 'Bob', 'another long passphrase');
    await onboard(C, 'Carol', 'yet another long passphrase');
    await pairByText(A, B);
    await A.page.click(tid('back')); await pairByText(A, C, {});
    await A.page.click(tid('back')); await A.page.click(tid('contact-Bob'));
    await B.page.waitForSelector(`${tid('conn-state')}[data-online="true"]`);

    // --- a photo is just the photo: no file name, no size, no Save; the time sits on the corner ---
    await A.page.setInputFiles(tid('file-input'), join(root, 'test/fixtures/media/photo-gps.jpg'));
    await A.page.click(tid('modal-send'));
    await B.page.waitForFunction(() => document.querySelector('[data-testid="msg-in"].media img.attach')?.naturalWidth > 0, null, { timeout: 20000 });
    await B.page.waitForFunction(() => document.getElementById('chatstatus')?.hidden !== false, null, { timeout: 5000 }); // no stuck "Receiving… 100%"
    const photoText = await B.page.$eval(`${tid('msg-in')}.media`, (e) => e.textContent);
    assert.doesNotMatch(photoText, /\.jpe?g|KB|Save/i, `photo bubble shows only the picture and the time (${photoText})`);
    assert.equal(await B.page.$$eval(`${tid('msg-in')}.media .meta.over`, (e) => e.length), 1);
    // Tap → full screen, with the REAL type and size, and Save / Forward / Reply.
    await B.page.click(`${tid('msg-in')} ${tid('media-open')}`);
    await B.page.waitForFunction(() => /^JPEG · [\d.]+ KB · \d+×\d+$/.test(document.querySelector('[data-testid="viewer-info"]')?.textContent || ''), null, { timeout: 10000 });
    for (const b of ['viewer-save', 'viewer-forward', 'viewer-reply']) await B.page.waitForSelector(tid(b));
    await shot(B.page, 'wa-2-viewer');
    await B.page.keyboard.press('Escape');
    assert.equal(await B.page.$$eval(tid('viewer'), (v) => v.length), 0, 'Escape closes the viewer');
    // Long-press on the photo (touch) opens the message menu — the photo being tappable mustn't block it.
    await B.page.$eval(`${tid('msg-in')} ${tid('media-open')}`, (el) => {
      const r = el.getBoundingClientRect(); const o = { pointerType: 'touch', pointerId: 3, isPrimary: true, bubbles: true, clientX: r.x + 30, clientY: r.y + 30 };
      el.dispatchEvent(new PointerEvent('pointerdown', o)); setTimeout(() => el.dispatchEvent(new PointerEvent('pointerup', o)), 700);
    });
    await B.page.waitForSelector(tid('menu-forward'), { timeout: 5000 });
    await B.page.keyboard.press('Escape');
    await B.page.waitForFunction(() => !document.querySelector('.spot'), null, { timeout: 3000 });
    assert.equal(await B.page.$$eval(tid('viewer'), (v) => v.length), 0, 'a long-press is not also a tap');

    // --- a document is a compact card: type badge, name, "PDF · size" — no Save chip ---
    await A.page.setInputFiles(tid('file-input'), { name: 'Quarterly report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% murmur test\n1 0 obj << >> endobj\ntrailer <<>>\n%%EOF\n') });
    await A.page.click(tid('modal-send'));
    await B.page.waitForSelector(`${tid('msg-in')} ${tid('file')} .docbadge`, { timeout: 20000 });
    assert.equal(await B.page.textContent(`${tid('msg-in')} ${tid('file')} .docbadge`), 'PDF');
    assert.match(await B.page.textContent(`${tid('msg-in')} ${tid('file')} small`), /^PDF · \d+ B$/);
    assert.doesNotMatch(await B.page.textContent(`${tid('msg-in')} ${tid('file')}`), /Save/);

    // --- reply from the menu: quote shows on both phones, with the right author ---
    await send(A, 'lunch at 1?');
    await inLog(B, /lunch at 1\?/);
    await openMenu(B, 'lunch at 1?', 'in');
    await B.page.click(tid('menu-reply'));
    await B.page.waitForSelector(`${tid('reply-bar')}:not([hidden])`);
    assert.match(await B.page.textContent(tid('reply-bar')), /Alice.*lunch at 1\?/s);
    await shot(B.page, 'wa-1-replybar');
    await send(B, 'yes! see you there');
    assert.equal(await B.page.$$eval(`${tid('reply-bar')}:not([hidden])`, (e) => e.length), 0, 'sent: the reply bar clears');
    await inLog(A, /see you there/);
    const q = await A.page.$eval(`${bubbleOf('see you there', 'in')} ${tid('quote')}`, (e) => ({ who: e.querySelector('.qwho').textContent, text: e.querySelector('.qtext').textContent.trim() }));
    assert.deepEqual(q, { who: 'You', text: 'lunch at 1?' }, 'Alice sees her own words quoted as "You"');
    assert.equal(await B.page.$eval(`${bubbleOf('see you there', 'out')} .qwho`, (e) => e.textContent), 'Alice');
    // Tapping the quote jumps to (and flashes) the original.
    await A.page.click(`${bubbleOf('see you there', 'in')} ${tid('quote')}`);
    await A.page.waitForSelector(`${bubbleOf('lunch at 1?', 'out')}.flash`);

    // --- swipe a bubble to the right (touch) to reply; ✕ cancels ---
    const swipe = (p, text, dir, dx) => p.page.$eval(bubbleOf(text, dir), (el, d) => {
      const r = el.getBoundingClientRect(); const o = { pointerType: 'touch', pointerId: 7, isPrimary: true, bubbles: true, clientX: r.x + 20, clientY: r.y + 10 };
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      for (let x = 0; x <= d; x += 10) el.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: o.clientX + x }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: o.clientX + d }));
    }, dx);
    await swipe(A, 'see you there', 'in', 30); // too short: nothing
    assert.equal(await A.page.$$eval(`${tid('reply-bar')}:not([hidden])`, (e) => e.length), 0, 'a small drag is not a reply');
    await swipe(A, 'see you there', 'in', 90);
    await A.page.waitForSelector(`${tid('reply-bar')}:not([hidden])`);
    await A.page.click(tid('reply-cancel'));
    assert.equal(await A.page.$$eval(`${tid('reply-bar')}:not([hidden])`, (e) => e.length), 0);
    await swipe(A, 'see you there', 'in', 90);
    await send(A, 'great 👍');
    await inLog(B, /great/);
    assert.equal(await B.page.$eval(`${bubbleOf('great', 'in')} .qwho`, (e) => e.textContent), 'You');

    // --- reply to a photo: the quote says "Photo" and shows a thumbnail ---
    await B.page.click(`${tid('msg-in')} ${tid('media-open')}`);
    await B.page.click(tid('viewer-reply'));
    await send(B, 'nice pic');
    await inLog(A, /nice pic/);
    await A.page.waitForTimeout(500); await shot(A.page, 'wa-3-quotes');
    assert.match(await A.page.textContent(`${bubbleOf('nice pic', 'in')} .qtext`), /Photo/);
    await A.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-in"]')].some((m) => /nice pic/.test(m.textContent) && m.querySelector('.qthumb')?.naturalWidth > 0), null, { timeout: 10000 });

    // --- forward Bob's message to Carol: a fresh copy, tagged "Forwarded", no quote, no trace of Bob ---
    await openMenu(A, 'see you there', 'in');
    await A.page.click(tid('menu-forward'));
    await A.page.check(tid('fwd-Carol'));
    await A.page.click(tid('modal-send'));
    await A.page.waitForFunction(() => /Forwarded to Carol/.test(document.body.textContent), null, { timeout: 15000 });
    await inLog(C, /yes! see you there/); // Carol is still in her chat with Alice from pairing
    const fwd = await C.page.$eval(bubbleOf('see you there', 'in'), (e) => ({ label: e.querySelector('[data-testid="forwarded"]')?.textContent.trim(), quote: !!e.querySelector('[data-testid="quote"]'), bob: /Bob/.test(e.textContent) }));
    assert.deepEqual(fwd, { label: 'Forwarded', quote: false, bob: false });
    // A photo forwarded from the viewer arrives as a photo.
    await A.page.click(`${tid('msg-out')} ${tid('media-open')}`);
    await A.page.click(tid('viewer-forward'));
    await A.page.check(tid('fwd-Carol'));
    await A.page.click(tid('modal-send'));
    await C.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-in"].media')].some((m) => m.querySelector('[data-testid="forwarded"]') && m.querySelector('img.attach')?.naturalWidth > 0), null, { timeout: 20000 });
    await shot(C.page, 'wa-4-forwarded');

    // --- read receipts: blue ✓✓ when Bob has the chat open… ---
    await send(A, 'read receipt check');
    await A.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-out"]')].some((m) => /read receipt check/.test(m.textContent) && m.querySelector('.status')?.dataset.st === 'read'), null, { timeout: 20000 });
    // …Bob turns them off just for Alice: she only gets "delivered" from now on…
    await B.page.click(tid('contact-info'));
    await B.page.selectOption(tid('contact-receipts'), 'off');
    await B.page.click(tid('back'));
    await send(A, 'are you reading this');
    await inLog(B, /are you reading this/);
    await A.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-out"]')].some((m) => /are you reading this/.test(m.textContent) && m.querySelector('.status')?.dataset.st === 'delivered'), null, { timeout: 20000 });
    await A.page.waitForTimeout(1500);
    assert.equal(await statusOf(A, 'are you reading this'), 'delivered', 'no read receipt was sent');
    // …and it's reciprocal: Bob doesn't see Alice's blue ticks either, even though she sends them.
    await send(B, 'quiet mode');
    await inLog(A, /quiet mode/);
    await B.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-out"]')].some((m) => /quiet mode/.test(m.textContent) && m.querySelector('.status')?.dataset.st === 'delivered'), null, { timeout: 20000 });
    await B.page.waitForTimeout(1500);
    assert.equal(await statusOf(B, 'quiet mode'), 'delivered');
    // Global switch: per-contact back to default, then everything off in Settings.
    await B.page.click(tid('contact-info'));
    await B.page.selectOption(tid('contact-receipts'), 'default');
    await B.page.click(tid('back')); await B.page.click(tid('back')); await openSetting(B.page, 'privacy');
    await B.page.uncheck(tid('read-receipts'));
    await leaveSettings(B.page); await B.page.click(tid('contact-Alice'));
    await send(A, 'global off check');
    await inLog(B, /global off check/);
    await A.page.waitForTimeout(2000);
    assert.equal(await statusOf(A, 'global off check'), 'delivered');
    // Earlier blue ticks stay blue on Alice's phone (her receipts are on).
    assert.equal(await statusOf(A, 'read receipt check'), 'read');
    await shot(A.page, 'wa-5-ticks');

    // --- everything survives a lock/unlock (replies, forwards, ticks are in the encrypted history) ---
    await A.page.click(tid('back')); await A.page.click(tid('lock'));
    await userReady(A.page); await A.page.fill(tid('unlock-pass'), 'correct horse battery staple'); await A.page.click(tid('unlock'));
    await A.page.click(tid('contact-Bob'));
    await A.page.waitForSelector(`${bubbleOf('see you there', 'in')} ${tid('quote')}`);
    assert.equal(await statusOf(A, 'read receipt check'), 'read');
    for (const p of [A, B, C]) assert.deepEqual(p.errors, [], `${p.name}: no page errors`);
  } finally { await browser.close(); }
});

test('Midnight theme, Settings sections, compact message menu, chat colour & wallpaper, and 24-hour Status', { timeout: 360000 }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const A = await profile(browser, 'alice-st'), B = await profile(browser, 'bob-st'), C = await profile(browser, 'carol-st');
  const css = (p, sel, prop) => p.page.$eval(sel, (e, pr) => getComputedStyle(e).getPropertyValue(pr).trim(), prop);
  const outBg = (p) => p.page.$eval(`${tid('msg-out')}:not(.media)`, (e) => getComputedStyle(e).backgroundColor);
  // What the chat screen really paints behind the messages (the computed image, not the class list).
  const chatPaint = (p) => p.page.$eval(".screen.chat", (e) => getComputedStyle(e).backgroundImage);
  const inLog = (p, re, sel = 'msg-in') => p.page.waitForFunction(([s, r]) => [...document.querySelectorAll(`[data-testid="${s}"]`)].some((m) => new RegExp(r).test(m.textContent)), [sel, re.source], { timeout: 20000 });
  try {
    await onboard(A, 'Alice', 'correct horse battery staple');
    await onboard(B, 'Bob', 'another long passphrase');
    await onboard(C, 'Carol', 'yet another long passphrase');

    // --- the default theme is Midnight Blue + Electric Teal ---
    assert.equal(await A.page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await css(A, 'body', 'background-color'), 'rgb(16, 28, 44)');   // #101C2C
    assert.equal(await css(A, ':root', '--accent'), '#43e6c1');
    assert.equal(await A.page.$eval('meta[name="theme-color"]', (m) => m.content), '#101c2c', 'the phone’s status bar matches');

    await pairByText(A, B);
    await A.page.click(tid('back')); await pairByText(A, C, {});
    await A.page.click(tid('back')); await A.page.click(tid('contact-Bob'));
    await B.page.waitForSelector(`${tid('conn-state')}[data-online="true"]`);

    // --- Settings is a hub of plain-language sections, with search ---
    await A.page.click(tid('back')); await A.page.click(tid('settings'));
    await shot(A.page, 'n01-settings-hub');
    for (const s of ['account', 'appearance', 'chats', 'privacy', 'security', 'calls', 'backups', 'internet', 'help']) {
      await A.page.click(tid(`settings-${s}`));
      await A.page.waitForSelector(tid(`settings-page-${s}`));
      await A.page.click(tid('back'));
    }
    await A.page.fill(tid('settings-search'), 'blue ticks');
    await A.page.waitForSelector(`${tid('settings-results')} ${tid('settings-privacy')}`);
    await A.page.fill(tid('settings-search'), 'backup');
    await A.page.click(`${tid('settings-results')} ${tid('settings-backups')}`);
    await A.page.waitForSelector(tid('backup-file'));
    await A.page.click(tid('back'));
    await A.page.fill(tid('settings-search'), 'zzzz');
    await A.page.waitForFunction(() => /No setting matches/.test(document.body.textContent));
    await A.page.fill(tid('settings-search'), '');
    // Theme switch: Light is preserved (the reload check is at the end — a reload drops the nearby link).
    await A.page.click(tid('settings-appearance'));
    await A.page.click(tid('theme-light'));
    assert.equal(await css(A, 'body', 'background-color'), 'rgb(246, 247, 249)');
    await A.page.click(tid('theme-dark'));
    assert.equal(await css(A, 'body', 'background-color'), 'rgb(16, 28, 44)');

    // --- chat colour & wallpaper for ALL chats (Appearance), with a live preview ---
    await A.page.click(tid('bubble-violet')); // saved to the encrypted vault, then the page re-draws
    await A.page.waitForFunction((s) => getComputedStyle(document.querySelector(s)).backgroundColor === 'rgb(91, 58, 140)', `${tid('look-preview')} .msg.out`, { timeout: 5000 });
    await A.page.click(tid('wall-aurora'));
    await A.page.waitForSelector(`${tid('look-preview')}.wall-aurora`);
    await shot(A.page, 'n02-appearance');
    await leaveSettings(A.page); await A.page.click(tid('contact-Bob'));
    await A.page.waitForSelector(`${tid('conn-state')}[data-online="true"]`);
    await send(A, 'hi in violet');
    assert.equal(await outBg(A), 'rgb(91, 58, 140)', 'sent bubbles use the chosen colour');
    assert.equal(await A.page.$eval('.screen.chat', (e) => e.classList.contains('wall-aurora')), true);
    // Classes alone proved nothing last time (a later `.chat { background }` rule painted over every
    // wallpaper while the classes were all correct) — so check what the screen actually PAINTS.
    assert.match(await chatPaint(A), /radial-gradient/, 'aurora wallpaper is really drawn');
    // The message bar floats over the chat: no bar background, the list scrolls underneath it,
    // and the last message is padded clear of it.
    const bar = await A.page.$eval('.chat .composer', (f) => {
      const cs = getComputedStyle(f), log = document.querySelector('#log');
      return { pos: cs.position, bg: cs.backgroundColor, logBottom: log.getBoundingClientRect().bottom, barBottom: f.getBoundingClientRect().bottom,
        pad: parseFloat(getComputedStyle(log).paddingBottom), h: f.getBoundingClientRect().height,
        pill: getComputedStyle(f.querySelector('textarea')).borderRadius };
    });
    assert.equal(bar.pos, 'absolute', 'the message bar floats');
    assert.equal(bar.bg, 'rgba(0, 0, 0, 0)', 'no solid strip behind the floating bar');
    assert.ok(Math.abs(bar.logBottom - bar.barBottom) < 2, 'messages run behind the bar to the bottom edge');
    assert.ok(bar.pad >= bar.h, `last message clears the bar (padding ${bar.pad} ≥ bar ${bar.h})`);
    assert.equal(bar.pill, '22px', 'the text box is a pill');
    // …and ONE chat gets its own look (contact info → Chat colour & wallpaper), including a photo.
    await A.page.click(tid('contact-info')); await A.page.click(tid('contact-look'));
    await A.page.click(tid('bubble-rose'));
    await A.page.waitForSelector(`${tid('bubble-rose')}.on`);
    await A.page.setInputFiles(tid('wall-photo-input'), join(root, 'test/fixtures/media/photo-gps.jpg'));
    await A.page.waitForFunction(() => /Wallpaper set/.test(document.body.textContent), null, { timeout: 15000 });
    await A.page.waitForSelector(`${tid('look-preview')}.wall-photo`);
    await A.page.check(tid('wall-dim'));
    await A.page.waitForSelector(`${tid('look-preview')}.wall-dim`);
    await A.page.click(tid('back')); await A.page.click(tid('back'));
    assert.equal(await outBg(A), 'rgb(155, 47, 74)', 'this chat: rose');
    await A.page.waitForFunction(() => /^url\("blob:/.test(getComputedStyle(document.querySelector('.screen.chat')).getPropertyValue('--wall-img').trim()), null, { timeout: 10000 });
    assert.equal(await A.page.$eval('.screen.chat', (e) => e.classList.contains('wall-photo') && e.classList.contains('wall-dim')), true);
    assert.match(await chatPaint(A), /url\("blob:/, 'the photo is really drawn behind the chat (Prince: "refused to change after selecting a photo")');
    await shot(A.page, 'n03-chat-photo-wallpaper');
    // Carol's chat still follows the default (violet + aurora).
    await A.page.click(tid('back')); await A.page.click(tid('contact-Carol'));
    assert.equal(await A.page.$eval('.screen.chat', (e) => e.classList.contains('wall-aurora')), true);
    assert.match(await chatPaint(A), /radial-gradient/);
    // The look is private: Bob's phone is untouched.
    await inLog(B, /hi in violet/);
    assert.equal(await B.page.$eval('.screen.chat', (e) => e.classList.contains('wall-none')), true);
    assert.equal(await chatPaint(B), 'none');
    // Reset brings Bob's chat back to the default.
    await A.page.click(tid('back')); await A.page.click(tid('contact-Bob')); await A.page.click(tid('contact-info')); await A.page.click(tid('contact-look'));
    await A.page.click(tid('look-reset'));
    await A.page.waitForSelector(`${tid('bubble-default')}.on`);
    await A.page.click(tid('back')); await A.page.click(tid('back'));
    assert.equal(await outBg(A), 'rgb(91, 58, 140)');

    // --- the message menu is a compact card beside the message, not a full-width dialog ---
    await A.page.locator(`${tid('msg-out')}:has-text("hi in violet")`).click({ button: 'right' });
    await A.page.waitForSelector(tid('message-menu'));
    const box = await A.page.$eval(tid('message-menu'), (e) => { const r = e.getBoundingClientRect(); return { w: r.width, vw: innerWidth, right: innerWidth - r.right }; });
    assert.ok(box.w < box.vw * 0.75, `menu is compact (${Math.round(box.w)} of ${box.vw}px)`);
    assert.ok(box.right < box.vw / 2, 'my message → the menu sits on the right, beside it');
    assert.equal(await A.page.evaluate(() => document.activeElement?.dataset.testid), 'menu-reply', 'focus is in the menu (keyboard / screen readers)');
    await shot(A.page, 'n04-message-menu');
    await A.page.keyboard.press('ArrowDown');
    assert.equal(await A.page.evaluate(() => document.activeElement?.dataset.testid), 'menu-forward');
    assert.equal(await A.page.$eval(tid('menu-me'), (e) => e.classList.contains('danger')), true, 'destructive actions are red');
    await A.page.click(tid('menu-backdrop'), { position: { x: 12, y: 12 } }); // tap empty space
    await A.page.waitForFunction(() => !document.querySelector('.spot'));

    // --- Status: Alice shares a text update with "only Bob" → Bob sees it, Carol never receives it ---
    await A.page.click(tid('back')); await openSetting(A.page, 'privacy');
    await shot(A.page, 'n09-privacy');
    await A.page.check(tid('status-aud-only'));
    await A.page.check(tid('status-aud-Bob'));
    await leaveSettings(A.page);
    await A.page.click(tid('tab-status'));
    await A.page.click(tid('status-new-text'));
    await A.page.fill(tid('status-text'), 'Beach day 🌊');
    await A.page.click(tid('status-bg')); // cycle the background colour
    await shot(A.page, 'n05-status-composer');
    await A.page.click(tid('status-post'));
    await A.page.waitForFunction(() => /Status posted — 1 contact can see it/.test(document.body.textContent), null, { timeout: 15000 });
    await B.page.click(tid('back'));
    await B.page.waitForSelector(tid('tabdot-status'), { timeout: 20000 }); // a dot on the Status tab
    await B.page.click(tid('tab-status'));
    await B.page.waitForSelector(`${tid('status-Alice')} .ring.unseen`);
    await shot(B.page, 'n06-status-list');
    await B.page.click(tid('status-Alice'));
    await shot(B.page, 'n07-status-viewer');
    assert.equal(await B.page.textContent(tid('status-shown')), 'Beach day 🌊');
    assert.equal(await B.page.$eval(`${tid('status-viewer')} .ststage`, (e) => e.className), 'ststage stbg-midnight stfont-sans', 'the background Alice chose');
    // Bob replies to the status → it arrives in their chat, quoting the status.
    await B.page.fill(tid('status-reply'), 'enjoy!');
    await B.page.click(tid('status-reply-send'));
    await B.page.waitForFunction(() => /Reply sent/.test(document.body.textContent));
    await B.page.click(tid('status-close'));
    await B.page.waitForSelector(`${tid('status-Alice')} .ring:not(.unseen)`); // now under "Viewed"
    // Alice sees who viewed it — the status fills the whole screen…
    await A.page.click(tid('status-mine'));
    await A.page.waitForFunction(() => document.querySelector('[data-testid="status-seen-count"]')?.textContent === '1', null, { timeout: 20000 });
    const full = await A.page.$eval(`${tid('status-viewer')} .ststage`, (e) => { const r = e.getBoundingClientRect(); return [r.top, r.left, Math.round(r.width) === innerWidth, Math.round(r.height) >= innerHeight]; });
    assert.deepEqual(full, [0, 0, true, true], 'status is edge to edge, bars and buttons float on it');
    // …and "Viewed by" slides up from the BOTTOM (not a box in the middle), pausing the status.
    await A.page.click(tid('status-seen-by'));
    await A.page.waitForFunction(() => { const sh = document.querySelector('[data-testid="viewed-by"]'); if (!sh) return false; const r = sh.getBoundingClientRect(); return Math.abs(r.bottom - innerHeight) < 2 && r.top > innerHeight * 0.25; }, null, { timeout: 3000 });
    assert.equal(await A.page.textContent(`${tid('viewed-by')} h2`), 'Viewed by 1');
    await A.page.waitForTimeout(300); await shot(A.page, 'n10-viewed-by-sheet');
    assert.match(await A.page.textContent(tid('viewed-by-list')), /Bob/);
    assert.equal(await A.page.$$eval(tid('status-waiting'), (e) => e.length), 0, 'Bob confirmed he has it — nobody is waiting');
    assert.equal(await A.page.$eval(tid('status-viewer'), (e) => e.classList.contains('paused')), true, 'the status waits while the sheet is up');
    await A.page.keyboard.press('Escape'); // closes the sheet only…
    await A.page.waitForFunction(() => !document.querySelector('[data-testid="viewed-by"]'));
    assert.equal(await A.page.$$eval(tid('status-viewer'), (e) => e.length), 1, '…the status is still open');
    // Swiping up on your own status opens it too; tapping the dimmed area closes it.
    await A.page.$eval(`${tid('status-viewer')} .ststage`, (el) => {
      const o = { pointerId: 5, isPrimary: true, bubbles: true, clientX: innerWidth / 2, clientY: innerHeight * 0.7, pointerType: 'touch' };
      el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointerup', { ...o, clientY: innerHeight * 0.4 }));
    });
    await A.page.waitForSelector(tid('viewed-by'));
    await A.page.click(tid('viewed-by-scrim'), { position: { x: 20, y: 20 } });
    await A.page.waitForFunction(() => !document.querySelector('[data-testid="viewed-by"]'));
    await A.page.click(tid('status-close'));
    await A.page.click(tid('tab-chats')); await A.page.click(tid('contact-Bob'));
    await inLog(A, /enjoy!/);
    assert.match(await A.page.textContent(`${tid('msg-in')}:has-text("enjoy!") ${tid('quote')}`), /Status: Beach day/);
    // Carol (not in the audience) has nothing.
    await C.page.click(tid('back')); await C.page.click(tid('tab-status'));
    // Her own row is the familiar one: + on her picture, "Disappears after 24 hours", camera + pencil.
    assert.match(await C.page.textContent(tid('status-mine')), /Add status\s*Disappears after 24 hours/);
    await shot(C.page, 'n13-status-add-row');
    for (const b of ['status-new-photo', 'status-new-text']) assert.equal(await C.page.$eval(tid(b), (e) => e.closest('.mystatus') !== null && e.textContent.trim() === ''), true, `${b}: an icon button in the row`);
    await C.page.waitForTimeout(1500);
    assert.equal(await C.page.$$eval(tid('status-Alice'), (e) => e.length), 0, 'not shared with Carol — never sent to her phone');

    // --- a photo status, then deleting it removes it from Bob's phone too ---
    await A.page.click(tid('back')); await A.page.click(tid('tab-status'));
    await A.page.setInputFiles(tid('status-photo-input'), join(root, 'test/fixtures/media/photo-gps.jpg'));
    await A.page.fill(tid('status-caption'), 'sunset');
    await A.page.click(tid('status-post'));
    await B.page.waitForSelector(`${tid('status-Alice')} .ring.unseen`, { timeout: 20000 });
    await B.page.click(tid('status-Alice'));
    await B.page.waitForFunction(() => document.querySelector('[data-testid="status-shown-photo"]')?.naturalWidth > 0, null, { timeout: 10000 });
    assert.match(await B.page.textContent(tid('status-viewer')), /sunset/);
    await shot(B.page, 'n08-status-photo');
    await B.page.keyboard.press('Escape');
    await A.page.click(tid('status-mine'));
    await A.page.keyboard.press('ArrowRight'); // to the photo (newest)
    await A.page.click(tid('status-delete')); await A.page.click(tid('modal-true'));
    await A.page.waitForFunction(() => /removed from your contacts’ phones/.test(document.body.textContent), null, { timeout: 10000 });
    await B.page.waitForFunction(() => document.querySelector('[data-testid="status-Alice"]')?.textContent.includes('Alice') && !/2 updates/.test(document.querySelector('[data-testid="status-Alice"]').textContent), null, { timeout: 20000 });
    // Statuses survive a lock / unlock (stored encrypted), then expire on their own after 24 h.
    await B.page.click(tid('tab-chats')); await B.page.click(tid('lock'));
    await userReady(B.page); await B.page.fill(tid('unlock-pass'), 'another long passphrase'); await B.page.click(tid('unlock'));
    await B.page.click(tid('tab-status'));
    await B.page.waitForSelector(tid('status-Alice'));
    await B.page.evaluate(() => { const real = Date.now; Date.now = () => real() + 24 * 3600 * 1000 + 60_000; });
    await B.page.waitForFunction(() => !document.querySelector('[data-testid="status-Alice"]'), null, { timeout: 70_000 }); // the minute sweep removes it
    // The theme is remembered across a reload — already on the lock screen, before unlocking.
    await C.page.click(tid('settings')); await C.page.click(tid('settings-appearance')); await C.page.click(tid('theme-light'));
    await C.page.reload(); await userReady(C.page);
    assert.equal(await C.page.evaluate(() => document.documentElement.dataset.theme), 'light');
    assert.equal(await css(C, 'body', 'background-color'), 'rgb(246, 247, 249)');
    for (const p of [A, B, C]) assert.deepEqual(p.errors, [], `${p.name}: no page errors`);
  } finally { await browser.close(); }
});

test('Status over the internet: reaches a phone that was closed, confirmed back to the owner ("Not received yet" until then)', { timeout: 300000 }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const C = await profile(browser, 'carol-sr'), D = await profile(browser, 'dave-sr');
  const DPASS = 'tr0ub4dor & 3 bananas';
  try {
    await onboard(C, 'Carol', 'correct horse battery staple');
    await onboard(D, 'Dave', DPASS);
    await C.page.waitForFunction(() => /connected to the relay|Far away/.test(document.body.textContent));
    // Connected ONLY through the internet relay (invite link) — like two phones far apart.
    await C.page.click(tid('link-invite'));
    await C.page.waitForFunction((s) => /#i=/.test(document.querySelector(s)?.value || ''), tid('invite-link'));
    const link = await C.page.$eval(tid('invite-link'), (e) => e.value);
    await C.page.click(tid('back'));
    await D.page.goto('about:blank'); await D.page.goto(link);
    await userReady(D.page); await D.page.fill(tid('unlock-pass'), DPASS); await D.page.click(tid('unlock'));
    await D.page.waitForSelector(tid('join-invite')); await D.page.click(tid('join-invite'));
    await send(D, 'hello carol');
    await C.page.waitForSelector(tid('contact-Dave'), { timeout: 20000 }); await C.page.click(tid('contact-Dave'));
    await C.page.click(tid('accept-request'));
    await send(C, 'hi dave');
    await D.page.waitForFunction(() => /hi dave/.test(document.body.textContent), null, { timeout: 20000 });

    // The chat keeps the screen: connection state under the name, a slim nearby line, no timer row.
    assert.match(await C.page.textContent(`header.bar ${tid('conn-state')}`), /internet/);
    assert.equal(await C.page.$eval(tid('nearby-card'), (e) => e.classList.contains('slim')), true);
    assert.equal(await C.page.$$eval(`.screen.chat ${tid('ttl')}`, (e) => e.length), 0, 'disappearing messages moved to contact info');
    await C.page.click(tid('contact-info'));
    await C.page.selectOption(tid('ttl'), '3600');
    await C.page.click(tid('back'));
    await C.page.waitForFunction((s) => /1 hour/.test(document.querySelector(s)?.textContent || ''), `header.bar ${tid('conn-state')}`, { timeout: 5000 });
    await shot(C.page, 'n11-chat-relay');

    // Dave's phone is CLOSED. Carol posts a status.
    const dctx = D.page.context();
    await D.page.close();
    await C.page.click(tid('back')); await C.page.click(tid('tab-status'));
    await C.page.click(tid('status-new-text'));
    await C.page.fill(tid('status-text'), 'posted while Dave was away');
    await C.page.click(tid('status-post'));
    // Carol can see it hasn't reached him yet.
    await C.page.click(tid('status-mine'));
    await C.page.click(tid('status-seen-by'));
    await C.page.waitForSelector(tid('status-waiting'));
    await C.page.waitForTimeout(300); await shot(C.page, 'n12-waiting-sheet');
    assert.match(await C.page.textContent(tid('status-waiting')), /Not received yet\s*D?Dave\s*waiting/);

    // Dave opens Murmur later: the relay held it; his phone shows it and confirms back.
    const D2 = await dctx.newPage();
    await D2.goto(ORIGIN + '/'); await userReady(D2); await D2.fill(tid('unlock-pass'), DPASS); await D2.click(tid('unlock'));
    await D2.click(tid('tab-status'));
    await D2.waitForSelector(`${tid('status-Carol')} .ring.unseen`, { timeout: 20000 });
    // Carol's open sheet updates by itself — no longer waiting for Dave.
    await C.page.waitForFunction(() => !document.querySelector('[data-testid="status-waiting"]'), null, { timeout: 20000 });
    // Dave views it → Carol's "Viewed by" (still open) shows him.
    await D2.click(tid('status-Carol'));
    await D2.waitForSelector(tid('status-shown'));
    await C.page.waitForFunction(() => /Dave/.test(document.querySelector('[data-testid="viewed-by-list"]')?.textContent || ''), null, { timeout: 20000 });
    assert.equal(await C.page.textContent(`${tid('viewed-by')} h2`), 'Viewed by 1');
    assert.deepEqual(C.errors, []);
  } finally { await browser.close(); }
});

test('voice & video calls: ring, accept, media flows both ways, mute, hang up, decline, and call permissions', { timeout: 240000 }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  const A = await profile(browser, 'alice-call'), B = await profile(browser, 'bob-call');
  const state = (p, st) => p.page.waitForFunction((s) => document.querySelector('[data-testid="call-screen"]')?.dataset.state === s, st, { timeout: 30000 });
  const gone = (p) => p.page.waitForFunction(() => !document.querySelector('[data-testid="call-screen"]'), null, { timeout: 15000 });
  const logHas = (p, re) => p.page.waitForFunction((r) => new RegExp(r).test(document.querySelector('[data-testid="log"]')?.textContent || ''), re, { timeout: 15000 });
  try {
    await onboard(A, 'Alice', 'correct horse battery staple'); await onboard(B, 'Bob', 'another long passphrase');
    await pairByText(A, B);
    await A.page.waitForSelector(tid('call-video'));

    // --- video call: ring → accept → connected, real media in both directions ---
    await A.page.click(tid('call-video'));
    await state(A, 'calling');
    await state(B, 'ringing');
    assert.match(await B.page.textContent(tid('call-screen')), /Alice[\s\S]*Incoming video call/);
    await B.page.click(tid('call-accept'));
    await state(A, 'connected'); await state(B, 'connected');
    for (const p of [A, B]) {
      await p.page.waitForFunction(() => { const v = document.querySelector('[data-testid="call-remote"]'); return v?.videoWidth > 0 && v.srcObject?.getAudioTracks().length === 1; }, null, { timeout: 20000 });
    }
    await A.page.click(tid('call-mute'));
    assert.equal(await A.page.getAttribute(tid('call-mute'), 'aria-pressed'), 'true');
    await A.page.waitForFunction(() => /0:0[1-9]/.test(document.querySelector('[data-testid="call-timer"]').textContent), null, { timeout: 10000 });
    await A.page.click(tid('call-end'));
    await gone(A); await gone(B);
    await logHas(A, '↗ Video call · 0:0'); await logHas(B, '↙ Video call · 0:0');

    // --- declined voice call ---
    await A.page.click(tid('call-voice'));
    await state(B, 'ringing');
    await B.page.click(tid('call-decline'));
    await gone(A); await gone(B);
    await logHas(A, 'Voice call — declined');

    // --- permissions: Bob turns video calls off → Alice's video button disappears (voice stays) ---
    await B.page.click(tid('back')); await openSetting(B.page, 'calls');
    await B.page.uncheck(tid('allow-video'));
    await A.page.waitForFunction(() => !document.querySelector('[data-testid="call-video"]') && !!document.querySelector('[data-testid="call-voice"]'), null, { timeout: 15000 });
    // …and blocks Alice entirely → no call buttons at all
    await leaveSettings(B.page); await B.page.click(tid('contact-Alice')); await B.page.click(tid('contact-info'));
    await B.page.uncheck(tid('allow-calls-from'));
    await A.page.waitForFunction(() => !document.querySelector('[data-testid="call-voice"]') && !document.querySelector('[data-testid="call-video"]'), null, { timeout: 15000 });
    for (const p of [A, B]) assert.deepEqual(p.errors, []);
  } catch (e) { console.error('DEBUG', A.errors, B.errors); throw e; } finally { await browser.close(); }
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
    await userReady(D.page); await D.page.fill(tid('unlock-pass'), 'tr0ub4dor & 3 bananas'); await D.page.click(tid('unlock'));
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
    // Dave has the chat open, so it turns blue (read) — through the relay too.
    await C.page.waitForFunction(() => document.querySelector('[data-testid="msg-out"] .status')?.dataset.st === 'read', null, { timeout: 20000 });

    // The "Connect nearby" card can be hidden with its ✕ — and brought back from contact info.
    await C.page.waitForSelector(tid('nearby-card'));
    await C.page.click(tid('nearby-dismiss'));
    await C.page.waitForFunction((s) => !document.querySelector(s), tid('nearby-card'), { timeout: 5000 });
    await C.page.click(tid('back')); await C.page.click(tid('contact-Dave'));
    assert.equal(await C.page.$$eval(tid('nearby-card'), (e) => e.length), 0, 'stays hidden');
    await C.page.click(tid('contact-info'));
    await C.page.waitForSelector(tid('contact-nearby-show')); // still reachable here
    await C.page.click(tid('nearby-unhide'));
    await C.page.click(tid('back'));
    await C.page.waitForSelector(tid('nearby-card'));

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
    assert.equal(await D.page.$$eval(tid('verify-banner'), (e) => e.length), 0);

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
  await userReady(to.page); await to.page.fill(tid('unlock-pass'), toPass); await to.page.click(tid('unlock'));
  await to.page.waitForSelector(tid('join-invite')); await to.page.click(tid('join-invite'));
  await to.page.waitForSelector(tid('verify-banner'));
  await to.page.click(tid('back'));
}
/** A real finger: touch pointer events, and — like every touchscreen — pointerleave right after pointerup. */
const touchHold = async (page, selector, ms) => {
  await page.$eval(selector, (el) => { const r = el.getBoundingClientRect(); const o = { pointerType: 'touch', pointerId: 7, isPrimary: true, bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', o)); el.__o = o; });
  await page.waitForTimeout(ms);
  await page.$eval(selector, (el) => { el.dispatchEvent(new PointerEvent('pointerup', el.__o)); el.dispatchEvent(new PointerEvent('pointerleave', el.__o)); });
};
// Settings is a hub of sections (Account, Appearance, Chats, Privacy, Security, Calls, Backups,
// Internet, Help). openSetting() goes straight to one; leaveSettings() returns to the chat list.
const openSetting = async (page, section) => { await page.click(tid('settings')); await page.click(tid(`settings-${section}`)); };
const leaveSettings = async (page) => { await page.click(tid('back')); await page.click(tid('tab-chats')); };
// SHOTS=dir saves screenshots of the voice UI states (for eyeballing the design; off in CI).
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }); };
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
    await P.Dave.page.click(`${tid('msg-in')} ${tid('media-open')}`);
    await P.Dave.page.click(tid('viewer-save'));
    await P.Dave.page.waitForFunction(() => !!window.__shared, null, { timeout: 5000 });
    assert.deepEqual(await P.Dave.page.evaluate(() => window.__shared), { n: 1, name: 'photo-gps.jpg', type: 'image/jpeg', jpeg: true, secret: false },
      'phone save hands the cleaned photo, with its real image type, to the share sheet');
    await P.Dave.page.click(tid('viewer-close'));

    // --- speed: a big camera photo goes out at standard size (one relay message), original is one tap away ---
    const bigB64 = await P.Carol.page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 4032; c.height = 3024; const g = c.getContext('2d');
      const img = g.createImageData(c.width, c.height); for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 2654435761) >>> 24;
      g.putImageData(img, 0, 0);
      const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
      const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s);
    });
    const big = Buffer.from(bigB64, 'base64');
    await P.Carol.page.setInputFiles(tid('file-input'), { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: big });
    await P.Carol.page.waitForSelector(tid('review-image'), { timeout: 20000 });
    assert.match(await P.Carol.page.textContent('.modal'), /Standard quality · 1600×1200/);
    await P.Carol.page.check(tid('review-original'));
    assert.match(await P.Carol.page.textContent('.modal'), /Original quality/);
    await P.Carol.page.uncheck(tid('review-original'));
    const sizeText = await P.Carol.page.textContent('.modal');
    const kb = +(/IMG_0001\.jpg · ([\d.]+) (KB|MB)/.exec(sizeText) || [])[1] * (/· [\d.]+ MB/.test(sizeText) ? 1024 : 1);
    assert.ok(kb > 0 && kb * 1024 < big.length / 3, `standard photo (${kb} KB) is far smaller than the original (${(big.length / 1024) | 0} KB)`);
    await P.Carol.page.click(tid('modal-send'));
    await P.Dave.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-in"] img')].some((i) => i.naturalWidth === 1600), null, { timeout: 30000 });

    // --- location: GPS position, distance and direction, no map server ---
    await P.Carol.page.click(tid('share-location'));
    await P.Carol.page.click(tid('modal-once'));
    await P.Dave.page.waitForSelector(`${tid('msg-in')} ${tid('loc-card')}`, { timeout: 20000 });
    await P.Dave.page.click(`${tid('msg-in')} ${tid('how-far')}`);
    await P.Dave.page.waitForFunction(() => /km S of you|km SSE of you|km SSW of you/.test(document.querySelector('[data-testid="msg-in"] [data-testid="loc-relative"]')?.textContent || ''), null, { timeout: 15000 });

    // --- a recorder that fails to start must not leave the mic button dead (iPhone regression) ---
    await P.Carol.page.evaluate(() => {
      const real = MediaRecorder.prototype.start; let once = true;
      MediaRecorder.prototype.start = function (...a) { if (once) { once = false; throw new Error('NotSupportedError'); } return real.apply(this, a); };
    });
    await holdButton(P.Carol.page, tid('voice'), 800);
    await P.Carol.page.waitForFunction(() => /Couldn’t start recording/.test(document.body.textContent), null, { timeout: 5000 });
    assert.equal(await P.Carol.page.$$eval('.modal', (e) => e.length), 0);
    assert.equal(await P.Carol.page.getAttribute('form.composer', 'data-voice'), 'idle', 'failed start leaves the composer usable');
    const C = P.Carol.page, D = P.Dave.page;
    const voiceState = (s) => C.waitForFunction((v) => document.querySelector('form.composer')?.dataset.voice === v, s, { timeout: 15000 });
    // --- on a TOUCHSCREEN: lifting the finger also fires pointerleave; that must not count as "slide away to cancel" ---
    await touchHold(C, tid('voice'), 1600);
    await voiceState('review'); // listen-first happens IN the composer bar…
    assert.equal(await C.$$eval('.modal', (e) => e.length), 0, '…not in a pop-up over the chat');
    await C.waitForFunction(() => +document.querySelector('[data-testid="voice-review"]')?.dataset.duration > 0.5, null, { timeout: 15000 });
    await C.click(tid('voice-trash'));
    await voiceState('idle');
    // --- a quick tap = hands-free: timer runs, live waveform, ⏸ stops and lets you listen ---
    await touchHold(C, tid('voice'), 150);
    await voiceState('locked');
    await C.waitForFunction(() => document.querySelector('[data-testid="voice-timer"]')?.textContent === '0:01', null, { timeout: 5000 });
    await shot(C, '2-locked');
    await C.click(tid('voice-stop'));
    await voiceState('review');
    await C.waitForSelector('[data-testid="voice-review"][data-duration]');
    await shot(C, '3-review');
    await C.click(tid('voice-trash'));
    // --- sliding the finger well away from the button cancels ---
    await C.$eval(tid('voice'), (el) => { const r = el.getBoundingClientRect(); const o = { pointerType: 'touch', pointerId: 9, isPrimary: true, bubbles: true, clientX: r.x + 5, clientY: r.y + 5 };
      el.dispatchEvent(new PointerEvent('pointerdown', o)); el.__o = o; });
    await voiceState('holding');
    await C.waitForTimeout(1200);
    await shot(C, '1-holding');
    await C.$eval(tid('voice'), (el) => { const o = { ...el.__o, clientY: el.__o.clientY - 200 }; el.dispatchEvent(new PointerEvent('pointermove', o)); el.dispatchEvent(new PointerEvent('pointerup', o)); });
    await voiceState('idle');
    assert.equal(await C.$$eval(tid('voice-review'), (e) => e.length), 0, 'slid away: discarded');
    // --- leaving the chat mid-recording releases the microphone and throws the clip away ---
    await touchHold(C, tid('voice'), 150);
    await voiceState('locked');
    await C.click(tid('back')); await C.click(tid('contact-Dave'));
    await voiceState('idle');
    // --- hold, talk, lift → review → 🗑 sends nothing; ➤ sends it ---
    await holdButton(C, tid('voice'), 1600);
    await voiceState('review');
    await C.click(tid('voice-trash'));
    await holdButton(C, tid('voice'), 1600);
    await voiceState('review');
    await C.click(tid('voice-send-now'));
    await voiceState('idle');
    await D.waitForFunction(() => +document.querySelector('[data-testid="msg-in"] [data-testid="voice-clip"]')?.dataset.duration > 0.5, null, { timeout: 30000 });
    assert.equal(await D.$$eval(tid('voice-clip'), (e) => e.length), 1, 'the deleted clips never arrived');
    // The bubble is a player, not a file: no file name, no size, no Save button.
    const bubbleText = await D.$eval(`${tid('msg-in')}:has(${tid('voice-clip')})`, (el) => el.textContent);
    assert.doesNotMatch(bubbleText, /voice-\d+|\.(m4a|webm|ogg)|KB|Save/, `voice bubble shows only player + time (${bubbleText})`);
    assert.equal(await D.$$eval(`${tid('msg-in')}:has(${tid('voice-clip')}) ${tid('file')}`, (e) => e.length), 0);
    assert.match(await D.textContent(tid('voice-time')), /^0:0[1-9]$/, 'shows its length');
    await shot(D, '4-received'); await shot(C, '4-sent');
    // Play / pause / speed.
    await D.click(tid('voice-play'));
    await D.waitForFunction(() => document.querySelector('[data-testid="voice-clip"]').dataset.state === 'playing', null, { timeout: 5000 });
    await D.click(tid('voice-speed'));
    await shot(D, '5-playing');
    assert.equal(await D.$eval(tid('voice-audio'), (a) => a.playbackRate), 1.5);
    assert.equal(await D.textContent(tid('voice-speed')), '1.5×');
    // At the end it resets by itself: ▶ again, full length shown, no bars lit.
    await D.waitForFunction(() => document.querySelector('[data-testid="voice-clip"]').dataset.state === 'paused', null, { timeout: 15000 });
    assert.match(await D.textContent(tid('voice-time')), /^0:0[1-9]$/);
    assert.equal(await D.$$eval(`${tid('voice-clip')} .vwave span.on`, (e) => e.length), 0);
    // Pause mid-way.
    await D.click(tid('voice-play'));
    await D.waitForFunction(() => document.querySelector('[data-testid="voice-clip"]').dataset.state === 'playing', null, { timeout: 5000 });
    await D.click(tid('voice-play'));
    await D.waitForFunction(() => document.querySelector('[data-testid="voice-clip"]').dataset.state === 'paused', null, { timeout: 5000 });
    // --- hands-free, then ➤ while still recording: sent straight away, like WhatsApp ---
    await touchHold(C, tid('voice'), 150);
    await voiceState('locked');
    await C.waitForTimeout(1200);
    await C.click(tid('voice-send-now'));
    await D.waitForFunction((s) => document.querySelectorAll(s).length === 2, tid('voice-clip'), { timeout: 30000 });
    // Real walkie-talkie mode (Settings): sends the moment you let go, no question asked.
    await C.click(tid('back')); await openSetting(C, 'chats');
    await C.selectOption(tid('voice-send'), 'release');
    await leaveSettings(C); await C.click(tid('contact-Dave'));
    await holdButton(C, tid('voice'), 1600);
    await D.waitForFunction((s) => document.querySelectorAll(s).length === 3, tid('voice-clip'), { timeout: 30000 });
    assert.equal(await C.$$eval(tid('voice-review'), (e) => e.length), 0, 'no review step in walkie-talkie mode');
    // Voice notes are media, not documents: they're listed under Media (with a player), never Docs.
    await C.click(tid('chat-title')); await C.click(tid('open-shared'));
    assert.deepEqual(await C.$$eval('.tabs button', (b) => b.map((x) => x.textContent)), ['Media 5', 'Docs 0', 'Links 0'], '2 photos + 3 voice notes; no docs');
    assert.equal(await C.$$eval(`${tid('shared-voice')} ${tid('voice-clip')}`, (e) => e.length), 3);
    await C.click(tid('tab-docs'));
    assert.equal(await C.$$eval(tid('shared-docs'), (e) => e.length), 0);
    await C.click(tid('back')); await C.click(tid('back'));

    // --- a video call between phones that are NOT nearby: every signal goes through the relay mailbox ---
    assert.equal(await P.Carol.page.getAttribute(tid('conn-state'), 'data-online'), 'false', 'internet link, not a nearby one');
    // This test relay has no TURN key, and "Hide my IP" is on by default: both phones must be ASKED, never silently exposed.
    await P.Carol.page.click(tid('call-video'));
    await P.Carol.page.waitForSelector('.modal', { timeout: 10000 });
    assert.match(await P.Carol.page.textContent('.modal'), /IP address can’t be hidden/);
    await P.Carol.page.click(tid('modal-true'));
    await P.Dave.page.waitForFunction(() => document.querySelector('[data-testid="call-screen"]')?.dataset.state === 'ringing', null, { timeout: 20000 });
    await P.Dave.page.click(tid('call-accept'));
    await P.Dave.page.waitForSelector('.modal', { timeout: 10000 });
    await P.Dave.page.click(tid('modal-true'));
    for (const p of [P.Carol, P.Dave]) {
      await p.page.waitForFunction(() => document.querySelector('[data-testid="call-screen"]')?.dataset.state === 'connected', null, { timeout: 30000 });
      await p.page.waitForFunction(() => document.querySelector('[data-testid="call-remote"]')?.videoWidth > 0, null, { timeout: 20000 });
    }
    await P.Carol.page.click(tid('call-end'));
    await P.Dave.page.waitForFunction(() => !document.querySelector('[data-testid="call-screen"]'), null, { timeout: 15000 });

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
