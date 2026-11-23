// duress.js — a second passcode that opens a harmless decoy instead of your real chats.
//
// The store holds TWO vault slots, always:
//   slot A — keys without a prefix (your real vault; installs from before this feature)
//   slot B — keys under "b:"       (the decoy, or a placeholder nobody can open)
//
// Every install gets slot B, even if you never set a duress passcode: it is filled with
// a vault locked by a random passphrase that is thrown away. So the storage of a phone
// WITH a decoy looks like the storage of a phone WITHOUT one, and unlocking always
// derives both keys (same work, same time) whichever passphrase was typed.
//
// Unlock order: real passphrase → slot A. Duress passcode → slot B (and, if you chose
// it, slot A is erased on the spot and replaced by a fresh placeholder). Anything else
// counts as ONE wrong attempt; past the limit everything is erased.
//
// Limits (see docs/THREAT-MODEL.md): this defeats "unlock it and show me". It does not
// defeat someone who knows Murmur has this feature and demands the second passcode, or a
// forensic copy taken BEFORE you unlock (unless "erase real chats" is on).

import { Vault, WrongPassphraseError, MIN_PASSPHRASE } from './vault.js';
import { SlotStore } from './storage.js';
import { passphraseKey } from './crypto.js';
import { random, toB64u } from './bytes.js';

// The "erase real chats" flag lives INSIDE the decoy's encrypted settings record. Record
// NAMES are stored in plain text, so a dedicated record would give the feature away.
const ERASE = 'eraseOther';

export function slots(inner) {
  return { a: new SlotStore(inner, '', ['b:']), b: new SlotStore(inner, 'b:') };
}

export async function anyVault(inner) {
  const s = slots(inner);
  return (await Vault.exists(s.a)) || (await Vault.exists(s.b));
}

/** A vault nobody can open, shaped like a real one (profile + settings records). */
async function placeholder(store, opts) {
  await store.clear();
  const v = await Vault.create(store, toB64u(random(32)), opts);
  await v.putRecord('profile', { name: 'Me' });
  await v.putRecord('settings', { autoLockMin: 5 });
  v.lock();
}

/** Give an install the slot it's missing (older installs only have slot A). */
export async function ensureSlots(inner, opts = {}) {
  const s = slots(inner);
  if (!(await Vault.exists(s.a))) await placeholder(s.a, opts);
  if (!(await Vault.exists(s.b))) await placeholder(s.b, opts);
}

/**
 * Unlock with whatever was typed. → { vault, slot: 'a'|'b', erasedOther: boolean }
 * Throws WrongPassphraseError / VaultWipedError exactly like Vault.unlock.
 */
export async function unlockAny(inner, passphrase) {
  const s = slots(inner);
  const [ma, mb] = await Promise.all([Vault.meta(s.a), Vault.meta(s.b)]);
  if (!ma && !mb) throw new Error('No vault');
  // Derive both keys every time: equal work for real, duress and wrong passphrases.
  const [ka, kb] = await Promise.all([
    ma ? passphraseKey(passphrase, ma.salt, ma.iterations) : null,
    mb ? passphraseKey(passphrase, mb.salt, mb.iterations) : null,
  ]);
  const va = ma && (await Vault.openWithKek(s.a, ma, ka));
  if (va) return { vault: va, slot: 'a', erasedOther: false };
  const vb = mb && (await Vault.openWithKek(s.b, mb, kb));
  if (vb) {
    let erasedOther = false;
    const st = await vb.getRecord('settings', {});
    if (st[ERASE]) {
      await placeholder(s.a, { iterations: ma?.iterations }); // the real vault is gone; its slot looks like any placeholder
      delete st[ERASE]; await vb.putRecord('settings', st);   // nothing left to erase
      erasedOther = true;
    }
    return { vault: vb, slot: 'b', erasedOther };
  }
  // Wrong for both. One shared counter (slot A's); past the limit, BOTH slots go.
  return Vault.noteFailure(ma ? s.a : s.b, () => inner.clear());
}

/**
 * Set (or replace) the duress passcode. Only from the REAL vault (slot A): from the decoy
 * this would overwrite your real chats, so it is refused (the app pretends instead).
 */
export async function setDuress(inner, realSlot, passcode, { name, settings = {}, eraseReal = false, iterations } = {}) {
  if (realSlot !== 'a') throw new Error('Only the real vault can set a duress passcode');
  if (typeof passcode !== 'string' || passcode.length < MIN_PASSPHRASE) throw new Error(`The duress passcode must be at least ${MIN_PASSPHRASE} characters`);
  const s = slots(inner);
  if (await Vault.open(s.a, passcode)) throw new Error('The duress passcode must be different from your real passphrase');
  await s.b.clear();
  const d = await Vault.create(s.b, passcode, iterations ? { iterations } : {});
  await d.putRecord('profile', { name: name || 'Me' });
  await d.putRecord('settings', { autoLockMin: 5, ...settings, ...(eraseReal ? { [ERASE]: true } : {}) });
  d.lock();
}

/** Turn it off: the decoy is replaced by an unopenable placeholder. */
export async function clearDuress(inner, realSlot, opts = {}) {
  if (realSlot !== 'a') throw new Error('Only the real vault can change the duress passcode');
  await placeholder(slots(inner).b, opts);
}

/** Would `pass` open the OTHER slot? Used to stop a passphrase change from colliding. */
export async function opensOther(inner, slot, pass) {
  const other = slots(inner)[slot === 'a' ? 'b' : 'a'];
  if (!(await Vault.exists(other))) return false;
  const v = await Vault.open(other, pass);
  if (v) { v.lock(); return true; }
  return false;
}

export { WrongPassphraseError };
