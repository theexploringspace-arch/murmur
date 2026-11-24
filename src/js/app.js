// app.js — Murmur's UI controller. Views are plain functions that rebuild
// #app from state. All persistence goes through the encrypted Vault.

import { Vault, WrongPassphraseError, VaultWipedError, LockedOutError, MIN_PASSPHRASE } from './core/vault.js';
import { IdbStore } from './core/storage.js';
import { Conversation, MAX_FILE, MAX_TEXT, APP_VERSION, newId, fileExtra } from './core/conversation.js';
import { Remote } from './core/remote.js';
import { RELAY_URL } from './config.js';
import { linkify, inspectFile, lookalikeNames } from './core/safety.js';
import { sha256 } from './core/crypto.js';
import { stripMetadata } from './core/media.js';
import { validLocation, relative, formatCoords, mapLinks } from './core/geo.js';
import { createGroup, applyInvite, inviteMessage, isMember, withoutMember, recipients, GroupError } from './core/groups.js';
import { contactId, safetyNumber } from './core/identity.js';
import { toQrText, toPasteText, fromText, PairingError, clampName } from './core/pairing.js';
import { toB64u, fromB64u, equal, toHex, utf8, random } from './core/bytes.js';
import { encodeQR } from './qr/encode.js';
import { Scanner, decodeImageFile } from './qr/scanner.js';
import { h, clear, icon, qrSvg, toast, fmtTime, fmtBytes } from './ui/dom.js';
import { scriptUrl } from './ui/trusted.js';
import { voicePlayer, voiceRecorder, stopAllVoice } from './ui/voice.js';
import { slots, anyVault, ensureSlots, unlockAny, setDuress, clearDuress, opensOther } from './core/duress.js';
import * as BK from './core/backup.js';
import { readBox, writeBox } from './core/relaybox.js';
import { Call, readSignal, callDecision, callButtons, formatDuration } from './core/call.js';
import { canEdit, canDeleteForEveryone, minutesLeft, acceptChange, EDIT_WINDOW, DELETE_WINDOW } from './core/edits.js';
import { normalizeUsername, usernameProblem, makeLogin, checkLogin, profileFor, readProfile, LOGIN_KEY, MAX_PIC } from './core/profile.js';
import { msgMeta, quoteOf, resolveQuote, kindOf, kindLabel, forwardHops, forwardLabel, receiptsOn, toConfirm, readIds, statusAfter, typeLabel } from './core/meta.js';

const $app = document.getElementById('app');
const store = new IdbStore();
const SLOTS = slots(store); // a = real vault, b = duress decoy or placeholder (see core/duress.js)

const TTL_OPTIONS = [[0, 'Off'], [30, '30 seconds'], [300, '5 minutes'], [3600, '1 hour'], [86400, '1 day']];
const LOCK_OPTIONS = [[1, '1 minute'], [5, '5 minutes'], [15, '15 minutes'], [60, '1 hour']];
const WIPE_OPTIONS = [[0, 'Never (recommended)'], [10, 'After 10 wrong tries'], [20, 'After 20 wrong tries']];

/** In-memory state. Everything here disappears on lock. */
const S = {
  vault: null, profile: null, settings: null,
  contacts: new Map(),   // id → {id, pub, name, alias, addedAt, keepHistory, ttl}
  chats: new Map(),      // id → [message]
  convs: new Map(),      // id → Conversation (live)
  unread: new Map(),
  typing: new Map(),
  drafts: new Map(),     // chat key → unsent text (memory only, never stored)
  replyTo: new Map(),    // chat key → reply quote waiting in the composer (memory only)
  view: null, viewArgs: null,
  scanner: null,
  lastActivity: Date.now(),
  remote: null,          // Remote (internet mode via the relay), null when off/locked
  relayOnline: false,
  rfiles: new Map(),     // incoming files over the relay: `${cid}:${fid}` → {meta, parts, got}
  pendingInvite: null,   // invite link opened before unlocking
  myCid: null,           // my own contact id (groups list me by it)
  groups: new Map(),     // gid → group (see core/groups.js)
  myLoc: null,           // my last GPS fix, only kept in memory, used for "how far?"
  liveShares: new Map(), // chat key → {watchId, lid, until, last}
};

// ---------------------------------------------------------------- utilities
const displayName = (c) => c.alias || c.name || 'Unknown';
const isOnline = (id) => S.convs.get(id)?.state === 'connected';
const hasRemote = (id) => !!S.remote?.has(id);
/** Can we send right now (live) or at least queue for the relay? */
const canChat = (id) => isOnline(id) || (hasRemote(id) && S.remote.canSend(id));
/** [label, kind] for the connection pill. */
function linkState(id) {
  if (isOnline(id)) return ['nearby · connected', 'nearby'];
  if (hasRemote(id)) return S.relayOnline ? ['via internet', 'internet'] : ['no internet · will send later', 'queued'];
  return ['not connected', 'none'];
}
const REMOTE_CHUNK = 512 * 1024;      // raw bytes per relay chunk (≈700 KB envelope, under the relay's 1 MiB cap)
const REMOTE_CHUNK_MIN = 192 * 1024;  // older senders used this; still accepted

function go(view, ...args) {
  stopScanner();
  S.view = view; S.viewArgs = args;
  render();
}
// Voice notes outlive re-renders of the SAME chat (the relay flickering re-draws it): a playing
// clip keeps playing and a recording in progress keeps recording. Leaving the chat stops both.
const PLAYERS = new Map(); // blob url → player element, reused by bubble()
let lastScreen = '';
function render() {
  const screen = `${S.view}:${S.viewArgs?.[0] ?? ''}`;
  if (screen !== lastScreen) {
    lastScreen = screen; stopAllVoice(); PLAYERS.clear(); closeViewer();
    if (S.voiceRec) { S.voiceRec.discard(); S.voiceRec = null; } // releases the microphone
  }
  // Re-drawing the same chat must not steal the keyboard or move the cursor while you type.
  const typing = document.activeElement?.id === 'compose' ? document.activeElement : null;
  const sel = typing && [typing.selectionStart, typing.selectionEnd];
  const v = VIEWS[S.view];
  clear($app).append(v(...(S.viewArgs || [])));
  const again = typing && document.getElementById('compose');
  if (again) { again.focus(); try { again.setSelectionRange(...sel); } catch { /* value shorter now */ } return; }
  const focus = $app.querySelector('[autofocus]');
  if (focus) focus.focus();
}
function rerenderIf(view, pred = () => true) { if (S.view === view && pred()) render(); }

function stopScanner() { if (S.scanner) { S.scanner.stop(); S.scanner = null; } }

function modal({ title, body, actions }) {
  return new Promise((resolve) => {
    const close = (v) => { m.remove(); resolve(v); };
    const m = h('div.modal-backdrop', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div.modal',
        h('h2', title),
        ...(Array.isArray(body) ? body : [body]).map((b) => (typeof b === 'string' ? h('p', b) : b)),
        h('div.modal-actions', actions.map(([label, value, cls = '']) =>
          h(`button${cls ? '.' + cls : ''}`, { onclick: () => close(value), 'data-testid': `modal-${value}` }, label)))));
    document.body.append(m);
    m.querySelector('button:last-child').focus();
  });
}

async function persistContacts() {
  await S.vault.putRecord('contacts', [...S.contacts.values()]);
}
// History (if kept) holds text, photos, voice notes, files, locations and call logs — all inside
// the encrypted vault. Each file's bytes are their own record (media/<contact>/<message>), written
// once; the history list only references them. Disappearing messages are never stored.
const MEDIA = (id, mid) => `media/${id}/${mid}`;
const HISTORY_MAX = 2000;
const persistQueue = new Map(); // one save at a time per chat, in order
function persistHistory(id) {
  const next = (persistQueue.get(id) || Promise.resolve()).then(() => saveHistory(id)).catch((e) => console.warn('history save:', e.message));
  persistQueue.set(id, next);
  return next;
}
async function saveHistory(id) {
  const c = S.contacts.get(id);
  if (!c || !S.vault) return;
  const had = c.media || [];
  if (!c.keepHistory) {
    await S.vault.deleteRecord(`history/${id}`);
    for (const mid of had) await S.vault.deleteRecord(MEDIA(id, mid));
    if (had.length) { c.media = []; await persistContacts(); }
    return;
  }
  const out = [];
  for (const m of (S.chats.get(id) || []).slice(-HISTORY_MAX)) {
    if (m.ttl) continue;
    const base = { id: m.id, dir: m.dir, ts: m.ts, status: m.status, edited: m.edited, deleted: m.deleted, system: m.system, re: m.re, fw: m.fw, rs: m.rs };
    if (m.file && !m.deleted) {
      if (!m.file.stored && m.file.blob) {
        const bytes = new Uint8Array(await m.file.blob.arrayBuffer());
        await S.vault.putRecord(MEDIA(id, m.id), { name: m.file.name, mime: m.file.mime, kind: m.file.kind || null, b: toB64u(bytes) });
        m.file.stored = true;
      }
      if (m.file.stored) out.push({ ...base, file: { name: m.file.name, mime: m.file.mime, size: m.file.size, kind: m.file.kind || null } });
    } else if (m.loc && !m.deleted) out.push({ ...base, loc: m.loc });
    else if (m.sos && !m.deleted) out.push({ ...base, sos: m.sos });
    else if (m.text != null || m.deleted) out.push({ ...base, text: m.deleted ? undefined : m.text });
  }
  await S.vault.putRecord(`history/${id}`, out);
  // Files that were deleted (for me or for everyone), cleared or aged out: remove their bytes too.
  const keep = new Set(out.filter((x) => x.file).map((x) => x.id));
  for (const mid of had) if (!keep.has(mid)) await S.vault.deleteRecord(MEDIA(id, mid));
  const now = [...keep];
  if (now.length !== had.length || now.some((x, i) => x !== had[i])) { c.media = now; await persistContacts(); }
}
/** After unlock: turn stored file entries back into viewable photos/voice notes (in the background). */
async function hydrateMedia(id) {
  for (const m of S.chats.get(id) || []) {
    if (!m.file || m.file.url || !m.file.stored) continue;
    const rec = await S.vault?.getRecord(MEDIA(id, m.id), null);
    if (!S.vault) return; // locked meanwhile
    if (!rec) { m.file.missing = true; continue; }
    const fm = await fileMessage({ id: m.id, dir: m.dir, ts: m.ts, status: m.status }, rec.name, rec.mime, fromB64u(rec.b), rec.kind);
    m.file = { ...fm.file, stored: true };
    const el = document.querySelector(`#log [data-mid="${CSS.escape(m.id)}"]`);
    if (el && isOpenChat(id)) el.replaceWith(bubble(m, id));
  }
  rerenderIf('shared', () => S.viewArgs[0] === id);
}

function strength(p) {
  // Rough entropy estimate: pool size × length, penalising repeats. Guidance only.
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26; if (/[A-Z]/.test(p)) pool += 26; if (/\d/.test(p)) pool += 10; if (/[^a-zA-Z0-9]/.test(p)) pool += 33;
  const uniq = new Set(p).size;
  const bits = Math.round(Math.log2(Math.max(pool, 1)) * Math.min(p.length, uniq * 2));
  return { bits, label: bits < 45 ? 'weak' : bits < 65 ? 'fair' : bits < 85 ? 'strong' : 'excellent' };
}

// ---------------------------------------------------------------- lifecycle
async function boot() {
  registerServiceWorker();
  wireAutoLock();
  // An invite link (…/#i=…) was opened: remember it, then remove it from the address
  // bar so it isn't left in history or shown over someone's shoulder.
  if (/[#&]i=/.test(location.hash)) {
    S.pendingInvite = location.href;
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (await anyVault(store)) {
    go('unlock');
    // Older installs have one slot; add the second (an unopenable placeholder) in the background.
    ensureSlots(store).catch((e) => console.warn('slot setup:', e.message));
  } else go('welcome');
}

async function openVault(vault) {
  // Load everything the timers and views read BEFORE publishing S.vault: they treat
  // "S.vault is set" as "the session is ready" (a tick in between used to crash).
  const profile = { name: '', ...(await vault.getRecord('profile', {})) };
  const settings = { autoLockMin: 5, ...(await vault.getRecord('settings', {})) };
  S.lastActivity = Date.now();
  S.profile = profile; S.settings = settings; S.vault = vault;
  S.contacts = new Map((await vault.getRecord('contacts', [])).map((c) => [c.id, c]));
  S.chats = new Map();
  S.myCid = await contactId(vault.identity.publicRaw);
  S.groups = new Map((await vault.getRecord('groups', [])).map((g) => [g.id, g]));
  for (const c of S.contacts.values()) {
    if (c.verified === undefined) c.verified = !c.remote; // contacts from before internet mode were all paired in person
    if (c.keepHistory) S.chats.set(c.id, (await vault.getRecord(`history/${c.id}`, [])).map((m) => (m.file ? { ...m, file: { ...m.file, stored: true } } : m)));
  }
  S.lastActivity = Date.now();
  navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict our (encrypted) data under storage pressure
  for (const id of S.chats.keys()) hydrateMedia(id).catch((e) => console.warn('media:', e.message));
  await startRemote().catch((e) => toast(`Internet mode unavailable: ${e.message}`, 'error'));
  // Restored from a file/online backup (an older copy): renew every secure link once.
  if (S.remote && S.slot === 'a' && (await store.get('restore/pending'))) {
    await S.remote.resyncAll().catch((e) => console.warn('resync:', e.message));
    await store.delete('restore/pending');
    if (S.remote.resyncing().length) toast('Renewing the secure link with each contact — messages you write now go out as soon as they’re online', 'success', 7000);
  }
  setTimeout(() => refreshOnlineBackup().catch((e) => console.warn('online backup:', e.message)), 15_000);
  if (S.pendingInvite) { const t = S.pendingInvite; S.pendingInvite = null; go('acceptinvite', t); } else go('home');
}

// ---------------------------------------------------------------- internet mode
async function startRemote() {
  if (S.settings.internet === false || S.remote) return;
  const r = new Remote({ vault: S.vault, identity: S.vault.identity, relayUrl: RELAY_URL, origin: location.origin, getName: () => S.profile.name });
  await r.load();
  S.remote = r;
  r.on('status', (v) => { S.relayOnline = v; if (v) syncProfiles(); rerenderIf('home'); rerenderIf('chat'); rerenderIf('settings'); })
    .on('message', (cid, m) => onRemoteMessage(cid, m).catch((e) => console.warn(e)))
    .on('joined', (j) => onRemoteJoined(j).catch((e) => console.warn(e)))
    .on('sent', (cid, mid) => setMsgStatus(cid, mid, 'sent'))
    .on('send-failed', (cid, mid, why) => { setMsgStatus(cid, mid, 'failed'); toast(why, 'error', 6000); })
    .on('warning', (w) => console.warn('relay:', w))
    .on('resynced', (cid, info) => {
      if (!S.contacts.has(cid)) return;
      callMsg(cid, info.initiator ? '🔐 Secure link renewed after restoring your account' : `🔐 ${displayName(S.contacts.get(cid))} restored Murmur on a new phone — secure link renewed (same safety number)`);
    });
  r.start();
}
function stopRemote() { S.remote?.stop(); S.remote = null; S.relayOnline = false; }

function setMsgStatus(cid, mid, status) {
  const m = (S.chats.get(cid) || []).find((x) => x.id === mid && x.dir === 'out');
  if (!m) { if (status === 'delivered') groupAck(cid, mid); return; }
  const next = statusAfter(m.status, status); // only forward: a late "delivered" never undoes "read"
  if (next === m.status) return;
  m.status = next; paintStatus(cid, m);
  persistHistory(cid).catch(() => {});
}
/** Read receipts are reciprocal: with them off for this contact, their "read" shows as delivered. */
function shownStatus(key, m) {
  if (m.status === 'read' && !(S.contacts.get(key) && receiptsOn(S.settings, S.contacts.get(key)))) return 'delivered';
  return m.status || 'sent';
}
function paintStatus(key, m) {
  if (!isOpenChat(key)) return;
  const el = document.querySelector(`#log [data-mid="${CSS.escape(m.id)}"] .status`); if (!el) return;
  const st = shownStatus(key, m); el.textContent = groupStatus(m, key); el.dataset.st = st; el.title = STATUS_WORD[st] || st;
}
const ACKED = new Set(); // `${cid}:${mid}` confirmed by the other phone (bounded)
const markDelivered = (cid, mid) => {
  ACKED.add(`${cid}:${mid}`); if (ACKED.size > 5000) ACKED.delete(ACKED.values().next().value);
  setMsgStatus(cid, mid, 'delivered');
};
// A nearby (Wi-Fi/hotspot) link can look alive for ~30 s after the other phone has gone
// (walked out of range, closed, lost). Anything sent over it that isn't confirmed within 5 s
// is sent again through the relay; the receiver drops the duplicate (same message id).
const LIVE_CONFIRM_MS = 5000;
function backstopViaRelay(cid, m) {
  if (!m?.id) return;
  setTimeout(() => {
    if (ACKED.has(`${cid}:${m.id}`) || !S.remote || !hasRemote(cid) || !S.remote.canSend(cid)) return;
    S.remote.send(cid, m).then(() => setMsgStatus(cid, m.id, S.relayOnline ? 'sent' : 'queued')).catch(() => {});
  }, LIVE_CONFIRM_MS);
}
const STATUS_MARK = { queued: '○', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '!' };
const STATUS_WORD = { queued: 'Waiting to send', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not delivered' };

async function onRemoteJoined({ cid, name, pub }) {
  let c = S.contacts.get(cid);
  if (!c) {
    c = { id: cid, pub: toB64u(pub), name, alias: '', addedAt: Date.now(), keepHistory: true, ttl: 0, remote: true, verified: false, request: true };
    const look = lookalikeNames(name, [...S.contacts.values()].map(displayName));
    if (look.length) c.lookalike = look;
    S.contacts.set(cid, c);
  } else c.remote = true;
  await persistContacts();
  toast(`${name} joined using your invite link`, 'success', 6000);
  rerenderIf('home'); rerenderIf('chat', () => S.viewArgs[0] === cid);
}

async function onRemoteMessage(cid, m) {
  const c = S.contacts.get(cid);
  if (!c) return;
  switch (m.t) {
    case 'hello': if (!c.remote) { c.remote = true; await persistContacts(); } rerenderIf('chat', () => S.viewArgs[0] === cid); rerenderIf('home'); break;
    case 'msg':
      if (typeof m.text !== 'string' || m.text.length > MAX_TEXT || typeof m.id !== 'string') return;
      addMessage(cid, { id: m.id.slice(0, 32), dir: 'in', ts: +m.ts || Date.now(), text: m.text, ttl: Math.max(0, m.ttl | 0), ...msgMeta(m) });
      S.remote.send(cid, { t: 'ack', id: m.id }).catch(() => {});
      break;
    case 'ack': markDelivered(cid, String(m.id)); break;
    case 'file': {
      if (!(m.size >= 0 && m.size <= MAX_FILE) || !(m.chunks >= 1 && m.chunks <= Math.ceil(MAX_FILE / REMOTE_CHUNK_MIN) + 1)) return;
      const key = `${cid}:${m.id}`;
      if ([...S.rfiles.keys()].filter((k) => k.startsWith(cid)).length >= 4) return;
      S.rfiles.set(key, { meta: m, parts: [], got: 0 });
      if (S.view === 'chat' && S.viewArgs[0] === cid) setStatusLine(`Receiving ${m.name}…`);
      break;
    }
    case 'chunk': {
      const key = `${cid}:${m.id}`; const f = S.rfiles.get(key);
      if (!f || m.i !== f.parts.length) return;
      const d = fromB64u(String(m.d)); f.got += d.length;
      if (d.length > REMOTE_CHUNK) { S.rfiles.delete(key); return; }
      if (f.got > f.meta.size) { S.rfiles.delete(key); return; }
      f.parts.push(d);
      if (S.view === 'chat' && S.viewArgs[0] === cid) setStatusLine(`Receiving… ${Math.round((f.got / f.meta.size) * 100)}%`);
      if (f.parts.length === f.meta.chunks) {
        S.rfiles.delete(key);
        const blob = new Blob(f.parts, { type: 'application/octet-stream' });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (toB64u(await sha256(bytes)) !== f.meta.sha) { toast(`File “${f.meta.name}” failed its integrity check`, 'error'); return; }
        await receivedFile(cid, { id: String(f.meta.id), ts: +f.meta.ts || Date.now(), ttl: Math.max(0, f.meta.ttl | 0) }, String(f.meta.name), String(f.meta.mime), bytes, fileExtra(f.meta));
        S.remote.send(cid, { t: 'ack', id: f.meta.id }).catch(() => {});
        if (S.view === 'chat' && S.viewArgs[0] === cid) setStatusLine('');
      }
      break;
    }
    default: await onAppMessage(cid, m); break;
  }
}

/** Build a file message: checks the REAL type from the bytes before anything is shown. */
async function fileMessage(base, name, mime, bytes, kind) {
  const safety = inspectFile(name, mime, bytes);
  // Audio/video play inside Murmur only when their CONTENT is really audio/video and nothing was flagged.
  const playable = safety.verdict === 'ok' && /^(audio\/|video\/(mp4|webm|quicktime))/.test(safety.realType)
    ? (kind === 'voice' || safety.realType.startsWith('audio/') ? 'audio' : 'video') : null;
  const type = safety.inline || playable ? safety.realType : 'application/octet-stream'; // never let the browser sniff/render other types
  const blob = new Blob([bytes], { type });
  return { ...base, file: { name: safety.name, mime, size: bytes.length, blob, url: URL.createObjectURL(blob), safety, playable, kind } };
}

async function sendFileRemote(cid, file, ttl, progress, extra = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const meta = { t: 'file', id: extra.id || newId(), ts: Date.now(), ...fileExtra(extra), name: String(file.name || 'file').slice(0, 120), mime: String(file.type || 'application/octet-stream').slice(0, 100),
    size: bytes.length, sha: toB64u(await sha256(bytes)), chunks: Math.ceil(bytes.length / REMOTE_CHUNK) || 1, ttl: ttl | 0 };
  await S.remote.send(cid, meta);
  for (let i = 0; i < meta.chunks; i++) {
    await S.remote.send(cid, { t: 'chunk', id: meta.id, i, d: toB64u(bytes.subarray(i * REMOTE_CHUNK, (i + 1) * REMOTE_CHUNK)) });
    progress(Math.min(bytes.length, (i + 1) * REMOTE_CHUNK), bytes.length);
  }
  return { meta, bytes };
}

// ---- face-to-face bootstrap of the internet link (over the authenticated live session) ----
async function offerRemoteSetup(conv) {
  if (!S.remote) return;
  const b = await S.remote.liveOffer();
  await conv.sendControl({ t: 'r-invite', b: toB64u(b) });
}
async function onControl(conv, id, m) {
  if (!S.remote) return;
  if (m.t === 'r-need') { await offerRemoteSetup(conv); return; }
  if (m.t === 'r-invite') {
    const { join, first } = await S.remote.liveAnswer(fromB64u(String(m.b)), conv.peer.publicRaw, { t: 'hello', name: S.profile.name });
    await conv.sendControl({ t: 'r-join', j: toB64u(join), f: toB64u(first) });
  } else if (m.t === 'r-join') {
    await S.remote.liveFinish(fromB64u(String(m.j)), fromB64u(String(m.f)), conv.peer.publicRaw);
  } else return;
  const c = S.contacts.get(id);
  if (c) { c.remote = true; c.verified = true; c.request = false; await persistContacts(); }
  rerenderIf('chat', () => S.viewArgs[0] === id); rerenderIf('home');
}

function lock(reason) {
  stopRemote();
  stopAllLiveShares();
  for (const conv of S.convs.values()) conv.close('locked');
  stopAllVoice(); if (S.voiceRec) { S.voiceRec.discard(); S.voiceRec = null; }
  for (const msgs of S.chats.values()) for (const m of msgs) dropFileUrl(m);
  for (const u of PIC_URLS.values()) URL.revokeObjectURL(u); PIC_URLS.clear();
  endCall('locked');
  S.vault?.lock();
  Object.assign(S, { vault: null, profile: null, settings: null, contacts: new Map(), chats: new Map(), convs: new Map(), unread: new Map(), typing: new Map(), drafts: new Map(), replyTo: new Map(), rfiles: new Map(), groups: new Map(), myCid: null, myLoc: null });
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove());
  go('unlock');
  if (reason) toast(reason);
}

function wireAutoLock() {
  const touch = () => { S.lastActivity = Date.now(); };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, touch, { passive: true });
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else { S.remote?.kick(); checkForUpdate(); }
    if (document.hidden) return;
    if (S.vault && hiddenAt && Date.now() - hiddenAt > S.settings.autoLockMin * 60000) lock('Locked while you were away');
  });
  addEventListener('online', () => S.remote?.kick());
  // An invite link opened while Murmur is already running.
  addEventListener('hashchange', () => {
    if (!/[#&]i=/.test(location.hash)) return;
    const href = location.href; history.replaceState(null, '', location.pathname + location.search);
    if (S.vault) go('acceptinvite', href); else S.pendingInvite = href;
  });
  setInterval(() => {
    if (S.vault && Date.now() - S.lastActivity > S.settings.autoLockMin * 60000) lock('Locked after inactivity');
    purgeExpired();
  }, 1000);
}

function purgeExpired() {
  const now = Date.now();
  for (const [id, msgs] of S.chats) {
    const keep = msgs.filter((m) => !m.expiresAt || m.expiresAt > now);
    if (keep.length !== msgs.length) {
      for (const m of msgs) if (m.expiresAt && m.expiresAt <= now) dropFileUrl(m);
      S.chats.set(id, keep);
      rerenderIf('chat', () => S.viewArgs[0] === id);
    }
  }
  // live countdowns
  document.querySelectorAll('[data-expires]').forEach((el) => {
    const left = Math.max(0, Math.round((+el.dataset.expires - now) / 1000));
    el.textContent = left > 3600 ? `${Math.round(left / 3600)}h` : left > 60 ? `${Math.round(left / 60)}m` : `${left}s`;
  });
}

/** Last reason the offline engine refused to install (shown in Settings). */
let offlineError = null;

function explainOfflineError(raw) {
  const m = /integrity check failed for (\S+)/.exec(raw);
  if (m) return `Offline mode is OFF: the website hosting Murmur altered ${m[1]} (for example by injecting a badge or script). Murmur refused to install a modified copy. Ask the host owner to disable injection, then reopen Murmur.`;
  return `Offline mode is OFF: Murmur couldn't download all of its files (${raw}). Open it again while online.`;
}

// ---- updates ----
// A new build installs in the background as a *waiting* service worker, after its own
// integrity check passed. Browsers only swap it in once every Murmur window is closed,
// which on phones can take days. So: look for updates whenever Murmur comes to the
// front, and when one is verified and waiting, say so and let the person apply it.
const UPD = { reg: null, waiting: null, running: null, next: null, applying: false };

/** The fingerprint inside a build's own cache (never the network). */
async function cachedFingerprint(cacheName) {
  try {
    const res = await (await caches.open(cacheName)).match('./build-info.json');
    return res ? (await res.json()).fingerprint : null;
  } catch { return null; }
}
async function noteWaiting(worker) {
  if (!worker || !navigator.serviceWorker.controller) return; // first install: nothing to replace
  UPD.waiting = worker;
  const names = (await caches.keys()).filter((k) => k.startsWith('murmur-'));
  const fps = await Promise.all(names.map(cachedFingerprint));
  UPD.next = fps.find((f) => f && f !== UPD.running) || null;
  rerenderIf('home'); rerenderIf('settings');
  rerenderIf('unlock', () => !document.getElementById('pass')?.value); // never wipe a half-typed passphrase
}
function checkForUpdate() { UPD.reg?.update().catch(() => {}); }
function applyUpdate() {
  if (!UPD.waiting || UPD.applying) return;
  UPD.applying = true;
  UPD.waiting.postMessage({ type: 'murmur-skip-waiting' }); // reload happens on controllerchange
}
function updateBanner() {
  if (!UPD.waiting) return null;
  return h('div.banner.update', { 'data-testid': 'update-banner' },
    h('p', icon('shield', 14), ' A new version of Murmur is downloaded and passed its integrity check.'),
    UPD.next ? h('p.hint', 'New fingerprint: ', h('code.small', UPD.next)) : null,
    h('button.primary', { type: 'button', onclick: applyUpdate, 'data-testid': 'apply-update' }, UPD.applying ? 'Restarting…' : 'Restart to update'));
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  fetch('./build-info.json').then((r) => r.json()).then((b) => { UPD.running = b.fingerprint; }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'murmur-offline-error') return;
    offlineError = explainOfflineError(String(e.data.message));
    toast(offlineError, 'error', 15000);
    rerenderIf('settings');
  });
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // A new verified build took over. Reload so page and cache are the same build —
    // but a first install claiming this page is not an update: don't yank it out
    // from under someone mid-setup.
    if (hadController || UPD.applying) location.reload();
  });
  try {
    const reg = await navigator.serviceWorker.register(scriptUrl('./sw.js'), { scope: './' });
    UPD.reg = reg;
    if (reg.waiting) noteWaiting(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed') noteWaiting(w); });
    });
    checkForUpdate();
  } catch (e) { console.warn('Service worker not registered (offline use unavailable):', e.message); }
}

