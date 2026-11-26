// backup.js — take your account to another phone. Three ways, one package format.
//
//   1. Backup file        sealed with your passphrase; you keep the file (Files, AirDrop, USB…)
//   2. Online backup      sealed with keys derived from username + passphrase, stored on the relay;
//                         any phone can log in with just those two (opt-in; needs a strong passphrase)
//   3. Move to new phone  sealed with a one-time random code shown as a QR; the old phone then erases itself
//
// What is inside: the vault's OWN stored records, exactly as they sit on the phone — already encrypted
// under your passphrase (see vault.js). Nothing is decrypted to make a backup. The package is then
// sealed a second time so the relay or a stolen file reveals not even record names or sizes per contact.
// Restoring writes the records back; your passphrase opens them as before.
//
// The duress decoy (slot B) and the other slot are never included: a backup holds only the vault that
// is open when you make it.

import { toB64u, fromB64u, utf8, fromUtf8, random, concat, Writer, Reader, equal } from './bytes.js';
import { hkdf, importAesKey, aesGcmEncrypt, aesGcmDecrypt, sha256, PBKDF2_ITERATIONS } from './crypto.js';
import { inboxAddress } from './invite.js';

const MAGIC = utf8('MURMURBK');            // 8 bytes
const VERSION = 1;
const MODE_PASS = 1, MODE_KEY = 2;
export const MEDIA_PREFIX = 'rec/media/';
export class BackupError extends Error { constructor(m) { super(m); this.name = 'BackupError'; } }

// ---------- (de)serialising store values (they contain Uint8Arrays) ----------
const enc = (v) => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? { $b: toB64u(x) } : x));
const dec = (s) => JSON.parse(s, (_k, x) => (x && typeof x === 'object' && typeof x.$b === 'string' && Object.keys(x).length === 1 ? fromB64u(x.$b) : x));

/**
 * Collect one vault slot's records + the shared login record.
 * @param exact  true only for "move to new phone" (the old phone stops using this state)
 */
export async function exportVault(slotStore, { login = null, includeMedia = true, exact = false, now = Date.now() } = {}) {
  const entries = [];
  for (const k of (await slotStore.keys()).sort()) {
    if (!includeMedia && k.startsWith(MEDIA_PREFIX)) continue;
    entries.push([k, await slotStore.get(k)]);
  }
  if (!entries.some(([k]) => k === 'vault/meta')) throw new BackupError('Nothing to back up');
  return { app: 'murmur', v: VERSION, created: now, exact, media: includeMedia, login, entries };
}

/** Replace slot A with a package's records. Lockout counters start fresh. */
export async function importVault(inner, slotA, pkg) {
  if (pkg?.app !== 'murmur' || pkg.v !== VERSION || !Array.isArray(pkg.entries)) throw new BackupError('Not a Murmur backup');
  if (!pkg.entries.some(([k]) => k === 'vault/meta')) throw new BackupError('Backup is incomplete');
  await slotA.clear();
  for (const [k, v] of pkg.entries) {
    if (typeof k !== 'string' || k.startsWith('b:') || k === 'login') continue;
    await slotA.put(k, v);
  }
  await slotA.put('vault/fails', 0); await slotA.put('vault/until', 0);
  if (pkg.login) await inner.put('login', pkg.login);
  // Not an exact copy (file / online backup): conversations may have moved on since. The app renews
  // every secure link after the first unlock (remote.resyncAll), then deletes this marker.
  if (!pkg.exact) await inner.put('restore/pending', { at: pkg.created });
}

// ---------- sealing ----------
async function pbkdf2(pass, salt, iterations, bytes) {
  const base = await crypto.subtle.importKey('raw', utf8(String(pass).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, bytes * 8));
}
const AAD = (mode) => concat(MAGIC, Uint8Array.of(VERSION, mode));

