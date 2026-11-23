// profile.js — username, profile photo and call permissions.
//
// None of this lives on a server. Your profile travels only to your contacts, inside the same
// end-to-end encrypted channel as messages ({ t: 'profile' }), and each contact can be sent a
// different version (e.g. "no calls from this person").
//
// The username is also asked for on the lock screen. It is NOT a secret and adds no
// cryptographic strength — the passphrase does that. It is stored only as a salted hash
// (outside both vault slots, so the real vault and the duress decoy share one login).

import { sha256 } from './crypto.js';
import { random, toB64u, fromB64u, utf8 } from './bytes.js';

export const USERNAME_RE = /^[a-z0-9][a-z0-9_.]{2,19}$/;
export const MAX_PIC = 36 * 1024;     // bytes of JPEG (fits one 64 KiB nearby frame); the app makes ~10–25 KB 256×256 photos
export const LOGIN_KEY = 'login';     // key in the shared store (not inside a vault slot)

export function normalizeUsername(s) {
  return String(s ?? '').trim().replace(/^@/, '').toLowerCase();
}
export function usernameProblem(s) {
  const u = normalizeUsername(s);
  if (u.length < 3) return 'Username must be at least 3 characters';
  if (u.length > 20) return 'Username can be at most 20 characters';
  if (!USERNAME_RE.test(u)) return 'Use letters, numbers, dots and underscores (start with a letter or number)';
  return null;
}

async function hashUser(salt, u) {
  const b = utf8(u); const x = new Uint8Array(salt.length + b.length);
  x.set(salt); x.set(b, salt.length);
  return toB64u(await sha256(x));
}
/** → { salt, h, user? } — `user` (plain) only if the person chose "remember on this phone". */
export async function makeLogin(username, remember = false) {
  const u = normalizeUsername(username);
  if (usernameProblem(u)) throw new Error(usernameProblem(u));
  const salt = random(16);
  return { salt: toB64u(salt), h: await hashUser(salt, u), ...(remember ? { user: u } : {}) };
}
export async function checkLogin(rec, username) {
  if (!rec) return true; // accounts from before usernames existed
  return (await hashUser(fromB64u(rec.salt), normalizeUsername(username))) === rec.h;
}

/** What one contact is told about me. */
export function profileFor(profile, settings, contact) {
  const calls = settings.calls || {};
  const blocked = !!contact?.noCalls;
  return {
    t: 'profile',
    v: profile.v || 1,
    name: profile.name,
    user: profile.username || null,
    pic: profile.pic || null,
    calls: { voice: calls.voice !== false && !blocked, video: calls.video !== false && !blocked },
  };
}

const isJpeg = (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Strict validation of an incoming profile. → sanitized object, or null to ignore it. */
export function readProfile(m) {
  if (!m || m.t !== 'profile') return null;
  if (!Number.isSafeInteger(m.v) || m.v < 1) return null;
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 60) return null;
  let user = null;
  if (m.user != null) { if (typeof m.user !== 'string' || !USERNAME_RE.test(m.user)) return null; user = m.user; }
  let pic = null;
  if (m.pic != null) {
    if (typeof m.pic !== 'string' || m.pic.length > Math.ceil(MAX_PIC * 4 / 3) + 4) return null;
    let b; try { b = fromB64u(m.pic); } catch { return null; }
    if (b.length > MAX_PIC || !isJpeg(b)) return null; // only real JPEGs are ever shown
    pic = m.pic;
  }
  const c = m.calls && typeof m.calls === 'object' ? m.calls : {};
  return { v: m.v, name: m.name.trim().replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, ''), user, pic,
    calls: { voice: c.voice !== false, video: c.video !== false } };
}
