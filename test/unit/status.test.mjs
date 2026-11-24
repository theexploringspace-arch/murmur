// Status updates: validation of what arrives, the 24-hour life, who may see it, list order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStatus, statusTag, readStatusId, cleanAudience, audience, live, statusRows, showFor, ago, expiresAt, STATUS_TTL, MAX_STATUS_TEXT, MAX_CAPTION, STATUS_BGS, STATUS_FONTS, SKEW } from '../../src/js/core/status.js';

const NOW = 1_800_000_000_000, ID = '0123456789abcdef';
const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);

test('a status lives exactly 24 hours', () => {
  assert.equal(STATUS_TTL, 86_400_000);
  assert.equal(expiresAt(NOW), NOW + 86_400_000);
});

test('readStatus: accepts a good text status and normalises it', () => {
  const s = readStatus({ id: ID, ts: NOW - 1000, kind: 'text', text: '  hello  ', bg: 'violet', font: 'serif' }, NOW);
  assert.deepEqual(s, { id: ID, ts: NOW - 1000, exp: NOW - 1000 + STATUS_TTL, kind: 'text', text: 'hello', bg: 'violet', font: 'serif' });
});

test('readStatus: rejects anything a phone shouldn’t show', () => {
  const ok = { id: ID, ts: NOW, kind: 'text', text: 'x' };
  assert.equal(readStatus({ ...ok, ts: NOW - STATUS_TTL }, NOW), null, 'already expired');
  assert.equal(readStatus({ ...ok, ts: NOW + SKEW + 1 }, NOW), null, 'from the future — would live longer than 24 h');
  assert.ok(readStatus({ ...ok, ts: NOW + SKEW - 1 }, NOW), 'a clock a few minutes fast is fine');
  assert.equal(readStatus({ ...ok, text: '   ' }, NOW), null, 'empty');
  assert.equal(readStatus({ ...ok, id: 'nope' }, NOW), null, 'bad id');
  assert.equal(readStatus({ ...ok, kind: 'photo' }, NOW), null, 'photos come as files, not here');
  assert.equal(readStatus({ ...ok, ts: 'soon' }, NOW), null);
  assert.equal(readStatus(null, NOW), null);
  assert.equal(readStatus({ ...ok, text: 'y'.repeat(5000) }, NOW).text.length, MAX_STATUS_TEXT, 'long text is cut');
  const odd = readStatus({ ...ok, bg: 'url(evil)', font: 'comic' }, NOW);
  assert.equal(odd.bg, STATUS_BGS[0]); assert.equal(odd.font, STATUS_FONTS[0]); // only known CSS classes are ever used
});

test('statusTag (photo status): validated the same way; caption capped', () => {
  assert.deepEqual(statusTag({ id: ID, ts: NOW, cap: ' sunset ' }, NOW), { id: ID, ts: NOW, exp: NOW + STATUS_TTL, cap: 'sunset' });
  assert.equal(statusTag({ id: ID, ts: NOW - STATUS_TTL - 1 }, NOW), null);
  assert.equal(statusTag({ id: ID, ts: NOW + SKEW + 1 }, NOW), null);
  assert.equal(statusTag({ id: 'x', ts: NOW }, NOW), null);
  assert.equal(statusTag('st', NOW), null);
  assert.equal(statusTag({ id: ID, ts: NOW, cap: 'c'.repeat(999) }, NOW).cap.length, MAX_CAPTION);
  assert.equal(statusTag({ id: ID, ts: NOW, cap: 42 }, NOW).cap, '');
  assert.equal(readStatusId({ id: ID }), ID); assert.equal(readStatusId({ id: '../x' }), null);
});

test('audience: all contacts / all except / only — never a pending stranger', () => {
  const contacts = [{ id: A }, { id: B }, { id: C, request: true }];
  assert.deepEqual(audience(undefined, contacts), [A, B], 'default: everyone accepted');
  assert.deepEqual(audience({ mode: 'except', list: [A] }, contacts), [B]);
  assert.deepEqual(audience({ mode: 'only', list: [B, C] }, contacts), [B], 'a stranger stays out even if picked');
  assert.deepEqual(audience({ mode: 'only', list: [] }, contacts), []);
  assert.deepEqual(cleanAudience({ mode: 'bogus', list: ['x', A, A] }), { mode: 'all', list: [A] });
  assert.deepEqual(cleanAudience(null), { mode: 'all', list: [] });
});

test('statusRows: unseen people first, then newest; expired updates vanish', () => {
  const by = new Map([
    [A, [{ id: '1', ts: NOW - 5000, exp: NOW + 1, seen: true }]],
    [B, [{ id: '2', ts: NOW - 9000, exp: NOW + 1, seen: false }, { id: '3', ts: NOW - 1000, exp: NOW + 1, seen: true }]],
    [C, [{ id: '4', ts: NOW - 100, exp: NOW - 1, seen: false }]],
  ]);
  const rows = statusRows(by, NOW);
  assert.deepEqual(rows.map((r) => r.cid), [B, A], 'C expired; B has something unseen so comes first');
  assert.equal(rows[0].firstUnseen, 0); assert.equal(rows[0].statuses.length, 2); assert.equal(rows[0].latest, NOW - 1000);
  assert.deepEqual(live([{ exp: NOW + 1 }, { exp: NOW }], NOW), [{ exp: NOW + 1 }]);
});

test('showFor: photos 6 s; text scales with length, between 4 and 10 s', () => {
  assert.equal(showFor({ kind: 'photo' }), 6000);
  assert.equal(showFor({ kind: 'text', text: 'hi' }), 4000);
  assert.equal(showFor({ kind: 'text', text: 'x'.repeat(700) }), 10000);
  const mid = showFor({ kind: 'text', text: 'x'.repeat(100) }); assert.ok(mid > 4000 && mid < 10000);
});

test('ago', () => {
  assert.equal(ago(NOW, NOW), 'just now');
  assert.equal(ago(NOW - 5 * 60000, NOW), '5m ago');
  assert.equal(ago(NOW - 3 * 3600000, NOW), '3h ago');
  assert.equal(ago(NOW + 99999, NOW), 'just now', 'a fast sender clock never shows negative time');
});