// ---------------------------------------------------------------- conversations
function addMessage(cid, m) {
  if (!S.chats.has(cid)) S.chats.set(cid, []);
  const list = S.chats.get(cid);
  if (list.some((x) => x.id === m.id && x.dir === m.dir)) return;
  if (m.ttl) m.expiresAt = Date.now() + m.ttl * 1000;
  list.push(m);
  const open = isOpenChat(cid);
  if (m.dir === 'in' && !(open && !document.hidden)) S.unread.set(cid, (S.unread.get(cid) || 0) + 1);
  persistHistory(cid).catch(() => {});
  if (open) { appendBubble(m, cid); if (m.dir === 'in') confirmReads(cid); } else rerenderIf('home');
}

// ---- read receipts (blue ✓✓): sent only while the chat is really on screen ----
// Every incoming message gets `rs` (read-sent) once you've seen it — even with receipts off —
// so switching them on later never floods the other phone with old "read"s.
const READ_TIMERS = new Map();
function confirmReads(cid) {
  if (String(cid).startsWith('g:') || document.hidden || !isOpenChat(cid)) return; // groups: delivery only
  clearTimeout(READ_TIMERS.get(cid));
  READ_TIMERS.set(cid, setTimeout(() => {
    READ_TIMERS.delete(cid);
    if (document.hidden || !isOpenChat(cid)) return;
    const c = S.contacts.get(cid); if (!c || c.request) return; // an unaccepted stranger learns nothing
    const msgs = S.chats.get(cid) || []; const ids = toConfirm(msgs);
    if (!ids.length) return;
    for (const m of msgs) if (ids.includes(m.id)) m.rs = 1;
    persistHistory(cid).catch(() => {});
    if (receiptsOn(S.settings, c)) for (let i = 0; i < ids.length; i += 200) deliver(cid, { t: 'read', ids: ids.slice(i, i + 200) }).catch(() => {});
  }, 400));
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.view === 'chat' && S.vault) confirmReads(S.viewArgs[0]); });
const isOpenChat = (key) => (S.view === 'chat' && S.viewArgs[0] === key) || (S.view === 'group' && `g:${S.viewArgs[0]}` === key);

/** Called once a Conversation is connected: bind it to a (possibly new) contact. */
async function adoptConversation(conv) {
  const pub = conv.peer.publicRaw;
  const id = await contactId(pub);
  let c = S.contacts.get(id);
  if (!c) {
    c = { id, pub: toB64u(pub), name: conv.peer.name, alias: '', addedAt: Date.now(), keepHistory: true, ttl: 0 };
    S.contacts.set(id, c);
  }
  // Scanning each other's codes face to face IS verification.
  c.verified = true; c.request = false; delete c.lookalike;
  await persistContacts();
  const old = S.convs.get(id);
  if (old && old !== conv) old.close('replaced by new connection');
  S.convs.set(id, conv);
  conv.on('message', (m) => addMessage(id, { ...m, dir: 'in' }))
    .on('file', async (f) => {
      await receivedFile(id, { id: f.id, ts: f.ts, ttl: f.ttl }, f.name, f.mime, new Uint8Array(await f.blob.arrayBuffer()), f);
      if (S.view === 'chat' && S.viewArgs[0] === id) setStatusLine(''); // "Receiving… 100%" is done
    })
    .on('app', (m) => onAppMessage(id, m).catch((e) => console.warn(e)))
    .on('control', (m) => onControl(conv, id, m).catch((e) => toast(`Internet setup failed: ${e.message}`, 'error')))
    .on('file-start', (f) => { if (S.view === 'chat' && S.viewArgs[0] === id) setStatusLine(`Receiving ${f.name}…`); })
    .on('file-progress', (_fid, got, size) => { if (S.view === 'chat' && S.viewArgs[0] === id) setStatusLine(`Receiving… ${Math.round((got / size) * 100)}%`); })
    .on('ack', (mid) => markDelivered(id, mid))
    .on('typing', (on) => { S.typing.set(id, on); const el = document.getElementById('typing'); if (el) el.hidden = !on; })
    .on('hello', () => rerenderIf('chat', () => S.viewArgs[0] === id))
    .on('error', (e) => toast(e.message, 'error', 6000))
    .on('closed', (why) => {
      if (S.convs.get(id) === conv) S.convs.delete(id);
      if (S.vault) { rerenderIf('chat', () => S.viewArgs[0] === id); rerenderIf('home'); }
      if (why === 'peer left' || why === 'channel closed' || why === 'failed') toast(hasRemote(id) ? `${displayName(c)} left the Wi-Fi — messages now go via internet` : `${displayName(c)} disconnected`);
    });
  syncProfiles([id]);
  // Set up the internet link through this face-to-face session (the inviter starts it).
  // Only when one side lacks it: re-keying an existing link would strand messages already on the relay.
  if (S.remote && !S.remote.has(id)) {
    if (conv.role === 'offerer') offerRemoteSetup(conv).catch(() => {});
    else conv.sendControl({ t: 'r-need' }).catch(() => {});
  }
  return id;
}

/** Warn if a NEW identity claims a name we already know (possible impersonation). */
async function confirmNewIdentity(peer, expectKey) {
  if (expectKey) return true;
  const id = await contactId(peer.publicRaw);
  if (S.contacts.has(id)) return true;
  const clash = [...S.contacts.values()].find((c) => displayName(c).toLowerCase() === peer.name.toLowerCase() || c.name.toLowerCase() === peer.name.toLowerCase());
  if (!clash) return true;
  return modal({
    title: 'Different person, same name',
    body: [`You already have a contact called “${displayName(clash)}”, but this code comes from a DIFFERENT identity key.`,
      'It could be a new phone, a reinstall — or someone pretending. If you are not standing next to them, cancel.'],
    actions: [['Cancel', false], ['Add as new contact', true, 'danger']],
  });
}

// ---------------------------------------------------------------- views
const VIEWS = {};

VIEWS.welcome = () => h('main.screen.center',
  h('div.brand', h('div.logo', icon('shield', 44)), h('h1', 'Murmur')),
  h('p.lede', 'Private messages that never touch the internet.'),
  h('ul.points',
    h('li', h('strong', 'No servers. '), 'Phones connect directly over the same Wi-Fi or a phone hotspot — mobile data can be off.'),
    h('li', h('strong', 'End-to-end encrypted. '), 'Keys are created on this device and never leave it.'),
    h('li', h('strong', 'Nothing in the cloud. '), 'No account, no phone number, no backups. What’s here stays here.')),
  h('button.primary.big', { onclick: () => go('create'), 'data-testid': 'get-started', autofocus: true }, 'Get started'),
  h('button.link', { onclick: () => go('restore'), 'data-testid': 'have-account' }, 'I already have an account'));

VIEWS.create = () => {
  const name = h('input#name', { type: 'text', maxlength: 40, autocomplete: 'off', placeholder: 'e.g. Sam', 'data-testid': 'name', autofocus: true });
  const user = h('input#user', { type: 'text', maxlength: 21, autocomplete: 'username', autocapitalize: 'none', spellcheck: false, placeholder: 'e.g. sam_k', 'data-testid': 'username' });
  const remember = h('input', { type: 'checkbox', checked: true, 'data-testid': 'remember-user' });
  const p1 = h('input#p1', { type: 'password', autocomplete: 'new-password', placeholder: `At least ${MIN_PASSPHRASE} characters`, 'data-testid': 'pass1' });
  const p2 = h('input#p2', { type: 'password', autocomplete: 'new-password', placeholder: 'Type it again', 'data-testid': 'pass2' });
  const meter = h('div.meter', h('span'));
  const meterLabel = h('small.hint', '');
  const err = h('p.error', { role: 'alert' });
  const btn = h('button.primary.big', { type: 'submit', 'data-testid': 'create' }, 'Create my keys');
  p1.addEventListener('input', () => {
    const s = strength(p1.value);
    meter.firstChild.style.width = `${Math.min(100, s.bits)}%`;
    meter.dataset.level = s.label;
    meterLabel.textContent = p1.value ? `Strength: ${s.label}` : '';
  });
  const form = h('form.screen.narrow', {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      const nm = clampName(name.value);
      if (!nm) { err.textContent = 'Pick a display name.'; return; }
      const uProblem = usernameProblem(user.value); if (uProblem) { err.textContent = uProblem; return; }
      if (p1.value.length < MIN_PASSPHRASE) { err.textContent = `Passphrase must be at least ${MIN_PASSPHRASE} characters.`; return; }
      if (p1.value !== p2.value) { err.textContent = 'Passphrases don’t match.'; return; }
      btn.disabled = true; btn.textContent = 'Creating keys…';
      try {
        const v = await Vault.create(SLOTS.a, p1.value);
        await saveLogin(user.value, remember.checked);
        await v.putRecord('profile', { name: nm, username: normalizeUsername(user.value), v: Date.now() });
        await v.putRecord('settings', { autoLockMin: 5 });
        p1.value = p2.value = '';
        S.slot = 'a';
        await openVault(v);
        ensureSlots(store).catch((e) => console.warn('slot setup:', e.message));
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Create my keys'; }
    },
  },
  h('h1', 'Set up this device'),
  h('label', { for: 'name' }, 'Your display name'), name,
  h('small.hint', 'Shown to people you connect with.'),
  h('label', { for: 'user' }, 'Username'), user,
  h('small.hint', 'You’ll type it with your passphrase to unlock. Your contacts see it as @username. It stays on this phone — there is no account server.'),
  h('label.toggle', remember, ' Remember my username on this phone'),
  h('label', { for: 'p1' }, 'Passphrase'), p1, meter, meterLabel,
  h('label', { for: 'p2' }, 'Confirm passphrase'), p2,
  h('div.callout.warn', h('strong', 'There is no “forgot passphrase”. '),
    'Your passphrase encrypts everything on this device and is never stored. Lose it and the data is gone — by design.'),
  err, btn);
  return form;
};

VIEWS.unlock = () => {
  const user = h('input#user', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, 'data-testid': 'unlock-user' });
  const p = h('input#pass', { type: 'password', autocomplete: 'current-password', 'data-testid': 'unlock-pass' });
  const err = h('p.error', { role: 'alert' });
  const btn = h('button.primary.big', { type: 'submit', 'data-testid': 'unlock' }, 'Unlock');
  let login = null;
  store.get(LOGIN_KEY).then((l) => {
    login = l || null;
    if (login?.user && !user.value) { user.value = login.user; p.focus(); } else user.focus();
    userRow.hidden = !login; // accounts from before usernames: passphrase only, then choose one
  }).catch(() => {}).finally(() => { form.dataset.ready = '1'; });
  const userRow = h('div', { hidden: true }, h('label', { for: 'user' }, 'Username'), user);
  let cd = 0;
  const waitText = (ms) => { const s2 = Math.ceil(ms / 1000); return s2 >= 120 ? `${Math.ceil(s2 / 60)} minutes` : `${s2} seconds`; };
  // Repeated wrong tries make you WAIT (it never erases unless you switched that on in Settings).
  const countdown = (ms, lead) => {
    clearInterval(cd); const end = Date.now() + ms;
    const tick = () => {
      const left = end - Date.now();
      if (left <= 0 || !btn.isConnected) { clearInterval(cd); btn.disabled = false; btn.textContent = 'Unlock'; err.textContent = lead; return; }
      btn.disabled = true; btn.textContent = `Try again in ${waitText(left)}`;
      err.textContent = `${lead} Too many wrong tries — wait ${waitText(left)}.`;
    };
    tick(); cd = setInterval(tick, 1000);
  };
  const fail = (ex) => {
    btn.disabled = false; btn.textContent = 'Unlock'; p.value = ''; p.focus();
    if (ex instanceof VaultWipedError) { toast('Too many wrong attempts. Everything was erased (you had switched this on).', 'error', 8000); go('welcome'); return; }
    if (ex instanceof LockedOutError) { countdown(ex.waitMs, ''); return; }
    if (ex instanceof WrongPassphraseError) {
      const lead = Number.isFinite(ex.attemptsLeft) ? `Wrong username or passphrase. ${ex.attemptsLeft} tries left before this device erases itself.` : 'Wrong username or passphrase.';
      if (ex.waitMs) countdown(ex.waitMs, lead); else err.textContent = lead;
    } else err.textContent = ex.message;
  };
  Vault.checkLockout(SLOTS.a).catch((ex) => { if (ex instanceof LockedOutError) countdown(ex.waitMs, ''); }); // still waiting after a reload
  const form = h('form.screen.narrow.center', { 'data-testid': 'unlock-form',
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; btn.disabled = true; btn.textContent = 'Unlocking…';
      try {
        await Vault.checkLockout(SLOTS.a);
        // A wrong username counts exactly like a wrong passphrase.
        if (login && !(await checkLogin(login, user.value))) await Vault.noteFailure(SLOTS.a, () => store.clear());
        // Real passphrase → real chats; duress passcode → the decoy. Nothing on screen says which.
        const { vault: v, slot } = await unlockAny(store, p.value); p.value = '';
        S.slot = slot;
        await openVault(v);
        if (login && S.profile.username !== normalizeUsername(user.value)) await saveProfile({ username: normalizeUsername(user.value) });
        if (!login) chooseUsername().catch(() => {});
      } catch (ex) { fail(ex); }
    },
  },
  h('div.brand', h('div.logo', icon('lock', 40)), h('h1', 'Murmur is locked')),
  updateBanner(),
  userRow,
  h('label', { for: 'pass' }, 'Passphrase'), p, err, btn,
  h('button.link', { type: 'button', onclick: () => go('restore'), 'data-testid': 'restore-here' }, 'Restore or move another account to this phone'),
  h('button.link', { type: 'button', onclick: panicWipe, 'data-testid': 'forgot' }, 'Forgot it? Erase this device and start over'));
  return form;
};

/** Accounts made before usernames existed pick one once. */
async function chooseUsername() {
  for (;;) {
    const inp = h('input', { type: 'text', autocapitalize: 'none', spellcheck: false, placeholder: 'e.g. sam_k', 'data-testid': 'choose-username' });
    const rem = h('input', { type: 'checkbox', checked: true });
    const v = await modal({ title: 'Choose a username',
      body: [h('p', 'From now on you unlock Murmur with your username and passphrase. Contacts see it as @username.'), inp, h('label.toggle', rem, ' Remember it on this phone')],
      actions: [['Save', 'save', 'primary']] });
    if (v !== 'save') continue;
    const problem = usernameProblem(inp.value);
    if (problem) { toast(problem, 'error'); continue; }
    await saveLogin(inp.value, rem.checked);
    await saveProfile({ username: normalizeUsername(inp.value) });
    toast(`You are @${normalizeUsername(inp.value)}`, 'success');
    rerenderIf('settings');
    return;
  }
}

function header(title, { back, actions = [], lead = null, onTitle = null } = {}) {
  return h('header.bar',
    back ? h('button.icon', { onclick: back, 'aria-label': 'Back', 'data-testid': 'back' }, icon('back')) : h('div.logo.sm', icon('shield', 20)),
    onTitle ? h('button.titlebtn', { type: 'button', onclick: onTitle, 'data-testid': 'chat-title' }, lead, h('h1', title)) : [lead, h('h1', title)],
    h('div.actions', actions));
}

VIEWS.home = () => {
  const list = [...S.contacts.values()].sort((a, b) => (isOnline(b.id) - isOnline(a.id)) || displayName(a).localeCompare(displayName(b)));
  return h('div.screen.full',
    header('Murmur', {
      actions: [
        h('button.sos', { onclick: () => go('sos'), 'aria-label': 'Emergency SOS', 'data-testid': 'sos' }, 'SOS'),
        h('button.icon', { onclick: () => go('settings'), 'aria-label': 'Settings', 'data-testid': 'settings' }, icon('gear')),
        h('button.icon', { onclick: () => lock(), 'aria-label': 'Lock', 'data-testid': 'lock' }, icon('lock')),
      ],
    }),
    updateBanner(),
    h('section.pair-actions',
      h('button.tile', { onclick: () => go('invite'), 'data-testid': 'invite' }, icon('qr', 30), h('span', 'Show my code'), h('small', 'Start a new chat')),
      h('button.tile', { onclick: () => go('join'), 'data-testid': 'join' }, icon('scan', 30), h('span', 'Scan a code'), h('small', 'Join a friend’s chat'))),
    h('section.pair-links',
      h('button', { onclick: () => go('linkinvite'), 'data-testid': 'link-invite' }, icon('link', 18), ' Invite by link'),
      h('button', { onclick: () => go('acceptinvite'), 'data-testid': 'open-invite' }, icon('paste', 18), ' Open an invite')),
    h('p.netnote', icon('info', 16), S.remote
      ? ' Nearby: same Wi-Fi or hotspot, no internet needed. Far away: messages go through the encrypted relay and wait up to 30 days.'
      : ' Both phones must be on the same Wi-Fi or hotspot. Internet mode is off (Settings).'),
    list.length
      ? h('ul.contacts', list.map((c) => h('li', h('button.contact', { onclick: () => { S.unread.delete(c.id); go('chat', c.id); }, 'data-testid': `contact-${displayName(c)}` },
        avatar(c, { online: isOnline(c.id) }),
        h('span.cname', displayName(c)),
        h('span.cstate', { 'data-kind': linkState(c.id)[1] }, c.request ? 'wants to chat' : linkState(c.id)[0]),
        S.unread.get(c.id) ? h('span.badge', String(S.unread.get(c.id))) : null))))
      : h('div.empty', h('p', 'No contacts yet.'), h('p', 'Meet up, tap ', h('strong', 'Show my code'), ', and let your friend scan it — or send an ', h('strong', 'invite link'), '.')),
    list.length ? h('section.groups',
      h('div.sectionhead', h('h2', 'Groups'), h('button', { onclick: () => go('newgroup'), 'data-testid': 'new-group' }, icon('users', 16), ' New group')),
      [...S.groups.values()].filter((g) => !g.removed).length
        ? h('ul.contacts', [...S.groups.values()].filter((g) => !g.removed).map((g) => h('li', h('button.contact', { onclick: () => { S.unread.delete(`g:${g.id}`); go('group', g.id); }, 'data-testid': `group-${g.name}` },
          h('span.avatar.group', icon('users', 18)), h('span.cname', g.name), h('span.cstate', `${g.members.length} people`),
          S.unread.get(`g:${g.id}`) ? h('span.badge', String(S.unread.get(`g:${g.id}`))) : null))))
        : h('p.hint', 'No groups yet.')) : null);
};

