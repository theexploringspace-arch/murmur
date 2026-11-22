// app.js — Murmur's UI controller. Views are plain functions that rebuild
// #app from state. All persistence goes through the encrypted Vault.

import { Vault, WrongPassphraseError, VaultWipedError, MIN_PASSPHRASE } from './core/vault.js';
import { IdbStore } from './core/storage.js';
import { Conversation, MAX_FILE, APP_VERSION } from './core/conversation.js';
import { contactId, safetyNumber } from './core/identity.js';
import { toQrText, toPasteText, fromText, PairingError, clampName } from './core/pairing.js';
import { toB64u, fromB64u, equal } from './core/bytes.js';
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
};

// ---------------------------------------------------------------- utilities
const displayName = (c) => c.alias || c.name || 'Unknown';
const isOnline = (id) => S.convs.get(id)?.state === 'connected';

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
  if (await Vault.exists(store)) go('unlock'); else go('welcome');
}

async function openVault(vault) {
  S.vault = vault;
  S.profile = await vault.getRecord('profile', { name: '' });
  S.settings = { autoLockMin: 5, ...(await vault.getRecord('settings', {})) };
  S.contacts = new Map((await vault.getRecord('contacts', [])).map((c) => [c.id, c]));
  S.chats = new Map();
  for (const c of S.contacts.values()) if (c.keepHistory) S.chats.set(c.id, await vault.getRecord(`history/${c.id}`, []));
  S.lastActivity = Date.now();
  go('home');
}

function lock(reason) {
  for (const conv of S.convs.values()) conv.close('locked');
  for (const msgs of S.chats.values()) for (const m of msgs) if (m.file?.url) URL.revokeObjectURL(m.file.url);
  S.vault?.lock();
  Object.assign(S, { vault: null, profile: null, settings: null, contacts: new Map(), chats: new Map(), convs: new Map(), unread: new Map(), typing: new Map() });
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
    else if (S.vault && hiddenAt && Date.now() - hiddenAt > S.settings.autoLockMin * 60000) lock('Locked while you were away');
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

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
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
  if (m.dir === 'in' && !(S.view === 'chat' && S.viewArgs[0] === cid && !document.hidden)) S.unread.set(cid, (S.unread.get(cid) || 0) + 1);
  persistHistory(cid).catch(() => {});
  if (S.view === 'chat' && S.viewArgs[0] === cid) appendBubble(m); else rerenderIf('home');
}

/** Called once a Conversation is connected: bind it to a (possibly new) contact. */
async function adoptConversation(conv) {
  const pub = conv.peer.publicRaw;
  const id = await contactId(pub);
  let c = S.contacts.get(id);
  if (!c) {
    c = { id, pub: toB64u(pub), name: conv.peer.name, alias: '', addedAt: Date.now(), keepHistory: false, ttl: 0 };
    S.contacts.set(id, c);
    await persistContacts();
  }
  const old = S.convs.get(id);
  if (old && old !== conv) old.close('replaced by new connection');
  S.convs.set(id, conv);
  conv.on('message', (m) => addMessage(id, { ...m, dir: 'in' }))
    .on('file', (f) => addMessage(id, { id: f.id, dir: 'in', ts: f.ts, ttl: f.ttl, file: { name: f.name, mime: f.mime, size: f.size, url: URL.createObjectURL(f.blob) } }))
    .on('file-start', (f) => { if (S.view === 'chat' && S.viewArgs[0] === id) setStatusLine(`Receiving ${f.name}…`); })
    .on('file-progress', (_fid, got, size) => { if (S.view === 'chat' && S.viewArgs[0] === id) setStatusLine(`Receiving… ${Math.round((got / size) * 100)}%`); })
    .on('ack', (mid) => {
      const m = (S.chats.get(id) || []).find((x) => x.id === mid && x.dir === 'out');
      if (m) { m.status = 'delivered'; const el = document.querySelector(`[data-mid="${mid}"] .status`); if (el) el.textContent = '✓✓'; persistHistory(id).catch(() => {}); }
    })
    .on('typing', (on) => { S.typing.set(id, on); const el = document.getElementById('typing'); if (el) el.hidden = !on; })
    .on('hello', () => rerenderIf('chat', () => S.viewArgs[0] === id))
    .on('error', (e) => toast(e.message, 'error', 6000))
    .on('closed', (why) => {
      if (S.convs.get(id) === conv) S.convs.delete(id);
      if (S.vault) { rerenderIf('chat', () => S.viewArgs[0] === id); rerenderIf('home'); }
      if (why === 'peer left' || why === 'channel closed' || why === 'failed') toast(`${displayName(c)} disconnected`);
    });
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
        h('button.icon', { onclick: () => go('settings'), 'aria-label': 'Settings', 'data-testid': 'settings' }, icon('gear')),
        h('button.icon', { onclick: () => lock(), 'aria-label': 'Lock', 'data-testid': 'lock' }, icon('lock')),
      ],
    }),
    h('section.pair-actions',
      h('button.tile', { onclick: () => go('invite'), 'data-testid': 'invite' }, icon('qr', 30), h('span', 'Show my code'), h('small', 'Start a new chat')),
      h('button.tile', { onclick: () => go('join'), 'data-testid': 'join' }, icon('scan', 30), h('span', 'Scan a code'), h('small', 'Join a friend’s chat'))),
    h('p.netnote', icon('info', 16), ' Both phones must be on the same Wi-Fi or hotspot. Internet is not needed.'),
    list.length
      ? h('ul.contacts', list.map((c) => h('li', h('button.contact', { onclick: () => { S.unread.delete(c.id); go('chat', c.id); }, 'data-testid': `contact-${displayName(c)}` },
        h('span.avatar', { 'data-online': isOnline(c.id) }, displayName(c).slice(0, 1).toUpperCase()),
        h('span.cname', displayName(c)),
        h('span.cstate', isOnline(c.id) ? 'connected' : 'offline'),
        S.unread.get(c.id) ? h('span.badge', String(S.unread.get(c.id))) : null))))
      : h('div.empty', h('p', 'No contacts yet.'), h('p', 'Meet up, tap ', h('strong', 'Show my code'), ', and let your friend scan it.')));
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
    clear(scanArea).append(h('div.camwrap', video, h('div.reticle')), h('p.hint', `Point the camera at the ${what} code`));
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

