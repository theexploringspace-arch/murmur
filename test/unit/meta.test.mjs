// Replies, forwards, read receipts and file-type labels — the rules behind the WhatsApp-style features.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  msgMeta, quoteOf, resolveQuote, kindOf, kindLabel, snippet, forwardHops, forwardLabel,
  receiptsOn, toConfirm, readIds, statusAfter, typeLabel, SNIPPET,
} from '../../src/js/core/meta.js';

const ME = 'a'.repeat(32), BOB = 'b'.repeat(32), CAROL = 'c'.repeat(32);
const MID = '0123456789abcdef';

test('quoteOf: who wrote it is absolute (contact ids), so it means the same on every phone', () => {
  assert.deepEqual(quoteOf({ id: MID, dir: 'out', text: 'hi' }, ME, BOB), { id: MID, by: ME, k: 'text', t: 'hi' });
  assert.deepEqual(quoteOf({ id: MID, dir: 'in', text: 'yo' }, ME, BOB), { id: MID, by: BOB, k: 'text', t: 'yo' });
  // group: the actual sender, not the group
  assert.equal(quoteOf({ id: MID, dir: 'in', from: CAROL, text: 'x' }, ME, 'g:' + 'd'.repeat(32)).by, CAROL);
});

test('quoteOf: kinds and previews for every message type', () => {
  const photo = { id: MID, dir: 'in', file: { name: 'IMG.jpg', mime: 'image/jpeg', safety: { inline: true } } };
  const voice = { id: MID, dir: 'in', file: { name: 'v.m4a', kind: 'voice', playable: 'audio' } };
  const video = { id: MID, dir: 'in', file: { name: 'a.mp4', playable: 'video', safety: { inline: false } } };
  const doc = { id: MID, dir: 'in', file: { name: 'Quarterly report final v2.pdf', mime: 'application/pdf', safety: { inline: false } } };
  assert.deepEqual([photo, voice, video, doc].map((m) => quoteOf(m, ME, BOB).k), ['photo', 'voice', 'video', 'file']);
  assert.equal(quoteOf(photo, ME, BOB).t, '', 'a photo has no text: the label "Photo" is shown instead');
  assert.equal(quoteOf(doc, ME, BOB).t, 'Quarterly report final v2.pdf');
  assert.equal(kindOf({ loc: { lat: 1, lon: 2 } }), 'loc');
  assert.equal(kindOf({ sos: { text: 'help' } }), 'sos');
  assert.equal(kindOf({ file: { mime: 'image/png' } }), 'photo', 'a stored photo not yet re-checked still counts as a photo');
  assert.equal(kindLabel('photo'), 'Photo'); assert.equal(kindLabel('voice'), 'Voice message'); assert.equal(kindLabel('file', 'a.pdf'), 'a.pdf');
});

test('snippet: one line, at most 120 characters', () => {
  assert.equal(snippet('  hello\n\n  world  '), 'hello world');
  const long = snippet('x'.repeat(500));
  assert.equal(long.length, SNIPPET); assert.ok(long.endsWith('…'));
});

test('msgMeta: accepts well-formed tags, drops anything odd', () => {
  assert.deepEqual(msgMeta({ re: { id: MID, by: BOB, k: 'photo', t: 'x' }, fw: 2 }), { re: { id: MID, by: BOB, k: 'photo', t: 'x' }, fw: 2 });
  assert.deepEqual(msgMeta({}), {});
  assert.deepEqual(msgMeta(null), {});
  assert.deepEqual(msgMeta({ re: { id: 'not hex!', by: BOB } }), {}, 'bad id');
  assert.deepEqual(msgMeta({ re: { id: MID, by: 'bob' } }), {}, 'bad author');
  assert.deepEqual(msgMeta({ re: 'abc' }), {});
  assert.equal(msgMeta({ re: { id: MID, by: BOB, k: '<script>' } }).re.k, 'text', 'unknown kind → text');
  assert.equal(msgMeta({ re: { id: MID, by: BOB, t: 'y'.repeat(10_000) } }).re.t.length, SNIPPET, 'preview is capped');
  for (const bad of [0, -1, 1.5, '3', true, NaN]) assert.deepEqual(msgMeta({ fw: bad }), {}, `fw ${bad}`);
  assert.equal(msgMeta({ fw: 1e9 }).fw, 99);
  assert.deepEqual(msgMeta({ fwd: BOB }), {}, 'the GROUP relay field `fwd` is not the forward tag');
});