// ---- invite by link (friends far away) ----
VIEWS.linkinvite = () => {
  const body = h('div.pair');
  const view = h('div.screen.full', header('Invite by link', { back: () => go('home') }), body);
  if (!S.remote) { body.append(h('p.error', 'Internet mode is off. Turn it on in Settings to invite friends who are far away.')); return view; }
  const box = h('textarea.code', { readonly: true, rows: 4, 'data-testid': 'invite-link', 'aria-label': 'Invite link' });
  const exp = h('p.hint');
  body.append(h('div.spinner'));
  S.remote.createInvite(new URL('./', location.href).href).then((inv) => {
    box.value = inv.link;
    exp.textContent = `Works once. Expires ${new Date(inv.expires * 1000).toLocaleString()}.`;
    const copy = async () => { try { await navigator.clipboard.writeText(inv.link); toast('Invite link copied'); } catch { box.select(); toast('Select the link and copy it'); } };
    const share = async () => { try { await navigator.share({ title: 'Murmur invite', text: `${S.profile.name} invites you to chat privately on Murmur. Open this link:`, url: inv.link }); } catch (e) { if (e.name !== 'AbortError') copy(); } };
    clear(body).append(
      h('ol.steps',
        h('li', h('strong', 'Send this link'), ' to your friend — by text, WhatsApp, email…'),
        h('li', 'They open it in Murmur and tap ', h('em', 'Join'), '.'),
        h('li', h('strong', 'Then call them'), ' and compare your safety numbers (contact ⓘ). That proves nobody swapped the link on the way.')),
      box,
      h('div.share',
        navigator.share ? h('button.primary', { onclick: share }, icon('share', 18), ' Share link') : null,
        h('button', { onclick: copy, 'data-testid': 'copy-invite' }, icon('copy', 18), ' Copy link')),
      exp,
      h('p.hint.small', 'Don’t post invite links publicly: anyone who opens it first becomes your contact. If a stranger uses it, you’ll be asked before they can send you links or files.'));
  }).catch((e) => { clear(body).append(h('p.error', e.message)); });
  return view;
};

// ---- open an invite link ----
VIEWS.acceptinvite = (text = '') => {
  const paste = h('textarea.code', { rows: 3, placeholder: 'Paste the invite link', 'data-testid': 'paste-invite', 'aria-label': 'Invite link', value: text });
  const result = h('div');
  const body = h('div.pair');
  const view = h('div.screen.full', header('Open an invite', { back: () => go('home') }), body);
  if (!S.remote) { body.append(h('p.error', 'Internet mode is off. Turn it on in Settings to join friends who are far away.')); return view; }
  const check = async () => {
    clear(result);
    let info;
    try { info = await S.remote.inspectInvite(paste.value); } catch (e) { result.append(h('p.error', e.message)); return; }
    const existing = S.contacts.get(info.cid);
    const look = existing ? [] : lookalikeNames(info.name, [...S.contacts.values()].map(displayName));
    const join = h('button.primary', { 'data-testid': 'join-invite', onclick: async () => {
      join.disabled = true;
      try {
        const cid = await S.remote.acceptInvite(info.inv, { t: 'hello', name: S.profile.name });
        let c = S.contacts.get(cid);
        if (!c) { c = { id: cid, pub: toB64u(info.pub), name: info.name, alias: '', addedAt: Date.now(), keepHistory: true, ttl: 0, remote: true, verified: false, request: false }; S.contacts.set(cid, c); }
        else c.remote = true;
        await persistContacts();
        toast(`Joined ${displayName(c)} 🔒`, 'success');
        go('chat', cid);
      } catch (e) { join.disabled = false; toast(e.message, 'error', 6000); }
    } }, existing ? `Connect with ${displayName(existing)} over the internet` : `Join ${info.name}`);
    result.append(
      h('p.big-instruction', existing ? `${displayName(existing)} (already a contact)` : `${info.name} invites you`),
      look.length ? h('p.warn', icon('alert', 16), ` Careful: this name looks like your contact “${look[0]}”, but it is a DIFFERENT person/key. Only join if you are sure.`) : null,
      h('p.hint', 'After joining, call them and compare safety numbers to be sure the link wasn’t swapped.'),
      join);
  };
  body.append(paste, h('button', { onclick: check, 'data-testid': 'check-invite' }, icon('check', 18), ' Check invite'), result);
  if (text) setTimeout(check, 0);
  return view;
};

// ---- pairing: inviter ----
VIEWS.invite = (expectId = null) => {
  const expect = expectId ? S.contacts.get(expectId) : null;
  const conv = new Conversation({ identity: S.vault.identity, name: S.profile.name });
  const qrBox = h('div.qrbox', h('div.spinner'), h('p.hint', 'Preparing a secure, local connection…'));
  const status = h('p.status', { 'data-testid': 'invite-status' });
  const textCode = h('textarea.code', { readonly: true, rows: 3, 'data-testid': 'invite-code', 'aria-label': 'Invite code as text' });
  const scanArea = h('div.scanarea');
  let done = false;
  const leave = () => { if (!done) conv.close('cancelled'); go(expectId ? 'chat' : 'home', ...(expectId ? [expectId] : [])); };

  const handleReply = async (bytes) => {
    try {
      status.textContent = 'Checking reply and connecting…';
      const expectKey = expect ? fromB64u(expect.pub) : null;
      await conv.acceptReply(bytes, expectKey);
      if (!(await confirmNewIdentity(conv.peer, expectKey))) { conv.close('rejected'); leave(); return; }
      status.textContent = `Connecting to ${conv.peer.name}…`;
      done = true;
      const id = await adoptConversation(conv);
      toast(`Connected to ${displayName(S.contacts.get(id))} 🔒`, 'success');
      go('chat', id);
    } catch (e) {
      status.textContent = '';
      toast(e.message, 'error', 6000);
      if (!(e instanceof PairingError)) { done = true; leave(); }
      return false;
    }
  };

  (async () => {
    try {
      const bytes = await conv.createInvite();
      clear(qrBox).append(qrSvg(encodeQR(toQrText(bytes), { ecl: 'M' }), 'Your invite QR code'));
      textCode.value = toPasteText(bytes);
      status.textContent = 'Waiting for your friend to scan…';
    } catch (e) { clear(qrBox).append(h('p.error', e.message)); }
  })();

  return h('div.screen.full',
    header(expect ? `Reconnect to ${displayName(expect)}` : 'Show my code', { back: leave }),
    h('div.pair',
      h('ol.steps',
        h('li', h('strong', 'Let your friend scan this'), ' with Murmur → ', h('em', 'Scan a code')),
        h('li', h('strong', 'Then scan their reply'), ' below.')),
      qrBox,
      shareRow(textCode),
      h('h2.sub', 'Their reply'),
      codeInput(scanArea, handleReply, 'reply'),
      scanArea,
      status,
      h('p.hint.small', 'Codes expire after 15 minutes and work only once.')));
};

// ---- pairing: joiner ----
VIEWS.join = (expectId = null) => {
  const expect = expectId ? S.contacts.get(expectId) : null;
  const scanArea = h('div.scanarea');
  const result = h('div');
  const status = h('p.status', { 'data-testid': 'join-status' });
  let conv = null;
  const leave = () => { if (conv && conv.state !== 'connected') conv.close('cancelled'); go(expectId ? 'chat' : 'home', ...(expectId ? [expectId] : [])); };

  const handleInvite = async (bytes) => {
    try {
      if (conv && conv.state !== 'connected') conv.close('superseded'); // a previous scan attempt
      conv = new Conversation({ identity: S.vault.identity, name: S.profile.name });
      // Auto-recognise known contacts even when not explicitly reconnecting.
      const expectKey = expect ? fromB64u(expect.pub) : null;
      status.textContent = 'Preparing reply…';
      const { reply, peer } = await conv.joinInvite(bytes, expectKey);
      if (!(await confirmNewIdentity(peer, expectKey))) { conv.close('rejected'); leave(); return; }
      stopScanner();
      const textCode = h('textarea.code', { readonly: true, rows: 3, 'data-testid': 'reply-code', 'aria-label': 'Reply code as text', value: toPasteText(reply) });
      clear(scanArea);
      clear(result).append(
        h('p.big-instruction', `Show this to ${peer.name}`),
        h('div.qrbox', qrSvg(encodeQR(toQrText(reply), { ecl: 'M' }), 'Your reply QR code')),
        shareRow(textCode));
      clear(inputs);
      status.textContent = `Waiting for ${peer.name} to scan…`;
      await conv.connected;
      const id = await adoptConversation(conv);
      toast(`Connected to ${displayName(S.contacts.get(id))} 🔒`, 'success');
      go('chat', id);
    } catch (e) {
      status.textContent = '';
      toast(e.message, 'error', 6000);
      if (conv && conv.state !== 'idle' && !(e instanceof PairingError)) { conv.close('failed'); leave(); }
      return false;
    }
  };
  const inputs = codeInput(scanArea, handleInvite, 'invite', true);
  return h('div.screen.full',
    header(expect ? `Reconnect to ${displayName(expect)}` : 'Scan a code', { back: leave }),
    h('div.pair', inputs, scanArea, result, status));
};

function shareRow(textCode) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(textCode.value); toast('Code copied'); }
    catch { textCode.hidden = false; textCode.select(); toast('Select the text and copy it'); }
  };
  const share = async () => {
    try { await navigator.share({ text: textCode.value }); } catch (e) { if (e.name !== 'AbortError') copy(); }
  };
  textCode.hidden = true;
  return h('div.share',
    h('button', { onclick: copy, 'data-testid': 'copy-code' }, icon('copy', 18), ' Copy code'),
    navigator.share ? h('button', { onclick: share }, icon('share', 18), ' Send nearby') : null,
    h('button.link', { onclick: () => { textCode.hidden = !textCode.hidden; }, 'data-testid': 'show-text' }, 'Show as text'),
    textCode,
    h('small.hint', '“Send nearby” works offline via AirDrop / Quick Share.'));
}

/** Camera / paste / photo inputs for a pairing code. onBytes returns false to keep scanning. */
function codeInput(scanArea, onBytes, what, autostart = false) {
  let handling = false;
  const take = async (text) => {
    if (handling) return true;
    let bytes;
    try { bytes = fromText(text); } catch (e) { toast(e.message, 'error'); return true; }
    handling = true;
    const r = await onBytes(bytes);
    handling = false;
    return r !== false ? false : true;
  };
  const startCam = async () => {
    stopScanner();
    const video = h('video.cam', { 'aria-label': 'Camera preview' });
    clear(scanArea).append(h('div.camwrap', video, h('div.reticle')), h('p.hint', `Point the camera at the ${what} code. Hold the phones about 25–30 cm (a forearm) apart — closer and the camera can't focus. Turn the other screen's brightness up.`));
    S.scanner = new Scanner(video);
    try {
      await S.scanner.start((text) => { take(text).then((keep) => { if (!keep) stopScanner(); }); return true; });
    } catch (e) {
      stopScanner();
      clear(scanArea).append(h('p.error', e.name === 'NotAllowedError' ? 'Camera permission was denied. You can paste the code or pick a photo instead.' : `Camera unavailable: ${e.message}`));
    }
  };
  const paste = h('textarea.code', { rows: 3, placeholder: `Paste the ${what} code (starts with mur1.)`, 'data-testid': `paste-${what}`, 'aria-label': `Paste ${what} code` });
  const photo = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async () => {
    const f = photo.files[0]; photo.value = '';
    if (!f) return;
    const text = await decodeImageFile(f).catch(() => null);
    if (text) take(text); else toast('No Murmur code found in that picture', 'error');
  } });
  const el = h('div.inputs',
    h('div.share',
      h('button.primary', { onclick: startCam, 'data-testid': `scan-${what}` }, icon('scan', 18), ' Scan with camera'),
      h('button', { onclick: () => photo.click() }, icon('image', 18), ' From photo'), photo),
    h('details', h('summary', 'Paste code instead'),
      paste, h('button', { onclick: () => take(paste.value), 'data-testid': `paste-${what}-go` }, icon('paste', 18), ' Use pasted code')));
  if (autostart && navigator.mediaDevices?.getUserMedia) setTimeout(startCam, 0);
  return el;
}

// ---- chat ----
let statusTimer = 0;
function setStatusLine(t) {
  const el = document.getElementById('chatstatus');
  if (!el) return;
  el.textContent = t; el.hidden = !t;
  // Progress ("Sending… 40%") stays until the next update; only one-off notes fade.
  // (It used to vanish after 4 s even mid-transfer, so a slow send looked like a failed one.)
  clearTimeout(statusTimer);
  if (t && !/…/.test(t)) statusTimer = setTimeout(() => { el.hidden = true; }, 4000);
  else if (t) statusTimer = setTimeout(() => { el.hidden = true; }, 120_000); // safety net
}

const RISK_LABEL = { low: 'Looks normal', medium: 'Be careful', high: 'Danger — likely a scam', blocked: 'Blocked' };

/** Links are never one-tap: show the REAL destination and our findings first. */
async function checkLink(seg, cid, dir) {
  const a = seg.analysis; const c = S.contacts.get(cid);
  const locked = dir === 'in' && c?.request;
  const body = [
    h('p.linkhost', { 'data-testid': 'link-host' }, a.unicodeHost || seg.text),
    a.host && a.host !== a.unicodeHost ? h('p.hint', 'Real address: ', h('code', a.host)) : null,
    h(`p.risk.risk-${a.risk}`, { 'data-testid': 'link-risk' }, RISK_LABEL[a.risk]),
    a.reasons.length ? h('ul', a.reasons.map((r) => h('li', r))) : h('p.hint', 'No known tricks found. That doesn’t prove it’s safe — never enter passwords or codes after following a link.'),
    locked ? h('p.warn', 'Accept this contact before opening their links.') : null,
  ];
  const actions = [['Cancel', 'cancel'], ['Copy', 'copy']];
  if (!locked && a.ok && a.risk !== 'blocked') actions.push(a.risk === 'high' ? ['Open anyway', 'open', 'danger'] : ['Open', 'open', 'primary']);
  const v = await modal({ title: 'Check this link', body, actions });
  if (v === 'copy') { try { await navigator.clipboard.writeText(seg.text); toast('Link copied'); } catch {} }
  if (v === 'open') {
    if (a.risk === 'high' && !(await modal({ title: 'Are you sure?', body: [`This link was flagged as dangerous. It goes to ${a.unicodeHost}.`], actions: [['Cancel', false], ['Open', true, 'danger']] }))) return;
    window.open(a.href, '_blank', 'noopener,noreferrer');
  }
}

async function saveFile(m, cid) {
  const c = S.contacts.get(cid); const sf = m.file.safety;
  if (m.dir === 'in' && c?.request) { toast('Accept this contact before saving their files', 'error'); return; }
  if (sf && sf.verdict !== 'ok') {
    const ok = await modal({ title: sf.verdict === 'danger' ? 'Dangerous file' : 'Check this file',
      body: [h('p', h('strong', m.file.name)), h('ul', sf.reasons.map((r) => h('li', r)))],
      actions: [['Cancel', false], [sf.verdict === 'danger' ? 'Save anyway' : 'Save', true, sf.verdict === 'danger' ? 'danger' : 'primary']] });
    if (!ok) return;
  }
  // Phones: <a download> on a blob does nothing useful in an iPhone Home Screen app (and
  // can strand you on a preview with no way back). The system share sheet is the real
  // path there — "Save Image"/"Save Video" go to Photos, "Save to Files" for the rest.
  // It must be called straight from the tap, so the Blob is already in memory (no await).
  const f = m.file.blob && new File([m.file.blob], m.file.name, { type: m.file.blob.type });
  if (f && matchMedia('(pointer:coarse)').matches && navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f] }); return; }
    catch (e) { if (e.name === 'AbortError') return; /* person closed the sheet */ console.warn('share failed, downloading instead:', e.message); }
  }
  const a = h('a', { href: m.file.url, download: m.file.name, hidden: true }); document.body.append(a); a.click(); a.remove();
}

/** Shown as a voice note only when it was sent as one AND its content really is clean audio. */
const isVoice = (m) => m.file?.kind === 'voice' && m.file.url && m.file.playable === 'audio' && m.file.blob;

/** Frees a message's file: stops its voice player if one is playing, then revokes the blob URL. */
function dropFileUrl(m) {
  const u = m.file?.url; if (!u) return;
  PLAYERS.get(u)?.stop(); PLAYERS.delete(u); URL.revokeObjectURL(u);
}

function richText(m, cid) {
  return h('div.text', linkify(m.text).map((seg) => (seg.type === 'text' ? seg.text
    : h(`button.inlink.risk-${seg.analysis.risk}`, { type: 'button', 'data-testid': 'link', onclick: () => checkLink(seg, cid, m.dir) }, seg.text))));
}

// ---- message bubbles (WhatsApp-style) ----
// Photos and videos fill the bubble with the time over the corner; no file name, no size, no
// Save button. Tap → full-screen viewer, which shows what the file really is (JPEG · 199 KB) and
// offers Save / Forward / Reply. Documents get a compact card. Voice notes get the player.
const isVisual = (m) => !!(m.file?.url && (m.file.safety?.inline || m.file.playable === 'video'));