/** Seal with a passphrase (backup file). */
export async function sealWithPassphrase(pkg, passphrase, { iterations = PBKDF2_ITERATIONS } = {}) {
  const salt = random(16), iv = random(12);
  const key = await importAesKey(await pbkdf2(passphrase, salt, iterations, 32));
  const ct = await aesGcmEncrypt(key, iv, utf8(enc(pkg)), AAD(MODE_PASS));
  return concat(MAGIC, Uint8Array.of(VERSION, MODE_PASS), new Writer().u32(iterations).done(), salt, iv, ct);
}
/** Seal with a raw 32-byte key (online backup, move-to-phone). */
export async function sealWithKey(pkg, rawKey) {
  const iv = random(12);
  const ct = await aesGcmEncrypt(await importAesKey(rawKey), iv, utf8(enc(pkg)), AAD(MODE_KEY));
  return concat(MAGIC, Uint8Array.of(VERSION, MODE_KEY), iv, ct);
}
export const isBackup = (b) => b instanceof Uint8Array && b.length > 10 && equal(b.slice(0, 8), MAGIC);

/** Open a sealed package. Wrong passphrase/key or any tampering → BackupError. */
export async function openSealed(bytes, { passphrase, key }) {
  if (!isBackup(bytes) || bytes[8] !== VERSION) throw new BackupError('This isn’t a Murmur backup (or it’s from a newer version)');
  const mode = bytes[9];
  let k, iv, ct;
  if (mode === MODE_PASS) {
    if (passphrase == null) throw new BackupError('This backup needs your passphrase');
    const r = new Reader(bytes.slice(10)); const it = r.u32();
    if (it < 100_000 && it !== 1000) throw new BackupError('Backup uses weak settings');   // 1000: unit tests only
    const salt = r.raw(16); iv = r.raw(12); ct = bytes.slice(10 + 4 + 16 + 12);
    k = await importAesKey(await pbkdf2(passphrase, salt, it, 32));
  } else if (mode === MODE_KEY) {
    if (!key) throw new BackupError('This backup needs its code');
    iv = bytes.slice(10, 22); ct = bytes.slice(22);
    k = await importAesKey(key);
  } else throw new BackupError('Unknown backup type');
  let pt;
  try { pt = await aesGcmDecrypt(k, iv, ct, AAD(mode)); }
  catch { throw new BackupError(mode === MODE_PASS ? 'Wrong passphrase — or the file was changed' : 'Wrong code — or the backup was changed'); }
  return dec(fromUtf8(pt));
}

// ---------- key derivations for the relay-based modes ----------
/**
 * Online backup: everything follows from username + passphrase, so a brand-new phone can find and
 * open it. The relay sees only a random-looking mailbox address and ciphertext; to attack it someone
 * must know your username AND guess your passphrase at 600,000 PBKDF2 rounds per guess.
 */
export async function onlineKeys(username, passphrase, { iterations = PBKDF2_ITERATIONS, pin = null } = {}) {
  const salt = await sha256(utf8(`murmur/online-backup/v1\u0000${normUser(username)}`));
  const root = await pbkdf2(passphrase, salt.slice(0, 16), iterations, 32);
  // The mailbox comes from username + passphrase only (so the relay can count PIN tries on it);
  // the key that opens the backup needs the PIN token too.
  return {
    box: await hkdf(root, new Uint8Array(32), 'murmur/online-backup/box', 32),
    key: await hkdf(pin ? concat(root, pin) : root, new Uint8Array(32), 'murmur/online-backup/key', 32),
  };
}
const normUser = (u) => String(u).trim().replace(/^@/, '').toLowerCase();

