// vault.js — everything Murmur keeps on the device, encrypted at rest.
//
// Key hierarchy:
//
//   passphrase ──PBKDF2(600k, salt)──▶ KEK (non-extractable, never stored)
//   KEK ──AES-GCM unwrap──▶ DEK  (random 256-bit data key, non-extractable once unwrapped)
//   DEK ──AES-GCM unwrap──▶ identity private key (ECDSA P-256, non-extractable)
//   DEK ──AES-GCM──▶ every record (profile, contacts, history, settings)
//
// "Non-extractable" means JavaScript — including a malicious script injected
// later — can USE the key while unlocked but can never read its bytes out.
// A stolen, locked device yields only ciphertext plus the PBKDF2 salt.
//
// The vault is storage-agnostic: it talks to a `store` with
// get/put/delete/clear. Browser = IndexedDB (storage-idb.js); tests = memory.

import * as C from './crypto.js';
import { utf8, fromUtf8, random } from './bytes.js';

const META = 'vault/meta';
const IDENT = 'vault/identity';
const FAILS = 'vault/fails';
const REC = (n) => `rec/${n}`;
const AAD = (n) => utf8(`murmur/v1/${n}`);

export class WrongPassphraseError extends Error {
  constructor(left) { super('Wrong passphrase'); this.name = 'WrongPassphraseError'; this.attemptsLeft = left; }
}
export class VaultWipedError extends Error {
  constructor() { super('Too many failed attempts — vault wiped'); this.name = 'VaultWipedError'; }
}

export const MIN_PASSPHRASE = 10;

export class Vault {
  /** @private */ constructor(store, dek, identity) {
    this.store = store; this.dek = dek; this.identity = identity;
  }

  static async exists(store) { return !!(await store.get(META)); }

  static async create(store, passphrase, { iterations = C.PBKDF2_ITERATIONS, wipeAfter = 10 } = {}) {
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE)
      throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE} characters`);
    if (await Vault.exists(store)) throw new Error('Vault already exists');

    const salt = random(16);
    const kek = await C.passphraseKey(passphrase, salt, iterations);
    const dekExtractable = await C.generateDataKey();
    const dekIv = random(12);
    const wrappedDek = await C.wrapKey('raw', dekExtractable, kek, dekIv, AAD('dek'));

    const ident = await C.generateIdentityKeyPair();
    const idIv = random(12);
    const wrappedId = await C.wrapKey('pkcs8', ident.privateKey, dekExtractable, idIv, AAD('identity'));
    const publicRaw = await C.exportPublic(ident.publicKey);

    await store.put(IDENT, { iv: idIv, wrapped: wrappedId, publicRaw });
    await store.put(FAILS, 0);
    await store.put(META, { v: 1, salt, iterations, dekIv, wrappedDek, wipeAfter });
    // Re-open through the normal path so the in-memory keys are non-extractable.
    return Vault.unlock(store, passphrase);
  }

  static async unlock(store, passphrase) {
    const opened = await Vault.open(store, passphrase);
    if (opened) return opened;
    await Vault.noteFailure(store, () => Vault.wipe(store));
  }

  /** Try a passphrase WITHOUT touching the failure counter. → Vault, or null if wrong. */
  static async open(store, passphrase) {
    const meta = await store.get(META);
    if (!meta) throw new Error('No vault');
    return Vault.openWithKek(store, meta, await C.passphraseKey(passphrase, meta.salt, meta.iterations));
  }
  /** Same, with a KEK derived elsewhere (lets callers derive several in parallel). */
  static async openWithKek(store, meta, kek) {
    let dek;
    try {
      dek = await C.unwrapKey('raw', meta.wrappedDek, kek, meta.dekIv, AAD('dek'), C.AES_ALGO,
        ['encrypt', 'decrypt', 'unwrapKey']);
    } catch { return null; }
    await store.put(FAILS, 0);
    const id = await store.get(IDENT);
    const privateKey = await C.unwrapKey('pkcs8', id.wrapped, dek, id.iv, AAD('identity'), C.ECDSA_ALGO, ['sign']);
    const publicKey = await C.importIdentityPublic(id.publicRaw);
    return new Vault(store, dek, { privateKey, publicKey, publicRaw: id.publicRaw });
  }
  static meta(store) { return store.get(META); }
  /** The wrong-passphrase limit is plain metadata (needed before unlock), so it can be set without the key. */
  static async setWipeAfterOn(store, n) { const m = await store.get(META); if (m) await store.put(META, { ...m, wipeAfter: n | 0 }); }
  /** Count one wrong passphrase on `store`; past the limit run `wipe` and throw VaultWipedError. Always throws. */
  static async noteFailure(store, wipe) {
    const meta = await store.get(META);
    const fails = ((await store.get(FAILS)) || 0) + 1;
    if (meta.wipeAfter > 0 && fails >= meta.wipeAfter) {
      await wipe();
      throw new VaultWipedError();
    }
    await store.put(FAILS, fails);
    throw new WrongPassphraseError(meta.wipeAfter > 0 ? meta.wipeAfter - fails : Infinity);
  }

  static async wipe(store) { await store.clear(); }

  get locked() { return !this.dek; }

  async getRecord(name, fallback = null) {
    this.#check();
    const r = await this.store.get(REC(name));
    if (!r) return fallback;
    const pt = await C.aesGcmDecrypt(this.dek, r.iv, r.ct, AAD(`rec/${name}`));
    return JSON.parse(fromUtf8(pt));
  }

  async putRecord(name, value) {
    this.#check();
    const iv = random(12);
    const ct = await C.aesGcmEncrypt(this.dek, iv, utf8(JSON.stringify(value)), AAD(`rec/${name}`));
    await this.store.put(REC(name), { iv, ct });
  }

  async deleteRecord(name) { this.#check(); await this.store.delete(REC(name)); }

  async changePassphrase(oldPass, newPass) {
    this.#check();
    if (newPass.length < MIN_PASSPHRASE) throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE} characters`);
    const meta = await this.store.get(META);
    const oldKek = await C.passphraseKey(oldPass, meta.salt, meta.iterations);
    // Temporarily unwrap an *extractable* DEK solely to re-wrap it.
    let dekX;
    try {
      dekX = await globalThis.crypto.subtle.unwrapKey('raw', meta.wrappedDek, oldKek,
        { name: 'AES-GCM', iv: meta.dekIv, additionalData: AAD('dek') }, C.AES_ALGO, true, ['encrypt']);
    } catch { throw new WrongPassphraseError(); }
    const salt = random(16);
    const newKek = await C.passphraseKey(newPass, salt, meta.iterations);
    const dekIv = random(12);
    const wrappedDek = await C.wrapKey('raw', dekX, newKek, dekIv, AAD('dek'));
    await this.store.put(META, { ...meta, salt, dekIv, wrappedDek });
  }

  async setWipeAfter(n) {
    this.#check();
    const meta = await this.store.get(META);
    await this.store.put(META, { ...meta, wipeAfter: n | 0 });
  }
  async getWipeAfter() { return (await this.store.get(META)).wipeAfter; }

  /** Drop every key reference. JS can't zero CryptoKeys, but unreferenced
   *  non-extractable keys were never readable in the first place. */
  lock() { this.dek = null; this.identity = null; }

  #check() { if (!this.dek) throw new Error('Vault is locked'); }
}
