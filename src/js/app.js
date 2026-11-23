// app.js — Murmur's UI controller. Views are plain functions that rebuild
// #app from state. All persistence goes through the encrypted Vault.

import { Vault, WrongPassphraseError, VaultWipedError, MIN_PASSPHRASE } from './core/vault.js';
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
import { toB64u, fromB64u, equal, toHex } from './core/bytes.js';
import { encodeQR } from './qr/encode.js';
import { Scanner, decodeImageFile } from './qr/scanner.js';
import { h, clear, icon, qrSvg, toast, fmtTime, fmtBytes } from './ui/dom.js';
import { scriptUrl } from './ui/trusted.js';

const $app = document.getElementById('app');
const store = new IdbStore();

const TTL_OPTIONS = [[0, 'Off'], [30, '30 seconds'], [300, '5 minutes'], [3600, '1 hour'], [86400, '1 day']];
const LOCK_OPTIONS = [[1, '1 minute'], [5, '5 minutes'], [15, '15 minutes'], [60, '1 hour']];
const WIPE_OPTIONS = [[0, 'Never'], [5, 'After 5 wrong tries'], [10, 'After 10 wrong tries'], [20, 'After 20 wrong tries']];

/** In-memory state. Everything here disappears on lock. */
const S = {
  vault: null, profile: null, settings: null,
  contacts: new Map(),   // id → {id, pub, name, alias, addedAt, keepHistory, ttl}
  chats: new Map(),      // id → [message]
  convs: new Map(),      // id → Conversation (live)
  unread: new Map(),
  typing: new Map(),
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
const REMOTE_CHUNK = 192 * 1024;

function go(view, ...args) {
  stopScanner();
  S.view = view; S.viewArgs = args;
  render();
}
function render() {
  const v = VIEWS[S.view];
  clear($app).append(v(...(S.viewArgs || [])));
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
async function persistHistory(id) {
  const c = S.contacts.get(id);
  if (!c) return;
  if (!c.keepHistory) { await S.vault.deleteRecord(`history/${id}`); return; }
  const msgs = (S.chats.get(id) || []).filter((m) => m.text != null && !m.ttl).map(({ id: mid, dir, ts, text, status }) => ({ id: mid, dir, ts, text, status }));
  await S.vault.putRecord(`history/${id}`, msgs.slice(-2000));
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
  if (await Vault.exists(store)) go('unlock'); else go('welcome');
}

async function openVault(vault) {
  S.vault = vault;
  S.profile = await vault.getRecord('profile', { name: '' });
  S.settings = { autoLockMin: 5, ...(await vault.getRecord('settings', {})) };
  S.contacts = new Map((await vault.getRecord('contacts', [])).map((c) => [c.id, c]));
  S.chats = new Map();
  S.myCid = await contactId(vault.identity.publicRaw);
  S.groups = new Map((await vault.getRecord('groups', [])).map((g) => [g.id, g]));
  for (const c of S.contacts.values()) {
    if (c.verified === undefined) c.verified = !c.remote; // contacts from before internet mode were all paired in person
    if (c.keepHistory) S.chats.set(c.id, await vault.getRecord(`history/${c.id}`, []));
  }
  S.lastActivity = Date.now();
  await startRemote().catch((e) => toast(`Internet mode unavailable: ${e.message}`, 'error'));
  if (S.pendingInvite) { const t = S.pendingInvite; S.pendingInvite = null; go('acceptinvite', t); } else go('home');
}

// ---------------------------------------------------------------- internet mode
async function startRemote() {
  if (S.settings.internet === false || S.remote) return;
  const r = new Remote({ vault: S.vault, identity: S.vault.identity, relayUrl: RELAY_URL, origin: location.origin, getName: () => S.profile.name });
  await r.load();
  S.remote = r;
  r.on('status', (v) => { S.relayOnline = v; rerenderIf('home'); rerenderIf('chat'); rerenderIf('settings'); })
    .on('message', (cid, m) => onRemoteMessage(cid, m).catch((e) => console.warn(e)))
    .on('joined', (j) => onRemoteJoined(j).catch((e) => console.warn(e)))
    .on('sent', (cid, mid) => setMsgStatus(cid, mid, 'sent'))
    .on('send-failed', (cid, mid, why) => { setMsgStatus(cid, mid, 'failed'); toast(why, 'error', 6000); })
    .on('warning', (w) => console.warn('relay:', w));
  r.start();
}
function stopRemote() { S.remote?.stop(); S.remote = null; S.relayOnline = false; }

function setMsgStatus(cid, mid, status) {
  const m = (S.chats.get(cid) || []).find((x) => x.id === mid && x.dir === 'out');
  if (!m) { if (status === 'delivered') groupAck(cid, mid); return; }
  if (m.status === 'delivered') return;
  m.status = status;
  const el = document.querySelector(`[data-mid="${mid}"] .status`);
  if (el) el.textContent = STATUS_MARK[status] || '';
  persistHistory(cid).catch(() => {});
}
const markDelivered = (cid, mid) => setMsgStatus(cid, mid, 'delivered');
const STATUS_MARK = { queued: '○', sent: '✓', delivered: '✓✓', failed: '!' };

async function onRemoteJoined({ cid, name, pub }) {
  let c = S.contacts.get(cid);
  if (!c) {
    c = { id: cid, pub: toB64u(pub), name, alias: '', addedAt: Date.now(), keepHistory: false, ttl: 0, remote: true, verified: false, request: true };
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
      addMessage(cid, { id: m.id.slice(0, 32), dir: 'in', ts: +m.ts || Date.now(), text: m.text, ttl: Math.max(0, m.ttl | 0) });
      S.remote.send(cid, { t: 'ack', id: m.id }).catch(() => {});
      break;
    case 'ack': markDelivered(cid, String(m.id)); break;
    case 'file': {
      if (!(m.size >= 0 && m.size <= MAX_FILE) || !(m.chunks >= 1 && m.chunks <= Math.ceil(MAX_FILE / REMOTE_CHUNK) + 1)) return;
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
  return { ...base, file: { name: safety.name, mime, size: bytes.length, url: URL.createObjectURL(new Blob([bytes], { type })), safety, playable, kind } };
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
  for (const msgs of S.chats.values()) for (const m of msgs) if (m.file?.url) URL.revokeObjectURL(m.file.url);
  S.vault?.lock();
  Object.assign(S, { vault: null, profile: null, settings: null, contacts: new Map(), chats: new Map(), convs: new Map(), unread: new Map(), typing: new Map(), rfiles: new Map(), groups: new Map(), myCid: null, myLoc: null });
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
    else S.remote?.kick();
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
      for (const m of msgs) if (m.expiresAt && m.expiresAt <= now && m.file?.url) URL.revokeObjectURL(m.file.url);
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

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'murmur-offline-error') return;
    offlineError = explainOfflineError(String(e.data.message));
    toast(offlineError, 'error', 15000);
    rerenderIf('settings');
  });
  try { await navigator.serviceWorker.register(scriptUrl('./sw.js'), { scope: './' }); }
  catch (e) { console.warn('Service worker not registered (offline use unavailable):', e.message); }
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
  if (open) appendBubble(m, cid); else rerenderIf('home');
}
const isOpenChat = (key) => (S.view === 'chat' && S.viewArgs[0] === key) || (S.view === 'group' && `g:${S.viewArgs[0]}` === key);

/** Called once a Conversation is connected: bind it to a (possibly new) contact. */
async function adoptConversation(conv) {
  const pub = conv.peer.publicRaw;
  const id = await contactId(pub);
  let c = S.contacts.get(id);
  if (!c) {
    c = { id, pub: toB64u(pub), name: conv.peer.name, alias: '', addedAt: Date.now(), keepHistory: false, ttl: 0 };
    S.contacts.set(id, c);
  }
  // Scanning each other's codes face to face IS verification.
  c.verified = true; c.request = false; delete c.lookalike;
  await persistContacts();
  const old = S.convs.get(id);
  if (old && old !== conv) old.close('replaced by new connection');
  S.convs.set(id, conv);
  conv.on('message', (m) => addMessage(id, { ...m, dir: 'in' }))
    .on('file', async (f) => receivedFile(id, { id: f.id, ts: f.ts, ttl: f.ttl }, f.name, f.mime, new Uint8Array(await f.blob.arrayBuffer()), f))
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
  h('button.primary.big', { onclick: () => go('create'), 'data-testid': 'get-started', autofocus: true }, 'Get started'));

VIEWS.create = () => {
  const name = h('input#name', { type: 'text', maxlength: 40, autocomplete: 'off', placeholder: 'e.g. Sam', 'data-testid': 'name', autofocus: true });
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
      if (p1.value.length < MIN_PASSPHRASE) { err.textContent = `Passphrase must be at least ${MIN_PASSPHRASE} characters.`; return; }
      if (p1.value !== p2.value) { err.textContent = 'Passphrases don’t match.'; return; }
      btn.disabled = true; btn.textContent = 'Creating keys…';
      try {
        const v = await Vault.create(store, p1.value);
        await v.putRecord('profile', { name: nm });
        await v.putRecord('settings', { autoLockMin: 5 });
        p1.value = p2.value = '';
        await openVault(v);
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Create my keys'; }
    },
  },
  h('h1', 'Set up this device'),
  h('label', { for: 'name' }, 'Your display name'), name,
  h('small.hint', 'Shown to people you connect with. Not unique, not an account.'),
  h('label', { for: 'p1' }, 'Passphrase'), p1, meter, meterLabel,
  h('label', { for: 'p2' }, 'Confirm passphrase'), p2,
  h('div.callout.warn', h('strong', 'There is no “forgot passphrase”. '),
    'Your passphrase encrypts everything on this device and is never stored. Lose it and the data is gone — by design.'),
  err, btn);
  return form;
};

