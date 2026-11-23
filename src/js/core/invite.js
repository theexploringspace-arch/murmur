// invite.js — add a friend who is far away, with a code sent over any channel.
//
// FLOW (Alice invites Bob)
//   1. Alice: createInvite() → a signed bundle with her identity key, a fresh
//      one-time ratchet key ("prekey"), her mailbox address and an expiry.
//      She sends it as a link/code by SMS, WhatsApp, email… anything.
//   2. Bob:   acceptInvite() → verifies Alice's signature, derives a shared key
//      SK = HKDF(ECDH(bobEphemeral, alicePrekey)), and builds a JOIN message:
//      his name, identity key and mailbox — signed by his identity key and
//      encrypted under SK, so the relay learns nothing about who he is.
//   3. Alice: openJoin() → decrypts, verifies Bob's signature, and deletes the
//      prekey (single use: a leaked or replayed invite is useless afterwards).
//   Both now hold a Double Ratchet (ratchet.js) bound to BOTH identity keys.
//
// WHAT THIS DOES NOT STOP — and how Murmur handles it:
//   Whoever can CHANGE the invite in transit (e.g. a compromised SMS account)
//   can substitute their own. Signatures can't help: the attacker signs with
//   their own key. Only comparing the safety number out-of-band (a voice call,
//   in person) detects it. So remote contacts start "not verified" and the UI
//   nags until the numbers are compared. In-person QR pairing is verified.

import { concat, utf8, fromUtf8, Writer, Reader, random, toB64u, fromB64u, toHex, equal } from './bytes.js';
import { sign, verify, importIdentityPublic, hkdf, sha256, aesGcmEncrypt, aesGcmDecrypt, importAesKey, labeledHash } from './crypto.js';
import { Ratchet, generateDH, dh, associatedData } from './ratchet.js';

export const INVITE_TTL_S = 7 * 24 * 3600;
export const MAX_SKEW_S = 5 * 60;
const V = 1;
const KIND_INVITE = 3, KIND_JOIN = 4;
export const INVITE_PREFIX = 'murmur-invite.';

export class InviteError extends Error { constructor(m) { super(m); this.name = 'InviteError'; } }

