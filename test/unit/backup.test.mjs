// Moving an account: backup file, online backup (username + passphrase), move-to-phone code,
// and renewing every secure link after restoring an OLDER backup.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../relay/node/server.mjs';
import { Remote } from '../../src/js/core/remote.js';
import { Vault } from '../../src/js/core/vault.js';
import { MemoryStore } from '../../src/js/core/storage.js';
import { slots, ensureSlots, setDuress, unlockAny } from '../../src/js/core/duress.js';
import { makeLogin, checkLogin } from '../../src/js/core/profile.js';
import { contactId } from '../../src/js/core/identity.js';
import * as B from '../../src/js/core/backup.js';
import { readBox, writeBox } from '../../src/js/core/relaybox.js';
import { random, concat, Writer, utf8 } from '../../src/js/core/bytes.js';
import * as INV from '../../src/js/core/invite.js';

const IT = { iterations: 1000 };
const PASS = 'correct horse battery staple';
const ORIGIN = 'http://app.test';
const relay = await startRelay({ port: 0, origins: [ORIGIN] });
after(() => relay.server.close());
const wsFactory = (u) => new WebSocket(u, { headers: { Origin: ORIGIN } });
const fetchImpl = (u, o) => fetch(u, { ...o, headers: { ...o.headers, Origin: ORIGIN } });

async function phoneWithAccount() {
  const inner = new MemoryStore();
  const v = await Vault.create(slots(inner).a, PASS, IT);
  await v.putRecord('profile', { name: 'Prince', username: 'prince' });
  await v.putRecord('contacts', [{ id: 'c1', name: 'Ada' }]);
  await v.putRecord('history/c1', [{ id: 'm1', text: 'hi', file: { name: 'p.jpg' } }]);
  await v.putRecord('media/c1/m1', { name: 'p.jpg', mime: 'image/jpeg', b: 'AAAA' });
  v.lock();
  await ensureSlots(inner, IT);
  await inner.put('login', await makeLogin('prince'));
  return inner;
}

test('backup file: everything comes back on a new phone with the passphrase — and only with it', async () => {
  const old = await phoneWithAccount();
  await setDuress(old, 'a', 'grandma birthday cake', IT);
  const pkg = await B.exportVault(slots(old).a, { login: await old.get('login') });
  assert.ok(!pkg.entries.some(([k]) => k.startsWith('b:')), 'the duress decoy is never in a backup');
  const sealed = await B.sealWithPassphrase(pkg, PASS, IT);
  assert.ok(B.isBackup(sealed));
  assert.ok(!new TextDecoder('latin1').decode(sealed).includes('history'), 'not even record names are visible');
  await assert.rejects(B.openSealed(sealed, { passphrase: 'wrong wrong wrong' }), /Wrong passphrase/);
  const bad = sealed.slice(); bad[bad.length - 5] ^= 1;
  await assert.rejects(B.openSealed(bad, { passphrase: PASS }), B.BackupError, 'tampering detected');

  const fresh = new MemoryStore();
  await B.importVault(fresh, slots(fresh).a, await B.openSealed(sealed, { passphrase: PASS }));
  await ensureSlots(fresh, IT);
  const { vault, slot } = await unlockAny(fresh, PASS);
  assert.equal(slot, 'a');
  assert.deepEqual(await vault.getRecord('contacts'), [{ id: 'c1', name: 'Ada' }]);
  assert.equal((await vault.getRecord('media/c1/m1')).b, 'AAAA', 'photos come back too');
  assert.ok(await checkLogin(await fresh.get('login'), 'prince'), 'same username works');
  assert.ok(await fresh.get('restore/pending'), 'older copy: links will be renewed after unlock');
});

test('backups without photos, and the move code format', async () => {
  const old = await phoneWithAccount();
  const pkg = await B.exportVault(slots(old).a, { includeMedia: false });
  assert.ok(!pkg.entries.some(([k]) => k.startsWith('rec/media/')));
  const code = random(32);
  assert.deepEqual(B.moveCodeFrom(`  ${B.moveCodeText(code)}  `), code);
  assert.throws(() => B.moveCodeFrom('hello'), /isn’t a Murmur move code/);
  const k1 = await B.moveKeys(code), k2 = await B.moveKeys(code);
  assert.deepEqual(k1, k2); assert.notDeepEqual(k1.box, k1.key); assert.notDeepEqual(k1.box, k1.ack);
});