VIEWS.unlock = () => {
  const p = h('input#pass', { type: 'password', autocomplete: 'current-password', 'data-testid': 'unlock-pass', autofocus: true });
  const err = h('p.error', { role: 'alert' });
  const btn = h('button.primary.big', { type: 'submit', 'data-testid': 'unlock' }, 'Unlock');
  return h('form.screen.narrow.center', {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; btn.disabled = true; btn.textContent = 'Unlocking…';
      try { const v = await Vault.unlock(store, p.value); p.value = ''; await openVault(v); }
      catch (ex) {
        btn.disabled = false; btn.textContent = 'Unlock'; p.value = ''; p.focus();
        if (ex instanceof VaultWipedError) { toast('Too many wrong passphrases. Everything was erased.', 'error', 8000); go('welcome'); return; }
        if (ex instanceof WrongPassphraseError) err.textContent = Number.isFinite(ex.attemptsLeft) ? `Wrong passphrase. ${ex.attemptsLeft} tries left before this device is wiped.` : 'Wrong passphrase.';
        else err.textContent = ex.message;
      }
    },
  },
  h('div.brand', h('div.logo', icon('lock', 40)), h('h1', 'Murmur is locked')),
  h('label', { for: 'pass' }, 'Passphrase'), p, err, btn,
  h('button.link', { type: 'button', onclick: panicWipe, 'data-testid': 'forgot' }, 'Forgot it? Erase this device and start over'));
};