export function clampName(name) {
  const s = String(name ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim();
  const b = utf8(s);
  if (b.length <= 48) return s;
  let out = ''; for (const ch of s) { if (utf8(out + ch).length > 48) break; out += ch; }
  return out;
}

function inviteBody({ created, expires, inviteId, name, identityPub, prekeyPub, inbox }) {
  return new Writer().u8(V).u8(KIND_INVITE).u32(created).u32(expires).raw(inviteId)
    .lp8(utf8(name)).raw(identityPub).raw(prekeyPub).raw(inbox).done();
}

/**
 * @param identity {privateKey, publicRaw}  @param inbox 32-byte mailbox address
 * @returns {{bytes, text, link?, pending}} pending must be stored (vault) until used/expired.
 */
export async function createInvite({ identity, name, inbox, now = Date.now(), ttlS = INVITE_TTL_S }) {
  if (!(inbox instanceof Uint8Array) || inbox.length !== 32) throw new InviteError('bad inbox');
  const created = Math.floor(now / 1000), expires = created + ttlS;
  const inviteId = random(16);
  const prekey = await generateDH();
  const body = inviteBody({ created, expires, inviteId, name: clampName(name), identityPub: identity.publicRaw, prekeyPub: prekey.pub, inbox });
  const sig = await sign(identity.privateKey, concat(utf8('murmur/invite/v1'), body));
  const bytes = concat(body, sig);
  return {
    bytes, text: INVITE_PREFIX + toB64u(bytes),
    pending: { id: toHex(inviteId), prekey: { pub: toB64u(prekey.pub), priv: toB64u(prekey.priv) }, expires, hash: toB64u(await sha256(bytes)) },
  };
}

/** Accepts the raw code, a "murmur-invite.…" string, or a link whose #fragment holds it. */
export function inviteBytesFromText(s) {
  s = String(s).trim();
  const hash = s.indexOf('#');
  if (hash >= 0) { const m = /(?:^|[#&])i=([A-Za-z0-9_-]+)/.exec(s.slice(hash)); if (m) return fromB64u(m[1]); }
  if (s.startsWith(INVITE_PREFIX)) return fromB64u(s.slice(INVITE_PREFIX.length));
  throw new InviteError('This is not a Murmur invite');
}
export const inviteLink = (origin, bytes) => `${origin.replace(/\/$/, '')}/#i=${toB64u(bytes)}`;

export async function parseInvite(bytes, { now = Date.now() } = {}) {
  let f;
  try {
    const r = new Reader(bytes);
    f = { v: r.u8(), kind: r.u8(), created: r.u32(), expires: r.u32(), inviteId: r.raw(16), name: fromUtf8(r.lp8()),
      identityPub: r.raw(65), prekeyPub: r.raw(65), inbox: r.raw(32) };
    f.bodyLen = r.o; f.sig = r.raw(64); r.end();
  } catch { throw new InviteError('Invite code is damaged or incomplete'); }
  if (f.v !== V || f.kind !== KIND_INVITE) throw new InviteError('Not a Murmur invite (or a newer version)');
  const pub = await importIdentityPublic(f.identityPub).catch(() => { throw new InviteError('Invite has a bad key'); });
  if (!(await verify(pub, f.sig, concat(utf8('murmur/invite/v1'), bytes.slice(0, f.bodyLen))))) throw new InviteError('Invite signature is invalid — it was altered');
  const t = Math.floor(now / 1000);
  if (f.created > t + MAX_SKEW_S) throw new InviteError('Invite is from the future — check the phone clocks');
  if (t > f.expires) throw new InviteError('This invite has expired. Ask for a new one.');
  if (clampName(f.name) !== f.name) throw new InviteError('Invite has an invalid name');
  return { ...f, hash: await sha256(bytes) };
}

async function joinKeys(dhOut, inviteHash) {
  const sk = await hkdf(dhOut, inviteHash, 'murmur/x3dh/v1', 32);
  const jk = await hkdf(dhOut, inviteHash, 'murmur/join/key/v1', 44);
  return { sk, key: await importAesKey(jk.slice(0, 32)), iv: jk.slice(32) };
}
const joinSigInput = (inviteHash, ephPub, identityPub, inbox, name, created) =>
  concat(utf8('murmur/join/v1'), inviteHash, ephPub, identityPub, inbox, utf8(name), Uint8Array.of(0), new Writer().u32(created).done());

/** Bob: → { join (bytes to post to Alice's inbox), ratchet (sender side), peer } */
export async function acceptInvite(invite, { identity, name, inbox, now = Date.now() }) {
  if (equal(invite.identityPub, identity.publicRaw)) throw new InviteError('This is your own invite');
  const eph = await generateDH();
  const { sk, key, iv } = await joinKeys(await dh(eph, invite.prekeyPub), invite.hash);
  const created = Math.floor(now / 1000);
  const nm = clampName(name);
  const sig = await sign(identity.privateKey, joinSigInput(invite.hash, eph.pub, identity.publicRaw, inbox, nm, created));
  const body = new Writer().lp8(utf8(nm)).raw(identity.publicRaw).raw(inbox).u32(created).raw(sig).done();
  const head = new Writer().u8(V).u8(KIND_JOIN).raw(invite.inviteId).raw(eph.pub).done();
  const join = concat(head, await aesGcmEncrypt(key, iv, body, head));
  const ratchet = await Ratchet.initSender(sk, invite.prekeyPub, associatedData(invite.identityPub, identity.publicRaw));
  return { join, ratchet, peer: { name: invite.name, identityPub: invite.identityPub, inbox: invite.inbox } };
}

export const isJoin = (b) => b instanceof Uint8Array && b.length > 2 + 16 + 65 && b[0] === V && b[1] === KIND_JOIN;
export const joinInviteId = (b) => toHex(b.slice(2, 18));

/** Alice: pending = the record from createInvite (looked up by joinInviteId). */
export async function openJoin(bytes, pending, { identity, now = Date.now() }) {
  if (!isJoin(bytes)) throw new InviteError('not a join');
  if (toHex(bytes.slice(2, 18)) !== pending.id) throw new InviteError('join is for a different invite');
  if (Math.floor(now / 1000) > pending.expires) throw new InviteError('invite expired before it was used');
  const head = bytes.slice(0, 2 + 16 + 65), ephPub = head.slice(18);
  const prekey = { pub: fromB64u(pending.prekey.pub), priv: fromB64u(pending.prekey.priv) };
  const inviteHash = fromB64u(pending.hash);
  const { sk, key, iv } = await joinKeys(await dh(prekey, ephPub), inviteHash);
  let body;
  try { body = await aesGcmDecrypt(key, iv, bytes.slice(head.length), head); }
  catch { throw new InviteError('join failed authentication'); }
  const r = new Reader(body);
  const name = fromUtf8(r.lp8()), identityPub = r.raw(65), inbox = r.raw(32), created = r.u32(), sig = r.raw(64); r.end();
  if (clampName(name) !== name) throw new InviteError('bad name');
  const pub = await importIdentityPublic(identityPub);
  if (!(await verify(pub, sig, joinSigInput(inviteHash, ephPub, identityPub, inbox, name, created)))) throw new InviteError('join signature invalid');
  const ratchet = Ratchet.initReceiver(sk, prekey, associatedData(identity.publicRaw, identityPub));
  return { ratchet, peer: { name, identityPub, inbox } };
}

// ---- mailbox addresses ----
/** secret (32 random bytes, private) → address (public, given to contacts). */
export const inboxAddress = async (secret) => labeledHash('murmur/inbox/v1', secret);
export const newInboxSecret = () => random(32);
