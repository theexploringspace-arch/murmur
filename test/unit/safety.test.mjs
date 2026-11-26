import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeUrl, linkify, inspectFile, sniff, lookalikeNames, skeleton, punycodeToUnicode, cleanFileName, registrableDomain } from '../../src/js/core/safety.js';

const risk = (u) => analyzeUrl(u).risk;

test('dangerous link schemes are blocked outright', () => {
  for (const u of ['javascript:alert(1)', 'JavaScript:fetch("//x")', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd', 'intent://x#Intent;end', 'ms-msdt:/id', 'search-ms:query=x'])
    assert.equal(risk(u), 'blocked', u);
});

test('normal links to real brands are low risk', () => {
  for (const u of ['https://www.apple.com/iphone', 'https://paypal.com', 'https://accounts.google.com/', 'https://en.wikipedia.org/wiki/Cat', 'https://www.bbc.co.uk/news', 'https://gtbank.com'])
    assert.equal(risk(u), 'low', u);
});

test('lookalike / homograph domains are flagged high and decoded for display', () => {
  const cyr = analyzeUrl('https://аpple.com/login');                 // Cyrillic "а"
  assert.equal(cyr.risk, 'high');
  assert.equal(cyr.host, 'xn--pple-43d.com');
  assert.equal(cyr.unicodeHost, 'аpple.com');
  assert.ok(cyr.reasons.some((r) => /Apple/.test(r)));
  for (const u of ['https://paypa1.com', 'http://paypal-secure-login.com', 'https://apple.com.verify-account.top/x', 'https://rnicrosoft.com', 'https://amaz0n.co', 'https://g00gle.com'])
    assert.equal(risk(u), 'high', u);
  assert.equal(risk('https://pineapple.com'), 'low', 'no false positive on words merely containing a brand');
});

test('hidden destinations: user@host, raw IPs, shorteners, http, .zip TLD', () => {
  const at = analyzeUrl('https://www.paypal.com@evil.example/login');
  assert.equal(at.risk, 'high'); assert.equal(at.host, 'evil.example');
  assert.equal(risk('http://192.168.4.1/admin'), 'high');
  assert.equal(risk('https://bit.ly/3abc'), 'medium');
  assert.equal(risk('http://example.com'), 'medium');
  assert.equal(risk('https://setup.zip'), 'high');
});

test('linkify finds links in messages (including ones without https://) and leaves text alone', () => {
  const segs = linkify('Pay here: paypa1.com/pay, or see www.apple.com. Mail me at bob@gmail.com e.g. file.txt');
  const links = segs.filter((s) => s.type === 'link').map((s) => s.text);
  assert.deepEqual(links, ['paypa1.com/pay', 'www.apple.com']);
  assert.equal(segs.map((s) => s.text).join(''), 'Pay here: paypa1.com/pay, or see www.apple.com. Mail me at bob@gmail.com e.g. file.txt');
  assert.equal(linkify('click javascript:alert(document.cookie)').find((s) => s.type === 'link').analysis.risk, 'blocked');
});

test('punycode decoding (RFC 3492 sample) and registrable domains', () => {
  assert.equal(punycodeToUnicode('xn--mnchen-3ya'), 'münchen');
  assert.equal(punycodeToUnicode('xn--80ak6aa92e'), 'аррӏе');
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('login.bank.com.ng'), 'bank.com.ng');
});

const bytes = (...a) => Uint8Array.from(a);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13);
const EXE = bytes(0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0);
const html = new TextEncoder().encode('<!DOCTYPE html><form action=https://evil>password</form>');

test('files are identified by content, not by name', () => {
  assert.equal(sniff(PNG), 'image/png');
  assert.equal(sniff(EXE), 'application/x-msdownload');
  assert.equal(sniff(html), 'text/html');
  assert.equal(sniff(new TextEncoder().encode('<?xml version="1.0"?><svg onload=x>')), 'image/svg+xml');
});