function header(title, { back, actions = [] } = {}) {
  return h('header.bar',
    back ? h('button.icon', { onclick: back, 'aria-label': 'Back', 'data-testid': 'back' }, icon('back')) : h('div.logo.sm', icon('shield', 20)),
    h('h1', title),
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
        h('span.avatar', { 'data-online': isOnline(c.id) }, displayName(c).slice(0, 1).toUpperCase()),
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
        if (!c) { c = { id: cid, pub: toB64u(info.pub), name: info.name, alias: '', addedAt: Date.now(), keepHistory: false, ttl: 0, remote: true, verified: false, request: false }; S.contacts.set(cid, c); }
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
  clearTimeout(statusTimer); statusTimer = setTimeout(() => { el.hidden = true; }, 4000);
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
  const a = h('a', { href: m.file.url, download: m.file.name, hidden: true }); document.body.append(a); a.click(); a.remove();
}

function richText(m, cid) {
  return h('div.text', linkify(m.text).map((seg) => (seg.type === 'text' ? seg.text
    : h(`button.inlink.risk-${seg.analysis.risk}`, { type: 'button', 'data-testid': 'link', onclick: () => checkLink(seg, cid, m.dir) }, seg.text))));
}

function bubble(m, key = S.viewArgs?.[0]) {
  if (m.system) return h('p.sysmsg', { 'data-mid': m.id }, m.text);
  const cid = m.from || key; // in groups, safety decisions use the actual sender
  const body = [];
  if (m.from && m.dir === 'in' && String(key).startsWith('g:')) body.push(h('div.sender', { 'data-testid': 'sender' }, memberName(S.groups.get(String(key).slice(2)), m.from)));
  if (m.sos) body.push(sosCard(m));
  if (m.loc) body.push(locCard(m));
  if (m.text != null) body.push(richText(m, cid));
  if (m.file) {
    const sf = m.file.safety;
    if (m.file.url && sf?.inline) body.push(h('img.attach', { src: m.file.url, alt: m.file.name }));
    if (m.file.url && m.file.playable === 'audio') body.push(h('audio', { controls: true, preload: 'metadata', src: m.file.url, 'data-testid': m.file.kind === 'voice' ? 'voice-clip' : 'audio' }));
    if (m.file.url && m.file.playable === 'video') body.push(h('video.attach', { controls: true, playsinline: true, preload: 'metadata', src: m.file.url, 'data-testid': 'video' }));
    if (sf && sf.verdict !== 'ok') body.push(h(`p.filewarn.${sf.verdict}`, { 'data-testid': 'file-warning' }, icon('alert', 14), ` ${sf.reasons[0]}`));
    body.push(m.file.url ? h('button.file', { type: 'button', onclick: () => saveFile(m, cid), 'data-testid': 'file', 'data-blob': m.file.url }, icon('clip', 16), ` ${m.file.name} · ${fmtBytes(m.file.size)}`) : h('span.file', m.file.name));
  }
  return h(`div.msg.${m.dir}`, { 'data-mid': m.id, 'data-testid': `msg-${m.dir}` },
    ...body,
    h('div.meta', fmtTime(m.ts),
      m.expiresAt ? h('span.ttl', icon('timer', 12), h('span', { 'data-expires': m.expiresAt })) : null,
      m.dir === 'out' ? h('span.status', { title: m.status || 'sent' }, groupStatus(m, key)) : null));
}
function groupStatus(m, key) {
  if (!String(key).startsWith('g:') || !m.acks) return STATUS_MARK[m.status] || '✓';
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
  let typingSent = false, typingTimer = 0;
  const comp = composer({
    key: id, disabled: !online,
    placeholder: live ? 'Message' : online ? (S.relayOnline ? 'Message (via internet)' : 'Message — sends when you’re online') : hasRemote(id) ? 'Waiting for their first message…' : 'Reconnect to send',
    onText: async (text) => {
      if (text.length > MAX_TEXT) throw new Error(`Message too long (max ${MAX_TEXT} characters)`);
      if (isOnline(id)) {
        const m = await S.convs.get(id).sendText(text, c.ttl);
        addMessage(id, { ...m, dir: 'out', status: 'sent' });
      } else {
        const m = { t: 'msg', id: newId(), ts: Date.now(), text, ttl: c.ttl | 0 };
        addMessage(id, { ...m, dir: 'out', status: 'queued' });
        await S.remote.send(id, m);
      }
      if (typingSent) { S.convs.get(id)?.setTyping(false); typingSent = false; }
    },
    onFile: async (f, kind) => {
      setStatusLine(`Sending ${f.name}…`);
      const r = await deliverFile(id, f, c.ttl, (s, t) => setStatusLine(`Sending… ${Math.round((s / t) * 100)}%`), kind ? { kind } : {});
      addMessage(id, await fileMessage({ id: r.meta.id, dir: 'out', ts: r.meta.ts, ttl: r.meta.ttl, status: r.status }, r.meta.name, r.meta.mime, r.bytes, kind));
      setStatusLine('');
    },
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
      actions: [h('span.pill', { 'data-online': live, 'data-kind': linkState(id)[1], 'data-testid': 'conn-state' }, linkState(id)[0]),
        h('button.icon', { onclick: () => go('contact', id), 'aria-label': 'Contact info', 'data-testid': 'contact-info' }, icon('info'))],
    }),
    c.request ? h('div.banner.warn', { 'data-testid': 'request-banner' },
      h('p', h('strong', `${displayName(c)} joined using your invite link.`), ' Only accept if you sent the link to this person. Until then, their links and files are locked.'),
      c.lookalike ? h('p', icon('alert', 14), ` This name looks like your contact “${c.lookalike[0]}” — but it is a different key.`) : null,
      h('div.share',
        h('button.primary', { 'data-testid': 'accept-request', onclick: async () => { c.request = false; await persistContacts(); render(); } }, 'Accept'),
        h('button.danger', { onclick: () => deleteContact(id) }, 'Delete'))) : null,
    !c.request && c.remote && !c.verified ? h('div.banner', { 'data-testid': 'verify-banner' },
      h('p', icon('shield', 14), ' Not verified yet. Call them and compare safety numbers to be sure nobody swapped the invite.'),
      h('button', { onclick: () => go('contact', id) }, 'Compare numbers')) : null,
    live ? null : h(`div.reconnect${hasRemote(id) ? '.compact' : ''}`,
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
  return view;
};

// ================================================================ phase 1: media, voice, location, SOS, groups

// ---- one way to send, whichever path is available ----
/** Sends an app message to one contact: live session if connected, else the relay. → 'sent' | 'queued' */
async function deliver(cid, m) {
  if (isOnline(cid)) { await S.convs.get(cid).sendApp(m); return 'sent'; }
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
  addMessage(key, { ...(await fileMessage({ ...base, dir: 'in' }, name, mime, bytes, extra.kind)), from });
}

// ---- photos & videos: remove hidden location/camera data before sending ----
async function prepareOutgoing(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const real = inspectFile(file.name, file.type, bytes).realType;
  if (real === 'image/heic') {
    // HEIC can't be cleaned byte-by-byte here: re-draw it as a JPEG (drops all metadata).
    try {
      const bmp = await createImageBitmap(file);
      const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92));
      return { file: new File([blob], file.name.replace(/\.hei[cf]$/i, '') + '.jpg', { type: 'image/jpeg' }), note: 'Converted to JPEG and removed hidden location & camera info' };
    } catch { return { file, note: 'Couldn’t remove hidden info from this HEIC photo', warn: true }; }
  }
  if (!/^(image|video)\//.test(real)) return { file, note: null };
  const r = stripMetadata(bytes); // throws MediaError on damaged files: better to refuse than half-clean
  if (!r.stripped) return { file, note: null };
  return { file: new File([r.bytes], file.name, { type: file.type || real }), note: r.removed.length ? 'Removed hidden location & camera info' : null };
}

// ---- walkie-talkie: press and hold to talk, release to send ----
function voiceButton(onClip, disabled) {
  const btn = h('button.icon.mic', { type: 'button', disabled, 'aria-label': 'Hold to talk', 'data-testid': 'voice', title: 'Hold to talk' }, icon('mic'));
  let rec = null, stream = null, held = false, cancelled = false, started = 0, timer = 0;
  const stop = () => { clearTimeout(timer); if (rec && rec.state !== 'inactive') rec.stop(); };
  btn.addEventListener('pointerdown', async (e) => {
    e.preventDefault(); if (rec || btn.disabled) return;
    held = true; cancelled = false;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { toast('Microphone access is off for Murmur (allow it in Settings → Safari/browser)', 'error', 6000); held = false; return; }
    if (!held) { stream.getTracks().forEach((t) => t.stop()); toast('Hold the button while you talk'); return; } // released during the permission prompt
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => globalThis.MediaRecorder?.isTypeSupported?.(t)) || '';
    const chunks = [];
    rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const mime = (rec.mimeType || type || 'audio/webm').split(';')[0];
      const dur = Date.now() - started; rec = null; btn.classList.remove('rec'); setStatusLine('');
      if (!cancelled && dur > 500) onClip(new File(chunks, `voice-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm'}`, { type: mime }), dur);
      else if (!cancelled) toast('Too short — hold the button while you talk');
    };
    started = Date.now(); rec.start(250); btn.classList.add('rec');
    setStatusLine('● Recording… release to send · slide away to cancel');
    timer = setTimeout(stop, 120_000); // 2 minutes max
  });
  btn.addEventListener('pointerup', () => { held = false; stop(); });
  for (const ev of ['pointerleave', 'pointercancel']) btn.addEventListener(ev, () => { if (rec) { cancelled = true; setStatusLine('Cancelled'); } held = false; stop(); });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  return btn;
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
      addMessage(key, { id: m.id, dir: 'in', ts: +m.ts || Date.now(), loc: L, from }); ack();
      break;
    }
    case 'sos': {
      if (c.request) return; // strangers can't trigger alarms
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
      addMessage(`g:${g.id}`, { id: m.id, dir: 'in', ts: +m.ts || Date.now(), text: m.text, from }); ack();
      forwardIfAdmin(g, m, cid);
      break;
    }
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
  const comp = composer({
    key, disabled: !active,
    placeholder: active ? `Message ${g.name}` : 'You are no longer in this group',
    onText: async (text) => {
      const m = { t: 'gmsg', gid, id: newId(), ts: Date.now(), text };
      addMessage(key, { ...m, dir: 'out', status: 'sent', acks: [] });
      const r = await fanOut(g, m);
      if (r.failed.length) toast(`Couldn’t reach ${r.failed.join(', ')} yet`, 'error');
      if (r.queued && !r.sent) setMsgStatusDirect(key, m.id, 'queued');
    },
    onFile: (file, kind) => groupFile(g, file, kind),
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
function setMsgStatusDirect(key, mid, status) {
  const m = (S.chats.get(key) || []).find((x) => x.id === mid); if (!m) return;
  m.status = status; const el = document.querySelector(`[data-mid="${mid}"] .status`); if (el) el.textContent = STATUS_MARK[status];
}
async function groupFile(g, file, kind) {
  const id = newId(); let first = null; const failed = [];
  for (const cid of recipients(g, S.myCid)) {
    if (!S.contacts.has(cid)) { failed.push(memberName(g, cid)); continue; }
    try { const r = await deliverFile(cid, file, 0, (s, t) => setStatusLine(`Sending to ${memberName(g, cid)}… ${Math.round((s / t) * 100)}%`), { gid: g.id, kind, id }); first ||= r; }
    catch { failed.push(memberName(g, cid)); }
  }
  setStatusLine('');
  if (first) addMessage(`g:${g.id}`, { ...(await fileMessage({ id, dir: 'out', ts: Date.now(), status: first.status, acks: [] }, file.name, file.type, first.bytes, kind)) });
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
  const input = h('textarea#compose', { rows: 1, placeholder, disabled, maxlength: MAX_TEXT, 'data-testid': 'compose', 'aria-label': 'Message' });
  const fileIn = h('input', { type: 'file', hidden: true, 'data-testid': 'file-input' });
  const send = async () => {
    const text = input.value; if (!text.trim() || disabled) return;
    input.value = ''; input.style.height = '';
    try { await onText(text); } catch (e) { toast(e.message, 'error'); input.value = text; }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer:fine)').matches) { e.preventDefault(); send(); } });
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = `${Math.min(140, input.scrollHeight)}px`; });
  const sendFile = async (f, kind) => {
    if (f.size > MAX_FILE) { toast(`Max ${fmtBytes(MAX_FILE)} per file`, 'error'); return; }
    try {
      const prep = kind === 'voice' ? { file: f } : await prepareOutgoing(f);
      if (prep.note) toast(prep.note, prep.warn ? 'error' : 'success');
      await onFile(prep.file, kind);
    } catch (e) { setStatusLine(''); toast(e.message, 'error'); }
  };
  fileIn.addEventListener('change', () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) sendFile(f); });
  return h('form.composer', { onsubmit: (e) => { e.preventDefault(); send(); } },
    h('button.icon', { type: 'button', onclick: () => fileIn.click(), disabled, 'aria-label': 'Attach photo, video or file', 'data-testid': 'attach' }, icon('clip')),
    h('button.icon', { type: 'button', onclick: onLocation, disabled, 'aria-label': 'Share location', 'data-testid': 'share-location' }, icon('pin')),
    input, fileIn,
    voiceButton((clip) => sendFile(clip, 'voice'), disabled),
    h('button.icon.send', { type: 'submit', disabled, 'aria-label': 'Send', 'data-testid': 'send' }, icon('send')));
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
      h('p.hint', 'Off (default): messages exist only in memory and vanish when you lock or close Murmur. On: stored encrypted with your passphrase. Files and disappearing messages are never stored.'),
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
  S.contacts.delete(id); S.chats.delete(id);
  await persistContacts(); await S.vault.deleteRecord(`history/${id}`);
  go('home');
}

