// status.js — Status updates: a text or photo that your contacts can see for 24 hours.
// Pure rules (no DOM, no network), unit-tested in test/unit/status.test.mjs.
//
// How a status travels: it is NOT posted to a server. Your phone sends it to each contact who
// may see it, end-to-end encrypted like a message (nearby or through the relay). Contacts who
// are offline get it when they're next reachable; anyone not in your audience never receives it
// at all. Every phone deletes a status 24 hours after it was posted — and refuses one that claims
// to last longer.
//
// Wire messages (all inside the encrypted channel):
//   { t:'status', id, ts, kind:'text', text, bg, font }          a text status
//   file with tag st:{ id, ts, cap }                              a photo status (caption ≤ 200)
//   { t:'status-del', id }                                         the owner deleted it
//   { t:'status-seen', id }                                        a viewer looked at it (only if their
//                                                                  read receipts are on — reciprocal)

export const STATUS_TTL = 24 * 60 * 60 * 1000;
export const MAX_STATUS_TEXT = 700;
export const MAX_CAPTION = 200;
export const SKEW = 5 * 60 * 1000; // a phone's clock may be a few minutes fast
const HEX_ID = /^[0-9a-f]{8,32}$/;

// Text-status backgrounds (CSS classes .stbg-<id>) and type faces (.stfont-<id>).
export const STATUS_BGS = ['teal', 'midnight', 'violet', 'sunset', 'rose', 'forest', 'ocean', 'graphite'];
export const STATUS_FONTS = ['sans', 'serif', 'mono', 'bold'];

/** When a status posted at `ts` disappears. */
export const expiresAt = (ts) => ts + STATUS_TTL;

/** Validate an incoming text status. → normalized status, or null (drop it). */
export function readStatus(m, now = Date.now()) {
  if (!m || m.kind !== 'text' || typeof m.id !== 'string' || !HEX_ID.test(m.id)) return null;
  const ts = Number(m.ts);
  if (!Number.isFinite(ts) || ts > now + SKEW || expiresAt(ts) <= now) return null; // from the future, or already gone
  const text = typeof m.text === 'string' ? m.text.trim().slice(0, MAX_STATUS_TEXT) : '';
  if (!text) return null;
  return { id: m.id, ts, exp: expiresAt(ts), kind: 'text', text,
    bg: STATUS_BGS.includes(m.bg) ? m.bg : STATUS_BGS[0], font: STATUS_FONTS.includes(m.font) ? m.font : STATUS_FONTS[0] };
}

/** Validate the `st` tag on a received photo. → { id, ts, exp, cap } or null. */
export function statusTag(st, now = Date.now()) {
  if (!st || typeof st !== 'object' || typeof st.id !== 'string' || !HEX_ID.test(st.id)) return null;
  const ts = Number(st.ts);
  if (!Number.isFinite(ts) || ts > now + SKEW || expiresAt(ts) <= now) return null;
  return { id: st.id, ts, exp: expiresAt(ts), cap: typeof st.cap === 'string' ? st.cap.trim().slice(0, MAX_CAPTION) : '' };
}

export const readStatusId = (m) => (typeof m?.id === 'string' && HEX_ID.test(m.id) ? m.id : null);

/** Who can see my status: everyone I've accepted, all except some, or only some. */
export const AUDIENCE_MODES = ['all', 'except', 'only'];
export function cleanAudience(a) {
  const mode = AUDIENCE_MODES.includes(a?.mode) ? a.mode : 'all';
  const list = Array.isArray(a?.list) ? [...new Set(a.list.filter((x) => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x)))] : [];
  return { mode, list };
}
/** @param contacts {Array<{id: string, request?: boolean}>} */
export function audience(setting, contacts) {
  const { mode, list } = cleanAudience(setting);
  const ok = (contacts || []).filter((c) => c && !c.request).map((c) => c.id);
  if (mode === 'except') return ok.filter((id) => !list.includes(id));
  if (mode === 'only') return ok.filter((id) => list.includes(id));
  return ok;
}

/** Drop expired statuses. */
export const live = (list, now = Date.now()) => (list || []).filter((s) => s.exp > now);

/**
 * The Status screen's contact rows: one per person with live statuses, newest first,
 * people with something you haven't seen above people you've caught up with.
 * @param byOwner Map<cid, status[]>
 */
export function statusRows(byOwner, now = Date.now()) {
  const rows = [];
  for (const [cid, list] of byOwner) {
    const l = live(list, now).sort((a, b) => a.ts - b.ts);
    if (!l.length) continue;
    rows.push({ cid, statuses: l, latest: l[l.length - 1].ts, unseen: l.some((s) => !s.seen), firstUnseen: Math.max(0, l.findIndex((s) => !s.seen)) });
  }
  return rows.sort((a, b) => (b.unseen - a.unseen) || (b.latest - a.latest));
}

/** How long a status stays on screen before moving on: longer text gets longer. */
export function showFor(s) {
  if (s.kind === 'photo') return 6000;
  return Math.max(4000, Math.min(10000, 2500 + (s.text?.length || 0) * 45));
}

/** "2h ago" / "just now" / "23m ago". */
export function ago(ts, now = Date.now()) {
  const m = Math.floor(Math.max(0, now - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ---------------------------------------------------------------- delivery (sent ≠ received)
// A status used to be marked "sent to Bob" the moment it left this phone, and was never sent
// again. If Bob's phone dropped it (e.g. it was still on an older Murmur that didn't know
// statuses yet), Bob never saw it and nothing ever noticed. Now the receiver CONFIRMS each status
// (`status-got`, also implied by `status-seen`), and the sender re-sends to anyone who hasn't
// confirmed: whenever they come back online, and every RESEND_MS while Murmur is open — until it
// expires. Receivers drop duplicates by id, so a re-send is harmless.
export const RESEND_MS = 5 * 60_000;

/** Should status `s` go (again) to `cid` now? Confirmed → never; sent recently → wait; else yes. */
export function needsSend(s, cid, now = Date.now()) {
  if ((s.gotBy || []).includes(cid)) return false;
  const last = s.sentAt?.[cid];
  return !(Number.isFinite(last) && now - last < RESEND_MS && now >= last);
}

/** For the owner's "Viewed by" sheet: who has it, who doesn't yet. */
export function deliveryState(s, audienceIds) {
  const got = new Set([...(s.gotBy || []), ...Object.keys(s.views || {})]);
  const delivered = audienceIds.filter((c) => got.has(c));
  return { delivered, waiting: audienceIds.filter((c) => !got.has(c)) };
}