test('disguised and dangerous files are flagged; real photos display inline', () => {
  assert.deepEqual([inspectFile('cat.png', 'image/png', PNG).verdict, inspectFile('cat.png', 'image/png', PNG).inline], ['ok', true]);
  const fakePhoto = inspectFile('holiday.jpg', 'image/jpeg', EXE);
  assert.equal(fakePhoto.verdict, 'danger'); assert.equal(fakePhoto.inline, false);
  assert.ok(fakePhoto.reasons.some((r) => /Disguised program|Pretends/.test(r)));
  assert.equal(inspectFile('invoice.pdf.exe', '', EXE).verdict, 'danger');
  assert.equal(inspectFile('update.apk', '', bytes(0x50, 0x4b, 3, 4)).verdict, 'danger');
  assert.equal(inspectFile('report.docm', '', bytes(0x50, 0x4b, 3, 4)).verdict, 'danger');
  assert.equal(inspectFile('login.html', 'text/html', html).verdict, 'warn');
  assert.equal(inspectFile('pic.svg', 'image/svg+xml', new TextEncoder().encode('<svg>')).inline, false, 'SVG never displayed');
  const rlo = inspectFile('photo‮gnp.exe', '', EXE);
  assert.equal(rlo.verdict, 'danger'); assert.ok(!/‮/.test(rlo.name));
  assert.equal(cleanFileName('a/b\\c.txt').name, 'a_b_c.txt');
});

test('lookalike contact names are caught (impersonation of an existing contact)', () => {
  const existing = ['Prince', 'Mum', 'Ada Lovelace'];
  assert.deepEqual(lookalikeNames('Prіnce', existing), ['Prince']);      // Cyrillic і
  assert.deepEqual(lookalikeNames('Pr1nce', existing), ['Prince']);
  assert.deepEqual(lookalikeNames('Princee', existing), ['Prince']);
  assert.deepEqual(lookalikeNames('ada  lovelace', existing), ['Ada Lovelace']);
  assert.deepEqual(lookalikeNames('Tunde', existing), []);
  assert.equal(skeleton('Ｐｒｉｎｃｅ'), 'prince', 'full-width letters normalised');
});

// ---------------------------------------------------------------- impostors & risky asks
import { impersonates, riskyAsk } from '../../src/js/core/safety.js';

test('impersonates: catches copycat display names AND @usernames, ignores the contact itself', () => {
  const mine = [{ id: 'a', name: 'Prince', username: 'prince' }, { id: 'b', name: 'Mommy', username: 'adaeze.o' }];
  assert.deepEqual(impersonates({ id: 'x', name: 'Pr1nce', username: 'prince_' }, mine), { name: 'Prince', user: 'prince' });
  assert.deepEqual(impersonates({ id: 'x', name: 'Mummy', username: 'adaeze_o' }, mine), { name: 'Mommy', user: 'adaeze.o' });
  // Names under 4 letters only match exactly ("Mom" vs "Mum" would flag half of everyone's contacts).
  assert.equal(impersonates({ id: 'x', name: 'Ada' }, [{ id: 'y', name: 'Ade' }]).name, null);
  assert.deepEqual(impersonates({ id: 'x', name: 'Tunde', username: 'tunde99' }, mine), { name: null, user: null });
  assert.deepEqual(impersonates({ id: 'x', name: 'Tunde' }, mine), { name: null, user: null }, 'no username yet');
  assert.deepEqual(impersonates(mine[0], mine), { name: null, user: null }, 'not compared with itself');
});

test('riskyAsk: money, gift cards, crypto, bank details, codes and passwords — not ordinary chat', () => {
  for (const t of [
    'Please send me 50000 naira, I will pay back tomorrow', 'can you transfer $200 to this account', 'Buy me an iTunes card and send the code',
    'I need USDT urgently', 'send me your account number', 'What is the OTP you just got?', 'forward the verification code they sent you',
    'tell me your passcode? no — tell me your password', 'It’s an emergency, please send money now', 'Kindly lend me ₦20000',
  ]) assert.equal(riskyAsk(t), true, t);
  for (const t of [
    'See you at 5', 'I paid for lunch already', 'the code compiles now', 'my password manager is great', 'send me the photos from yesterday',
    'Happy birthday!', 'transfer the files when you can', 'what’s the wifi password', '', null,
  ]) assert.equal(riskyAsk(t), false, String(t));
});