test('resolveQuote: our own copy beats the sender’s preview (a quote can’t put words in your mouth)', () => {
  const re = { id: MID, by: ME, k: 'text', t: 'I owe you $500' };
  const mine = { id: MID, dir: 'out', text: 'see you at 5' };
  assert.equal(resolveQuote(re, mine).t, 'see you at 5');
  assert.equal(resolveQuote(re, mine).found, true);
  assert.equal(resolveQuote(re, null).t, 'I owe you $500', 'not on this phone: only then is their preview shown');
  assert.equal(resolveQuote(re, null).found, false);
  const gone = resolveQuote(re, { id: MID, deleted: true });
  assert.equal(gone.t, 'This message was deleted'); assert.equal(gone.gone, true);
  assert.equal(resolveQuote(null, mine), null);
});

test('forwarding: hop count and label', () => {
  assert.equal(forwardHops({ text: 'x' }), 1);
  assert.equal(forwardHops({ fw: 1 }), 2);
  assert.equal(forwardHops({ fw: 99 }), 99);
  assert.equal(forwardLabel(0), ''); assert.equal(forwardLabel(1), 'Forwarded'); assert.equal(forwardLabel(4), 'Forwarded');
  assert.equal(forwardLabel(5), 'Forwarded many times');
});

test('read receipts: on by default; per-contact choice beats the global one', () => {
  assert.equal(receiptsOn({}, {}), true);
  assert.equal(receiptsOn({ readReceipts: false }, {}), false);
  assert.equal(receiptsOn({ readReceipts: false }, { receipts: 'on' }), true);
  assert.equal(receiptsOn({ readReceipts: true }, { receipts: 'off' }), false);
  assert.equal(receiptsOn(undefined, undefined), true);
});

test('toConfirm: only incoming, real, not-yet-confirmed messages', () => {
  const msgs = [
    { id: 'a1a1a1a1', dir: 'in', text: 'x' },
    { id: 'b2b2b2b2', dir: 'out', text: 'mine' },
    { id: 'c3c3c3c3', dir: 'in', text: 'seen', rs: 1 },
    { id: 'd4d4d4d4', dir: 'in', system: true, text: 'call' },
    { id: 'e5e5e5e5', dir: 'in', deleted: true },
    { id: 'f6f6f6f6', dir: 'in', file: {} },
  ];
  assert.deepEqual(toConfirm(msgs), ['a1a1a1a1', 'f6f6f6f6']);
  assert.deepEqual(toConfirm(undefined), []);
});

test('readIds: validated, de-duplicated, capped at 200', () => {
  assert.deepEqual(readIds({ ids: [MID, MID, 'x', 5, null, 'ABCDEF12'] }), [MID]);
  assert.equal(readIds({ ids: Array.from({ length: 500 }, (_, i) => i.toString(16).padStart(16, '0')) }).length, 200);
  assert.deepEqual(readIds({ ids: 'nope' }), []);
  assert.deepEqual(readIds(null), []);
});

test('statusAfter: ticks only move forward; failure never hides a confirmed message', () => {
  assert.equal(statusAfter('sent', 'delivered'), 'delivered');
  assert.equal(statusAfter('delivered', 'read'), 'read');
  assert.equal(statusAfter('sent', 'read'), 'read', 'read implies delivered');
  assert.equal(statusAfter('read', 'delivered'), 'read', 'a late delivery receipt must not undo read');
  assert.equal(statusAfter('queued', 'sent'), 'sent');
  assert.equal(statusAfter('delivered', 'sent'), 'delivered');
  assert.equal(statusAfter('queued', 'failed'), 'failed');
  assert.equal(statusAfter('sent', 'failed'), 'failed');
  assert.equal(statusAfter('delivered', 'failed'), 'delivered');
  assert.equal(statusAfter('read', 'failed'), 'read');
  assert.equal(statusAfter('failed', 'delivered'), 'delivered', 'it got there after all');
  assert.equal(statusAfter(undefined, 'sent'), 'sent');
  assert.equal(statusAfter('sent', 'bogus'), 'sent');
});

test('typeLabel: from the detected content type, falling back to the extension', () => {
  assert.equal(typeLabel('image/jpeg', 'x.png'), 'JPEG', 'content wins over the name');
  assert.equal(typeLabel('image/png'), 'PNG');
  assert.equal(typeLabel('video/quicktime'), 'MOV');
  assert.equal(typeLabel('application/pdf'), 'PDF');
  assert.equal(typeLabel('audio/mp4;codecs=mp4a'), 'M4A');
  assert.equal(typeLabel('application/octet-stream', 'report.docx'), 'DOCX');
  assert.equal(typeLabel('', 'noext'), 'FILE');
});
