// Duress passcode: a second passcode opens a decoy, never the real chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, SlotStore } from '../../src/js/core/storage.js';
import { Vault, WrongPassphraseError, VaultWipedError } from '../../src/js/core/vault.js';
import { slots, ensureSlots, unlockAny, setDuress, clearDuress, opensOther, anyVault } from '../../src/js/core/duress.js';

const IT = { iterations: 1000 }; // fast PBKDF2 for tests (the app uses 600k)
const REAL = 'correct horse battery staple', DURESS = 'grandma birthday cake', WRONG = 'definitely not it 123';

async function phoneWithRealChats() {
  const inner = new MemoryStore();
  const v = await Vault.create(slots(inner).a, REAL, IT);
  await v.putRecord('profile', { name: 'Prince' });
  await v.putRecord('contacts', [{ id: 'c1', name: 'Secret Source' }]);
  v.lock();
  await ensureSlots(inner, IT);
  return inner;
}

test('slot stores keep their keys apart; clearing one leaves the other', async () => {
  const inner = new MemoryStore();
  const { a, b } = slots(inner);
  await a.put('x', 1); await b.put('x', 2);
  assert.deepEqual([await a.get('x'), await b.get('x')], [1, 2]);
  assert.deepEqual(await a.keys(), ['x']); assert.deepEqual(await b.keys(), ['x']);
  await b.clear();
  assert.equal(await a.get('x'), 1); assert.equal(await b.get('x'), undefined);
  assert.ok(new SlotStore(inner, '') instanceof SlotStore);
});

test('real passphrase → real chats; duress passcode → empty decoy; real chats untouched', async () => {
  const inner = await phoneWithRealChats();
  await setDuress(inner, 'a', DURESS, { name: 'Prince', iterations: 1000 });
  const d = await unlockAny(inner, DURESS);
  assert.equal(d.slot, 'b'); assert.equal(d.erasedOther, false);
  assert.deepEqual(await d.vault.getRecord('contacts', []), [], 'decoy shows no contacts');
  assert.equal((await d.vault.getRecord('profile')).name, 'Prince', 'same display name, so nothing looks off');
  d.vault.lock();
  const r = await unlockAny(inner, REAL);
  assert.equal(r.slot, 'a');
  assert.equal((await r.vault.getRecord('contacts'))[0].name, 'Secret Source');
});

test('using the duress passcode is NOT a wrong attempt (20 uses never trigger the wipe)', async () => {
  const inner = await phoneWithRealChats();
  await setDuress(inner, 'a', DURESS, { iterations: 1000 });
  for (let i = 0; i < 20; i++) (await unlockAny(inner, DURESS)).vault.lock();
  assert.equal((await unlockAny(inner, REAL)).slot, 'a');
});

test('wrong passphrases count once each, and the limit erases BOTH slots', async () => {
  const inner = await phoneWithRealChats();
  await setDuress(inner, 'a', DURESS, { iterations: 1000 });
  await assert.rejects(unlockAny(inner, WRONG), (e) => e instanceof WrongPassphraseError && e.attemptsLeft === 9);
  for (let i = 0; i < 8; i++) await assert.rejects(unlockAny(inner, WRONG), WrongPassphraseError);
  await assert.rejects(unlockAny(inner, WRONG), VaultWipedError);
  assert.equal(await anyVault(inner), false, 'real and decoy are both gone');
  assert.deepEqual(await inner.keys(), []);
});

test('"erase real chats" option: the duress passcode destroys the real vault and leaves no trace of doing so', async () => {
  const inner = await phoneWithRealChats();
  await setDuress(inner, 'a', DURESS, { eraseReal: true, iterations: 1000 });
  assert.ok(!(await inner.keys()).some((k) => /duress|erase/i.test(k)), 'no key name hints at a duress setup');
  const d = await unlockAny(inner, DURESS);
  assert.equal(d.erasedOther, true);
  assert.equal((await d.vault.getRecord('settings')).eraseOther, undefined, 'flag consumed');
  d.vault.lock();
  await assert.rejects(unlockAny(inner, REAL), WrongPassphraseError, 'real passphrase opens nothing now');
  assert.deepEqual((await slots(inner).a.keys()).sort(), ['rec/profile', 'rec/settings', 'vault/fails', 'vault/identity', 'vault/meta'],
    'real slot now holds only an ordinary placeholder: contacts gone, nothing says why');
  const again = await unlockAny(inner, DURESS);
  assert.equal(again.erasedOther, false, 'the erase flag removed itself');
});

test('without a duress passcode the storage looks exactly the same (a placeholder fills slot B)', async () => {
  const plain = await phoneWithRealChats();
  const withDecoy = await phoneWithRealChats();
  await setDuress(withDecoy, 'a', DURESS, { iterations: 1000 });
  assert.deepEqual((await plain.keys()).sort(), (await withDecoy.keys()).sort());
  const erasing = await phoneWithRealChats();
  await setDuress(erasing, 'a', DURESS, { eraseReal: true, iterations: 1000 });
  assert.deepEqual((await plain.keys()).sort(), (await erasing.keys()).sort(), 'the erase option is invisible too');
  await assert.rejects(unlockAny(plain, DURESS), WrongPassphraseError, 'placeholder cannot be opened');
});

test('safety rails: decoy can\'t overwrite the real vault, codes must differ, and passphrase changes can\'t collide', async () => {
  const inner = await phoneWithRealChats();
  await assert.rejects(setDuress(inner, 'a', REAL, { iterations: 1000 }), /different from your real passphrase/);
  await assert.rejects(setDuress(inner, 'a', 'short', { iterations: 1000 }), /at least/);
  await assert.rejects(setDuress(inner, 'b', DURESS, { iterations: 1000 }), /Only the real vault/);
  await setDuress(inner, 'a', DURESS, { iterations: 1000 });
  assert.equal(await opensOther(inner, 'a', DURESS), true, 'changing the real passphrase TO the duress code is detectable');
  assert.equal(await opensOther(inner, 'b', REAL), true);
  assert.equal(await opensOther(inner, 'a', WRONG), false);
  await clearDuress(inner, 'a', IT);
  await assert.rejects(unlockAny(inner, DURESS), WrongPassphraseError, 'turned off: the code is just a wrong passphrase');
  assert.equal((await unlockAny(inner, REAL)).slot, 'a');
});

test('older installs (one vault, no slots) get their second slot and keep working', async () => {
  const inner = new MemoryStore();
  (await Vault.create(inner, REAL, IT)).lock(); // how the app stored it before slots existed
  await ensureSlots(inner, IT);
  assert.equal((await unlockAny(inner, REAL)).slot, 'a');
  assert.ok(await Vault.exists(slots(inner).b));
});