function whoWrote(by, key) {
  if (by === S.myCid) return 'You';
  if (String(key).startsWith('g:')) return memberName(S.groups.get(String(key).slice(2)), by);
  const c = S.contacts.get(by); return c ? displayName(c) : 'Them';
}
const QUOTE_ICON = { photo: 'image', video: 'video', voice: 'mic', file: 'clip', loc: 'pin', sos: 'alert' };
/** The quoted message: who wrote it, an icon for its kind, a preview line, a thumbnail for photos. */
function quoteContent(re, key) {
  const local = findMsg(key, re.id);
  const q = resolveQuote(re, local);
  const text = q.t || kindLabel(q.k, local?.file?.name);
  return [h('span.qbody', h(`strong.qwho${q.by === S.myCid ? '.me' : ''}`, whoWrote(q.by, key)),
    h('span.qtext', QUOTE_ICON[q.k] && !q.gone ? icon(QUOTE_ICON[q.k], 14) : null, ' ', text)),
  local?.file?.url && local.file.safety?.inline && !q.gone ? h('img.qthumb', { src: local.file.url, alt: '' }) : null];
}
/** Scroll to a message and flash it (tap on a quote). */
function jumpTo(key, mid) {
  const el = document.querySelector(`#log [data-mid="${CSS.escape(mid)}"]`);
  if (!el) { toast('The original message isn’t on this phone anymore'); return; }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

function bubble(m, key = S.viewArgs?.[0]) {
  if (m.system) return h('p.sysmsg', { 'data-mid': m.id }, m.text);
  if (m.deleted) return h(`div.msg.${m.dir}.deleted`, { 'data-mid': m.id, 'data-testid': `msg-${m.dir}` },
    h('p.gone', { 'data-testid': 'deleted' }, icon('trash', 14), m.dir === 'out' ? ' You deleted this message' : ' This message was deleted'),
    h('div.meta', fmtTime(m.ts)));
  const cid = m.from || key; // in groups, safety decisions use the actual sender
  const st = m.dir === 'out' ? shownStatus(key, m) : null;
  const meta = (over) => h(`div.meta${over ? '.over' : ''}`, fmtTime(m.ts), m.edited ? h('span.edited', { 'data-testid': 'edited' }, 'edited') : null,
    m.expiresAt ? h('span.ttl', icon('timer', 12), h('span', { 'data-expires': m.expiresAt })) : null,
    m.dir === 'out' ? h('span.status', { title: STATUS_WORD[st] || st, 'data-st': st, 'data-testid': 'status' }, groupStatus(m, key)) : null);
  const body = [];
  if (m.from && m.dir === 'in' && String(key).startsWith('g:')) body.push(h('div.sender', { 'data-testid': 'sender' }, memberName(S.groups.get(String(key).slice(2)), m.from)));
  if (m.fw) body.push(h('div.fwd', { 'data-testid': 'forwarded' }, icon('forward', 13), ` ${forwardLabel(m.fw)}`));
  if (m.re) body.push(h('button.replyq', { type: 'button', 'data-testid': 'quote', 'data-qid': m.re.id, onclick: () => jumpTo(key, m.re.id) }, ...quoteContent(m.re, key)));
  if (m.sos) body.push(sosCard(m));
  if (m.loc) body.push(locCard(m));
  if (m.text != null) body.push(richText(m, cid));
  let overMeta = false;
  if (m.file) {
    const f = m.file, sf = f.safety;
    if (isVisual(m)) {
      const isVid = f.playable === 'video';
      overMeta = !(sf && sf.verdict !== 'ok');
      body.push(h('div.mediawrap',
        h('button.mediabox', { type: 'button', onclick: () => openViewer(m, key), 'data-testid': 'media-open', 'aria-label': isVid ? 'Open video' : 'Open photo' },
          isVid ? [h('video.attach', { src: `${f.url}#t=0.1`, preload: 'metadata', muted: true, playsinline: true, 'data-testid': 'video' }), h('span.playbadge', icon('play', 26))]
            : h('img.attach', { src: f.url, alt: 'Photo' })),
        overMeta ? meta(true) : null));
    } else if (isVoice(m)) {
      // A voice note is a message, not a file: player only — no name, no size, no Save.
      if (!PLAYERS.has(f.url)) PLAYERS.set(f.url, voicePlayer({ blob: f.blob, url: f.url }));
      body.push(PLAYERS.get(f.url));
    } else if (f.url) {
      if (f.playable === 'audio') body.push(h('audio', { controls: true, preload: 'metadata', src: f.url, 'data-testid': 'audio' }));
      const tl = typeLabel(sf?.realType || f.mime, f.name);
      body.push(h('button.doc', { type: 'button', onclick: () => openViewer(m, key), 'data-testid': 'file', 'data-blob': f.url },
        h('span.docbadge', tl), h('span.docmeta', h('strong.docname', f.name), h('small', `${tl} · ${fmtBytes(f.size)}`))));
    } else if (f.stored && !f.missing) body.push(h('p.hint', f.kind === 'voice' ? 'Loading voice message…' : 'Loading…'));
    else body.push(h('p.hint', icon(f.kind === 'voice' ? 'mic' : 'clip', 14), f.kind === 'voice' ? ' Voice message' : ` ${f.name}`));
    if (sf && sf.verdict !== 'ok') body.push(h(`p.filewarn.${sf.verdict}`, { 'data-testid': 'file-warning' }, icon('alert', 14), ` ${sf.reasons[0]}`));
  }
  const media = overMeta && !m.text && !m.loc && !m.sos;
  return h(`div.msg.${m.dir}${media ? '.media' : ''}`, { 'data-mid': m.id, 'data-testid': `msg-${m.dir}` }, ...body, overMeta ? null : meta(false));
}
function groupStatus(m, key) {
  if (!String(key).startsWith('g:') || !m.acks) return STATUS_MARK[shownStatus(key, m)] || '✓';
  const g = S.groups.get(String(key).slice(2)); const n = g ? recipients(g, S.myCid).length : 0;
  if (m.status === 'queued' && !m.acks.length) return STATUS_MARK.queued;
  return m.acks.length && m.acks.length >= n ? '✓✓' : m.acks.length ? `✓ ${m.acks.length}/${n}` : '✓';
}

function appendBubble(m, key) {
  const log = document.getElementById('log');
  if (!log) return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  document.querySelector('#log .empty')?.remove();
  log.append(bubble(m, key)); // key tells the renderer whether this is a group chat (sender names)
  if (nearBottom || m.dir === 'out') log.scrollTop = log.scrollHeight;
  purgeExpired();
}

// ---- sending (chat, reply and forward all go through these) ----
async function sendTextTo(id, text, tags = {}) {
  if (text.length > MAX_TEXT) throw new Error(`Message too long (max ${MAX_TEXT} characters)`);
  const c = S.contacts.get(id); if (!c) throw new Error('Contact not found');
  if (isOnline(id)) {
    const m = await S.convs.get(id).sendText(text, c.ttl, tags);
    addMessage(id, { ...m, dir: 'out', status: 'sent' });
    backstopViaRelay(id, m);
  } else {
    if (!(hasRemote(id) && S.remote.canSend(id))) throw new Error(`${displayName(c)} isn't reachable yet`);
    const m = { t: 'msg', id: newId(), ts: Date.now(), text, ttl: c.ttl | 0, ...msgMeta(tags) };
    addMessage(id, { ...m, dir: 'out', status: 'queued' });
    await S.remote.send(id, m);
  }
}
async function sendFileTo(id, f, kind, tags = {}) {
  const c = S.contacts.get(id); if (!c) throw new Error('Contact not found');
  setStatusLine(`Sending ${kind === 'voice' ? 'voice message' : f.name}…`);
  const extra = { ...(kind ? { kind } : {}), ...msgMeta(tags) };
  const r = await deliverFile(id, f, c.ttl, (s, t) => setStatusLine(`Sending… ${Math.round((s / t) * 100)}%`), extra);
  addMessage(id, await fileMessage({ id: r.meta.id, dir: 'out', ts: r.meta.ts, ttl: r.meta.ttl, status: r.status, ...msgMeta(tags) }, r.meta.name, r.meta.mime, r.bytes, kind));
  setStatusLine('');
}

VIEWS.chat = (id) => {
  const c = S.contacts.get(id);
  if (!c) return VIEWS.home();
  S.unread.delete(id);
  const conv = S.convs.get(id);
  const online = canChat(id);
  const live = isOnline(id);
  const msgs = S.chats.get(id) || [];
  const log = h('div#log.log', { 'aria-live': 'polite', 'data-testid': 'log' },
    msgs.length ? msgs.map((m) => bubble(m, id)) : h('p.empty', online ? 'Say hi. Messages are end-to-end encrypted.' : 'Not connected.'));
  messageActions(log, id);
  let typingSent = false, typingTimer = 0;
  const comp = composer({
    key: id, disabled: !online,
    placeholder: live ? 'Message' : online ? (S.relayOnline ? 'Message (via internet)' : 'Message — sends when you’re online') : hasRemote(id) ? 'Waiting for their first message…' : 'Reconnect to send',
    onText: async (text, tags) => {
      await sendTextTo(id, text, tags);
      if (typingSent) { S.convs.get(id)?.setTyping(false); typingSent = false; }
    },
    onFile: (f, kind, tags) => sendFileTo(id, f, kind, tags),
    onLocation: () => shareLocation(id, () => [id]),
  });
  const input = comp.querySelector('textarea');
  input.addEventListener('input', () => {
    if (!typingSent && input.value) { conv?.setTyping(true); typingSent = true; }
    clearTimeout(typingTimer); typingTimer = setTimeout(() => { if (typingSent) { conv?.setTyping(false); typingSent = false; } }, 2500);
  });

  const ttlSel = h('select', { 'aria-label': 'Disappearing messages', 'data-testid': 'ttl', onchange: async (e) => { c.ttl = +e.target.value; await persistContacts(); toast(c.ttl ? `New messages disappear after ${TTL_OPTIONS.find(([v]) => v === c.ttl)[1]}` : 'Disappearing messages off'); } },
    TTL_OPTIONS.map(([v, l]) => h('option', { value: v, selected: c.ttl === v }, l)));

  const view = h('div.screen.chat',
    header(displayName(c), {
      back: () => go('home'),
      lead: avatar(c, { size: 'sm', online: live }),
      onTitle: () => go('contact', id),
      actions: [h('span.pill', { 'data-online': live, 'data-kind': linkState(id)[1], 'data-testid': 'conn-state' }, linkState(id)[0]),
        ...(online ? [
          callButtons(c).voice ? h('button.icon', { onclick: () => startCall(id, false), 'aria-label': 'Voice call', 'data-testid': 'call-voice' }, icon('phone')) : null,
          callButtons(c).video ? h('button.icon', { onclick: () => startCall(id, true), 'aria-label': 'Video call', 'data-testid': 'call-video' }, icon('video')) : null] : []),
        h('button.icon', { onclick: () => go('contact', id), 'aria-label': 'Contact info', 'data-testid': 'contact-info' }, icon('info'))],
    }),
    c.request ? h('div.banner.warn', { 'data-testid': 'request-banner' },
      h('p', h('strong', `${displayName(c)} joined using your invite link.`), ' Only accept if you sent the link to this person. Until then, their links and files are locked.'),
      c.lookalike ? h('p', icon('alert', 14), ` This name looks like your contact “${c.lookalike[0]}” — but it is a different key.`) : null,
      h('div.share',
        h('button.primary', { 'data-testid': 'accept-request', onclick: async () => { c.request = false; await persistContacts(); syncProfiles([id]); render(); } }, 'Accept'),
        h('button.danger', { onclick: () => deleteContact(id) }, 'Delete'))) : null,
    !c.request && c.remote && !c.verified ? h('div.banner', { 'data-testid': 'verify-banner' },
      h('p', icon('shield', 14), ' Not verified yet. Call them and compare safety numbers to be sure nobody swapped the invite.'),
      h('button', { onclick: () => go('contact', id) }, 'Compare numbers')) : null,
    live || (hasRemote(id) && c.hideNearby) ? null : h(`div.reconnect${hasRemote(id) ? '.compact' : ''}`, { 'data-testid': 'nearby-card' },
      hasRemote(id) ? h('button.icon.small.dismiss', { type: 'button', 'aria-label': 'Hide this', title: 'Hide — it’s also in contact info', 'data-testid': 'nearby-dismiss',
        onclick: async () => { c.hideNearby = true; await persistContacts(); render(); toast('Hidden. Connect nearby any time from contact info (tap their name).'); } }, icon('close', 16)) : null,
      h('p', hasRemote(id) ? 'Together without internet? Connect nearby:' : 'Meet up on the same Wi-Fi or hotspot to reconnect:'),
      h('div.share',
        h('button.primary', { onclick: () => go('invite', id), 'data-testid': 'reconnect-invite' }, icon('qr', 18), ' Show my code'),
        h('button', { onclick: () => go('join', id), 'data-testid': 'reconnect-join' }, icon('scan', 18), ' Scan theirs'))),
    liveBanner(id),
    log,
    h('p#typing.typing', { hidden: !S.typing.get(id) }, `${displayName(c)} is typing…`),
    h('p#chatstatus.chatstatus', { hidden: true }),
    h('div.chattools', h('label.ttlwrap', { title: 'Disappearing messages' }, icon('timer', 16), ttlSel)),
    comp);
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; if (online) input.focus(); });
  confirmReads(id);
  return view;
};

// ================================================================ phase 1: media, voice, location, SOS, groups

// ---- one way to send, whichever path is available ----
/** Sends an app message to one contact: live session if connected, else the relay. → 'sent' | 'queued' */
async function deliver(cid, m) {
  if (isOnline(cid)) {
    await S.convs.get(cid).sendApp(m);
    if (['loc', 'sos', 'gmsg'].includes(m.t)) backstopViaRelay(cid, m); // the ones that get receipts
    return 'sent';
  }
  if (hasRemote(cid) && S.remote.canSend(cid)) { await S.remote.send(cid, m); return S.relayOnline ? 'sent' : 'queued'; }
  throw new Error(`${displayName(S.contacts.get(cid) || { name: 'Contact' })} isn't reachable yet`);
}
async function deliverFile(cid, file, ttl, progress, extra = {}) {
  if (isOnline(cid)) {
    const meta = await S.convs.get(cid).sendFile(file, ttl, progress, extra);
    return { meta, bytes: new Uint8Array(await meta.blob.arrayBuffer()), status: 'sent' };
  }
  if (canChat(cid)) { const r = await sendFileRemote(cid, file, ttl, progress, extra); return { ...r, status: S.relayOnline ? 'sent' : 'queued' }; }
  throw new Error(`${displayName(S.contacts.get(cid) || { name: 'Contact' })} isn't reachable yet`);
}

/** Every received file goes here: routes group files to their group, checks content, acks. */
async function receivedFile(cid, base, name, mime, bytes, extra = {}) {
  let key = cid, from;
  if (extra.gid) {
    if (!isMember(S.groups.get(extra.gid), cid)) return; // not from a member: drop
    key = `g:${extra.gid}`; from = cid;
  }
  addMessage(key, { ...(await fileMessage({ ...base, dir: 'in', ...msgMeta(extra) }, name, mime, bytes, extra.kind)), from });
}

// ---- photos & videos: remove hidden location/camera data before sending ----
// Photos are sent at "standard" quality by default: longest side 1600 px, JPEG. A 12-MP iPhone
// photo (2–4 MB HEIC/JPEG) becomes ~250–450 KB — usually ONE relay message instead of a dozen,
// and re-drawing drops every byte of hidden metadata. "Original quality" stays one tap away.
const PHOTO_MAX_SIDE = 1600, PHOTO_QUALITY = 0.82, PHOTO_KEEP_UNDER = 350 * 1024;

async function redrawAsJpeg(file, maxSide) {
  const bmp = await createImageBitmap(file); // applies the photo's rotation
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); // transparent PNG → white, not black
  g.drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close?.();
  const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', PHOTO_QUALITY));
  if (!blob) throw new Error('could not encode');
  return { file: new File([blob], file.name.replace(/\.[a-z0-9]+$/i, '') + '.jpg', { type: 'image/jpeg' }), w: cv.width, h: cv.height };
}

/** → { file, note, warn?, original?: { file, note, warn? } } — `original` is offered as "Original quality". */
async function prepareOutgoing(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const real = inspectFile(file.name, file.type, bytes).realType;
  const cleanOriginal = () => {
    if (real === 'image/heic') return { file, note: 'Original HEIC can’t be cleaned here — it may contain your location', warn: true };
    if (!/^(image|video)\//.test(real)) return { file, note: null };
    const r = stripMetadata(bytes); // throws MediaError on damaged files: better to refuse than half-clean
    if (!r.stripped) return { file, note: null };
    return { file: new File([r.bytes], file.name, { type: file.type || real }), note: r.removed.length ? 'Removed hidden location & camera info' : null };
  };
  if (/^image\/(jpeg|png|webp|heic)$/.test(real)) {
    try {
      const small = await redrawAsJpeg(file, PHOTO_MAX_SIDE);
      if (real === 'image/heic' || small.file.size < bytes.length * 0.8 || bytes.length > PHOTO_KEEP_UNDER) {
        return { file: small.file, note: 'Removed hidden location & camera info',
          quality: `Standard quality · ${small.w}×${small.h}`, original: real === 'image/heic' ? null : cleanOriginal() };
      }
    } catch { /* browser can't decode it: fall back to byte-level cleaning */ }
  }
  return cleanOriginal();
}

// ---- location ----
function getPosition({ timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('This device has no location service')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { S.myLoc = { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy) }; resolve(S.myLoc); },
      (e) => reject(new Error(e.code === 1 ? 'Location access is off for Murmur (allow it in Settings)' : 'Couldn’t get a GPS fix — go outside or try again')),
      { enableHighAccuracy: true, timeout, maximumAge: 10_000 });
  });
}
const locMessage = (p, extra = {}) => ({ t: 'loc', id: newId(), ts: Date.now(), lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), acc: p.acc, ...extra });

async function shareLocation(key, targets) {
  const choice = await modal({ title: 'Share your location',
    body: [h('p', 'Your GPS position is sent end-to-end encrypted. GPS works without internet; the message travels nearby or through the relay.'),
      h('p.hint', 'Live sharing updates every 30 seconds while Murmur is open, then stops by itself.')],
    actions: [['Cancel', false], ['Send once', 'once', 'primary'], ['Live 15 min', 15], ['Live 1 hour', 60]] });
  if (!choice) return;
  let p; try { setStatusLine('Getting your location…'); p = await getPosition(); } catch (e) { setStatusLine(''); toast(e.message, 'error', 6000); return; } finally { setStatusLine(''); }
  const live = choice !== 'once' ? { lid: newId(), until: Date.now() + choice * 60_000 } : {};
  const m = locMessage(p, { ...live, ...(key.startsWith('g:') ? { gid: key.slice(2) } : {}) });
  await sendToTargets(key, targets, m, { loc: pick(m) });
  if (live.lid) startLiveShare(key, targets, live);
}
const pick = (m) => ({ lat: m.lat, lon: m.lon, acc: m.acc, lid: m.lid, until: m.until });

function startLiveShare(key, targets, { lid, until }) {
  stopLiveShare(key);
  const share = { lid, until, last: Date.now(), watchId: navigator.geolocation.watchPosition(async (pos) => {
    if (Date.now() > until) { stopLiveShare(key); return; }
    if (Date.now() - share.last < 30_000) return;
    share.last = Date.now();
    S.myLoc = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) };
    const m = locMessage(S.myLoc, { lid, until, ...(key.startsWith('g:') ? { gid: key.slice(2) } : {}) });
    updateLiveBubble(key, lid, m);
    for (const cid of targets()) deliver(cid, m).catch(() => {});
  }, () => {}, { enableHighAccuracy: true, maximumAge: 15_000 }) };
  S.liveShares.set(key, share);
  rerenderIf('chat'); rerenderIf('group');
}
function stopLiveShare(key) {
  const s = S.liveShares.get(key); if (!s) return;
  navigator.geolocation?.clearWatch(s.watchId); S.liveShares.delete(key);
  rerenderIf('chat'); rerenderIf('group');
}
function stopAllLiveShares() { for (const k of [...S.liveShares.keys()]) stopLiveShare(k); }
function updateLiveBubble(key, lid, m) {
  const msg = (S.chats.get(key) || []).find((x) => x.loc?.lid === lid);
  if (!msg) return false;
  msg.loc = pick(m); msg.ts = m.ts;
  const el = document.querySelector(`[data-mid="${msg.id}"]`);
  if (el) el.replaceWith(bubble(msg, key));
  return true;
}

function locCard(m) {
  const L = m.loc;
  const rel = h('p.rel', { 'data-testid': 'loc-relative' }, relative(S.myLoc, L) || '');
  const live = L.until && Date.now() < L.until;
  return h('div.loc', { 'data-testid': 'loc-card' },
    h('p.loctitle', icon('pin', 16), h('strong', L.lid ? (live ? ' Live location' : ' Live location (ended)') : ' Location'),
      live ? h('small', ` until ${fmtTime(L.until)}`) : null),
    h('p.coords', formatCoords(L)), rel,
    h('div.share',
      m.dir === 'in' ? h('button', { type: 'button', 'data-testid': 'how-far', onclick: async () => {
        try { rel.textContent = 'Getting your position…'; await getPosition(); rel.textContent = relative(S.myLoc, L); } catch (e) { rel.textContent = e.message; }
      } }, 'How far?') : null,
      h('button', { type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(`${L.lat}, ${L.lon}`); toast('Coordinates copied'); } catch {} } }, 'Copy'),
      h('button', { type: 'button', onclick: async () => {
        const ok = await modal({ title: 'Open in a map app?', body: ['The map company (Apple, Google…) will see this location, and you need internet to load the map. Murmur itself sends nothing.'], actions: [['Cancel', false], ['Open map', true, 'primary']] });
        if (ok) window.open(/iPhone|iPad|Mac/.test(navigator.userAgent) ? mapLinks(L).apple : mapLinks(L).osm, '_blank', 'noopener,noreferrer');
      } }, 'Map')));
}

// ---- SOS ----
function sosCard(m) {
  return h('div.sos-card', { 'data-testid': 'sos-card' }, h('p', h('strong', '🚨 SOS'), ' ', m.sos.text), m.sos.loc ? locCard({ ...m, loc: m.sos.loc }) : h('p.hint', 'No location included'));
}
VIEWS.sos = () => {
  const people = [...S.contacts.values()].filter((c) => !c.request);
  const checks = new Map(people.map((c) => [c.id, h('input', { type: 'checkbox', checked: true, 'data-testid': `sos-to-${displayName(c)}` })]));
  const text = h('textarea', { rows: 3, maxlength: 500, 'data-testid': 'sos-text', 'aria-label': 'SOS message' }, 'I need help. This is an SOS from Murmur.');
  text.value = 'I need help. This is an SOS from Murmur.';
  const withLoc = h('input', { type: 'checkbox', checked: true, 'data-testid': 'sos-loc' });
  const progress = h('span.holdbar');
  const btn = h('button.sosbtn', { type: 'button', 'data-testid': 'sos-send', disabled: !people.length }, progress, h('span', 'Hold to send SOS'));
  let t = 0;
  const cancel = () => { clearTimeout(t); btn.classList.remove('holding'); };
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); btn.classList.add('holding'); t = setTimeout(async () => { btn.classList.remove('holding'); await sendSos(); }, 1500); });
  btn.addEventListener('pointerup', cancel); btn.addEventListener('pointerleave', cancel); btn.addEventListener('pointercancel', cancel);
  const sendSos = async () => {
    const to = people.filter((c) => checks.get(c.id).checked).map((c) => c.id);
    if (!to.length) { toast('Choose at least one person', 'error'); return; }
    let loc = null;
    if (withLoc.checked) { try { setStatusLine('Getting your location…'); loc = await getPosition({ timeout: 8000 }); } catch (e) { toast(`${e.message} — sending without location`, 'error'); } }
    const m = { t: 'sos', id: newId(), ts: Date.now(), text: text.value.trim().slice(0, 500) || 'SOS', ...(loc ? { loc: { lat: +loc.lat.toFixed(6), lon: +loc.lon.toFixed(6), acc: loc.acc } } : {}) };
    const res = { sent: 0, queued: 0, failed: [] };
    for (const cid of to) {
      try { const st = await deliver(cid, m); res[st] += 1; addMessage(cid, { id: m.id, dir: 'out', ts: m.ts, status: st, sos: { text: m.text, loc: m.loc } }); }
      catch { res.failed.push(displayName(S.contacts.get(cid))); }
    }
    toast(`SOS sent to ${res.sent}${res.queued ? `, waiting for internet for ${res.queued}` : ''}${res.failed.length ? ` — couldn’t reach ${res.failed.join(', ')}` : ''}`, res.failed.length ? 'error' : 'success', 10000);
    go('home');
  };
  return h('div.screen.full', header('Emergency SOS', { back: () => go('home') }),
    h('div.settings',
      h('p.warn', { 'data-testid': 'sos-disclaimer' }, icon('alert', 16), h('strong', ' Murmur cannot call emergency services.'), ' In danger, call your local emergency number (112, or 911 in the US). Many phones can also send an emergency SOS by satellite.'),
      h('p', 'This sends an alert — with your GPS position if you allow it — to the people you choose. It goes nearby if they’re close, or through the relay; if there’s no network it waits on your phone and sends the moment you get signal.'),
      h('h2', 'Send to'),
      people.length ? h('ul.picklist', people.map((c) => h('li', h('label', checks.get(c.id), ` ${displayName(c)}`, c.verified ? h('small', ' ✓ verified') : null)))) : h('p.hint', 'Add contacts first.'),
      h('h2', 'Message'), text,
      h('label.checkline', withLoc, ' Include my location'),
      btn));
};

// ---- incoming location / SOS / group messages (live or relay) ----
async function onAppMessage(cid, m) {
  const c = S.contacts.get(cid);
  if (!c) return;
  // Messages that get a delivery receipt must carry a sane id; roster updates (ginv) don't.
  if (['loc', 'sos', 'gmsg'].includes(m.t) && (typeof m.id !== 'string' || !m.id || m.id.length > 32)) return;
  const ack = () => deliver(cid, { t: 'ack', id: m.id }).catch(() => {});
  switch (m.t) {
    case 'loc': {
      if (!validLocation(m)) return;
      let key = cid, from;
      if (m.gid) {
        const g = S.groups.get(m.gid);
        if (!isMember(g, cid) || !(from = groupOrigin(g, cid, m))) return;
        key = `g:${m.gid}`; forwardIfAdmin(g, m, cid);
      }
      const L = { lat: m.lat, lon: m.lon, acc: m.acc, lid: typeof m.lid === 'string' ? m.lid.slice(0, 32) : undefined, until: Number.isFinite(m.until) ? m.until : undefined };
      if (L.lid && updateLiveBubble(key, L.lid, { ...m, ...L })) return;
      addMessage(key, { id: m.id, dir: 'in', ts: +m.ts || Date.now(), loc: L, from, ...msgMeta(m) }); ack();
      break;
    }
    case 'sos': {
      if (c.request) return; // strangers can't trigger alarms
      if (findMsg(cid, m.id)) { ack(); return; } // same SOS arrived twice (nearby + relay backstop): one alarm
      const loc = validLocation(m.loc) ? { lat: m.loc.lat, lon: m.loc.lon, acc: m.loc.acc } : null;
      const text = String(m.text || 'SOS').slice(0, 500);
      addMessage(cid, { id: m.id, dir: 'in', ts: +m.ts || Date.now(), sos: { text, loc } }); ack();
      navigator.vibrate?.([400, 150, 400, 150, 400]);
      const v = await modal({ title: `🚨 SOS from ${displayName(c)}`, body: [h('p.sostext', { 'data-testid': 'sos-alert' }, text),
        loc ? h('p', formatCoords(loc), ' ', relative(S.myLoc, loc) || '') : h('p.hint', 'No location was included.'),
        h('p.hint', 'If they may be in danger, contact local emergency services.')],
        actions: [['Close', false], ['Open chat', true, 'primary']] });
      if (v) go('chat', cid);
      break;
    }
    case 'ginv': {
      if (c.request) return;
      let g;
      try { g = applyInvite(S.groups.get(m.gid), m, cid, S.myCid); } catch (e) { console.warn('group update refused:', e.message); return; }
      const isNew = !S.groups.has(g.id);
      S.groups.set(g.id, g); await persistGroups();
      if (isNew && !g.removed) toast(`${displayName(c)} added you to “${g.name}”`, 'success', 6000);
      if (g.removed && !isNew) toast(`You were removed from “${g.name}”`);
      rerenderIf('home'); rerenderIf('group', () => S.viewArgs[0] === g.id); rerenderIf('groupinfo', () => S.viewArgs[0] === g.id);
      break;
    }
    case 'gmsg': {
      const g = S.groups.get(m.gid);
      if (!isMember(g, cid) || typeof m.text !== 'string' || m.text.length > MAX_TEXT) return;
      const from = groupOrigin(g, cid, m); if (!from) return;
      addMessage(`g:${g.id}`, { id: m.id, dir: 'in', ts: +m.ts || Date.now(), text: m.text, from, ...msgMeta(m) }); ack();
      forwardIfAdmin(g, m, cid);
      break;
    }
    case 'edit': case 'del': applyEditOrDelete(cid, m); break;
    case 'read': {
      // Reciprocal: with receipts off for this contact we don't show theirs either.
      if (!receiptsOn(S.settings, c)) return;
      for (const mid of readIds(m)) { ACKED.add(`${cid}:${mid}`); setMsgStatus(cid, mid, 'read'); }
      break;
    }
    case 'profile': await onProfile(cid, m); break;
    case 'call': onCallSignal(cid, m); break;
    case 'gleave': {
      const g = S.groups.get(m.gid);
      if (!isMember(g, cid)) return;
      if (g.admin === S.myCid) await updateRoster(withoutMember(g, cid), [cid]);
      else { g.members = g.members.filter((x) => x.cid !== cid); await persistGroups(); }
      addMessage(`g:${g.id}`, { id: m.id, dir: 'in', ts: Date.now(), text: `${memberName(g, cid)} left the group`, system: true });
      break;
    }
    default: break;
  }
}