// ---------- security PIN (online backup / logging in on a new phone) ----------
// What it adds: the relay counts wrong PINs per backup (4 free, then waits up to 24 h), so someone who
// learned your username AND passphrase still can't download your backup without the PIN. On its own a
// 6-digit PIN is weak (a million options) — the relay's counter is what makes it strong. See relay/src/inbox.js.
export const PIN_MIN = 6, PIN_MAX = 12;
export function pinProblem(pin) {
  const p = String(pin ?? '');
  if (!/^\d+$/.test(p)) return 'Use digits only';
  if (p.length < PIN_MIN) return `Use at least ${PIN_MIN} digits`;
  if (p.length > PIN_MAX) return `Use at most ${PIN_MAX} digits`;
  if (/^(\d)\1+$/.test(p)) return 'Too easy to guess (all the same digit)';
  const steps = [...p].slice(1).map((c, i) => (+c - +p[i] + 10) % 10);
  if (steps.every((d) => d === 1) || steps.every((d) => d === 9)) return 'Too easy to guess (a run like 123456)';
  for (const n of [2, 3]) if (p.length % n === 0 && p === p.slice(0, n).repeat(p.length / n)) return 'Too easy to guess (a repeating pattern)';
  return null;
}
/** PIN → 32-byte token, bound to the username (the same PIN gives different tokens for different people). */
export async function pinToken(username, pin, { iterations = 100_000 } = {}) {
  const salt = await sha256(utf8(`murmur/online-pin/v1\u0000${normUser(username)}`));
  return pbkdf2(String(pin), salt.slice(0, 16), iterations, 32);
}
/** What the relay stores and compares against: SHA-256(token), base64url — never the PIN or token. */
export const pinVerifier = async (token) => toB64u(await sha256(token));
/** Move-to-phone: one random code → mailbox for the package, key, and a mailbox for "received" */
export async function moveKeys(code) {
  if (!(code instanceof Uint8Array) || code.length !== 32) throw new BackupError('That isn’t a valid move code');
  const z = new Uint8Array(32);
  return { box: await hkdf(code, z, 'murmur/move/box', 32), key: await hkdf(code, z, 'murmur/move/key', 32), ack: await hkdf(code, z, 'murmur/move/ack', 32) };
}
export const MOVE_PREFIX = 'murmur-move:';
export const moveCodeText = (code) => MOVE_PREFIX + toB64u(code);
export function moveCodeFrom(text) {
  const t = String(text || '').trim();
  const i = t.indexOf(MOVE_PREFIX);
  if (i < 0) throw new BackupError('That isn’t a Murmur move code');
  try { return fromB64u(t.slice(i + MOVE_PREFIX.length).replace(/[^A-Za-z0-9_-]/g, '')); } catch { throw new BackupError('That code is damaged'); }
}

// ---------- chunking for the relay (1 MiB per message) ----------
export const CHUNK = 900 * 1024;
const CHUNK_MAGIC = utf8('MBK1');
export function toChunks(sealed, { id = random(8), created = Date.now() } = {}) {
  const n = Math.max(1, Math.ceil(sealed.length / CHUNK));
  if (n > 65535) throw new BackupError('Backup too large');
  const out = [];
  for (let i = 0; i < n; i++) out.push(concat(CHUNK_MAGIC, id, new Writer().u32(Math.floor(created / 1000)).u16(i).u16(n).done(), sealed.slice(i * CHUNK, (i + 1) * CHUNK)));
  return out;
}
/** From whatever is in the mailbox, rebuild the newest COMPLETE backup. → Uint8Array | null */
export function fromChunks(datas) {
  const sets = new Map();
  for (const d of datas) {
    if (!(d instanceof Uint8Array) || d.length < 20 || !equal(d.slice(0, 4), CHUNK_MAGIC)) continue;
    const id = toB64u(d.slice(4, 12)); const r = new Reader(d.slice(12, 20));
    const created = r.u32(), i = r.u16(), n = r.u16();
    if (!sets.has(id)) sets.set(id, { created, n, parts: new Map() });
    const s = sets.get(id); if (s.n === n && i < n) s.parts.set(i, d.slice(20));
  }
  const complete = [...sets.values()].filter((s) => s.parts.size === s.n).sort((a, b) => b.created - a.created);
  if (!complete.length) return null;
  const s = complete[0];
  return concat(...Array.from({ length: s.n }, (_v, i) => s.parts.get(i)));
}
export const mailboxAddress = async (secret) => toB64u(await inboxAddress(secret));
