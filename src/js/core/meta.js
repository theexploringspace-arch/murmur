// meta.js — the small optional tags a message can carry, and the read-receipt rules.
// Pure functions (no DOM, no network) so every rule is unit-tested: test/unit/meta.test.mjs.
//
//   re   a REPLY: which message this answers.   { id, by, k, t }
//          id  the quoted message's id
//          by  contact id (32 hex) of whoever WROTE the quoted message — absolute, so it means
//              the same thing on every phone, including in groups
//          k   what it was: text | photo | video | voice | file | loc | sos
//          t   a short text preview (≤ 120 chars), shown only if this phone doesn't have the
//              original (e.g. it disappeared, or you joined the group later)
//   fw   FORWARDED: how many hops (1 = forwarded once). ≥ 5 shows "Forwarded many times".
//        NB: groups already use `fwd` (the creator relaying a member's message) — different field.
//
// Trust rule for quotes: if this phone HAS the quoted message, the quote is drawn from OUR copy,
// never from the sender's preview. A sender can't make you appear to have said something you
// didn't — the most they can do is quote an id you don't have, which shows their preview text.

export const QUOTE_KINDS = ['text', 'photo', 'video', 'voice', 'file', 'loc', 'sos'];
export const SNIPPET = 120;
export const MANY_TIMES = 5;
const HEX_ID = /^[0-9a-f]{8,32}$/;
const CID = /^[0-9a-f]{32}$/;

/** Collapse whitespace and cut to `n` characters with an ellipsis. */
export function snippet(text, n = SNIPPET) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** What kind of thing a (local) message is, for the quote's icon and label. */
export function kindOf(m) {
  if (m?.sos) return 'sos';
  if (m?.loc) return 'loc';
  if (m?.file) {
    if (m.file.kind === 'voice') return 'voice';
    if (m.file.safety?.inline || (!m.file.safety && /^image\//.test(m.file.mime || ''))) return 'photo';
    if (m.file.playable === 'video' || (!m.file.playable && /^video\//.test(m.file.mime || ''))) return 'video';
    return 'file';
  }
  return 'text';
}

/** The label a quote shows when there's no text (or alongside the icon). */
export function kindLabel(k, name) {
  return { photo: 'Photo', video: 'Video', voice: 'Voice message', file: name || 'File', loc: 'Location', sos: 'SOS' }[k] || '';
}

/** Build the `re` tag for replying to local message `m` in chat `key` (contact id or "g:…"). */
export function quoteOf(m, myCid, key) {
  const k = kindOf(m);
  const by = m.dir === 'out' ? myCid : (m.from || key);
  const t = m.text != null ? snippet(m.text) : m.sos ? snippet(m.sos.text) : k === 'file' ? snippet(m.file?.name, 60) : '';
  return { id: m.id, by, k, t };
}

/** Validate the optional tags on anything received. Unknown or malformed → simply absent. */
export function msgMeta(m) {
  const out = {};
  const re = m?.re;
  if (re && typeof re === 'object' && typeof re.id === 'string' && HEX_ID.test(re.id) && typeof re.by === 'string' && CID.test(re.by)) {
    out.re = { id: re.id, by: re.by, k: QUOTE_KINDS.includes(re.k) ? re.k : 'text', t: snippet(typeof re.t === 'string' ? re.t : '') };
  }
  const fw = m?.fw;
  if (Number.isInteger(fw) && fw >= 1) out.fw = Math.min(fw, 99);
  return out;
}

/** Hops for a forwarded copy of `m`. */
export const forwardHops = (m) => Math.min(99, (Number.isInteger(m?.fw) && m.fw > 0 ? m.fw : 0) + 1);
export const forwardLabel = (fw) => (fw >= MANY_TIMES ? 'Forwarded many times' : fw >= 1 ? 'Forwarded' : '');

/**
 * What a quote block should show. `local` is this phone's copy of the quoted message (or null).
 * → { id, by, k, t, found, gone }
 */
export function resolveQuote(re, local) {
  if (!re) return null;
  if (local && local.deleted) return { id: re.id, by: re.by, k: 'text', t: 'This message was deleted', found: true, gone: true };
  if (local) {
    const q = quoteOf(local, re.by, re.by); // our own copy wins over the sender's preview
    return { id: re.id, by: re.by, k: q.k, t: q.t, found: true, gone: false };
  }
  return { ...re, found: false, gone: false };
}

// ---------------------------------------------------------------- read receipts
// Delivered (✓✓ grey) is automatic: it only says the phone got it. READ (✓✓ blue) says you
// looked at it, which is personal — so it's yours to switch off, for everyone or per contact.
// Like WhatsApp, it's reciprocal: with receipts off for someone, you don't send them yours
// AND you don't see theirs. Otherwise "off" would let you watch others while hiding yourself.

/** @param {{readReceipts?: boolean}} settings @param {{receipts?: 'on'|'off'|undefined}} contact */
export function receiptsOn(settings, contact) {
  if (contact?.receipts === 'on') return true;
  if (contact?.receipts === 'off') return false;
  return settings?.readReceipts !== false; // default: on
}

/** Incoming messages in a chat that should now be confirmed as read. */
export function toConfirm(msgs) {
  return (msgs || []).filter((m) => m.dir === 'in' && !m.system && !m.deleted && !m.rs && typeof m.id === 'string').map((m) => m.id);
}

/** Validate an incoming `{t:'read', ids}`: at most 200 sane ids. */
export function readIds(m) {
  if (!Array.isArray(m?.ids)) return [];
  return [...new Set(m.ids.filter((x) => typeof x === 'string' && HEX_ID.test(x)))].slice(0, 200);
}

// Message status only moves forward: a late "delivered" must not undo "read". "failed" (the relay
// gave up) can replace queued/sent, never a message the other phone already confirmed.
const RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };
export function statusAfter(cur, next) {
  if (next === 'failed') return cur === 'delivered' || cur === 'read' ? cur : 'failed';
  if (!(next in RANK)) return cur;
  return cur === 'failed' || (RANK[next] > (RANK[cur] ?? -1)) ? next : cur;
}

// ---------------------------------------------------------------- file type label
// The viewer shows WHAT a file really is ("JPEG · 199 KB"), from the type detected in its bytes
// (media.js inspectFile → realType), not from its name — a "photo.jpg" that is really a PNG says PNG.
const TYPES = {
  'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WEBP', 'image/gif': 'GIF', 'image/heic': 'HEIC', 'image/heif': 'HEIF', 'image/avif': 'AVIF',
  'video/mp4': 'MP4', 'video/quicktime': 'MOV', 'video/webm': 'WEBM',
  'audio/mp4': 'M4A', 'audio/mpeg': 'MP3', 'audio/webm': 'WEBM', 'audio/ogg': 'OGG', 'audio/wav': 'WAV',
  'application/pdf': 'PDF', 'application/zip': 'ZIP', 'text/plain': 'TXT',
};
export function typeLabel(mime, name = '') {
  const t = TYPES[String(mime || '').split(';')[0].toLowerCase()];
  if (t) return t;
  const ext = /\.([a-z0-9]{1,5})$/i.exec(String(name))?.[1];
  return ext ? ext.toUpperCase() : 'FILE';
}