// ---- profile: photo, username, call permissions (see core/profile.js) ----
/** Round avatar: their photo (only real JPEGs ever get here), else their initial. */
// Images only ever come from in-memory blob: URLs (the DOM helper refuses anything else).
const PIC_URLS = new Map(); // b64 → blob URL, so re-renders don't create new ones
function picUrl(b64) {
  if (!b64) return null;
  let u = PIC_URLS.get(b64);
  if (!u) {
    if (PIC_URLS.size > 200) { for (const x of PIC_URLS.values()) URL.revokeObjectURL(x); PIC_URLS.clear(); }
    u = URL.createObjectURL(new Blob([fromB64u(b64)], { type: 'image/jpeg' })); PIC_URLS.set(b64, u);
  }
  return u;
}
function avatar(c, { size = 'md', online } = {}) {
  const pic = c && !c.request && c.pic;
  return h(`span.avatar.${size}`, { 'data-online': online, 'data-testid': 'avatar' },
    pic ? h('img', { src: picUrl(pic), alt: '' }) : displayName(c || {}).slice(0, 1).toUpperCase());
}
const myPicUrl = () => picUrl(S.profile.pic);

/** Any change to what contacts should know about me. */
async function saveProfile(patch = {}) {
  Object.assign(S.profile, patch, { v: Math.max(Date.now(), (S.profile.v || 0) + 1) });
  await S.vault.putRecord('profile', S.profile);
  syncProfiles();
}
/** Tell contacts (each their own version) whatever changed since they last heard. */
let syncing = Promise.resolve();
function syncProfiles(only) {
  syncing = syncing.then(async () => {
    if (!S.vault) return;
    let dirty = false;
    for (const c of S.contacts.values()) {
      if (only && !only.includes(c.id)) continue;
      if (c.request || !canChat(c.id)) continue; // strangers don't get my photo; unreachable ones get it later
      const msg = profileFor(S.profile, S.settings, c);
      const sig = JSON.stringify(msg);
      if (c.profileSent === sig) continue;
      try { await deliver(c.id, msg); c.profileSent = sig; dirty = true; } catch { /* retried on next connect */ }
    }
    if (dirty) await persistContacts();
  }).catch((e) => console.warn('profile sync:', e.message));
  return syncing;
}
async function onProfile(cid, m) {
  const c = S.contacts.get(cid); const p = readProfile(m);
  if (!c || !p || p.v < (c.profileV || 0)) return;
  Object.assign(c, { name: p.name, username: p.user, pic: p.pic, calls: p.calls, profileV: p.v });
  await persistContacts();
  rerenderIf('home'); rerenderIf('chat', () => S.viewArgs[0] === cid); rerenderIf('contact', () => S.viewArgs[0] === cid);
}
/** Square-crop and shrink a picked photo to a ≤36 KB JPEG (drops all metadata). */
async function makeProfilePic(file) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height), N = 256;
  const cv = document.createElement('canvas'); cv.width = cv.height = N;
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, N, N);
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, N, N); bmp.close?.();
  for (const q of [0.8, 0.65, 0.5, 0.35]) {
    const b = await new Promise((res) => cv.toBlob(res, 'image/jpeg', q));
    if (b && b.size <= MAX_PIC) return toB64u(new Uint8Array(await b.arrayBuffer()));
  }
  throw new Error('Couldn’t make that photo small enough');
}
/** Username on the lock screen: checked against the shared salted hash (both vault slots). */
async function saveLogin(username, remember) {
  await store.put(LOGIN_KEY, await makeLogin(username, remember));
}

// ---- voice & video calls (engine: core/call.js) ----
// One call at a time. Signals ride the normal encrypted channel (deliver()). Incoming calls
// ring only while Murmur is open on that phone — a web app can't wake a locked phone.
let ICE_CACHE = null;
async function iceConfig(cid) {
  const nearby = isOnline(cid);
  let servers = { iceServers: [], turn: false };
  if (S.remote && navigator.onLine !== false) {
    if (ICE_CACHE && ICE_CACHE.until > Date.now()) servers = ICE_CACHE;
    else {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
        const j = await (await fetch(`${RELAY_URL}/v1/turn`, { signal: ctl.signal, cache: 'no-store' })).json();
        clearTimeout(t);
        if (Array.isArray(j.iceServers)) servers = ICE_CACHE = { iceServers: j.iceServers, turn: !!j.turn, until: Date.now() + 45 * 60_000 };
      } catch { /* offline or relay unreachable: nearby/direct only */ }
    }
  }
  const hide = S.settings.calls?.hideIp !== false;
  // Nearby (same Wi-Fi/hotspot) is always direct — there may be no internet to relay through.
  return { iceServers: servers.iceServers, relayOnly: hide && servers.turn && !nearby, cantHide: hide && !servers.turn && !nearby };
}
/** "Hide my IP" is on but no relay is available: never fall back to direct silently. */
async function okToGoDirect(ice) {
  if (!ice.cantHide) return true;
  return (await modal({ title: 'Your IP address can’t be hidden right now',
    body: ['The call relay isn’t available, so this call would connect directly — the other person’s phone could learn your IP address (roughly where you are, and your internet provider).',
      'The call itself is still end-to-end encrypted.'],
    actions: [['Cancel', false], ['Call anyway', true, 'primary']] })) === true;
}

const callMsg = (cid, text) => addMessage(cid, { id: newId(), dir: 'in', ts: Date.now(), text, system: true });
function callLogText(call, { reason, duration }) {
  const what = call.video ? 'Video call' : 'Voice call';
  if (duration) return `${call.outgoing ? '↗' : '↙'} ${what} · ${formatDuration(duration)}`;
  return {
    'no answer': `↗ ${what} — no answer`, cancelled: `↗ ${what} — cancelled`, missed: `↙ Missed ${what.toLowerCase()}`,
    declined: call.outgoing ? `↗ ${what} — declined` : `↙ ${what} — declined`, busy: `↗ ${what} — they were on another call`,
    unavailable: `↗ ${what} — they don’t accept ${call.video ? 'video' : 'voice'} calls from you`, 'no permission': `${what} — microphone/camera access is off`,
    'could not connect': `${what} — couldn’t connect`, locked: `${what} — ended (Murmur locked)`,
  }[reason] || `${what} — ${reason}`;
}

async function startCall(cid, video) {
  const c = S.contacts.get(cid);
  if (S.call) { toast('You’re already in a call', 'error'); return; }
  if (!c || !canChat(cid)) { toast('Not reachable right now', 'error'); return; }
  if (!callButtons(c)[video ? 'video' : 'voice']) { toast(`${displayName(c)} doesn’t accept ${video ? 'video' : 'voice'} calls`, 'error'); return; }
  const ice = await iceConfig(cid);
  if (!(await okToGoDirect(ice))) return;
  const call = new Call({ id: newId(), peer: cid, outgoing: true, video, ice, send: (sig) => deliver(cid, sig) });
  showCall(call);
  call.start();
}

function onCallSignal(cid, m) {
  const sig = readSignal(m); if (!sig) return;
  const c = S.contacts.get(cid);
  if (sig.k !== 'offer') { if (S.call?.id === sig.id && S.call.peer === cid) S.call.onSignal(sig); return; }
  // Both called each other at the same moment: the one with the smaller id keeps its call.
  if (S.call && S.call.peer === cid && S.call.outgoing && S.call.state === 'calling') {
    if (S.myCid < cid) return; // ours wins; theirs will be dropped by them
    S.call.yielded = true; S.call.hangup();
  }
  const verdict = callDecision({ settings: S.settings, contact: c, video: sig.video, busy: !!S.call });
  if (verdict !== 'ring') {
    deliver(cid, { t: 'call', id: sig.id, k: verdict }).catch(() => {});
    if (verdict === 'busy' && c) callMsg(cid, `↙ Missed ${sig.video ? 'video' : 'voice'} call (you were on another call)`);
    return;
  }
  const call = new Call({ id: sig.id, peer: cid, outgoing: false, video: sig.video, send: (s2) => deliver(cid, s2) });
  call.offer = sig.sdp;
  showCall(call);
}

// --- ringing sound (Web Audio; unlocked by the first tap, as phones require) ---
let AUDIO = null;
addEventListener('pointerdown', () => { try { AUDIO ||= new AudioContext(); AUDIO.resume?.(); } catch { /* no audio */ } }, { passive: true });
function ring(outgoing) {
  if (!AUDIO) return () => {};
  let stop = false; const notes = outgoing ? [[440, 0.4, 2.6]] : [[880, 0.25, 0.15], [660, 0.25, 1.6]];
  const play = () => {
    if (stop) return; let t = AUDIO.currentTime; let total = 0;
    for (const [f, d, gap] of notes) {
      const o = AUDIO.createOscillator(), g = AUDIO.createGain();
      o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(outgoing ? 0.05 : 0.2, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(AUDIO.destination); o.start(t); o.stop(t + d); t += d + gap; total += d + gap;
    }
    if (!outgoing) navigator.vibrate?.([300, 200, 300]);
    timer = setTimeout(play, total * 1000);
  };
  let timer = 0; play();
  return () => { stop = true; clearTimeout(timer); };
}

function endCall(reason) { S.call?.hangup?.(reason); }

/** The full-screen call UI. Lives outside the view tree, so moving around the app doesn't end the call. */
function showCall(call) {
  S.call = call;
  const c = S.contacts.get(call.peer);
  const remoteV = h('video.remote', { autoplay: true, playsinline: true, 'data-testid': 'call-remote' });
  const localV = h('video.local', { autoplay: true, playsinline: true, muted: true, 'data-testid': 'call-local' });
  localV.muted = true; // muted must be a property for autoplay rules
  const status = h('p.callstatus', { 'data-testid': 'call-status' });
  const timer = h('p.calltimer', { 'data-testid': 'call-timer' });
  const btn = (name, label, testid, onclick, cls = '') => h(`button.callbtn${cls}`, { type: 'button', 'aria-label': label, 'data-testid': testid, onclick }, icon(name, 26), h('span', label));
  const mute = btn('mic', 'Mute', 'call-mute', () => call.setMuted(!call.muted));
  const cam = call.video ? btn('video', 'Camera', 'call-camera', () => call.setCameraOff(!call.cameraOff)) : null;
  const flip = call.video ? btn('flip', 'Flip', 'call-flip', () => call.flipCamera().catch((e) => toast(e.message, 'error'))) : null;
  const hang = btn('hangup', 'End', 'call-end', () => call.hangup(), '.end');
  const accept = btn(call.video ? 'video' : 'phone', 'Accept', 'call-accept', async () => {
    stopRing();
    const ice = await iceConfig(call.peer); // the answering phone hides its IP too
    if (!(await okToGoDirect(ice))) { call.decline(); return; }
    call.ice = ice; call.accept(call.offer); render2();
  }, '.accept');
  const decline = btn('hangup', 'Decline', 'call-decline', () => call.decline(), '.end');
  const controls = h('div.callcontrols');
  const el = h('div.callscreen', { role: 'dialog', 'aria-label': 'Call', 'data-testid': 'call-screen', 'data-video': call.video },
    remoteV,
    h('div.callwho', avatar(c, { size: 'xl' }), h('h2', displayName(c || {})), status, timer),
    localV, controls);
  let stopRing = ring(call.outgoing);
  const label = { calling: 'Calling…', ringing: call.video ? 'Incoming video call' : 'Incoming voice call', connecting: 'Connecting…', reconnecting: 'Reconnecting…', connected: '' };
  const render2 = () => {
    el.dataset.state = call.state;
    status.textContent = label[call.state] ?? '';
    mute.classList.toggle('on', call.muted); mute.setAttribute('aria-pressed', call.muted); mute.firstChild.replaceWith(icon(call.muted ? 'micoff' : 'mic', 26));
    if (cam) { cam.classList.toggle('on', call.cameraOff); cam.setAttribute('aria-pressed', call.cameraOff); cam.firstChild.replaceWith(icon(call.cameraOff ? 'videooff' : 'video', 26)); }
    clear(controls).append(...(call.state === 'ringing' ? [decline, accept] : [mute, cam, flip, hang].filter(Boolean)));
  };
  const tick = setInterval(() => {
    if (call.connectedAt) timer.textContent = formatDuration(Date.now() - call.connectedAt);
    S.lastActivity = Date.now(); // a call is activity: don't auto-lock mid-call
  }, 1000);
  call.on('state', (st) => { if (st !== 'calling' && st !== 'ringing') stopRing(); render2(); })
    .on('controls', render2)
    .on('local', (st) => { localV.srcObject = st; localV.hidden = !call.video; })
    .on('remote', (st) => { if (remoteV.srcObject !== st) remoteV.srcObject = st; remoteV.play?.().catch(() => {}); })
    .on('end', (info) => {
      stopRing(); clearInterval(tick); el.remove();
      if (S.call === call) S.call = null;
      if (!call.yielded && S.vault && S.contacts.has(call.peer)) callMsg(call.peer, callLogText(call, info));
      if (['no permission', 'could not connect', 'connection lost'].includes(info.reason)) toast(callLogText(call, info), 'error', 6000);
    });
  localV.hidden = true;
  render2();
  document.body.append(el);
}

// ---- edit & delete ----
// Your own messages can be edited for 15 minutes and deleted for everyone for 1 hour.
// "Delete for me" works on anything, any time. Receivers enforce the same rules: only the
// AUTHOR can change a message (checked against who actually sent it, also in groups), only
// text can be edited, and only inside the window (with 5 min of clock-skew grace).
const canDeleteAll = (m) => canDeleteForEveryone(m);

function findMsg(key, mid) { return (S.chats.get(key) || []).find((x) => x.id === mid); }
function redrawBubble(key, m) {
  const el = document.querySelector(`#log [data-mid="${CSS.escape(m.id)}"]`);
  if (el && isOpenChat(key)) el.replaceWith(bubble(m, key));
  persistHistory(key).catch(() => {});
}
function wipeContent(m) {
  dropFileUrl(m);
  for (const k of ['text', 'file', 'loc', 'sos']) delete m[k];
  m.deleted = true; delete m.edited;
}

/** Long-press (phones) or right-click (computers) on a bubble opens its actions. */
function messageActions(log, key) {
  let timer = 0, sx = 0, sy = 0;
  // Swipe a bubble to the right to reply (touch), like WhatsApp. Bubbles are touch-action: pan-y,
  // so vertical scrolling still belongs to the browser and a sideways drag reaches us.
  let sw = null, eatClick = false;
  const NO_SWIPE = '.vwave, .vspeed, .vplay, audio, video[controls], input, textarea, a';
  log.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest(NO_SWIPE)) return;
    const el = e.target.closest('.msg[data-mid]'); if (!el) return;
    sw = { el, x: e.clientX, y: e.clientY, id: e.pointerId, dx: 0, on: false, buzz: false };
  });
  log.addEventListener('pointermove', (e) => {
    if (!sw || e.pointerId !== sw.id) return;
    const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
    if (!sw.on) {
      if (Math.abs(dy) > 14) { sw = null; return; }
      if (dx > 14 && dx > Math.abs(dy) * 1.5) { sw.on = true; clearTimeout(timer); sw.el.classList.add('swiping'); } else return;
    }
    sw.dx = Math.max(0, Math.min(96, dx));
    sw.el.style.transform = `translateX(${sw.dx}px)`;
    sw.el.dataset.armed = sw.dx >= 64 ? '1' : '';
    if (sw.dx >= 64 && !sw.buzz) { sw.buzz = true; navigator.vibrate?.(10); }
  });
  const endSwipe = (e) => {
    if (!sw || e.pointerId !== sw.id) return;
    const { el, on, dx } = sw; sw = null;
    if (!on) return;
    el.style.transform = ''; el.classList.remove('swiping'); delete el.dataset.armed;
    eatClick = true; setTimeout(() => { eatClick = false; }, 400); // the lift after a drag isn't a tap
    const m = findMsg(key, el.dataset.mid);
    if (e.type === 'pointerup' && dx >= 64 && m) setReply(key, m);
  };
  log.addEventListener('pointerup', endSwipe); log.addEventListener('pointercancel', endSwipe);
  log.addEventListener('click', (e) => { if (eatClick) { e.stopPropagation(); e.preventDefault(); eatClick = false; } }, true);
  const open = (target) => {
    const el = target.closest?.('[data-mid]'); if (!el) return;
    const m = findMsg(key, el.dataset.mid); if (!m || m.system) return;
    navigator.vibrate?.(15);
    messageMenu(key, m);
  };
  log.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-mid]')) { e.preventDefault(); open(e.target); } });
  log.addEventListener('pointerdown', (e) => {
    // Photos, documents and quotes are buttons (tap opens them) but still part of the message:
    // a long-press on them opens the menu too. Real controls (play, links, players) don't.
    if (e.pointerType === 'mouse' || e.target.closest('button:not(.mediabox):not(.doc):not(.replyq), a, audio, video[controls], input')) return;
    sx = e.clientX; sy = e.clientY; clearTimeout(timer);
    timer = setTimeout(() => open(e.target), 500);
  });
  for (const ev of ['pointerup', 'pointercancel', 'scroll']) log.addEventListener(ev, () => clearTimeout(timer), { passive: true });
  log.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clearTimeout(timer); }, { passive: true });
}

async function messageMenu(key, m) {
  const left = (ms) => { const min = minutesLeft(m, ms); return min > 1 ? `${min} min left` : 'less than a minute left'; };
  const actions = [['Cancel', false]];
  if (canReply(m)) actions.push(['Reply', 'reply']);
  if (canForward(m)) actions.push(['Forward', 'forward']);
  if (m.text != null && !m.deleted) actions.push(['Copy', 'copy']);
  if (canEdit(m)) actions.push([`Edit (${left(EDIT_WINDOW)})`, 'edit']);
  actions.push(['Delete for me', 'me']);
  if (canDeleteAll(m)) actions.push([`Delete for everyone (${left(DELETE_WINDOW)})`, 'all', 'danger']);
  const choice = await modal({ title: m.dir === 'out' ? 'Your message' : 'Message',
    body: [m.text != null ? h('p.quote', m.text.length > 200 ? `${m.text.slice(0, 200)}…` : m.text) : h('p.hint', m.deleted ? 'Deleted message' : m.file ? m.file.name : m.loc ? 'Location' : 'Message'),
      m.dir === 'out' && !canDeleteAll(m) && !m.deleted ? h('p.hint', 'Too late to delete this for everyone (1-hour limit) — you can still remove it from this phone.') : null].filter(Boolean),
    actions });
  try {
    if (choice === 'reply') setReply(key, m);
    else if (choice === 'forward') await forwardMessage(key, m);
    else if (choice === 'copy') { await navigator.clipboard.writeText(m.text); toast('Copied'); }
    else if (choice === 'edit') await editMessage(key, m);
    else if (choice === 'me') deleteForMe(key, m);
    else if (choice === 'all') await deleteForEveryone(key, m);
  } catch (e) { toast(e.message, 'error'); }
}

// ---- reply ----
const canReply = (m) => !!(m && !m.deleted && !m.system && m.id);
/** Put a quote of `m` above the composer of chat `key`. */
function setReply(key, m) {
  if (!canReply(m)) return;
  S.replyTo.set(key, quoteOf(m, S.myCid, key));
  refreshReplyBar(key);
  document.getElementById('compose')?.focus();
}
function replyBar(key) {
  const re = S.replyTo.get(key);
  return h('div#replybar.replybar', { hidden: !re, 'data-testid': 'reply-bar' }, re ? [
    h('div.replyq', ...quoteContent(re, key)),
    h('button.icon.small', { type: 'button', 'aria-label': 'Cancel reply', 'data-testid': 'reply-cancel', onclick: () => { S.replyTo.delete(key); refreshReplyBar(key); } }, icon('close', 18))] : []);
}
function refreshReplyBar(key) { if (isOpenChat(key)) document.getElementById('replybar')?.replaceWith(replyBar(key)); }
/** The composer's pending reply as message tags, removed from the composer. */
function takeReply(key) {
  const re = S.replyTo.get(key); if (!re) return {};
  S.replyTo.delete(key); refreshReplyBar(key);
  return { re };
}

