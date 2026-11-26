// devices.js — "Where you're signed in": a device list for an account that has no account server.
//
// WHY THIS EXISTS
//   Murmur has no server that knows your account. Logging in on another phone (online backup,
//   backup file) copies your whole vault there — same identity key, same relay inbox. Two copies
//   reading one inbox fight over every message: whichever grabs it first acknowledges it, and the
//   relay deletes it for the other. After a restore the new phone also re-keys every contact, so the
//   old phone can't even read what it grabs — it used to drop those messages silently.
//
// THE RULE (like Signal/WhatsApp's single phone): one account is ACTIVE on one phone at a time.
// The phone that most recently took the account over is the active one; any other copy notices,
// stops using the inbox, and tells its owner where the account went.
//
// HOW, with only the relay's dumb mailboxes
//   A private "devices box" on the relay, derived from the inbox secret (so only copies of this
//   account can find or read it). Each phone appends sealed rows:
//     { k: 'take', id, ... }  "I'm the active phone now"     (new account, restore, move, take back)
//     { k: 'here', id, ... }  "still here" heartbeat          (name, last seen)
//     { k: 'out',  id, to }   "sign phone <to> out"           (from the active phone)
//   ORDER comes from the relay (rows are returned in the order they arrived), never from the phones'
//   clocks — a phone with a wrong clock can't win a takeover. Rows expire after 30 days on the relay.
//
// The relay sees: a mailbox address unrelated to your inbox's, sizes and timing. Not names, not ids.
// LIMIT (threat model): this coordinates honest copies of the app. Someone who stole your passphrase
// and runs a modified copy can ignore a sign-out — but the takeover still shows up here, which is the
// point: you find out.
import { concat, utf8, fromUtf8 } from './bytes.js';
import { labeledHash, importAesKey, aesGcmEncrypt, aesGcmDecrypt } from './crypto.js';

// Reading the box is free (no rows added), so phones CHECK often; writing adds a row the relay keeps
// for 30 days (cap 5000 rows/mailbox), so heartbeats are rare: ≤ 48/day/phone → far under the cap.
export const CHECK_MS = 2 * 60_000;               // while the app is open: did another phone take over?
export const HEARTBEAT_MS = 30 * 60_000;          // "still here" at most this often
export const ACTIVE_MS = HEARTBEAT_MS + 5 * 60_000; // "active recently" if heard from within this
const MAGIC = utf8('MDV1');

/** The devices box's own mailbox secret and sealing key, both derived from the inbox secret. */
export async function deviceKeys(inboxSecret) {
  return {
    box: await labeledHash('murmur/devices/box/v1', inboxSecret),
    key: await importAesKey(await labeledHash('murmur/devices/key/v1', inboxSecret)),
  };
}

export async function sealRow(key, row) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await aesGcmEncrypt(key, iv, utf8(JSON.stringify(row)), MAGIC);
  return concat(MAGIC, iv, ct);
}

/** → the row, or null for anything that isn't a well-formed sealed row of this account. */
export async function openRow(key, bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length < 4 + 12 + 16) return null;
    if (fromUtf8(bytes.slice(0, 4)) !== 'MDV1') return null;
    const row = JSON.parse(fromUtf8(await aesGcmDecrypt(key, bytes.slice(4, 16), bytes.slice(16), MAGIC)));
    return validRow(row) ? row : null;
  } catch { return null; }
}

const ID = /^[A-Za-z0-9_-]{8,40}$/;
const VIA = new Set(['new', 'online', 'file', 'move', 'back', 'existing']);
function validRow(r) {
  if (!r || typeof r !== 'object' || !['take', 'here', 'out'].includes(r.k) || !ID.test(r.id)) return false;
  if (!Number.isFinite(r.at)) return false;
  if (r.k === 'out') return ID.test(r.to);
  return typeof r.name === 'string' && r.name.length <= 60 && (r.k !== 'take' || VIA.has(r.via));
}

/**
 * Fold the rows (relay order) into the device list.
 * → { devices: [{id, name, via, since, last, active, out}], activeId, superseded, signedOut }
 *   superseded: another phone took the account over after `me` did.   signedOut: someone signed `me` out.
 */
export function deviceState(rows, me, now = Date.now()) {
  const by = new Map();
  let activeId = null, takeIdx = -1;
  rows.forEach((r, i) => {
    if (r.k === 'out') {
      // Only the active phone (at that point in the log) may sign others out — not a stale copy.
      if (r.id === activeId && r.to !== r.id) { const d = by.get(r.to); if (d) d.out = true; else by.set(r.to, { id: r.to, name: 'A phone', out: true, last: 0 }); }
      return;
    }
    const d = by.get(r.id) || { id: r.id, last: 0 };
    d.name = r.name; d.last = Math.max(d.last, Math.min(r.at, now));
    if (r.k === 'take') { d.via = r.via; d.since = r.at; d.out = false; activeId = r.id; takeIdx = i; }
    by.set(r.id, d);
  });
  for (const d of by.values()) d.active = d.id === activeId && !d.out;
  const mine = by.get(me);
  const devices = [...by.values()].sort((a, b) => (b.id === me) - (a.id === me) || (b.active - a.active) || b.last - a.last);
  return {
    devices, activeId,
    superseded: !!activeId && activeId !== me && !!mine,  // I was here, someone took over after me
    signedOut: !!mine?.out,
    lastTakeIndex: takeIdx,
  };
}

export const isRecent = (d, now = Date.now()) => now - d.last < ACTIVE_MS;

/** A human name for this browser/phone, e.g. "Chrome on Android", "Safari on iPhone". */
export function deviceName(ua = '', platformHint = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua)) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : platformHint || 'Unknown device';
  const br = /EdgA?\//.test(ua) ? 'Edge' : /SamsungBrowser\//.test(ua) ? 'Samsung Internet' : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox' : /CriOS\/|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${br} on ${os}` : os;
}

export const VIA_TEXT = {
  new: 'Created the account', online: 'Logged in with username + passphrase', file: 'Restored from a backup file',
  move: 'Moved from another phone', back: 'Took the account back', existing: 'Signed in',
};
