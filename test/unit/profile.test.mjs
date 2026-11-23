// Username login, profile photo validation, per-contact call permissions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsername, usernameProblem, makeLogin, checkLogin, profileFor, readProfile, MAX_PIC } from '../../src/js/core/profile.js';
import { MemoryStore } from '../../src/js/core/storage.js';
import { slots, setDuress, unlockAny, ensureSlots } from '../../src/js/core/duress.js';
import { Vault } from '../../src/js/core/vault.js';
import { toB64u } from '../../src/js/core/bytes.js';

test('usernames: normalized, validated', () => {
  assert.equal(normalizeUsername('  @Prince_99 '), 'prince_99');
  assert.equal(usernameProblem('ab'), 'Username must be at least 3 characters');
  assert.match(usernameProblem('_prince'), /start with a letter/);
  assert.match(usernameProblem('pri nce'), /letters, numbers/);
  assert.equal(usernameProblem('prince.is.genius'), null);
});

test('login record: only a salted hash unless "remember" is chosen; case-insensitive', async () => {
  const rec = await makeLogin('Prince');
  assert.equal(rec.user, undefined);
  assert.ok(!JSON.stringify(rec).includes('prince'), 'username not stored in clear');
  assert.equal(await checkLogin(rec, '@PRINCE'), true);
  assert.equal(await checkLogin(rec, 'princes'), false);
  assert.equal((await makeLogin('prince', true)).user, 'prince');
  assert.equal(await checkLogin(null, 'anything'), true, 'older accounts without a username still unlock');
  const a = await makeLogin('prince'), b = await makeLogin('prince');
  assert.notEqual(a.h, b.h, 'salted: two installs with the same username look different');
});

test('the login record is shared by the real vault and the decoy, and survives "erase real chats"', async () => {
  const inner = new MemoryStore();
  (await Vault.create(slots(inner).a, 'correct horse battery staple', { iterations: 1000 })).lock();
  await ensureSlots(inner, { iterations: 1000 });
  await inner.put('login', await makeLogin('prince'));
  await setDuress(inner, 'a', 'grandma birthday cake', { eraseReal: true, iterations: 1000 });
  assert.ok(!(await slots(inner).a.keys()).includes('login'), 'not part of slot A');
  (await unlockAny(inner, 'grandma birthday cake')).vault.lock(); // erases slot A
  assert.ok(await checkLogin(await inner.get('login'), 'prince'), 'same login still works for the decoy');
});

const jpeg = (n) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); return toB64u(b); };

test('profile messages: per-contact call permissions', () => {
  const me = { name: 'Prince', username: 'prince', pic: null, v: 3 };
  const st = { calls: { voice: true, video: false } };
  assert.deepEqual(profileFor(me, st, { noCalls: false }).calls, { voice: true, video: false });
  assert.deepEqual(profileFor(me, st, { noCalls: true }).calls, { voice: false, video: false }, 'blocked contact sees no call buttons');
  assert.deepEqual(profileFor(me, {}, {}).calls, { voice: true, video: true }, 'calls allowed by default');
});

test('incoming profiles are strictly validated (photo must be a real, small JPEG)', () => {
  const ok = { t: 'profile', v: 2, name: 'Ada', user: 'ada', pic: jpeg(2000), calls: { voice: true, video: false } };
  assert.deepEqual(readProfile(ok), { v: 2, name: 'Ada', user: 'ada', pic: ok.pic, calls: { voice: true, video: false } });
  assert.equal(readProfile({ ...ok, pic: toB64u(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2])) }), null, 'PNG/SVG/HTML never shown as a photo');
  assert.equal(readProfile({ ...ok, pic: jpeg(MAX_PIC + 1) }), null, 'too big');
  assert.equal(readProfile({ ...ok, user: 'BAD NAME' }), null);
  assert.equal(readProfile({ ...ok, name: '' }), null);
  assert.equal(readProfile({ ...ok, v: -1 }), null);
  assert.equal(readProfile({ ...ok, name: 'Ad‮a' }).name, 'Ada', 'direction-override tricks stripped');
  assert.deepEqual(readProfile({ ...ok, calls: undefined }).calls, { voice: true, video: true });
});
