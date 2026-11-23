// Two phones talking through the REAL relay code (Node shim), with real vaults.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../relay/node/server.mjs';
import { Remote } from '../../src/js/core/remote.js';
import { Vault } from '../../src/js/core/vault.js';
import { MemoryStore } from '../../src/js/core/storage.js';
import { contactId } from '../../src/js/core/identity.js';

const ORIGIN = 'http://app.test';
const relay = await startRelay({ port: 0, origins: [ORIGIN] });
after(() => relay.server.close());

async function phone(name, store = new MemoryStore()) {
  const vault = (await Vault.exists(store)) ? await Vault.unlock(store, 'correct horse battery') : await Vault.create(store, 'correct horse battery', { iterations: 1000 });
  const r = new Remote({ vault, identity: vault.identity, relayUrl: relay.url, origin: ORIGIN, getName: () => name,
    wsFactory: (u) => new WebSocket(u, { headers: { Origin: ORIGIN } }),
    fetchImpl: (u, o) => fetch(u, { ...o, headers: { ...o.headers, Origin: ORIGIN } }) });
  await r.load();
  const inbox = []; const waiters = [];
  r.on('message', (cid, m) => { inbox.push({ cid, m }); for (const w of waiters.splice(0)) w(); });
  r.on('joined', (j) => { r.lastJoin = j; for (const w of waiters.splice(0)) w(); });
  r.next = (pred) => new Promise((res) => { const chk = () => (pred() ? res() : waiters.push(chk)); chk(); });
  r.inbox = inbox; r.store = store; r.name = name;
  return r;
}
const online = (r) => new Promise((res) => { if (r.online) res(); else r.on('status', (v) => v && res()); });

test('remote invite → join → chat both ways, with one side OFFLINE while the other writes', async () => {
  const alice = await phone('Alice'), bob = await phone('Bob');
  alice.start(); await online(alice);
  const inv = await alice.createInvite('https://murmur.example');
  // Bob is offline (never started) — he joins and writes; it all queues encrypted.
  const { inv: parsed, name } = await bob.inspectInvite(inv.link);
  assert.equal(name, 'Alice');
  const aliceCid = await bob.acceptInvite(parsed, { t: 'hello', name: 'Bob' });
  await bob.send(aliceCid, { t: 'msg', id: 'm1', text: 'written while offline' });
  assert.equal(bob.outbox.length, 3, 'join + hello + msg parked in the encrypted outbox');
  bob.start(); await online(bob);
  await alice.next(() => alice.inbox.length >= 2);
  const bobCid = await contactId(bob.identity.publicRaw);
  assert.equal(alice.lastJoin.cid, bobCid); assert.equal(alice.lastJoin.name, 'Bob');
  assert.deepEqual(alice.inbox.map((x) => x.m.t), ['hello', 'msg']);
  assert.equal(alice.inbox[1].m.text, 'written while offline');
  assert.equal(bob.outbox.length, 0);
  // Alice goes offline; Bob keeps writing; Alice comes back and gets everything.
  alice.stop();
  await bob.send(aliceCid, { t: 'msg', id: 'm2', text: 'are you there?' });
  await alice.send(bobCid, { t: 'msg', id: 'a1', text: 'queued reply' }); // Alice offline: queued
  alice.start(); await online(alice);
  await alice.next(() => alice.inbox.length >= 3);
  await bob.next(() => bob.inbox.length >= 1);
  assert.equal(alice.inbox[2].m.text, 'are you there?');
  assert.equal(bob.inbox[0].m.text, 'queued reply');
  alice.stop(); bob.stop();
});

test('state survives lock/unlock (ratchets + inbox persist in the vault); used invite cannot be reused', async () => {
  const alice = await phone('Alice'), bob = await phone('Bob'), eve = await phone('Eve');
  alice.start(); await online(alice);
  const inv = await alice.createInvite('https://m.example');
  const parsed = (await bob.inspectInvite(inv.text)).inv;
  const aliceCid = await bob.acceptInvite(parsed, { t: 'hello', name: 'Bob' });
  bob.start(); await online(bob);
  await alice.next(() => alice.lastJoin);
  // Eve got hold of the same (already used) invite link:
  const eveP = (await eve.inspectInvite(inv.text)).inv;
  const warned = new Promise((res) => alice.on('warning', res));
  await eve.acceptInvite(eveP, { t: 'hello', name: 'Eve' }); eve.start();
  assert.match(await warned, /unknown or already-used invite/);
  // "Lock" Alice: rebuild from the same encrypted store.
  alice.stop();
  const alice2 = await phone('Alice', alice.store);
  assert.equal(alice2.address, alice.address);
  alice2.start(); await online(alice2);
  await bob.send(aliceCid, { t: 'msg', id: 'x', text: 'after relock' });
  await alice2.next(() => alice2.inbox.some((x) => x.m.text === 'after relock'));
  alice2.stop(); bob.stop(); eve.stop();
});

test('in-person bootstrap (over an already-authenticated channel) yields a working internet link', async () => {
  const alice = await phone('Alice'), bob = await phone('Bob');
  const offer = await alice.liveOffer();
  const { join, first } = await bob.liveAnswer(offer, alice.identity.publicRaw, { t: 'hello', name: 'Bob' });
  const bobCid = await alice.liveFinish(join, first, bob.identity.publicRaw);
  assert.equal(bobCid, await contactId(bob.identity.publicRaw));
  await assert.rejects(alice.liveFinish(join, first, bob.identity.publicRaw), /unknown internet setup/);
  const mallory = await phone('Mallory');
  await assert.rejects(mallory.liveAnswer(await alice.liveOffer(), bob.identity.publicRaw, {}), /different identity/);
  alice.start(); bob.start(); await online(alice); await online(bob);
  await alice.send(bobCid, { t: 'msg', id: 'z', text: 'internet now' });
  await bob.next(() => bob.inbox.length >= 1);
  assert.equal(bob.inbox[0].m.text, 'internet now');
  alice.stop(); bob.stop();
});

test('the relay never sees names, identity keys or plaintext', async () => {
  const alice = await phone('Alice Secretname'), bob = await phone('Bob Hiddenname');
  alice.start(); await online(alice);
  const inv = await alice.createInvite('https://m.example');
  const aliceCid = await bob.acceptInvite((await bob.inspectInvite(inv.text)).inv, { t: 'hello', name: 'Bob Hiddenname' });
  bob.stop(); // keep everything in Alice's relay mailbox: don't let it be delivered+deleted
  alice.stop();
  await bob.send(aliceCid, { t: 'msg', id: 'q', text: 'TOP SECRET PLAN' });
  await bob.flush();
  const st = relay.env.INBOX.instance(alice.address);
  const blobs = st.storage.sql.exec('SELECT data FROM m').toArray().map((r) => Buffer.from(r.data));
  assert.ok(blobs.length >= 3);
  const all = Buffer.concat(blobs);
  for (const needle of ['TOP SECRET', 'Hiddenname', 'Secretname', 'hello']) assert.equal(all.indexOf(needle), -1, needle);
  assert.equal(all.indexOf(Buffer.from(bob.identity.publicRaw.slice(1, 24))), -1, 'Bob identity key not visible');
});
