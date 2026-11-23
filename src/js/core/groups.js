// groups.js — small private groups by pairwise fan-out.
//
// A group message is sent to each member SEPARATELY, over each member's own
// end-to-end encrypted 1:1 link (live or relay). There is no group server and no
// shared group key to leak: compromise of one member's link exposes only what
// that member could read anyway. Cost: N sends per message — fine for the small
// groups this is designed for (MAX_MEMBERS).
//
// Trust rules (enforced on every receive):
//   • Every message is authenticated as coming from a specific contact (by the 1:1 link).
//   • Only the group's creator ("admin") can change name or membership.
//   • A message from someone not in the member list is dropped.
//   • Members you don't have as contacts are shown with the name the admin gave
//     them, marked "(via group)": you have no verified key for them.
//   • Members who aren't each other's contacts still hear each other: the creator
//     forwards text and location over their own 1:1 links (app.js forwardIfAdmin).
//     Those messages are only as trustworthy as the creator. Files go only to
//     members who are your direct contacts.

export const MAX_MEMBERS = 20;
export const MAX_NAME = 48;
const HEX = /^[0-9a-f]+$/;

export class GroupError extends Error {}

const cleanName = (s) => String(s ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, MAX_NAME);

function validMembers(list) {
  if (!Array.isArray(list) || list.length < 2 || list.length > MAX_MEMBERS) return false;
  const seen = new Set();
  for (const m of list) {
    if (!m || typeof m.cid !== 'string' || m.cid.length !== 32 || !HEX.test(m.cid) || seen.has(m.cid)) return false;
    seen.add(m.cid);
  }
  return true;
}

export function createGroup({ name, me, members, randomHex }) {
  const nm = cleanName(name);
  if (!nm) throw new GroupError('Give the group a name');
  const list = [{ cid: me.cid, name: cleanName(me.name) }, ...members.map((m) => ({ cid: m.cid, name: cleanName(m.name) }))];
  if (!validMembers(list)) throw new GroupError(`A group needs 2–${MAX_MEMBERS} people`);
  const id = randomHex(16); // 16 random bytes → 32 hex characters
  if (typeof id !== 'string' || id.length !== 32 || !HEX.test(id)) throw new GroupError('internal: bad group id generator');
  return { id, name: nm, admin: me.cid, members: list, v: 1, created: Date.now() };
}

/** The roster message the admin sends to every member (on create and on change). */
export const inviteMessage = (g) => ({ t: 'ginv', gid: g.id, name: g.name, admin: g.admin, members: g.members, v: g.v });

/**
 * Apply a roster update received from `fromCid`.
 * @returns the new group object, or throws GroupError explaining why it was refused.
 */
export function applyInvite(existing, m, fromCid, myCid) {
  if (typeof m.gid !== 'string' || m.gid.length !== 32 || !HEX.test(m.gid)) throw new GroupError('bad group id');
  if (m.admin !== fromCid) throw new GroupError('only the group creator can change the group');
  if (existing && existing.admin !== fromCid) throw new GroupError('group creator mismatch');
  if (existing && !(m.v > existing.v)) throw new GroupError('old group update');
  const members = Array.isArray(m.members) ? m.members.map((x) => ({ cid: String(x?.cid), name: cleanName(x?.name) })) : null;
  if (!validMembers(members)) throw new GroupError('bad member list');
  if (!members.some((x) => x.cid === fromCid)) throw new GroupError('creator must be a member');
  const name = cleanName(m.name);
  if (!name) throw new GroupError('bad name');
  return { id: m.gid, name, admin: fromCid, members, v: m.v | 0, removed: !members.some((x) => x.cid === myCid) };
}

export const isMember = (g, cid) => !!g && !g.removed && g.members.some((m) => m.cid === cid);

/** Admin removes someone (or a member leaves): returns the next roster version. */
export function withoutMember(g, cid) {
  return { ...g, members: g.members.filter((m) => m.cid !== cid), v: g.v + 1 };
}

/** Who to send to: everyone except me. */
export const recipients = (g, myCid) => g.members.filter((m) => m.cid !== myCid).map((m) => m.cid);
