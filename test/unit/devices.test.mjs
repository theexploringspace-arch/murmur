import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceKeys, sealRow, openRow, deviceState, deviceName, isRecent, HEARTBEAT_MS, CHECK_MS } from '../../src/js/core/devices.js';

const T = 1_700_000_000_000;
const take = (id, at, via = 'new', name = id) => ({ k: 'take', id, at, via, name });
const here = (id, at, name = id) => ({ k: 'here', id, at, name });
const out = (id, to, at) => ({ k: 'out', id, to, at });
const A = 'phoneAAAAAAAA', B = 'phoneBBBBBBBB', C = 'phoneCCCCCCCC';

test('seal/open round-trips; another account, tampering and junk all read as nothing', async () => {
  const k1 = await deviceKeys(new Uint8Array(32).fill(1)), k2 = await deviceKeys(new Uint8Array(32).fill(2));
  const row = take(A, T, 'online', 'Chrome on Android');
  const sealed = await sealRow(k1.key, row);
  assert.deepEqual(await openRow(k1.key, sealed), row);
  assert.equal(await openRow(k2.key, sealed), null, 'a different account can’t read it');
  const bad = sealed.slice(); bad[bad.length - 1] ^= 1;
  assert.equal(await openRow(k1.key, bad), null, 'tampered');
  assert.equal(await openRow(k1.key, new Uint8Array(40)), null, 'junk');
  // A well-sealed row with nonsense fields is still refused.
  assert.equal(await openRow(k1.key, await sealRow(k1.key, { k: 'take', id: 'x', at: T, via: 'new', name: 'n' })), null, 'short id');
  assert.equal(await openRow(k1.key, await sealRow(k1.key, { k: 'take', id: A, at: T, via: 'evil', name: 'n' })), null, 'unknown via');
});

test('the devices box is unrelated to the inbox and differs per account', async () => {
  const s = new Uint8Array(32).fill(7);
  const a = await deviceKeys(s), b = await deviceKeys(new Uint8Array(32).fill(8));
  assert.equal(a.box.length, 32);
  assert.notDeepEqual(a.box, s);
  assert.notDeepEqual(a.box, b.box);
});

test('one phone: active, not superseded', () => {
  const st = deviceState([take(A, T), here(A, T + 1000)], A, T + 2000);
  assert.equal(st.activeId, A);
  assert.equal(st.superseded, false);
  assert.equal(st.devices.length, 1);
  assert.equal(st.devices[0].last, T + 1000);
});

test('a later login on another phone takes over; the old phone learns it was superseded', () => {
  const rows = [take(A, T), here(A, T + 10), take(B, T + 20, 'online', 'Safari on iPhone')];
  const forA = deviceState(rows, A, T + 30), forB = deviceState(rows, B, T + 30);
  assert.equal(forA.superseded, true);
  assert.equal(forB.superseded, false);
  assert.equal(forB.activeId, B);
  assert.deepEqual(forB.devices.map((d) => [d.id, d.active]), [[B, true], [A, false]], 'this phone first, then the others');
});

test('ORDER decides, not clocks: a phone whose clock is years ahead does not win', () => {
  const rows = [take(A, T + 10 * 365 * 86400_000), take(B, T)];  // A's clock is wildly ahead; B came later
  assert.equal(deviceState(rows, A, T).activeId, B);
  assert.equal(deviceState(rows, A, T).superseded, true);
  // …and a far-future "last seen" is clamped to now, so it can't look "active" forever.
  assert.ok(deviceState(rows, B, T).devices.find((d) => d.id === A).last <= T);
});

test('taking the account back flips it again', () => {
  const rows = [take(A, T), take(B, T + 1, 'online'), take(A, T + 2, 'back')];
  assert.equal(deviceState(rows, A).superseded, false);
  assert.equal(deviceState(rows, B).superseded, true);
  assert.equal(deviceState(rows, A).devices.find((d) => d.id === A).via, 'back');
});

test('sign-out: only the active phone can sign another out; a stale copy cannot', () => {
  const rows = [take(A, T), take(B, T + 1, 'online'), out(B, A, T + 2)];
  assert.equal(deviceState(rows, A).signedOut, true, 'B (active) signed A out');
  const forged = [take(A, T), take(B, T + 1, 'online'), out(A, B, T + 2)]; // A is no longer active
  assert.equal(deviceState(forged, B).signedOut, false, 'the superseded copy can’t sign the active one out');
  assert.equal(deviceState([take(A, T), out(A, A, T + 1)], A).signedOut, false, 'can’t sign yourself out by accident');
});

test('a signed-out phone that later takes the account back is no longer signed out', () => {
  const rows = [take(A, T), take(B, T + 1), out(B, A, T + 2), take(A, T + 3, 'back')];
  const st = deviceState(rows, A);
  assert.equal(st.signedOut, false); assert.equal(st.superseded, false);
});

test('a phone that never wrote (fresh) is not "superseded"; an empty box has no active phone', () => {
  assert.equal(deviceState([take(B, T)], C).superseded, false);
  const empty = deviceState([], A);
  assert.equal(empty.activeId, null); assert.equal(empty.superseded, false); assert.deepEqual(empty.devices, []);
});

test('heartbeat cadence stays far below the relay’s 5000-row cap over its 30-day lifetime', () => {
  const perPhoneMonth = (30 * 86400_000) / HEARTBEAT_MS;
  assert.ok(perPhoneMonth * 3 < 5000, `3 phones × ${perPhoneMonth} rows`);
  assert.ok(CHECK_MS < HEARTBEAT_MS);
  assert.equal(isRecent({ last: T }, T + 60_000), true);
  assert.equal(isRecent({ last: T }, T + 3 * 3600_000), false);
});

test('device names people recognise', () => {
  const ua = {
    android: 'Mozilla/5.0 (Linux; Android 14; TECNO KJ7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    ipados: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
    firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
    chromeios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1',
  };
  assert.equal(deviceName(ua.android), 'Chrome on Android');
  assert.equal(deviceName(ua.iphone), 'Safari on iPhone');
  assert.equal(deviceName(ua.ipados), 'Safari on iPad');
  assert.equal(deviceName(ua.win), 'Edge on Windows');
  assert.equal(deviceName(ua.samsung), 'Samsung Internet on Android');
  assert.equal(deviceName(ua.firefox), 'Firefox on Linux');
  assert.equal(deviceName(ua.chromeios), 'Chrome on iPhone');
  assert.equal(deviceName(''), 'Unknown device');
});