// ---- forward ----
// Up to 5 chats at once (WhatsApp's limit — a brake on chain-message spam). The copy is sent
// fresh to each chat, encrypted for each recipient like any new message, and tagged "Forwarded"
// (≥ 5 hops: "Forwarded many times"). It never carries who it originally came from.
const FORWARD_MAX = 5;
const canForward = (m) => !!(m && !m.deleted && !m.system && !m.sos && (m.text != null || m.loc || m.file));
const fileOf = (m) => new File([m.file.blob], m.file.name, { type: m.file.blob.type || m.file.mime });
async function forwardMessage(key, m) {
  if (!canForward(m)) return;
  if (m.file && !m.file.blob) { toast('This file is still loading — try again in a moment', 'error'); return; }
  const targets = [
    ...[...S.contacts.values()].filter((c) => !c.request && canChat(c.id)).map((c) => ({ key: c.id, name: displayName(c), sub: '' })),
    ...[...S.groups.values()].filter((g) => !g.removed).map((g) => ({ key: `g:${g.id}`, name: g.name, sub: `${g.members.length} people` })),
  ].sort((x, y) => x.name.localeCompare(y.name));
  if (!targets.length) { toast('No chats you can send to right now', 'error'); return; }
  const picked = new Set();
  const count = h('p.hint', `Choose up to ${FORWARD_MAX} chats.`);
  const boxes = [];
  const list = h('ul.picklist.fwdlist', { 'data-testid': 'forward-list' }, targets.map((t) => {
    const cb = h('input', { type: 'checkbox', 'data-testid': `fwd-${t.name}`, onchange: (e) => {
      if (e.target.checked) picked.add(t.key); else picked.delete(t.key);
      for (const b of boxes) b.disabled = !b.checked && picked.size >= FORWARD_MAX;
      count.textContent = picked.size ? `${picked.size} of ${FORWARD_MAX} selected` : `Choose up to ${FORWARD_MAX} chats.`;
    } });
    boxes.push(cb);
    return h('li', h('label.toggle', cb, ' ', t.name, t.sub ? h('small', ` · ${t.sub}`) : null));
  }));
  const v = await modal({ title: 'Forward to…', body: [list, count], actions: [['Cancel', false], ['Send', 'send', 'primary']] });
  if (v !== 'send' || !picked.size) return;
  const ok = [], failed = [];
  for (const t of targets.filter((x) => picked.has(x.key))) {
    try { await forwardTo(t.key, m); ok.push(t.name); } catch (e) { failed.push(t.name); console.warn('forward:', e.message); }
  }
  setStatusLine('');
  if (ok.length) toast(`Forwarded to ${ok.join(', ')}`, 'success');
  if (failed.length) toast(`Couldn’t forward to ${failed.join(', ')}`, 'error');
}
async function forwardTo(target, m) {
  const tags = { fw: forwardHops(m) };
  const g = target.startsWith('g:') ? S.groups.get(target.slice(2)) : null;
  if (m.text != null) return g ? sendGroupText(g, m.text, tags) : sendTextTo(target, m.text, tags);
  if (m.file) return g ? groupFile(g, fileOf(m), m.file.kind, tags) : sendFileTo(target, fileOf(m), m.file.kind, tags);
  if (m.loc) {
    // A forwarded live location is a snapshot: only its owner can keep it updating.
    const lm = locMessage(m.loc, { ...tags, ...(g ? { gid: g.id } : {}) });
    const to = g ? () => recipients(g, S.myCid).filter((c) => S.contacts.has(c)) : () => [target];
    return sendToTargets(target, to, lm, { loc: pick(lm), fw: tags.fw });
  }
}

/** Send to whoever got the original: the contact, or every group member. */
async function sendChange(key, change) {
  if (key.startsWith('g:')) {
    const g = S.groups.get(key.slice(2)); if (!g) throw new Error('Group not found');
    const r = await fanOut(g, { ...change, gid: g.id });
    if (r.failed.length) toast(`Couldn’t reach ${r.failed.join(', ')} yet`, 'error');
  } else await deliver(key, change);
}

async function editMessage(key, m) {
  const ta = h('textarea.edit', { rows: 3, maxlength: MAX_TEXT, 'data-testid': 'edit-text' }, m.text);
  const v = await modal({ title: 'Edit message', body: [ta, h('p.hint', 'Everyone sees it marked “edited”.')], actions: [['Cancel', false], ['Save', 'save', 'primary']] });
  const text = ta.value.trim();
  if (v !== 'save' || !text || text === m.text) return;
  if (!canEdit(m)) throw new Error('The 15-minute edit window has passed');
  await sendChange(key, { t: 'edit', ref: m.id, text, ts: Date.now() });
  m.text = text; m.edited = true; redrawBubble(key, m);
}
function deleteForMe(key, m) {
  const list = S.chats.get(key) || [];
  const i = list.indexOf(m); if (i >= 0) list.splice(i, 1);
  dropFileUrl(m);
  document.querySelector(`#log [data-mid="${CSS.escape(m.id)}"]`)?.remove();
  persistHistory(key).catch(() => {});
}
async function deleteForEveryone(key, m) {
  if (!canDeleteAll(m)) throw new Error('The 1-hour window has passed');
  const ok = await modal({ title: 'Delete for everyone?', body: ['It disappears from their phone too. They’ll see “This message was deleted”.'], actions: [['Cancel', false], ['Delete', true, 'danger']] });
  if (!ok) return;
  await sendChange(key, { t: 'del', ref: m.id, ts: Date.now() });
  wipeContent(m); redrawBubble(key, m);
}

/** Incoming edit/delete: only the author, only inside the window. */
function applyEditOrDelete(cid, m) {
  if (typeof m.ref !== 'string' || !m.ref || m.ref.length > 32) return;
  let key = cid, author = cid;
  if (m.gid) {
    const g = S.groups.get(m.gid);
    if (!isMember(g, cid) || !(author = groupOrigin(g, cid, m))) return;
    key = `g:${m.gid}`; forwardIfAdmin(g, m, cid);
  }
  const t = findMsg(key, m.ref);
  const verdict = acceptChange(t, m, author, key.startsWith('g:'));
  if (verdict === 'edit') { t.text = m.text; t.edited = true; }
  else if (verdict === 'del') wipeContent(t);
  else return;
  redrawBubble(key, t);
}

// ---- groups ----
// Members who aren't each other's contacts can't send to each other directly, so the
// group's creator forwards every member message to everyone else (marked `fwd`).
// Only the creator may forward, only for real members, and forwarded copies are never
// forwarded again. Recipients see the original author's name with "(via group)" when
// they don't have that person as a verified contact themselves.
function groupOrigin(g, cid, m) {
  if (!m.fwd) return cid;
  if (cid !== g.admin || typeof m.fwd !== 'string' || !isMember(g, m.fwd) || m.fwd === S.myCid) return null;
  return m.fwd;
}
function forwardIfAdmin(g, m, cid) {
  if (m.fwd || g.admin !== S.myCid) return;
  for (const r of recipients(g, S.myCid)) if (r !== cid && S.contacts.has(r)) deliver(r, { ...m, fwd: cid }).catch(() => {});
}
const persistGroups = () => S.vault.putRecord('groups', [...S.groups.values()]);
function memberName(g, cid) {
  if (cid === S.myCid) return 'You';
  const c = S.contacts.get(cid);
  return c ? displayName(c) : `${g?.members.find((m) => m.cid === cid)?.name || 'Someone'} (via group)`;
}
/** Send to every member except me; returns {sent, queued, failed[]}. */
async function fanOut(g, m) {
  const res = { sent: 0, queued: 0, failed: [] };
  await Promise.all(recipients(g, S.myCid).map(async (cid) => {
    if (!S.contacts.has(cid)) { res.failed.push(memberName(g, cid)); return; }
    try { res[await deliver(cid, m)] += 1; } catch { res.failed.push(memberName(g, cid)); }
  }));
  return res;
}
async function updateRoster(g, alsoTell = []) {
  S.groups.set(g.id, g); await persistGroups();
  const msg = inviteMessage(g);
  for (const cid of new Set([...recipients(g, S.myCid), ...alsoTell])) if (S.contacts.has(cid)) deliver(cid, msg).catch(() => {});
  rerenderIf('group', () => S.viewArgs[0] === g.id); rerenderIf('groupinfo', () => S.viewArgs[0] === g.id); rerenderIf('home');
}
function groupAck(cid, mid) {
  for (const [key, msgs] of S.chats) {
    if (!key.startsWith('g:')) continue;
    const m = msgs.find((x) => x.id === mid && x.dir === 'out');
    if (!m) continue;
    m.acks = [...new Set([...(m.acks || []), cid])];
    const g = S.groups.get(key.slice(2)); const n = g ? recipients(g, S.myCid).length : m.acks.length;
    m.status = m.acks.length >= n ? 'delivered' : 'sent';
    const el = document.querySelector(`[data-mid="${mid}"] .status`);
    if (el) el.textContent = m.acks.length >= n ? '✓✓' : `✓ ${m.acks.length}/${n}`;
    return;
  }
}

VIEWS.newgroup = () => {
  const people = [...S.contacts.values()].filter((c) => !c.request);
  const name = h('input', { placeholder: 'Group name', maxlength: 48, 'data-testid': 'group-name', 'aria-label': 'Group name' });
  const checks = new Map(people.map((c) => [c.id, h('input', { type: 'checkbox', 'data-testid': `pick-${displayName(c)}` })]));
  const create = async () => {
    const chosen = people.filter((c) => checks.get(c.id).checked);
    let g;
    try { g = createGroup({ name: name.value, me: { cid: S.myCid, name: S.profile.name }, members: chosen.map((c) => ({ cid: c.id, name: displayName(c) })), randomHex: (bytes) => toHex(crypto.getRandomValues(new Uint8Array(bytes))) }); }
    catch (e) { toast(e instanceof GroupError ? e.message : 'Could not create the group', 'error'); return; }
    S.groups.set(g.id, g); await persistGroups();
    const r = await fanOut(g, inviteMessage(g));
    toast(r.failed.length ? `Group created — couldn’t reach ${r.failed.join(', ')} yet` : `Group “${g.name}” created`, r.failed.length ? 'error' : 'success');
    go('group', g.id);
  };
  return h('div.screen.full', header('New group', { back: () => go('home') }),
    h('div.settings',
      name,
      h('h2', 'Members'),
      people.length ? h('ul.picklist', people.map((c) => h('li', h('label', checks.get(c.id), ` ${displayName(c)}`, c.verified ? h('small', ' ✓ verified') : h('small', ' not verified'))))) : h('p.hint', 'Add contacts first.'),
      h('p.hint', 'Each message is end-to-end encrypted separately for every member — no group server, no shared key. Up to 20 people.'),
      h('button.primary', { onclick: create, 'data-testid': 'create-group' }, 'Create group')));
};

VIEWS.group = (gid) => {
  const g = S.groups.get(gid);
  if (!g) return VIEWS.home();
  const key = `g:${gid}`; S.unread.delete(key);
  const msgs = S.chats.get(key) || [];
  const active = !g.removed;
  const log = h('div#log.log', { 'aria-live': 'polite', 'data-testid': 'log' }, msgs.length ? msgs.map((m) => bubble(m, key)) : h('p.empty', 'Messages here go to everyone in the group, each one end-to-end encrypted.'));
  messageActions(log, key);
  const comp = composer({
    key, disabled: !active,
    placeholder: active ? `Message ${g.name}` : 'You are no longer in this group',
    onText: (text, tags) => sendGroupText(g, text, tags),
    onFile: (file, kind, tags) => groupFile(g, file, kind, tags),
    onLocation: () => shareLocation(key, () => recipients(S.groups.get(gid), S.myCid).filter((c) => S.contacts.has(c))),
  });
  return h('div.screen.chat',
    header(g.name, { back: () => go('home'), actions: [
      h('span.pill', { 'data-testid': 'group-size' }, `${g.members.length} people`),
      h('button.icon', { onclick: () => go('groupinfo', gid), 'aria-label': 'Group info', 'data-testid': 'group-info' }, icon('info'))] }),
    liveBanner(key),
    g.members.some((m) => m.cid !== S.myCid && !S.contacts.has(m.cid)) ? h('div.banner', h('p', icon('shield', 14), ' Some members aren’t your contacts: their names come from the group creator, and their messages reach you only through people you know.')) : null,
    log, h('p#chatstatus.chatstatus', { hidden: true }), comp);
};
async function sendGroupText(g, text, tags = {}) {
  if (text.length > MAX_TEXT) throw new Error(`Message too long (max ${MAX_TEXT} characters)`);
  const key = `g:${g.id}`;
  const m = { t: 'gmsg', gid: g.id, id: newId(), ts: Date.now(), text, ...msgMeta(tags) };
  addMessage(key, { ...m, dir: 'out', status: 'sent', acks: [] });
  const r = await fanOut(g, m);
  if (r.failed.length) toast(`Couldn’t reach ${r.failed.join(', ')} yet`, 'error');
  if (r.queued && !r.sent) setMsgStatusDirect(key, m.id, 'queued');
}
function setMsgStatusDirect(key, mid, status) {
  const m = (S.chats.get(key) || []).find((x) => x.id === mid); if (!m) return;
  m.status = statusAfter(m.status, status); paintStatus(key, m);
}
async function groupFile(g, file, kind, tags = {}) {
  const id = newId(); let first = null; const failed = [];
  for (const cid of recipients(g, S.myCid)) {
    if (!S.contacts.has(cid)) { failed.push(memberName(g, cid)); continue; }
    try { const r = await deliverFile(cid, file, 0, (s, t) => setStatusLine(`Sending to ${memberName(g, cid)}… ${Math.round((s / t) * 100)}%`), { gid: g.id, kind, id, ...msgMeta(tags) }); first ||= r; }
    catch { failed.push(memberName(g, cid)); }
  }
  setStatusLine('');
  if (first) addMessage(`g:${g.id}`, { ...(await fileMessage({ id, dir: 'out', ts: Date.now(), status: first.status, acks: [], ...msgMeta(tags) }, file.name, file.type, first.bytes, kind)) });
  if (failed.length) toast(`Couldn’t reach ${failed.join(', ')} yet`, 'error');
}

VIEWS.groupinfo = (gid) => {
  const g = S.groups.get(gid);
  if (!g) return VIEWS.home();
  const amAdmin = g.admin === S.myCid;
  return h('div.screen.full', header(g.name, { back: () => go('group', gid) }),
    h('div.settings',
      h('h2', `Members (${g.members.length})`),
      h('ul.picklist', { 'data-testid': 'member-list' }, g.members.map((m) => {
        const c = S.contacts.get(m.cid);
        return h('li', h('span', memberName(g, m.cid), m.cid === g.admin ? h('small', ' · creator') : null, c ? h('small', c.verified ? ' ✓ verified' : ' not verified') : null),
          amAdmin && m.cid !== S.myCid ? h('button.danger.small', { onclick: async () => {
            if (!(await modal({ title: `Remove ${memberName(g, m.cid)}?`, body: ['They will stop receiving new messages in this group.'], actions: [['Cancel', false], ['Remove', true, 'danger']] }))) return;
            await updateRoster(withoutMember(g, m.cid), [m.cid]);
          } }, 'Remove') : null);
      })),
      h('p.hint', amAdmin ? 'You created this group, so only you can change its members or name.' : 'Only the person who created the group can change its members.'),
      !g.removed ? h('button.danger', { 'data-testid': 'leave-group', onclick: async () => {
        if (!(await modal({ title: `Leave “${g.name}”?`, body: ['You will stop receiving its messages. Messages on this phone are deleted.'], actions: [['Cancel', false], ['Leave', true, 'danger']] }))) return;
        await fanOut(g, { t: 'gleave', gid, id: newId() });
        S.groups.delete(gid); S.chats.delete(`g:${gid}`); await persistGroups(); go('home');
      } }, amAdmin ? 'Leave and close the group for me' : 'Leave group') : null));
};

// ---- shared composer (1:1 chats and groups) ----
function composer({ key, disabled, placeholder, onText, onFile, onLocation }) {
  // The screen is redrawn whenever something changes (relay reconnects, a new profile photo…).
  // The draft lives in S.drafts so a redraw never wipes what you're typing. Memory only.
  const input = h('textarea#compose', { rows: 1, placeholder, disabled, maxlength: MAX_TEXT, 'data-testid': 'compose', 'aria-label': 'Message', value: S.drafts.get(key) || '' });
  const fileIn = h('input', { type: 'file', hidden: true, 'data-testid': 'file-input' });
  const send = async () => {
    const text = input.value; if (!text.trim() || disabled) return;
    input.value = ''; input.style.height = ''; S.drafts.delete(key);
    const tags = takeReply(key);
    // Re-read the box after the send: a redraw during the await replaced this element.
    try { await onText(text, tags); } catch (e) {
      toast(e.message, 'error'); S.drafts.set(key, text); const box = document.getElementById('compose'); if (box) box.value = text;
      if (tags.re) { S.replyTo.set(key, tags.re); refreshReplyBar(key); }
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer:fine)').matches) { e.preventDefault(); send(); } });
  input.addEventListener('input', () => {
    if (input.value) S.drafts.set(key, input.value); else S.drafts.delete(key);
    input.style.height = ''; input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  });
  if (input.value) requestAnimationFrame(() => { input.style.height = `${Math.min(140, input.scrollHeight)}px`; });
  const sendFile = async (f, kind) => {
    if (f.size > MAX_FILE) { toast(`Max ${fmtBytes(MAX_FILE)} per file`, 'error'); return; }
    try {
      const prep = await prepareOutgoing(f);
      // Nothing leaves the phone on a mis-tap: photos, videos and files always show a preview first.
      // (Voice notes are reviewed inside the composer bar instead — see ui/voice.js.)
      if (!(await reviewBeforeSend(prep, kind))) return;
      await onFile(prep.file, kind, takeReply(key));
    } catch (e) { setStatusLine(''); toast(e.message, 'error'); }
  };
  fileIn.addEventListener('change', () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) sendFile(f); });
  // One recorder per chat, kept across re-renders (see render()).
  if (S.voiceRec?.key !== key) {
    S.voiceRec?.discard();
    const vr = { key, form: null };
    Object.assign(vr, voiceRecorder({
      disabled,
      reviewFirst: () => S.settings.voiceSend !== 'release',
      onState: (st) => vr.form?.setAttribute('data-voice', st),
      onSend: async (clip) => {
        if (clip.size > MAX_FILE) { toast(`Max ${fmtBytes(MAX_FILE)} per file`, 'error'); return; }
        try { await vr.onFile(clip, 'voice', takeReply(vr.key)); } catch (e) { setStatusLine(''); toast(e.message, 'error'); }
      },
    }));
    S.voiceRec = vr;
  }
  const vr = S.voiceRec;
  vr.onFile = onFile; vr.button.disabled = !!disabled;
  const form = h('form.composer', { onsubmit: (e) => { e.preventDefault(); send(); }, 'data-voice': vr.state() },
    replyBar(key),
    h('button.icon', { type: 'button', onclick: () => fileIn.click(), disabled, 'aria-label': 'Attach photo, video or file', 'data-testid': 'attach' }, icon('clip')),
    h('button.icon', { type: 'button', onclick: onLocation, disabled, 'aria-label': 'Share location', 'data-testid': 'share-location' }, icon('pin')),
    input, fileIn, vr.bar,
    vr.button,
    h('button.icon.send', { type: 'submit', disabled, 'aria-label': 'Send', 'data-testid': 'send' }, icon('send')));
  vr.form = form;
  return form;
}
/** Show exactly what is about to be sent (the cleaned copy) and wait for an explicit Send. */
async function reviewBeforeSend(prep, kind) {
  let cur = prep;
  const isImg = (t) => /^image\/(jpeg|png|webp|gif)$/.test(t);
  const box = h('div.review-preview');
  const info = h('p.hint'); const note = h('p');
  let url = null;
  const show = () => {
    const f = cur.file, type = f.type || '';
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(f);
    clear(box).append(type.startsWith('audio/')
      ? h('audio', { controls: true, src: url, preload: 'metadata', 'data-testid': 'review-audio' })
      : isImg(type) ? h('img.review', { src: url, alt: f.name, 'data-testid': 'review-image' })
      : type.startsWith('video/') ? h('video.review', { controls: true, playsinline: true, src: url, preload: 'metadata', 'data-testid': 'review-video' })
      : h('p', icon('clip', 16), ` ${f.name}`));
    info.textContent = `${f.name} · ${fmtBytes(f.size)}${cur.quality ? ` · ${cur.quality}` : ''}`;
    clear(note); note.className = cur.warn ? 'warn' : 'ok';
    if (cur.note) note.append(icon(cur.warn ? 'alert' : 'shield', 14), ` ${cur.note}`);
  };
  const hd = prep.original && h('label.toggle', h('input', { type: 'checkbox', 'data-testid': 'review-original', onchange: (e) => {
    cur = e.target.checked ? { ...prep.original, quality: 'Original quality — bigger, slower to send' } : prep; show();
  } }), ' Send original quality');
  show();
  try {
    const t = (cur.file.type || '');
    const choice = await modal({
      title: `Send ${t.startsWith('image/') ? 'this photo' : t.startsWith('video/') ? 'this video' : 'this file'}?`,
      body: [box, info, note, hd].filter(Boolean),
      actions: [['Cancel', 'cancel'], ['Send', 'send', 'primary']],
    });
    if (choice === 'send') prep.file = cur.file; // what you saw is what is sent
    return choice === 'send';
  } finally { if (url) URL.revokeObjectURL(url); }
}

function liveBanner(key) {
  const s = S.liveShares.get(key);
  return s ? h('div.banner', { 'data-testid': 'live-banner' }, h('p', icon('pin', 14), ` Sharing your live location until ${fmtTime(s.until)}`),
    h('button', { onclick: () => stopLiveShare(key), 'data-testid': 'stop-live' }, 'Stop sharing')) : null;
}
/** Sends one message to several contacts and shows it once in `key`. */
async function sendToTargets(key, targets, m, display) {
  const to = targets(); let status = 'sent'; const failed = [];
  for (const cid of to) { try { if ((await deliver(cid, m)) === 'queued') status = 'queued'; } catch { failed.push(displayName(S.contacts.get(cid) || { name: '?' })); } }
  if (failed.length === to.length) { toast(`Couldn’t send: ${failed.join(', ')} not reachable`, 'error'); return; }
  addMessage(key, { id: m.id, dir: 'out', ts: m.ts, status, acks: [], ...display });
  if (failed.length) toast(`Couldn’t reach ${failed.join(', ')} yet`, 'error');
}