test('online backup keys follow from username + passphrase only (case-insensitive username)', async () => {
  const a = await B.onlineKeys('Prince', PASS, IT), b = await B.onlineKeys('@prince', PASS, IT);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, await B.onlineKeys('prince', 'another passphrase here', IT));
  assert.notDeepEqual(a, await B.onlineKeys('princess', PASS, IT));
});

test('chunks: the newest COMPLETE backup wins; half-uploaded ones are ignored', () => {
  const bytes = (n, seed) => Uint8Array.from({ length: n }, (_v, i) => (i * 31 + seed) & 255); // random() caps at 64 KB
  const big = bytes(2 * B.CHUNK + 10, 1);
  const older = B.toChunks(random(50), { created: 1000_000 });
  const newest = B.toChunks(big, { created: 2000_000 });
  const partial = B.toChunks(bytes(B.CHUNK * 2, 2), { created: 3000_000 }).slice(0, 1);
  assert.equal(newest.length, 3);
  assert.deepEqual(B.fromChunks([...partial, ...newest.reverse(), ...older]), big);
  assert.equal(B.fromChunks([partial[0]]), null);
});

test('relay drop box: write, replace, read back — through the real relay code', async () => {
  const secret = random(32);
  await writeBox(relay.url, secret, B.toChunks(utf8('first'), { created: 1e9 }), { fetchImpl, wsFactory });
  await writeBox(relay.url, secret, B.toChunks(utf8('second'), { created: 2e9 }), { replace: true, fetchImpl, wsFactory });
  const rows = await readBox(relay.url, secret, { wsFactory });
  assert.equal(rows.length, 1, 'the old backup was deleted');
  assert.equal(new TextDecoder().decode(B.fromChunks(rows.map((r) => r.data))), 'second');
});

// ---------- renewing secure links after restoring an older backup ----------
async function phone(name, store) {
  const vault = (await Vault.exists(store)) ? await Vault.unlock(store, PASS) : await Vault.create(store, PASS, IT);
  const r = new Remote({ vault, identity: vault.identity, relayUrl: relay.url, origin: ORIGIN, getName: () => name, wsFactory, fetchImpl });
  await r.load();
  r.inbox = []; const waiters = [];
  r.on('message', (cid, m) => { r.inbox.push({ cid, m }); for (const w of waiters.splice(0)) w(); });
  for (const ev of ['joined', 'resynced', 'warning']) r.on(ev, (...a) => { (r[ev] ||= []).push(a); for (const w of waiters.splice(0)) w(); });
  r.next = (pred) => new Promise((res) => { const chk = () => (pred() ? res() : waiters.push(chk)); chk(); });
  return r;
}
const online = (r) => new Promise((res) => { if (r.online) res(); else r.on('status', (v) => v && res()); });
const texts = (r) => r.inbox.filter((x) => x.m.t === 'msg').map((x) => x.m.text);