VIEWS.settings = () => {
  const nameIn = h('input', { type: 'text', value: S.profile.name, maxlength: 40, 'aria-label': 'Display name' });
  const lockSel = h('select', { 'aria-label': 'Auto-lock' }, LOCK_OPTIONS.map(([v, l]) => h('option', { value: v, selected: S.settings.autoLockMin === v }, l)));
  const wipeSel = h('select', { 'aria-label': 'Wipe after failed attempts' });
  S.vault.getWipeAfter().then((n) => { for (const [v, l] of WIPE_OPTIONS) wipeSel.append(h('option', { value: v, selected: n === v }, l)); });
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
      h('div.row', nameIn, h('button', { onclick: async () => { const n = clampName(nameIn.value); if (!n) return; S.profile.name = n; await S.vault.putRecord('profile', S.profile); toast('Name saved'); } }, 'Save')),
      h('p.hint', 'Identity key: ', myId),

      h('h2', 'Security'),
      h('label', 'Auto-lock after inactivity'),
      h('div.row', lockSel, h('button', { onclick: async () => { S.settings.autoLockMin = +lockSel.value; await S.vault.putRecord('settings', S.settings); toast('Saved'); } }, 'Save')),
      h('label', 'Erase everything after wrong passphrases'),
      h('div.row', wipeSel, h('button', { onclick: async () => { await S.vault.setWipeAfter(+wipeSel.value); toast('Saved'); } }, 'Save')),
      h('p.hint', 'Slows down someone who grabs your phone. It can’t stop an attacker who copies the encrypted data first — a long passphrase is your real protection.'),
      h('label', 'Change passphrase'),
      oldP, newP,
      h('button', { onclick: async () => {
        try { await S.vault.changePassphrase(oldP.value, newP.value); oldP.value = newP.value = ''; toast('Passphrase changed', 'success'); }
        catch (e) { toast(e instanceof WrongPassphraseError ? 'Current passphrase is wrong' : e.message, 'error'); }
      } }, 'Change passphrase'),

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