VIEWS.contact = (id) => {
  const c = S.contacts.get(id);
  if (!c) return VIEWS.home();
  const sn = h('code.safety', { 'data-testid': 'safety-number' }, '…');
  safetyNumber(S.vault.identity.publicRaw, fromB64u(c.pub)).then((s) => { sn.textContent = s; });
  const alias = h('input', { type: 'text', value: c.alias || '', placeholder: c.name, maxlength: 40, 'aria-label': 'Nickname' });
  const keep = h('input', { type: 'checkbox', checked: !!c.keepHistory, 'data-testid': 'keep-history' });
  return h('div.screen.full',
    header(displayName(c), { back: () => go('chat', id) }),
    h('div.panel',
      h('div.who', avatar(c, { size: 'xl' }), h('div', h('strong', c.name), c.username ? h('p.handle', { 'data-testid': 'contact-username' }, `@${c.username}`) : null)),
      (() => { const k = sharedItems(id); return h('button.sharedbtn', { type: 'button', onclick: () => go('shared', id), 'data-testid': 'open-shared' },
        icon('image', 20), h('span', 'Media, links and docs'), h('span.count', String(k.media.length + k.docs.length + k.links.length))); })(),
      h('h2', 'Calls'),
      h('label.toggle', h('input', { type: 'checkbox', checked: !c.noCalls, 'data-testid': 'allow-calls-from', onchange: async (e) => {
        c.noCalls = !e.target.checked; await persistContacts(); syncProfiles([id]);
        toast(c.noCalls ? `${displayName(c)} can no longer call you` : `${displayName(c)} can call you again`);
      } }), ` Allow ${displayName(c)} to call me`),
      h('p.hint', c.calls && !c.calls.voice && !c.calls.video ? `${displayName(c)} doesn’t accept calls right now.` : ''),
      h('h2', 'Read receipts'),
      h('select', { 'data-testid': 'contact-receipts', 'aria-label': 'Read receipts for this contact', onchange: async (e) => {
        if (e.target.value === 'default') delete c.receipts; else c.receipts = e.target.value;
        await persistContacts(); toast(receiptsOn(S.settings, c) ? `${displayName(c)} sees when you’ve read their messages` : `${displayName(c)} won’t see when you’ve read their messages`);
      } },
        h('option', { value: 'default', selected: !c.receipts }, `Same as everyone (${S.settings.readReceipts === false ? 'off' : 'on'})`),
        h('option', { value: 'on', selected: c.receipts === 'on' }, 'On for this contact'),
        h('option', { value: 'off', selected: c.receipts === 'off' }, 'Off for this contact')),
      h('p.hint', 'Blue ✓✓ tells the sender you’ve opened their message. It works both ways: when it’s off, you won’t see theirs either. Delivered (grey ✓✓) always shows.'),
      !isOnline(id) ? [h('h2', 'Connect nearby'),
        h('p.hint', 'On the same Wi-Fi or hotspot? Show your code to each other — no internet needed.'),
        h('div.share',
          h('button.primary', { onclick: () => go('invite', id), 'data-testid': 'contact-nearby-show' }, icon('qr', 18), ' Show my code'),
          h('button', { onclick: () => go('join', id) }, icon('scan', 18), ' Scan theirs')),
        c.hideNearby ? h('button.linkish', { 'data-testid': 'nearby-unhide', onclick: async () => { delete c.hideNearby; await persistContacts(); toast('The nearby card is back in your chat'); } }, 'Show the nearby card in the chat again') : null] : null,
      h('h2', 'Safety number'),
      h('p', 'Compare these digits with ', h('strong', c.name), '’s screen — in person or on a voice call. If they match, nobody is intercepting you.'),
      sn,
      c.verified
        ? h('p.ok', { 'data-testid': 'verified' }, icon('check', 16), c.remote && !S.convs.has(id) ? ' Verified' : ' Verified (you scanned each other’s codes in person)')
        : h('div',
          h('p.warn', icon('alert', 16), ' Not verified. You added this contact with a link, which someone could have swapped on the way.'),
          h('button.primary', { 'data-testid': 'mark-verified', onclick: async () => { c.verified = true; await persistContacts(); toast('Marked as verified', 'success'); render(); } }, 'The numbers match')),
      h('h2', 'Nickname'),
      h('div.row', alias, h('button', { onclick: async () => { c.alias = clampName(alias.value); await persistContacts(); toast('Saved'); } }, 'Save')),
      h('h2', 'History'),
      h('label.toggle', keep, ' Keep encrypted history on this device'),
      h('p.hint', 'On (default for new contacts): messages, photos, voice notes and files are kept on this phone, encrypted with your passphrase. Off: they exist only in memory and vanish when you lock or close Murmur. Disappearing messages are never stored.'),
      h('button', { onclick: async () => { c.keepHistory = keep.checked; await persistContacts(); await persistHistory(id); toast(c.keepHistory ? 'History will be kept (encrypted)' : 'History deleted from storage'); } }, 'Apply'),
      h('h2', 'Danger zone'),
      h('div.share',
        h('button', { onclick: async () => { S.chats.set(id, []); await persistHistory(id); toast('Conversation cleared'); } }, icon('trash', 18), ' Clear conversation'),
        h('button.danger', { onclick: () => deleteContact(id) }, 'Delete contact'))));
};

async function deleteContact(id) {
  const c = S.contacts.get(id);
  if (!c || !(await modal({ title: `Delete ${displayName(c)}?`, body: 'This removes the contact, their key, the internet link and all history from this device.', actions: [['Cancel', false], ['Delete', true, 'danger']] }))) return;
  S.convs.get(id)?.close('deleted');
  await S.remote?.forget(id);
  for (const mid of c.media || []) await S.vault.deleteRecord(MEDIA(id, mid));
  S.contacts.delete(id); S.chats.delete(id);
  await persistContacts(); await S.vault.deleteRecord(`history/${id}`);
  go('home');
}