test('restoring an OLD backup: links are renewed (only by the real identity), held messages go out, chat continues', async () => {
  const aliceStore = new MemoryStore(), bobStore = new MemoryStore();
  const alice = await phone('Alice', aliceStore), bob = await phone('Bob', bobStore);
  alice.start(); bob.start(); await online(alice); await online(bob);
  const inv = await alice.createInvite('https://m.example');
  const aliceCid = await bob.acceptInvite((await bob.inspectInvite(inv.text)).inv, { t: 'hello', name: 'Bob' });
  const bobCid = await contactId(bob.identity.publicRaw);
  await alice.next(() => alice.inbox.some((x) => x.m.t === 'hello'));
  await alice.send(bobCid, { t: 'msg', id: 'a1', text: 'before backup' });
  await bob.next(() => texts(bob).includes('before backup'));

  // Alice makes a backup… then the conversation moves on (ratchets advance on both sides).
  await alice.idle();
  const pkg = await B.exportVault(aliceStore);
  for (let i = 0; i < 3; i++) {
    await alice.send(bobCid, { t: 'msg', id: `x${i}`, text: `after ${i}` });
    await bob.send(aliceCid, { t: 'msg', id: `y${i}`, text: `reply ${i}` });
  }
  await bob.next(() => texts(bob).includes('after 2'));
  await alice.next(() => texts(alice).includes('reply 2'));
  alice.stop(); // the old phone is lost

  // New phone: restore the OLD backup, renew links, write immediately (held until renewed).
  const newStore = new MemoryStore();
  await B.importVault(newStore, slots(newStore).a, pkg);
  const a2 = await phone('Alice', slots(newStore).a);
  await a2.resyncAll();
  assert.deepEqual(a2.resyncing(), [bobCid]);
  assert.equal(a2.canSend(bobCid), true, 'you can write right away…');
  assert.equal(await a2.send(bobCid, { t: 'msg', id: 'n1', text: 'from my new phone' }), 'held', '…it waits, encrypted at rest, until the link is renewed');
  a2.start(); await online(a2);
  await bob.next(() => (bob.resynced || []).length >= 1);
  await a2.next(() => (a2.resynced || []).length >= 1);
  await bob.next(() => texts(bob).includes('from my new phone'));
  await bob.send(aliceCid, { t: 'msg', id: 'z1', text: 'welcome back' });
  await a2.next(() => texts(a2).includes('welcome back'));
  assert.deepEqual(a2.resyncing(), []);

  // Someone else can't re-key Bob's chat with Alice, and an old renewal can't be replayed.
  const mallory = await phone('Alice', new MemoryStore());
  const fake = await INV.createInvite({ identity: mallory.identity, name: 'Alice', inbox: mallory.addressBytes });
  const bobAddr = (await bob.vault.getRecord('remote')).secret && (await INV.inboxAddress(bob.secret));
  const post = (bytes) => fetchImpl(`${relay.url}/v1/inbox/${Buffer.from(bobAddr).toString('base64url')}`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
  const before = (bob.warning || []).length;
  await post(concat(Uint8Array.of(1, 6), fake.bytes));
  await bob.next(() => (bob.warning || []).length > before);
  assert.match(bob.warning.at(-1)[0], /not a contact/);
  await bob.send(aliceCid, { t: 'msg', id: 'z2', text: 'still fine' });
  await a2.next(() => texts(a2).includes('still fine'));
  a2.stop(); bob.stop(); mallory.stop();
});

// ---------------------------------------------------------------- security PIN
import { pinProblem, pinToken, pinVerifier, onlineKeys as keysFor, PIN_MIN, PIN_MAX } from '../../src/js/core/backup.js';
import { toB64u as b64 } from '../../src/js/core/bytes.js';

test('PIN rules: 6–12 digits, no repeats, runs or short patterns', () => {
  assert.equal(PIN_MIN, 6); assert.equal(PIN_MAX, 12);
  for (const ok of ['482916', '305718', '90210477', '120398475611']) assert.equal(pinProblem(ok), null, ok);
  const bad = {
    '12345': /at least 6/, '1234567890123': /at most 12/, '48a916': /digits only/, '': /digits only/,
    '000000': /same digit/, '123456': /run/, '654321': /run/, '890123': /run/, '7890123': /run/,
    '121212': /repeating/, '123123': /repeating|run/, '696969': /repeating/,
  };
  for (const [pin, re] of Object.entries(bad)) assert.match(pinProblem(pin), re, pin);
});

test('PIN token: deterministic, bound to the username (case/@-insensitive), never the PIN itself', async () => {
  const it = { iterations: 1000 };
  const a = await pinToken('Prince', '482916', it), b = await pinToken('@prince', '482916', it);
  assert.equal(b64(a), b64(b));
  assert.notEqual(b64(a), b64(await pinToken('prince2', '482916', it)), 'same PIN, other person → other token');
  assert.notEqual(b64(a), b64(await pinToken('prince', '482917', it)));
  assert.equal(a.length, 32);
  const v = await pinVerifier(a);
  assert.match(v, /^[A-Za-z0-9_-]{43}$/, 'what the relay stores: a 32-byte hash');
  assert.notEqual(v, b64(a), 'the relay never gets the token itself as its stored value');
});

test('online keys: the PIN changes the KEY but not the MAILBOX (so the relay can count PIN tries on it)', async () => {
  const it = { iterations: 1000 };
  const tok = await pinToken('prince', '482916', it);
  const plain = await keysFor('prince', 'correct horse battery staple', it);
  const withPin = await keysFor('prince', 'correct horse battery staple', { ...it, pin: tok });
  const otherPin = await keysFor('prince', 'correct horse battery staple', { ...it, pin: await pinToken('prince', '305718', it) });
  assert.equal(b64(plain.box), b64(withPin.box));
  assert.notEqual(b64(plain.key), b64(withPin.key));
  assert.notEqual(b64(withPin.key), b64(otherPin.key), 'a wrong PIN can’t open the backup even if the relay were bypassed');
});