function bubble(m) {
  const body = [];
  if (m.text != null) body.push(h('div.text', m.text));
  if (m.file) {
    if (/^image\/(png|jpeg|gif|webp)$/.test(m.file.mime) && m.file.url) body.push(h('img.attach', { src: m.file.url, alt: m.file.name }));
    body.push(m.file.url ? h('a.file', { href: m.file.url, download: m.file.name }, icon('clip', 16), ` ${m.file.name} · ${fmtBytes(m.file.size)}`) : h('span.file', m.file.name));
  }
  return h(`div.msg.${m.dir}`, { 'data-mid': m.id, 'data-testid': `msg-${m.dir}` },
    ...body,
    h('div.meta', fmtTime(m.ts),
      m.expiresAt ? h('span.ttl', icon('timer', 12), h('span', { 'data-expires': m.expiresAt })) : null,
      m.dir === 'out' ? h('span.status', m.status === 'delivered' ? '✓✓' : m.status === 'failed' ? '!' : '✓') : null));
}

function appendBubble(m) {
  const log = document.getElementById('log');
  if (!log) return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  document.querySelector('#log .empty')?.remove();
  log.append(bubble(m));
  if (nearBottom || m.dir === 'out') log.scrollTop = log.scrollHeight;
  purgeExpired();
}