// ---- media, links and docs shared with one contact ----
function sharedItems(id) {
  const media = [], docs = [], links = [];
  for (const m of S.chats.get(id) || []) {
    if (m.deleted) continue;
    if (m.file) {
      const isMedia = m.file.safety?.inline || m.file.playable === 'video' || (!m.file.url && /^(image|video)\//.test(m.file.mime || ''));
      (isMedia ? media : docs).push(m);
    } else if (m.text) {
      for (const seg of linkify(m.text)) if (seg.type === 'link') links.push({ m, seg });
    }
  }
  return { media: media.reverse(), docs: docs.reverse(), links: links.reverse() };
}
// ---- full-screen viewer: the photo/video/file, what it really is, and what you can do with it ----
function fileInfo(m, img) {
  const f = m.file;
  const dims = img?.naturalWidth ? ` · ${img.naturalWidth}×${img.naturalHeight}` : '';
  return `${typeLabel(f.safety?.realType || f.mime, f.name)} · ${fmtBytes(f.size)}${dims}`;
}
function closeViewer() {
  const v = document.querySelector('.viewer-screen'); if (!v) return;
  v.querySelector('video')?.pause(); v.remove(); document.removeEventListener('keydown', viewerKeys);
}
function viewerKeys(e) { if (e.key === 'Escape') closeViewer(); }
function openViewer(m, key, { fromShared = false } = {}) {
  closeViewer();
  const f = m.file; if (!f?.url) return;
  const k = kindOf(m);
  const cid = m.from || key;
  const info = h('span.vinfo', { 'data-testid': 'viewer-info' }, fileInfo(m));
  const sf = f.safety;
  const stage = k === 'photo' ? h('img.vbig', { src: f.url, alt: 'Photo', 'data-testid': 'viewer-image', onload: (e) => { info.textContent = fileInfo(m, e.target); } })
    : k === 'video' ? h('video.vbig', { controls: true, playsinline: true, autoplay: true, src: f.url, 'data-testid': 'viewer-video' })
    : h('div.vdoc', h('span.docbadge.big', typeLabel(sf?.realType || f.mime, f.name)), h('strong', { 'data-testid': 'viewer-name' }, f.name),
      sf && sf.verdict !== 'ok' ? h('ul.filewarn', sf.reasons.map((r) => h('li', r))) : null);
  const who = m.dir === 'out' ? 'You' : whoWrote(cid, key);
  const act = (label, ic, fn, tid) => h('button.vact', { type: 'button', onclick: fn, 'data-testid': tid }, icon(ic, 22), h('span', label));
  const v = h('div.viewer-screen', { role: 'dialog', 'aria-modal': 'true', 'aria-label': `${k} from ${who}`, 'data-testid': 'viewer' },
    h('div.vtop',
      h('button.icon', { type: 'button', onclick: closeViewer, 'aria-label': 'Close', 'data-testid': 'viewer-close' }, icon('back')),
      h('div.vwho', h('strong', who), h('small', new Date(m.ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })))),
    h('div.vstage', stage),
    h('div.vbottom', info,
      h('div.vacts',
        canReply(m) ? act('Reply', 'reply', () => { closeViewer(); if (fromShared || !isOpenChat(key)) go(key.startsWith('g:') ? 'group' : 'chat', key.startsWith('g:') ? key.slice(2) : key); S.replyTo.set(key, quoteOf(m, S.myCid, key)); refreshReplyBar(key); }, 'viewer-reply') : null,
        canForward(m) ? act('Forward', 'forward', () => { closeViewer(); forwardMessage(key, m).catch((e) => toast(e.message, 'error')); }, 'viewer-forward') : null,
        fromShared ? act('In chat', 'chat', () => { closeViewer(); go('chat', key); requestAnimationFrame(() => jumpTo(key, m.id)); }, 'viewer-chat') : null,
        // Straight from the tap (no await before it): iPhone only allows the share sheet that way.
        act('Save', 'share', () => saveFile(m, cid), 'viewer-save'))));
  document.body.append(v);
  document.addEventListener('keydown', viewerKeys);
}
VIEWS.shared = (id, tab = 'media') => {
  const c = S.contacts.get(id);
  if (!c) return VIEWS.home();
  const k = sharedItems(id);
  const tabs = [['media', 'Media', k.media.length], ['docs', 'Docs', k.docs.length], ['links', 'Links', k.links.length]];
  const when = (m) => new Date(m.ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const empty = (t) => h('p.empty', t);
  let body;
  if (tab === 'media') {
    body = k.media.length ? h('div.mediagrid', { 'data-testid': 'shared-media' }, k.media.map((m) => h('button.thumb', { type: 'button', onclick: () => m.file.url && openViewer(m, id, { fromShared: true }), 'aria-label': kindLabel(kindOf(m)) },
      !m.file.url ? h('span.hint', '…') : m.file.playable === 'video' ? [h('video', { src: m.file.url, preload: 'metadata', muted: true, playsinline: true }), h('span.play', '▶')] : h('img', { src: m.file.url, alt: '' }))))
      : empty('No photos or videos yet.');
  } else if (tab === 'docs') {
    body = k.docs.length ? h('ul.doclist', { 'data-testid': 'shared-docs' }, k.docs.map((m) => h('li',
      isVoice(m)
        ? [h('div.docinfo', icon('mic', 18), h('div', h('strong', 'Voice message'), h('small', `${m.dir === 'out' ? 'You' : displayName(c)} · ${when(m)}`))),
          voicePlayer({ blob: m.file.blob, url: m.file.url, compact: true })]
        : [h('div.docinfo', icon('clip', 18), h('div', h('strong', m.file.name), h('small', `${fmtBytes(m.file.size)} · ${m.dir === 'out' ? 'You' : displayName(c)} · ${when(m)}`))),
          m.file.url && m.file.playable === 'audio' ? h('audio', { controls: true, preload: 'none', src: m.file.url }) : null,
          m.file.url ? h('button', { type: 'button', onclick: () => openViewer(m, id, { fromShared: true }), 'data-testid': 'doc-open' }, 'Open') : h('span.hint', 'Loading…')])))
      : empty('No files or voice messages yet.');
  } else {
    body = k.links.length ? h('ul.linklist', { 'data-testid': 'shared-links' }, k.links.map(({ m, seg }) => h('li',
      h(`button.inlink.risk-${seg.analysis.risk}`, { type: 'button', onclick: () => checkLink(seg, id, m.dir) }, seg.text),
      h('small', `${m.dir === 'out' ? 'You' : displayName(c)} · ${when(m)}`))))
      : empty('No links yet.');
  }
  return h('div.screen.full',
    header('Media, links and docs', { back: () => go('contact', id) }),
    h('div.tabs', { role: 'tablist' }, tabs.map(([t, label, n]) => h(`button${t === tab ? '.on' : ''}`, { type: 'button', role: 'tab', 'aria-selected': t === tab, 'data-testid': `tab-${t}`, onclick: () => go('shared', id, t) }, `${label} ${n}`))),
    h('div.panel', body,
      c.keepHistory ? null : h('p.hint', 'History is off for this contact, so only what arrived since you unlocked is listed. Turn on “Keep encrypted history” to keep everything.')));
};

// ---- backup & move: your account on another phone (engine: core/backup.js + core/relaybox.js) ----
const ONLINE_MIN_BITS = 65;          // online backups can be attacked offline: require a strong passphrase
const ONLINE_MAX_BYTES = 48 * 1024 * 1024;
const ONLINE_REFRESH_MS = 20 * 3600e3;

/** Let pending history/media writes and queued relay work finish, so a snapshot is complete. */
async function settle() {
  await Promise.all([...persistQueue.values()]).catch(() => {});
  await S.remote?.idle().catch(() => {});
}
async function makePackage({ includeMedia = true, exact = false } = {}) {
  await settle();
  return BK.exportVault(SLOTS[S.slot || 'a'], { login: await store.get(LOGIN_KEY), includeMedia, exact });
}
/** Ask for the passphrase of the OPEN vault (proves it's you; never stored). → string | null */
async function askPassphrase(title, body, extra = []) {
  const inp = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Your passphrase', 'data-testid': 'confirm-pass' });
  for (;;) {
    const v = await modal({ title, body: [...[].concat(body), inp, ...extra], actions: [['Cancel', false], ['Continue', 'ok', 'primary']] });
    if (v !== 'ok') return null;
    const opened = await Vault.open(SLOTS[S.slot || 'a'], inp.value).catch(() => null);
    if (opened) { opened.lock(); return inp.value; }
    toast('That’s not your passphrase', 'error');
  }
}
async function shareOrDownload(bytes, name) {
  const f = new File([bytes], name, { type: 'application/octet-stream' });
  if (matchMedia('(pointer:coarse)').matches && navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(f);
  const a = h('a', { href: url, download: name, hidden: true }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// 1. Backup file
async function saveBackupFile() {
  const media = h('input', { type: 'checkbox', checked: true, 'data-testid': 'backup-media' });
  const pass = await askPassphrase('Save an encrypted backup',
    ['The file is locked with your passphrase — keep it somewhere safe (Files, a computer, a USB stick). Anyone who has the file still needs your passphrase.'],
    [h('label.toggle', media, ' Include photos, voice notes and files')]);
  if (!pass) return;
  setStatusLine('Preparing backup…'); toast('Preparing your backup…');
  try {
    const sealed = await BK.sealWithPassphrase(await makePackage({ includeMedia: media.checked }), pass);
    S.settings.backupFileAt = Date.now(); await S.vault.putRecord('settings', S.settings);
    await shareOrDownload(sealed, `murmur-backup-${new Date().toISOString().slice(0, 10)}.murmur`);
    toast(`Backup ready (${fmtBytes(sealed.length)})`, 'success');
    rerenderIf('settings');
  } catch (e) { toast(`Backup failed: ${e.message}`, 'error'); }
}

// 2. Online backup (log in on any phone with username + passphrase)
async function uploadOnline(rec) {
  let media = true;
  let sealed = await BK.sealWithKey(await makePackage({ includeMedia: true }), fromB64u(rec.key));
  if (sealed.length > ONLINE_MAX_BYTES) { media = false; sealed = await BK.sealWithKey(await makePackage({ includeMedia: false }), fromB64u(rec.key)); }
  if (sealed.length > ONLINE_MAX_BYTES) throw new Error('Your messages alone are too big for an online backup — use a backup file');
  await writeBox(RELAY_URL, fromB64u(rec.box), BK.toChunks(sealed), { replace: true });
  Object.assign(rec, { at: Date.now(), size: sealed.length, media });
  await S.vault.putRecord('cloud', rec);
  rerenderIf('settings');
  return rec;
}
async function enableOnlineBackup() {
  if (!S.profile.username) { toast('Choose a username first (Settings → You)', 'error'); return; }
  const pass = await askPassphrase('Turn on online backup',
    [h('p', 'Your account is sealed with keys made from your username and passphrase, then stored on the Murmur relay. On a new phone you just log in with those two.'),
      h('p.warn', icon('alert', 14), ' The trade-off: anyone who knows your username could download the sealed copy and try to guess your passphrase forever. It is only as strong as your passphrase.')]);
  if (!pass) return;
  if (strength(pass).bits < ONLINE_MIN_BITS) {
    await modal({ title: 'Your passphrase is too weak for this', body: ['An online copy can be attacked offline, so Murmur requires a strong passphrase — for example 4–5 random words. Change it in Settings → Security, then try again.'], actions: [['OK', true, 'primary']] });
    return;
  }
  toast('Making your online backup…');
  try {
    const k = await BK.onlineKeys(S.profile.username, pass);
    await uploadOnline({ box: toB64u(k.box), key: toB64u(k.key), user: S.profile.username });
    toast('Online backup is on. Log in on any phone with your username and passphrase.', 'success', 6000);
  } catch (e) { toast(`Online backup failed: ${e.message}`, 'error', 6000); }
}
async function disableOnlineBackup(silent = false) {
  const rec = await S.vault.getRecord('cloud', null);
  if (rec) await readBox(RELAY_URL, fromB64u(rec.box), { ack: true }).catch(() => {}); // delete it from the relay
  await S.vault.deleteRecord('cloud');
  if (!silent) toast('Online backup turned off and deleted from the relay');
  rerenderIf('settings');
}
/** Keep the online copy fresh (the relay erases anything older than 30 days). */
async function refreshOnlineBackup(force = false) {
  const rec = await S.vault?.getRecord('cloud', null);
  if (!rec || (!force && Date.now() - (rec.at || 0) < ONLINE_REFRESH_MS)) return;
  await uploadOnline(rec);
}
/** The passphrase changed (we have the new one): move the online copy to the new keys. */
async function rekeyOnlineBackup(newPass) {
  const rec = await S.vault.getRecord('cloud', null); if (!rec) return;
  await readBox(RELAY_URL, fromB64u(rec.box), { ack: true }).catch(() => {});
  const k = await BK.onlineKeys(S.profile.username, newPass);
  await uploadOnline({ box: toB64u(k.box), key: toB64u(k.key), user: S.profile.username });
}

// 3. Move to a new phone (old phone erases itself once the new one has everything)
VIEWS.moveout = () => {
  const qr = h('div.qrbox', h('div.spinner'));
  const codeBox = h('textarea.code', { readonly: true, rows: 2, 'data-testid': 'move-code', 'aria-label': 'Move code' });
  const status = h('p', { 'data-testid': 'move-status' }, 'Preparing…');
  let cancelled = false, keys = null;
  const cancel = async () => {
    cancelled = true;
    if (keys) await readBox(RELAY_URL, keys.box, { ack: true }).catch(() => {});
    if (S.vault) { await startRemote().catch(() => {}); go('settings'); toast('Move cancelled — nothing changed'); }
  };
  (async () => {
    stopRemote(); // freeze: from now on this phone's state must not move
    const code = random(32); keys = await BK.moveKeys(code);
    const sealed = await BK.sealWithKey(await makePackage({ includeMedia: true, exact: true }), keys.key);
    status.textContent = `Uploading (${fmtBytes(sealed.length)})…`;
    await writeBox(RELAY_URL, keys.box, BK.toChunks(sealed), { replace: true, onProgress: (i, n) => { status.textContent = `Uploading… ${Math.round((i / n) * 100)}%`; } });
    if (cancelled) return;
    const text = BK.moveCodeText(code);
    codeBox.value = text;
    clear(qr).append(qrSvg(encodeQR(text, { ecl: 'M' }), 'Move code'));
    status.textContent = 'On your new phone: open Murmur → “I already have an account” → “Move from my old phone” → scan this.';
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      if (cancelled || S.view !== 'moveout') return;
      const got = await readBox(RELAY_URL, keys.ack, { ack: true }).catch(() => []);
      if (got.length) break;
    }
    await readBox(RELAY_URL, keys.box, { ack: true }).catch(() => {});
    await eraseThisPhone();
    toast('Moved to your new phone. This phone has been erased.', 'success', 8000);
  })().catch((e) => { status.textContent = `Couldn’t prepare the move: ${e.message}`; status.className = 'error'; });
  return h('div.screen.full',
    header('Move to a new phone', { back: cancel }),
    h('div.pair',
      h('ol.steps',
        h('li', 'On the ', h('strong', 'new'), ' phone open Murmur and tap ', h('em', 'I already have an account → Move from my old phone'), '.'),
        h('li', 'Scan this code (or copy the text). Your account is sent sealed through the relay — nothing is readable on the way.'),
        h('li', 'You’ll unlock the new phone with the same username and passphrase. ', h('strong', 'This phone then erases itself'), ' so the two never get out of step.')),
      qr, codeBox,
      h('div.share', h('button', { onclick: async () => { try { await navigator.clipboard.writeText(codeBox.value); toast('Code copied'); } catch { codeBox.select(); } } }, icon('copy', 18), ' Copy code')),
      status,
      h('p.hint', 'The code works once. Don’t send it to anyone — together with your passphrase it opens your account.'),
      h('button', { onclick: cancel, 'data-testid': 'move-cancel' }, 'Cancel')));
};
async function startMove() {
  const pass = await askPassphrase('Move to a new phone', ['After the move, THIS phone erases itself. Your new phone gets everything: contacts, chats, photos, keys and settings.']);
  if (pass) go('moveout');
}
async function eraseThisPhone() {
  const r = S.remote; stopRemote();
  await r?.idle().catch(() => {});
  for (const conv of S.convs.values()) conv.close('wiped');
  S.vault?.lock();
  await store.destroy(); store.destroyed = false;
  Object.assign(S, { vault: null, contacts: new Map(), chats: new Map(), convs: new Map() });
  go('welcome');
}

// ---- the new phone: "I already have an account" ----
async function finishRestore(pkg, passphrase) {
  if (await anyVault(store)) await store.clear(); // replacing (the person confirmed)
  await BK.importVault(store, SLOTS.a, pkg);
  await ensureSlots(store);
  if (passphrase) {
    const { vault, slot } = await unlockAny(store, passphrase);
    S.slot = slot; await openVault(vault);
  } else go('unlock');
}
async function confirmReplace() {
  if (!(await anyVault(store))) return true;
  return (await modal({ title: 'Replace the account on this phone?', body: ['This phone already has a Murmur account. Restoring erases it and puts the other account here instead.'], actions: [['Cancel', false], ['Replace it', true, 'danger']] })) === true;
}
VIEWS.restore = (mode = null) => {
  const back = () => (mode ? go('restore') : go(S.vault ? 'home' : 'welcome'));
  const out = h('div.screen.narrow');
  const err = h('p.error', { role: 'alert', 'data-testid': 'restore-error' });
  const busy = (btn, on, label) => { btn.disabled = on; btn.textContent = on ? 'Working…' : label; };
  if (!mode) {
    const opt = (m, ic, t, d) => h('button.tile.wide', { onclick: () => go('restore', m), 'data-testid': `restore-${m}` }, icon(ic, 26), h('span', t), h('small', d));
    return h('div.screen.full', header('I already have an account', { back }),
      h('section.pair-actions.column',
        opt('online', 'globe', 'Log in with username + passphrase', 'If you turned on online backup'),
        opt('move', 'scan', 'Move from my old phone', 'Old phone nearby: scan its code'),
        opt('file', 'clip', 'Restore a backup file', 'A .murmur file you saved')),
      h('p.hint.pad', 'There is no account server: your account exists only on your phone, plus any backup you made. Without one of these, a lost phone’s chats can’t be recovered — by anyone.'));
  }
  if (mode === 'online') {
    const user = h('input', { type: 'text', autocapitalize: 'none', spellcheck: false, autocomplete: 'username', placeholder: 'Username', 'data-testid': 'login-user' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Passphrase', 'data-testid': 'login-pass' });
    const btn = h('button.primary.big', { type: 'submit', 'data-testid': 'login-go' }, 'Log in');
    return h('form.screen.narrow', { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      if (!(await confirmReplace())) return;
      busy(btn, true, 'Log in');
      try {
        const k = await BK.onlineKeys(user.value, pass.value);
        const rows = await readBox(RELAY_URL, k.box);
        const sealed = BK.fromChunks(rows.map((r) => r.data));
        if (!sealed) throw new Error('No online backup found for that username and passphrase.');
        await finishRestore(await BK.openSealed(sealed, { key: k.key }), pass.value);
        toast('Welcome back — your account is on this phone', 'success', 6000);
      } catch (ex) { err.textContent = ex.message; busy(btn, false, 'Log in'); }
    } },
    header('Log in', { back }),
    h('p', 'Works if you turned on ', h('strong', 'online backup'), ' on your old phone.'),
    h('label', 'Username'), user, h('label', 'Passphrase'), pass, err, btn,
    h('p.hint', 'Messages that arrived after the last backup (and were already read on the old phone) aren’t included. Your contacts’ phones renew the secure link automatically the next time they’re online.'));
  }
  if (mode === 'file') {
    const file = h('input', { type: 'file', accept: '.murmur,application/octet-stream', 'data-testid': 'restore-file' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Passphrase', 'data-testid': 'restore-pass' });
    const btn = h('button.primary.big', { type: 'submit', 'data-testid': 'restore-go' }, 'Restore');
    return h('form.screen.narrow', { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      const f = file.files[0]; if (!f) { err.textContent = 'Pick your backup file first.'; return; }
      if (!(await confirmReplace())) return;
      busy(btn, true, 'Restore');
      try {
        const pkg = await BK.openSealed(new Uint8Array(await f.arrayBuffer()), { passphrase: pass.value });
        await finishRestore(pkg, pass.value);
        toast('Restored — your account is on this phone', 'success', 6000);
      } catch (ex) { err.textContent = ex.message; busy(btn, false, 'Restore'); }
    } },
    header('Restore a backup file', { back }),
    h('label', 'Backup file (.murmur)'), file, h('label', 'Passphrase (the one you had when you saved it)'), pass, err, btn);
  }
  // mode === 'move'
  const scanArea = h('div');
  const paste = h('textarea.code', { rows: 2, placeholder: 'Or paste the code (starts with murmur-move:)', 'data-testid': 'move-paste' });
  const take = async (text) => {
    err.textContent = '';
    try {
      const code = BK.moveCodeFrom(text);
      if (!(await confirmReplace())) return true;
      stopScanner(); clear(scanArea).append(h('p', 'Receiving your account…'));
      const k = await BK.moveKeys(code);
      const sealed = BK.fromChunks((await readBox(RELAY_URL, k.box)).map((r) => r.data));
      if (!sealed) throw new Error('Nothing waiting for this code — keep the old phone on the code screen, then try again.');
      const pkg = await BK.openSealed(sealed, { key: k.key });
      await writeBox(RELAY_URL, k.ack, [utf8('received')]);     // tells the old phone it can erase itself
      await finishRestore(pkg, null);
      toast('Moved! Unlock with your username and passphrase.', 'success', 8000);
      return false;
    } catch (ex) { err.textContent = ex.message; return true; }
  };
  const startCam = async () => {
    stopScanner();
    const video = h('video.cam', { 'aria-label': 'Camera preview' });
    clear(scanArea).append(h('div.camwrap', video, h('div.reticle')));
    S.scanner = new Scanner(video);
    try { await S.scanner.start((text) => { if (text.includes(BK.MOVE_PREFIX)) take(text); return text.includes(BK.MOVE_PREFIX); }); }
    catch (e) { stopScanner(); clear(scanArea).append(h('p.error', `Camera unavailable: ${e.message}. Paste the code instead.`)); }
  };
  return h('div.screen.full', header('Move from my old phone', { back }),
    h('div.pair',
      h('ol.steps', h('li', 'On the old phone: Settings → ', h('em', 'Move to a new phone'), '.'), h('li', 'Scan the code it shows.')),
      h('button.primary', { onclick: startCam, 'data-testid': 'move-scan' }, icon('scan', 18), ' Scan the code'),
      scanArea, paste,
      h('button', { onclick: () => take(paste.value), 'data-testid': 'move-paste-go' }, icon('paste', 18), ' Use pasted code'),
      err));
};

/** Settings section. */
function backupSection() {
  const info = h('p.hint', { 'data-testid': 'online-status' }, '…');
  const toggle = h('button', { 'data-testid': 'online-toggle' }, '…');
  S.vault.getRecord('cloud', null).then((rec) => {
    info.textContent = rec ? `On — last backup ${new Date(rec.at).toLocaleString()} (${fmtBytes(rec.size)}${rec.media ? '' : ', without photos — too big'}). Refreshed daily while you use Murmur; the relay keeps it 30 days.` : 'Off.';
    toggle.textContent = rec ? 'Turn off and delete it' : 'Turn on online backup';
    toggle.onclick = () => (rec ? disableOnlineBackup() : enableOnlineBackup());
  });
  return h('div.backup',
    h('h2', 'Backup & new phone'),
    h('p.hint', 'Your account lives only on this phone. Make a backup so a lost or broken phone doesn’t mean lost chats.'),
    h('label', 'Encrypted backup file'),
    h('div.row', h('button', { onclick: saveBackupFile, 'data-testid': 'backup-file' }, icon('share', 18), ' Save backup file')),
    h('p.hint', S.settings.backupFileAt ? `Last saved ${new Date(S.settings.backupFileAt).toLocaleString()}.` : 'Never saved.'),
    h('label', 'Online backup — log in on any phone'),
    info, h('div.row', toggle, h('button', { onclick: () => refreshOnlineBackup(true).then(() => toast('Backed up', 'success')).catch((e) => toast(e.message, 'error')), 'data-testid': 'online-now' }, 'Back up now')),
    h('label', 'Move to a new phone'),
    h('p.hint', 'Old phone in hand: scan a code on the new one. Everything moves; this phone then erases itself.'),
    h('button', { onclick: startMove, 'data-testid': 'move-start' }, icon('qr', 18), ' Move to a new phone'));
}

// ---- duress passcode ----
// In the REAL vault this sets up the decoy. In the DECOY the same screen appears and
// "works" (it is saved in the decoy's own settings) but can never touch the real vault —
// so someone poking around the decoy sees nothing unusual.
function duressSection() {
  const d = S.settings.duress || {};
  const p1 = h('input', { type: 'password', placeholder: `Duress passcode (${MIN_PASSPHRASE}+ chars)`, autocomplete: 'off', 'data-testid': 'duress-pass' });
  const p2 = h('input', { type: 'password', placeholder: 'Repeat it', autocomplete: 'off', 'data-testid': 'duress-pass2' });
  const erase = h('input', { type: 'checkbox', checked: !!d.erase, 'data-testid': 'duress-erase' });
  const btn = h('button.primary', { 'data-testid': 'duress-save' }, d.on ? 'Change duress passcode' : 'Set duress passcode');
  const save = async (next) => { S.settings.duress = next; await S.vault.putRecord('settings', S.settings); };
  btn.onclick = async () => {
    if (p1.value.length < MIN_PASSPHRASE) { toast(`At least ${MIN_PASSPHRASE} characters`, 'error'); return; }
    if (p1.value !== p2.value) { toast('The two passcodes don’t match', 'error'); return; }
    if (erase.checked && !(await modal({ title: 'Erase real chats when it’s used?',
      body: ['The moment anyone unlocks with the duress passcode, your real contacts, keys and messages are destroyed for good. Nobody — not even you — can bring them back.'],
      actions: [['Cancel', 'no'], ['Yes, erase them', 'yes', 'danger']] }) === 'yes')) return;
    btn.disabled = true; btn.textContent = 'Setting up…';
    try {
      if (S.slot === 'a') {
        await setDuress(store, 'a', p1.value, { name: S.profile.name, eraseReal: erase.checked,
          profile: { username: S.profile.username, pic: S.profile.pic || null, v: Date.now() },
          settings: { autoLockMin: S.settings.autoLockMin, internet: !!S.settings.internet, calls: S.settings.calls } });
      } else {
        // Decoy: same checks, same wait, same result on screen; nothing real is touched.
        if (await opensOther(store, 'b', p1.value) || await Vault.open(S.vault.store, p1.value)) throw new Error('The duress passcode must be different from your real passphrase');
      }
      await save({ on: true, erase: erase.checked });
      p1.value = p2.value = '';
      toast('Duress passcode set', 'success'); render();
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = d.on ? 'Change duress passcode' : 'Set duress passcode'; }
  };
  const off = h('button', { 'data-testid': 'duress-off', onclick: async () => {
    if (S.slot === 'a') await clearDuress(store, 'a');
    await save({ on: false, erase: false });
    toast('Duress passcode turned off'); render();
  } }, 'Turn off');
  return h('div.duress',
    h('h2', 'Duress passcode'),
    h('p.hint', 'For when someone forces you to unlock Murmur. Type this instead of your passphrase: Murmur opens normally, but shows a separate set of chats — never your real ones. Nothing on screen tells them apart.'),
    h('p', { 'data-testid': 'duress-status' }, d.on ? (d.erase ? 'On — erases your real chats when used' : 'On') : 'Off'),
    p1, p2,
    h('label.toggle', erase, ' Also erase my real chats the moment it’s used'),
    h('div.row', btn, d.on ? off : null),
    h('p.hint', 'Tip: unlock once with the duress passcode and add a few ordinary contacts (family, a work group), so it looks lived-in. Choose something you can type calmly under pressure.'));
}

function profileEditor(nameIn) {
  const picIn = h('input', { type: 'file', accept: 'image/*', hidden: true, 'data-testid': 'pic-input', onchange: async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { await saveProfile({ pic: await makeProfilePic(f) }); toast('Profile photo updated', 'success'); render(); }
    catch (ex) { toast(ex.message, 'error'); }
  } });
  const userIn = h('input', { type: 'text', value: S.profile.username || '', maxlength: 21, autocapitalize: 'none', spellcheck: false, 'aria-label': 'Username', 'data-testid': 'settings-username' });
  return h('div.profile',
    h('div.me', h('button.avatar.lg.me', { type: 'button', onclick: () => picIn.click(), 'aria-label': 'Change profile photo', 'data-testid': 'pic-button' },
      myPicUrl() ? h('img', { src: myPicUrl(), alt: '' }) : (S.profile.name || '?').slice(0, 1).toUpperCase(), h('span.cam', icon('camera', 14))),
      h('div',
        h('button.link', { type: 'button', onclick: () => picIn.click() }, myPicUrl() ? 'Change photo' : 'Add a photo'),
        myPicUrl() ? h('button.link', { type: 'button', 'data-testid': 'pic-remove', onclick: async () => { await saveProfile({ pic: null }); render(); } }, 'Remove') : null,
        h('p.hint', 'Only your contacts see it — sent end-to-end encrypted, never uploaded anywhere.'))),
    picIn,
    h('label', 'Display name'),
    h('div.row', nameIn, h('button', { onclick: async () => { const n = clampName(nameIn.value); if (!n) return; await saveProfile({ name: n }); toast('Name saved'); } }, 'Save')),
    h('label', 'Username'),
    h('div.row', userIn, h('button', { 'data-testid': 'save-username', onclick: async () => {
      const problem = usernameProblem(userIn.value); if (problem) { toast(problem, 'error'); return; }
      const remembered = !!(await store.get(LOGIN_KEY))?.user;
      await saveLogin(userIn.value, remembered);
      await saveProfile({ username: normalizeUsername(userIn.value) });
      toast(`Username saved — unlock with @${normalizeUsername(userIn.value)} from now on`, 'success');
      if (await S.vault.getRecord('cloud', null)) {
        // The online backup is found by username: move it to the new name (needs the passphrase).
        const pass = await askPassphrase('Update your online backup', ['Your online backup is found by your username, so it has to move to the new one.']);
        if (pass) await rekeyOnlineBackup(pass).then(() => toast('Online backup moved to your new username', 'success')).catch((e) => toast(e.message, 'error'));
        else { await disableOnlineBackup(true); toast('Online backup turned off (it was under your old username)'); }
      }
    } }, 'Save')),
    h('label.toggle', h('input', { type: 'checkbox', 'data-testid': 'remember-toggle', onchange: async (e) => {
      const rec = await store.get(LOGIN_KEY); if (!rec) return;
      if (e.target.checked) await store.put(LOGIN_KEY, { ...rec, user: S.profile.username }); else { const { user: _u, ...rest } = rec; await store.put(LOGIN_KEY, rest); }
      toast(e.target.checked ? 'Username remembered on this phone' : 'You’ll type your username each time');
    } }, ), ' Remember my username on this phone'));
}
function callToggle(kind, label) {
  return h('label.toggle', h('input', { type: 'checkbox', checked: S.settings.calls?.[kind] !== false, 'data-testid': `allow-${kind}`, onchange: async (e) => {
    S.settings.calls = { ...(S.settings.calls || {}), [kind]: e.target.checked };
    await S.vault.putRecord('settings', S.settings);
    await saveProfile(); // tells contacts to show/hide the button
    toast(`${kind === 'voice' ? 'Voice' : 'Video'} calls ${e.target.checked ? 'allowed' : 'turned off'}`);
  } }), ` ${label}`);
}

VIEWS.settings = () => {
  const nameIn = h('input', { type: 'text', value: S.profile.name, maxlength: 40, 'aria-label': 'Display name' });
  const lockSel = h('select', { 'aria-label': 'Auto-lock' }, LOCK_OPTIONS.map(([v, l]) => h('option', { value: v, selected: S.settings.autoLockMin === v }, l)));
  const wipeSel = h('select', { 'aria-label': 'Wipe after failed attempts' });
  Vault.meta(SLOTS.a).then((m) => m?.wipeAfter ?? 0).then((n) => {
    const opts = WIPE_OPTIONS.some(([v]) => v === n) ? WIPE_OPTIONS : [...WIPE_OPTIONS, [n, `After ${n} wrong tries`]]; // keep an older choice visible
    for (const [v, l] of opts) wipeSel.append(h('option', { value: v, selected: n === v }, l));
  });
  const oldP = h('input', { type: 'password', placeholder: 'Current passphrase', autocomplete: 'current-password' });
  const newP = h('input', { type: 'password', placeholder: `New passphrase (${MIN_PASSPHRASE}+ chars)`, autocomplete: 'new-password' });
  const fp = h('code.small', { 'data-testid': 'build-fp' }, 'unavailable');
  fetch('./build-info.json').then((r) => r.json()).then((b) => { fp.textContent = b.fingerprint; }).catch(() => {});
  const myId = h('code.small', '…');
  contactId(S.vault.identity.publicRaw).then((x) => { myId.textContent = x.match(/.{4}/g).slice(0, 4).join(' '); });
  const sw = h('span', { 'data-testid': 'offline-status' }, navigator.serviceWorker?.controller ? 'Installed — works with no network'
    : offlineError || 'Not installed yet (reload once while online)');

  return h('div.screen.full',
    header('Settings', { back: () => go('home') }),
    h('div.panel',
      h('h2', 'You'),
      profileEditor(nameIn),
      h('p.hint', 'Identity key: ', myId),

      h('h2', 'Calls'),
      callToggle('voice', 'Allow voice calls'),
      callToggle('video', 'Allow video calls'),
      h('p.hint', 'When off, your contacts don’t see the call button, and calls are refused even if someone tries. You can also block calls from one person in their contact info.'),
      h('label.toggle', h('input', { type: 'checkbox', checked: S.settings.calls?.hideIp !== false, 'data-testid': 'hide-ip', onchange: async (e) => {
        S.settings.calls = { ...(S.settings.calls || {}), hideIp: e.target.checked }; await S.vault.putRecord('settings', S.settings);
      } }), ' Hide my IP address on internet calls'),
      h('p.hint', 'On: calls go through the encrypted relay, so the other person never learns your IP address (slightly more delay). Off: a direct connection when possible. Calls are end-to-end encrypted either way. Nearby calls without internet are always direct.'),

      h('h2', 'Security'),
      h('label', 'Auto-lock after inactivity'),
      h('div.row', lockSel, h('button', { onclick: async () => { S.settings.autoLockMin = +lockSel.value; await S.vault.putRecord('settings', S.settings); toast('Saved'); } }, 'Save')),
      h('label', 'Wrong passphrase protection'),
      h('p.hint', 'After 4 wrong tries Murmur makes you wait — 30 s, then 1 min, 5 min, 15 min, 1 hour — like an iPhone. Only someone holding this phone can even try: there is no online login to attack. Erasing is optional: it stops a thief, but anyone who picks up your phone could also trigger it on purpose.'),
      h('label', 'Erase everything after wrong passphrases'),
      h('div.row', wipeSel, h('button', { onclick: async () => { await Vault.setWipeAfterOn(SLOTS.a, +wipeSel.value); await Vault.setWipeAfterOn(SLOTS.b, +wipeSel.value); toast('Saved'); } }, 'Save')),
      h('p.hint', 'Neither the waits nor erasing can stop someone who copies the encrypted data off the phone first — a long passphrase is your real protection.'),
      h('label', 'Change passphrase'),
      oldP, newP,
      h('button', { onclick: async () => {
        try {
          if (await opensOther(store, S.slot, newP.value)) throw new Error('Pick a different passphrase');
          await S.vault.changePassphrase(oldP.value, newP.value);
          const np = newP.value; oldP.value = newP.value = ''; toast('Passphrase changed', 'success');
          rekeyOnlineBackup(np).catch((e) => toast(`Online backup: ${e.message}`, 'error')); }
        catch (e) { toast(e instanceof WrongPassphraseError ? 'Current passphrase is wrong' : e.message, 'error'); }
      } }, 'Change passphrase'),

      duressSection(),
      backupSection(),

      h('h2', 'Messages'),
      h('label', { for: 'voice-send' }, 'Voice messages'),
      h('select#voice-send', { 'data-testid': 'voice-send', onchange: async (e) => {
        S.settings.voiceSend = e.target.value; await S.vault.putRecord('settings', S.settings);
        toast(e.target.value === 'release' ? 'Voice messages send when you let go' : 'You’ll hear each voice message before it sends');
      } },
        h('option', { value: 'review', selected: S.settings.voiceSend !== 'release' }, 'Listen first, then tap Send'),
        h('option', { value: 'release', selected: S.settings.voiceSend === 'release' }, 'Send as soon as I let go (walkie-talkie)')),
      h('p.hint', 'Photos, videos and files always show a preview with a Send button, so a wrong tap never sends anything.'),
      h('label.toggle', h('input', { type: 'checkbox', checked: S.settings.readReceipts !== false, 'data-testid': 'read-receipts', onchange: async (e) => {
        S.settings.readReceipts = e.target.checked; await S.vault.putRecord('settings', S.settings);
        toast(e.target.checked ? 'Read receipts on' : 'Read receipts off — you won’t send or see blue ticks');
      } }), ' Read receipts'),
      h('p.hint', 'Blue ✓✓ when someone has opened your message, and they see the same from you. Off: you don’t send them and don’t see them (like WhatsApp). You can choose differently for one person in their contact info. Groups show delivery only.'),

      h('h2', 'Internet mode'),
      h('p', { 'data-testid': 'internet-status' }, S.remote ? (S.relayOnline ? 'On — connected to the relay' : 'On — relay not reachable right now (messages wait safely on this phone)') : 'Off — nearby (same Wi-Fi) only'),
      h('p.hint', 'Lets you reach contacts who are far away. Messages are end-to-end encrypted before they leave this phone; the relay only stores unreadable data, deletes it once delivered, and erases anything unclaimed after 30 days. The relay can see when you are online and your IP address.'),
      h('button', { 'data-testid': 'toggle-internet', onclick: async () => {
        S.settings.internet = !S.remote ? true : false;
        await S.vault.putRecord('settings', S.settings);
        if (S.settings.internet) await startRemote().catch((e) => toast(e.message, 'error')); else stopRemote();
        render();
      } }, S.remote ? 'Turn off internet mode' : 'Turn on internet mode'),

      h('h2', 'This app'),
      h('p', `Murmur ${APP_VERSION} · `, sw),
      h('p.hint', 'Build fingerprint (compare with a friend to confirm you run identical code): '), fp,
      updateBanner() || h('button', { onclick: () => { checkForUpdate(); toast('Checking for a new version…'); }, 'data-testid': 'check-update' }, 'Check for update'),
      h('button', { onclick: () => go('about') }, icon('shield', 18), ' How Murmur protects you'),

      h('h2', 'Panic'),
      h('button.danger.big', { onclick: panicWipe, 'data-testid': 'panic' }, icon('trash', 18), ' Erase everything now')));
};

VIEWS.about = () => h('div.screen.full',
  header('How Murmur protects you', { back: () => go('settings') }),
  h('div.panel.prose',
    h('h2', 'What happens when you connect'),
    h('p', 'Your phones open a direct WebRTC connection on the local network. There are no STUN, TURN or signaling servers — the QR codes you scan carry everything needed, signed by each person’s identity key.'),
    h('p', 'Inside that connection Murmur runs its own handshake: fresh one-time keys (ECDH P-256), signed by your identity keys (ECDSA P-256) and bound to the connection’s certificates. Every message gets its own AES-256-GCM key, which is erased after use. Keys are re-negotiated every 100 messages or 5 minutes.'),
    h('h2', 'When you are far apart (internet mode)'),
    h('p', 'Messages go through a relay at relay.princeisgenius.com, encrypted with the Double Ratchet (the design Signal uses): every message has its own key, old keys are deleted, and a stolen phone cannot read past messages. The relay stores only unreadable data, deletes it when delivered, and erases anything unclaimed after 30 days. Names, keys and contents never reach it.'),
    h('p', 'Contacts added with a link start “not verified”: compare safety numbers on a call. Contacts you scanned in person are verified.'),
    h('h2', 'Protection from scams'),
    h('p', 'Links are never opened with one tap: Murmur shows the real website first and warns about lookalike letters, fake brand names, hidden destinations and shorteners. Files are checked by their contents: disguised programs, macro documents and fake photos are flagged, and only real photos are displayed. All checks run on this phone.'),
    h('h2', 'What is stored'),
    h('p', 'Only on this device, encrypted with a key derived from your passphrase (PBKDF2, 600,000 rounds). Your private key is held by the browser as non-extractable — even code running in this page cannot read it out.'),
    h('h2', 'What Murmur cannot protect against'),
    h('ul',
      h('li', 'A phone that is already compromised (malware, a malicious browser extension).'),
      h('li', 'Someone watching your screen, or who knows your passphrase.'),
      h('li', 'The website that first served you this app changing the code later. Install from a source you trust, and compare the build fingerprint in Settings.'),
      h('li', 'Hiding that two phones talked: people on the same Wi-Fi — or the relay, in internet mode — can see that a connection happened (not what was said).'),
      h('li', 'Every scam: a brand-new website can look completely normal. Never type passwords or codes after following a link from a chat.'))));

async function panicWipe() {
  const ok = await modal({
    title: 'Erase everything?',
    body: ['This permanently deletes your identity key, contacts and messages from this device. There is no undo and no backup.'],
    actions: [['Cancel', false], ['Erase', true, 'danger']],
  });
  if (!ok) return;
  const r = S.remote; stopRemote();
  await r?.idle().catch(() => {}); // let in-flight writes finish before the database is deleted
  for (const conv of S.convs.values()) conv.close('wiped');
  S.vault?.lock();
  await store.destroy();
  store.destroyed = false; // a fresh vault may be created after this
  Object.assign(S, { vault: null, contacts: new Map(), chats: new Map(), convs: new Map() });
  go('welcome');
  toast('Erased.');
}

addEventListener('beforeunload', () => { for (const conv of S.convs.values()) conv.close('page closed'); });
boot();
