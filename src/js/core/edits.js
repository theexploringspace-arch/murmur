// edits.js — the rules for editing and deleting sent messages (pure; used by the app, unit-tested).
//
// Your own messages: edit text for 15 minutes, delete for everyone for 1 hour.
// "Delete for me" is local and always allowed. Receivers apply the SAME rules and only accept a
// change from the message's real author — in a group that is checked against who actually wrote
// it, not who forwarded it — with 5 minutes of grace for clocks that disagree.

export const EDIT_WINDOW = 15 * 60_000;
export const DELETE_WINDOW = 60 * 60_000;
export const SKEW = 5 * 60_000;
export const MAX_TEXT = 8000;

const editable = (m) => m.text != null && !m.file && !m.loc && !m.sos && !m.deleted && !m.system;

export const canEdit = (m, now = Date.now()) => m.dir === 'out' && editable(m) && now - m.ts < EDIT_WINDOW;
export const canDeleteForEveryone = (m, now = Date.now()) => m.dir === 'out' && !m.deleted && !m.system && now - m.ts < DELETE_WINDOW;
export const minutesLeft = (m, windowMs, now = Date.now()) => Math.max(0, Math.ceil((windowMs - (now - m.ts)) / 60_000));

/**
 * Should an incoming change be applied to `target` (a message we hold)?
 * @param target  our copy of the message, or undefined
 * @param change  { t: 'edit'|'del', ref, text? }
 * @param author  who really sent the change (contact id; in groups the original author)
 * @param group   true if this is a group chat
 * → 'edit' | 'del' | null
 */
export function acceptChange(target, change, author, group, now = Date.now()) {
  if (!target || target.dir !== 'in' || target.deleted || target.system) return null;
  if (group && target.from !== author) return null;          // only the author, never another member
  const age = now - target.ts;
  if (change.t === 'edit') {
    if (!editable(target) || typeof change.text !== 'string' || !change.text.trim() || change.text.length > MAX_TEXT) return null;
    return age <= EDIT_WINDOW + SKEW ? 'edit' : null;
  }
  if (change.t === 'del') return age <= DELETE_WINDOW + SKEW ? 'del' : null;
  return null;
}