VIEWS.chat = (id) => {
  const c = S.contacts.get(id);
  if (!c) return VIEWS.home();
  S.unread.delete(id);
  const conv = S.convs.get(id);
  const online = isOnline(id);
  const msgs = S.chats.get(id) || [];
  const log = h('div#log.log', { 'aria-live': 'polite', 'data-testid': 'log' },
    msgs.length ? msgs.map(bubble) : h('p.empty', online ? 'Say hi. Messages are end-to-end encrypted.' : 'Not connected.'));
  const input = h('textarea#compose', { rows: 1, placeholder: online ? 'Message' : 'Reconnect to send', disabled: !online, maxlength: 8000, 'data-testid': 'compose', 'aria-label': 'Message' });
  const fileIn = h('input', { type: 'file', hidden: true, 'data-testid': 'file-input' });
  let typingSent = false, typingTimer = 0;

  const send = async () => {
    const text = input.value;
    if (!text.trim() || !isOnline(id)) return;
    input.value = ''; input.style.height = '';
    try {
      const m = await conv.sendText(text, c.ttl);
      addMessage(id, { ...m, dir: 'out', status: 'sent' });
    } catch (e) { toast(e.message, 'error'); input.value = text; }
    if (typingSent) { conv.setTyping(false); typingSent = false; }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer:fine)').matches) { e.preventDefault(); send(); } });
  input.addEventListener('input', () => {
    input.style.height = ''; input.style.height = `${Math.min(140, input.scrollHeight)}px`;
    if (!typingSent && input.value) { conv?.setTyping(true); typingSent = true; }
    clearTimeout(typingTimer); typingTimer = setTimeout(() => { if (typingSent) { conv?.setTyping(false); typingSent = false; } }, 2500);
  });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0]; fileIn.value = '';
    if (!f) return;
    if (f.size > MAX_FILE) { toast(`Max ${fmtBytes(MAX_FILE)} per file`, 'error'); return; }
    try {
      setStatusLine(`Sending ${f.name}…`);
      const meta = await conv.sendFile(f, c.ttl, (s, t) => setStatusLine(`Sending… ${Math.round((s / t) * 100)}%`));
      addMessage(id, { id: meta.id, dir: 'out', ts: meta.ts, ttl: meta.ttl, status: 'sent', file: { name: meta.name, mime: meta.mime, size: meta.size, url: URL.createObjectURL(meta.blob) } });
      setStatusLine('');
    } catch (e) { toast(e.message, 'error'); }
  });

  const ttlSel = h('select', { 'aria-label': 'Disappearing messages', 'data-testid': 'ttl', onchange: async (e) => { c.ttl = +e.target.value; await persistContacts(); toast(c.ttl ? `New messages disappear after ${TTL_OPTIONS.find(([v]) => v === c.ttl)[1]}` : 'Disappearing messages off'); } },
    TTL_OPTIONS.map(([v, l]) => h('option', { value: v, selected: c.ttl === v }, l)));

  const view = h('div.screen.chat',
    header(displayName(c), {
      back: () => go('home'),
      actions: [h('span.pill', { 'data-online': online, 'data-testid': 'conn-state' }, online ? 'connected' : 'offline'),
        h('button.icon', { onclick: () => go('contact', id), 'aria-label': 'Contact info', 'data-testid': 'contact-info' }, icon('info'))],
    }),
    online ? null : h('div.reconnect',
      h('p', 'Meet up on the same Wi-Fi or hotspot to reconnect:'),
      h('div.share',
        h('button.primary', { onclick: () => go('invite', id), 'data-testid': 'reconnect-invite' }, icon('qr', 18), ' Show my code'),
        h('button', { onclick: () => go('join', id), 'data-testid': 'reconnect-join' }, icon('scan', 18), ' Scan theirs'))),
    log,
    h('p#typing.typing', { hidden: !S.typing.get(id) }, `${displayName(c)} is typing…`),
    h('p#chatstatus.chatstatus', { hidden: true }),
    h('form.composer', { onsubmit: (e) => { e.preventDefault(); send(); } },
      h('button.icon', { type: 'button', onclick: () => fileIn.click(), disabled: !online, 'aria-label': 'Attach file', 'data-testid': 'attach' }, icon('clip')),
      input, fileIn,
      h('label.ttlwrap', { title: 'Disappearing messages' }, icon('timer', 18), ttlSel),
      h('button.icon.send', { type: 'submit', disabled: !online, 'aria-label': 'Send', 'data-testid': 'send' }, icon('send'))));
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; if (online) input.focus(); });
  return view;
};

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
      h('p', 'Compare these digits with ', h('strong', c.name), '’s screen. If they match, nobody is intercepting you. (You verified in person when you scanned their code.)'),
      sn,
      h('h2', 'Nickname'),
      h('div.row', alias, h('button', { onclick: async () => { c.alias = clampName(alias.value); await persistContacts(); toast('Saved'); } }, 'Save')),
      h('h2', 'History'),
      h('label.toggle', keep, ' Keep encrypted history on this device'),
      h('p.hint', 'Off (default): messages exist only in memory and vanish when you lock or close Murmur. On: stored encrypted with your passphrase. Files and disappearing messages are never stored.'),
      h('button', { onclick: async () => { c.keepHistory = keep.checked; await persistContacts(); await persistHistory(id); toast(c.keepHistory ? 'History will be kept (encrypted)' : 'History deleted from storage'); } }, 'Apply'),
      h('h2', 'Danger zone'),
      h('div.share',
        h('button', { onclick: async () => { S.chats.set(id, []); await persistHistory(id); toast('Conversation cleared'); } }, icon('trash', 18), ' Clear conversation'),
        h('button.danger', { onclick: async () => {
          if (!(await modal({ title: `Delete ${displayName(c)}?`, body: 'This removes the contact, their key and all history from this device.', actions: [['Cancel', false], ['Delete', true, 'danger']] }))) return;
          S.convs.get(id)?.close('deleted');
          S.contacts.delete(id); S.chats.delete(id);
          await persistContacts(); await S.vault.deleteRecord(`history/${id}`);
          go('home');
        } }, 'Delete contact'))));
};

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
  const sw = h('span', navigator.serviceWorker?.controller ? 'Installed — works with no network' : 'Not installed yet (reload once while online)');

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
    h('h2', 'What is stored'),
    h('p', 'Only on this device, encrypted with a key derived from your passphrase (PBKDF2, 600,000 rounds). Your private key is held by the browser as non-extractable — even code running in this page cannot read it out.'),
    h('h2', 'What Murmur cannot protect against'),
    h('ul',
      h('li', 'A phone that is already compromised (malware, a malicious browser extension).'),
      h('li', 'Someone watching your screen, or who knows your passphrase.'),
      h('li', 'The website that first served you this app changing the code later. Install from a source you trust, and compare the build fingerprint in Settings.'),
      h('li', 'Hiding that two phones talked: people on the same Wi-Fi can see that a connection happened (not what was said).'))));

async function panicWipe() {
  const ok = await modal({
    title: 'Erase everything?',
    body: ['This permanently deletes your identity key, contacts and messages from this device. There is no undo and no backup.'],
    actions: [['Cancel', false], ['Erase', true, 'danger']],
  });
  if (!ok) return;
  for (const conv of S.convs.values()) conv.close('wiped');
  S.vault?.lock();
  await store.destroy();
  Object.assign(S, { vault: null, contacts: new Map(), chats: new Map(), convs: new Map() });
  go('welcome');
  toast('Erased.');
}

addEventListener('beforeunload', () => { for (const conv of S.convs.values()) conv.close('page closed'); });
boot();
